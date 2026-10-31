# Sidebar is an action-only icon rail beside a chat list

The sidebar has two parts. On the far left is a narrow icon rail (about 60 px) that holds only app-level actions: the "H" mark, New chat and Search at the top, then the connection status dot and Settings at the bottom. Next to it is a list panel with Active chats first and Settled chats in a collapsed "Settled (n)" section below. The owner picked this hybrid of two prototype variants (A: list with a collapsible Settled section; C: icon rail) after clicking through all of them on `prototype/ui`. The rail doesn't show chat bubbles or a Settled inbox button, because that would list the same chats twice and the app's main goal is to avoid clutter.

## Consequences

- With Search and New chat moved to the rail, the list panel's header becomes the profile switcher: the current profile's name with a ▾ (for example "default ▾"), which opens the list of profiles with a filter box. Profiles are switched here, not in Settings. The header shows the full name because a rail button would only have room for a first letter, and several profiles share one. Ctrl+B or clicking the "H" hides the list panel, leaving the rail and the chat pane. With the panel hidden, the owner switches chats through Search (Ctrl+K).
- Connection status is a dot on the rail: green for Connected, amber for Reconnecting, grey for Offline. An Unsecure connection adds an amber ring and an open-lock mark to the dot. The full wording appears only in the dot's tooltip and in Connection settings, so the list panel has no footer.

## Considered options

- **A alone** (list panel with a header and footer): the owner liked how it looked but preferred C's rail for the app-level actions.
- **C alone** (rail with chat bubbles and a Settled inbox button): too compact to read chat titles, and the bubbles duplicate the list once A's panel is added.
