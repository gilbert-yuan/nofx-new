"""One-time conversion of official Chronos weights; no market data or trading logic."""
import argparse
import hashlib
import importlib.metadata
import json
import math
import types
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from chronos import ChronosBoltPipeline


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def finite_norm(self, x, loc_scale=None):
    original_dtype = x.dtype
    x = x.float()
    if loc_scale is None:
        loc = x.mean(dim=-1, keepdim=True)
        scale = (x - loc).square().mean(dim=-1, keepdim=True).sqrt()
        scale = torch.where(scale == 0, self.eps, scale)
    else:
        loc, scale = loc_scale
    return ((x - loc) / scale).to(original_dtype), (loc, scale)


def complete_patches(self, x):
    # Native Rust rejects missing values and requires exactly 256 values, divisible by 16.
    return x.reshape(x.shape[0], -1, self.patch_size)


def integer_embedding(self, ids):
    # Both encoder REG and decoder start-token indices must remain integer in ONNX.
    return torch.nn.functional.embedding(
        ids.to(torch.long), self.weight, self.padding_idx, self.max_norm,
        self.norm_type, self.scale_grad_by_freq, self.sparse,
    )


class ExportWrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, context):
        return self.model(context=context).quantile_preds


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", default="data/chronos/model")
    parser.add_argument("--output", default="data/chronos/chronos-bolt-tiny.onnx")
    parser.add_argument("--reference", default="data/chronos/parity-reference.json")
    args = parser.parse_args()
    weights_sha = sha256(Path(args.model_dir) / "model.safetensors")
    config_sha = sha256(Path(args.model_dir) / "config.json")
    if weights_sha != "75068728d376d2bec670379eeef4bfb4d24c0cfe24d957451f8d19b447030a32":
        raise ValueError("Weights do not match the pinned official Tiny revision")
    if config_sha != "278f0086733031635fb1c861cb01c1bad6477420c7fcb19381a2993e335785e0":
        raise ValueError("Config does not match the pinned official Tiny revision")
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    pipeline = ChronosBoltPipeline.from_pretrained(
        args.model_dir, device_map="cpu", torch_dtype=torch.float32, local_files_only=True
    )
    model = pipeline.model.eval()
    if model.instance_norm.use_arcsinh or model.patch.patch_size != 16 or model.patch.patch_stride != 16:
        raise ValueError("Exporter supports only the verified Tiny norm and non-overlapping patches")
    if sum(p.numel() for p in model.parameters()) != 8652672:
        raise ValueError("Expected official Chronos-Bolt-Tiny parameter count")
    model.decoder.config.use_cache = False
    contexts = [
        [10000 + 20 * math.sin(i * 0.09) + i * 1.5 for i in range(256)],
        [100.0] * 256,
        [2000 + 3 * math.cos(i * 0.17) - i * 0.07 for i in range(256)],
    ]
    tensors = [torch.tensor([c], dtype=torch.float32) for c in contexts]
    with torch.no_grad():
        references = [model(context=x).quantile_preds.detach().numpy() for x in tensors]
    # Replace only export-unsupported operations, preserving semantics for finite inputs.
    model.instance_norm.forward = types.MethodType(finite_norm, model.instance_norm)
    model.patch.forward = types.MethodType(complete_patches, model.patch)
    model.shared.forward = types.MethodType(integer_embedding, model.shared)
    wrapper = ExportWrapper(model).eval()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        torch.onnx.export(
            wrapper, tensors[0], str(output), input_names=["context"],
            output_names=["quantile_preds"], opset_version=17,
            do_constant_folding=True, dynamo=False,
        )
    onnx.checker.check_model(str(output))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(output), sess_options=options, providers=["CPUExecutionProvider"])
    validation = []
    for x, expected in zip(tensors, references):
        actual = session.run(None, {"context": x.numpy()})[0]
        np.testing.assert_allclose(actual, expected, rtol=1e-5, atol=1e-3)
        validation.append({"max_abs_error": float(np.max(np.abs(actual - expected)))})
    reference = {
        "model": "amazon/chronos-bolt-tiny", "context": tensors[0][0].tolist(),
        "quantile_preds": references[0][0].tolist(), "output_shape": [1, 9, 64],
        "input_shape": [1, 256], "finite_inputs_only": True,
        "parameter_count": sum(p.numel() for p in model.parameters()),
        "conversion_validation": validation,
        "versions": {"torch": torch.__version__, "onnx": onnx.__version__, "onnxruntime": ort.__version__},
    }
    Path(args.reference).write_text(json.dumps(reference, indent=2), encoding="utf-8")
    manifest = {
        "model": "amazon/chronos-bolt-tiny", "device": "cpu", "license": "Apache-2.0",
        "upstream_revision": "a0e552de83495b5c28c14c71c374f3e33280b340",
        "upstream_url": "https://huggingface.co/amazon/chronos-bolt-tiny",
        "weights_sha256": weights_sha, "config_sha256": config_sha,
        "onnx_sha256": sha256(output), "exporter_sha256": sha256(__file__),
        "input_shape": [1, 256], "output_shape": [1, 9, 64],
        "quantiles": [i / 10 for i in range(1, 10)],
        "versions": {**reference["versions"],
            "chronos-forecasting": importlib.metadata.version("chronos-forecasting"),
            "transformers": importlib.metadata.version("transformers")},
        "config": json.loads((Path(args.model_dir) / "config.json").read_text()),
        "conversion_validation": validation, "validation_rtol": 1e-5, "validation_atol": 1e-3,
        "limitations": "Finite FP32 [1,256] inputs, finite normalization intermediates, fixed Tiny configuration only",
    }
    output.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"model": str(output), "bytes": output.stat().st_size,
                      "parameters": reference["parameter_count"], "validation": validation}))


if __name__ == "__main__":
    main()
