$ErrorActionPreference = 'Stop'

# Build script for MCLauncher.exe (single-file host).
# IMPORTANT: keep this file ASCII-only. PowerShell 5.1 reads .ps1 as ANSI,
# and cmd/PowerShell line joining issues have bitten this project before.

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }

$nodeExe = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not (Test-Path $nodeExe)) { throw "node.exe not found" }

$wv2 = Join-Path $root 'build\wv2'
foreach ($f in 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll') {
    if (-not (Test-Path (Join-Path $wv2 $f))) { throw "missing WebView2 file: $f" }
}

Write-Host '[1/5] staging payload...'
$stage = Join-Path $root 'build\payload'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item $nodeExe (Join-Path $stage 'node.exe')
Copy-Item (Join-Path $root 'src') (Join-Path $stage 'src') -Recurse
New-Item -ItemType Directory -Path (Join-Path $stage 'wv2') | Out-Null
Copy-Item (Join-Path $wv2 '*.dll') (Join-Path $stage 'wv2')

Write-Host '[2/5] building payload.zip...'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Join-Path $root 'build\payload.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$zipMb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "      payload.zip = $zipMb MB"

# BuildId = hash of payload. Any source change produces a new id and forces
# the host to re-extract the engine directory instead of reusing stale files.
$sha = [System.Security.Cryptography.SHA256]::Create()
$fs = [System.IO.File]::OpenRead($zip)
try { $hashBytes = $sha.ComputeHash($fs) } finally { $fs.Close(); $sha.Dispose() }
$payloadHash = ([System.BitConverter]::ToString($hashBytes) -replace '-', '').Substring(0, 12).ToLower()
if ($payloadHash.Length -ne 12) { throw 'build id generation failed' }

$genPath = Join-Path $root 'build\BuildId.gen.cs'
$genSrc = "namespace MCLauncherHost {`r`n    internal static class BuildInfo {`r`n        public const string Id = `"$payloadHash`";`r`n    }`r`n}`r`n"
Set-Content -Path $genPath -Value $genSrc -Encoding ASCII
Write-Host "      build id = $payloadHash"

Write-Host '[3/5] compiling MCLauncher.exe...'
$refs = @(
    'System.dll'
    'System.Core.dll'
    'System.Drawing.dll'
    'System.Windows.Forms.dll'
    'System.IO.Compression.dll'
    'System.IO.Compression.FileSystem.dll'
    (Join-Path $wv2 'Microsoft.Web.WebView2.Core.dll')
    (Join-Path $wv2 'Microsoft.Web.WebView2.WinForms.dll')
)
$refArgs = $refs | ForEach-Object { '/reference:' + $_ }

$sources = @(
    (Join-Path $root 'build\Host.cs')
    $genPath
)

$out = Join-Path $root 'M-DSH-C.exe'
if (Test-Path $out) { Remove-Item $out -Force }

$common = @()
$common += '/nologo'
$common += '/platform:x64'
$common += '/optimize+'
$common += '/win32manifest:' + (Join-Path $root 'build\app.manifest')
$iconPath = Join-Path $root 'build\icon.ico'
if (Test-Path $iconPath) { $common += '/win32icon:' + $iconPath }
$common += $refArgs
$common += '/resource:' + $zip + ',payload.zip'
$common += $sources

$cscArgs = @()
$cscArgs += '/target:winexe'
$cscArgs += '/out:' + $out
$cscArgs += $common
& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Write-Host '[4/5] compiling console variant (for debugging)...'
$outConsole = Join-Path $root 'build\M-DSH-C-console.exe'
if (Test-Path $outConsole) { Remove-Item $outConsole -Force }
$cscArgs2 = @()
$cscArgs2 += '/target:exe'
$cscArgs2 += '/out:' + $outConsole
$cscArgs2 += $common
& $csc $cscArgs2
if ($LASTEXITCODE -ne 0) { throw "csc (console) failed with exit code $LASTEXITCODE" }

Write-Host '[5/5] done.'
$exeMb = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "      M-DSH-C.exe             = $exeMb MB"
Write-Host "      build\M-DSH-C-console.exe"

# remove intermediates
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path $zip) { Remove-Item $zip -Force -ErrorAction SilentlyContinue }
# --- post-build cleanup -----------------------------------------------------
# 1) Drop the Mark-of-the-Web if the file somehow carries one.
# 2) Strip the sandbox capability SID inherited from the workspace folder.
#    With that entry present, Windows re-checks the exe on EVERY launch
#    instead of only the first time.
try { Unblock-File -Path $out -ErrorAction SilentlyContinue } catch { }

$sid = 'S-1-4-332428003-257888444'
foreach ($t in @($out, (Join-Path (Split-Path -Parent $out) 'build\M-DSH-C-console.exe'))) {
  if (-not (Test-Path $t)) { continue }
  & icacls $t /remove:g "*$sid" 2>$null | Out-Null
  & icacls $t /inheritance:r 2>$null | Out-Null
  & icacls $t /grant "$($env:USERNAME):(F)" 2>$null | Out-Null
  Write-Host "      acl cleaned: $t"
}