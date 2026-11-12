# Every port a real sign-in tunnel and a real server page listen on, tried by a program run by another local account
# (#378, #506, ADR 0105). Run from src-tauri on a disposable Windows runner: it adds a local account and writes the
# runner account's ~/.ssh/config. Windows' own ssh signs in to a stand-in sshd on this computer, whose loopback serves
# a stand-in dashboard and a stand-in page. The script lists every port held by the test process and the processes it
# started (ssh among them). curl run as the new account must get nothing from any of them. curl run as this account must
# get the page through its relay.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:RUNNER_TEMP 'relay-other-account'
New-Item -ItemType Directory -Force $dir | Out-Null
icacls $dir /grant 'Everyone:(OI)(CI)F' | Out-Null
$env:PATH = "$env:WINDIR\System32\OpenSSH;$env:PATH"
"ssh: $((Get-Command ssh).Source) $(cmd /c "ssh -V 2>&1")"

foreach ($site in @(@{ Port = 8765; Body = 'the dashboard' }, @{ Port = 8766; Body = 'a server page' })) {
    $root = Join-Path $dir "web$($site.Port)"
    New-Item -ItemType Directory -Force $root | Out-Null
    $site.Body | Out-File -Encoding ascii -NoNewline (Join-Path $root 'index.html')
    Start-Process python -ArgumentList '-m', 'http.server', $site.Port, '--bind', '127.0.0.1', '--directory', $root -NoNewWindow | Out-Null
}
python -m pip install -q asyncssh
if ($LASTEXITCODE -ne 0) { throw "pip install asyncssh failed: $LASTEXITCODE" }
Start-Process python -ArgumentList "$PSScriptRoot\sshd.py" -NoNewWindow -RedirectStandardOutput "$dir\sshd.out" -RedirectStandardError "$dir\sshd.err" | Out-Null
$sshDir = Join-Path $HOME '.ssh'
New-Item -ItemType Directory -Force $sshDir | Out-Null
@"
Host hvprobe
  HostName 127.0.0.1
  Port 2222
  User probe
  StrictHostKeyChecking no
  UserKnownHostsFile $($dir -replace '\\', '/')/known_hosts
Host hvnowhere
  HostName 127.0.0.1
  Port 9
  User probe
"@ | Out-File -Encoding ascii (Join-Path $sshDir 'config')

$env:RELAY_DIR = $dir
$env:TUNNEL_TARGET = 'hvprobe'
$env:TUNNEL_DASHBOARD_PORT = '8765'
$env:TUNNEL_PAGE_PORT = '8766'
$env:TUNNEL_CLOSED_PORT = '8767'
$env:TUNNEL_UNREACHABLE_TARGET = 'hvnowhere'
$test = 'server_page::tests::real_tunnels_for_a_program_run_by_another_account'
$relay = Start-Process cargo -ArgumentList 'test', '--lib', $test, '--', '--ignored', '--exact', $test, '--nocapture' -PassThru -NoNewWindow -RedirectStandardOutput "$dir\relay.out" -RedirectStandardError "$dir\relay.err"
for ($i = 0; $i -lt 900 -and -not (Test-Path "$dir\ports") -and -not $relay.HasExited; $i++) { Start-Sleep 1 }
if (-not (Test-Path "$dir\ports")) { Get-Content "$dir\relay.out", "$dir\relay.err", "$dir\sshd.out", "$dir\sshd.err" -ErrorAction SilentlyContinue; throw 'the tunnels never opened' }
$testPid, $signInPort, $pagePort = (Get-Content "$dir\ports").Trim() -split ' '

$processes = Get-CimInstance Win32_Process
$tree = @([int]$testPid)
do {
    $more = @($processes | Where-Object { $tree -contains $_.ParentProcessId -and $tree -notcontains $_.ProcessId } | ForEach-Object { [int]$_.ProcessId })
    $tree += $more
} while ($more.Count)
"the test and what it started:"
$processes | Where-Object { $tree -contains $_.ProcessId } | ForEach-Object { "  $($_.ProcessId) $($_.Name)" }
$listening = @(Get-NetTCPConnection -State Listen | Where-Object { $tree -contains $_.OwningProcess })
"listening:"
$listening | ForEach-Object { "  $($_.LocalAddress):$($_.LocalPort) pid $($_.OwningProcess)" }
$urls = @($listening | ForEach-Object {
        $host_ = switch ($_.LocalAddress) { '0.0.0.0' { '127.0.0.1'; break } '::' { '[::1]'; break } { $_ -like '*:*' } { "[$_]" } default { $_ } }
        "http://${host_}:$($_.LocalPort)/"
    } | Sort-Object -Unique)
if (-not ($listening | Where-Object LocalPort -eq $signInPort)) { throw "the sign-in tunnel's relay port $signInPort isn't listed" }
if (-not ($listening | Where-Object LocalPort -eq $pagePort)) { throw "the page's relay port $pagePort isn't listed" }
$urls | Out-File -Encoding ascii "$dir\urls.txt"

$curl = "$env:WINDIR\System32\curl.exe"
$mine = & $curl -s -m 10 "http://127.0.0.1:$pagePort/"
"$(whoami) through the page's relay: exit=$LASTEXITCODE body=[$mine]"

$user = 'hvrelayother'
$pw = 'P!' + [guid]::NewGuid().ToString('N').Substring(0, 9) + 'aA1'
net user $user $pw /add | Out-Null
if ($LASTEXITCODE -ne 0) { throw "net user failed: $LASTEXITCODE" }
@'
param($dir)
whoami | Out-File "$dir\theirs-who.txt"
$out = foreach ($url in Get-Content "$dir\urls.txt") {
    $b = & "$env:WINDIR\System32\curl.exe" -s -m 10 $url
    "$url exit=$LASTEXITCODE body=[$b]"
}
$out | Out-File "$dir\theirs.txt"
'@ | Out-File "$dir\as-them.ps1"
$cred = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$user", (ConvertTo-SecureString $pw -AsPlainText -Force))
Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$dir\as-them.ps1", $dir -Credential $cred -WorkingDirectory $dir -Wait -LoadUserProfile
$who = Get-Content "$dir\theirs-who.txt" -ErrorAction SilentlyContinue
$theirs = @(Get-Content "$dir\theirs.txt" -ErrorAction SilentlyContinue)
"${who}:"
$theirs | ForEach-Object { "  $_" }
New-Item "$dir\done" -ItemType File | Out-Null
$relay.WaitForExit(120000) | Out-Null
net user $user /delete | Out-Null

if (-not ("$mine" -match 'a server page')) { throw "this account's program wasn't relayed to the page" }
if (-not $who -or $who -notmatch $user) { throw 'curl never ran as the other account' }
if ($theirs.Count -ne $urls.Count) { throw "the other account tried $($theirs.Count) of $($urls.Count) ports" }
$reached = @($theirs | Where-Object { $_ -match 'the dashboard|a server page' })
if ($reached) { throw "another account's program reached the server: $($reached -join '; ')" }
# 7: nothing listens. 52 and 56: curl connected, and the port closed the connection with nothing sent back.
$answered = @($theirs | Where-Object { $_ -notmatch ' exit=(7|52|56) body=\[\]$' })
if ($answered) { throw "a port answered the other account: $($answered -join '; ')" }
"no port of the tunnels served the other account"
