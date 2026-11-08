# Sign in straight to a dashboard URL too, and label it Unsecure unless Tailscale or loopback carries it

Besides the SSH tunnel (ADR 0003), the sign-in screen can take a dashboard URL such as `http://hermes:9119`, with the same username and password. A connection is **Unsecure** when it uses `http://` or `ws://`, unless its host is loopback (`localhost`, `127.0.0.0/8`, `::1`), a MagicDNS name (`*.ts.net`), a Tailscale address (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`), or a bare name (no dots, such as `hermes`) whose addresses all fall in those ranges. Tailscale encrypts the traffic in all of those cases. SSH connections are never Unsecure.

Carrier-grade NAT uses `100.64.0.0/10` too (RFC 6598), so an address there is Tailscale only if Tailscale carries it. Rust asks the routing table which address this computer sends from to reach it (a UDP socket connected to it, which sends nothing). A plain `http://` route to an address in that range is refused unless that source address is in `100.64.0.0/10` as well, as it is for a tailnet peer (`transport::check_plain_http`). Otherwise the route goes out through the LAN's gateway, and the password would cross the carrier's network in the clear. A route that connects is therefore over Tailscale, and the label above stays true.

Rust resolves the host name when it connects and reports the addresses with the route. The webview makes the Unsecure decision (`src/hermes/unsecure.ts`), so the rule lives in one place and is tested through the frontend transport.

## Considered options

- **Exempt any name that resolves into the Tailscale ranges, dotted or not.** Rejected: only a bare name is clearly a tailnet short name. A dotted public name that happens to resolve to a Tailscale address today could resolve elsewhere tomorrow.
- **Decide in Rust.** Rejected: the frontend owns what the owner sees, and keeping the rule in TypeScript keeps it next to the other connection logic and its tests.
- **Count `100.64.0.0/10` as Tailscale by its range alone.** Rejected (#346): with Tailscale off, or for an address that isn't a tailnet peer, plain http goes to the carrier, labelled as encrypted.
- **Refuse plain `http://` to `100.64.0.0/10` always, or ask the owner to tick "this is my tailnet".** Rejected: the first breaks every route typed as a Tailscale IP, and the second is a claim the routing table can check.
- **Look for a network interface named `tailscale0`.** Rejected: the name differs by platform, and the source address answers the question for the address being reached.

## Consequences

- The name is resolved again on every reconnect, so the label follows a name that moves off (or onto) the tailnet. The HTTP and WebSocket clients still do their own lookups, so a name that changes between the check and the connect can be labelled from the earlier answer.
- `ws://` and `wss://` URLs are taken as `http://` and `https://`.
- A computer that holds a carrier's `100.64.0.0/10` address itself, such as one with a built-in mobile modem, sends from that address, so the check takes the carrier's network for Tailscale there.
- With Tailscale off, a plain `http://` route to a Tailscale IP fails and says to turn Tailscale on. The next route is tried.
