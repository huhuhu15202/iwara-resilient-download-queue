$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataRoot = "F:\IwaraVideos\R18\ServiceData"
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
