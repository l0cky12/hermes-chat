# Webhook automations: the server contract (`webhooks/1`)

Status: proposed for Hermes, with a reference implementation (`webhook-automations/hermes-bf0203a.patch`) that this app
was built and verified against. Issue: #83. Decision record: ADR 0108.

An **automation** is a Hermes webhook route: a named endpoint on the gateway's webhook listener that verifies an
outside service's signed event and starts a task for it. Hermes already has most of this. This document says what the
deployed Hermes (`bf0203a`) provides, what it lacks for #83, and the contract that fills the gap. It defines one
provider, GitHub.

## 1. What the deployed Hermes already does (`bf0203a`)

Checked against a throwaway copy of the deployed checkout with a throwaway `HERMES_HOME` (section 7 has the output).

Ingress, in the gateway (`gateway/platforms/webhook.py`), `POST /webhooks/<route>` on the listener (default
`:8644`, `platforms.webhook.extra.port`):

1. Route lookup (static `config.yaml` routes plus the hot-reloaded `webhook_subscriptions.json`). Unknown → 404.
   Paused (`enabled: false`) → 403.
2. Size cap before reading (`max_body_bytes`, 1 MiB) → 413.
3. Signature, by whichever header is present: GitHub `X-Hub-Signature-256` (HMAC-SHA256 of the body), GitLab token,
   Svix/Standard Webhooks (signed id and timestamp), Linear, generic V2 (HMAC of `<timestamp>.<body>`, ±300 s), and
   generic V1 (body only, deprecated). No usable secret → 403; bad → 401.
4. Rate limit per route (30/min) → 429.
5. Event type filter (`events`), declarative `filters`, optional `script`. Not matching → 200 `ignored`.
6. Dedupe by `(profile, route, delivery id)`: an in-memory 1-hour cache for direct-delivery, cron and coalesced
   routes; for agent routes, the durable admission ledger (`session_admissions`) refuses the same delivery id again.
7. Optional coalescing by a payload key (in memory; flushed on clean shutdown).
8. Agent run: admitted to the profile's session authority, run as a `webhook` session whose `chat_id` encodes
   `[profile, route, delivery id]`.

Dashboard REST (`hermes_cli/web_routers/ops.py`): `GET /api/webhooks`, `POST /api/webhooks` (create, and replace
when the name exists; a new secret is generated unless one is passed, and returned once), `DELETE
/api/webhooks/{name}`, `PUT /api/webhooks/{name}/enabled`, `POST /api/webhooks/enable` (turns the platform on and
restarts the gateway). Sessions: `GET /api/sessions?source=webhook`.

## 2. What #83 needs that it lacks

