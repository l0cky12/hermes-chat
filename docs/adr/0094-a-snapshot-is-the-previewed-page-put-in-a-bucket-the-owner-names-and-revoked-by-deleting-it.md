# A snapshot is the previewed page, put in a bucket the owner names, and revoked by deleting it

**Status: proposed. Nothing is built. Waiting on the owner's answers to "Open questions", the first above all.**

Issue #92 asks for a copy of a chat that other people can open. The owner picks what goes in, likely secrets are redacted, and Publish is explicit. Each copy has its own link, an optional expiry and Revoke, and later messages in the chat never reach it. ADR 0076 built the private part: the Export dialog picks the messages, flags and redacts likely secrets, and previews the exact file. It left one question for the owner, which is where a published copy lives. This ADR answers that question with a default, and decides everything that doesn't depend on the answer.

A **Snapshot** is that published copy. It is one immutable page, made from the Export dialog's file, held by a **Snapshot host**, and reached by a link that ends when the snapshot expires or is revoked. A snapshot is not a chat's web link (ADR 0062). A web link is a live view for someone who can sign in to the dashboard. A snapshot is a fixed copy for people who can't.

## Why Hermes can't host it

Read in the local Hermes source (`~/.hermes/hermes-agent` at `b200f5bc`, 2026-11-03, which contains the `f0d94882` that ADR 0076 read) on 2026-11-07. Nothing below was run against a live dashboard.

- **Hermes serves no chat content to anyone signed out.** The sign-in gate lets through only sign-in pages, static assets and a fixed list of status and config reads (`_GATE_PUBLIC_PREFIXES` in `hermes_cli/dashboard_auth/middleware.py`, `PUBLIC_API_PATHS` in `hermes_cli/dashboard_auth/public_paths.py`). Every file route is behind the gate too, and its download tickets last 60 seconds (`hermes_cli/web_server_file_tickets.py`).
- **A dashboard plugin can't serve it either.** A plugin's routes are mounted under `/api/plugins/<name>/`, behind the same gate, and nothing in a plugin's manifest exempts them (`_plugin_api_runtime_gate` in `hermes_cli/web_server.py`). So the third option in ADR 0062 doesn't help here.
- **Upstream is closing public access, not opening it.** `should_require_auth` (`hermes_cli/web_server_boundary.py`) ignores `--insecure` "since the June 2026 hermes-0day campaign" and treats LAN addresses as public.
- **Most connections can't be reached by other people anyway.** A connection reaches its dashboard through SSH, Tailscale, a LAN or a web address (ADR 0056). For a page on the dashboard to reach other people, the owner would have to expose the dashboard to the internet. Issue #92 rules that out ("do not expose the private dashboard").

So a snapshot needs a host that is on the internet, that is separate from the dashboard, and that this app can write to and delete from with the owner's own credential.

## Proposal

**The default Snapshot host is an S3-compatible bucket the owner names.** That means Amazon S3, Cloudflare R2, Backblaze B2, or a self-hosted MinIO or Garage. The bucket stays private. Each snapshot is one object, and its link is a presigned `GET` URL that the host refuses after the expiry. One protocol covers hosted and self-hosted stores, and the host, not this app, enforces the expiry.

### The data shape

A snapshot is one object, `<prefix>/<id>.html`. The object's metadata is the management list's record, so nothing about a snapshot is kept on this computer:

| Field | Where it lives | What it is |
|---|---|---|
| `id` | The object key | 26 characters of base32 from 128 random bits, made before the upload, so a retry writes the same key. |
| `title` | `x-amz-meta-title`, percent-encoded | The title line as the page has it, after redaction. |
| `created`, `expires` | `x-amz-meta-created`, `x-amz-meta-expires` | UTC times. `expires` is always set (see Expiry). |
| `sha256` | `x-amz-meta-sha256` | The SHA-256 of the page's bytes as published. |
| The page | The object's body | The HTML the owner saw in the preview, byte for byte. |

In the app the record is a typed `Snapshot` with one state, never a set of booleans:

- **Live.** The link works until `expires`.
- **Expired.** The host refuses the link. The object is deleted the next time the list loads.
- **Changed.** The body's SHA-256 no longer matches `sha256`, so something other than this app wrote it. The list offers Revoke only.

A revoked snapshot has no state. It is gone from the bucket and gone from the list.

The host settings are the endpoint, region, bucket, prefix (`hermes-chat-snapshots/` by default) and the access key's id. They are kept per computer in the app's config folder. The secret key is kept in the system keyring. Snapshots go to one bucket whatever connection or profile they came from.

