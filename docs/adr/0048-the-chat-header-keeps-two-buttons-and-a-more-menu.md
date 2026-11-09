# The chat header keeps two buttons and a More menu; the split buttons are on the tab strip

Issue #173: the chat header had eight unlabelled icon buttons in a row (side panel, search, export, copy chat link,
settle, archive, split right, split down), all looking equally important.

## Decisions

- **Two buttons stay on the bar: the side panel and Find in chat.** They are the ones used most. The project defaults
  button and the worktree chip stay beside them when they apply, as before.
- **The rest are in a labelled More (⋯) menu.** Export…, Copy chat link, Settle or Unsettle, and Archive or
  Restore, each with its name and icon. It is the same menu shell as the chat list's right-click menu (ChatMenu.tsx):
  it opens below its button with the first item focused, the arrow keys move between items, Enter runs one, and Escape
  or a click elsewhere closes it and gives focus back to the button. The button says `aria-haspopup="menu"` and
  `aria-expanded`.
- **Delete chat… is the menu's last item** (#165), after a separator, left out while a reply runs. It asks first, as
  every way of deleting a chat does (DeleteChat.tsx).
- **Split right and Split down are at the end of each pane's tab strip.** ADR 0046 made splitting part of tabs; the
  buttons now sit with the strip's New tab button, and a split pane's close button takes their place there.
- **Tooltips name the shortcut where there is one.** Find in chat (Ctrl+F), Split right (Ctrl+\), and the other pane's
  close button (Ctrl+\). No new shortcuts were added for the side panel, Split down or More.

## Considered options

- **Labels on every header button.** Clearer, but the header is shared with the title and badges, and in a split pane
  there is no room.
- **The split buttons in the More menu.** Fewer controls on screen, but splitting would then be two steps away from the
  tabs it now belongs with.

## Consequences

- Export, Copy chat link, Settle and Archive take two clicks or keys instead of one. The chat list's right-click menu
  and row buttons still offer Copy chat link, Settle and Archive.
