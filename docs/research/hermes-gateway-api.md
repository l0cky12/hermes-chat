# Hermes gateway API: research for a custom desktop client

- Date: 2026-10-31
- Upstream: https://github.com/NousResearch/hermes-agent at commit `c419cf7c864ac0ee511dbd9f7091a8bba0b567ee` (committed 2026-10-31). Cloned read-only into `/tmp/hermes-research/hermes-agent`; every `path:line` below is relative to that clone at that SHA. Docs citations are the `website/docs/` sources in the same clone (published at https://hermes-agent.nousresearch.com/docs/).
- Starting point: the prior research in GitHub repo `l0cky12/hermes-client` at `docs/research/hermes-gateway-api.md` (pinned to upstream `c714c42`, 2026-10-26), plus that repo's `docs/design/gateway-client.md`, `docs/adr/0003-embedded-ssh-client.md` and its `src/main/gateway/*` / `src/main/ssh/tunnel.ts`. Treated as a prior to verify. Note: that GitHub repo is an Electron + `ssh2` implementation; this local repo (`hermes-chat`) is Tauri 2 + React + TS, so the prior's code-level choices do not carry over, only its protocol findings.
- Official desktop app: it is not a separate repository; it lives in-tree at `apps/desktop` (Electron) with shared protocol code in `apps/shared/src`. `gh repo list NousResearch` and `gh search repos` were not needed once that was found in the clone.
- Status key: CONFIRMED = read in upstream source/docs at this SHA; STALE = prior-research claim that no longer matches; UNCONFIRMED = not found in a primary source, must be checked on the live server.

## Summary for the client

| # | Question | One-line answer | Status |
|---|----------|-----------------|--------|
| 1 | Exposed protocol | Two surfaces. (a) OpenAI-compatible HTTP+SSE "API server" inside `hermes gateway` (`API_SERVER_ENABLED=true`, default `127.0.0.1:8642`, `/v1/*` + `/api/sessions/*` + `/v1/runs/*`). (b) The dashboard/desktop surface: REST `/api/*` + JSON-RPC 2.0 over WebSocket `/api/ws`, served by `hermes serve`/`hermes dashboard` (default `127.0.0.1:9119`) and also by the `hermes gateway` process's own listener (ephemeral loopback port; Webapp listener default 9120). | CONFIRMED |
| 2 | Auth / TLS | (a) API server: `Authorization: Bearer $API_SERVER_KEY`, key mandatory even on loopback. (b) Dashboard: loopback bind is "ungated" and accepts the process session token (`?token=` on WS, Bearer on REST); any non-loopback bind engages an auth gate that needs a provider (username/password, Nous OAuth, self-hosted OIDC, or the static `HERMES_DASHBOARD_SESSION_TOKEN` provider) and WS then needs a single-use ticket from `POST /api/auth/ws-ticket`. No TLS in either server; docs say use a TLS reverse proxy, Tailscale, or an SSH tunnel. | CONFIRMED |
| 3 | Streaming | Yes, token by token. (a) `/v1/chat/completions` `stream:true` = SSE `data: {chat.completion.chunk}` plus named events `hermes.tool.progress`, `hermes.status`, `approval.request`, ending `data: [DONE]`; `/v1/runs/{id}/events` = SSE with `id:` seq and `{"event":"message.delta","delta":...}`; `/api/sessions/{id}/chat/stream` = SSE `assistant.delta`. (b) WS: notifications `{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":...,"payload":{"text":...}}}`. | CONFIRMED |
| 4 | Tool calls in stream | Yes on every surface. SSE: `hermes.tool.progress {tool,emoji,label,toolCallId,status}` (chat completions), `tool.started`/`tool.completed {tool,preview,duration,error,tool_call_id}` (runs, session stream). WS: `tool.start {tool_id,name,args,preview}` / `tool.complete {tool_id,name,duration_s,result,summary,...}`. | CONFIRMED |
| 5 | Sessions | All platforms share one SQLite file per profile, `$HERMES_HOME/state.db` (`~/.hermes/state.db`, profiles under `~/.hermes/profiles/<name>/state.db`); `sessions.source` tags the platform (`cli`, `telegram`, `discord`, `api_server`, ...). Listing with last-activity, pagination and source filters exists on API-server REST (`last_active`, `limit<=200`), dashboard REST (`order=recent`, `limit<=100`, `sources=`), and WS `session.list` (no last-active field). Full history: REST `/api/sessions/{id}/messages` (page<=500) or WS `session.resume`/`session.history`. Continuing a session owned by another surface is refused on the OpenAI routes (409 `permission_denied`); the WS `prompt.submit` path is the documented way, verified for CLI/TUI/Desktop sessions; messaging-platform sessions are not documented as attachable, but the source allows it, and on the canonical path the reply is also posted to the Telegram/Discord chat. | CONFIRMED (messaging continue: source-read, not live-tested) |
| 6 | Approvals | (a) API: SSE `event: approval.request {request_id, command, description, choices,...}` then `POST /v1/runs/{run_id}/approval {"choice":"once|session|always|deny","request_id":...}` (canonical owner also needs `execution_generation`). (b) WS legacy: server-to-client JSON-RPC request `method:"approval"` with id `srq-*`, client replies with a JSON-RPC result `{"choice":...}` and must have advertised `client.capabilities {server_requests:true}`. (c) WS canonical: `approval.request` event with `prompt_id` + `execution_generation`, answered by `approval.respond`. | CONFIRMED |
| 7 | Attachments | API server: inline images only (`image_url` http(s) or `data:image/...;base64` parts); files return 400 `unsupported_content_type`. WS: `image.attach_bytes {content_base64}` (25 MiB cap), `pdf.attach` (50 MiB / 25 pages), `file.attach {path | data_url, name}`, canonical `prompt.submit.attachments:[{path,mime}]`; dashboard REST multipart `POST /api/chat/file-upload`. | CONFIRMED |
| 8 | Cancel | API: `POST /v1/runs/{run_id}/stop` -> `{"status":"stopping"}`; closing an SSE stream also interrupts the agent. WS: `session.interrupt {session_id}` (canonical adds `execution_generation`). | CONFIRMED |
| 9 | Official desktop | Gateway mode: Remote URL (`http://host:9119`) + either static session token (REST header, WS `?token=`) or OAuth (cookies + `?ticket=`). SSH mode: spawns the system `ssh` binary (OpenSSH ControlMaster, not a JS library), runs `hermes serve --isolated --host 127.0.0.1 --port 0 --ssh-session-token-file ... --ssh-owner-nonce ...` on the remote, scrapes `HERMES_DASHBOARD_READY port=N`, then `ssh -N -L <local>:127.0.0.1:<N>` and talks HTTP/WS to `http://127.0.0.1:<local>`. It does not run the hermes CLI as the chat transport. | CONFIRMED |

## 1) What the gateway exposes to a custom client

### Two distinct surfaces

Hermes has two client-facing servers, and the word "gateway" is used for the process that hosts both. The prior research's "do not infer the deployed surface from the word gateway" warning is CONFIRMED.

**(a) API server platform adapter** (OpenAI-compatible, aiohttp). Lives inside the `hermes gateway` process as a messaging-platform adapter.

- Enable: `API_SERVER_ENABLED=true` and `API_SERVER_KEY=...` in `~/.hermes/.env`, then `hermes gateway` (`website/docs/user-guide/features/api-server.md:19-40`). Config-file equivalent: `gateway.api_server: {enabled, port, host, key, cors_origins, model_name}` (`api-server.md:837-854`).
- Default bind: `DEFAULT_HOST = "127.0.0.1"`, `DEFAULT_PORT = 8642`, overridable by `API_SERVER_HOST` / `API_SERVER_PORT` (`gateway/platforms/api_server.py:155-169`; `api-server.md:828-835`).
- Routes (`gateway/platforms/api_server.py:1558-1588`; runs routes `gateway/platforms/api_server_runs.py:286-292`):
  - `GET /health`, `GET /v1/health`, `GET /health/detailed` (bearer), `GET /v1/models`, `GET /api/model/options`, `GET /v1/capabilities`, `GET /v1/skills`, `GET /v1/toolsets`
  - `POST /v1/chat/completions`, `POST /v1/responses`, `GET|DELETE /v1/responses/{id}`
  - `POST /v1/runs`, `GET /v1/runs/{run_id}`, `GET /v1/runs/{run_id}/events` (SSE), `POST /v1/runs/{run_id}/approval`, `.../clarify`, `.../steer`, `.../resolve-unknown`, `.../stop`
  - `GET|POST /api/sessions`, `GET|PATCH|DELETE /api/sessions/{id}`, `GET /api/sessions/{id}/messages`, `POST /api/sessions/{id}/fork`, `POST /api/sessions/{id}/chat`, `POST /api/sessions/{id}/chat/stream` (SSE), `POST /api/sessions/{id}/model`
  - `/api/jobs*` (cron CRUD), `POST /api/platforms/{platform}/events`
  - Every route is also mounted under `/p/{profile}` for multi-profile gateways (`api_server.py:3975-3979`; `api-server.md:795-811`).
