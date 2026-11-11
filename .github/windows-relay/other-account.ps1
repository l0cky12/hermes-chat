# The relay from a program run by another local account (#378, ADR 0105). Run from src-tauri on a disposable Windows
# runner: it adds a local account. The relay serves this account; curl run as the new account must get nothing, and
# curl run as this account must get the stand-in dashboard.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:RUNNER_TEMP 'relay-other-account'
New-Item -ItemType Directory -Force $dir | Out-Null
icacls $dir /grant 'Everyone:(OI)(CI)F' | Out-Null
$env:RELAY_DIR = $dir
$relay = Start-Process cargo -ArgumentList 'test', '--lib', 'the_relay_for_a_program_run_by_another_account', '--', '--ignored', '--exact', 'server_page::tests::the_relay_for_a_program_run_by_another_account' -PassThru -NoNewWindow -RedirectStandardOutput "$dir\relay.out" -RedirectStandardError "$dir\relay.err"
for ($i = 0; $i -lt 600 -and -not (Test-Path "$dir\port"); $i++) { Start-Sleep 1 }
if (-not (Test-Path "$dir\port")) { Get-Content "$dir\relay.out", "$dir\relay.err" -ErrorAction SilentlyContinue; throw 'the relay never wrote its port' }
$url = "http://127.0.0.1:$((Get-Content "$dir\port").Trim())/"

$curl = "$env:WINDIR\System32\curl.exe"
$mine = & $curl -s -m 10 $url
"$(whoami): exit=$LASTEXITCODE body=[$mine]"

$user = 'hvrelayother'
$pw = 'P!' + [guid]::NewGuid().ToString('N').Substring(0, 9) + 'aA1'
net user $user $pw /add | Out-Null
if ($LASTEXITCODE -ne 0) { throw "net user failed: $LASTEXITCODE" }
'param($url, $dir) whoami | Out-File "$dir\theirs-who.txt"; $b = & "$env:WINDIR\System32\curl.exe" -s -m 10 $url; "exit=$LASTEXITCODE body=[$b]" | Out-File "$dir\theirs.txt"' | Out-File "$dir\as-them.ps1"
$cred = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$user", (ConvertTo-SecureString $pw -AsPlainText -Force))
Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$dir\as-them.ps1", $url, $dir -Credential $cred -WorkingDirectory $dir -Wait -LoadUserProfile
$who = Get-Content "$dir\theirs-who.txt" -ErrorAction SilentlyContinue
$theirs = Get-Content "$dir\theirs.txt" -ErrorAction SilentlyContinue
"${who}: $theirs"
New-Item "$dir\done" -ItemType File | Out-Null
$relay.WaitForExit(120000) | Out-Null
net user $user /delete | Out-Null

if (-not ("$mine" -match 'the dashboard')) { throw "this account's program wasn't relayed" }
if (-not $who -or $who -notmatch $user) { throw 'curl never ran as the other account' }
if ("$theirs" -match 'the dashboard') { throw "another account's program reached the dashboard through the relay" }
# 52 and 56: curl connected, and the relay closed the connection with nothing sent back.
if (-not ("$theirs" -match '^exit=(52|56) body=\[\]$')) { throw "the other account's curl didn't connect and get closed: $theirs" }
'the relay served this account and refused the other'
