param(
    [string]$DataDir = 'data/ml/expanded-archive-20261016',
    [string]$OutputDir = 'output/ml-rolling-20261016',
    [string]$RawCacheDir = 'data/ml/monthly-archive-20261014',
    [ValidateRange(1,8)][int]$Concurrency = 8,
    [ValidateRange(1,12)][int]$Threads = 4,
    [string]$Symbols = '',
    [int]$CollectorProcessId = 0,
    [switch]$Resume,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $projectRoot
try {
    $runDirectory = [IO.Path]::GetFullPath($OutputDir)
    New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
    $statusPath = Join-Path $runDirectory 'workflow-status.json'
    if (Test-Path -LiteralPath $statusPath) {
        $previous = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
        if ($previous.status -eq 'running' -and (Get-Process -Id $previous.processId -ErrorAction SilentlyContinue)) {
            throw "Workflow already running with process $($previous.processId)"
        }
        if (-not $Resume) { throw 'Existing workflow requires -Resume or a fresh -OutputDir' }
    }
    function Write-WorkflowStatus([string]$status, [string]$stage, [string]$message) {
        [ordered]@{
            status = $status; stage = $stage; message = $message
            updatedUtc = (Get-Date).ToUniversalTime().ToString('o'); processId = $PID
            dataDirectory = [IO.Path]::GetFullPath($DataDir); outputDirectory = $runDirectory
            runtimeModified = $false; ordersEnabled = $false
        } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding utf8
    }
    try {
        if (-not $SkipBuild) {
            Write-WorkflowStatus 'running' 'build' 'Building the Rust collector and chronological trainer'
            $env:CARGO_BUILD_JOBS = '1'
            cargo build --release --locked --bin nofx-ml-archive --bin nofx-ml-rolling-train
            if ($LASTEXITCODE -ne 0) { throw 'Rust release build failed' }
        }
        if ($CollectorProcessId -gt 0) {
            Write-WorkflowStatus 'running' 'wait-for-collection' "Waiting for the already running collector $CollectorProcessId before training"
            while (Get-Process -Id $CollectorProcessId -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 10 }
            $collection = Get-Content -LiteralPath (Join-Path $DataDir 'manifest.json') -Raw | ConvertFrom-Json
            if (-not $collection.history_complete) { throw 'The existing collector stopped before historical data was complete' }
        } else {
            Write-WorkflowStatus 'running' 'collect' 'Collecting and verifying 180 days of public historical data'
            $collectArguments = @('--output-dir', $DataDir, '--days', '180', '--end-date', '2026-10-14', '--warmup-hours', '256', '--raw-cache-dir', $RawCacheDir, '--include-inactive', '--phase', 'all', '--concurrency', [string]$Concurrency)
            if ($Symbols) { $collectArguments += @('--symbols', $Symbols) }
            & (Join-Path $projectRoot 'target/release/nofx-ml-archive.exe') @collectArguments 1>(Join-Path $runDirectory 'collection.stdout.log') 2>(Join-Path $runDirectory 'collection.stderr.log')
            if ($LASTEXITCODE -ne 0) { throw 'Historical collection failed; check collection.stderr.log' }
        }
        Write-WorkflowStatus 'running' 'prepare-and-train' 'Preparing causal predictions and execution labels, then training and verifying frozen folds'
        $trainArguments = @('--data-dir', $DataDir, '--output-dir', $OutputDir, '--threads', [string]$Threads)
        if ($Resume -or (Test-Path -LiteralPath (Join-Path $runDirectory 'run-config.json'))) { $trainArguments += '--resume' }
        if ($Symbols) { $trainArguments += @('--symbols', $Symbols) }
        # The workflow directory already contains logs/status, so the trainer gets
        # --resume; its immutable run-config must still match before reusing work.
        if ($trainArguments -notcontains '--resume') { $trainArguments += '--resume' }
        & (Join-Path $projectRoot 'target/release/nofx-ml-rolling-train.exe') @trainArguments 1>(Join-Path $runDirectory 'training.stdout.log') 2>(Join-Path $runDirectory 'training.stderr.log')
        if ($LASTEXITCODE -ne 0) { throw 'Preparation or training failed; check training.stderr.log' }
        $report = Get-Content -LiteralPath (Join-Path $runDirectory 'report.json') -Raw | ConvertFrom-Json
        Write-WorkflowStatus 'completed' 'report' "Historical profitable upgrade: $($report.historical_profitable_upgrade); runtime unchanged; neural weights unchanged"
    } catch {
        Write-WorkflowStatus 'failed' 'error' $_.Exception.Message
        throw
    }
} finally {
    Pop-Location
}