- `GET /v1/capabilities` returns `{"object":"hermes.api_server.capabilities","auth":{"type":"bearer","required":true},"features":{chat_completions,responses_api,run_submission,run_status,run_events_sse,run_stop,reasoning_streaming,...}}` and `endpoints.*`; use it for feature detection (`api-server.md:357-379`; `api_server.py:2365`).
- OpenAI compatibility: `/v1/chat/completions` and `/v1/responses` are documented as standard OpenAI formats (`api-server.md:9, 163-165, 229-231`). Caveat: a bare `model` without `provider` is ignored unless `gateway.platforms.api_server.direct_model_requests: true` (`api-server.md:423-438`).

**(b) Dashboard / desktop surface** (FastAPI + uvicorn). REST under `/api/*` plus a JSON-RPC 2.0 WebSocket at `/api/ws`.

- `/api/ws` is mounted in `hermes_cli/web_routers/chat_ws.py:650`; the WS transport reuses the same JSON-RPC dispatcher as the stdio TUI gateway, newline-delimited JSON-RPC both ways, `gateway.ready` is the first frame (`tui_gateway/ws.py:1-4`, `ws.py:643-649`).
- Served by three commands/processes:
  - `hermes serve`: headless backend, "the JSON-RPC/WebSocket gateway the desktop app and remote clients connect to", same server as `hermes dashboard` without the browser UI; default port 9119; `--port 0` binds an ephemeral port and prints `HERMES_BACKEND_READY port=<port>` (`website/docs/reference/cli-commands.md:1876-1884`; `hermes_cli/web_server.py:1395` `port: int = 9119`; `hermes_cli/main_dashboard.py:57-58` defaults `port = 9119`, `host = "127.0.0.1"`).
  - `hermes dashboard`: same server plus web UI (`cli-commands.md:1892`).
  - `hermes gateway` (the messaging gateway) also runs its own listener that serves the native ticketed `/api/ws` and lazily mounts the dashboard app (`gateway/run_api.py:1-13`); `start_gateway_api(runner, host="127.0.0.1", port=0, ...)` so its private port is ephemeral by default (`gateway/run_api.py:213`). The optional Webapp listener defaults to `127.0.0.1:9120` (`gateway/webapp_listener.py:30-31`; `website/docs/user-guide/desktop.md:47`). Prior research's "9120 is the Webapp default, 9119 is `hermes serve`" is CONFIRMED.
- Documented remote recipe for a custom/desktop client: run `hermes serve --host 0.0.0.0 --port 9119` (or bind the Tailscale IP) under systemd and keep the messaging `hermes gateway` as a separate process (`website/docs/user-guide/desktop.md:644-651`; `website/docs/user-guide/features/web-dashboard.md:173-209`).
- The WS `gateway.ready` payload is `{skin, change_events, replay_epoch, heartbeat, session_authority?}`; `session_authority: true` means session verbs speak the canonical wire (`tui_gateway/contracts/events.py:51-64`; `ws.py:645-648`). Prior research's two-generation (legacy vs canonical) warning is CONFIRMED.
- Keepalive: client sends `{"jsonrpc":"2.0","method":"gateway.ping","id":n}`, server answers `{"result":{"ok":true}}` (`tui_gateway/ws.py:695-699`); the shared TS client has a 45 s heartbeat deadline (`ws.py:90`).
- The machine-readable RPC contract is published at `apps/shared/src/gateway-contract.openrpc.json` with TS types in `apps/shared/src/gateway-contract.generated.ts`; the Python pydantic sources are `tui_gateway/contracts/*.py`.

### Which surface for this client

The API server is the simpler, documented-for-third-parties route, but it refuses to continue sessions owned by other surfaces (see section 5). The dashboard WS is what the official desktop uses and is the only path that can attach to CLI/TUI/Desktop sessions, at the cost of the JSON-RPC protocol and the auth gate.

## 2) Auth

### API server

- Bearer token: `Authorization: Bearer <API_SERVER_KEY>` (`gateway/platforms/api_server.py:1428-1429`; `api-server.md:785-793`). The adapter refuses to start without a key and runs a strength check (`api_server.py:3908-3932`); docs: "required for every deployment, including the default loopback bind" (`api-server.md:821`).
- Under `gateway.multiplex_profiles`, `/p/<profile>/...` must carry that profile's own `API_SERVER_KEY` (`api-server.md:795-818`).
- CORS is off unless `API_SERVER_CORS_ORIGINS` is set; allowed request headers include `Authorization, Content-Type, Idempotency-Key, X-Hermes-Session-Id` (`api_server.py:634`; `api-server.md:870-886`). A Tauri webview making fetches from a custom origin may need this; a Rust-side HTTP client does not.
- TLS: no `ssl`/certfile handling in `gateway/platforms/api_server.py` or `gateway/platforms/tcp_site.py` (grep at this SHA found none); the only `https` references are URL validation. Docs give no TLS option. Treat it as plain HTTP behind your own tunnel/proxy.

### Dashboard / `hermes serve` / gateway listener

- **Ungated loopback mode**: a loopback bind without a public URL has no auth gate. REST accepts the process session token as `Authorization: Bearer <token>` (`hermes_cli/web_server.py:297-308`), WS accepts `?token=<token>` or, on the Webapp, a one-use ticket (`hermes_cli/web_server_chat.py:352-363`). The token is minted per process (`web_server.py:222-224`) or provisioned via `HERMES_DASHBOARD_SESSION_TOKEN`. The official desktop reads the served token by scraping `window.__HERMES_SESSION_TOKEN__` from the dashboard HTML (`apps/desktop/electron/dashboard-token.ts:1-40`) and, in "token" mode, sends REST requests with an `X-Hermes-Session-Token` header and WS with `?token=` (`apps/desktop/electron/connection-config.ts:12-15, 96, 257`). Whether the live server accepts `X-Hermes-Session-Token` in addition to `Authorization: Bearer` is UNCONFIRMED from the Python source read here (only the Bearer compare at `web_server.py:308` was read).
- **Gated mode**: engaged by a non-loopback bind OR a non-loopback `dashboard.public_url` / `webapp.public_url` (`web_server.py:370`, `857-918`); a gated bind with no registered provider fails closed at startup (`web_server.py:944-994`; `web-dashboard.md:179`). Providers:
  - username/password: `HERMES_DASHBOARD_BASIC_AUTH_USERNAME`, `..._PASSWORD` (or `..._PASSWORD_HASH`), `..._SECRET` (`web-dashboard.md:203-210`), login via `POST /auth/password-login` (`hermes_cli/dashboard_auth/routes.py:10`).
  - Nous Portal OAuth (`hermes dashboard register`) and self-hosted OIDC (`web-dashboard.md:698-706, 903-941`).
  - Deployment session-token provider: when `HERMES_DASHBOARD_SESSION_TOKEN` is set, "one provisioned token authorizes both" the REST `Authorization: Bearer` path and the `/api/ws` `?token=` upgrade; `/api/status` then shows `auth_required: true, auth_providers: ["session-token"]` (`web-dashboard.md:865-889`). This is the simplest static-token option for a LAN/Tailscale deployment and is what the official desktop's "Session token" field expects (`website/docs/user-guide/multi-connection-desktop.md:124-127`).
  - Native (desktop) PKCE flow: `GET /auth/native/authorize`, `POST /auth/native/token`, `POST /auth/native/refresh`, `GET /api/auth/providers` (`hermes_cli/dashboard_auth/routes.py:8-14, 212, 305`). Prior research's description of these routes is CONFIRMED to still exist.
