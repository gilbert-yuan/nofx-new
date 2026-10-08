param([switch]$SkipBuildTools)
$ErrorActionPreference = 'Stop'

# Native Windows toolchain installer. Application/test/backtest logic lives in Rust.
$rustBinDirectory = Join-Path $env:USERPROFILE '.cargo\bin'
$rustupExecutable = Join-Path $rustBinDirectory 'rustup.exe'
if (-not (Test-Path -LiteralPath $rustupExecutable)) {
    $installerDirectory = Join-Path $env:TEMP 'nofx-rust-setup'
    New-Item -ItemType Directory -Path $installerDirectory -Force | Out-Null
    $installerExecutable = Join-Path $installerDirectory 'rustup-init.exe'
    Invoke-WebRequest 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile $installerExecutable
    & $installerExecutable -y --profile minimal --default-toolchain stable --default-host x86_64-pc-windows-msvc --no-modify-path
    if ($LASTEXITCODE -ne 0) { throw 'rustup 安装失败。' }
}
if (-not $SkipBuildTools) {
    $vswhereExecutable = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $compilerInstalled = $false
    if (Test-Path -LiteralPath $vswhereExecutable) {
        $compilerInstalled = [bool](& $vswhereExecutable -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
    }
    if (-not $compilerInstalled) {
        & winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --silent --accept-package-agreements --accept-source-agreements --override '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
        if ($LASTEXITCODE -ne 0) { throw 'Visual Studio C++ Build Tools 安装失败。' }
    }
}
$existingUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($existingUserPath -split ';') | Where-Object { $_.TrimEnd('\') -eq $rustBinDirectory.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', "$rustBinDirectory;$existingUserPath", 'User')
}
$env:Path = "$rustBinDirectory;$env:Path"
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & $rustupExecutable show
    if ($LASTEXITCODE -ne 0) { throw '项目工具链安装失败。' }
    & cargo --version
    & rustc --version
    & cargo check --all-targets
    if ($LASTEXITCODE -ne 0) { throw 'Rust 项目编译检查失败。' }
} finally { Pop-Location }
Write-Host 'Rust 环境就绪。新开的终端可直接使用 cargo。'