| Need | Gap at `bf0203a` |
|---|---|
| Filters, coalescing, provider in the editor | The dashboard's create takes neither `filters` nor `coalesce`; any signature scheme reaches any route. |
| Edit an automation | No update route. Create replaces the route and makes a new secret (`secret` is redacted on read, so a client can't keep it). |
| Secret reference | The secret is stored in the route, and the only way to set it from a client is to send it. |
| Delivery history with received/filtered/queued/running/completed/failed | No record. Filtered, refused and duplicate deliveries exist only in logs. Accepted agent deliveries leave a session, but its `end_reason` is `webhook_complete` even when the run failed; the real outcome is in `session_admissions`, which the dashboard doesn't expose. |
| Replay protection for GitHub | GitHub signs no timestamp, and `X-GitHub-Delivery` is outside the signature. A captured request replayed under a new delivery id passes every check. The in-memory cache also forgets after an hour or a restart. |
| Explicit retry | None. |
| Create paused | A new route is always live. |

## 3. The contract

All additions are opt-in fields and new paths. A client that doesn't know them sees what it saw before.

### 3.1 Discovery

`GET /api/webhooks?profile=` adds:

```json
{ "contract": "webhooks/1", "providers": ["github"],
  "limits": { "retention_seconds": 604800, "max_rows_per_route": 1000, "max_body_bytes": 1048576,
              "rate_limit_per_minute": 30, "signed_timestamp_window_seconds": 300 },
  "subscriptions": [ { "...": "the bf0203a summary, plus:",
      "provider": "github", "filters": [], "coalesce": null, "profile": "default",
      "secret_ref": "stored | env:NAME", "secret_env_set": true, "deliver_chat_id": null,
      "kind": "agent | deliver_only | cron_job", "revision": "16 hex",
      "last_received_at": 1793721516.8, "rejections": { "bad_signature": { "count": 3, "last_at": 1793721517.0 } } } ] }
```

A client treats a missing `contract` as `bf0203a` behaviour.

### 3.2 Routes

- `POST /api/webhooks?profile=` also takes `provider` (`"github"`), `filters` (Hermes's declarative filter list, at
  most 20, no `in_file` from a client), `coalesce` (`{key, window_seconds, max_wait_seconds}`, each at most 86400),
  `secret_env` (an environment variable name; the route then stores no secret and none is returned), `enabled`
  (`false` creates it paused) and `create_only` (409 instead of replacing an existing name).
- `PUT /api/webhooks/{name}?profile=` (new) edits in place. Body: `revision` (required) and any of `description`,
  `events`, `prompt`, `skills`, `deliver`, `deliver_chat_id`, `provider`, `filters`, `coalesce` (`{}` turns it off),
  `secret_env` (`""` goes back to a stored secret, made and returned once) and `rotate_secret`. Fields left out keep
  their value; the secret is kept unless rotated. A stale `revision` → 409 with `detail.current`, the route as it is.
- `DELETE` also deletes the route's delivery history.

### 3.3 Ingress, in order

1. Route lookup; paused → 403, counted (`rejections.paused`).
2. Size cap → 413, counted.
3. Signature. A `provider: "github"` route checks `X-Hub-Signature-256` over the body and nothing else, whatever
   other scheme's headers come with it, and requires `X-GitHub-Delivery` (else 401/400). Generic V2 keeps its ±300 s window. Failures are counted by kind (`bad_signature`, `stale_timestamp`,
   `missing_delivery_id`, `no_secret`). **Nothing from a request that fails here is stored**: it is untrusted, and
   storing it would let anyone fill the disk.
4. Rate limit → 429, counted.
5. **Store the delivery** in the profile's ledger (`$HERMES_HOME/webhook_deliveries.db`, mode 0600) as `received`,
   before anything acts on it. Then, in order:
   - **Same delivery id as a row that did more than fail before running.** If that row started an agent task, the
     copy goes on to Hermes's own admission ledger, which decides it exactly as at `bf0203a` (a duplicate, finishing a
     run whose reply was settled, refusing a changed body or a fenced profile with 503); the ledger only counts it.
     Any other copy (filtered, coalesced, direct delivery, cron trigger) is answered 200 `duplicate` here, durably,
     where `bf0203a` only had a one-hour in-memory cache.
   - **Same signed material under another delivery id**, on a `provider: "github"` route: 200 `duplicate`, counted on
     the original, when any delivery with that material did more than fail before running. This is the GitHub replay
     window: a replayed capture carries the same signed body whatever delivery id it is given. Routes without a
     provider keep `bf0203a`'s behaviour (their schemes may sign a timestamp or id; generic V1 stays replayable, as
     Hermes documents).
   - **Never ran.** A delivery that failed before running (`admission_unavailable`: the profile wasn't being served,
     for example straight after a gateway start), or that is still `received` but was stored by a gateway process
     that has since been replaced (each gateway process records its instance id in the ledger it serves; a live one
     may still be acting on a delivery, however long its script takes), is processed again when the provider resends
     it, under its id or another, unless another attempt at the same event (a retry of it, or the same signed body)
     did run. A body runs at most once however it arrives. The history shows a stuck one as failed (`interrupted`),
     and retrying it asks first.
