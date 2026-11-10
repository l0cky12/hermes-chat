# A chat's web link is a Hermes dashboard page, behind the dashboard's own sign-in

**Status: proposed. Waiting on the owner to pick the page (see "Decision needed").** Nothing is built yet.

Issue #167 asks for a link that a normal web browser can open to show one chat's messages and replies, read-only to start with. A chat can hold private things, so the page must need a sign-in or a link that can be revoked, and nobody may see it just by guessing the address. The issue asks where the page is served from before anything is built.

A Chat link (ADR 0037) can't do this. `hermes-chat://` only opens the desktop app, and it holds only ids, so a browser has nothing to load.

## What Hermes already serves

Read in the deployed Hermes source (`f0d94882`, `~/.cache/hermes-src-168`) on 2026-11-04. Nothing below was run against a live dashboard with its real web build: the throwaway dashboards on this box serve a stub `index.html`.

- **`/chat?resume=<id>&profile=<p>`** opens one chat in the dashboard's own web app (`web/src/pages/ChatPage.tsx`). The dashboard starts the Hermes terminal UI for that chat in a PTY (`hermes_cli/web_server_chat.py`, `HERMES_TUI_RESUME`), following the chat to its latest continuation. The browser shows it in a terminal, and **the person at the browser can type into it.** The page is there when the dashboard's embedded chat is on, which is the default (`_DASHBOARD_EMBEDDED_CHAT_ENABLED = True`). The Sessions page's own Resume button uses the same address.
- **The Sessions page** (`/sessions`) shows a chat's messages read-only when its row is opened (`GET /api/sessions/{id}/messages`). Which row is open is page state, though. No address opens a given chat there.
- **The sign-in comes back to the address.** Signed out, any dashboard page redirects to `/login?next=<path and query>` (`dashboard_auth/middleware.py`, `_safe_next_target`), and signing in lands on the page that was asked for. That includes a sub-path behind a reverse proxy.
- **Dashboard plugins** (`<plugins>/*/dashboard/manifest.json`, with a script bundle and an optional `plugin_api.py`) can add a page to the dashboard's web app behind the same sign-in.

## Proposal

**The link is the Hermes dashboard's own address for the chat, and the dashboard's sign-in is the lock.** This app runs no web server and starts no new one, keeps no new secret, and adds nothing public to the internet:

- **Copy web link** sits beside Copy chat link (in the chat's menu and the chat header's More menu). It makes `<dashboard address>/<page for the chat>`, using the connection's first route that a browser can open: a Web address route first, then Tailscale, then LAN. Only `https://` and `http://` routes count, and a loopback address (`localhost`, `127.*`, `[::1]`) doesn't, because it only works on this computer.
- **A connection whose routes are all SSH has no web link.** Its dashboard listens on the server's loopback and is reached through the app's own tunnel, so no browser can open it. The menu item is there but turned off, with a note saying why and that a Web address route would give one (`0120-a-connection-has-ordered-routes-tried-in-turn-each-checked-for-the-same-server.md`).
- **Only someone who can sign in to the dashboard sees the page.** That person can already see every chat on that server, so the link exposes nothing new. Guessing an address gets a sign-in page, nothing more. Signing out of the dashboard, or changing its password, takes access away. **Extra request headers** (`0104-extra-request-headers-for-a-gateway-in-front-of-the-dashboard.md`) are the app's own and a browser doesn't send them: a dashboard behind Cloudflare Access asks the browser to sign in to Access itself, as it would for any visit.
- **The link holds the address, the profile and the chat id, and nothing else:** no username, password, header, token or reference from this computer. Unlike a Chat link, the address is visible to whoever sees the link. That is what makes it openable in a browser. The menu item's note says so.
- **Opening a web link is the dashboard's job.** The app doesn't read web links or open them; a `hermes-chat://` Chat link still opens the desktop app.

## Decision needed: which page

The issue asks for a read-only page "to start with". **No page the dashboard serves today opens one chat read-only.** Pick one:

1. **The dashboard's chat page, `/chat?resume=<id>&profile=<p>` (works today, interactive).** This needs no server change and the client can be built now. But it isn't read-only: the browser can send messages, and opening the link starts a Hermes terminal session for the chat on the server. If a reply is already running in the desktop app, the browser can start another one in the same chat, through Hermes's own resume, which is not this app's single-writer checks. A dashboard with embedded chat turned off has no such page, so the link lands on Sessions.
2. **A read-only deep link on the dashboard's Sessions page (recommended; needs Hermes to change).** For example, `/sessions?session=<id>&profile=<p>` opens that row's read-only message list. This is a small change upstream in `NousResearch/hermes-agent`, and it is out of this repository's reach. The client builds Copy web link against it, the PR is labelled `ready-for-human` with the server gap named, and links copied before Hermes has the change open the Sessions list.
3. **A dashboard plugin this app installs on the server (read-only, more to own).** A plugin page renders the chat from `GET /api/sessions/{id}/messages`, behind the dashboard's sign-in. It is read-only and works without waiting on Hermes. But this app has never installed anything into the dashboard: it needs SSH (which a Web-address-only connection may not have), a plugin rescan, a script bundle built against the dashboard's plugin interface, safe Markdown and HTML rendering of the transcript in a page this app doesn't control, and updates when Hermes changes that interface.

Option 2 gives the page the issue describes, on the server that already holds the chat and the sign-in, with the least new code to own. Option 1 is a reasonable stopgap if a working link matters more than read-only.

## How #92 (share snapshots) relates

#92 is a different thing: an **immutable, redacted copy** of chosen messages, **published for other people**, each copy with its own revocable link and expiry, held by a publication backend that doesn't exist yet. A web link is a **live view for the owner**, locked by the dashboard's sign-in, and showing whatever the chat holds now.

- **They overlap only if #167 uses revocable link tokens.** This proposal doesn't. A per-link token that lets a browser in without a sign-in is a publication: it belongs to #92, with #92's redaction preview, management list and backend. Building it here would mean a second, weaker way to publish a chat.
- **What #92 can reuse:** the menu placement, the choice of a browser-openable route, and the rule that a loopback or SSH-only connection has no web address.

## Considered options

- **This app serves the page.** A web server in the desktop app only reaches browsers on this computer, unless it is exposed to the network, which would put a second door to every chat on the owner's computer, with its own sign-in to get right. A browser on this computer has the desktop app already.
- **A small web app of our own on the server.** This means a new process to install, keep running, update and expose, with its own sign-in or tokens, beside a dashboard that already has both.
- **A revocable token in the link, no sign-in.** Anyone who gets the link sees the chat until it is revoked, and revoking needs a server that keeps the tokens. That is #92's publication backend. See above.
- **Put the chat in the link (a `data:` URL, or the transcript in the fragment).** The link would be a copy, not the chat. Pasting it anywhere would leak the whole conversation, and it couldn't be revoked.

## Consequences

- Web links work only for connections with a browser-openable route, and only for people who can sign in to that dashboard.
- Each link names the server's address. It is fine in a note to self, and risky to paste anywhere public.
- Whatever page is picked, the dashboard owns its rendering, sign-in and logging. The desktop app only makes the address.
