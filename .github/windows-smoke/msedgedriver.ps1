# Downloads the msedgedriver that matches the runner's WebView2 runtime into $out (installing the Evergreen runtime
# first when none is registered).
param([Parameter(Mandatory)][string]$out)
$ErrorActionPreference = "Stop"
$keys = @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
function Get-Runtime {
  foreach ($k in $keys) { if (Test-Path $k) { $v = (Get-ItemProperty $k).pv; if ($v) { return $v } } }
  return $null
}
$runtime = Get-Runtime
if (-not $runtime) {
  Write-Host "No WebView2 runtime registered; installing the Evergreen runtime"
  $boot = "$env:RUNNER_TEMP\MicrosoftEdgeWebview2Setup.exe"
  Invoke-WebRequest "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $boot
  Start-Process $boot -ArgumentList "/silent", "/install" -Wait
  $runtime = Get-Runtime
}
if (-not $runtime) { throw "WebView2 runtime version not found" }
$edge = (Get-Item "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -ErrorAction SilentlyContinue).VersionInfo.ProductVersion
Write-Host "WebView2 runtime $runtime; Edge $edge"
$major = $runtime.Split(".")[0]
New-Item -ItemType Directory -Force $out | Out-Null
$zip = "$out\edgedriver.zip"
$candidates = @($runtime)
try {
  $raw = (Invoke-WebRequest "https://msedgedriver.microsoft.com/LATEST_RELEASE_${major}_WINDOWS" -UseBasicParsing).Content
  if ($raw -is [byte[]]) { $raw = [System.Text.Encoding]::Unicode.GetString($raw) }
  $latest = $raw.Trim([char]0xFEFF).Trim()
  Write-Host "Latest driver for major ${major}: $latest"
  $candidates += $latest
} catch { Write-Host "LATEST_RELEASE_${major}_WINDOWS: $_" }
$got = $null
foreach ($v in $candidates) {
  try { Invoke-WebRequest "https://msedgedriver.microsoft.com/$v/edgedriver_win64.zip" -OutFile $zip -UseBasicParsing; $got = $v; break }
  catch { Write-Host "no driver $v : $_" }
}
if (-not $got) { throw "no msedgedriver for $($candidates -join ', ')" }
Expand-Archive $zip -DestinationPath $out -Force
& "$out\msedgedriver.exe" --version
"WebView2 runtime $runtime; Edge $edge; msedgedriver $got" | Out-File "$out\versions.txt"