- **Gated WS admission**: a single-use ticket minted by authenticated `POST /api/auth/ws-ticket` (`routes.py:17, 573`), presented as `?ticket=` or as the `hermes-gateway-ticket.<ticket>` subprotocol alongside `hermes-gateway-v1`; the server selects only `hermes-gateway-v1` on accept (`web_server_chat.py:378-420`; `hermes_cli/web_server_boundary.py:156-157`). Prior research CONFIRMED.
- **Host/peer checks**: a loopback bind rejects non-loopback peers at the socket layer, and the Host header must match the bound host (DNS-rebinding guard) (`web_server.py:382`; `web-dashboard.md:180`). Through an SSH tunnel to `127.0.0.1` both pass.
- **Gateway-process native `/api/ws`**: the `hermes gateway` listener admits a WS on `/api/ws` only from a loopback peer, with no `Origin` header, carrying a control-socket `session-ticket` redeemed for `purpose='interactive'`; otherwise it falls through to the dashboard app's own auth (`gateway/run_api.py:436-460`). The control socket (`$HERMES_HOME/gateway.sock`, `identify` and `session-ticket` verbs) is CONFIRMED present (`gateway/control_socket.py:4, 31-32, 224, 339`).
- **Discovery**: `GET /api/status` is public and reports version, gateway state and the auth-gate shape (`hermes_cli/web_routers/status.py:533-590`); the official desktop's readiness probe uses it and the docs warn that it answers before `/api/ws` auth is proven (`web-dashboard.md:177`).
- TLS: none in `hermes_cli/web_server.py` (grep found only an `allow_origin_regex` mentioning https). `--insecure` exists as a flag (`main_dashboard.py:660, 1008`) but its exact effect was not read; UNCONFIRMED. Docs: put a TLS reverse proxy (Caddy/nginx/Tailscale Serve) in front of `http://127.0.0.1:9119` and set `dashboard.public_url` to the external HTTPS origin; proxy headers `X-Forwarded-*` are honoured under the gate (`web-dashboard.md:1024-1079`); "HTTPS is strongly recommended remotely", "prefer an SSH tunnel, Tailscale or another trusted VPN" (`desktop.md:82, 91-96`).

## 3) Streaming

### (a) `POST /v1/chat/completions` with `"stream": true`

SSE. Every frame is built by `_sse_frame`: optional `id: <n>\n`, optional `event: <name>\n`, then `data: <json>\n\n` (`gateway/platforms/api_server.py:196-202`). Writer: `gateway/platforms/api_server_openai_routes.py:1155-1247`.

Sequence:

1. `data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}` (line 1171)
2. Text: same envelope with `"delta":{"content":"<token>"}` (line 1193)
3. Reasoning: `"delta":{"reasoning_content":"..."}` (line 1183; `api-server.md:223`)
4. Named events interleaved: `event: hermes.tool.progress` (line 1179), `event: hermes.status` (line 1185), `event: approval.request` (line 1187)
5. Final chunk: `"delta":{}`, `finish_reason` in `stop|length|cancelled|error`, plus `"usage":{...}` and, when not `stop`, `"error":{"message","type"}` and `"hermes":{...}` (lines 1200-1235; `api-server.md:67-75`)
6. `data: [DONE]` (line 1236)

`: keepalive` comment every 10 s on all SSE streams (`api-server.md:216`). Strict-OpenAI opt-out for named events: `gateway.platforms.api_server.tool_progress_events: false` (`api-server.md:219`).

### (b) `GET /v1/runs/{run_id}/events`

SSE. Each event: `id: <seq>\ndata: {"event":"<name>","run_id":"...","timestamp":<unix>,...,"seq":<n>}\n\n` (`api_server_runs.py:224-226, 1289-1292`). Opens with `: open\n\n`; resumable via `Last-Event-ID` header or `?last_seq=`; emits `replay.truncated {oldest_retained_seq}` if the backlog (1000 events) no longer covers the gap; `: keepalive` on idle; `: stream closed` at the end (`api_server_runs.py:1274-1341`). Event names: `message.delta {delta}` (line 1072), `message.interim {text, already_streamed}` (`api-server.md:541-546`), `tool.started`, `tool.completed`, `reasoning.available {text}` (lines 141-145), `approval.request`, `approval.responded`, `run.queued`, `run.stopping`, `run.steered`, `run.completed|failed|cancelled|interrupted` (lines 1030-1032, 1085-1095, 1478, 1515), `subagent.start`/`subagent.complete` (`api-server.md:557-569`). The final answer text is only in `run.completed` (`api-server.md:545`).

### (c) `POST /api/sessions/{id}/chat/stream`

SSE wrapper over one turn. Event names `assistant.delta {message_id, delta}`, `assistant.commentary`, `tool.started|completed|failed`, `assistant.completed`, then `run.completed|failed|cancelled`; every payload is stamped `session_id`, `run_id`, `seq`, `ts` (`api_server.py:956-981, 3117-3179`; `api-server.md:729`).

### (d) WebSocket `/api/ws`

Notifications are JSON-RPC notifications: `{"jsonrpc":"2.0","method":"event","params":{"type":"<event>","session_id":"<sid>","payload":{...}}}` (`tui_gateway/server.py:589-590`). Message events (`tui_gateway/contracts/events.py`):

- `message.start` (line 150): turn began; payload may carry `turn_id`.
- `message.delta` (line 178): `{"text": str|null, "rendered"?: str, "turn_id"?: str, "segment"?: int, "offset"?: int}`; `text: null` is a segment boundary (lines 165-175). Prior research CONFIRMED.
- `reasoning.delta`, `reasoning.available`, `thinking.delta` (lines 179-181): `{"text": str}`.
- `message.interim` (line 194): `{"text", "already_streamed", "turn_id"?, "segment"?}`.
- `message.complete` (line 305): `{"text", "usage"?, "status"?, "reasoning"?, "error"?, "partial"?, "failure_reason"?, ...}` (lines 282-302).

Canonical replay: `session.events.since {session_id, last_sequence, last_seen, replay_epoch}` returns `CanonicalReplayEvent {type, session_id, payload, replay_epoch, seq, authority_epoch?, execution_generation?, admission_id?}` (`tui_gateway/contracts/canonical_sessions.py:295-310`).

## 4) Tool calls

### API server SSE

- Chat completions `event: hermes.tool.progress`, data `{"tool":"<name>","emoji":"...","label":"<preview>","toolCallId":"<id>","status":"running"}` then `{"tool":"<name>","toolCallId":"<id>","status":"completed"}`; tools whose name starts with `_` are not emitted (`api_server_openai_routes.py:971-987`).
- Runs / session streams: `tool.started` data `{"event":"tool.started","run_id","timestamp","tool":"<name>","preview":"<args preview>","tool_call_id"?:"<id>","seq"}`; `tool.completed` data `{"tool","duration":<s>,"error":<bool>,"tool_call_id"?,"preview":"<result, redacted, <=500 chars>"}` (`api_server_runs.py:140-157`; `api-server.md:548-555`).
- `/v1/responses` streaming: spec-native `response.output_item.added/done` with `function_call` and `function_call_output` items, already executed server-side with `"status":"completed"` (`api-server.md:220, 251-259`).

### WebSocket events (`tui_gateway/contracts/events.py`)

- `tool.generating {"name"}` (line 441): the model is emitting arguments.
- `tool.start` (line 413): `{"tool_id":str,"name":str,"context"?:str,"args"?:{...},"args_text"?:str,"preview"?:str,"labels"?:[...]}` (lines 398-410).
- `tool.progress` (line 469): `{"tool_id","name","progress":float,"total"?,"percent"?,"message"?}` (MCP progress, throttled to 500 ms).
- `tool.complete` (line 432): `{"tool_id","name","args"?,"duration_s"?,"result":any,"summary"?,"result_text"?,"inline_diff"?,"todos"?,"revision"?,"labels"?}` (lines 417-429).
- `tool.output_risk` (line 454): `{"tool_id","name","risk","findings":[...],"redacted":bool}`.

