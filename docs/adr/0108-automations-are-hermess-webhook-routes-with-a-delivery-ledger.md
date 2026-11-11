# Automations are Hermes's webhook routes; their history needs a delivery ledger on the server

An Automation is a Hermes webhook route in one profile. Hermes's gateway receives the outside service's event,
verifies its signature, filters it and runs the task, so automations work while Hermes Chat is closed. The app only
sets routes up and inspects them, over dashboard REST `/api/webhooks*`, naming the profile on every call and reading
the list back after every write. GitHub is the one provider the editor sets up.

The deployed Hermes (`bf0203a`) can create, list, pause and delete routes, but can't keep filters or coalescing from
a client, can't edit a route without making a new secret, keeps no record of deliveries, offers no retry, and doesn't
recognise a GitHub replay sent under a new delivery id (GitHub's delivery id is outside its signature). So the app
works against two contracts: stock `bf0203a`, and `webhooks/1` (docs/design/webhook-automations.md), which a server
announces with `"contract": "webhooks/1"` on `GET /api/webhooks`. `webhooks/1` stores every authenticated delivery
in a per-profile ledger before anything acts on it, deduplicated by delivery id and, on GitHub routes, by the SHA-256 of
the signed body. A copy of a delivery that started a task still goes to Hermes's own admission ledger, so Hermes's
recovery of admitted runs is unchanged.
It also adds a compare-and-swap edit, filters, coalescing, a secret reference and an owner's retry. A reference
implementation is kept as a patch against `bf0203a` (docs/design/webhook-automations/), which this app was verified
against.

## Considered options

- **Receive webhooks in the app, or in a sidecar the app runs.** Rejected: events would be lost while the app is
  closed, and it would add an endpoint beside Hermes's, which already verifies signatures, limits size and rate,
  and runs the task in the right profile.
- **Derive the history from Hermes's logs over the terminal.** Rejected: logs aren't a contract, rotate, and mix
  profiles.
- **Derive the history from `webhook` sessions alone.** Kept as the stock fallback, but it can't be the design:
  filtered, refused and duplicate deliveries leave no session, and a failed run's session ends with
  `webhook_complete` like a successful one.
- **Deduplicate GitHub by delivery id only.** Rejected: `X-GitHub-Delivery` isn't signed, so a captured request
  replays under any new id. The signed body's digest is.
- **Store refused requests in the history.** Rejected: they are unauthenticated; storing them lets anyone fill the
  disk. They are counted per route and kind.
- **Retry by asking the gateway over its control socket.** Rejected for the reference implementation: the dashboard
  re-sends the stored body to the gateway's own listener, signed with the route's secret and an idempotency key, so a
  retry goes through the same pipeline as the original and can't run twice.

## Consequences

- **Secrets.** Hermes makes the secret and returns it once; the screen shows it until dismissed and keeps it nowhere
  (not in storage, not in the prompt). On `webhooks/1` a route can instead name an environment variable on the server,
  so the secret never passes through the app. The Rust relay refuses any `secret` field, and never relays `POST
  api/webhooks/enable`, which rewrites the config and restarts the gateway.
- **Stock server.** Create checks the list first, since Hermes's create replaces a route of the same name; filters,
  coalescing and a secret reference are refused, not silently dropped. "Create paused" pauses straight after, which is
  safe because no one has the new secret yet. Editing can only replace the route, which makes a new secret: the owner
  confirms that, and the app first checks the route's shown fields haven't changed since it was opened (Hermes checks
  nothing). History lists the route's `webhook` sessions (decoded from their `chat_id`) with links to them, and says
  what it can't show.
- **Preview.** The editor renders the prompt and evaluates filters and the coalescing key the way Hermes's
  `_render_prompt`, `filter_matches` and `group_key` do. It is checked against Hermes's own code with
  `tools/webhook-golden.py`. Python's regular expressions and integers past 2^53 are the known differences. A filter's
  pattern is tested on a worker with a time limit (ADR 0139). Example events are
  synthetic; a pasted one is sanitised and stays on this computer. Event text is always shown as text.
- **Retry** is never automatic. It is offered only for a failed delivery; when the failed attempt had started, the app
  asks first, since its tools may have acted and a retry undoes nothing. A retry whose answer was lost is sent again
  with the same key, and Hermes answers that it already has it.
- **Ordering and retention.** The history is in receipt order, which isn't GitHub's; coalescing keeps the latest
  received event. `webhooks/1` keeps 7 days and 1000 rows per route; older replays aren't recognised.
- **Scope.** Everything is per profile: to run a route's tasks in another profile, switch to it. A route's project or
  working folder isn't settable in either contract.
- **Relay.** `POST api/webhooks`, `PUT api/webhooks/{name}`, `PUT api/webhooks/{name}/enabled` and `POST
  api/webhooks/{name}/deliveries/{id}/retry`, each with only the body keys the app sends.
