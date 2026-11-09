# Sign-in methods are what Hermes advertises, and their secrets stay in Rust

> **Accepted and built for discovery and token sign-in** (#93): sections 1 and 2. Browser sign-in (section 3), passkeys through it (section 4), and Sign-in needed with the identity check (section 5) are still proposed and not built.

Hermes Chat signs in only with the dashboard's username and password (ADR 0003, ADR 0004). A Hermes dashboard can also be set up to take a provisioned token or a browser sign-in through an identity provider. Issue #93 asks the app to offer the methods a server supports and nothing else, while keeping password sign-in as it is. This ADR records what Hermes offers, which of those methods the app supports, and where each secret lives.

## What Hermes advertises

These were read in the Hermes source. The owner's server runs `bf0203a` (2026-10-22). A newer checkout, `b200f5bc` (2026-11-03), was also read, and each fact below says which build has it.

- **`GET /api/status`**, public, on both builds. It answers `auth_required`, `auth_providers` and `auth_flows`. `auth_providers` names every registered provider, including ones that can't be signed in to from a browser. `auth_flows` lists `cookie` whenever the gate is on, and adds `native_pkce` when at least one provider has a browser sign-in (`hermes_cli/web_routers/status.py`, `_auth_gate_status`). The owner's server answered `auth_providers: ["basic", "conduit-local-live"]` and `auth_flows: ["cookie", "native_pkce"]` on 2026-10-31.
- **`GET /api/auth/providers`**, public, on both builds. It lists the providers a person can sign in to (`interactive_login`), each with `name`, `display_name` and `supports_password`. It answers `503` when no session provider is registered. A gate with only the session token answers an empty list.
- **Providers bundled with Hermes**: `basic` (username and password), `self-hosted` (any OIDC identity provider, through `.well-known/openid-configuration`), `nous` (Nous Portal), `session-token` (the provisioned `HERMES_DASHBOARD_SESSION_TOKEN`, only from `2edfd0d`, 2026-10-28) and `drain-secret` (a service credential, never a sign-in). `conduit-local-live` isn't in Hermes's source. The owner's server gets it from somewhere else.

## Decisions

### 1. Discovery decides what the sign-in screen offers

Before it shows the sign-in fields for a connection, the app reads `GET /api/status` through the tunnel or the URL, as `hermes_probe` already does. When `auth_flows` has `native_pkce`, it also reads `GET /api/auth/providers`. Rust parses both and hands the webview a list of methods, never raw answers:

| Method | Shown when | Notes |
|---|---|---|
| **Password** | a provider in `/api/auth/providers` has `supports_password`, or `auth_providers` has `basic` | Signs in with that provider's `name`, no longer a hard-coded `basic`. With several password providers, a picker shows their `display_name`s. When none can be read, it is `basic`, as today. |
| **Token** | `auth_providers` has `session-token` | |
| **Browser** (one per provider) | `auth_flows` has `native_pkce`, and `/api/auth/providers` lists a provider without `supports_password` | Labelled with the provider's `display_name`, such as "Sign in with Self-Hosted OIDC". |

- A provider the app doesn't recognise, such as `conduit-local-live` or `drain-secret`, isn't offered. The Diagnostics tab still lists its name, as it does today (ADR 0044).
- When the answer is missing or can't be read (an older Hermes, a timeout, or a gateway's login page), the screen offers Password only, as it does today. It never fails closed to nothing. A connection that signs in with a token is offered Token beside it, and the screen says it couldn't read the server's methods. For a password connection that guess is what the screen always showed, so it says nothing.
- When `auth_required` is `false`, the dashboard is bound to loopback and needs a per-process token that the app has no way to get. The screen says so. This is out of scope, as it is today.
- **The picker.** The sign-in screen and Setup's sign-in step show the methods as one segmented control above the fields, reachable by keyboard, with the chosen method's fields below it. The method the connection used last is picked first. With one method, there is no picker, so a password-only server looks as it does now. Setup reads the methods once the server's address is entered, as its test already reads `/api/status`.
- The connection records the method it signed in with (`password`, `token` or `browser:<provider>`) beside its address in `hermes-chat.connections`. A method isn't a secret. Launch and reconnect use the recorded method without asking again. If a later `/api/status` no longer offers that method, the sign-in screen says so and offers the ones it does.

