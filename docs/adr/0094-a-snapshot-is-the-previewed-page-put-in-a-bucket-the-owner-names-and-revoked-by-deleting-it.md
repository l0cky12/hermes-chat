# A snapshot is the previewed page, put in a bucket the owner names, and revoked by deleting it

**Status: proposed. Nothing is built. Waiting on the owner's answers to "Open questions", the first above all.**

Issue #92 asks for a copy of a chat that other people can open. The owner picks what goes in, likely secrets are redacted, and Publish is explicit. Each copy has its own link, an optional expiry and Revoke, and later messages in the chat never reach it. ADR 0076 built the private part: the Export dialog picks the messages, flags and redacts likely secrets, and previews the exact file. It left one question for the owner, which is where a published copy lives. This ADR answers that question with a default, and decides everything that doesn't depend on the answer.

A **Snapshot** is that published copy. It is one immutable page, made from the Export dialog's file, held by a **Snapshot host**, and reached by a link that ends when the snapshot expires or is revoked. A snapshot is not a chat's web link (ADR 0062). A web link is a live view for someone who can sign in to the dashboard. A snapshot is a fixed copy for people who can't.

## Why Hermes can't host it

Read in the local Hermes source (`~/.hermes/hermes-agent` at `b200f5bc`, 2026-11-03, which contains the `f0d94882` that ADR 0076 read) on 2026-11-07. Nothing below was run against a live dashboard.

- **Hermes serves no chat content to anyone signed out.** The sign-in gate lets through only sign-in pages, static assets and a fixed list of status and config reads (`_GATE_PUBLIC_PREFIXES` in `hermes_cli/dashboard_auth/middleware.py`, `PUBLIC_API_PATHS` in `hermes_cli/dashboard_auth/public_paths.py`). Every file route is behind the gate too, and its download tickets last 60 seconds (`hermes_cli/web_server_file_tickets.py`).
- **A dashboard plugin can't serve it either.** A plugin's API routes are mounted under `/api/plugins/<name>/`, and the gate covers them as it covers every `/api/` path. Nothing in a plugin's manifest exempts them. A plugin's static files, `.html` among them, are served without a sign-in from `/dashboard-plugins/` (`serve_plugin_asset` in `hermes_cli/web_routers/dashboard_ui.py`, a prefix in `_GATE_PUBLIC_PREFIXES`). Snapshots kept there would still be on the dashboard, which #92 says not to expose. A static file also has no expiry and no revoke the owner could manage from here. So the third option in ADR 0062 doesn't help here.
- **Upstream is closing public access, not opening it.** `should_require_auth` (`hermes_cli/web_server_boundary.py`) ignores `--insecure` "since the June 2026 hermes-0day campaign" and treats LAN addresses as public.
- **Most connections can't be reached by other people anyway.** A connection reaches its dashboard through SSH, Tailscale, a LAN or a web address (ADR 0056). For a page on the dashboard to reach other people, the owner would have to expose the dashboard to the internet. Issue #92 rules that out ("do not expose the private dashboard").

So a snapshot needs a host that is on the internet, that is separate from the dashboard, and that this app can write to and delete from with the owner's own credential.

## Proposal

**The default Snapshot host is an S3-compatible bucket the owner names.** That means Amazon S3, Cloudflare R2, Backblaze B2, or a self-hosted MinIO. A host must answer `ListObjectVersions` and honor `If-None-Match: *` on `PutObject`, because Publish and Revoke below rely on both. Test checks the first. Only a write can check the second, so the first live run on the owner's host checks it. Garage doesn't qualify, because its compatibility page marks object versioning and `ListObjectVersions` as missing (Garage, "S3 Compatibility status"). The bucket stays private. Each snapshot is one object, and its link is a presigned `GET` URL that the host refuses after the expiry. One protocol covers hosted and self-hosted stores, and the host, not this app, enforces the expiry.

### The data shape

A snapshot is one object, `<prefix>/<id>.html`. The object's metadata is the management list's record, so nothing about a snapshot is kept on this computer:

