# Hermes server compatibility

Hermes Chat works with more than one version of Hermes, but not every version has every feature. This guide lists what each feature needs from the Hermes server, how the app checks for it, and what the app does when the server doesn't have it. The decision record is [ADR 0044](adr/0044-capabilities-are-what-hermes-says-or-answers-checked-only-by-reading.md).

To see what your server has, open **Settings → Diagnostics**, or **Settings → General → Connection diagnostics**. It shows the server's version, protocol, sign-in and feature flags, and the state of each feature below.

## How the app checks

The app learns what a server supports in three ways, in this order:

1. **What Hermes says about itself.** `GET /api/health` gives the version and commit. `GET /api/status` gives the release date and the sign-in providers. The `gateway.ready` frame gives the protocol. `client.capabilities` lists the requests Hermes may send, such as Approvals, and `gateway.capabilities` lists feature flags.
2. **What the app's own requests show.** When a screen reads a route and Hermes answers, that feature is supported. When Hermes answers that it has no such route or method, it is not supported.
3. **A check.** For anything still not known about 2 seconds after the connection opens, the app sends one request that only reads. It never changes anything on the server to find out. Each check has an 8-second time limit.

A version number alone doesn't prove that a route exists, so each feature is checked on its own. A Hermes installed from a git checkout may report its version as `unknown`; diagnostics then shows its build and commit.

### What each state means

| State | Meaning |
| --- | --- |
| Supported | Hermes answered the route or method. |
| Not supported | Hermes has no such route (it answered `404 Not Found`, `404 No such API endpoint`, or `405`) or no such method (JSON-RPC `-32601`). The screen shows a note instead of opening, and the app sends no change for it. Updating Hermes on the server adds it. |
| Unknown | Hermes answered, but the answer doesn't settle it: a refusal, an expired sign-in, or an answer in a shape this app doesn't read. The screen opens and finds out for itself. |
| Couldn't check | No answer came: a timeout, a dropped connection, or a server error. This may pass. The screen opens and tries for itself. |

### When the app checks again

- **On each reconnect.** The app reads the version again. If the build is the same, was checked in the last 15 minutes, and every feature was settled, it keeps the results. Otherwise, it checks again.
- **When the version changes.** If Hermes reports another build, the results for the old build are dropped and everything is checked again.
- **When you press Check again** in Settings → Diagnostics.

Switching profile opens a new connection, so it counts as a reconnect. An answer that arrives after the connection it was sent on has closed is ignored, so a slow answer from the profile you left can't change what is shown.

A note that says a feature is missing stays until one of those checks, or until the screen's own read finds the route. If you update Hermes while the app stays connected, press Check again.

### What is stored, and what is copied

Results are kept in memory for the current sign-in only. They are never written to disk, and signing out discards them. From Hermes's answers, the app keeps only the version, build, commit, release date, protocol, feature flag names, and the names of the sign-in providers and flows. It doesn't keep the paths, process ids, or install id that `/api/status` includes.

**Copy report** puts a plain-text report on the clipboard. It holds no password, cookie, WebSocket ticket, or header value. The window never has the values of your extra request headers, and the report also removes anything that looks like a secret from the reasons Hermes gives, with the same rules as the Logs screen. Redaction can miss a secret written in an unusual shape, so read the report before you share it.

## Chats and the session protocol

The app needs the dashboard's **legacy** session protocol on `/api/ws`. If `gateway.ready` reports `session_authority` (the canonical protocol), the app doesn't connect, and the sign-in screen says that it doesn't support that protocol yet. The app keeps refusing the canonical protocol until a tested adapter exists.

The app signs in only with the dashboard's username and password (the `basic` provider). Token, OAuth, and OIDC sign-in aren't supported.

## Approvals

Needs Hermes to list `approval` in its answer to `client.capabilities`. A Hermes without `client.capabilities` (0.16.0 and older) asks for approvals in an older way that this app doesn't read, so Approval cards don't show and Hermes decides by the profile's own settings, or waits.

## Projects

Needs the `projects.*` methods on `/api/ws`. Checked with `projects.list`. Without them, the chat list works, and the project menu says that Hermes doesn't support projects and offers no New project.

