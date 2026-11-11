# Dashboard requests never go through a proxy

Issue #479. ADR 0104 let reqwest use a proxy set in the environment (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`) for requests to the dashboard. Two things went wrong with that.

- **The SSH route went through the proxy.** Its dashboard is the sign-in tunnel's local end, `http://127.0.0.1:<port>/` (ADR 0098), and reqwest doesn't leave loopback out of a proxy unless `NO_PROXY` names it. A test showed the proxy receiving `POST /api/auth/password-login` with the password in clear. A local proxy such as mitmproxy or clash would see every sign-in.
- **A URL route split in two.** The `/api/ws` socket never uses a proxy (tokio-tungstenite connects directly). On a network that reaches the dashboard only through a proxy, the status read and the sign-in went through and the socket then failed.

## Decisions

- **No proxy for the dashboard.** The client every dashboard request uses (`transport::client`) is built with `no_proxy()`. The status read, the sign-in, the ticket, every REST call and the socket all go straight to the dashboard on either route.
- **Other requests are unchanged.** A web page check and a Markdown image (ADR 0136) still use the environment's proxy, since they go to other sites.

## Considered options

- **`no_proxy()` only for a loopback dashboard.** It fixes the SSH route. A URL route would still sign in through the proxy and then fail at the socket.
- **Send the socket through the proxy as well.** That needs an HTTP CONNECT step before the WebSocket handshake, and proxy credentials. No owner has asked for a dashboard behind a proxy, so that waits until one does.

## Consequences

- A dashboard reachable only through a proxy doesn't connect, and now fails at the status read instead of at the socket.
- ADR 0104's note on proxies no longer holds.
