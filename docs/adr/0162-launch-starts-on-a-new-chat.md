# Launch starts on a new chat

> **Accepted.** It changes the default of "Reopen last chat on launch" (commit `0accfac1`, which had no ADR of its own) from on to off.

Since `0accfac1`, the app opened each profile's last chat at launch, and Settings → General → Launch, tray & updates could turn that off. The owner reported that this affects real users: the app opens on the chat they were in before, not a new one. The owner asked for launch to open a new chat.

## Decisions

- **`reopenLastChat` is off by default.** Launch shows the New chat pane. The switch stays in Settings, unchanged, for an owner who wants the old behavior.
- **Every saved preference is moved to off once** (preferences version 5). Each write of the preferences stores every field, so a saved `reopenLastChat: true` can't tell an owner who turned it on from one who never looked. Moving everyone to off is what the owner asked for. An owner who wants it back turns it on again, and from version 5 that choice is kept.
- **The chat on screen is still recorded** (`lastOpenChat`) while reopening is off, as before, so turning the switch on reopens the chat left last time, not the one from before the switch was off.

## Considered options

- **Only change the default.** Every existing install has `reopenLastChat: true` written down, so nothing would change for the people who hit it.
- **Remove the setting.** Some owners do want their last chat back, and the switch costs nothing to keep.

## Consequences

- A backup made before version 5 holds `reopenLastChat: true`, and restoring its Settings turns reopening back on. That restores what the backup holds, as it does for every other setting.
