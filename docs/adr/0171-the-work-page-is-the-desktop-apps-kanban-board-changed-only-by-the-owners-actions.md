# The Work page is the desktop app's Kanban board, changed only by the owner's actions

> **Accepted.** Issue #595. The Work page (`src/ui/Work.tsx`) is a rail screen, and its reads and writes are `KanbanApi` methods in `src/hermes/kanban.ts`.

The owner wanted to see and steer their bots' work without leaving Hermes Chat. Hermes keeps that work on the dashboard's kanban plugin board, and the official Hermes desktop app already shows it in its Kanban view (`hermes-desktop` `src/lib/ui/Kanban.svelte`, `TaskSheet.svelte`, `src/lib/kanban.ts`). The chat list already read the same board for each chat's Dispatched work (ADR 0096), but only to place chats, never to show the board itself.

## Decisions

- **The page copies the desktop app's view, not a design of its own.** It has one column per status from `GET board`, cards with the task id, priority, tenant, title, the block reason or a two-line body, and the assignee. It has the task sheet with comments, Edit, Comment and the moves the workflow allows, and New task. Someone who uses both apps finds the same board.
- **The plugin's workflow decides every move.** A card drops only on a column whose `drag_target` is set, and only when `manual[from]` lists it (`canMove`). The dispatcher's columns, such as running and review, never take a drop. Completing a task that isn't in review asks what got done, and blocking asks why (`moveNeeds`). A block also leaves a `BLOCKED: <reason>` comment, as the CLI does.
- **A write that may have landed is never sent twice by mistake.** A move holds its task until the board shows it somewhere else (`moveSettled`), and Refresh clears the hold. New task sends one `idempotency_key` per form, reused on a retry, and its fields stay locked after a lost answer so the retry sends what the first try sent. A comment has no key, so after a lost answer the box stays locked until a read shows it saved, or the owner picks Post again or Discard. A refusal (an answer under 500, or a write the app never sent) is told apart from a lost answer by `refused`.
- **The board is read every 10 seconds while the page is open**, as the desktop app does, but never during a drag, a move or an open prompt. A read that started before a move doesn't overwrite the board the move read afterwards.
- **The page lives behind a capability, `kanban`.** It is checked with `GET api/plugins/kanban/boards`, the small list the chat list already reads. On a Hermes without the plugin the Work button doesn't show, and a board read that answers 404 explains that the plugin is off. The relay takes the page's two `POST`s only with the fields the page sends (`kanban_write`). Its `PATCH`es were already relayed.

## Considered options

- **Reuse the chat list's `KanbanWatch`.** It reads every board every 5 minutes and keeps only the tasks of the shown profile's chats. The page needs the whole current board, fresh, only while it is open, so it reads on its own and shares only `KanbanApi`.
- **A board picker.** The desktop app shows only the current board, and so does this page. A picker can follow if the owner works on several boards.
- **A drag-and-drop library.** Native HTML5 drag and drop is enough for moves between columns, and the issue asks for no new dependencies.

## Consequences

- The page reads the whole current board every 10 seconds while it is open. The default board is hundreds of kilobytes, so the page reads nothing while it is closed.
- A move or edit made on the dashboard or by the dispatcher shows within one poll.
- The Rust relay now takes `POST api/plugins/kanban/tasks` and `POST api/plugins/kanban/tasks/{id}/comments`. Its tests list the fields each one takes.
