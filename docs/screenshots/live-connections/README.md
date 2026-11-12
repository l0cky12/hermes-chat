# Several live connections: verification record (issue #99, ADR 0125)

Taken on 2026-11-12 from the real desktop binary (WebKitGTK under Xvfb, driven through WebDriver by the
`verify-hermes-chat` skill), signed in to two stand-in dashboards on loopback. Both stand-ins are the repo's
`FakeHermes` behind HTTP and WebSocket, with the same profile (`default`) and the same chat ids (`backup` and the
others), so nothing could be told apart by those alone. They are named "Work server" and "Home server" here. The data
is synthetic.

| Shot | What it shows |
| --- | --- |
| `02-home-target-work-live.png` | Home server was added through Setup and is the composer target. The chat header names the server and profile. Work server stayed live: nothing closed it. |
| `03-work-approval-in-background.png` | Work's stand-in asked for an Approval in its `backup` chat while Work was in the background. The rail's server button counts 1 waiting. Home's own `backup` chat shows no card. |
| `04-inbox-names-server.png` | The Inbox (opened by the tray's event) lists Work's Approval as "default · Work server". |
| `05-overview.png` | Settings → General → Connections: each live connection's status, route, last activity and counts, with Use, Disconnect and the Live at once limit. |
| `06-work-target-card.png` | Opening the entry made Work the target without a new sign-in (the stand-in's log shows no new `password-login`). The card is there, and Work's draft is kept. |
| `10-after-relaunch.png` | After quitting and relaunching, Work opened as the target and Home opened again in the background with its saved password ("1 more live" on the rail button). |

Also driven, without a shot kept here: Approve once reached Work's stand-in only (`answers` in its `/__state` holds
`srq-000000000001` with `choice: once`; Home's holds none). Disconnect on Home closed it alone and Work stayed the
target; Connect opened it again in the background with its saved password.

Not driven in the real app: the at-limit refusal (it needs a third server; `src/ui/liveConnections.test.tsx` and the
Rust test `a_connect_past_the_owners_limit_is_refused_and_closes_nothing` cover it), removal of a live connection
(covered by the same Vitest file), SSH routes, and a real Hermes 0.21.6 or later with the official app attached to the
same chat, which is what proves fan-out and first-answer-wins.
