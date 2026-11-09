# Dispatched work

A reply that hands work to another agent and ends its turn leaves its chat in **Working**, with a still hourglass in the row instead of the spinner, until that work is over and Hermes's follow-up reply has ended. The hourglass's tooltip says what the chat waits on ("Waiting on 1 dispatched task", "Waiting on 2 subagents"). When the task is done, Hermes wakes the chat with a new reply: the row shows the spinner, and once that reply ends the chat lands in the Inbox as new. A task that is blocked or under review puts the chat in the Inbox at once, with a small alert icon and the reason. **Stop waiting**, in the row's right-click menu, puts the chat in the Inbox on this computer only; a newer dispatch counts again. The Rail inbox lists a waiting chat as Running with "Hermes is waiting on work it handed off.", and the Office seats its reply in the Workroom labelled "Waiting on handed-off work".

## Sub-features

- `waiting`: the chat stays in Working with the hourglass after a dispatching reply ends.
- `wake`: moving the task to done shows the spinner for the wake reply, then the chat lands in the Inbox as new.
- `needs-owner`: moving the task to blocked (or review) puts the chat in the Inbox with the reason.
- `stop-waiting`: the menu item moves the chat to the Inbox; a newer dispatch moves it back to Working.
- `subagents`: a `background` prompt keeps the chat in Working until both subagents have ended.
- `inbox-office`: the Rail inbox's Running entry and the Office's waiting desk.
- `relaunch`: after a relaunch the waiting state is rebuilt from the board.
- `relaunch-subagents`: after a relaunch, a chat whose background subagents still run stays in Working from Hermes's `subagent.roster` counts, without being opened, until they end and its wake turn ends (issue #311).

## How to get to it (user POV)

- Send a message with the word `dispatch` in it in any chat. The reply calls `kanban_create` and ends.
- Send a message with the word `background` in it. The reply starts two subagents and ends.
- Right-click a waiting chat's row for **Stop waiting**.
- The tray menu's Open Inbox, filter Running (the rail has no Inbox button, ADR 0097); the rail's Office button.

## Driving it with wd.mjs

Preconditions:

- Signed in per [sign-in.md](sign-in.md), and `. $HV_RUN/state.env` run so `$BRIDGE_PORT` is set. Chats in the Inbox and Working are read with `$S/wd.mjs eval 'return [...document.querySelectorAll("[data-section-head]")].map(h=>h.dataset.sectionHead+":"+h.querySelector(".count").textContent).join(" ")'`.

- **Waiting.** Run `$S/wd.mjs click button "New chat (Ctrl+N)"`, `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs keys 'dispatch a research task\n'` and `$S/wd.mjs wait .msg "Research task dispatched"`. The reply's tool call `kanban_create` shows in the transcript, and the reply ends. The row is in Working with `.row-wait[aria-label="Waiting on 1 dispatched task"]` and no `.dot`. Take `$S/wd.mjs shot`. Read the task id from the reply text (`t_…`), or from `$S/hv state | jq '.kanban.default.tasks[-1].id'` (`hv state` reads the bridge's `/__state`).
- **Picked up.** `curl -s -X POST "http://127.0.0.1:$BRIDGE_PORT/__kanban?id=<task>&status=running"`. Within 30 s the app reads the task again; the row stays as it was (the tooltip doesn't change for a running task).
- **Wake.** `curl -s -X POST "http://127.0.0.1:$BRIDGE_PORT/__kanban?id=<task>&status=done"`. The row keeps the hourglass for up to 2 s, then shows the spinner while "Results are in for t_…" streams (`$S/wd.mjs wait .msg "Results are in"`), and once it ends the chat is in the Inbox: `$S/wd.mjs gone .row-wait`, and the section counts read `inbox:1 working:0`. Take `$S/wd.mjs shot`.
- **Needs the owner.** Start another `dispatch` chat, then `curl -s -X POST "http://127.0.0.1:$BRIDGE_PORT/__kanban?id=<task>&status=blocked"`. The chat moves to the Inbox with `.row-owner[aria-label="A dispatched task is blocked."]`, and no wake reply streams.
- **Stop waiting.** Start another `dispatch` chat. Right-click its row with `$S/wd.mjs rightclick .row-open "<title>"` and `$S/wd.mjs click '[role=menuitem]' "Stop waiting"`. The chat is in the Inbox. Send `dispatch again` in it: it is back in Working with the hourglass.
- **Subagents.** `$S/wd.mjs keys 'do it in the background\n'` in a new chat, then `$S/wd.mjs wait .msg "background"`. The reply ends and the row shows `.row-wait[aria-label="Waiting on 2 subagents"]`. End them with `curl -s -X POST "http://127.0.0.1:$BRIDGE_PORT/__subagent?id=sa-1&status=completed"` and the same for `sa-2`: the hourglass goes and the chat is in the Inbox.
- **Rail inbox and Office.** With a chat waiting, open the Rail inbox as [rail-inbox.md](rail-inbox.md) Open does, by emitting the tray's `tray-open-inbox` event, and read the entry: state `Waiting`, summary "Hermes is waiting on work it handed off.", and no "Completed, unread" entry for that chat. Close it, `$S/wd.mjs click button Office`, `$S/wd.mjs wait .office-tag`: the chat's tag reads `Waiting on handed-off work` in its `aria-label`, in the Workroom. **List** shows the same label.
- **Relaunch.** With a chat waiting, `$S/wd.mjs close` then `$S/wd.mjs open` and sign in again. Once the list loads the row is in Working with the hourglass again, read from the board (`GET /api/plugins/kanban/boards` and `board?board=default` in the bridge's log).

- **Relaunch with subagents running.** Send `do it in the background` in a new chat as **Subagents** does, then open a different chat so the waiting one isn't reopened at launch. `$S/wd.mjs close`, `$S/wd.mjs open`, sign in, and wait for the list. The row is in Working with `.row-wait[aria-label="Waiting on 2 subagents"]`, and `bridge.log` shows `WS subagent.roster` and no `WS session.resume` for that chat. End both subagents with `/__subagent` as above, and start its wake turn with `curl -s -X POST "http://127.0.0.1:$BRIDGE_PORT/__live?profile=default&id=<chat id>&status=working"` (the chat id is the row's `data-chat`). After the next check (15 s) the row is still in Working. `…&status=end` ends the wake turn, and within 15 s the chat is in the Inbox.

## Gotchas

- The stand-in's `background` subagents are `sa-N` numbered across the whole run, after any `delegate` chat's. Read the ids from the reply text.
- The 30 s task poll and the 5 min board scan are real time. A relaunch reads the board once the chat list has loaded, so wait for the list before reading the row.
- An over task keeps the chat waiting for up to 20 s if no wake reply comes (the stand-in sends one after 2 s). To see the no-wake path, stop the dispatching chat's reply first with the composer's Stop before moving the task, or move it while the chat isn't open in this run.
