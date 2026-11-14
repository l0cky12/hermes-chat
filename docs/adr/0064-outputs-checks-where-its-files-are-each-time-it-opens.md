# Outputs checks where its files are each time it opens

> **Superseded by [ADR 0164](0164-the-outputs-screen-is-removed-and-artifacts-open-from-the-preview.md)** (#570). The Outputs screen is gone, so nothing checks where its files are.

Issue #223: on the Outputs page, Edit on `hermes-verify-install.sh` failed with "can't be edited here: That file isn't on the server, or is gone now". The issue named four possible causes. Checked against the real Hermes (v0.22.6, default profile) and its stored rows:
- **Wrong machine:** no. The profile's terminal is `local`, so the tools and the dashboard share one disk. Preview and Edit read a tool's file through `/api/fs/*` with the profile, and a `host` file through the managed files routes, as the availability check does (ADR 0016, ADR 0029).
- **Wrong profile:** no. The chat is in the default profile, and every Outputs request names the profile of the index.
- **Path form:** no. `write_file`'s `args.path`, `resolved_path` and `files_modified` were all `/home/liam/.hermes/cache/scratch/hermes-verify-install.sh`.
- **The file is really gone:** yes. Right after its last `write_file`, the chat's own `terminal` call ran `bash …/hermes-verify-install.sh; rc=$?; rm -f …/hermes-verify-install.sh`. `GET /api/fs/read-data-url` then answered `404 {"detail":"File not found"}`, which was correct.

The bug was the app's. ADR 0016 checked where files are only when the owner pressed Refresh or added a file. Until then a row said "Not checked", and Edit and Preview stayed on for a file that was gone.

**Decision:** opening Outputs, or changing its scope, now runs what Refresh runs: it reads the chats that changed, then checks every file shown, within ADR 0016's limit of 40 folders. A file that is gone shows Missing before anything is clicked. Its Edit and Preview are off, and say why, ending "Check again, or look in its folder" (the row's Check again button, and its folder button, which opens that folder in Server files). Two rules make it safe to run without asking (`OutputsIndex.refresh`). A refresh that a newer one, or a profile switch, replaced while it read doesn't check, so it can't cancel the newer one's check. And a read that failed isn't followed by a check, so its error stays on screen. Until the check answers for a row, the row says "Checking…" and its Edit and Preview are off, so a slow connection can't open a file on a stale answer. An unsaved edit still opens. A row past the 40-folder limit gets no answer, and opens again once the refresh ends.

**Considered:** checking only when Edit or Preview is clicked. Rejected: the row would still claim nothing until the click, and the issue asks for Missing before it.

**Consequences:** each opening lists up to 40 folders, one request per folder. A file deleted while Outputs is open still shows its last state until Refresh, or until Outputs opens again.