### Sharing a snapshot

1. **Share snapshot…** in the chat header's More menu opens the Export dialog (ADR 0076) with Publish… in place of Save…. Every pick works as it does for an export. One default changes: Hermes's thinking starts unticked, as tool calls and attachment names already do.
2. **Publish… opens a confirm step.** It names the destination before anything leaves this computer: the host's address, the bucket and the prefix. It shows the expiry, the page itself, and two warnings. Detection can miss a secret. Anyone with the link can read the page until it ends, and a copy someone saves can't be recalled.
3. **The preview is the page.** The confirm step shows the exact bytes to upload in an `<iframe sandbox srcdoc>` that runs no script. Tests compare the bytes handed to Rust with the `srcdoc`.
4. **Publish uploads, and only Publish does.** With no host set, the dialog says so, links to Settings → Snapshots, and still offers Save as a file.

### The page

The webview builds the page from the Export dialog's Markdown. It uses the transcript's own Markdown pipeline (`src/ui/markdownPipeline.ts`) rendered to static markup.

- Raw HTML in a message stays text. It is never markup.
- Links keep only `https:`, `http:` and `mailto:` addresses, with `rel="noopener noreferrer"`. Images aren't loaded. Each shows as its alt text and address, so a viewer's browser fetches nothing a message names.
- The page has no script and loads nothing. Its `<meta http-equiv="Content-Security-Policy">` is `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`, with the stylesheet inline.
- The upload sets `Content-Type: text/html; charset=utf-8`, `Content-Disposition: inline` and `Cache-Control: private, no-store`, so a shared cache can't keep serving a revoked page.

### Upload, read back and revoke

Rust holds the secret key and makes every request to the host, as it does for Hermes's own secrets (ADR 0058). The webview never has the secret key. The webview hands Rust the page's bytes, title and expiry. Rust gives back the snapshot, or an error that says whether the page certainly wasn't sent.

- **Publish** is a `PUT` with `If-None-Match: *`, so a snapshot is never written over. AWS documents a `412` for a key that exists ("How to prevent object overwrites with conditional writes"). R2's presigned-URL page doesn't mention it, so the live run checks the owner's host. Rust then reads the object back, compares its SHA-256, and only then returns the link. A lost answer is settled by reading that key. Retrying with the same key and bytes can't make a second copy, and a `412` on retry means the first `PUT` arrived.
- **Copy link** in the list signs a fresh link that ends at the same `expires`. The owner can copy a link again without making a copy that lives longer.
- **Revoke** is a `DELETE`, then a read of the key. The list drops the snapshot only once the host says the key is gone. Otherwise it says Revoke may not have worked and keeps the row.
- **Settings → Snapshots** has the host card (with **Test**, which lists the prefix and writes nothing) and the list: title, created, expiry state, Copy link and Revoke. The list is read from the bucket each time the screen opens, so it shows snapshots published from any computer that uses the same bucket. An answer for host settings that have since changed is dropped.

### Expiry

A link lasts 1 hour, 1 day (the default) or 7 days. The maximum is 7 days because AWS and Cloudflare R2 accept a presigned link for at most 7 days (AWS, "Download and upload objects with presigned URLs"; Cloudflare, "R2 presigned URLs"). AWS also ends a link early when the key that signed it is deleted or deactivated, so on AWS rotating the key revokes every snapshot at once. Other hosts weren't checked. "Never expires" isn't offered, because that would need a public bucket and an expiry that only this app enforces. See Open questions.

The host stops honoring a link at its expiry, even with this app closed. The object stays in the bucket until the list next loads and deletes it, or until a lifecycle rule the owner sets on the bucket deletes it. This app never changes a bucket's settings.

### Attachments

A snapshot holds no attachment contents, as an export doesn't. Attachment names go in only when ticked. Publishing attachment files is a later stage. Each file would be one more object under `<prefix>/<id>/`, linked from the page with a link that ends at the same time, and Revoke would delete the whole prefix. The page alone meets #92's rule that revoking removes attachment access, because the page links to no attachment.

### What this doesn't touch

No snapshot request goes to Hermes, so a snapshot needs no Hermes version or capability (ADR 0044). Sending, recovery, Approvals, and connection and profile separation keep their own code paths. A snapshot is made from the Export dialog's copy of the chat, taken when the dialog opens, and its object is never written again. A message sent after Publish can't reach it.

## What is stored where

