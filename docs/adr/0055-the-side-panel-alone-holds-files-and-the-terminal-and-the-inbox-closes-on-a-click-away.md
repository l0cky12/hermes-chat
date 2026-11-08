# The side panel alone holds Server files and the Terminal, splitting has no buttons, and the Inbox closes on a click away

> **Updated by [ADR 0097](0097-the-rail-has-no-inbox-button-and-the-tray-opens-the-rail-inbox.md)** (#276). The Inbox button no longer exists, so the Inbox closes on a press outside it or on Escape, and opens from the tray's Open Inbox.

> **Updated by [ADR 0063](0063-the-chat-list-is-the-inbox-in-sections-that-collapse-and-settings-turns-on-and-off.md)** (#219). "The Inbox" here is the **Rail inbox**, opened from the rail. The chat list beside the chat is now in sections, the first of them the Inbox; the Side panel is unchanged.

The rail's Work group (ADR 0050) had Server files and the Terminal, which only opened the side panel at a tab it already shows (ADR 0039): two ways to the same place. Each pane's tab strip had Split right and Split down buttons beside the side panel's, three similar icons at the window's right edge. And the Inbox stayed open over the chat list while the owner went to another rail tool, so it had to be closed by its own button.

## Decisions

- **No Work group.** Server files and the Terminal leave the rail; they are the side panel's Files and Terminal tabs, reached from the chat header's side panel button. Outputs and Repository, which have no panel tab, join the Server group (first, then Scheduled jobs, Automations, Logs, Usage). Their files and Git checkout are on the server too.
- **The rail's Terminal dot goes with its button.** The panel's Terminal tab keeps its own running dot.
- **No split buttons on the tab strip.** Splitting is Ctrl+\\, a tab's menu (Split right, Split down), or dragging a tab to a pane's edge (ADR 0052). A split pane keeps its Close button.
- **The Inbox closes on a press anywhere outside it**: another rail tool, the chat, the side panel. The Inbox button still toggles it, and Escape still closes it.

## Considered options

- **Making Outputs and Repository side panel tabs.** Each is a full screen with its own layout (a table, a diff), too wide for a panel that can be 300 px. The panel keeps its four tabs.
- **Closing the Inbox only from other rail buttons.** A press on the chat should close it too, as a popover does, so one rule covers both.

## Consequences

- From Settings or another covering screen, Files and the Terminal are a step further: back to the chat, then the side panel button.
- ADR 0050's "Work" group and ADR 0039's "the rail's Terminal and Server files buttons" no longer hold.
