# A relay port serves only programs run by the owner's account

The sign-in tunnel (ADR 0098) and every server-page tunnel (ADR 0114) relay through a TCP listener Rust holds on `127.0.0.1:<ephemeral>`. Until this change, `server_page::serve` accepted every connection. Any program on the computer, under any account, could connect while the app was signed in. It could then reach the dashboard on the server's loopback, or a page's dev server. A dashboard with sign-in off, because it listens only on the server's loopback (`transport.rs`, `GateOff`), is then an unauthenticated Hermes that can run agent tools (#355).

## Decisions

- **The relay closes a connection from another account unanswered.** For each connection it accepts, `serve` finds the account that runs the program at the other end (`loopback_peer.rs`). When that account isn't the app's own, `serve` drops the connection before it opens ssh's socket. Nothing reaches the server.
- **On Linux the owner comes from `/proc/net/tcp`.** TCP has no `SO_PEERCRED`. The peer's socket has a row in `/proc/net/tcp` whose local address is the peer's `127.0.0.1:<port>` and whose remote address is the relay's. That row gives the socket's uid, which is compared with `getuid()`. A program on an IPv6 socket that connects through `::ffff:127.0.0.1` is listed in `/proc/net/tcp6`, so that table is read too.
- **It fails closed.** A connection whose row isn't found, or whose tables can't be read, counts as another account's. A row in TIME_WAIT lists uid 0 and names no owner, so it counts as not found.
- **One check for both tunnels.** The check is in `serve`, which the sign-in tunnel and the page tunnels share (ADR 0098, "One implementation").

## Considered options

- **Point the HTTP and WebSocket clients at ssh's Unix socket, so the sign-in tunnel has no TCP port.** reqwest 0.13 can send over a Unix socket (`ClientBuilder::unix_socket`). The two WebSocket clients would each need a connector of their own, and the dashboard's base URL would no longer be an address on this computer. Windows' OpenSSH can't listen on a Unix socket, so Windows would keep the TCP path. Server pages need a TCP port for the frame either way, so the relay check is needed regardless. Rejected: it adds a second transport and still leaves the relay to protect.
- **`SO_PEERCRED` on a Unix socket the webview connects to.** The frame loads `http://127.0.0.1:<port>`, an address the webview reaches over TCP, so a page tunnel needs a TCP port.
- **Only `/proc/net/tcp`, not `tcp6`.** A program could connect from an IPv6 socket to `::ffff:127.0.0.1`, and its row would not be found. The fail-closed rule would refuse it, so this is safe, but it would also refuse a program run by the owner's account. Both tables are read.
- **Netlink `sock_diag` for an exact lookup by address.** It answers in one request without reading every socket. It needs more code and a netlink socket. The `/proc` tables are small on a desktop, and the read happens once per connection.

## Consequences

- **Other accounts on Linux can't use the relay.** They can still connect to the port, which the kernel accepts, but the relay closes the connection unanswered. A program run by the owner's account can still use it, as can the webview.
- **Root is not stopped.** Root can read the app's memory and the owner's SSH keys in any case.
- **A process in another user namespace** shows in `/proc/net/tcp` as its uid mapped into the app's namespace. That is never the app's own uid unless the namespace maps it there, which only the owner or root can arrange.
- **Windows and macOS admit every connection.** There, `loopback_peer::runs_as` always says yes and ADR 0098's and ADR 0114's consequences still hold. Issue #378 tracks a Windows check (`GetExtendedTcpTable` and the owning process's SID) and a macOS check.
- **The cost is one read of each table per connection**, in the connection's own task. A page that makes many requests reads them once per connection, not per request.
