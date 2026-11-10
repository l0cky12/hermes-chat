# Idle compaction is this computer's setting and compacts once per measure

The owner wants a long chat compacted on its own once they've left it, rather than paying for its whole context on the next message. Settings → Model gains **Idle compaction**: a switch, off by default, a mark for how full the context window must be (50–90%, 70% by default), and how long the chat must have been idle (5 minutes to 2 hours, 15 minutes by default). When a chat is due, the app has Hermes compact it with `session.compress`, as **Compact now** does (ADR 0025).

A chat is due when all of these hold:

- the switch is on, the app is connected, and this connection's Hermes hasn't answered that it can't compact (`-32601`);
- the chat is open on Hermes on this connection (it has a runtime session), and Hermes reports a compactor for it (`usage.compressions` is present);
- Hermes has measured its context window, and the measure is at the mark or past it;
- the app hasn't already compacted the chat, or tried to, at this same measure;
- no reply is running or stopping, it isn't loading, no message is sending, and no Approval waits on the owner;
- nothing has happened in it for the idle time.

"Something happening" is a change in what the app sees of the chat: its runtime session, a reply starting or ending, it loading, its number of items, or its last-activity time. An idle stretch starts at that change, or when the app first sees the chat, so opening an old chat or launching the app starts the clock and never compacts at once.

The app looks for a due chat every 30 seconds and compacts one at a time, the one idle longest first. Each measure is compacted at most once, whatever Hermes answers. The meter keeps Hermes's last measure until the next reply, since `session.compress` doesn't send a new one, so without this the same chat would be compacted again on every check. Keying it to the idle stretch instead isn't enough: Hermes may move the chat's last activity as it stores the compaction, and the list's next sync would then start a new idle stretch with the same stale measure, compacting the chat again every idle period. A compaction that worked shows a toast with Hermes's own counts and its token estimate, labelled as an estimate. One that failed says why, once. A compaction that found nothing to do, or that Hermes was already running, says nothing.

A message sent while a compaction waits on Hermes goes once Hermes has answered it, from Send, the queue, Retry or a voice conversation alike. A second compaction asked meanwhile, by Compact now or the idle check, is answered as busy without asking Hermes. Compacting while a message is going is refused, as before.

## Why idle

The provider's prompt cache lasts minutes. A chat left idle past that pays for its whole context, uncached, on the next message, whether or not it is compacted. Compacting then costs one call to the profile's Compression model and makes that next message, and the ones after, cheaper. Compacting a chat in active use would throw a warm cache away and change what the model reads mid-conversation. Hermes's own compaction when the window fills during a reply stays as it is; Idle compaction is on top of it, for the chats the owner has stepped away from.

## Considered options

- **Hermes's `compression.threshold` in the profile's config.** Rejected for this: it triggers during a reply, when the window fills, not when a chat is idle, and it is Hermes's setting for every client. Changing it from here is a separate question.
- **Compact chats not open in this app, by resuming them.** Rejected: Hermes measures a chat only once it is loaded, so the app would have to resume every long chat to learn which are full, building an agent on the server for each. Only chats the owner opened here, which Hermes has measured, are compacted.
- **Count the chat's lifetime token usage instead of the window.** Rejected: usage counts every call, cache reads included (ADR 0008), and says nothing about what the next call will read. The window measure is the one compaction changes.
- **Keep it per connection or profile, or on Hermes.** Rejected for now: it is how this app behaves while it runs, like the other launch and display settings, so it lives in the one prefs document on this computer (`uiPrefs.ts`). Hermes has no place for a client's setting.
- **Ask before each compaction.** Rejected: the owner is away by definition. The switch is the consent; the toast says what happened, and the Compactions tab lists it as it lists every compaction.

## Consequences

- Off until the owner turns it on, since each compaction is a model call.
- It runs only while the app is open and connected, and only for the profile shown.
- After a compaction the meter still shows the measure from before until the next reply, as after Compact now. The context inspector reads the window and the Compactions tab again as it already does.
- A chat compacted while it is on screen changes nothing on screen; every message stays in the transcript (ADR 0025).
