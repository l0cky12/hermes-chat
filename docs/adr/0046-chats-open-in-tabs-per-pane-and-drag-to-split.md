# Chats open in tabs of each pane, and a dragged chat splits the chat area right or down

The chat area had one pane, or two side by side (ADR 0010), each showing one chat. Moving between a few chats meant
going back to the list each time. Each pane now has a tab strip. A chat dragged from the chat list (or from a tab) onto
a pane opens in a new tab there, or splits the chat area, side by side or one above the other.

## Decisions

- **Tabs belong to a pane.** Each pane keeps its own tabs, as an editor group does. Two panes may both have a tab for the
  same chat; they are two views of it, as ADR 0010 already allows. `null` is the New chat tab, at most one per pane.
- **Opening a chat in place replaces the tab showing.** A chat opened from the list, Search, a link or Alt+Up/Down takes
  the place of the tab on screen, as a link followed in a browser tab does. If the pane already has a tab for that chat,
  the pane switches to it instead. Only a drop on the tab strip or the pane's middle, the chat menu's Open in a new tab,
  and the strip's + button add a tab.
- **Where a dragged chat lands.** The pane's tab strip and its middle add a tab. Its right quarter splits the chat area
  side by side, its bottom quarter one above the other, with the chat in the second pane. Dropped on an edge when there
  are two panes already, the panes turn that way and the chat gets a tab in the second pane. There are still at most two
  panes. A hint over the pane says where the chat will land. ADR 0052 replaces this for tabs: a dragged tab moves rather
  than copies, all four edges split, and tabs move along their strip.
- **HTML5 drag and drop, not pointer events.** Rows and tabs carry the chat id as `application/x-hermes-chat`. Tauri's
  native drop handler on Linux (wry's WebKitGTK `drag_drop.rs`) only takes drags carrying file URIs, so in-page drags
  reach the webview, and file drops still attach to the composer as before. On Windows that handler takes every drag;
  ADR 0127 turns it off there.
- **Every drag has a keyboard way too.** The chat menu has Open in a new tab beside its pane items. The end of
  each tab strip has Split right (Ctrl+\) and Split down (ADR 0048). Ctrl+Tab and Ctrl+Shift+Tab move between the active pane's tabs; the
  arrow keys, Home and End move along a focused tab strip, and Delete closes the focused tab.
- **Closing.** A closing tab shows the one after it, or before it at the end. The last tab of a second pane closes the
  pane; the last tab of one pane leaves a New chat tab. A chat deleted, or archived out of the list, loses its tabs.
- **Tabs are layout, so they are transient.** As ADR 0010 decided for the split, tabs and the split's direction last
  for the sign-in. Switching profile leaves one pane with a New chat tab. The active pane's chat is still the one
  reopened at launch.
- **A pane's view, not its object, says whether the owner moved.** A chat starting from a New chat tab replaces that
  tab only if the pane hasn't moved meanwhile. That was checked by the pane object's identity, which a tab closing beside
  it would also change; each pane now carries a `view` number that changes only when what it shows does.

## Considered options

- **One tab strip for the window**, with the active pane showing the picked tab. Rejected: with two panes, which pane a
  tab opens in becomes a guess.
- **Every chat opened from the list in a new tab.** Rejected: tabs pile up, and the list already is the way to every
  chat. The owner chooses which chats to keep at hand.
- **Keeping tabs across launches.** Not built; layout has been transient since ADR 0010. Easy to add per profile if
  wanted.
- **More than two panes.** Not built; ADR 0010's divider, narrow-window switcher and Ctrl+1/2 assume two.

## Consequences

- Each pane's chat header has one more row above it, about 34 pixels.
- In a stacked split, each pane keeps at least 200 pixels of height, and below that the panes take turns with the
  switcher, as narrow side-by-side panes do.