## 5) Sessions

### Storage on disk

- One SQLite file per profile: `DEFAULT_DB_PATH = get_hermes_home() / "state.db"` (`hermes_state.py:181`), i.e. `~/.hermes/state.db` by default, `$HERMES_HOME/state.db` when set (`hermes_constants.py:194-199`), and `~/.hermes/profiles/<name>/state.db` per profile (`website/docs/user-guide/profiles.md:11`). WAL mode with `state.db-wal`/`state.db-shm` sidecars; do not copy or delete them separately; every process (gateway, dashboard, cron, CLI) writes through SQLite locking (`website/docs/user-guide/session-storage-recovery.md:8-11, 53-58`).
- Schema (`hermes_state_common.py:451` onward, `SCHEMA_SQL`): table `sessions` with `id TEXT PRIMARY KEY, source TEXT NOT NULL, created_source, user_id, session_key, chat_id, chat_type, thread_id, display_name, model, model_config, system_prompt_hash, parent_session_id, started_at REAL NOT NULL, ended_at REAL, end_reason, message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cwd, git_branch, git_repo_root, title, title_source, last_activity_at REAL, last_activity_description, profile_name, transport_profile, archived, auto_archived, pinned, hidden, last_read_at, tool_names, transcript_revision, ...`; table `messages` with `id INTEGER PK AUTOINCREMENT, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp REAL, token_count, finish_reason, reasoning, reasoning_content, reasoning_details, platform_message_id, active, compacted, api_content, display_kind, display_metadata, message_uid, ...`; plus `session_model_usage`, `runtime_epoch`, `system_prompts`, FTS5 virtual tables. Session IDs are `YYYYMMDD_HHMMSS_<hex>` (`website/docs/user-guide/sessions.md:261`).
- `source` values: `cli`, `oneshot`, `tui`, `telegram`, `discord`, `slack`, `whatsapp`, `signal`, `matrix`, `api_server`, `cron`, `tool`, `kanban`, ... (`sessions.md:111-141`); `INTERNAL_LISTING_SOURCES = ("kanban", "tool", "oneshot")` are hidden from human listings (`hermes_state_sessions.py:241`; `tui_gateway/methods_session.py:127-134`).
- Docs confirm every platform's conversation lands in this one DB: "Every conversation, whether from the CLI, Telegram, Discord, Slack, ... is stored as a session with full message history" (`sessions.md:15-24`).

### Listing with last activity, pagination, filters

| Surface | Endpoint | Params | Response | Source |
|---|---|---|---|---|
| API server | `GET /api/sessions` | `limit` (default 50, max 200), `offset`, `source`, `include_children`, `title` (+`include_hidden` only with title); always ordered by last activity | `{"object":"list","data":[{id, source, user_id, model, title, started_at, ended_at, end_reason, message_count, tool_call_count, ...tokens, parent_session_id, last_active, preview, _lineage_root_id, pinned, archived, hidden, has_system_prompt, has_model_config, is_internal_child}], "limit", "offset", "has_more"}` | `api_server.py:2521-2573`, `2441-2471`; `api-server.md:721` |
| API server | `GET /api/sessions/{id}/messages` | `limit` (default and max 500), `offset`, `order=oldest\|latest` (default latest page when no limit), `include_compacted`, `inline_images=false` | `{"object":"list","session_id","data":[{id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, reasoning, reasoning_content, display_kind}],"pagination":{limit, offset, order, returned}}` | `api_server.py:2731-2765`, `2476-2482`; `api-server.md:726` |
| Dashboard REST | `GET /api/sessions` | `limit` (default 20, max 100), `offset`, `min_messages`, `archived=exclude\|only\|include`, `order=created\|recent`, `source`, `sources` (csv), `exclude_sources` (csv), `cwd_prefix`, `full`, `profile` | `{"sessions":[rows + is_active, profile, archived, pinned], "total", "limit", "offset", "storage"}` | `hermes_cli/web_routers/sessions.py:182-241` |
| Dashboard REST | `GET /api/sessions/search` | `q`, `limit` (max 100), `profile`, `source`, `sources`, `exclude_sources` | rows with `last_active`, `source`, `snippet` | `sessions.py:286-463` |
| Dashboard REST | `GET /api/sessions/{id}/messages` | `limit` (max 500, default latest page), `offset`, `order`, `profile` | paged messages | `sessions.py:741-781` |
| WS legacy | `session.list {title?, limit (default 200), include_hidden}` | no offset | `{"sessions":[{id, resolved_id?, title, preview, started_at, message_count, live_message_count?, source, _lineage_root_id}]}` most recent first | `tui_gateway/contracts/sessions.py:221-249`; `methods_session.py:110-123, 537-559` |
| WS canonical | `session.list {scope: live\|stored, limit 200, title?, include_hidden}` | | `{"sessions":[{session_id, id, title, source, started_at, message_count, running, model?, resolved_id?, root_title?}],"scope"}` | `canonical_sessions.py` (`CanonicalListParams`, `CanonicalSessionListRow`) |
| WS | `session.resume {session_id, source?, lazy, defer_history, omit_messages, inline_images, cols}` | | `{session_id, stored_session_id, message_count, messages:[TranscriptMessage], info, running, pending_approval?, open_requests?, ...}` (canonical adds `revision, execution_generation, pending, prompts, replay_epoch, last_sequence, subscription_id`) | `sessions.py:73-99, 182-202`; `canonical_sessions.py` (`CanonicalResumeParams`, `CanonicalSnapshot`) |
| WS | `session.history {session_id}` | | `{count, messages}` | `sessions.py:490-500` |

Dashboard `GET /api/sessions` always passes `include_pinned=True`, so **every page** ends with all pinned rows that aren't already on it, out of recency order (`hermes_cli/web_routers/sessions.py:224`; `hermes_state_sessions.py:1420-1446`). A client that pages must de-duplicate by `id`, and only the unpinned rows tell it how far back the ordered list has reached. The pinned back-fill ignores `archived`. `total` counts the ordered rows only. CONFIRMED at `c419cf7`; not checked against the deployed `bf0203a`.

When any process changes a profile's session rows (title, flags, activity, ...), the WS broadcasts a session-less `{"type":"sessions.changed","session_id":""}` event to every connected client (`tui_gateway/change_watcher.py:190-240, 400-425`; `tui_gateway/server.py:632`). CONFIRMED at `c419cf7`; which profile's store the dashboard process watches was not read, so a client should still poll.

Prior research's "REST session list pages cap at 100; message pages cap at 500 and default to the latest page" is CONFIRMED for the dashboard router (`sessions.py:184, 754-756`); note the API-server router caps at 200.

Gap: the WS `session.list` row has `started_at` but no last-activity timestamp (`methods_session.py:113-123`). Use REST (`last_active`, `order=recent`) or canonical `info.last_active_at` on resume (`canonical_sessions.py` `CanonicalSnapshotInfo.last_active_at`) for recency.

### Continuing a session started elsewhere

- API server routes cannot: `session_id` / `X-Hermes-Session-Id` "cannot bind a session that another surface owns: a CLI, TUI, Desktop, ACP or messaging conversation. Such a request is refused with HTTP 409 and error code `permission_denied` ... To work on a chat from another surface, attach through the gateway WebSocket (a `prompt.submit` on the shared session)" (`api-server.md:502-512`).
- WS: "Verified operators of the same gateway profile can attach to canonical local CLI, TUI, or Desktop sessions created through another operator authentication method ... Closing a client connection detaches that client; accepted work remains with the gateway" (`sessions.md:31-36`). `session.resume` takes the stored id or exact title (`sessions.py:182-183`). The desktop docs confirm the gateway is "the same process `hermes chat`, the TUI and messaging channels use" and that chats written before the gateway owned sessions show history but cannot be continued (`desktop.md:581, 117`).
- Messaging-platform sessions (Telegram, Discord): docs describe `/handoff <platform>` from CLI to a platform and `/resume <title>` back to CLI (`sessions.md:264-298`), and the API-server docs list "messaging conversation" among foreign-owned sessions. The docs do not promise WS attach; the source does allow it (next subsection).

