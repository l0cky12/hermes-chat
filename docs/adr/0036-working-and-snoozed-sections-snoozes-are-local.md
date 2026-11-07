# The list shows Working and Snoozed sections, and snoozes are kept on this computer

The chat list used to have two sections, Active and Settled. A chat Hermes was still replying in sat among the ones waiting on the owner, so the top of the list didn't say what needed the owner now. And there was no way to put a chat aside for a while without settling it and remembering to come back.

The list now shows each chat in one place, worked out from what the app already reads (`snooze.ts` `chatSections`):

1. **At the top, unlabeled**: Active chats that need the owner or are done. Hermes waits on an Approval, the reply ended, or nothing is running. Newest first; a chat counts as new when it woke from a snooze, was unsnoozed, or stopped working (seen while the app runs, `AttentionClock`), so a chat that stops to ask for an Approval goes to the very top even though Hermes doesn't count that as activity.
2. **Working**: Active chats with a reply running that isn't waiting on an Approval. It shows only when it has chats.
3. **Snoozed**: Active chats the owner snoozed that haven't woken yet. A collapsed section, soonest to wake first, each row showing when it wakes in place of its age.
4. **Settled**: unchanged (ADR 0002), the drawer at the foot.

The word "Active" no longer labels anything in the list. It stays the name of the state that is stored as Hermes's `pinned` flag, and the toast after unsettling says "Unsettled".

Snoozing is in a chat's right-click menu: 1 hour, 3 hours, Tomorrow (9:00), Next week (the coming Monday, 9:00), and Custom…, which asks for a date and time or a duration (up to a year). A snoozed chat's menu offers only Unsnooze, so to change the time the owner unsnoozes first. Settled chats can't be snoozed. Settling a snoozed chat forgets the snooze; Undo puts it back.

## Decisions

- **Snoozes are kept on this computer only**, in one versioned localStorage document (`hermes-chat.snoozes`), for each connection and profile (the scope projectLinks.ts gives), and never sent to Hermes. Hermes has no field for it: a session edit takes only its title and flags. Windows of this app share it through the `storage` event.
- **A woken snooze is kept for a week**, so the chat stays sorted by when it woke, then forgotten. Deleting a chat forgets its snooze.
- **Only the owner's own send wakes a snoozed chat early.** A message the owner sends from this app (the composer, the queue or Retry: everything that goes through the transport's `deliver`, which tells the app through `onSend`) wakes it, as sending makes a Settled chat Active. A slash command Hermes runs isn't a message, so it doesn't. A reply or message from another platform leaves it snoozed, as it leaves a Settled chat settled.
- **The list re-sorts when the next snooze wakes**, on a timer (set again when a snooze is further off than one timer can wait), and again when the window comes back to the front, in case the timer slept with the computer.
- **Rows keep their state when they move.** The top, Working and Snoozed are one keyed list of rows and headings, so a chat that moves as its reply starts or ends keeps its open menu, rename box and focus. Snoozed rows stay in that list while the section is collapsed, hidden, so a chat snoozed from another window keeps its rename box too. The Custom snooze dialog belongs to the list, not the row.
- **A snoozed row shows when it wakes**, beside its spinner or unread dot when it has one. The chat's header says Snoozed until it wakes, and stops saying so when it does.
- **A custom time the clocks skip is refused** (02:30 on the night they go forward), rather than moved.
- **Unsettle is the same icon-only button as Settle.** Both are named on hover ("Settle", "Unsettle"), and are shown on hover or keyboard focus like the row's other actions. The labeled "Unsettle" pill on Settled rows and in the chat header is gone.
- Alt+Up and Alt+Down step through the top of the list, then Working (ADR 0032).

## Considered options

- **Storing snoozes in Hermes** as a tag in the title, or in the pinned flag: either would show in other Hermes clients and change the chat for them.
- **Working above the chats that need the owner**: the point of the change is that what needs the owner comes first.
- **Waking a snoozed chat when anything new arrives in it**, as some mail clients do: that would let other platforms pull chats back into view, which ADR 0002 rules out for Settled chats too.
