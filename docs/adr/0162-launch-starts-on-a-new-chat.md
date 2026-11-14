# Launch starts on a new chat

> **Accepted.** It changes the default of "Reopen last chat on launch" (commit `0accfac1`, which had no ADR of its own) from on to off.

Since `0accfac1`, the app opened each profile's last chat at launch, and Settings → General → Launch, tray & updates could turn that off. The owner reported that this affects real users: the app opens on the chat they were in before, not a new one. The owner asked for launch to open a new chat.

## Decisions

- **`reopenLastChat` is off by default.** Launch shows the New chat pane. The switch stays in Settings, unchanged, for an owner who wants the old behavior.
- **Every saved preference is moved to off once** (preferences version 5). Each write of the preferences stores every field, so a saved `reopenLastChat: true` can't tell an owner who turned it on from one who never looked. Moving everyone to off is what the owner asked for. An owner who wants it back turns it on again, and from version 5 that choice is kept.
- **The setting is about launch only: the first time the main screen shows in a run.** Every later time it shows, the connection's last chat opens as before, whatever the setting: a switch to another saved connection, a switch that stopped on the sign-in screen for a password, signing in again after signing out or after a turned-down password, and a failed Save and connect putting the last connection back. `chatToReopen` takes which of the two it is (`ReopenOn`), and `App.tsx` works it out from whether the main screen has shown yet. Telling them apart by whether a connection was open before failed both ways in review: the sign-in screen has none open at launch and mid-run alike.
- **A launch on the New chat pane is the chat on screen.** It is recorded as the profile's last open chat (`lastOpenChat`), as a move to the New chat pane always was, so the main screen showing again later in the run shows it, or whatever the owner opened since, and never a chat from before the launch. Turning the setting on reopens, at the next launch, the chat on screen when the app last closed.

## Considered options

- **Only change the default.** Every existing install has `reopenLastChat: true` written down, so nothing would change for the people who hit it.
- **Remove the setting.** Some owners do want their last chat back, and the switch costs nothing to keep.

## Consequences

- A backup and a restore read the preferences stored here as the app does, brought up to this version (`backup.ts`), and a restore writes the backup's Settings into that. Read as stored, an older document's `reopenLastChat: true` matched a backup's and the restore skipped it, though the app reads it as off; and written into an older document, a restored `true` was turned off again by this migration on the next read. A document whose version isn't a version is left as stored, since migrating it would drop every field.
- A backup made before version 5 holds `reopenLastChat: true`, and restoring its Settings turns reopening back on. That restores what the backup holds, as it does for every other setting.
