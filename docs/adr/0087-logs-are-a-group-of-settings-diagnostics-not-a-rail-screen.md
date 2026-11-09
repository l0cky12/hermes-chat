# Logs are a group of Settings → Diagnostics, not a rail screen

The owner asked for the Logs screen (ADR 0033) to move into Settings, under Diagnostics. Logs had its own rail button in the Server group (ADR 0050, 0116) and covered the chat panes like Usage. Diagnostics already answered "what is wrong with the connection" from the server's side; Logs answers the same question from the log lines. Two places for one question meant two places to look.

## Decisions

- **Diagnostics shows two groups beside a sub-nav**: **Server**, what was there before (the server's facts, each feature's check, the Bot Desktop's browser), and **Logs**. One shows at a time, as General's groups do (ADR 0113). The sub-nav is `compact`, so in a narrow window it is a row of icons above the group.
- **Server comes first.** Diagnostics opens at Server, and a screen's "Hermes lacks this" note, or a tab's, opens Diagnostics at Server and the capability it names, even when Logs was the group shown last.
- **The rail loses its Logs button.** The Server group keeps Outputs, Repository, Scheduled jobs, Automations and Usage.
- **Logs reads Hermes only while it is shown.** Leaving the Logs group, the Diagnostics tab or Settings stops the polling, and what was read from Hermes goes, as closing the Logs screen did. This app's own diagnostics stay until the app quits. Changing profile starts Logs afresh.
- **Search names Diagnostics for Logs' words.** Diagnostics is a named tab in a Settings search, not one whose sections show in place, so a search never starts reading Hermes's logs. Its description now says what Logs holds.
- **Everything ADR 0033 decided about reading, redaction, filters, export and the support bundle is unchanged.** Only where Logs lives changed: `LogsScreen` became `LogsPanel`, without its own back button and title, which Settings has.

## Considered options

- **Logs as a section below Server, in one scrolling page.** Rejected: the list needs a fixed height to follow lines, and at the foot of a long page its controls would be off screen.
- **Logs as its own Settings tab.** Rejected: the owner asked for it under Diagnostics, and the tab strip is already eleven tabs.
- **Keeping the rail button as a shortcut to Settings → Diagnostics → Logs.** Rejected: the move was asked for to take Logs off the rail.

## Gaps

- The list's height is the window's less a fixed allowance for Settings' header and Logs' controls (`calc(100vh - 448px)`, never under 260 px). A very wide set of controls that wraps to more lines pushes the list's foot below the window, where Settings scrolls to it.