| Field | Where it lives | What it is |
|---|---|---|
| `id` | The object key | 26 characters of base32 from 128 random bits, made before the upload, so a retry writes the same key. |
| `title` | `x-amz-meta-title`, percent-encoded | The title line as the page has it, after redaction. It is cut so that the object's metadata stays under 2 KB, the S3 limit that counts the UTF-8 bytes of every metadata key and value. Encoded, one character can take 12 bytes. The list decodes it before showing it. |
| `created`, `expires` | `x-amz-meta-created`, `x-amz-meta-expires` | UTC times. `expires` is always set (see Expiry). |
| `sha256` | `x-amz-meta-sha256` | The SHA-256 of the page's bytes as published. |
| The page | The object's body | The HTML the owner saw in the preview, byte for byte. |

In the app the record is a typed `Snapshot` with one state, never a set of booleans:

- **Live.** The link works until `expires`.
- **Expired.** The host refuses the link. The list deletes the object as it loads, so the owner sees this state only when that delete failed. The row then offers Revoke.
- **Changed.** The body's SHA-256 no longer matches `sha256`, so something other than this app wrote it. The list offers Revoke only.

A revoked snapshot has no state. No version of its key is left in the bucket, so it is gone from the list.

The host settings are the endpoint, region, bucket, prefix (`hermes-chat-snapshots/` by default) and the access key's id. They are kept per computer, in one keyring entry with the secret key, as ADR 0058 keeps a token with the addresses it was entered for. Rust uses the secret only with the endpoint, region, bucket and key id saved beside it. A change to any of them needs the secret typed again, so a secret is never sent to an edited endpoint. The webview learns the settings, never the secret. Snapshots go to one bucket whatever connection or profile they came from.

### Sharing a snapshot

1. **Share snapshot…** in the chat header's More menu opens the Export dialog (ADR 0076) with Publish… in place of Save…. Every pick works as it does for an export. One default changes: Hermes's thinking starts unticked, as tool calls and attachment names already do.
2. **Publish… opens a confirm step.** It names the destination before anything leaves this computer: the host's address, the bucket and the prefix. It shows the expiry, the page itself, and two warnings. Detection can miss a secret. Anyone with the link can read the page until it ends, and a copy someone saves can't be recalled.
3. **The preview is the page.** The confirm step shows the exact bytes to upload in ADR 0007's frame for HTML: `srcdoc`, `sandbox=""` with no tokens, and `referrerpolicy="no-referrer"`. Tests parse the frame's `srcdoc` attribute and compare it with the bytes handed to Rust.
4. **Publish uploads, and only Publish does.** With no host set, the dialog says so, links to Settings → Snapshots, and still offers Save as a file.

### The page

The webview builds the page from the Export dialog's Markdown. It uses the transcript's own Markdown pipeline (`src/ui/markdownPipeline.ts`) rendered to static markup.

- Raw HTML in a message stays text. It is never markup.
- Links keep only absolute `https:`, `http:` and `mailto:` addresses, with `rel="noopener noreferrer"`. Any other link, a protocol-relative `//host` and a `data:` address among them, stays text. `markdownPipeline.ts` doesn't filter schemes today, and react-markdown's default leaves `//host` alone, so the page needs its own filter. Images aren't loaded. Each shows as its alt text and address, so a viewer's browser fetches nothing a message names.
- The page has no script and loads nothing. The first elements in its `<head>`, before the title and any text from the chat, are `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">` and `<meta name="referrer" content="no-referrer">`. The second keeps a viewer's browser from sending the presigned link as a `Referer` when a link in the page is followed. The stylesheet is inline.
- The upload sets `Content-Type: text/html; charset=utf-8`, `Content-Disposition: inline` and `Cache-Control: private, no-store`, so a shared cache can't keep serving a revoked page.

### Upload, read back and revoke

Rust holds the secret key and makes every request to the host, as it does for Hermes's own secrets (ADR 0058). The webview never has the secret key. The webview hands Rust the page's bytes, title and expiry. Rust gives back the snapshot, or an error that says whether the page certainly wasn't sent.

