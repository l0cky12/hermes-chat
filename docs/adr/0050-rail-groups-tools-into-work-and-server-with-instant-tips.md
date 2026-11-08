# The rail groups its tools into Work and Server, with tips that show at once

> **Updated by [ADR 0097](0097-the-rail-has-no-inbox-button-and-the-tray-opens-the-rail-inbox.md)** (#276). The rail no longer has an Inbox button; the Rail inbox opens from the tray's Open Inbox. The rail's top is the "H" mark, New chat, Search, Bots and Office.

> **Updated by [ADR 0063](0063-the-chat-list-is-the-inbox-in-sections-that-collapse-and-settings-turns-on-and-off.md)** (#219). The rail's Inbox button opens the **Rail inbox**, the list of what needs the owner in every profile; the chat list's first section is now also called the Inbox.

Issue #176: the rail had grown from ADR 0001's few app-level actions to twelve icon-only buttons of the same size and weight, in no order a person could learn. Each had only a native `title`, which shows after a delay, so telling them apart meant hovering and waiting.

## Decisions

- **Daily tools first.** The "H" mark, New chat, Search and Inbox stay at the top in full strength (`--text-2`).
- **The profile's tools sit in two labeled groups, a step quieter.** **Work**: Server files, Outputs, Repository, Terminal (what Hermes made and where it works). **Server**: Scheduled jobs, Automations, Logs, Usage (what runs or is recorded on the Hermes server). Each group has a small uppercase label and a rule above it, like Settings' section labels. A group with none of its tools (a Hermes without jobs or webhooks, say) isn't drawn. The connection dot and Settings stay at the foot.
- **One tip, shown at once.** Hovering or focusing a rail button shows a tip beside it with its name, its shortcut (Ctrl+B, Ctrl+N, Ctrl+K, Ctrl+,) and a line about it. It stays while the pointer is on the button or on the tip itself, so it can be read under magnification, and goes once the pointer leaves both, on blurring, scrolling the rail, or Escape. It is drawn on the page itself, outside the rail, so a screen the rail sits under (the Inbox) can't cover it. The buttons drop their native `title`, so no second, slower tooltip shows. The tip is hidden from screen readers, which get the same from the button: its name, its shortcut in `aria-keyshortcuts`, and the tip's line as its description (left out where the name already says it, as with the Inbox count).
- **The open screen is marked** with an accent bar at the rail's edge, as the active pane is marked along its top.
- **A short window keeps every button.** Under 620 px of height the group labels give way to their rules alone and the buttons close up; under 540 px they close up further, so the window's minimum height (500 px) shows every button. A rail that still overflows (a larger font, say) scrolls its middle, so the daily tools and Settings never leave the screen.

## Considered options

- **A More button for the rarely used tools.** Fewer icons, but every one of them becomes two clicks, and which ones count as rare differs by owner.
- **A rail that expands to show its labels.** Readable, but it takes width from the chat in a window that can be as narrow as 760 px, and needs a setting to remember it.
- **Moving Import to Settings.** The issue read the Outputs button (a file with an arrow) as Import. Import already lives in Settings (Settings → Import); Outputs stays on the rail, in Work, now named by its tip. The Settings tip mentions Import, so it is found from the rail.

## Consequences

- Tests find rail buttons by their accessible name, not by `title`.
- A new rail tool joins Work or Server, or argues for a third group; it doesn't go between the groups.
