# 多周期特征与 Chronos / LightGBM

Chronos-Bolt-Tiny 的 ONNX 输入是一条长度为 256 的收盘价序列，不能把 1m、5m、15m、1h、4h 拼进同一个 `context`。现役 Demo 仍是 1h 模型；Chronos 权重本轮不更新。

## 能做什么

决策时点 `origin_ms` 上，只使用**已经收盘**的 K 线，给 LightGBM 追加因果特征。4h 由连续 4 根已收盘 1h 聚合：开=第一根开、收=第四根收、高/低取区间极值、量求和。未凑齐 4 根或收盘晚于 `origin_ms` 的组丢弃。历史不足 50 根 4h 时 12 个技术量为 0，`h4_available=0`。

4h 特征（`rust/src/ml_multiframe.rs`）：

| 名称 | 含义 |
| --- | --- |
| `h4_return_{1,3,6,12}_bars` | 1/3/6/12 根 4h 收益率 |
| `h4_close_sma20` / `h4_sma20_sma50` / `h4_ema12_ema26` | 均线相对位置 |
| `h4_rsi14` / `h4_atr14_fraction` / `h4_volatility12` | RSI、ATR/价格、12 根收益波动 |
| `h4_range_position24` / `h4_volume_z24` | 24 根区间位置与量能 z |
| `h4_available` | 1=凑齐 50 根 4h，否则 0 |

1h LightGBM 基线仍用冻结缓存里的价格、微观结构、资金费/OI、BTC/ETH 背景和 Chronos 分位数。对照只多这 13 维 4h，标签、成本、共享回放不变。

## 不能做什么

当前 180 天归档 `data/ml/expanded-archive-20261016` 的 `datasets` **只有 1h**。1m、5m、15m 禁止用小时 K 升采样。15m 研究要原生季度小时归档，见 [净收益训练](ml-profit-training.md)。Chronos 官方间隔只承认 `1h` 和 `15m`。

## 对照入口

冻结执行标签与 `output/ml-rolling-20261016` 的缓存，比较 `1h` 与 `1h+4h`：

```powershell
cargo build --locked --bin nofx-ml-multiframe-train
.\target\debug\nofx-ml-multiframe-train.exe --output-dir output/ml-multiframe-20261017

# 两币冒烟
.\target\debug\nofx-ml-multiframe-train.exe --symbols BTCUSDT,ETHUSDT --output-dir output/ml-multiframe-smoke-20261017
```

输出不可覆盖。通过条件仍是扣成本净收益、足够平仓数和回撤上限；减亏不等于盈利。历史区间已经观察过，不是新盲测。验收通过前不改 Demo 模型目录或 `planInterval`。

复用 `output/ml-rolling-20261016` 的执行标签时，准备代码指纹必须与当时一致（含 `strategies.rs` 出场快照）。短持仓均线出场改过之后，旧缓存会拒绝加载；需要先用当前引擎重新准备标签，再跑对照。两币冒烟已复现该拒绝，没有绕过校验。