### Continuing a messaging-platform session over the WS (source read)

Source-only reading at the same SHA; not yet tested on the live server. Which path applies depends on whether the `hermes serve` process hosts the gateway's session authority: `/api/ws` takes the canonical route when `app.state.session_authority` exists, otherwise legacy (`hermes_cli/web_routers/chat_ws.py:650, 665`). A token-authenticated connection gets submit and control scopes, not operator scope (`chat_ws.py:666-672`).

- **`session.resume` on `source=telegram|discord`: attachable on both paths.** Legacy has no source check; `_resume_guard` only refuses Kanban worker sessions and over-long transcripts (`tui_gateway/methods_session.py:836-860, 1044-1071`); `_denied_source` only applies to listing/auto-resume of `kanban|tool|oneshot` (`methods_session.py:129-133`; `hermes_state_sessions.py:241`). Canonical redirects a messaging session to its compression-lineage root (`gateway/session_controls.py:642-646`) and needs only `session:read` (`:659`); the owner check applies only to `Platform.LOCAL` sources (`gateway/session_authority.py:220-222`). CONFIRMED.
- **Where the reply goes, canonical path: to the platform chat AND the WS client.** `submit` needs `session:submit` with no owner check for non-local sources and stamps the input `local_operator_v1` (`session_authority.py:679, 714-723`). The turn runs as an ordinary turn of the telegram source (`gateway/session_ingress.py:253-256, 302`); the reply is queued for the platform adapter and delivered to the chat (`session_ingress.py:320-331, 389-414`); progress/status notices also go to the chat because `local_viewer_turn` is false for messaging sources (`gateway/run_turn_progress.py:1010-1015`). WS viewers receive it via the session event stream (`session_ingress.py:314-319`). CONFIRMED.
- **Exception, detached sessions:** if the platform chat has since moved to another session (`/new`, `/resume`, `/branch`, `/handoff`), the old session is "detached" and replies reach app viewers only (`gateway/session_detached.py:1-25`). CONFIRMED.
- **Legacy path: WS client only.** The turn runs inside the serve process and nothing in `tui_gateway/` calls a platform adapter (searched `adapter.send`, `deliver_response`, `_adapter_for_source`). A turn is refused while the gateway still has queued work for the session (`tui_gateway/session_lifecycle.py:126, 180-214`); a typed prompt may be forwarded to the gateway owner instead (`tui_gateway/owner_forward.py:1-17`). CONFIRMED by absence.
- **History:** WS turns are written to the same session (`tui_gateway/agent_factory.py:674, 679`; canonical runs on the same session), and each Telegram turn reloads the transcript (`gateway/run_turn_prepare.py:704`), so the platform side sees app turns as context. CONFIRMED.
- **Fork/takeover:** no `POST /api/sessions/{id}/fork` on the dashboard REST surface (`hermes_cli/web_routers/sessions.py:182-977`). Legacy `session.branch` creates a child whose source is the live record's (the client's, e.g. `desktop`/`tui`, after a legacy resume) (`methods_session_branch.py:105-114`; `tui_gateway/session_workdir.py:493-495`). Canonical `session.mutate {operation:"branch"}` requires a stored local policy, else `runtime_coordination_required` (`hermes_state_mutation_branch.py:53-56`); a messaging session has none, so a refusal is expected (inferred, UNCONFIRMED). `/handoff` only goes CLI to messaging (`sessions.md:266-293`).

### Tagging a client's own sessions with a source

- Legacy `session.create {source}` accepts any string and stores it as the session's DB `source` unchanged: "an explicit caller value ... is never rewritten; only empty/None falls back to the env-resolved platform" (`tui_gateway/methods_session.py:63-65`; `tui_gateway/agent_factory.py:42-45`). The fallback is `desktop` or `tui` depending on `HERMES_DESKTOP` (`agent_factory.py:30-33`). CONFIRMED.
- Canonical `session.create` limits `source` to `cli|tui|gui|acp|tool|oneshot`, default `cli` (`tui_gateway/contracts/canonical_sessions.py:21-23`). A custom tag such as `hermes-chat` is not accepted there. CONFIRMED.
- The official desktop app sends `source: 'desktop'` (for example `apps/desktop/src/app/session/hooks/branch-owner-routing.integration.test.ts:122`). Which value it uses on the canonical path is UNCONFIRMED.

### Session flags: archived, pinned, unread

- `PATCH /api/sessions/{session_id}` on the dashboard REST surface (`hermes_cli/web_routers/sessions.py:926-934`), body all-optional `{"archived": bool, "pinned": bool, "hidden": bool, "unread": bool, "title": str, "request_id", "expected_revision", "expected_generation", "profile"}` (`hermes_cli/web_models.py:280-290`); values must be strict booleans (`hermes_state_mutations.py:5, 50-55`). CONFIRMED.
- `unread: false` sets `last_read_at` to now, `unread: true` sets it to 0, applied across the compression lineage (`hermes_state_mutations.py:110-112`). A session is unread when last activity is newer than `last_read_at` (`hermes_state_sessions.py:1064-1075`). CONFIRMED.
- Nothing updates `last_read_at` automatically; the official desktop PATCHes it when a session is opened (`apps/desktop/src/store/session-unread-remote.ts:1-11`). It is one column per session, shared by every client, and changes are broadcast (`hermes_state_common.py:524`; `tui_gateway/change_watcher.py:197`). CONFIRMED.

## 6) Approvals

Policy: `approvals.mode: smart|manual|off`, `timeout: 300`, and `unattended_mode: deny` for api_server/webhook sessions, except "an api_server session whose client can answer the card (`/v1/runs` and streaming chat completions, via `POST /v1/runs/{id}/approval`) still gets the approval request" (`website/docs/user-guide/security.md:30-60`, line 52). Prior research's statement that approvals do not require WebSocket is CONFIRMED.

### API server

- Request arrives as SSE `event: approval.request` on `/v1/chat/completions` streams (`api_server_openai_routes.py:797-811, 1186-1187`), on `/v1/runs/{id}/events` (`api_server_runs.py:1003-1004`) and on `/api/sessions/{id}/chat/stream` (`api_server.py:3224-3225`). Payload = the approval queue entry plus the run envelope: `{"request_id":"...","command":"<redacted>","description":"...","allow_session":bool,"allow_permanent":bool,"smart_denied"?,"tool_name"?,"event":"approval.request","run_id":"...","timestamp":...,"choices":["once","session","always","deny"]}` (`api_server.py:86-103`; canonical owner maps `prompt_id` to `request_id` at `gateway/session_api_turn.py:325-332`). On chat completions "the completion id doubles as the run id" (`api_server_openai_routes.py:988-991`), so `POST /v1/runs/<chatcmpl-id>/approval` is the reply path.
- Answer: `POST /v1/runs/{run_id}/approval` with `{"choice":"once|session|always|deny","request_id":"<request_id>"}`; aliases `approve|approved|allow` map to `once`; `all`/`resolve_all` resolves every pending request; 409 `approval_not_active` / `approval_not_pending` when nothing is waiting (`api_server_runs.py:1348-1409`). With the canonical session authority the body must be `{"request_id":"<prompt_id>","execution_generation":<n>,"choice":"once"}`; stale generations return 409 (`api-server.md:656-670`; `api_server_runs.py:1366-1369`). Run status shows `waiting_for_approval` and `pending_controls` (`api_server_runs.py:1004`; `api-server.md:660-662`). Clarify questions use the sibling `POST /v1/runs/{id}/clarify {request_id, execution_generation, answer}` (`api-server.md:672-677`).

### WebSocket, legacy generation

