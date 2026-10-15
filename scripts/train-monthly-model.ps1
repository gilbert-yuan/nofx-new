[CmdletBinding()]
param(
    [string]$DataDir = 'data/ml/monthly-archive-20261014',
    [string]$OutputDir = 'output/ml-monthly-20261014',
    [string]$CacheDir = '',
    [ValidateSet('archive','rest')][string]$Source = 'archive',
    # Default matches the project's ecosystem.config.json public market proxy.
    [string]$Proxy = 'http://127.0.0.1:7890',
    [ValidateRange(1,8)][int]$Concurrency = 4,
    [switch]$Serve
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $projectRoot
try {
    if (!$CacheDir) { $CacheDir = Join-Path $DataDir 'feature-cache-v3' }
    if ($PSBoundParameters.ContainsKey('Proxy') -or (!$env:HTTPS_PROXY -and !$env:HTTP_PROXY)) {
        $env:HTTP_PROXY = $Proxy
        $env:HTTPS_PROXY = $Proxy
    }
    # Keep the native toolchain within the machine's available build memory.
    $env:CARGO_BUILD_JOBS = '1'
    $env:CARGO_PROFILE_DEV_DEBUG = '0'
    $env:CARGO_PROFILE_TEST_DEBUG = '0'
    $env:CARGO_PROFILE_DEV_CODEGEN_UNITS = '256'
    $env:CARGO_INCREMENTAL = '0'

    & cargo build --locked --bin nofx-ml-collect --bin nofx-ml-archive --bin nofx-ml-archive-repair --bin nofx-ml-monthly-train --bin nofx-ml-monthly-predict
    if ($LASTEXITCODE -ne 0) { throw 'Rust executable build failed.' }

    $monthlyServeArguments = @('--model-dir', $OutputDir, '--serve', '--port', '18084')
    if ($Source -eq 'archive') { $monthlyServeArguments += @('--data-dir', $DataDir) }

    $candidateManifest = Join-Path $OutputDir 'manifest.json'
    $candidateReport = Join-Path $OutputDir 'training-report.json'
    if ((Test-Path -LiteralPath $candidateManifest) -and (Test-Path -LiteralPath $candidateReport)) {
        $report = Get-Content -LiteralPath $candidateReport -Raw | ConvertFrom-Json
        if ($report.status -ne 'completed') { throw 'Candidate report is incomplete; preserve it and choose a new OutputDir.' }
        if ($Serve) {
            & .\target\debug\nofx-ml-monthly-predict.exe @monthlyServeArguments
            if ($LASTEXITCODE -ne 0) { throw 'Monthly candidate inference service stopped with an error.' }
        }
        else { Write-Host "Completed candidate preserved: $OutputDir. Use -Serve to run it, or select a new OutputDir for another study." }
        return
    }

    if ($Source -eq 'archive') {
        & .\target\debug\nofx-ml-archive.exe --output-dir $DataDir --concurrency $Concurrency --phase all
    }
    else {
        & .\target\debug\nofx-ml-collect.exe --output-dir $DataDir --days 30 --warmup-hours 256 --concurrency $Concurrency --phase all
    }
    if ($LASTEXITCODE -ne 0) { throw 'Monthly collection failed; rerun to resume the frozen window.' }
    if ($Source -eq 'archive') {
        & .\target\debug\nofx-ml-archive-repair.exe --data-dir $DataDir --prepare-only
        if ($LASTEXITCODE -ne 0) { throw 'Observed-bar gap repair preparation failed.' }
        & .\target\debug\nofx-ml-archive-repair.exe --data-dir $DataDir --apply
        if ($LASTEXITCODE -ne 0) { throw 'Observed-bar gap repair application failed.' }
        & .\target\debug\nofx-ml-archive.exe --output-dir $DataDir --phase history --concurrency $Concurrency
        if ($LASTEXITCODE -ne 0) { throw 'Auxiliary history refresh after repairs failed.' }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $DataDir 'manifest.json') -Raw | ConvertFrom-Json
    if (!$manifest.train_ready -or !$manifest.history_complete) {
        throw 'Collection has not finished every phase, or no symbol has enough valid training data.'
    }

    & .\target\debug\nofx-ml-monthly-train.exe --data-dir $DataDir --output-dir $OutputDir --cache-dir $CacheDir
    if ($LASTEXITCODE -ne 0) { throw 'Monthly training failed; inspect the saved feature cache and logs.' }

    Write-Host "Training finished. Candidate artifacts: $OutputDir"
    if ($Serve) {
        & .\target\debug\nofx-ml-monthly-predict.exe @monthlyServeArguments
        if ($LASTEXITCODE -ne 0) { throw 'Monthly candidate inference service stopped with an error.' }
    }
}
finally {
    Pop-Location
}
