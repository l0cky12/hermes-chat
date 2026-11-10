# Setup tests a sign-in before keeping it, and provider keys go only to the server

> **Extended by [ADR 0054](0054-setup-can-stop-a-sign-in-and-runs-again-from-the-sign-in-screen.md)** (#101): Save and connect can be stopped, the sign-in screen offers Run setup again for its connection, the provider step can be skipped, and late answers are dropped.

On a computer with nothing set up, the app opens **Setup** instead of the bare sign-in screen. Setup asks for the server (SSH target or dashboard URL), then the dashboard username and password, and tests them with `hermes_probe` before anything is saved. The test runs the same steps as a real sign-in (ADR 0003, ADR 0004): open the tunnel or resolve the URL, read the public `GET /api/status`, sign in, open `/api/ws` and wait for the first frame. Then it drops everything. It reports the stage that failed (`address`, `reach`, `sign-in`, `chat`), and the webview turns that and the error text into what to fix (`src/hermes/setup.ts`). Only **Save and connect** signs in for real and saves the password in the keyring, as the sign-in screen does.

After connecting, Setup offers to give Hermes a model provider's API key. The key goes to the server through `hermes_save_provider_key`, which does what the dashboard's Keys page does: `GET /api/env` must list the variable as a provider's secret, `POST /api/providers/validate` asks the provider, and `PUT /api/env` saves it in the profile's `.env`. Hermes Chat never stores the key.

## Considered options

- **Test by connecting for real.** Rejected: Rust holds one connection, so testing a new server from Settings would drop the one in use, and a failed test would leave the owner with none.
- **Let the webview's REST relay `PUT /api/env` and `POST /api/providers/validate`.** Rejected: the relay passes bodies through unread, so the webview could write any variable in the profile's `.env`, `HERMES_*` included. A dedicated command builds the body in Rust and writes only a variable that Hermes lists as a provider's secret. It also keeps the relay's verb allow-list as it is.
- **Keep provider keys in this computer's keyring too.** Rejected: Hermes reads keys from its own `.env`. A second copy would only go stale, and it would be one more place a key can leak from.
- **Show Setup to every install once, after an update.** Rejected: an install with a saved sign-in already works. Launch signs in as before, and after Sign out the sign-in screen asks only for the password.

## Consequences

- An install counts as set up when the sign-in saved beside the keyring has a target, URL or username (`isSetUp`). Setup opens by itself only when it has none.
- Setup opens again from Settings (**Run setup again**) and from the sign-in screen (**Set up a different server…**). From Settings, the connection in use carries on during the test. Cancel or Escape leaves it as it was. **Save and connect** closes it first, because its reconnects would otherwise take Rust's one connection back. If the new connection still fails, the saved one is put back as at launch.
- A URL's extra request headers (ADR 0104) are edited in Setup as on the sign-in screen, through the same fields. The test sends them with every request, `GET /api/status` included, and stops at a redirect to another site as a sign-in does. From Settings, Setup starts from the connection in use, header values included; changing the URL clears them.
- A test can be stopped. Rust aborts it, which also ends its SSH tunnel. Each step has a 15-second limit, so a test reports where it stuck.
- A provider key's requests follow a redirect only within the dashboard's origin, with or without extra request headers, so the key can't be sent on to another site. Errors from them never include Hermes's or the provider's text, which can quote part of the key.
- With extra request headers set, a refusal (401, 403 or 407) is never shown at any step, as a gateway can repeat the values it turned down. Other errors, and the chat connection's close reason, are shown only when they repeat no 8 characters of a header value, so a value cut short still counts; an error body only as the dashboard's JSON `detail`. Without headers, errors are shown as before. A request that got no answer is reported without its URL, which a redirect can fill with a header value or a provider key. A redirect to another site names that site only when its address repeats no header value.
- Providers that sign in with an account (OAuth, such as Nous Portal or a Codex subscription) can't be set up from Hermes Chat. Setup says to set them up on the server.
