# Sign in straight to a dashboard URL too, and label it Unsecure unless Tailscale or loopback carries it

Besides the SSH tunnel (ADR 0003), the sign-in screen can take a dashboard URL such as `http://hermes:9119`, with the same username and password. A connection is **Unsecure** when it uses `http://` or `ws://`, unless its host is loopback (`localhost`, `127.0.0.0/8`, `::1`), a MagicDNS name (`*.ts.net`), a Tailscale address (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`), or a bare name (no dots, such as `hermes`) whose addresses all fall in those ranges. Tailscale encrypts the traffic in all of those cases. SSH connections are never Unsecure.

Rust resolves the host name when it connects and reports the addresses with the route. The webview makes the Unsecure decision (`src/hermes/unsecure.ts`), so the rule lives in one place and is tested through the frontend transport.

## Considered options

- **Exempt any name that resolves into the Tailscale ranges, dotted or not.** Rejected: only a bare name is clearly a tailnet short name. A dotted public name that happens to resolve to a Tailscale address today could resolve elsewhere tomorrow.
- **Decide in Rust.** Rejected: the frontend owns what the owner sees, and keeping the rule in TypeScript keeps it next to the other connection logic and its tests.

## Consequences

- The name is resolved again on every reconnect, so the label follows a name that moves off (or onto) the tailnet. The HTTP and WebSocket clients still do their own lookups, so a name that changes between the check and the connect can be labelled from the earlier answer.
- `ws://` and `wss://` URLs are taken as `http://` and `https://`.