### 2. Token sign-in (first PR)

- **Entry.** A masked field with no autocomplete and no spellcheck, as for the provider key (ADR 0054). Its value goes to Rust once, in the connect or test command, and is never read back into the webview.
- **Storage.** The keyring entry is `dashboard-token/<id>` (service `hermes-chat`, named by `saved_password::account`, ADR 0112). Its value is `{"v":1,"for":[[mode,target],…],"token":…}`, one `[mode,target]` for each route the token was entered for (ADR 0120), as a password is saved with every route. Rust saves it only after a sign-in with the typed token went through, and only when the address that sign-in used is among them. **Rust** loads the token at connect time and uses it only while the route's mode and target are in `for`, so a token is never sent to an edited address (ADR 0112's rule, applied in Rust instead of the webview). The webview learns only which addresses a token is saved for, so a route it wasn't saved for is skipped until the token is typed again, as with a password.
- **On the wire.** `Authorization: Bearer <token>` on every REST request and on `POST /api/auth/ws-ticket`. `/api/ws` opens with the one-time `?ticket=` as it does today, never `?token=`, so the token never appears in a URL. A same-origin redirect is followed and any other redirect is refused (ADR 0104, ADR 0112). If the connection's Extra request headers already set `Authorization`, token sign-in is refused, with a message naming the header.
- **Check.** Before the token goes out, the `/api/status` read before every sign-in must list `session-token` (an unreadable status doesn't stop it). Setup's test and the sign-in then read `GET /api/auth/me` with the token. A `401` means the token is wrong or was rotated. The answer's `provider` must be `session-token`.
- **Expiry and revoke.** The session-token provider has no expiry, refresh or revoke: a token stops working when the server's token is replaced. Sign out deletes it from this computer's keyring and says so: "To revoke it, replace `HERMES_DASHBOARD_SESSION_TOKEN` on the server." A `401` on a connection that was working becomes **Sign-in needed** (section 5), not a reconnect loop. Until section 5 is built, a token turned down while reconnecting puts the connection Offline at once, without the retries a dropped connection gets.
- **Server version.** Needs a Hermes with the session-token provider, from `2edfd0d` on. The owner's server (`bf0203a`) doesn't have it and doesn't advertise it, so the screen won't offer Token there.

### 3. Browser sign-in through Hermes, for OIDC and Nous Portal (second PR)

Hermes brokers the identity provider (RFC 8252). To the app, Hermes is the authorization server, and Hermes is the OAuth client of the provider, because the provider accepts only Hermes's own callback. So the app runs the native flow against Hermes, never against the provider directly.

1. Rust makes a PKCE verifier (32 random bytes, base64url), its S256 challenge and a `state` (32 random bytes). It listens on `127.0.0.1` on a port the system picks.
2. Rust opens the system browser with `xdg-open` (`web_page::open_in_browser`, as Preview's Open in your browser does) at `{dashboard}/auth/native/authorize?provider=<name>&code_challenge=…&code_challenge_method=S256&redirect_uri=http://127.0.0.1:<port>/callback&state=…`. The webview never opens it. The URL holds no secret: the challenge is public and the state is single use.
3. The listener accepts one request: `GET /callback` with exactly one `code` and one `state`. It compares `state` in constant time and answers a fixed page ("You can close this tab and go back to Hermes Chat") that echoes nothing from the request. Anything else gets a `400`, the flow carries on, and nothing is logged. The flow ends after one valid callback, 10 minutes (Hermes's own pending limit), or Cancel. Then the listener closes.
4. Rust posts `{code, code_verifier}` to `POST /auth/native/token`. The answer has `access_token`, `refresh_token`, `expires_at`, `provider` and `user_id`. A `provider` other than the one asked for fails the sign-in.
5. The access token stays in Rust's memory and goes out as `Authorization: Bearer` on REST requests and when minting a WS ticket. The refresh token goes to the keyring as `dashboard-refresh/<id>`, with `{"v":1,"for":[mode,target],"provider":…,"user_id":…,"refresh_token":…}`. Neither token ever reaches the webview.
6. **Refresh.** One refresh at a time per connection: when `expires_at` is within 60 seconds, or when a request answers `401`, Rust posts `{refresh_token, provider}` to `/auth/native/refresh`. It saves the rotated refresh token before using the new access token. A `401 session_expired` deletes the refresh token and sets **Sign-in needed**. A `503` keeps it and goes Offline, retrying as a dropped connection does.
7. **Nonce.** No ID token reaches the app, so a nonce has nothing to bind on the app's side. State and PKCE cover the app's leg. Hermes runs the provider's leg with its own state and PKCE cookie. Its `self-hosted` provider sends no `nonce` upstream (see the capability gap).
8. **Where it works.** For a **URL** connection, the browser goes to the same dashboard the app uses. Over **SSH**, the browser opens the tunnel's local port. The provider then sends the browser back to the callback Hermes registered with it, which is Hermes's `public_url` (or, with none set, the tunnel's own address, which the provider is unlikely to accept). Hermes keeps the flow's PKCE cookie on the address the browser started at, the tunnel's, so a callback that lands on another address finds no cookie and Hermes answers `400 Missing PKCE state cookie`. The flow therefore works over SSH only when the callback registered with the provider is the tunnel's own local address, which is rare. Browser sign-in is still offered over SSH, as the owner chose, with a note under the button saying that it usually needs a URL connection to the dashboard's public address. When no callback comes, the screen says the browser didn't finish and names that as the likely cause once the flow ends (10 minutes or Cancel). Extra request headers aren't sent by the system browser, so a gateway such as Cloudflare Access asks the browser to sign in to it as well.

Password providers also accept the native flow (Hermes shows its `/login` form in the browser). The app keeps its own password form for them, as today, so this PR doesn't change password sign-in.

### 4. Passkeys come through the browser, not the app

Hermes has no WebAuthn relying party: no dashboard provider registers or checks a passkey. A passkey can belong only to the upstream identity provider, so its relying-party ID is that provider's domain. A Tauri webview's origin (`tauri://localhost`) can't claim that domain, so the app never runs WebAuthn itself. Browser sign-in (section 3) is the supported handoff: the provider's page runs in the owner's own browser, where the passkey's origin rules hold. No separate passkey code is planned. The sign-in screen's help text says that a passkey works when the identity provider offers one.

### 5. Session expiry, sign-out and signing in again

- **Sign-in needed.** A new connection state, for a credential that Hermes turned down while connected (`401` after a refresh attempt, or a turned-down token). The socket closes, the app stops reconnecting, and a banner offers **Sign in again**. Drafts stay, because they are local and kept under the connection's scope (ADR 0112). Queued messages pause.
- **No queued work under another identity.** Every method, password included, records the identity it signed in as, from `GET /api/auth/me` (`provider` and `user_id`). After signing in again, the queue resumes only if the identity is the same. Otherwise the queue stays paused and the app says the sign-in is a different account, so the owner chooses. When `/api/auth/me` can't be read, a password connection resumes only if it signed in again with the same password provider and the same username as before: a username is an identity only within its provider, so `alice` at another provider is another account. Anything else, and a token or browser connection, keeps the queue paused. Failed messages are never resent on their own (ADR 0018).
- **Sign out.** Password: as now. Token: deletes `dashboard-token/<id>`. Browser: deletes `dashboard-refresh/<id>` and drops the access token from memory. There is no server-side revoke for a native token (see the gap), so the screen says the session ends when its refresh token expires on the server. Removing a connection deletes all four keyring entries before anything else (ADR 0112).
- **Several connections.** Every secret and identity is keyed by connection id, and Rust holds one connection (ADR 0112), so two connections can't share tokens. A refresh that finishes after a switch updates only its own connection's keyring entry, and its access token is dropped with that connection.

## Capability gap in Hermes, and a proposed backend design

- **No revoke for native tokens.** `POST /auth/logout` revokes only the refresh token in the session cookie. A native app holds its refresh token in its own store and can't revoke it. (Sending it as a `hermes_session_rt` cookie to `/auth/logout` would work today, but it relies on undocumented behaviour that could change, so the app doesn't.) A hermes-chat issue tracks this, opened with the Browser sign-in PR. Proposal: `POST /auth/native/revoke {refresh_token, provider}`, public like `/auth/native/refresh`, answering `204` whether or not the token was known (RFC 7009), and calling `revoke_session` on the named provider.
- **No nonce on the OIDC leg.** `self-hosted` sends `state` and a PKCE challenge to the identity provider but no `nonce`, and doesn't check one in the ID token. PKCE already stops code injection for this flow, but OIDC asks for a nonce when an ID token is used. Proposal: send a random nonce in the same PKCE cookie and check the ID token's `nonce` claim in `complete_login`.
- **`auth_providers` doesn't say what each provider is.** A client has to know names (`session-token`) to tell a token gate from a sign-in. Proposal: `/api/status.auth_methods: [{name, kind: "password"|"browser"|"token"|"service", display_name}]`.
- **No passkey provider.** Passkeys depend on the upstream identity provider. A Hermes-native WebAuthn provider would need its relying-party ID to be the dashboard's `public_url` domain, and would still be signed in to through the system browser.
- **Token sign-in needs `2edfd0d` or later**, which the owner's server doesn't run yet.

## Delivery

One method per PR. Each PR says which method it covers and is "Part of #93" until the last one.

1. **Discovery and Token** (built): this ADR, `/api/status` and `/api/auth/providers` parsing, the method picker, the token keyring entry, and bearer transport. A turned-down token goes Offline.
2. **Browser sign-in**: the loopback listener, PKCE and state, token exchange, refresh, refresh-token storage, and Browser sign-in on the sign-in screen and in Setup. Passkeys are covered by this flow, as section 4 says.
3. **Sign-in needed and the identity check** (section 5), in PR 2 or a last PR, which says `Fixes #93`.

## Verification

- Token: a throwaway `hermes dashboard --isolated` from the newer checkout, bound to `127.0.0.2` so the gate is on, with a throwaway `HERMES_HOME` and `HERMES_DASHBOARD_SESSION_TOKEN`, as earlier research probes did. The owner's server can't run it until Hermes is updated.
- Browser: the same throwaway dashboard with `basic`, signed in through the native flow in the system browser, which covers the app's whole leg (listener, state, PKCE, token, refresh). An OIDC provider leg needs a test identity provider (such as a local Dex). If none is set up, the PR reports that leg as not checked live.
- Unit tests in Rust for the callback parser (wrong state, a repeated or missing parameter, the wrong path or method, a second callback), PKCE values, keyring binding to the address, refresh single-flight and rotation, and the redirect refusal. Frontend tests for the method picker per `/api/status` shape, Sign-in needed, and the queue held for another identity.

## Considered options

- **Be an OIDC client of the identity provider directly**, with the app's own client id and nonce. Rejected: Hermes checks its own session tokens, and the provider accepts only Hermes's registered callback. Hermes has a native broker for exactly this case.
- **Sign in to the provider in a Tauri webview window and take the cookie**, as the official app's fallback does. Rejected: the window can't satisfy a passkey's origin, can't use the owner's password manager, and would put a session cookie inside the webview process.
- **Send the token as `?token=` on `/api/ws`.** Rejected: URLs end up in proxy and server logs, and the WS ticket already works with a bearer.
- **Let the webview load the token, as it loads the password today.** Rejected for the new secrets: the issue asks for auth state inside the trusted transport boundary. The password keeps its current path so this change doesn't touch it.
- **Use a custom URL scheme (`hermes-chat://callback`) instead of a loopback listener.** Rejected: Hermes accepts only `http://127.0.0.1` or `[::1]` redirects, and on Linux any app can register a scheme, so it could intercept the code.
- **Offer Browser sign-in for URL connections only.** Rejected by the owner, who wants the option offered everywhere. Over SSH it usually fails, and the note and the end-of-flow message say why.

## Consequences

- The sign-in screen and Setup gain a method picker, shown only when a server offers more than one method. With only Password, they look as they do now.
- Two new keyring entries per connection, `dashboard-token/<id>` and `dashboard-refresh/<id>`. Backups never hold them (ADR 0038).
- `docs/compatibility.md` and the README say which method needs which Hermes build, where each secret is kept, and what can't be checked live.