6. Event type, filters, script → `filtered` with the reason (`event:<name>`, `filter`, `script`).
7. Coalescing → `coalesced` with the group key; when a later event replaces it, `superseded` with `superseded_by`.
8. Agent admission → `queued` with the session's `chat_id`; admission failure → `failed`
   (`admission_unavailable`, 503, so the provider retries). Direct delivery → `completed` or `failed`
   (`delivery_failed`). Cron trigger → `queued` (`cron_job`).

The ledger keeps 7 days (longer than GitHub's 3-day redelivery window) and at most 1000 rows per route. A replay older
than that is no longer recognised; the history says so.

### 3.4 History

`GET /api/webhooks/{name}/deliveries?profile=&limit=50&before=<received_at>` → newest first:

```json
{ "route": "triage", "contract": "webhooks/1", "enabled": true, "next_before": null, "limits": {},
  "rejections": { "bad_signature": { "count": 1, "last_at": 1793721517.0 } },
  "deliveries": [ { "delivery_id": "…", "event": "issues", "action": "opened",
      "received_at": 1793721516.8, "updated_at": 1793721523.3,
      "state": "received|filtered|coalesced|superseded|queued|running|completed|failed",
      "reason": "event:push|filter|script|admission_unavailable|delivery_failed|failed|interrupted|cancelled|settled_unknown|…",
      "session_id": "20261103_155836_396c6f6e", "outcome": "completed|failed|interrupted|cancelled|settled_unknown",
      "duplicates": 2, "last_duplicate_at": 1793721600.0, "retry_of": null, "coalesce_key": "example/fixture#42",
      "superseded_by": null, "excerpt": { "repository.full_name": "example/fixture", "issue.number": 42, "issue.title": "…" },
      "retryable": false, "retry_needs_confirmation": false } ] }
```

`queued`/`running`/`completed`/`failed` for an agent task are read at query time from the profile's admission ledger
(`session_admissions.status` and `outcome`), which is the authority on them; the delivery ledger doesn't copy them.
The excerpt holds only identifying fields; the stored body is never returned.

### 3.5 Retry

`POST /api/webhooks/{name}/deliveries/{delivery_id}/retry?profile=` with
`{"idempotency_key": "8–64 of [A-Za-z0-9_-]", "confirm_side_effects": false}`:

- Only a `failed` delivery with a stored body, on a running route, when no other attempt at the same event (the
  original or any retained retry of it) is queued, running, completed or in flight; each attempt's state is read
  from the admission ledger. Otherwise 409 `not_retryable` or `paused`.
- The dashboard **reserves** the retry in the ledger before sending it, in one `BEGIN IMMEDIATE` transaction with
  that check, so two retries at once (two windows, two keys) start one task. The gateway claims the reservation
  when the retry arrives. Until then it blocks every other attempt: if the gateway doesn't answer in time (504
  `uncertain`), the retry may still arrive, and the same key answers `already_sent`. A reservation the gateway
  refused outright is released; one it never claimed stops blocking once the retry window (300 s, plus a minute)
  has passed, since the gateway would refuse its signature by then.
- If the failed attempt had started (`failed`, `interrupted`, `cancelled`, `settled_unknown`, or a direct delivery
  whose answer was unclear), its tools may have acted: 409 `needs_confirmation` unless `confirm_side_effects`.
