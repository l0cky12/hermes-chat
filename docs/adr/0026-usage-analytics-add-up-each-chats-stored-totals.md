# Usage analytics add up each chat's stored totals; Hermes's own sums only cross-check them

Usage analytics shows where tokens and recorded cost add up across chats, models, sources, projects, profiles and days. Its figures are the same stored session totals a chat's own usage shows (ADR 0008), read for every chat started in the period and added up in the app. Nothing is priced here: each cost is what Hermes recorded, under its own status, and every total says how much of the usage it covers.

## How it reads Hermes

- **Chats.** `GET /api/sessions?profile=&order=created&archived=include&limit=100&offset=` for each profile picked, newest started first, every source (scheduled jobs' runs and imported chats too) and archived chats included. Reading stops at the first page holding a chat that started before the period, at the end of the list, or after 50 pages (5,000 chats), when the screen says the oldest weren't counted. Every page also carries all pinned chats out of order (research doc §5); chats are kept once by id, and only those that started in the period count. A profile that fails is named and left out; the others still count.
- **Compressed chats.** At the deployed `bf0203a`, a chat Hermes compressed onto a fresh session is listed once, under its last segment's id and model, with its **first** segment's counts and `_lineage_ids` naming every segment (`_project_compression_tips`; checked on the live server: root `input_tokens` 664,536, the later segment's own 464,314). Each segment stores only its own calls, so the others are read by id (`GET /api/sessions/{id}?profile=`) and added once each, four at a time, at most 300 per refresh. A segment that can't be read leaves the chat marked short ("+").
- **Hermes's own sums.** `GET /api/analytics/usage?days=&profile=` only for a rolling period (the last N × 24 hours), which is the cutoff it uses (`started_at > now − days·86400`). It sums every stored session started then, including subagent runs, which no chat list shows (they carry `_delegate_from`, and `GET /api/sessions` hides them unless the server's `sessions.show_subagents` is on, with no request parameter), and each compression segment by its own start. The screen shows both side by side and says what the difference is. Its `by_task` gives Hermes's helper tasks (titling, compression, background review, approvals), which are in no chat's totals; they are shown apart. A Hermes without the route (404) says so; the chats still count.

## What a total means

- **Period.** A chat counts in the period it started in, with its whole usage so far, as Hermes's own sums count it. Rolling periods match Hermes's cutoff; a custom period runs from midnight of the first day to the end of the last, on the chosen time zone's clock (DST-aware), and so has no Hermes sums to compare. The Day breakdown uses the same zone.
- **Tokens.** Input (not cached), cache read and cache written don't overlap, and together are everything sent; output includes reasoning, so the total is input + cache read + cache written + output. A count Hermes didn't send for some chat is shown with "+" and how many chats lack it.
- **Model.** The model a chat used last (`sessions.model`). Hermes keeps per-call model usage only in `session_model_usage`, which dashboard REST exposes per model but not per chat, so a chat that changed model counts all its usage under its last one. The screen says so.
- **Cost.** Each segment's cost is classified as ADR 0008 does: reported by the provider, estimated by Hermes, at least (latest call unpriced, so a lower bound), included in a subscription, or unknown. A segment without model calls has nothing to price and counts under none. The total is the sum of recorded dollars, prefixed `~` when any of it is Hermes's estimate and suffixed `+` when some usage has no price or only part of one, with the share of tokens whose cost is recorded in full. It is labelled "not a bill". Hermes keeps one status per session, so an earlier unpriced call in a chat whose latest call was priced leaves no mark; the screen says that too.
- **Projects.** Membership is this computer's (ADR 0105), read as it is now, so a change shows at once without reading Hermes again. A chat in two projects counts in both rows, so project rows can add up to more than the total. Projects belong to the shown profile; other profiles' chats are left out while a project is picked. Grouping, the filter and the CSV use one membership: projects Hermes has, archived ones labelled "(archived)"; a chat kept here only in a project Hermes no longer has is in no project.

## Freshness and concurrency

Each change of period, time zone (for a custom period) or profiles starts a new read and aborts the one before: it asks Hermes nothing more after its current request, and its answer is dropped. Project and model filters, sorting and grouping work on what was read. The screen says when it read Hermes and offers Refresh. It is keyed to the profile shown, and the app's main view to the connection, so a late answer from another connection or profile has nowhere to land.

## Storage

Nothing is kept on this computer. Export CSV writes the chats counted (with the filters picked) only where the owner saves it, through the native Save dialog: one row per chat with its profile, title, source, start time in UTC and in the chosen zone, model, projects, each count, the recorded cost with its kind and label, where the figures came from (`Hermes stored session totals`, and how many compression segments were added), and how complete they are. Text a spreadsheet would run as a formula is prefixed with `'`.

## Considered options

- **Hermes's analytics routes as the source.** `/api/analytics/usage` and `/api/analytics/models` take only `days` back from now and the profile, bucket days in the server's own time zone, have no cache-write totals and no cost status, and list no chats. They can't filter by project, model or a custom range, or drill into chats, and their per-model sums wouldn't add up to the chat rows shown beside them. Rejected as the source; kept as a cross-check and for helper tasks, which only they expose.
- **A price table to fill unknown costs.** Rejected, as in ADR 0008.
- **Adding up per-reply usage this app measured.** Rejected, as in ADR 0008: it misses other clients' turns.
- **Keeping a local history of reads.** Not done: Hermes already keeps the totals, and a copy here would go stale and hold chat titles on disk.

## Consequences

- Subagent runs' usage shows only in Hermes's own sums, and only for rolling periods. On the live server on 2026-11-03, the 7-day default profile held 336 chats and 60 subagent runs: Hermes's input total was 42,261,194, the chats' 36,403,825, the difference exactly the 60 runs' 5,857,369.
- A chat's own usage beside its title reads `GET /api/sessions/{id}` with the last segment's id, which for a compressed chat is only that segment's usage; its list row carries the first segment's. Analytics adds every segment, so for a compressed chat it can show more than the chat's own usage does. That limitation of the chat's own usage predates this screen.
- A period reaching back more than 5,000 chats in a profile is counted in part, and says so.
- Older Hermes versions that send no token counts with the list show a "doesn't send token counts" state; each chat's own usage still works as before.
