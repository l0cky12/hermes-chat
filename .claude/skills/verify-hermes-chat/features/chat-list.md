# Chat list and the Settled drawer

The chat list beside the chat shows one profile's chats in sections: Pinned, Inbox, Snoozed, Archived when Settings turns it on, and Working last, in the list's scroll. Settled is a drawer at the panel's foot, outside the scroll (ADR 0090). Its header opens the drawer upward to at most half the panel, with its own scroll, and closes it again. Open or closed is kept across restarts. Settle, from a row's hover button or right-click menu, is the one way to clear a chat from the Inbox. Unsettle moves a Settled chat back.

## Sub-features

- `drawer`: the "Settled N" header at the foot opens and closes the drawer; the drawer caps at half the panel and scrolls on its own.
- `remembered`: open or closed survives a relaunch.
- `settle` / `unsettle`: the right-click menu's Settle on an Inbox row, and Unsettle on a drawer row, with the stand-in's `pinned` flag read back.
- `keys`: Up and Down walk from the last row in the scroll into an open drawer's rows, and back.
- `opened-elsewhere`: opening a Settled chat from search opens a closed drawer.
- `archived`: Archived, switched on in Settings → Chats → Chat list sections, sits just above Working, the scroll's last section, which shows only while a reply runs.
- `working-last`: a chat with a reply running is the scroll's last row, right above the drawer, with Archived shown or hidden.

## How to get to it (user POV)

- The list panel, beside the rail.
- Settings (Ctrl+,) → Chats → Chat list sections, for the switches.

## Driving it with wd.mjs

Preconditions:

- `HV_LIST=24 $S/hv up`, so `default` has 24 Active chats (`list1` … `list24`) and its Inbox is longer than the panel. Then sign in per [sign-in.md](sign-in.md).

- **Header at the foot.** `$S/wd.mjs wait .settled-drawer`. `$S/wd.mjs count '.sb-scroll .settled-drawer'` prints `0`. The header `[data-section-head=settled]` reads `Settled4` with `aria-expanded="false"`, and its bottom is the panel's bottom (`eval` the two `getBoundingClientRect()`s). Run `$S/wd.mjs shot 01-drawer-closed`.
- **Settle from the menu.** For each of `list1`, `list3`, `list4`, `list6`, `list7`, `list8`, run `$S/wd.mjs rightclick '.row-open[data-chat=<id>]'`, then `$S/wd.mjs click '[role=menuitem]' Settle`. The header reads `Settled10`. `$S/hv state` shows each with `"pinned": false`.
- **Open.** `$S/wd.mjs click '[data-section-head=settled]'`, then `$S/wd.mjs wait .settled-list`, then `$S/wd.mjs shot 02-drawer-open`. The drawer's height is half the panel's at most, and `.settled-list` has `scrollHeight > clientHeight`.
- **Own scroll.** `$S/hv x mousemove 190 700`, then `$S/hv x click 5` a few times. `.settled-list` `scrollTop` grows and `.sb-scroll` `scrollTop` stays `0`.
- **Unsettle.** `$S/wd.mjs rightclick '.settled-list .row-open' "Swap usage spikes"`, then `$S/wd.mjs click '[role=menuitem]' Unsettle`. The row is back in `.sb-scroll`, and `$S/hv state` shows `list7` with `"pinned": true`.
- **Keys.** Find the last scroll row (`eval` the last `.sb-scroll .row-open`'s `data-chat`). Click it twice: the first click opens the chat and focuses the composer, the second leaves focus on the row. `$S/wd.mjs press ArrowDown` moves focus into `.settled-drawer`; `ArrowUp` moves it back.
- **Opened elsewhere.** Close the drawer, then `$S/wd.mjs press Control+k`, `$S/wd.mjs keys "Why is the VPN"`, `$S/wd.mjs click .hit-row "Why is the VPN slow"`. The header has `aria-expanded="true"` and `.settled-list .row-open[data-chat=vpn]` counts `1`.
- **Remembered.** Close the drawer, then `$S/wd.mjs close`, `$S/wd.mjs open` and sign in again. The header still has `aria-expanded="false"`.
- **Archived.** Settings → Chats, then `$S/wd.mjs click '[role=switch][aria-labelledby=chat-section-archived]'` and Escape. `.sb-scroll [data-section-head]` ends with `Archived0` (no reply runs, so Working draws no header), and the drawer still holds only Settled.
- **Working last.** Start `hv up` with `HV_LONG_REPLY=400`. Press `Control+n`, then type a prompt that starts with `long` into `textarea[data-composer]` and press Enter. Run `$S/wd.mjs wait '.row[data-section=working]'`. `.sb-scroll`'s `lastElementChild` has `data-section="working"`, and its `nextElementSibling` is `.settled-drawer`. Check this with Archived shown and again with it hidden.

## Gotchas

- The row's hover buttons (Settle, Unsettle) show only under the pointer; drive Settle and Unsettle through `rightclick` and the menu.
- `rightclick` can print "the press landed on something else" and still open the menu. Check for the menu item before retrying.
- `wait <css> <ms>` reads the number as text. Give a text, or none, before the timeout.
- To prove an upgrade (state left by an older build), keep one `hv up` run: `wd.mjs close`, `hv build` from the newer source, then `wd.mjs open`. `hv doctor` then reports the build as stale against the stamp `hv up` recorded; that is expected.