- The dashboard re-sends the stored body to the gateway's own listener as delivery `<original>~retry~<key>`, signed
  with the route's secret over `<timestamp>.<original>.<key>.<body>` (`X-Hermes-Retry-*` headers, ±300 s). It goes
  through the whole pipeline again: filters as they are now, coalescing, dedupe. Only a holder of the secret can make
  one, and the same key is a duplicate, so a lost answer retried with the same key never makes a second task
  (`already_sent`), unless that retry never ran (the gateway couldn't take it), when it is sent again under the same key. A retry is a new task in a new chat; nothing is undone.

## 4. Failure handling and limits

- **Gateway down**: the provider's request fails; GitHub marks it failed and offers redelivery from its own Recent
  Deliveries page. Nothing is stored. Resending after the gateway is back is processed normally.
- **Gateway restart**: ledger rows and agent admissions survive. Events waiting in a coalescing group are dispatched on a
  clean shutdown and lost on a kill (as at `bf0203a`).
- **Ordering**: rows are in receipt order. GitHub doesn't promise order; coalescing keeps the latest *received* event.
- **Size and rate**: 1 MiB and 30/min per route, as at `bf0203a`; refusals are counted, not stored.
- **Untrusted content**: payload text is rendered into the prompt as it is. The secret is never in the payload or the
  prompt. Webhook tasks keep Hermes's restricted default toolset unless a route's `toolsets` is changed in config.
- **Storage scope**: per profile home. Deleting a route deletes its rows.
- **Ledger writes are synchronous SQLite on the gateway's loop** in the reference implementation: small writes, but a
  production version should move them off the loop. The ledger file has no schema migration; it is new in `webhooks/1`.

## 5. Not in `webhooks/1`

- Other providers in the editor (GitLab, Standard Webhooks). The listener still verifies them; the editor sets up GitHub.
- A route's project or working folder. Hermes runs webhook tasks in the profile without a folder; the editor says so.
- Editing `deliver_only` and `cron_job` routes from a client.

## 6. What the app does on each server

| | Stock `bf0203a` | `webhooks/1` |
|---|---|---|
| Create | Yes; refused here if the name exists (Hermes would replace it). Paused straight after if asked. Filters, coalescing and a secret reference are refused, not dropped. | Yes, paused if asked, `create_only`. |
| Edit | Only by replacing, which makes a new secret; the owner confirms, and the app checks first that no one else changed it. | In place, with `revision`. |
| Pause / resume / delete | Yes, read back. | Yes, read back. |
| History | The route's `webhook` sessions: when each task ran, whether it ended, and a link to it. | The ledger, with rejection counts, links and retry. |
| Retry | No. | Yes. |

## 7. Verification against Hermes

Throwaway copy of the deployed `bf0203a` (`git archive`) with the patch, throwaway `HERMES_HOME`, gateway listener
and dashboard on loopback, no provider or platform credentials. The scripts are in `webhook-automations/`:
`setup.sh` builds it from the patch, `e2e.sh` runs the deliveries below against a real gateway and dashboard (signed
with `send.py` as GitHub signs, read with `probe.py`), and stops only what it started.

- The patch's own tests: `tests/gateway/test_webhook_ledger_contract.py` (19) and
  `tests/hermes_cli/test_webhook_deliveries_api.py` (4). Signed delivery stored before work, duplicate id and same-body
  replay (also with another scheme's made-up headers on it), refused requests counted not stored (bad signature, generic V1 on a GitHub
  route, missing delivery id, oversized), filtered with the reason, owner retry signed and deduped by key, stale retry,
  coalescing and superseding, out-of-order arrival, gateway restart, pause with a queued task, a changed provider
  schema, retention, a body that ran once never running again after an attempt that never ran, a delivery stuck as
  received processed only once its gateway is gone, a redelivery of an event a retry already ran, a retry while the
  original is queued, a failed retry not blocking another but its original running again blocking it, a retry whose
  answer timed out keeping others out until it expires, and two retries at once starting one task.
- Hermes's existing webhook tests (`tests/gateway/test_webhook_*.py`, 149 with the patch's), and the dashboard and
  file-safety tests that read `webhook_subscriptions.json` (306), pass with the patch as without it.
- The patch also applies to Hermes's current `main` (`f0d94882e8`).

Stock, before the patch:

```text
== signed               202 {"status": "accepted", "route": "gh-issues", "event": "issues", "delivery_id": "7b1c0a10-…-000000000001"}
== bad signature        401 {"error": "Invalid signature"}
== replay of the first  200 {"status": "duplicate", "delivery_id": "7b1c0a10-…-000000000001"}
== other event type     200 {"status": "ignored", "event": "push"}
```

With the patch, see the PR for the full `e2e.sh` run, including the same signed body under a new delivery id being
refused before and after a gateway restart.
