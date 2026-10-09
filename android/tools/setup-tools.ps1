param([string]$ToolRoot)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ([string]::IsNullOrWhiteSpace($ToolRoot)) {
    $ToolRoot = if ($env:IWARA_ANDROID_TOOLS) { $env:IWARA_ANDROID_TOOLS } else { Join-Path $env:LOCALAPPDATA 'IwaraAndroidBuildTools' }
}
New-Item -ItemType Directory -Path $ToolRoot -Force | Out-Null
$javaDirectory = Get-ChildItem -LiteralPath $ToolRoot -Directory -Filter 'jdk-*' | Select-Object -First 1
if (-not $javaDirectory) {
    $asset = (Invoke-RestMethod 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse')[0]
    $archive = Join-Path $ToolRoot 'jdk.zip'
    Invoke-WebRequest -Uri $asset.binary.package.link -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.binary.package.checksum) { throw 'JDK checksum mismatch' }
    Expand-Archive -LiteralPath $archive -DestinationPath $ToolRoot -Force
    $javaDirectory = Get-ChildItem -LiteralPath $ToolRoot -Directory -Filter 'jdk-*' | Select-Object -First 1
}
$env:JAVA_HOME = $javaDirectory.FullName
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$env:ANDROID_USER_HOME = Join-Path $ToolRoot 'user'
$sdkDirectory = Join-Path $ToolRoot 'sdk'
$manager = Join-Path $ToolRoot 'tools\cmdline-tools\bin\sdkmanager.bat'
if (-not (Test-Path -LiteralPath $manager)) {
    $archive = Join-Path $ToolRoot 'commandline-tools.zip'
    Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a') { throw 'Android SDK checksum mismatch' }
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $ToolRoot 'tools') -Force
}
1..12 | ForEach-Object { 'y' } | & $manager "--sdk_root=$sdkDirectory" --licenses
if ($LASTEXITCODE -ne 0) { throw 'SDK license setup failed' }
& $manager "--sdk_root=$sdkDirectory" 'platforms;android-35' 'build-tools;35.0.0' 'platform-tools'
if ($LASTEXITCODE -ne 0) { throw 'SDK installation failed' }
Write-Output "Portable Android build tools ready: $ToolRoot"
