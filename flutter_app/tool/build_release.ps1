param(
    [switch]$BumpMinor
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pubspecPath = Join-Path $projectRoot 'pubspec.yaml'
$pubspec = Get-Content -Raw $pubspecPath
$match = [regex]::Match($pubspec, '(?m)^version:\s*(\d+)\.(\d+)\.(\d+)\+(\d+)\s*$')

if (-not $match.Success) {
    throw 'pubspec.yaml must contain version: major.minor.patch+build'
}

$major = [int]$match.Groups[1].Value
$minor = [int]$match.Groups[2].Value
$patch = [int]$match.Groups[3].Value
$build = [int]$match.Groups[4].Value + 1

if ($BumpMinor) {
    $minor += 1
    $patch = 0
}

$nextVersion = "$major.$minor.$patch+$build"
$updated = [regex]::Replace($pubspec, '(?m)^version:\s*.*$', "version: $nextVersion", 1)
Set-Content -LiteralPath $pubspecPath -Value $updated -NoNewline

Push-Location $projectRoot
try {
    flutter pub get
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    flutter build apk --release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Output "Built NOFX $nextVersion"
    Write-Output (Join-Path $projectRoot 'build\app\outputs\flutter-apk\app-release.apk')
} finally {
    Pop-Location
}
