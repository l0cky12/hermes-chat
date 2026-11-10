# Project membership sync screenshots

These were captured on 2026-11-03 from the running Hermes Chat debug build (WebKitGTK), built from this branch. They were taken on an Xvfb display at 1280 × 820, which has no window manager, so dialogs have no title bar. Nothing was composited or retouched.

**No real Hermes has a membership store.** The app was signed in by URL to a local stand-in: the repo's `FakeHermes` behind real HTTP and WebSocket on loopback (`bridge.ts` here). Its `projects.membership.*` methods implement the contract that [ADR 0109](../../adr/0109-project-membership-syncs-through-a-proposed-hermes-store.md) proposes. Every chat, project and link is synthetic.

"Computer A" and "computer B" are two runs of the app, each with its own `XDG_DATA_HOME`, so each has its own local storage. They ran one after the other against the same stand-in server. The changes were made in the app, with the mouse, unless noted otherwise.

1. `1-local-only.png`: computer A on a Hermes without the store, which is every Hermes today. A put Nightly backup in Home lab, NAS disk usage in Home lab and Docs, and Caddy in Docs. The project screen says this is kept on this computer.
2. `2-move-offered.png`: the store is switched on in the stand-in (`curl :47821/store/on`), standing in for a Hermes that ships the contract. After Sync now, the project screen offers the move, and the switcher has a dot.
3. `3-move-preview.png`: Review… shows the preview before anything is sent. 3 links are sent. 1 is already on Hermes and left alone (no duplicate). 1, Grafana in Home lab, was seeded on the server as another computer's link and is shown from now on.
4. `4-moved-synced.png`: after Move, Hermes keeps the links and Grafana shows in Home lab. The server then held exactly 5 links, one record each.
5. `5-other-computer.png`: computer B, signed in with empty app data, shows the same chats in Home lab, read from Hermes.
6. `6-pending-offline.png`: the network is dropped (`curl :47821/offline/on`; the app shows Reconnecting, then Offline). B takes Caddy out of Docs. The change shows at once, and the project screen says it waits, and why.
7. `7-chat-menu-waiting.png`: Caddy's chat menu marks Docs as "waiting to sync". B was then stopped with the change still pending. Its stored document held `pending: [{chatId: "caddy", projectId: "p_docs", member: false, base: 3}]`.
8. `8-conflict-in-switcher.png`: the network is back. On computer A, Caddy was taken out of Docs and put back (revisions 4 and 5). When B starts again, its change is a conflict: the switcher has a dot and a line saying so.
9. `9-conflict-dialog.png`: Review… shows both versions. Until the owner picks, Hermes's version (in Docs) is the one shown.
10. `10-kept-mine.png`: after Keep mine, the change is sent again over the conflict's revision. Hermes then no longer had Caddy in Docs, and nothing needs the owner.

To run it again: build the debug binary, pointing it at a free Vite port, with `TAURI_CONFIG='{"build":{"devUrl":"http://localhost:1521"}}' cargo build` in `src-tauri`. Then run `npx vite --port 1521 --strictPort`, and run
`npx rolldown docs/screenshots/project-membership/bridge.ts --platform node -o /tmp/membership-bridge.mjs && node /tmp/membership-bridge.mjs 47820`. Start the app with its own `XDG_*` folders under `dbus-run-session`, so nothing reaches your keyring, and sign in by URL to `http://127.0.0.1:47820` with any username and password. The controls are on port 47821: `/store/on`, `/store/off`, `/offline/on`, `/offline/off`, and `/` for the links the server has.
