# On Windows each tunnel connection is an ssh of its own that listens on nothing

> **Supersedes [ADR 0140](0140-on-windows-a-tunnel-connection-is-used-only-if-ssh-holds-its-far-end.md)** (#354), except its job objects, which stay.

ADR 0105 made the relay close a connection from a program run by another account. On Windows each tunnel had a second port, which the relay check never saw: ssh's own `-L 127.0.0.1:<port>`, and ssh accepts every account there. A run on a Windows runner showed it (#506, run 42936496314). A second local account fetched the stand-in dashboard through ssh's port. A dashboard with sign-in off is then an unauthenticated Hermes that can run agent tools. Linux closes this with a Unix socket in a 0700 folder (ADR 0098), but Windows' OpenSSH (9.5p2) refuses one: `unix_listener: cannot bind to path …: Operation not supported`.

## Decisions

- **On Windows ssh listens on nothing.** The relay's port is the only one a tunnel opens. For each connection the relay accepts, and only after the account check (ADR 0105), it starts `ssh <options> -W <host>:<port> -- <target>`. It then copies the connection to and from that ssh's stdin and stdout (`server_page::connect`, `Through`). When the connection, the tunnel or the app closes, that ssh ends, with anything it started, because each ssh still goes into the job objects of ADR 0140.
- **Each ssh gets the options the `-L` ssh had.** The sign-in tunnel keeps its options (`tunnel.rs`) and a server page keeps `SSH_OPTIONS` (ADR 0114). `-W` takes the place of `-N -L …`. Each ssh also gets `ClearAllForwardings=yes`, since `-W` drops the forwards in the owner's config only while that config leaves `ClearAllForwardings` unset. It also gets `StdinNull=no`, since a config's `StdinNull yes` would stop ssh reading the connection. Options on the command line beat the config.
- **One connection proves the tunnel works.** The sign-in tunnel sends `HEAD /` to the dashboard through one ssh and opens when any byte comes back. It fails with what ssh said if ssh ends first, and with the timeout if neither happens. A server page sends its usual probe (ADR 0114). ssh has 20 s to sign in and the page has the same 20 s to answer. No answer by then, with ssh still running, opens the page, as a slow page does on Linux.
- **ssh's exit tells why a connection closed unanswered.** A `channel N: open failed` line means ssh signed in and nothing on the server answered at the port, so the page says so with that line. Any other failing exit means ssh couldn't sign in or start, and the app shows what ssh said.
- **ADR 0140's check is gone.** It checked that ssh held the far end of each connection to ssh's port. There is no such port now, so `loopback_owner.rs` is deleted. No port is released for ssh to bind either, so the race of #354 can't happen.
- **Linux is unchanged.** ssh forwards a Unix socket in a private folder there, as ADR 0098 and ADR 0114 say.

## Considered options

The issue named three options. Each was weighed against the same four tests: the simplest design, the least code, whether it removes the port rather than guards it, and whether it keeps the owner's own `ssh`, `~/.ssh/config`, agent and keys (ADR 0003).

- **`ssh -W` for each connection.** Chosen. It removes ssh's listener, which is the cause, rather than guarding it. It deletes more code than it adds: ADR 0140's table and process checks go. It keeps ADR 0003, since the owner's ssh still makes every connection. Its costs are the consequences below.
- **Wait for Win32-OpenSSH to forward Unix sockets.** Windows has AF_UNIX, but OpenSSH 9.5p2 refuses to listen on one, so nothing can be done today. If a later release can, Windows could use Linux's private socket and drop the extra sign-ins.
- **A Rust SSH client.** Rust would own both ends and could multiplex every connection over one sign-in. It would need a new SSH stack, and the app would lose the owner's `~/.ssh/config`, agent, `ProxyJump` and security keys, which ADR 0003 chose ssh to keep. It is the most code of the options.
- **One ssh to a small relay program on the server.** One sign-in could carry every connection through a program on the server that speaks a framing protocol over ssh's stdin and stdout. It needs that program on every server and a protocol of the app's own. That is more code than `-W` and a new dependency on the server.
- **Limit how many ssh sign-ins run at once.** That keeps a page's first load under sshd's `MaxStartups` (below), but adds a queue to every connection. Not done until a refused connection is seen in use.

## Consequences

- **Another account on Windows gets nothing from any port of a tunnel.** The `windows-installer` job checks this with real Windows OpenSSH (`.github/windows-relay/other-account.ps1`). It opens a sign-in tunnel and a server page against a stand-in sshd, through an ssh config that keeps a `LocalForward` and sets `StdinNull yes`, lists every port held by the test process and the processes it started, and runs curl against each as a new local account. Any answer fails the job.
- **Each new connection is a full SSH sign-in on Windows.** Windows' OpenSSH can't share connections (ControlMaster needs a Unix socket), so each TCP connection the frame, the dashboard client or a WebSocket opens costs one SSH handshake and sign-in. HTTP clients reuse a connection for many requests, so the cost is per connection, not per request. Signing in waits for one sign-in more than before: the readiness check makes one, and the first request makes its own.
- **A security key that needs a touch asks for one touch per connection.** A key file, or a key in the agent that needs no touch, asks for nothing.
- **A page's first load can start several sign-ins at once.** Chromium opens up to six connections to a host. sshd's default `MaxStartups 10:30:100` refuses some new connections once ten are still signing in, so two pages loading at once can lose a request.
- **Each open connection is a running ssh** and an SSH session on the server, until the client closes it. An idle keep-alive connection keeps its ssh too.
- **On Windows a page no longer closes when ssh ends.** No ssh lives between connections, so when the server goes away the page's requests fail one by one. Reload tries again, because each new connection signs in again.
