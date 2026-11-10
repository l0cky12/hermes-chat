# Connection routes (ADR 0120, issue #191)

Taken on 2026-11-04 from the real Tauri debug build (WebKitGTK) on an Xvfb display, 1280 × 820, app data and keyring in
a throwaway folder (`setup/start-app.sh`). The dashboards are two `FakeHermes` stand-ins (`bridge.ts`) on loopback:
`127.0.0.2:19191` as the home server and `127.0.0.3:19191` as a different install, with synthetic chats and a
throwaway password. `192.168.77.10` and `100.101.102.103` are addresses with nothing behind them, so they time out;
`liam@hermes-box` is an SSH host that doesn't resolve. No real server, address or user data is shown. Clicks are real
xdotool clicks; framebuffer captures, not retouched.

Before (`main` at af77a05):

- `before-1-server-step.png`: Setup's Server step. One way to reach the server: SSH or URL.
- `before-2-test.png`: the Sign in step's test, for that one address.
- `before-3-rail-tip.png`: the rail's connection tip: status and address.
- `before-4-settings.png`: Settings → Connection: the connection's one address.

After:

- `after-1a-route-tests.png`, `after-1b-routes-tested-one-off.png`: the Routes list. Each route has a kind, an address
  (completed with `http://` and `:9119`), Test, up, down, Use and Remove. Test reaches the route without the
  password: the two dead addresses time out, the stand-in is reached, the unknown SSH host is unreachable. The SSH
  route is turned off (kept, not tried).
- `after-2a-testing.png`: Sign in step, Test connection: each route in turn, the next ones waiting.
- `after-2-sign-in-test.png`: how each route went, with the password; at least one works.
- `after-3-rail-tip.png`: connected over the third route: "Home server · via LAN".
- `after-4-settings.png`: Settings: "4 routes: LAN, Tailscale, LAN and SSH", and the connection in use "via LAN
  (fallback)".
- `after-5-wrong-server.png`: a fifth route added at `127.0.0.3:19191`, another Hermes install. Its Test says Wrong
  server, before any password is sent, and offers Trust this server for a reinstall.
- `after-6-every-route-failed.png`: the sign-in screen once the stand-in is stopped: the routes in order, and why each
  one failed.

Rerun: `npx rolldown docs/screenshots/connection-routes/bridge.ts --platform node -o /tmp/routes-bridge.mjs`, then
`node /tmp/routes-bridge.mjs 127.0.0.2 19191 install-home` and `node /tmp/routes-bridge.mjs 127.0.0.3 19191
install-neighbour`, `npx vite --port 1420`, then `setup/start-app.sh <binary>` and `setup/routes.sh`.
