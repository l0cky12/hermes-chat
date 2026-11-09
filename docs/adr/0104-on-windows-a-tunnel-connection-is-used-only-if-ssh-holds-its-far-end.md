# On Windows a tunnel connection is used only if ssh holds its far end

ADR 0098 gave the sign-in tunnel a local end no other program can take on Linux: ssh forwards a Unix socket in a private folder. Windows' OpenSSH can't forward a Unix socket, so on Windows `LocalEnd` still binds `127.0.0.1:0`, reads the port, closes it, and has ssh bind that port after it signs in. A program that bound the port in that gap got the relay's connections, among them the sign-in POST with the dashboard password (#354). A test on Windows showed it: the program that took the port received `POST /api/auth/password-login` with the password.

## Decisions

- **Every connection to ssh's port is checked before anything is sent on it.** On Windows, `server_page::connect` connects to `127.0.0.1:<port>`, then reads Windows' IPv4 TCP table (`GetExtendedTcpTable`, `TCP_TABLE_OWNER_PID_ALL`). The row whose local end is the port and whose remote end is this connection's own end names the process holding the far end. A connection ssh hasn't accepted yet already has that row, owned by the listener's process; a Windows test checks this against the real table. The readiness check and each connection the relay makes go through `connect`, so the sign-in request and every later request reach ssh or go nowhere.
- **ssh, or a process ssh started, counts.** Scoop and Chocolatey put a shim named `ssh.exe` on PATH that runs the real `ssh.exe` as its child, so the process holding the port may be ssh's descendant. A process counts if it is the ssh child the app started, or if walking up its parents (a process snapshot, `CreateToolhelp32Snapshot`) reaches that child within eight steps. Each process on the way must have started no earlier than its parent, so a process whose parent's id Windows has since given to ssh doesn't count. The app holds ssh's process handle, so Windows gives ssh's id to no other process while the tunnel lives.
- **Anything else ends the attempt.** Another process, or a table or process Windows can't read, fails the connection with `PermissionDenied`. The message says which: "process N is listening on 127.0.0.1:P, and Hermes Chat couldn't confirm it is the ssh it started", or "Hermes Chat couldn't check which program is listening on 127.0.0.1:P". The readiness check then stops the sign-in at once with "Hermes Chat didn't sign in through the SSH tunnel: …", and the password is never sent. A relay connection is closed without sending anything.
- **Server pages get the same check.** They share `LocalEnd`, `connect` and `serve` with the sign-in tunnel (ADR 0052, ADR 0098). They carry no password, but the check costs nothing extra there. A page whose port another program holds doesn't open, and says why.
- **Linux is unchanged.** The check is compiled only for Windows. The logic that reads table rows and walks parents is plain Rust and is unit-tested on Linux too.

## Considered options

- **Read the listener table once, when the port first accepts.** Issue #354 suggested `TCP_TABLE_OWNER_PID_LISTENER` after readiness. A program could still bind the same address afterwards (Windows allows a second socket on an address when the first wasn't bound exclusively) or listen on `0.0.0.0:<port>`, and later connections, including the sign-in POST, would not be checked. Checking each connection's own far end leaves no gap between the check and the bytes sent.
- **A named pipe or an AF_UNIX socket on Windows.** The OpenSSH builds Windows ships can't forward one. Revisit if they gain it.
- **A job object per ssh, counting any process in the job.** It would recognise a shim's child without walking parents, but a shim can start the real ssh before the app adds the shim to the job, unless ssh starts suspended, which `std::process::Command` can't resume.
- **Check the dashboard's `install_id` before sending the password.** As in ADR 0098, a program holding the port would only have to fake it.

## Consequences

- **A program that takes the port can stop the sign-in, not read it.** The port is still free between `LocalEnd::new` and ssh's bind. Taking it now makes the sign-in fail with a clear error, and signing in again picks a new port.
- **Programs with full access to ssh are not stopped.** One that can open ssh's process with full rights (the same account, or an administrator) can start a process with ssh as its parent, or read the app's memory. That is outside what this check guards against.
- **Each connection costs a TCP table read**, plus a process snapshot when ssh runs behind a shim. The relay makes one connection per request it relays, and HTTP clients reuse connections.
- **Other local programs can still connect to the relay's port**, as ADR 0098 says.
