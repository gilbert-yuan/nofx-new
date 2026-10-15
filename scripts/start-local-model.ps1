param(
    [int]$Port = 18080,
    [ValidateRange(1, 12)][int]$Threads = 4
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $projectRoot 'data/local-model'
$serverPath = Join-Path $localRoot 'runtime/b11429/llama-server.exe'
$modelPath = Join-Path $localRoot 'models/qwen2.5-0.5b-instruct-q4_k_m.gguf'
$baseUrl = "http://127.0.0.1:$Port"

foreach ($requiredPath in @($serverPath, $modelPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Missing local model file: $requiredPath. See docs/local-buy-model.md."
    }
}

try {
    $existing = Invoke-RestMethod -Uri "$baseUrl/v1/models" -TimeoutSec 2
    if ($existing.data.id -contains 'qwen2.5-0.5b-instruct') {
        Write-Output "Local model ready: $baseUrl/v1 (qwen2.5-0.5b-instruct)"
        return
    }
    throw "Port $Port is occupied by another model service."
} catch {
    if ($_.Exception.Message -like 'Port * is occupied*') { throw }
}

$logRoot = Join-Path $localRoot 'logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$arguments = @(
    '-m', ('"{0}"' -f $modelPath),
    '--host', '127.0.0.1', '--port', "$Port",
    '--alias', 'qwen2.5-0.5b-instruct',
    '-ngl', '0', '-t', "$Threads", '-tb', "$Threads",
    '-c', '4096', '-b', '128', '-ub', '64', '--parallel', '1'
)
$serverProcess = Start-Process -FilePath $serverPath -ArgumentList $arguments `
    -WorkingDirectory (Split-Path -Parent $serverPath) -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logRoot 'server.stdout.log') `
    -RedirectStandardError (Join-Path $logRoot 'server.stderr.log')
Set-Content -LiteralPath (Join-Path $localRoot 'server.pid') -Value $serverProcess.Id

for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $serverProcess.Refresh()
    if ($serverProcess.HasExited) {
        throw "Model server exited. See $logRoot/server.stderr.log."
    }
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 1
        if ($health.status -eq 'ok') {
            Write-Output "Local model ready: $baseUrl/v1 (qwen2.5-0.5b-instruct), PID $($serverProcess.Id)"
            return
        }
    } catch { }
    Start-Sleep -Milliseconds 500
}
throw "Model is still loading. Check $baseUrl/health and $logRoot/server.stderr.log."
