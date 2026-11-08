# Finished Rail inbox entries can dismiss themselves after a set age, and Clear done dismisses them all

Issue #275. Dismissing a Rail inbox entry was a click per entry (ADR 0019). An owner whose scheduled briefs, one-off questions and finished work chats each leave a Completed entry clicked each one away, or let them pile up over the Approvals and failures that need an answer.

## Decisions

- **Settings → Chats, Rail inbox, "Days of inactivity before auto-dismiss".** A number field (issue #298) of whole days from 1 to 365, saved when the field is left or Enter is pressed. Empty or 0 is Off, and a value outside that range isn't saved. Off until the owner sets a number. It is a display preference (uiPrefs.ts `inboxAutoDismissDays`), kept on this computer like the rest.
- **Only Completed entries qualify.** A reply running, an Approval waiting or ended, a failure, a Failed message and one Hermes may not have all ask something of the owner or leave on their own, and are never dismissed for their age. A Completed entry with no known time isn't either.
- **Older than the set time means its own time.** An entry qualifies once the time Hermes gives its chat's last activity is more than the set time ago. One exactly that old stays.
- **It is a dismissal, through the same store.** Each entry is recorded as a dismissal by hand records it: its key and time, and now as when, in the connection's own record (`INBOX_PREFIX`), kept 30 days and 1000 at most. So it shows again exactly when a dismissed entry does: once the chat has something newer. Unread, Settled and Archived on the server are untouched, and nothing goes to Hermes.
- **It applies whenever the inbox is worked out**, on every check and render, with or without the Rail inbox open. A change to the setting applies at once.
- **Clear done**, in the Rail inbox's header, dismisses every Completed entry the list shows under its filter, whatever its age, in one write. It shows only while there is one.

## Considered options

- **Read and quiet for some hours (the issue's B), and a daily sweep (C).** Left out for now. Both are the same threshold on another clock, and can share this setting later.
- **A conservative default, such as 7 days.** An entry leaving on its own is a change the owner would notice without having asked for it. Off keeps the inbox as it was until they do.
- **Counting from when this app first noticed an entry.** That time lasts only while the app runs, so a restart would restart every count.

## Consequences

- A batch of auto-dismissals is newest in the 1000-entry cap, so a profile with many old Unread chats can push out older dismissals made by hand, whose entries then show again if they still exist. A batch bigger than the cap keeps 1000; the rest stay shown, and aren't tried again until the app restarts or their chat moves on.
- **ADR 0019**: dismissals are still kept here, per connection, with the same rules; some are now made by the app on the owner's say-so.
