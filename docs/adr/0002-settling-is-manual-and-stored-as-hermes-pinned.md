# Settling is manual, and Active is stored as Hermes's "pinned" flag

Every chat is either Active or Settled. Only the owner moves it: settling and unsettling are manual, and nothing settles on its own. Starting a chat in this app or sending a message in one makes it Active. Imported chats start Settled, and a new message from another platform leaves them there, so other platforms can't push chats back into view. The state is stored on the server as the session's `pinned` flag (pinned = Active, unpinned = Settled), set with `PATCH /api/sessions/{id}`. That way it syncs between the owner's desktop and laptop, and imported chats are Settled by default without anything being written for them.

## Considered options

- **Local-only state in this app.** Simplest, and invisible to other Hermes clients, but each machine would keep its own Active list. Rejected once it was clear the owner switches between two machines.
- **Hermes's `archived` flag as Settled.** Rejected: archiving hides sessions in the official app and the dashboard, and because imported chats start Settled, every imported chat would be archived on the server.

## Consequences

- Settle and Undo write the flag straight away, one write at a time per chat, so a quick Undo leaves the server where the owner left the chat. A write that fails is reported and tried again on the next refresh, and the chat stays where the owner put it.
- Pinning or unpinning a chat in the official Hermes app changes whether it is Active here, and the other way round. On first launch, chats the owner had already pinned elsewhere show up as Active.
- The unread dot uses Hermes's shared unread flag (`last_read_at`). Opening a chat on either machine clears it everywhere, the same way the official app does.
- Replying to an imported Telegram/Discord chat makes it Active like any other chat. When the server will also post Hermes's answer in the original Telegram or Discord chat, a note above the composer says so. That happens only on the canonical protocol. On the legacy protocol this app speaks, replies stay in Hermes clients, so the note doesn't show yet (`Hermes.alsoPostsIn`). This routing comes from reading the source and hasn't been tested on the live server (no Telegram or Discord adapter was connected on 2026-10-31).
- Both flags are stored per profile, because each Hermes profile has its own chat database.
