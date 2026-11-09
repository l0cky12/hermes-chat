# Saved connections have stable ids, keep their secrets and data apart, and one is in use at a time

Hermes Chat kept one sign-in, so reaching another Hermes server meant overwriting it (issue #88). Now it keeps a list of **saved connections** in one versioned local-storage document, `hermes-chat.connections` (`src/hermes/connections.ts`). Each has a random UUID as its id, a name, SSH or URL mode, its non-secret address (SSH target or URL) and dashboard username, and when it was added and last used. The id never changes, even when the address is edited, and everything else is keyed by it:

- **Keyring.** Each connection has its own two entries in the system keyring, `dashboard-password/<id>` and `extra-request-headers/<id>` (service `hermes-chat`). Rust builds the entry name from the id and refuses an id that isn't 8 to 64 lowercase letters, digits and dashes, so the webview can't name another entry (`saved_password::account`).
- **Local data.** Every per-connection storage key, and every per-connection scope inside a document, starts with the connection's scope: `["connection", <id>]`. That covers drafts, the outbox (Failed messages), queues, chat lists, Saved copies, the profile shown, pulled history, project membership (`hermes-chat.projects`), project defaults (`project-defaults.json`), the Outputs index, persona edits, inbox dismissals, tags and Saved filters (`tags.json`), snoozes, branch origins, the transcript imports record and which chats were started in a worktree. Display preferences kept per profile (the chat to reopen, the model pick) are keyed by `<id>\n<profile>`, and the Terminal's typed SSH target by `hermes-chat.terminal-target.<id>`. So two profiles called `default` on two servers never share a draft, a queue or a pick.

One connection is **in use** at a time (`current`), and only it has a socket: Rust still holds one connection. `current` is set only when the owner connects with a connection. Launch signs in to it, as before. Nothing ever picks a connection by its name, and when the one in use is removed none is in use: the sign-in screen offers the saved ones, most recently used first, and picks none.

## Migration

The first time the list is read, the single sign-in kept before (`hermes-chat.sign-in`) becomes one connection, named after its host, in use. It gets an id like any other, but it keeps the storage scope its data was already kept under (`[mode, target, username]` as they were) and the keyring entries it already had (`dashboard-password`, `extra-request-headers`). Nothing has to be moved, so a migration that is interrupted, or a storage that refuses the new document, can't lose a draft or a queued message. That scope is frozen in the record (`legacy.scope`), so it stays the connection's even when its address is edited. The old key is never read again once the document exists, and is deleted when that connection is removed.

## Secrets never go to another address

A password is saved together with the address it signed in with (`{"v":1,"for":[mode, target, username],"password":…}`), and is given back only while the connection still has that address. The migrated connection's plain password counts only while its address is the one it had when it was migrated. Extra request headers were already saved with their URL (ADR 0104). So a connection whose address was edited, and whose keyring then couldn't save the new secrets, never sends the old ones to the new address. The sign-in screen also clears a password filled in from the keyring once the address in the form changes, as `ServerFields` already does for header values. Redirects to another origin are refused for every dashboard request, including a password-bearing sign-in without extra headers. This extends ADR 0104's header protection to passwords.

## Switching

Switching closes the connection in use and signs in to the other with its saved password, Offline with what this computer saved for it if the server can't be reached, or the sign-in screen for it when no password is saved or the dashboard turns it down. The sign-in screen explains a failed sign-in the way Setup explains a failed test (`explainSignIn`), with what to fix, and offers the other saved connections.

Before switching away, the app asks if something is under way on the connection in use: an Approval waiting or a reply running in any of its profiles, as the inbox sees them (ADR 0019). Closing a connection doesn't stop anything on the server: Hermes keeps a running reply going, as it does when the profile switches, and an Approval waits until Hermes stops waiting. Queued messages wait on this computer; the queue is loaded paused when the owner comes back (ADR 0018). Switching back restores the connection's own profile, drafts, queues, model pick and the chat it had open.

Every sign-in, switch, sign-out and removal runs one after another (`src/hermes/serial.ts`). One that a newer one overtook stops at its next step and closes what it opened before the next one starts, so a quick A → B → A can't leave Rust holding B's connection under A's screen. Requests a closed connection's `Hermes` would still send are refused, as on sign-out (ADR 0014).

## Adding, editing, testing and removing

Add connection and Edit go through Setup's own steps (ADR 0009): the connection is tested, then saved, and only then connected to; the one in use carries on until then, and is put back if the new one fails after all. A new connection is given its id before its test, but is saved only once it signed in. Settings → General lists every connection with its mode, address, username and when it was last used; each can be renamed in place, tested with its saved sign-in while the one in use carries on, edited, connected to, or removed.

Removing a connection asks first, listing what goes from this computer and saying the server keeps everything. It deletes the connection's two keyring entries first; if the keyring refuses, nothing else is removed, so no entry is left behind under an id nothing names. Then it signs out of the connection if it is in use, deletes every key and scope under its scope (`forgetConnection.ts`), and drops it from the list. Cleanup holds the screen busy; if it fails after closing the transport, sign-in explains the failure and offers retry rather than leaving a closed chat screen usable. Persona cleanup waits for saves already under way and clears its in-memory copies too. Screenshots no message needs any more are let go by the existing outbox sync. Nothing is sent to Hermes.

## Considered options

- **Re-key every existing storage entry under the new id at migration.** Rejected: dozens of keys and two documents (one a file shared between app instances) would have to move together, and a crash or a full storage halfway would split one connection's data between two scopes. Freezing the old scope in the record gives the same stable identity without moving anything.
- **Keep connections keyed by their address, as before.** Rejected: editing an address would orphan its drafts and queues, and two connections to the same address (say, two usernames, or the same server before and after a gateway) would share them.
- **Pick a connection by name when the one in use goes, or at launch.** Rejected: names aren't unique, and a wrong pick would sign in, with that connection's secrets, to a server the owner didn't choose.
- **Backups name the data by connection id.** Rejected: a backup is restored on another computer, whose connection to the same server has another id. A backup names each place by its address and profile, as before (ADR 0038). On export, a scope under a connection's id is read as that connection's address; on restore, records go under the id of the connection in use (`backup.ts` `placesOf`, `Target.parts`). Data under an id no saved connection has is left out.
- **Keep every connection's socket open for monitoring.** Out of scope here: Rust holds one connection. Concurrent monitoring is a separate feature.

## Consequences

- Connections don't sync between computers. Each computer has its own list, keyring entries and local data.
- A corrupt `hermes-chat.connections` document is read as empty, then migrated again from the old sign-in if that is still there; the other connections' keyring entries are then left under ids nothing names, and can be deleted in the desktop's keyring manager (Seahorse, KWalletManager).
- At most 50 connections. Names are up to 60 characters and needn't be unique; the address always shows beside the name.
- Running work is named only as the inbox sees it: replies the dashboard's own process runs, and Approvals on the profile shown or found by the inbox's checks. A reply running in the CLI or a gateway on that server isn't named, though Hermes keeps it going all the same.
- Older versions of Hermes Chat read only `hermes-chat.sign-in` and the old keyring entries. Going back to one finds the migrated connection's address as it was at migration time, and asks for its password once this version has saved it again in the new form.
