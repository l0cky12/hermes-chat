# Launch starts on a new chat

> **Accepted.** It changes the default of "Reopen last chat on launch" (commit `0accfac1`, which had no ADR of its own) from on to off.

Since `0accfac1`, the app opened each profile's last chat at launch, and Settings → General → Launch, tray & updates could turn that off. The owner reported that this affects real users: the app opens on the chat they were in before, not a new one. The owner asked for launch to open a new chat.

## Decisions

- **`reopenLastChat` is off by default.** Launch shows the New chat pane. The switch stays in Settings, unchanged, for an owner who wants the old behavior.
- **Every saved preference is moved to off once** (preferences version 5). Each write of the preferences stores every field, so a saved `reopenLastChat: true` can't tell an owner who turned it on from one who never looked. Moving everyone to off is what the owner asked for. An owner who wants it back turns it on again, and from version 5 that choice is kept.
- **The setting is about launch only: the first time the main screen shows in a run.** Every later time it shows (a switch to another saved connection, a switch that stopped on the sign-in screen for a password, signing in again, a failed Save and connect putting the last connection back) it shows the profile's chat as it was in this run, whatever the setting. `App.tsx` tells the two apart by whether the main screen has shown yet, and passes `ReopenOn` to it. Telling them apart by whether a connection was open before failed both ways in review: the sign-in screen has none open at launch and mid-run alike.
- **What a later screen shows is the run's, not the stored chat.** `App.tsx` keeps each profile's chat on screen in this run, by connection and profile, across main screens: every move between chats, and the New chat pane wherever it shows without a move (the launch, a launch by a chat link, a profile switched to). A later screen shows that. Only a profile not yet on screen in this run, such as another connection's, opens its stored last open chat, as before. The stored `lastOpenChat` keeps its meaning, the last chat opened in each profile, so turning the setting on reopens it at the next launch, and a profile switch mid-run leaves it for then. Clearing the stored chat at launch and on a profile switch was tried and dropped: it threw that away.

## Considered options

- **Only change the default.** Every existing install has `reopenLastChat: true` written down, so nothing would change for the people who hit it.
- **Remove the setting.** Some owners do want their last chat back, and the switch costs nothing to keep.

## Consequences

- A backup and a restore read the preferences stored here as the app does, brought up to this version (`backup.ts`), and a restore writes the backup's Settings into that. Read as stored, an older document's `reopenLastChat: true` matched a backup's and the restore skipped it, though the app reads it as off; and written into an older document, a restored `true` was turned off again by this migration on the next read. A document whose version isn't a version is left as stored, since migrating it would drop every field.
- A backup made before version 5 holds `reopenLastChat: true`, and restoring its Settings turns reopening back on. That restores what the backup holds, as it does for every other setting.
