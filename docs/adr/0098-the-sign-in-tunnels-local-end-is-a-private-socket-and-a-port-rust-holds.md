# The sign-in tunnel's local end is a private socket and a port Rust holds

An SSH sign-in (ADR 0003) sends the dashboard password through a tunnel. The tunnel picked a free port by binding `127.0.0.1:0` and closing it, then started `ssh -L 127.0.0.1:<port>:127.0.0.1:9119`. OpenSSH binds that port only after it connects and signs in, so the port stayed free for up to a few seconds. The app took the first connection that succeeded on the port as the tunnel, and the sign-in then posted the password to it. Another program on this computer that bound the port in that gap got the password (#342). ADR 0052 already named this race and avoided it for server pages.

## Decisions

- **The sign-in tunnel uses the server page's two halves (ADR 0052).** ssh forwards a Unix socket in a new private folder (mode 0700, in `$XDG_RUNTIME_DIR`, else the temporary folder) to `127.0.0.1:9119` on the server. Rust waits until the socket accepts, then binds `127.0.0.1:0` itself, keeps that listener and copies each connection to and from the socket. The sign-in, the WebSocket and every REST call use that port, as they used ssh's port before. Rust holds the port from the moment it binds it until the tunnel closes, so no other program can listen on it.
- **ssh gets two more options.** `StreamLocalBindMask=0177` lets only the owner connect to the socket. `StreamLocalBindUnlink=yes` replaces a stale socket file. `ExitOnForwardFailure=yes` stays, so ssh exits when it can't make the socket.
- **Closing the tunnel ends all of it.** Dropping the tunnel ends ssh, stops the relay and its copies, and removes the socket's folder. The folder has the same `hermes-chat-page-<pid>-…` name as a page's, so the sweep that removes folders left by a killed app removes it too.
- **One implementation.** `tunnel.rs` uses `server_page.rs`'s `LocalEnd`, `connect` and `serve`, so the sign-in tunnel and the page tunnels make their local end the same way.

## Considered options

- **Check that the status answer comes from this owner's Hermes before sending the password.** Issue #342 suggested checking the `install_id` hash on every route. The port would still be free for another program to take, which would then have to fake that hash. Not enough on its own, and it depends on the separate issue about 404 statuses.
- **Check the owner of the TCP listener before the sign-in.** On Linux, `/proc/net/tcp` gives the owner's uid but not the process, and another program run by the same user would pass. Not pursued, because the socket removes the gap entirely.
- **HTTP and WebSocket clients that connect to the socket directly, with no TCP port.** No other local account could reach the dashboard then. Not done here: the dashboard's base URL is used by reqwest and by two WebSocket clients, and each would need a socket connector.

## Consequences

- **On Windows the race remains.** Windows' OpenSSH can't listen on a Unix socket, so there `LocalEnd` still picks a loopback port and releases it for ssh to bind, as it does for pages (ADR 0052). A program that takes that port first gets the relay's connections.
- **Other local programs can still connect.** Any program on this computer can connect to the relay's port while the app is signed in. On Linux, since ADR 0103, the relay closes a connection from a program run by another account unanswered. On Windows and macOS such a program can still reach the dashboard through it (#378), and a dashboard that needs no sign-in, because it listens only on the server's loopback, is open to it.
- **The readiness check connects to the socket**, not to a TCP port. As before, it opens a channel to the dashboard and closes it.
