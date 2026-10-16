param(
    [string]$OutputDir = 'output/ml-optimization-20261016',
    [ValidateRange(1,16)][int]$Workers = 4,
    [switch]$Resume
)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $projectRoot
try {
    $env:CARGO_BUILD_JOBS = '1'
    cargo build --release --locked --bin nofx-ml-optimize
    if ($LASTEXITCODE -ne 0) { throw 'Rust optimizer build failed' }
    $arguments = @('--output-dir', $OutputDir, '--workers', [string]$Workers)
    if ($Resume) { $arguments += '--resume' }
    & (Join-Path $projectRoot 'target/release/nofx-ml-optimize.exe') @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Rust optimizer failed; see the preceding error' }
} finally {
    Pop-Location
}