## Slash commands

Needs `commands.catalog`, `command.dispatch`, and `slash.exec` on `/api/ws`. Checked with `commands.catalog`. Without them, `/steer` and `/context` say that Hermes needs an update. The app's own commands still work.

Running skills from the composer also needs `commands.catalog` to list skills (its `skills` field), and Settings → Skills' `GET /api/skills` and `GET /api/config`. Without any of them, the menus show no skills, "$" opens nothing, and text naming a skill is sent as an ordinary message.

## The inbox

Needs `session.active_list` on `/api/ws` to show work running in other profiles. Without it, the inbox still lists Unread chats and Failed messages in every profile, and says that it can't see running work elsewhere.

## Memory

Needs the `learning.*` methods on `/api/ws` and `GET /api/profiles/active`. Checked with `learning.detail` for an entry that doesn't exist, which only reads. Without them, Settings → Memory shows a note instead of the editor, and reads or writes nothing.

## Toolsets

Needs `GET /api/tools/toolsets`. Without it, Settings → Toolsets shows a note instead of the list.

The switches also need `PUT /api/tools/toolsets/{name}`. Diagnostics doesn't send that check itself. Settings → Toolsets sends it when it opens, as a request Hermes refuses before the route runs (ADR 0021), and diagnostics shows the result. Without the route, Settings → Toolsets shows each toolset's state without switches.

## Persona

Needs `GET` and `PUT /api/profiles/{name}/soul`. Checked with the `GET`. Without them, Settings → Persona shows a note instead of the editor.

## Clone profile

Needs `POST /api/profiles`, which isn't checked ahead: the Clone dialog sends it only when the owner clones. A fresh clone needs its `soul`, `description` and `provider`/`model` fields (Hermes `f0d94882`). An older Hermes that ignores one of them makes the profile without it, and the dialog's read-back shows that category as not copied. Without the route Hermes answers 405, and the dialog says the server can't create profiles. Deleting a clone needs `DELETE /api/profiles/{name}`.

## Provider keys

Settings → Providers and Setup's key step need `GET /api/env`, which lists each provider's key as a row with `provider`, `is_password`, `channel_managed`, `is_set` and a redacted preview. Checked with that `GET`. Without it, both show a note that this server doesn't let Hermes Chat set provider keys, and offer no change; the keys are set on the server instead.

Adding or replacing a key also needs `POST /api/providers/validate` and `PUT /api/env`. Without the check route, Hermes answers an error and the key isn't saved. A check that can't reach the provider still saves the key, and says so.

Removing a key needs `DELETE /api/env` with `{"key"}`, which Hermes `bf0203a` has. It isn't checked ahead. A Hermes without it answers 405, since `/api/env` still exists for the other methods, and the removal fails with that answer and changes nothing. A 404 is how Hermes says the key isn't set, which counts as removed, and the app reads `GET /api/env` again either way: a key still set is reported as one Hermes still lists.

## Skills

Needs `GET /api/skills`, and `PUT /api/skills/toggle` and `/api/skills/content` to change skills. Checked with the `GET`. Without it, Settings → Skills shows a note instead of the list.

## Server files

Needs the dashboard's managed-files routes, `GET /api/files` and `GET /api/files/read`. Checked with `GET /api/files`. Without them, the Server files screen shows a note instead of the browser, and nothing is uploaded or saved.

## Scheduled jobs

Needs the cron routes under `/api/cron/`. Checked with `GET /api/cron/jobs`. To run jobs, the profile's gateway must also be running on the server, which the app can't check. Without the routes, the Scheduled jobs screen shows a note instead of the list.

## Automations

Needs the webhook routes under `/api/webhooks`. Checked with `GET /api/webhooks`. Without them, the Automations screen shows a note instead of the list. A Hermes whose list doesn't name the `webhooks/1` contract keeps fewer fields per route; the Automations screen says which.

## Outputs

Needs `GET /api/fs/list`, and `GET /api/sessions/{id}/messages` with tool rows. Checked with `GET /api/fs/list`. Without `fs/list`, the Outputs screen shows a note instead of the list.

