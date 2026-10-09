$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherErrorLog = Join-Path $appRoot "launcher-error.log"
function Get-SafeLauncherFailureMessage {
    param([string]$Message)

    $position = [regex]::Match($Message, '\((\d+)\):\s*\{')
    if ($Message -match '(?i)config(?:uration)?|配置文件' -and $position.Success) {
        return "配置文件 JSON 格式错误，约在第 $($position.Groups[1].Value) 个字符。为保护密钥，配置正文已隐藏；请检查 config.json 格式。"
    }

    # Some PowerShell JSON parser errors append the complete input document.
    # Never show or persist a structured object from an exception.
    $jsonStart = [regex]::Match($Message, '(?s)\{\s*"(?:dataRoot|downloadRoot|aria2Secret|lanAccessToken|servicePort)"\s*:')
    if ($jsonStart.Success) {
        $Message = $Message.Substring(0, $jsonStart.Index) + "[结构化配置内容已隐藏]"
    }
    return [regex]::Replace(
        $Message,
        '(?i)("?(?:aria2Secret|lanAccessToken|access_token|token)"?\s*[:=]\s*)("[^"]*"|[^,\s}]+)',
        '$1[已隐藏]'
    )
}
trap {
    $failureMessage = Get-SafeLauncherFailureMessage -Message ([string]$_.Exception.Message)
    try { Add-Content -LiteralPath $launcherErrorLog -Value "[$(Get-Date -Format s)] $failureMessage" -Encoding UTF8 } catch {}
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show(
            "Iwara 启动失败。详细信息已记录到：`r`n$launcherErrorLog`r`n`r`n$failureMessage",
            "Iwara 本地播放列表启动失败",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } catch {}
    exit 1
}
$configPath = if ($env:IWARA_CONFIG_PATH) { $env:IWARA_CONFIG_PATH } else { Join-Path $appRoot "config.json" }
$examplePath = Join-Path $appRoot "config.example.json"
$dataRoot = if ($env:IWARA_DATA_ROOT) { $env:IWARA_DATA_ROOT } else { $null }
if (Test-Path -LiteralPath $configPath) {
    try {
        $localConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($localConfig.dataRoot -and -not $env:IWARA_DATA_ROOT) { $dataRoot = [string]$localConfig.dataRoot }
    } catch {
        throw (Get-SafeLauncherFailureMessage -Message "Unable to read config file ${configPath}: $($_.Exception.Message)")
    }
}
if (-not $dataRoot -and (Test-Path -LiteralPath $examplePath)) {
    try {
        $exampleConfig = Get-Content -LiteralPath $examplePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $dataRoot = [string]$exampleConfig.dataRoot
    } catch {
        throw (Get-SafeLauncherFailureMessage -Message "Unable to read example config ${examplePath}: $($_.Exception.Message)")
    }
}
if (-not $dataRoot) { $dataRoot = Join-Path $appRoot "data" }
if (-not $env:IWARA_CONFIG_PATH -and -not (Test-Path -LiteralPath $configPath)) {
    $legacyConfigPath = Join-Path $dataRoot "config.json"
    if (Test-Path -LiteralPath $legacyConfigPath) {
        $configPath = $legacyConfigPath
        if (-not $env:IWARA_DATA_ROOT) {
            try {
                $legacyConfig = Get-Content -LiteralPath $legacyConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($legacyConfig.dataRoot) { $dataRoot = [string]$legacyConfig.dataRoot }
            } catch {
                throw (Get-SafeLauncherFailureMessage -Message "Unable to read legacy config file ${legacyConfigPath}: $($_.Exception.Message)")
            }
        }
    }
}
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null

$startupTimeoutSeconds = 120
$startupPollIntervalMs = 250
$maxStartupAttempts = [math]::Ceiling($startupTimeoutSeconds * 1000 / $startupPollIntervalMs)
$serviceProcess = $null

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
    $serviceProcess = Start-Process -FilePath $nodePath `
        -ArgumentList "src\main.mjs" `
        -WorkingDirectory $appRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $dataRoot "service.log") `
        -RedirectStandardError (Join-Path $dataRoot "service-error.log") `
        -PassThru
}

$ready = $false
for ($attempt = 0; $attempt -lt $maxStartupAttempts; $attempt++) {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:18777/health" -TimeoutSec 1 | Out-Null
        $ready = $true
        break
    } catch {
        if ($serviceProcess -and $serviceProcess.HasExited) { break }
        Start-Sleep -Milliseconds $startupPollIntervalMs
    }
}

if ($ready) {
    try {
        Start-Process -FilePath "http://127.0.0.1:18777/playlist" -ErrorAction Stop
    } catch {
        throw "本地服务已经启动，但无法打开浏览器。请检查 Windows 的 HTTP 浏览器关联，或手动打开本地播放列表。"
    }
} else {
    $failureMessage = "Iwara queue failed to start. See:"
    if ($serviceProcess -and $serviceProcess.HasExited) {
        $failureMessage += "`r`nNode.js exited with code $($serviceProcess.ExitCode)."
    } elseif ($serviceProcess) {
        $failureMessage += "`r`nNode.js is still initializing; health check timed out after $startupTimeoutSeconds seconds."
    }
    $serviceErrorLog = Join-Path $dataRoot "service-error.log"
    $failureMessage += "`r`n`r`nService log: $serviceErrorLog"
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show(
            $failureMessage,
            "Iwara 本地播放列表启动失败",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } catch {
        Add-Content -LiteralPath $launcherErrorLog -Value "[$(Get-Date -Format s)] $failureMessage" -Encoding UTF8
    }
    exit 1
}
