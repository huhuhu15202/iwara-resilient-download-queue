param(
    [string]$ToolRoot,
    [switch]$TestMode,
    [switch]$PersonalBuild
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ToolRoot)) {
    $ToolRoot = if ($env:IWARA_ANDROID_TOOLS) { $env:IWARA_ANDROID_TOOLS } else { Join-Path $env:LOCALAPPDATA 'IwaraAndroidBuildTools' }
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$javaDirectory = Get-ChildItem -LiteralPath $ToolRoot -Directory -Filter 'jdk-*' | Select-Object -First 1
if (-not $javaDirectory) { throw 'Run setup-tools.ps1 first' }
$env:JAVA_HOME = $javaDirectory.FullName
$env:PATH = "$(Join-Path $javaDirectory.FullName 'bin');$env:PATH"
$env:ANDROID_HOME = Join-Path $ToolRoot 'sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

$gradleVersion = '8.13'
$gradleHome = Join-Path $ToolRoot "gradle-$gradleVersion"
$gradle = Join-Path $gradleHome 'bin\gradle.bat'
if (-not (Test-Path -LiteralPath $gradle)) {
    $archive = Join-Path $ToolRoot "tools\gradle-$gradleVersion-bin.zip"
    New-Item -ItemType Directory -Path (Split-Path -Parent $archive) -Force | Out-Null
    if (-not (Test-Path -LiteralPath $archive)) {
        Invoke-WebRequest -Uri "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip" -OutFile $archive
    }
    $unpack = Join-Path $ToolRoot ("gradle-extract-$gradleVersion-" + [guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $archive -DestinationPath $unpack
    Move-Item -LiteralPath (Join-Path $unpack "gradle-$gradleVersion") -Destination $gradleHome
}

$variant = if ($PersonalBuild) { 'personal' } else { 'standard' }
$buildType = if ($TestMode) { 'Debug' } else { 'Release' }
$task = ":app:assemble$($variant.Substring(0,1).ToUpperInvariant())$($variant.Substring(1))$buildType"
& $gradle --no-daemon --stacktrace --project-dir $projectRoot "-PtoolRoot=$ToolRoot" $task
if ($LASTEXITCODE -ne 0) { throw "Gradle build failed: $task" }

$sourceFile = if ($TestMode) { "app-$variant-debug.apk" } else { "app-$variant-release.apk" }
$sourceApk = Join-Path $projectRoot "app\build\outputs\apk\$variant\$($buildType.ToLowerInvariant())\$sourceFile"
if (-not $TestMode -and -not (Test-Path -LiteralPath $sourceApk)) {
    $sourceApk = Join-Path $projectRoot "app\build\outputs\apk\$variant\release\app-$variant-release-unsigned.apk"
}
if (-not (Test-Path -LiteralPath $sourceApk)) { throw "Gradle did not produce $sourceApk" }
$output = Join-Path $projectRoot 'output'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$suffix = if ($PersonalBuild) { '' } else { '-standard' }
$name = if ($TestMode) { "IwaraLocal-0.3.11$suffix-debug.apk" } else { "IwaraLocal-0.3.11$suffix.apk" }
$apk = Join-Path $output $name
$apksigner = Join-Path $ToolRoot 'sdk\build-tools\35.0.0\lib\apksigner.jar'
$java = Join-Path $javaDirectory.FullName 'bin\java.exe'
if ($TestMode) {
    Copy-Item -LiteralPath $sourceApk -Destination $apk -Force
} else {
    $signingRoot = Join-Path $ToolRoot 'signing'
    $passwordFile = Join-Path $signingRoot 'password.txt'
    $keystore = Join-Path $signingRoot 'iwara-local.jks'
    if (-not (Test-Path -LiteralPath $passwordFile) -or -not (Test-Path -LiteralPath $keystore)) {
        throw 'Release signing files are missing; refusing to publish an unsigned APK.'
    }
    $env:IWARA_APK_SIGNING_PASSWORD = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
    try {
        & $java -jar $apksigner sign --ks $keystore --ks-key-alias iwara-local `
            --ks-pass 'env:IWARA_APK_SIGNING_PASSWORD' --key-pass 'env:IWARA_APK_SIGNING_PASSWORD' --out $apk $sourceApk
    } finally {
        Remove-Item Env:IWARA_APK_SIGNING_PASSWORD -ErrorAction SilentlyContinue
    }
    if ($LASTEXITCODE -ne 0) { throw 'APK signing failed' }
    # Personal intermediates contain the private LAN token; keep only the final APK.
    Remove-Item -LiteralPath $sourceApk -Force
}
& $java -jar $apksigner verify --verbose $apk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
Get-Item -LiteralPath $apk | Select-Object FullName, Length
Get-FileHash -LiteralPath $apk -Algorithm SHA256