| Data | Where | Who can read it | Removed by |
|---|---|---|---|
| The page and its metadata | The owner's bucket | The owner's key, and anyone with a live link to that page only | Revoke, the list deleting an expired one, or the owner |
| Host settings, without the secret | `$XDG_CONFIG_HOME/net.l0cky12.hermes-chat/` | This computer | Clearing them in Settings → Snapshots |
| The secret key | The system keyring | This app's Rust side | Clearing them in Settings → Snapshots |
| A link someone saved, or the page they saved | Their computer | Them | Nobody. The confirm step says so. |

## How #92's checks would be verified

- **Redacted text is absent from the payload.** Unit tests check the bytes handed to the publish command: they equal the preview's `srcdoc` and don't contain any redacted text. A live run reads the object back from a real bucket and searches it for each redacted text.
- **Management authorization, expiry and revocation.** Rust tests run against a stand-in S3 built on axum, which the Rust tests already use. They cover a refused credential, a `412` on a repeated key, a lost answer settled by a read, a `DELETE` read back, and the list deleting an expired object. A live run against a real bucket checks a link before and after Revoke, and a 1-hour link after its hour. Attachment access holds because there are no attachment objects yet.
- **Malicious content, publication failure and later edits.** Fixtures with `<script>`, `<img onerror>`, `javascript:` links, `<iframe>`, `<base>`, `<meta>` and broken Markdown must render as text or as inert markup. A failed `PUT` must show "not published". A message sent after Publish must leave the object's SHA-256 unchanged.
- **Existing behavior.** The full suite, plus a verify-hermes-chat run that sends a message, takes an Approval, and switches profile after a Publish.
- **Documentation.** The README's storage table gains the rows above. The README says that no Hermes version is needed, and that the live runs used one host.

## Considered options

- **A publication route in Hermes (upstream `NousResearch/hermes-agent`).** Management routes such as `POST`, `GET` and `DELETE /api/snapshots` would sit behind the dashboard's sign-in. A separate read-only listener would serve only `/s/<token>` from `<HERMES_HOME>/snapshots/`, so the dashboard itself stays private, and `/api/status` would advertise it. This keeps data on the owner's server. But the work is out of this repository's reach, it goes against upstream's direction (see above), and the owner would still have to put that listener on the internet. A Hermes that adds it could become a second Snapshot host behind the same Rust boundary.
- **A dashboard plugin this app installs.** Rejected. Plugin routes always sit behind the sign-in.
- **A secret GitHub Gist.** This is the cheapest option. It needs one token with the `gist` scope, GitHub renders and cleans the Markdown, and deleting the gist revokes it. But it can't expire, it holds text only, a signed-in viewer can fork it before Revoke, and the data always goes to GitHub. It is the best alternative if the owner wants something today and doesn't need expiry.
- **A public bucket with unguessable keys and no signing.** The links would be shorter and could last any time. But expiry would happen only when this app runs, and a bucket listing setting the owner gets wrong would expose every snapshot.
- **This app serves the page, or a paste service hosts it.** The first is rejected in ADR 0062. The second can't be revoked, as Hermes's own debug share shows.
- **The AWS SDK for Rust.** Its dependency tree is heavy for five calls. A small signing crate such as `rusty-s3` with the existing `reqwest` is enough. That choice belongs to the implementation PR.

## Open questions for the owner

1. **Which Snapshot host?** The default is an S3-compatible bucket you name. The alternatives are a secret GitHub Gist (no expiry, data on GitHub), or waiting for a Hermes publication route upstream. Nothing is built until you answer.
2. **Is 7 days long enough?** Anything longer needs a public bucket, and an expiry that only this app enforces when it runs. The default is no, so 7 days is the maximum.
3. **Should attachment files ever be published?** The default is not in this stage. If yes, they become their own issue, with the prefix design above.
4. **Is a link that shows the bucket's host, the bucket and the access key's id acceptable?** A presigned link carries all three. The default is yes, with the README telling you to use a key limited to `GetObject`, `PutObject`, `DeleteObject` and `ListBucket` on the prefix.

## Consequences

- Sharing needs a bucket and a key that the owner sets up outside this app. Until then, Share snapshot offers only Save.
- A link names the host and the bucket, and works for anyone who has it until it ends. Every link ends within 7 days.
- Revoke is as good as the host's delete. A page someone already saved stays with them.
- The page is this app's HTML, so its safety is this app's to test. GitHub's Markdown cleaning would do that work under the Gist option.