- **Publish** is a `PUT` with `If-None-Match: *`, so a snapshot is never written over. AWS and R2 both answer `412` for a key that exists (AWS, "How to prevent object overwrites with conditional writes"; Cloudflare, "Extensions"). Rust then reads the object back and returns the link only when the body's SHA-256 matches the bytes it uploaded. That match is the only way to Live.
- **A lost answer is settled by sending the same `PUT` again**, never by a read alone. R2 says a `NoSuchKey` read doesn't rule out an earlier write that is still in flight (Cloudflare, "Consistency"). A `412` on the second `PUT` means the first one committed. A success means it hadn't, and this one did. Either way the body's SHA-256 is checked next. "Not published" is shown only after the host refused the `PUT` outright, such as a `403`, and a version listing shows no object for the key. Anything else, such as a failed read, a body that differs, or a `404` with `x-amz-delete-marker: true`, means the page may have been sent, and Rust says so.
- **Links name the version.** Where the `PUT` returns a version id, every link is signed for that version, so a later write to the key isn't what an existing link returns.
- **Copy link** in the list signs a fresh link that ends at the same `expires`. The owner can copy a link again without making a copy that lives longer.
- **Revoke** deletes every version and delete marker of the key, then lists the key's versions again. A plain `DELETE` isn't enough. Backblaze B2 versions every bucket, and on B2, or on an S3 bucket with versioning on, a `DELETE` without a version id only adds a delete marker or hides the file, while older versions keep the page. A `GET` that then fails proves nothing about those versions. The list drops the snapshot only once no version or delete marker of the key is left. Otherwise it says Revoke may not have worked and keeps the row.
- **Settings → Snapshots** has the host card (with **Test**, which lists the prefix's versions and writes nothing) and the list: title, created, expiry state, Copy link and Revoke. The list is a complete `ListObjectVersions` of the prefix, read each time the screen opens, with every continuation token followed. A current-object listing would hide a key that has only older versions or delete markers left, and the page would stay in the bucket with no row to revoke it from. Such a key shows as a Revoke that didn't finish. The list also shows snapshots published from any computer that uses the same bucket. An answer for host settings that have since changed is dropped.

### Expiry

A link lasts 1 hour, 1 day (the default) or 7 days. The maximum is 7 days because AWS and Cloudflare R2 accept a presigned S3 link for at most 7 days (AWS, "Download and upload objects with presigned URLs"; Cloudflare, "R2 presigned URLs"). AWS also ends a link early when the key that signed it is deleted or deactivated, so on AWS rotating the key revokes every snapshot at once. Other hosts weren't checked. "Never expires" and anything past 7 days aren't offered. Either would need another way to sign links, such as CloudFront signed URLs in front of a private bucket, or a public bucket. See Open questions.

The host stops honoring a link at its expiry, even with this app closed. The object stays in the bucket until the list next loads and deletes every version of it, as Revoke does, or until a lifecycle rule the owner sets on the bucket deletes it. On a versioned bucket the rule must also expire older versions, because expiring the current one only adds a delete marker or hides the file. This app never changes a bucket's settings.

### Attachments

A snapshot holds no attachment contents, as an export doesn't. Attachment names go in only when ticked. Publishing attachment files is a later stage. Each file would be one more object under `<prefix>/<id>/`, linked from the page with a link that ends at the same time, and Revoke would delete the whole prefix. The page alone meets #92's rule that revoking removes attachment access, because the page links to no attachment.

### What this doesn't touch

No snapshot request goes to Hermes, so a snapshot needs no Hermes version or capability (ADR 0044). Sending, recovery, Approvals, and connection and profile separation keep their own code paths. A snapshot is made from the Export dialog's copy of the chat, taken when the dialog opens, and its object is never written again. A message sent after Publish can't reach it.

## What is stored where

| Data | Where | Who can read it | Removed by |
|---|---|---|---|
| The page and its metadata | The owner's bucket | The owner's key, and anyone with a live link to that page only | Revoke, the list deleting an expired one, or the owner |
| Host settings and the secret key, in one entry | The system keyring | This app's Rust side. The webview gets the settings, never the secret. | Clearing them in Settings → Snapshots |
| A link someone saved, or the page they saved | Their computer | Them | Nobody. The confirm step says so. |

## How #92's checks would be verified

- **Redacted text is absent from the payload.** Unit tests check the bytes handed to the publish command: they equal the preview's `srcdoc` and don't contain any redacted text. A live run reads the object back from a real bucket and searches it for each redacted text.
- **Management authorization, expiry and revocation.** Rust tests run against a stand-in S3 built on axum, which the Rust tests already use. They cover a refused credential, a `412` on a repeated key, a lost answer settled by sending the `PUT` again, a `404` with a delete marker, and the list deleting an expired object. They also cover a secret refused after the endpoint, region, bucket, prefix or key id changes. Revoke is tested on a versioned key, where a plain `GET` already fails but an older version still holds the page, and on a listing split by continuation tokens. A live run against a real bucket checks a link before and after Revoke, lists the key's versions after Revoke, and checks a 1-hour link after its hour. Attachment access holds because there are no attachment objects yet.
- **Malicious content, publication failure and later edits.** Fixtures with `<script>`, `<img onerror>`, `javascript:`, `data:` and protocol-relative `//host` links, `<iframe>`, `<base>`, `<meta>` and broken Markdown must render as text or as inert markup. A test checks that the two `<meta>` elements come first in `<head>`. A `PUT` refused with the key still absent must show "not published". A lost answer, a failed read and a body that differs must each show that the page may have been sent. A message sent after Publish must leave the object's SHA-256 unchanged.
- **Existing behavior.** The full suite, plus a verify-hermes-chat run that sends a message, takes an Approval, and switches profile after a Publish. The snapshot stays in the list after the switch, because one bucket serves every profile and connection.
- **Documentation.** The README's storage table gains the rows above. The README says that no Hermes version is needed, that the live runs used one host, and which permissions the key needs (Open question 4). `GLOSSARY.md` gains Snapshot and Snapshot host. Its Export entry says that a snapshot uploads the file it previews, and its avoid line stops saying that snapshots wait for a hosting service.

## Considered options

- **A publication route in Hermes (upstream `NousResearch/hermes-agent`).** Management routes such as `POST`, `GET` and `DELETE /api/snapshots` would sit behind the dashboard's sign-in. A separate read-only listener would serve only `/s/<token>` from `<HERMES_HOME>/snapshots/`, so the dashboard itself stays private, and `/api/status` would advertise it. This keeps data on the owner's server. But the work is out of this repository's reach, it goes against upstream's direction (see above), and the owner would still have to put that listener on the internet. A Hermes that adds it could become a second Snapshot host behind the same Rust boundary.
- **A dashboard plugin this app installs.** Rejected. Its API routes sit behind the sign-in. Its static files are public, but they are on the dashboard, with no expiry and no revoke from here (see above).
- **A secret GitHub Gist.** This is the cheapest option. It needs one token with the `gist` scope, GitHub renders and cleans the Markdown, and deleting the gist revokes it. But it can't expire, it holds text only, a signed-in viewer can fork it before Revoke, and the data always goes to GitHub. It is the best alternative if the owner wants something today and doesn't need expiry.
- **A public bucket with unguessable keys and no signing.** The links would be shorter and could last any time. But expiry would happen only when this app runs, and a bucket listing setting the owner gets wrong would expose every snapshot.
- **This app serves the page.** Rejected in ADR 0062.
- **A paste service.** Hermes's debug share (`hermes_cli/debug.py`) uploads to paste.rs, deletes each paste after 6 hours, and falls back to dpaste.com, whose pastes it can't delete. A paste is public text with no list for the owner to manage, and the fallback can't be revoked at all.
- **The AWS SDK for Rust.** Its dependency tree is heavy for the handful of S3 calls this needs. A small signing crate such as `rusty-s3` with the existing `reqwest` is enough. That choice belongs to the implementation PR.

## Open questions for the owner

1. **Which Snapshot host?** The default is an S3-compatible bucket you name. The alternatives are a secret GitHub Gist (no expiry, data on GitHub), or waiting for a Hermes publication route upstream. Nothing is built until you answer.
2. **Is 7 days long enough?** It is the limit on a presigned S3 link. Anything longer needs another signer, such as CloudFront signed URLs, or a public bucket. The default is yes: 7 days is the maximum.
3. **Should attachment files ever be published?** The default is not in this stage. If yes, they become their own issue, with the prefix design above.
4. **Is a link that shows the bucket's host, the bucket and the access key's id acceptable?** A presigned link carries all three. The default is yes, with the README telling you to use a key limited to the prefix, with `GetObject`, `PutObject`, `DeleteObject`, `DeleteObjectVersion`, `ListBucket` and `ListBucketVersions`. Revoke needs the two version permissions.

## Consequences

- Sharing needs a bucket and a key that the owner sets up outside this app. Until then, Share snapshot offers only Save.
- A link names the host and the bucket, and works for anyone who has it until it ends. Every link ends within 7 days.
- Revoke is as good as the host's delete of every version. A page someone already saved stays with them.
- The page is this app's HTML, so its safety is this app's to test. GitHub's Markdown cleaning would do that work under the Gist option.