- The backend sends a JSON-RPC **request** to the client: `{"jsonrpc":"2.0","id":"srq-<12 hex>","method":"approval","params":{"session_id":"...","request_id":"...","command":"<redacted>","description":"...","choices":[...],"allow_permanent"?,"allow_session"?,"smart_denied"?,"tool_name"?}}` (`tui_gateway/server_requests.py:1-16, 96-99`; `tui_gateway/contracts/server_requests.py:166-196`; `tui_gateway/server.py:651-664` computes `choices`).
- The client answers with a JSON-RPC response carrying the same id: `{"jsonrpc":"2.0","id":"srq-...","result":{"choice":"once","all":false}}` (`contracts/server_requests.py:190-193`).
- Precondition: the client must have sent `client.capabilities {server_requests: true}` once per connection, otherwise the server never writes the frame and the agent waits out the timeout (`server_requests.py:27-33`; `tui_gateway/contracts/liveness.py:57`).
- Withdrawal: `request.cancel {id, method, reason}` notification; `approval.cancelled` broadcast when pending approvals are dropped by interrupt/teardown (`server_requests.py:11-13`; `events.py:558-575`).
- Reconnect: unanswered requests are returned as `open_requests` by `session.resume` / `session.activate` / `session.events.since` (`server_requests.py:15-18`; `sessions.py:93`). Other server-request kinds use the same mechanism: `clarify`, sudo/secret/vault prompts, etc. (`contracts/server_requests.py:30-57`).

### WebSocket, canonical generation (`gateway.ready.session_authority: true`)

- Pending prompts arrive as `approval.request` / `clarify.request` events stamped with the owner's `execution_generation` and a `prompt_id` (`apps/shared/src/gateway-events.ts:30-41`; `gateway/session_api_turn.py:397`), and are also listed on the resume snapshot as `prompts: [{kind: approval|clarify, prompt_id, execution_generation, choices, command?, description?, question?, timeout_s?}]` (`canonical_sessions.py` `CanonicalPendingPrompt`, `CanonicalSnapshot.prompts`).
- Answer: RPC `approval.respond {session_id, execution_generation, prompt_id, choice}` returning `{status: resolved|already_resolved, prompt_id}` (`canonical_sessions.py:290-292, 333`; `tui_gateway/contracts/canonical.py:357-362`). `clarify.respond {session_id, execution_generation, prompt_id, answer}` likewise.
- Auxiliary RPCs in the OpenRPC contract: `approval.pending` (replay waiting approvals on reconnect) and `approval.received` (tell the backend the card is on screen so its timeout starts) (`apps/shared/src/gateway-contract.openrpc.json`, entries `approval.pending`, `approval.received`).

## 7) File attachments

### API server

- Inline images only: user `content` parts `{"type":"image_url","image_url":{"url":"https://..." | "data:image/png;base64,..."}}` on `/v1/chat/completions`; `input_image` on `/v1/responses`; same multimodal path on `/api/sessions/{id}/chat[/stream]` (`api-server.md:195-212, 263-280, 731`).
- Uploaded files (`file`, `input_file`, `file_id`) and non-image `data:` URLs return `400 unsupported_content_type`; "No file upload" is a listed limitation (`api-server.md:212, 280, 944`).

### WebSocket

All stage the attachment server-side for the next turn of a session (`tui_gateway/contracts/prompt_voice.py`):

- `image.attach {session_id, path}`: a gateway-visible host path (line 119-124).
- `image.attach_bytes {session_id, content_base64 | data, filename?, ext?}`: base64 upload from a remote client; magic bytes decide the type (PNG, JPEG, GIF, BMP) (lines 126-138; `tui_gateway/prompt_attachments.py:25-29`). Cap 25 MiB (`prompt_attachments.py:21`).
- `pdf.attach {path | content_base64 | data, filename?, first_page?, last_page?}`: pages rendered to PNG; cap 50 MiB and 25 pages per call (lines 141-168; `prompt_attachments.py:22-23`).
- `file.attach {path | data_url, name?, staged_upload?}` -> `{attached, name, path, ref_path, ref_text, uploaded}`: non-image files staged into the session workspace and referenced as `@file:` text (lines 171-199). Data-URL cap 256 MiB (`prompt_attachments.py:19-20`).
- `image.detach {path}`, `clipboard.paste` (lines 110-116, 202-212).
- Canonical `prompt.submit` carries `attachments: [{path, mime}]` directly (`canonical_sessions.py` `CanonicalAttachment`, `CanonicalSubmitParams.attachments`).

### At the deployed `bf0203a` (checked over SSH, 2026-10-31)

- The legacy `image.attach_bytes`, `pdf.attach` and `file.attach` contracts match the ones above (`tui_gateway/contracts/prompt_voice.py:86-199`). Results: `image.attach_bytes` -> `{attached, path, name, count, remainder, text, bytes, ...}`; `file.attach` -> `{attached, name, path, ref_path, ref_text, uploaded}`. `image.detach {session_id, path}` takes back a queued image (`methods_prompt.py:1133-1145`).
- Caps: `_ATTACH_BYTES_MAX_BYTES = 25 MiB` and `_PDF_ATTACH_MAX_BYTES = 50 MiB` / 25 pages (`tui_gateway/prompt_attachments.py:17-19`); over the cap is error 4018. **There is no data-URL cap for `file.attach` here**: the 256 MiB constant above is newer than `bf0203a`. The dashboard's WS takes frames up to `_DESKTOP_ATTACHMENT_WS_MAX_BYTES = 384 MiB` (`hermes_cli/web_server_boundary.py:26`, used as uvicorn `ws_max_size` in `web_server.py:1027`), so a 256 MiB file (about 342 MiB as base64) still fits in one frame.
- Images are `.png .jpg .jpeg .gif .webp .bmp` (`cli._IMAGE_EXTENSIONS`); `image.attach_bytes` refuses other extensions with 4016.
- **`pdftoppm` isn't installed on the live server**, so `pdf.attach` fails with 5028. Send PDFs with `file.attach`.
- `file.attach` quotes a `ref_path` that has whitespace, brackets or quotes, trying `` ` ``, then `"`, then `'` (`_format_ref_value`, `prompt_attachments.py:174-181`). The client puts `ref_text` in the prompt as-is.
- The official desktop app, in remote mode, sends images with `image.attach_bytes` and other files with `file.attach {data_url, name}`. It prepends the `@file:` refs, one per line, then a blank line, then the text. An image sent with no text gets the prompt "What do you see in this image?" (`apps/desktop/src/app/session/hooks/use-prompt-actions/submit.ts:280-302`).

