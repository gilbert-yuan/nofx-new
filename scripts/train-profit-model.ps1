param(
    [ValidateSet('1h','15m')][string]$Interval = '1h',
    [string]$OutputDir = '',
    [string]$DataDir = '',
    [string]$CacheDir = '',
    [string]$PreviousRun = 'output/ml-rolling-20261016',
    [ValidateRange(1,4)][int]$Threads = 2,
    [ValidateRange(1,4)][int]$EvaluationWeeks = 4,
    [ValidateRange(5,300)][int]$MaxIterations = 120,
    [ValidateRange(1,50)][int]$TopN = 50,
    [string]$Symbols = '',
    [switch]$SkipBuild,
    [switch]$Resume
)
if (-not $OutputDir) {
    $OutputDir = if ($Interval -eq '15m') { 'output/ml-profit-train-15m-20261017' } else { 'output/ml-profit-train-20261016' }
}
if (-not $DataDir) {
    $DataDir = if ($Interval -eq '15m') { 'data/ml/intraday-archive-20261017' } else { 'data/ml/expanded-archive-20261016' }
}
if (-not $CacheDir) {
    $CacheDir = if ($Interval -eq '15m') { 'data/ml/intraday-archive-20261017/execution-feature-cache-v1' } else { 'data/ml/expanded-archive-20261016/execution-feature-cache-v1' }
}
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$runDirectory = [IO.Path]::GetFullPath($OutputDir)
if ((Test-Path -LiteralPath $runDirectory) -and -not $Resume) { throw 'Existing output requires -Resume' }
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
$statusPath = Join-Path $runDirectory 'workflow-status.json'
if (Test-Path -LiteralPath $statusPath) {
    $previous = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    $process = Get-Process -Id $previous.processId -ErrorAction SilentlyContinue
    if ($process -and $previous.status -eq 'running' -and $process.StartTime.ToUniversalTime().ToString('o') -eq $previous.processStartedUtc) { throw "Already running with PID $($process.Id)" }
    if ($previous.childProcessId -and (Get-Process -Id $previous.childProcessId -ErrorAction SilentlyContinue)) { throw 'Existing child is still running; inspect it before recovery' }
}
$script:childId = $null
$script:stdout = $null
$script:stderr = $null
function Write-Status([string]$state, [string]$stage, [string]$message) {
    $training = $null
    $trainingPath = Join-Path $runDirectory 'training-status.json'
    if (Test-Path -LiteralPath $trainingPath) { try { $training = Get-Content -LiteralPath $trainingPath -Raw | ConvertFrom-Json } catch { } }
    $value = [ordered]@{
        status=$state; stage=$stage; message=$message; updatedUtc=(Get-Date).ToUniversalTime().ToString('o')
        processId=$PID; processStartedUtc=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
        childProcessId=$script:childId; stdoutLog=$script:stdout; stderrLog=$script:stderr
        training=$training; outputDirectory=$runDirectory; runtimeModified=$false; ordersEnabled=$false; deploymentApproved=$false
    }
    $temporary = Join-Path $runDirectory ('workflow-status.' + [guid]::NewGuid().ToString('N') + '.tmp')
    $value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $statusPath -Force
}
try {
    if (-not $SkipBuild) {
        Write-Status 'running' 'build' 'Building the Rust cost-adjusted trainer'
        $env:CARGO_BUILD_JOBS = '1'
        cargo build --release --locked --bin nofx-ml-profit-train
        if ($LASTEXITCODE -ne 0) { throw 'Rust release build failed' }
    }
    $builtBinary = Join-Path $projectRoot 'target/release/nofx-ml-profit-train.exe'
    if (-not (Test-Path -LiteralPath $builtBinary)) { throw 'Missing release trainer' }
    $binaryDirectory = Join-Path $runDirectory 'bin'
    New-Item -ItemType Directory -Path $binaryDirectory -Force | Out-Null
    $binary = Join-Path $binaryDirectory 'nofx-ml-profit-train.exe'
    if (Test-Path -LiteralPath $binary) {
        if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $builtBinary -Algorithm SHA256).Hash) { throw 'Saved trainer differs from this build; use a fresh output directory' }
    } else { Copy-Item -LiteralPath $builtBinary -Destination $binary }
    $memory = Get-CimInstance Win32_OperatingSystem
    if ($memory.FreeVirtualMemory -lt 3GB / 1KB) { throw 'Less than 3 GiB of system commit headroom; free memory before starting training' }
    $tag = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfff')
    $script:stdout = Join-Path $runDirectory ('train.' + $tag + '.stdout.log')
    $script:stderr = Join-Path $runDirectory ('train.' + $tag + '.stderr.log')
    $arguments = @('--output-dir',$OutputDir,'--data-dir',$DataDir,'--cache-dir',$CacheDir,'--interval',$Interval,'--threads',[string]$Threads,'--evaluation-weeks',[string]$EvaluationWeeks,'--max-iterations',[string]$MaxIterations,'--top-n',[string]$TopN,'--resume')
    if ($Interval -ne '15m') { $arguments += @('--previous-run',$PreviousRun) }
    if ($Symbols) { $arguments += @('--symbols',$Symbols) }
    $quoted = @($arguments | ForEach-Object { '"' + ([regex]::Replace([regex]::Replace($_, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"' })
    $child = Start-Process -FilePath $binary -ArgumentList $quoted -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $script:stdout -RedirectStandardError $script:stderr
    $script:childId = $child.Id
    do {
        Write-Status 'running' 'training' 'Weekly net-return training, disjoint OOF calibration and shared-account evaluation'
        if ($child.WaitForExit(10000)) { break }
    } while ($true)
    $child.WaitForExit()
    $child.Refresh()
    $exitCode = $child.ExitCode
    $script:childId = $null
    if ($exitCode -ne 0) { throw "Trainer failed with exit code $exitCode; inspect $($script:stderr)" }
    $reportPath = Join-Path $runDirectory 'report.json'
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if ($report.status -ne 'completed') { throw 'Trainer exited without a completed report' }
    Write-Status 'completed' 'report' 'Historical research completed; new forward validation is required before deployment'
} catch {
    Write-Status 'failed' 'error' $_.Exception.Message
    throw
}
