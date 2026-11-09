# Project membership syncs through a proposed Hermes store, and stays on this computer until Hermes has one

ADR 0105 kept which chats are in each project on this computer, because Hermes had nowhere to keep it. The result: a chat can be in different projects on different computers (#84). Before writing anything, I checked again whether Hermes now has a store for this. It doesn't:

- The deployed `bf0203a` and upstream `NousResearch/hermes-agent` at `9302ba9e` (2026-11-03) were checked. `projects.db` has `projects`, `project_folders`, `project_meta` and `discovered_repos`, and no table linking a project to a session.
- `projects.tree` and `projects.project_sessions` derive a project's sessions from each session's working folder (`project_for_path`), the grouping ADR 0105 rejected.
- `PATCH /api/sessions/{id}` takes only `title`, `archived`, `hidden`, `pinned` and `unread`.

No Hermes method stores this relationship. A project's description, slug or colour could hold a hidden list, but every other Hermes client shows or uses those fields. An app-owned file in the owner's server folders could hold one too, but it would sit in the owner's files, the agent could read and change it, and no Hermes client would know what it is. Both were rejected. Instead, this app speaks a small contract that Hermes would need to add, and it uses the contract only when Hermes answers it.

## The contract Hermes needs (proposed, not in any Hermes yet)

It is legacy JSON-RPC on `/api/ws`, like `projects.*`, and it is profile-scoped because each profile has its own `projects.db` and `state.db`.

```sql
-- in projects.db
CREATE TABLE project_sessions (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,          -- the stored session id, never a title
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id)
);
CREATE TABLE project_session_revs (   -- the revision of each link's last change, removals included
  project_id TEXT NOT NULL, session_id TEXT NOT NULL, rev INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id)
);
CREATE TABLE project_session_ops (    -- first answer to each op id, for retries; may be pruned after 30 days
  op_id TEXT PRIMARY KEY, result TEXT NOT NULL, at INTEGER NOT NULL
);
-- project_meta key 'membership_rev': bumped by every write
```

- **`projects.membership.list {profile}`** → `{revision, links: [{project_id, session_id, added_at}]}`. These are all of the profile's links. A profile has hundreds of them, not millions, so the call isn't paged.
- **`projects.membership.apply {profile, ops: [{op_id, project_id, session_id, member, base_revision}]}`** (at most 200 ops) → `{revision, results: [{op_id, status, member, rev}]}`. The ops run in order, in one write transaction. For each op:
  1. An `op_id` already recorded is answered with its recorded result, and nothing is written.
  2. A project the profile doesn't have answers `no_project`.
  3. Adding a session the profile's `state.db` doesn't have answers `no_session`.
  4. When the link already is as asked (`member`), the answer is `unchanged`.
  5. When the link's `rev` is greater than `base_revision`, the answer is `conflict` with what the server has. Another client changed this link after the caller last read, and it disagrees with the caller.
  6. Otherwise the link is written, `membership_rev` is bumped, the link's `rev` becomes the new revision, and the answer is `applied`.

  `member` is the link's state after the op, and `rev` is its last-change revision.
- **Cascades:** `projects.delete` removes the project's links (`ON DELETE CASCADE`), and nothing else. Deleting a session (`DELETE /api/sessions/{id}`, `prune`) removes its links.
- **Errors:** the same as `projects.*`: 4064 for an unknown profile, 5063 for a bad argument (such as more than 200 ops), and 5061 for anything else. A server without the methods answers -32601.
- **Optional:** emit `projects.changed` after a membership write, so clients can read again without waiting for a refresh.
- Public share links never include membership.

## How the app uses it

- **Is it there?** After each read of the projects (on connect, reconnect, and opening the switcher), the app calls `projects.membership.list`. A -32601 answer means this Hermes has no store. Membership then stays on this computer, as in ADR 0105, and the project screen says so. Every Hermes today answers this way.
- **The move.** The first time a Hermes answers, the app compares this computer's links with Hermes's and shows a preview before sending anything. The preview has four groups:
  - links that will be sent;
  - links already on Hermes, which are left alone, so Hermes keeps one record of each;
  - links put there by another computer, which are kept;
  - links to a project Hermes no longer has, which are not sent.

  If the owner chooses Move, the app first copies this computer's grouping as it is at that moment into a recovery copy (`recovery`, never overwritten by a later move). The copy includes the links set aside for deleted projects. Then it marks the scope moved (`synced: {v: 1}`), makes Hermes's links the ones it keeps, and turns the links Hermes lacks into pending add operations. If there's nothing to send, the move happens without a preview. **Not now** is stored (`postponed`). It holds across restarts, and even once another computer has put every link on Hermes. Membership stays local until the owner chooses Move on the project screen.
- **Links to deleted projects before the move.** Until the move, a link to a project Hermes no longer lists is set aside (`setAside`) instead of dropped. This happens even when the membership check fails or the app is restarted. Set-aside links are never shown in the list, never sent, always listed in the preview as not sent, and kept in the recovery copy. (ADR 0105 forgot them. This keeps them, invisibly, so a move never loses something the owner had.)
- **After the move.** `chats` holds Hermes's links as last read, and `revision` holds that read's revision. Each change the owner makes is a pending operation (`pending`), stored in the same document as before. Its `base` is the revision the owner was looking at. The list shows Hermes's links with the pending operations laid over them, so a change shows at once. A change that is undone before it is sent cancels out. Pending operations are sent in order, at most 200 at a time, after every change and on every connect. Then the app reads Hermes's links back, and they replace the ones kept here. Another computer's adds and removes therefore show after a refresh or reconnect, and links nobody changed are left as they were.
- **Offline.** A change made while Hermes can't be reached stays pending, survives a restart, and is shown as waiting: on the project screen, in the chat menu ("waiting to sync"), and as a count. It goes at the next connect.
- **Conflict policy.** Ops are per link, with set semantics, so two computers that change the same link the same way never conflict. A conflict happens only when another client changed that link after this computer's `base` and the result disagrees. Hermes's state is then the one shown, and the switcher gets a dot. The dialog shows both versions, and the owner picks:
  - **Use Hermes's** drops the change.
  - **Keep mine** sends it again as a new op over the conflict's revision.

  A newer change to the same link settles the conflict the same way. This computer's own quick changes, such as an add followed by a remove while the add is still on its way, are chained so they never count as a conflict.
- **Retries.** Every op has a unique id. An answer lost to a dropped connection is retried with the same id, and Hermes answers it from its record instead of applying it again over a newer change.
- **Refusals.** A change for a deleted project or a deleted chat is answered `no_project` or `no_session`. It is dropped, and the dialog lists it under "Not kept".
- **Deleting a project** removes its links on Hermes (the cascade) and drops its pending operations here. Its chats, and its folders on the server, stay.
- **A Hermes that loses the store** after the move: the app shows the links it last read, keeps changes pending, and says this Hermes no longer answers.
- **Scope.** Everything is kept per connection and profile (`projectScope`), as before. A store is made per scope, and its requests are queued, so an answer for another profile or connection never replaces the one shown.

## Consequences

- Until Hermes ships this contract, nothing changes for the owner. Membership stays on each computer, and the project screen now says that this Hermes doesn't keep it. Sync is verified only against the repo's `FakeHermes`, which implements the contract as written here. No real Hermes has been tested with it.
- The local document moves to version 2 (`hermes-chat.projects`). Version 1 scopes read as before. An older app reading a moved scope would treat Hermes's links as its own, and its edits there would be replaced at this app's next sync.
- "Clear local cache" still doesn't touch membership, pending changes, or the recovery copy.
- Which project the list shows stays on this computer, as before (ADR 0105).