Hermes Chat follows the desktop app (T12). Images go up to 25 MiB and other files, PDFs included, up to 256 MiB. Rust reads each file from its real path (from Tauri's native drop event or the file picker) and splices its base64 into the frame, so the bytes never pass through the webview.

### Dashboard REST (browser path)

`POST /api/chat/file-upload` multipart `file=` (+`?profile=`) stages a file under `$HERMES_HOME/uploads` and returns `{ok, path, size, staged_upload}` for a following `file.attach` (`hermes_cli/web_routers/uploads.py:22-55`); cap `WEBAPP_ATTACHMENT_MAX_BYTES = 16 MiB` (`hermes_constants.py:29`), returning HTTP 413 when exceeded (`uploads.py:36-41`).

## 8) Cancel

- API server: `POST /v1/runs/{run_id}/stop` returns `{"run_id":"...","status":"stopping"}` immediately; the run settles as `cancelled` when the worker exits; canonical authority path via `stop_run` (`api_server_runs.py:1492-1523`; `api-server.md:649-654`). Applies to chat-completions streams too because the completion id is the run id. Closing the SSE connection also interrupts the agent ("On client disconnect the agent is interrupted (stops LLM calls), then its task wrapper cancelled", `api_server_openai_routes.py:1159-1160, 1238-1240`).
- WS legacy: `session.interrupt {session_id, expected_hosted_task_id?}` -> `{"status":"interrupted"|"not_interrupted","interrupted"?,"turn_isolation"?}` (`tui_gateway/methods_session_interrupt.py:70-107`; `contracts/sessions.py:605-621`). Same shape at the deployed `bf0203a` (`contracts/sessions.py:603-620`), checked by source read. `not_interrupted` comes only with `expected_hosted_task_id`. The handler answers without waiting for the agent. The turn then ends with `message.complete {status: "interrupted"}`, whose `text` is the partial reply or `""` (`prompt_turn.py:311-314`, `_turn_outcome`). An unknown runtime id gets error `4001 "session not found"` (`session_registry.py:304-320`).
- WS canonical: `session.interrupt {session_id, execution_generation}` -> `CanonicalSessionHandle` (`canonical_sessions.py:328`; `CanonicalControlParams`). Prior research's "interrupt requires the execution generation" is CONFIRMED for canonical.
- Queue controls: `prompt.cancel`, `prompt.steer_queued`, `prompt.replace_queued`, `/discard <admission_id>` for a turn lost in a restart (`gateway-contract.openrpc.json`; `desktop.md:194`).

## 9) How the official Hermes desktop app connects

Source: `apps/desktop/electron/*` (Electron main process) and `website/docs/user-guide/multi-connection-desktop.md`, `desktop.md`.

### Gateway ("Remote gateway") mode

- User enters a base URL of a running `hermes serve` backend, e.g. `http://homelab.lan:9119` (reverse-proxy path prefixes allowed), and picks **Session token** or **OAuth** (`multi-connection-desktop.md:121-129`).
- Token mode: static dashboard session token; REST uses an `X-Hermes-Session-Token` header, WS uses `ws(s)://host/api/ws?token=<token>` (`apps/desktop/electron/connection-config.ts:12-15, 96, 257`). The backend side that validates it is the `HERMES_DASHBOARD_SESSION_TOKEN` provider for gated binds (`web-dashboard.md:865-889`).
- OAuth mode: cookie session (`hermes_session_at` / `hermes_session_rt`), WS via single-use `?ticket=` minted at `POST /api/auth/ws-ticket` right before each socket open (`connection-config.ts:15-34`; `apps/desktop/electron/oauth-rest-request.ts:135`; `apps/shared/src/websocket-url.ts:40-60`). The gateway advertises the gate via `/api/status.auth_required` (`connection-config.ts:17-18`).
- Local profiles use `hermes gateway ensure --json` plus control-socket `session-ticket` grants (`interactive` for WS, `native-http` for HTTP via `X-Hermes-Gateway-Ticket`) (`apps/desktop/docs/canonical-gateway-protocol.md:11-19`; `desktop.md:581`). This is the path the prior research's "native attachment" section describes; it is CONFIRMED but is a loopback-only mechanism unless tunnelled.

### SSH mode

- Library/approach: the **system `ssh` binary**, not a JS SSH library: "Uses the system `ssh` client (not a JS SSH library) so it inherits ~/.ssh/config, the agent, jump hosts (ProxyJump), and hardware keys for free" (`apps/desktop/electron/ssh-connection.ts:4-9`). On non-Windows the binary is bare `ssh`; Windows resolves System32 OpenSSH, then Git-for-Windows ssh (`apps/desktop/electron/ssh-binary.ts:51-77`).
- Options: `ControlMaster=auto`, `ControlPath=<hashed short path>`, `ControlPersist=300`, `BatchMode=yes` (never prompts; a passphrase-protected key must be in the agent), `StrictHostKeyChecking=accept-new` (TOFU; a changed key fails closed), `ExitOnForwardFailure=yes`, `ServerAliveInterval=15` (`ssh-connection.ts:13-24, 235-265`).
- What it runs remotely: it does **not** run the hermes CLI as the chat transport. It locates `hermes` via a login-shell probe, checks `uname`, then spawns a detached (`setsid`/`nohup`) `hermes serve --isolated --host 127.0.0.1 --port 0 --ssh-session-token-file <~/.hermes/desktop-ssh/...token> --ssh-owner-nonce <nonce>` (`apps/desktop/electron/remote-lifecycle.ts:1-16, 1119-1161`), scrapes `HERMES_DASHBOARD_READY port=<n>` from the remote log (`remote-lifecycle.ts:13-14, 1733-1738`; emitted by `hermes_cli/web_server.py:1278-1281`), writes a lockfile under `~/.hermes/desktop-ssh` so later connections reuse the same backend, and adopts the token the backend actually serves.
- Tunnel: `ssh -N -L <localPort>:127.0.0.1:<remotePort>` (via the ControlMaster, `-O forward` where muxing works) and then `baseUrl = http://127.0.0.1:<localPort>` for all REST and `/api/ws` traffic (`ssh-connection.ts:1203-1238`; `remote-lifecycle.ts:1439-1448, 1740-1742`). Docs: "Your SSH key is used; the app adopts a dashboard token over the tunnel" (`multi-connection-desktop.md:45, 130-133`).
- The `--ssh-session-token-file` / `--ssh-owner-nonce` flags are validated server-side (absolute path under the desktop-ssh dir, owner and permission checks) (`hermes_cli/main_dashboard.py:754-816`) and exempt that loopback backend from the auth gate (`web_server.py:974, 1413-1422`). Older remote installs that lack the flags are rejected with a "does not support" error (`remote-lifecycle.ts:1302`).

### Comparison with the prior (Electron/ssh2) client design

The prior repo's ADR 0003 chose an embedded `ssh2` client with `direct-streamlocal` to the gateway control socket plus a TCP forward to the discovered gateway port. That is a valid alternative (the control socket and `session-ticket` verb exist at this SHA), but it is not what the official app does. The official approach (spawn an isolated `hermes serve` per desktop over SSH, forward one TCP port, use the served token) avoids the control socket, `StreamLocal` forwarding, and the ephemeral-gateway-port discovery problem. For Tauri, the equivalent is spawning the system `ssh` from Rust with the same options.

## Live server probe (2026-10-31)

Unauthenticated `GET http://100.100.64.121:9119/api/status` against the owner's server (Tailscale node `hermes`). Nothing else was called.

- **Version:** `0.22.5`, release `2026.9.24`. That is older than the `c419cf7` source this doc cites (2026-10-31), so the line references may not match the deployed code exactly. The server reports `can_update_hermes: true`.
- **Auth gate:** `auth_required: true`, `auth_providers: ["basic", "conduit-local-live"]`, `auth_flows: ["cookie", "native_pkce"]`. There is **no `session-token` provider**: `HERMES_DASHBOARD_SESSION_TOKEN` is not set, so the static-token mode the official app uses won't work against this server as configured. `basic` is username/password login (section 2). `conduit-local-live` isn't covered by the source read for this doc (UNCONFIRMED).
- **Connected platforms:** only `api_server` and `webhook`, for both the `default` and `studio-gateway` profiles (the API server listens on `127.0.0.1:8646`). **No Telegram or Discord adapter is connected or configured.** The other configured entries are `<profile>:buzz` adapters failing with `cli_missing`. Sessions that already have `source=telegram|discord` in `state.db` could still be listed, but a reply sent to them now has no platform to go out on.
- **Profiles:** 19 profiles (`default`, `aegis`, `anvil`, …, `work-email-manager`), `gateway_mode: "multiplex"`. Each profile has its own `state.db` (section 5), so a client sees one profile's chats at a time unless it queries each one.
- **Host health:** `disk.pressure: "critical"` (94.7% used, about 930 MB free). Not a client concern, but SQLite WAL writes will fail if the disk fills.
- `gateway.ready.session_authority` (legacy vs canonical) can't be read without authenticating. Resolved below by reading the deployed source.

### SSH tunnel, Host header and protocol generation (2026-10-31, over SSH)

Checked over SSH as `liam@10.2.1.136` (LAN address of the Tailscale node `hermes`). The deployed source is the git checkout `~/.hermes/hermes-agent` at `bf0203a794a07aac3ff764972ab9087baa4e4f4e` (committed 2026-10-22). Paths below are relative to that checkout, not to `c419cf7`.

- **Processes.** Port 9119 is a standalone `hermes dashboard --host 0.0.0.0 --port 9119 --skip-build --no-open` started by the systemd user manager. The messaging gateway is a separate `hermes gateway run` process that owns the API server on `127.0.0.1:8646`. `127.0.0.1:8642` is a Caddy proxy (`~/.config/hermes-studio/Caddyfile.local`), not Hermes. The `hermes` binary is not on a non-login shell's `PATH`.
- **Loopback through the tunnel: reachable.** `ssh -N -L <local>:127.0.0.1:9119 liam@10.2.1.136` works; `GET /api/status` through it returns 200.
- **Host header: any well-formed value.** Because the bind is `0.0.0.0`, `_is_accepted_host` accepts every syntactically valid Host on both HTTP and WebSocket ("All-interfaces bind: no Host-layer defence is possible", `hermes_cli/web_server_boundary.py:79-102`, WS check at `:190-215`). Tested through the tunnel: `127.0.0.1:<local>`, `127.0.0.1:9119`, `localhost:9119`, `hermes:9119`, `100.100.64.121:9119` and `evil.example` all returned 200. A WS `Origin` header, if sent, must be an http(s) origin for the bound host, or a non-web scheme (`file:`, `app:`, `null`), which is always trusted (`web_server_boundary.py:207-215`). A Rust client that sends no `Origin` passes.
- **The auth gate still applies through the tunnel.** Whether the gate is on depends only on the bind address (`should_require_auth(host)`, `web_server_boundary.py:106-113`), not on the peer. A tunnelled request comes from `127.0.0.1`, but `GET /api/sessions` still returns `401 {"error":"unauthenticated","reason":"no_cookie","login_url":"/login"}`. So tunnelling to this dashboard needs the `basic` password login (username `liam`, from `dashboard.basic_auth` in `config.yaml`), then a ws-ticket. **This contradicts open risk 6 below**, which assumed the ungated loopback path applies over an SSH tunnel. That is only true when the backend itself is bound to loopback.
- **`--insecure` is ignored.** `should_require_auth(host, allow_public=False)`: "`allow_public` (legacy `--insecure`) is accepted for old launch scripts but IGNORED since the June 2026 hermes-0day campaign" (`web_server_boundary.py:106-113`). Closes open risk 3.
- **Protocol generation on 9119: legacy.** `/api/ws` on the dashboard runs `handle_ws` in-process (`hermes_cli/web_routers/chat_ws.py:700-735`). `gateway.ready` includes `session_authority: true` only when `app.state.session_authority` (or the ASGI scope key `hermes.session_authority`) is set (`tui_gateway/ws.py:360-361, 552`). In the deployed tree that is assigned only by the gateway process's own listener (`gateway/run_api.py:70, 366`), never by a standalone `hermes dashboard`. Source read only: logging in to read the live frame was skipped at the owner's request. Expect `gateway.ready` without `session_authority`, and speak the legacy verbs (`session.create {source}`, `prompt.submit {session_id, text}`). **Confirmed live later the same day** by the T1 app: it refuses a `gateway.ready` that carries `session_authority`, and it connected. `session.create {profile: "default", source: "hermes-chat"}` stored session `20261031_224226_c99bc4` in `~/.hermes/state.db` with `source = 'hermes-chat'` (an explicit source is kept as sent) and `pinned = 0`. The server log tags the turn `platform=hermes-chat`. `display.streaming: true` is set in `config.yaml`. The WS sends every frame, coalesced token batches included, as its own text message (`tui_gateway/ws.py:117-122, 165-280`).
- **Desktop SSH mode is available.** The deployed `hermes_cli/main_dashboard.py:753-797` validates `--ssh-session-token-file`, and `~/.hermes/desktop-ssh/` already holds entries from the official app. A client could spawn its own isolated loopback `hermes serve` over SSH the way section 9 describes, which needs no dashboard password.
- **Legacy contracts at `bf0203a`.** `session.create` params: `{profile?, cols?, source?, cwd?, title?, model?, ...}` → `{session_id, stored_session_id, message_count, messages, info}`. "A DB row appears on the first prompt unless seeded" (`tui_gateway/contracts/sessions.py:118-151`). `prompt.submit` params: `{session_id, profile?, text, ...}` → `{status: streaming|queued|steered|redirected, user_row_id?, ...}` (`tui_gateway/contracts/prompt_voice.py:26-83`). `message.delta.payload` is `{text: str|null, rendered?, verbose?}` (`tui_gateway/contracts/events.py:155-169`). `message.complete.payload` has `{text, usage?, status?, error?, partial?, failure_reason?, ...}` (`events.py:269-293`). `client.capabilities {server_requests}` is optional: "A WebSocket client that never says so is treated as a build older than server→client requests and every such request fails fast for it" (`tui_gateway/contracts/liveness.py:29-38`).

### Password login and profiles (source read)

- `POST /auth/password-login` with JSON `{provider, username, password, next?}` (provider `"basic"` on this server). On success it returns `{"ok": true, "next": ...}` and sets the session cookies. Errors are generic: 401 bad credentials, 404 unknown or non-password provider, 429 rate limited (sliding window per client IP), 503 provider unreachable (`hermes_cli/dashboard_auth/routes.py:400-425, 464-509`). The WebSocket then needs a one-time ticket from `POST /api/auth/ws-ticket`, whose response is `{ticket, ttl_seconds}` (`routes.py:585`). `POST /auth/logout` revokes the refresh token (`routes.py:512-519`). CONFIRMED.
- One sign-in covers every profile. On the canonical path the authenticated WS identity gets `profile_scope: 'host'` ("The dashboard gate authorizes the whole host (its REST routes take `?profile=` for every profile), so its socket may select any served sibling too", `hermes_cli/web_routers/chat_ws.py:673-676`). The WS picks a profile with `?profile=<name>` (`chat_ws.py:499, 512`), and dashboard REST routes take `?profile=` (section 5 table). CONFIRMED.

## Open risks

Items marked UNCONFIRMED above, plus things that must be checked against the user's live Debian server:

1. **Which surface the server actually exposes.** Probe `GET http://<host>:8642/v1/capabilities` (bearer) and `GET http://<host>:9119/api/status` (public). The API server is off by default; `hermes serve` may not be running at all, and the `hermes gateway` process's own listener binds an ephemeral loopback port.
2. **Dashboard token header.** The official desktop sends `X-Hermes-Session-Token` on REST in token mode; the Python code read here only shows `Authorization: Bearer <token>`. Verify which the live server accepts (`web_server.py:297-308` vs `connection-config.ts:13`).
3. **`--insecure` flag semantics** for `hermes serve`/`dashboard`. Resolved 2026-10-31: ignored by the deployed `bf0203a` (see "SSH tunnel, Host header and protocol generation").
4. **Continuing messaging-platform sessions (Telegram/Discord) from a WS client.** Source says attachable; replies go to the platform chat too on the canonical path, WS-only on legacy, WS-only for detached sessions (section 5). Still to test live: check `gateway.ready.session_authority`, then submit to a throwaway Telegram session and observe where the reply lands.
5. **Legacy vs canonical protocol on the live server.** Check `gateway.ready.session_authority`; the RPC parameter shapes differ (`session.interrupt`, `prompt.submit`, approvals). Do not mix the schemas. 2026-10-31: the dashboard on 9119 is legacy by source read of the deployed `bf0203a`, not yet read from a live frame.
6. **Auth gate when binding non-loopback.** A `--host 0.0.0.0` or Tailscale-IP bind fails closed without a provider; the simplest static-token option is `HERMES_DASHBOARD_SESSION_TOKEN` (`session-token` provider). Confirm `/api/status.auth_providers` on the live server. ~~Over an SSH tunnel to `127.0.0.1` the ungated loopback path applies instead~~ **Corrected 2026-10-31:** the ungated path applies only when the backend is bound to loopback. On the live server (bound to `0.0.0.0`), tunnelled requests still hit the gate and need the `basic` login; see "SSH tunnel, Host header and protocol generation". A loopback-bound backend, such as the official app's isolated `hermes serve`, still needs its per-process session token (scrape `window.__HERMES_SESSION_TOKEN__` as the official app does, or use `--ssh-session-token-file`).
7. **TLS.** Neither server does TLS. Public-internet use needs a reverse proxy with `dashboard.public_url` set (which also engages the auth gate), Tailscale, or the SSH tunnel.
8. **CORS for a Tauri webview.** If HTTP calls are made from the webview rather than Rust, the API server needs `API_SERVER_CORS_ORIGINS` and the dashboard only allows loopback origins by default (`web_server.py:570`). Prefer doing network I/O in Rust.
9. **Version skew.** All line numbers are for `c419cf7`; the user's server may be older (for example, pre-canonical, no `/v1/runs/{id}/resolve-unknown`, no `--ssh-session-token-file`). Check `/api/status.version` and `/v1/capabilities.features` before relying on any endpoint.
10. **WS `session.list` has no last-activity field.** Use REST `GET /api/sessions?order=recent` on the dashboard, `last_active` on the API-server list, or canonical `info.last_active_at` if recency ordering in the UI matters.
