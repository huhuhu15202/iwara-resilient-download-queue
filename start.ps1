$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = if ($env:IWARA_CONFIG_PATH) { $env:IWARA_CONFIG_PATH } else { Join-Path $appRoot "config.json" }
$examplePath = Join-Path $appRoot "config.example.json"
$dataRoot = if ($env:IWARA_DATA_ROOT) { $env:IWARA_DATA_ROOT } else { $null }
if (Test-Path -LiteralPath $configPath) {
    try {
        $localConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($localConfig.dataRoot -and -not $env:IWARA_DATA_ROOT) { $dataRoot = [string]$localConfig.dataRoot }
    } catch {
        throw "Unable to read config file ${configPath}: $($_.Exception.Message)"
    }
}
if (-not $dataRoot -and (Test-Path -LiteralPath $examplePath)) {
    try {
        $exampleConfig = Get-Content -LiteralPath $examplePath -Raw | ConvertFrom-Json
        $dataRoot = [string]$exampleConfig.dataRoot
    } catch {
        throw "Unable to read example config ${examplePath}: $($_.Exception.Message)"
    }
}
if (-not $dataRoot) { $dataRoot = Join-Path $appRoot "data" }
if (-not $env:IWARA_CONFIG_PATH -and -not (Test-Path -LiteralPath $configPath)) {
    $legacyConfigPath = Join-Path $dataRoot "config.json"
    if (Test-Path -LiteralPath $legacyConfigPath) {
        $configPath = $legacyConfigPath
        if (-not $env:IWARA_DATA_ROOT) {
            try {
                $legacyConfig = Get-Content -LiteralPath $legacyConfigPath -Raw | ConvertFrom-Json
                if ($legacyConfig.dataRoot) { $dataRoot = [string]$legacyConfig.dataRoot }
            } catch {
                throw "Unable to read legacy config file ${legacyConfigPath}: $($_.Exception.Message)"
            }
        }
    }
}
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null

try {
    Invoke-RestMethod -Uri "http://127.0.0.1:18777/health" -TimeoutSec 1 | Out-Null
} catch {
    $nodePath = "C:\Program Files\nodejs\node.exe"
    if (-not (Test-Path -LiteralPath $nodePath)) {
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($null -eq $nodeCommand) {
            throw "Node.js was not found."
        }
        $nodePath = $nodeCommand.Source
    }
    $nodeVersion = (& $nodePath --version 2>$null).Trim()
    if ($nodeVersion -notmatch '^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)') {
        throw "Unable to parse Node.js version: $nodeVersion. Install Node.js 24 LTS."
    }
    $major = [int]$Matches.major
    $minor = [int]$Matches.minor
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 13)) {
        throw "Node.js $nodeVersion is unsupported; this service needs >= 22.13.0. Install Node.js 24 LTS."
    }
    Start-Process -FilePath $nodePath `
        -ArgumentList "src\main.mjs" `
        -WorkingDirectory $appRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $dataRoot "service.log") `
        -RedirectStandardError (Join-Path $dataRoot "service-error.log")
}

$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:18777/health" -TimeoutSec 1 | Out-Null
        $ready = $true
        break
    } catch {
        Start-Sleep -Milliseconds 250
    }
}

if ($ready) {
    Start-Process "http://127.0.0.1:18777/"
} else {
    Write-Host "Iwara queue failed to start. See:" -ForegroundColor Red
    Write-Host (Join-Path $dataRoot "service-error.log")
    Read-Host "Press Enter to close"
    exit 1
}
