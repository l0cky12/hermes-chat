# A relay port serves only programs run by the owner's account

The sign-in tunnel (ADR 0098) and every server-page tunnel (ADR 0114) relay through a TCP listener Rust holds on `127.0.0.1:<ephemeral>`. Until this change, `server_page::serve` accepted every connection. Any program on the computer, under any account, could connect while the app was signed in. It could then reach the dashboard on the server's loopback, or a page's dev server. A dashboard with sign-in off, because it listens only on the server's loopback (`transport.rs`, `GateOff`), is then an unauthenticated Hermes that can run agent tools (#355).

## Decisions

- **The relay closes a connection from another account unanswered.** For each connection it accepts, `serve` finds the account that runs the program at the other end (`loopback_peer.rs`). When that account isn't the app's own, `serve` drops the connection before it opens ssh's socket. Nothing reaches the server.
- **On Linux the owner comes from `/proc/net/tcp`.** TCP has no `SO_PEERCRED`. The peer's socket has a row in `/proc/net/tcp` whose local address is the peer's `127.0.0.1:<port>` and whose remote address is the relay's. That row gives the socket's uid, which is compared with `getuid()`. A program on an IPv6 socket that connects through `::ffff:127.0.0.1` is listed in `/proc/net/tcp6`, so that table is read too.
- **On Windows the owner comes from the TCP table and the process's token (#378).** `GetExtendedTcpTable` lists each IPv4 connection with the process that holds it. The peer's row is the one whose local address is the peer's `127.0.0.1:<port>` and whose remote address is the relay's. `OpenProcess` and `OpenProcessToken` on that process give its account's SID (`TokenUser`), which is compared with the SID of the app's own token.
- **It fails closed.** A connection whose row isn't found, or whose tables can't be read, counts as another account's. A row in TIME_WAIT lists uid 0 and names no owner, so it counts as not found. On Windows, a process the app can't open, or whose token it can't read, counts as another account's. Without administrator rights, the app can't open another account's process.
- **One check for both tunnels.** The check is in `serve`, which the sign-in tunnel and the page tunnels share (ADR 0098, "One implementation").

## Considered options

- **Point the HTTP and WebSocket clients at ssh's Unix socket, so the sign-in tunnel has no TCP port.** reqwest 0.13 can send over a Unix socket (`ClientBuilder::unix_socket`). The two WebSocket clients would each need a connector of their own, and the dashboard's base URL would no longer be an address on this computer. Windows' OpenSSH can't listen on a Unix socket, so Windows would keep the TCP path. Server pages need a TCP port for the frame either way, so the relay check is needed regardless. Rejected: it adds a second transport and still leaves the relay to protect.
- **`SO_PEERCRED` on a Unix socket the webview connects to.** The frame loads `http://127.0.0.1:<port>`, an address the webview reaches over TCP, so a page tunnel needs a TCP port.
- **Only `/proc/net/tcp`, not `tcp6`.** A program could connect from an IPv6 socket to `::ffff:127.0.0.1`, and its row would not be found. The fail-closed rule would refuse it, so this is safe, but it would also refuse a program run by the owner's account. Both tables are read.
- **A secret on every request (Windows, #378).** The sign-in's clients could send a token, but a page in the frame makes its own requests, and the relay would have to parse HTTP and WebSocket traffic to find it. It also wouldn't cover ssh's own port. Rejected.
- **A named pipe or a Unix socket in place of the relay's port on Windows.** The frame loads `http://127.0.0.1:<port>`, so a page needs a TCP port, as on Linux. Windows' OpenSSH can't listen on a Unix socket either.
- **Netlink `sock_diag` for an exact lookup by address.** It answers in one request without reading every socket. It needs more code and a netlink socket. The `/proc` tables are small on a desktop, and the read happens once per connection.

## Consequences

- **Other accounts on Linux can't use the relay.** They can still connect to the port, which the kernel accepts, but the relay closes the connection unanswered. A program run by the owner's account can still use it, as can the webview.
- **Root is not stopped.** Root can read the app's memory and the owner's SSH keys in any case.
- **A process in another user namespace** shows in `/proc/net/tcp` as its uid mapped into the app's namespace. That is never the app's own uid unless the namespace maps it there, which only the owner or root can arrange.
- **On Windows another account can still use ssh's own port.** ssh listens on `127.0.0.1:<port>` for its `-L` forward, and that port accepts every account. Windows' OpenSSH (9.5p2) can't listen on a Unix socket: it answers `unix_listener: cannot bind to path …: Operation not supported`. A run on a Windows runner with a second local account reached the stand-in dashboard through that port. Issue #506 tracks closing it.
- **On Windows only the IPv4 table is read.** A program that reaches `127.0.0.1` from an IPv6 socket through `::ffff:127.0.0.1` isn't found, so it is refused, even when the owner runs it.
- **macOS admits every connection.** The app isn't built for macOS, and there `loopback_peer::runs_as` always says yes.
- **The cost is one read of each table per connection**, in the connection's own task. A page that makes many requests reads them once per connection, not per request. On Windows, a connection also costs opening its process and that process's token.
- **The Windows check runs in CI.** The `windows-installer` job adds a local account and runs curl as it against the relay (`.github/windows-relay/other-account.ps1`). The relay must answer curl run as the app's account and close on curl run as the new one.
