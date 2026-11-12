# The sign-in tunnel's local end is a private socket and a port Rust holds

An SSH sign-in (ADR 0003) sends the dashboard password through a tunnel. The tunnel picked a free port by binding `127.0.0.1:0` and closing it, then started `ssh -L 127.0.0.1:<port>:127.0.0.1:9119`. OpenSSH binds that port only after it connects and signs in, so the port stayed free for up to a few seconds. The app took the first connection that succeeded on the port as the tunnel, and the sign-in then posted the password to it. Another program on this computer that bound the port in that gap got the password (#342). ADR 0114 already named this race and avoided it for server pages.

## Decisions

- **The sign-in tunnel uses the server page's two halves (ADR 0114).** ssh forwards a Unix socket in a new private folder (mode 0700, in `$XDG_RUNTIME_DIR`, else the temporary folder) to `127.0.0.1:9119` on the server. Rust waits until the socket accepts, then binds `127.0.0.1:0` itself, keeps that listener and copies each connection to and from the socket. The sign-in, the WebSocket and every REST call use that port, as they used ssh's port before. Rust holds the port from the moment it binds it until the tunnel closes, so no other program can listen on it.
- **ssh gets two more options.** `StreamLocalBindMask=0177` lets only the owner connect to the socket. `StreamLocalBindUnlink=yes` replaces a stale socket file. `ExitOnForwardFailure=yes` stays, so ssh exits when it can't make the socket.
- **Closing the tunnel ends all of it.** Dropping the tunnel ends ssh, stops the relay and its copies, and removes the socket's folder. The folder has the same `hermes-chat-page-<pid>-…` name as a page's, so the sweep that removes folders left by a killed app removes it too.
- **One implementation.** `tunnel.rs` uses `server_page.rs`'s `LocalEnd`, `connect` and `serve`, so the sign-in tunnel and the page tunnels make their local end the same way.

## Considered options

- **Check that the status answer comes from this owner's Hermes before sending the password.** Issue #342 suggested checking the `install_id` hash on every route. The port would still be free for another program to take, which would then have to fake that hash. Not enough on its own, and it depends on the separate issue about 404 statuses.
- **Check the owner of the TCP listener before the sign-in.** On Linux, `/proc/net/tcp` gives the owner's uid but not the process, and another program run by the same user would pass. Not pursued, because the socket removes the gap entirely.
- **HTTP and WebSocket clients that connect to the socket directly, with no TCP port.** No other local account could reach the dashboard then. Not done here: the dashboard's base URL is used by reqwest and by two WebSocket clients, and each would need a socket connector.

## Consequences

- **On Windows ssh listens on nothing.** Windows' OpenSSH can't listen on a Unix socket. Until ADR 0157 ssh listened on a loopback port there instead, which another program could take first (#354, ADR 0140) and which every account could connect to (#506). Now each connection the relay takes is an `ssh -W` of its own, so no port is released and none but the relay's is open (ADR 0157).
- **Other local programs can still connect.** Any program on this computer can connect to the relay's port while the app is signed in. On Linux and Windows, since ADR 0105, the relay closes a connection from a program run by another account unanswered. On Windows ssh has no port of its own since ADR 0157, so such a program has no other way in (#506).
- **The readiness check connects to the socket**, not to a TCP port. As before, it opens a channel to the dashboard and closes it. On Windows it sends `HEAD /` through one `ssh -W` and waits for any answer (ADR 0157).