## Sign-in methods

The sign-in screen and Setup read the dashboard's public `GET /api/status` (`auth_required`, `auth_providers`, `auth_flows`) and, when `auth_flows` lists `native_pkce`, `GET /api/auth/providers`, before anything signs in (ADR 0058). Password sign-in needs a provider listed with `supports_password`, or `basic` in `auth_providers` on a Hermes without the providers list; every Hermes checked has `basic`. Token sign-in needs the `session-token` provider, in Hermes from `2edfd0d` (2026-10-28), started with `HERMES_DASHBOARD_SESSION_TOKEN` set; it was checked live at `f0d94882`. The owner's server at `bf0203a` doesn't have it, so the app doesn't offer Token there. A status that can't be read, or that lists no method the app supports, leaves the password, as before. Browser sign-in through OIDC or Nous Portal, which `auth_flows: native_pkce` advertises, isn't built yet.

## Bot Mode

Needs `profiles.list` on `/api/ws` with each profile's Bot Chat in its rows (`canonical_session`, which is `null` for a profile without one), and `session.list` with `title` and `include_hidden` to look a Bot Chat up by its title. Checked with `profiles.list`. Hermes `f0d94882` has both. An older Hermes without `profiles.list`, or one whose rows don't report a Bot Chat, has no Bot Mode: the Bots button doesn't show, and diagnostics says why. To start a Bot Chat, the app also uses `session.create` with `hidden` and `session.title`.

## Subagents

Needs the `subagent.*` events on a chat's session (`spawn_requested`, `start`, `progress`, `tool`, `thinking`, `complete`, with `subagent_id` and `parent_id`), and `subagent.list`, `subagent.tail`, `subagent.steer` and `subagent.interrupt` on `/api/ws`. Hermes `f0d94882` has all of them. These methods need a chat's live session, so diagnostics can't check them by reading. The capability is unknown until a chat opened on the connection lists its subagents. Without `subagent.list`, the Subagents panel still shows what the events say, says that it can't check what happened while the app was disconnected, and has no Steer or Stop. A Hermes whose events carry no `subagent_id` shows its subagents side by side, by their `delegate_task` call, without Steer or Stop.

## Subagents in chats not opened

Needs `subagent.roster` on `/api/ws`, which counts the background subagents and background processes running for each chat of a profile, with no chat open. Hermes `f0d94882` has it, and 0.16.0 doesn't. Checked with `subagent.roster`. The app reads it with `session.active_list`, so a chat not opened since launch stays in Working while its background subagents run (ADR 0096). Without it, only a chat opened on the connection stays in Working while they run. Any other chat goes to the Inbox when its reply ends, as before.

## Versions checked

Checked live on 2026-11-04 with throwaway dashboards holding no real data (`src/hermes/capabilities.live.test.ts`):

- Hermes at upstream `74b2ed6` (it reports 0.21.5): every feature is supported, and it advertises the `per_session_exclusive_submit` flag.
- Hermes 0.16.0 at `3705625`: chats, Toolsets, Persona, Skills, Scheduled jobs, Automations, slash commands, and the inbox are supported. Approvals, Projects, Memory, Server files, and Outputs are not supported, and it has no `/api/health` or feature flags. Sign-in with a username and password works.
- The deployed `bf0203a` was not reachable for this check; earlier features were developed against it.

The automated tests use a fake Hermes that can answer as either of those, or leave out any route or method.

### Limits

- A check proves that a route answers. It doesn't prove that every field the app reads is there. A screen still checks what it reads, and says when an answer has an unexpected shape.
- A route that a gateway or proxy in front of the dashboard blocks can look missing (a `404`) or unreachable (a `5xx`). Check the gateway if a feature your Hermes should have shows as not supported.
- Toolset switches can't be checked by reading, so they stay unknown until Settings → Toolsets opens.
- Memory can be edited only for the profile the dashboard runs as. That limit isn't a missing feature, so diagnostics doesn't show it; Settings → Memory explains it.
- The canonical protocol can't be shown in diagnostics, because the app doesn't connect to it.
