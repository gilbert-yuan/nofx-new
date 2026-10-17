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
        $snapshot = [ordered]@{
            status = $status; stage = $stage; message = $message
            updatedUtc = (Get-Date).ToUniversalTime().ToString('o'); processId = $PID
            processStartedUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
            childProcessId = $script:activeChildId
            stdoutLog = $script:activeStdout; stderrLog = $script:activeStderr
            dataDirectory = [IO.Path]::GetFullPath($DataDir); outputDirectory = $runDirectory
            runtimeModified = $false; ordersEnabled = $false
        }
        $temporaryStatus = Join-Path $runDirectory ('workflow-status.' + [guid]::NewGuid().ToString('N') + '.tmp')
        $snapshot | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporaryStatus -Encoding utf8
        Move-Item -LiteralPath $temporaryStatus -Destination $statusPath -Force
    }
    function Invoke-WorkflowProgram([string]$program, [string[]]$programArguments, [string]$stage, [string]$message) {
        $logTag = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfff')
        $script:activeStdout = Join-Path $runDirectory ($stage + '.' + $logTag + '.stdout.log')
        $script:activeStderr = Join-Path $runDirectory ($stage + '.' + $logTag + '.stderr.log')
        # Windows file/argument paths may contain spaces and trailing backslashes.
        $quotedArguments = @($programArguments | ForEach-Object {
            '"' + ([regex]::Replace([regex]::Replace($_, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
        })
        $child = Start-Process -FilePath $program -ArgumentList $quotedArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $script:activeStdout -RedirectStandardError $script:activeStderr
        $script:activeChildId = $child.Id
        do {
            Write-WorkflowStatus 'running' $stage $message
            if ($child.WaitForExit(10000)) { break }
        } while ($true)
        $child.WaitForExit()
        $child.Refresh()
        $exitCode = $child.ExitCode
        $script:activeChildId = $null
        if ($exitCode -ne 0) { throw "$stage failed with exit code $exitCode; check $($script:activeStderr)" }
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
            while (Get-Process -Id $CollectorProcessId -ErrorAction SilentlyContinue) {
                Write-WorkflowStatus 'running' 'wait-for-collection' "Waiting for collector $CollectorProcessId before training"
                Start-Sleep -Seconds 10
            }
            $collection = Get-Content -LiteralPath (Join-Path $DataDir 'manifest.json') -Raw | ConvertFrom-Json
            if (-not $collection.history_complete) { throw 'The existing collector stopped before historical data was complete' }
        } else {
            Write-WorkflowStatus 'running' 'collect' 'Collecting and verifying 180 days of public historical data'
            $phase = 'all'
            $existingManifest = Join-Path $DataDir 'manifest.json'
            if ($Resume -and (Test-Path -LiteralPath $existingManifest)) {
                $existingCollection = Get-Content -LiteralPath $existingManifest -Raw | ConvertFrom-Json
                if ($existingCollection.status -in @('candles_complete','candles_complete_with_errors','complete','complete_with_errors')) { $phase = 'history' }
            }
            $collectArguments = @('--output-dir', $DataDir, '--days', '180', '--end-date', '2026-10-14', '--warmup-hours', '256', '--raw-cache-dir', $RawCacheDir, '--include-inactive', '--phase', $phase, '--concurrency', [string]$Concurrency)
            if ($Symbols) { $collectArguments += @('--symbols', $Symbols) }
            Invoke-WorkflowProgram (Join-Path $projectRoot 'target/release/nofx-ml-archive.exe') $collectArguments 'collect' 'Collecting and verifying 180 days of public historical data'
        }
        Write-WorkflowStatus 'running' 'prepare-and-train' 'Preparing causal predictions and execution labels, then training and verifying frozen folds'
        $trainArguments = @('--data-dir', $DataDir, '--output-dir', $OutputDir, '--threads', [string]$Threads)
        if ($Resume -or (Test-Path -LiteralPath (Join-Path $runDirectory 'run-config.json'))) { $trainArguments += '--resume' }
        if ($Symbols) { $trainArguments += @('--symbols', $Symbols) }
        # The workflow directory already contains logs/status, so the trainer gets
        # --resume; its immutable run-config must still match before reusing work.
        if ($trainArguments -notcontains '--resume') { $trainArguments += '--resume' }
        Invoke-WorkflowProgram (Join-Path $projectRoot 'target/release/nofx-ml-rolling-train.exe') $trainArguments 'prepare-and-train' 'Preparing causal predictions and execution labels, then training and verifying frozen folds'
        $report = Get-Content -LiteralPath (Join-Path $runDirectory 'report.json') -Raw | ConvertFrom-Json
        Write-WorkflowStatus 'completed' 'report' "Historical profitable upgrade: $($report.historical_profitable_upgrade); runtime unchanged; neural weights unchanged"
    } catch {
        Write-WorkflowStatus 'failed' 'error' $_.Exception.Message
        throw
    }
} finally {
    Pop-Location
}
