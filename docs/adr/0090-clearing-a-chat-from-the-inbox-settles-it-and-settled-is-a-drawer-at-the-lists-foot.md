# Clearing a chat from the Inbox settles it, and Settled is a drawer at the list's foot

Issue #278. ADR 0063 split the Active chats out of the way into their own section, Unsettled. They were Active chats the owner cleared from the Inbox, kept on this computer only, and each one came back to the Inbox when anything new happened in it. So the list had two places for chats out of the way, Unsettled and Settled, with a button for each (Clear and Settle) and different rules. ADR 0063 also moved Settled from a drawer at the list's foot into the list's scroll, just under Unsettled. With dozens of chats in each, the owner had to scroll past both to find Settled. The owner asked for one place for chats cleared from the Inbox, at the bottom of the list.

## Decisions

- **Clearing a chat from the Inbox is settling it.** The row's Clear button and the menu's Clear from the Inbox and Back to the Inbox items go. The row's Settle button, and a Settle item in its right-click menu, clear a chat. The chat becomes Settled on Hermes (ADR 0002), so this holds on every computer and a message from another platform leaves it there. Settle works on any Active chat, as it always has, not only a read and quiet one as Clear did.
- **Unsettle puts a chat back in the Inbox.** It is the same button as before, plus an Unsettle item in the right-click menu.
- **There is no Unsettled section.** Its switch in Settings → General goes. A stored preference that names it drops it (uiPrefs.ts `toSections` leaves out a key it doesn't know); a list of shown sections that held only Unsettled becomes the defaults.
- **Settled is a drawer at the foot of the chat list, outside its scroll.** Its header, with the count and the unread dot, always sits at the bottom of the list panel, however long the Inbox is. Clicking it opens the drawer upward, to at most half the panel, with its own scroll; clicking it again closes it and hides the settled chats. It starts closed, and open or closed is kept in `chatSectionsCollapsed` across restarts, as every section's is. Opening a Settled chat from elsewhere (a search, a link) opens the drawer. The Settled switch in Settings still hides the drawer.
- **The list's scroll is Pinned, Inbox, Working, Snoozed, then Archived** when Settings shows it. `SECTION_KEYS` puts Settled last, so Settings lists its switches in the order the list shows the sections.
- **Settle all clears the whole Inbox at once** (issue #303). The Inbox header has a Settle all button while the Inbox has chats, reachable by Tab. It settles the chats the Inbox shows under the shown profile and project, and no others: Pinned, Working, Snoozed and Settled chats stay. It asks first, naming how many chats have an Approval waiting or a failure, since those are settled too. Each chat gets the same write the row's Settle makes, all at once, and the chats move to the drawer, which stays as it was. A toast says "Settled 12 chats" with Undo, which unsettles exactly the chats that went in. A write that fails puts that chat back in the Inbox, isn't retried, and the toast says how many; when every write fails the toast has no Undo.
- **The clears an older version kept are settled once.** Once Hermes has listed the profile's chats and the connection is up, each clear that still holds (snooze.ts `heldClears`: the chats the old Unsettled section showed) is settled, as the Settle button would, without a toast. Then that connection and profile's clears are dropped from `hermes-chat.cleared`. Clears that something newer had ended are dropped without settling anything.

## Considered options

- **Keeping clears on this computer and showing them in Settled.** Settled would then hold chats of two kinds: ones that come back on anything new and stay on this computer, and ones that stay put on every computer.
- **A Settled button at the foot that swaps the list for the Settled chats.** It hides the Inbox while the owner looks through settled chats.
- **Leaving Settled in the scroll and pushing it down with empty space.** It sits at the bottom only while the scroll above is short.
- **Dropping the old clears, so those chats come back to the Inbox.** The owner had dozens of them, and had already put each one out of the way.

## Consequences

- **ADR 0063** is partly superseded: Unsettled, Clear from the Inbox and Back to the Inbox, and "Settled leaves the foot of the list" no longer hold. The rest stands.
- A row that moves between the scroll and the drawer, as a chat is settled or unsettled, is drawn again, and loses an open menu or rename box. Settling and unsettling are clicks on that row or its menu, so nothing is open then.
- Settling a chat Hermes has no route for is kept in this computer's list (ADR 0002), so those chats are Settled here only, as they always were when settled.
- Settling the old clears writes to Hermes once per chat. A write that fails is reported and retried on the next refresh, as any Settle is.
- Tests find the drawer by `.settled-drawer` and its rows by `data-section="settled"`.
