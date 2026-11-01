# Sign in through an SSH tunnel to the existing dashboard, with its password

The app reaches Hermes by spawning the system `ssh` to forward a local port to the server's `127.0.0.1:9119`, where the owner's `hermes dashboard` already runs. It then signs in with the dashboard's `basic` username and password, mints a one-time ticket, and opens the JSON-RPC WebSocket at `/api/ws`. All network I/O happens in Rust. The webview only sends and receives JSON-RPC frames, so CORS and the dashboard's `Origin` checks never apply. The app speaks the legacy protocol generation only, because that's what the dashboard on 9119 serves (`gateway.ready` has no `session_authority`).

The dashboard is bound to `0.0.0.0`, and its auth gate depends on the bind address, not on who connects. So the password is needed even through the tunnel. SSH supplies the encryption and the reachability; the password supplies the dashboard identity.

## Considered options

- **Spawn an isolated loopback `hermes serve` over SSH, as the official app's SSH mode does** (`--ssh-session-token-file`, no password). Rejected for now: it runs a second Hermes backend on a server whose disk is about 95% full, and the reuse, lockfile and cleanup lifecycle is more code than the tracer bullet needs.
- **Connect straight to `http://hermes:9119`.** Not pursued: the plan is to sign in over SSH. Plain `http://` is encrypted only while Tailscale carries it, and the app would have to label it Unsecure. Later added as a second way to sign in, alongside SSH (ADR 0004).

## Consequences

- The sign-in screen asks for an SSH target (for example `liam@10.2.1.136`, or a `~/.ssh/config` alias) and the dashboard username and password. `ssh` runs with `BatchMode=yes`, so the key must work without a prompt (agent or unencrypted key).
- If the server ever switches to the canonical generation (`gateway.ready.session_authority: true`), the app refuses to continue rather than mixing schemas.
- Once a sign-in succeeds, the password is saved in the system keyring (the Secret Service: GNOME Keyring or KWallet), and the app signs in with it at launch. Sign out in Settings deletes it. The rest of the sign-in (target, URL, username) stays in localStorage, so the sign-in screen after Sign out asks only for the password. If the keyring can't save, the sign-in still goes ahead and the app says the password wasn't kept.
- The chat list needs dashboard REST, because the legacy `session.list` has no last-activity time. Rust keeps the sign-in cookies, including the ones the dashboard sends back when it refreshes an expired session, and relays the webview's REST calls. It only relays `GET` and `PATCH` to paths under `api/`, and passes the bodies through without parsing them.
