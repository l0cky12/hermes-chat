# Shortcuts are a command table each handler asks, and the owner's changes are a diff in the display preferences

Issue #285: every keyboard shortcut was a literal in the handler that answered it, in eight files, and the only place to find one was a tooltip. The owner couldn't change any of them. The issue asks for one Settings page that lists every command with its keys and lets the owner rebind it, with each default kept as it was, no key firing during IME composition, and no bare key answering an Approval or stopping a reply with the cursor outside a text field (`keyboard.test.tsx` pins both).

## Decisions

- **One table names every command** (`src/ui/keybindings.ts`): its title, the Settings group it is listed under, the scope its keys work in (`app` for a window listener, else one control), the When condition the page shows, and its default chords. The When text is only shown. There is no expression language and no evaluator: a typed `scope` decides which commands can clash, and each handler keeps the guards it had (`covered`, `onChat`, `activeRef`, `!chat.running`, a `select` target).
- **Each handler asks the table which of its scope's commands a press is**, through `pick(e, scope)` or `pickApp(e)`, in place of its `e.key ===` checks. There is no central dispatcher. A window listener runs no command when a control already took the press (`defaultPrevented`), and every window listener picks from the same app-wide list, so one press runs one command even when the owner puts two commands on one chord.
- **A chord is a press with exactly its modifiers.** `Ctrl+Alt+Shift+K`, modifiers in that order, Ctrl standing for Ctrl or Cmd as before. A letter or digit is named by what it types, else by its position, so Shift and other layouts give the same key; punctuation by position first. Matching is strict: Enter and Shift+Enter are different commands, as are Ctrl+Tab and Ctrl+Shift+Tab. Two presses that used to work by accident don't now: Ctrl+Shift+K no longer opens Search, and Alt+Enter no longer sends.
- **The owner's changes are a diff from the defaults**, in the display preferences (`uiPrefs.ts` `keybindings`, the one document every display setting lives in), by command id. A command never changed takes whatever default a later version gives it. `uiPrefs.ts` checks the shape; the table drops an id it doesn't know, a string that isn't a chord, and a chord it would refuse, so a hand-edited document can't put a bare key on an app-wide command. A backup carries the field.
- **A chord is refused when it would break typing or the desktop, never for clashing with another command.** A printable key without Ctrl or Alt, a bare key on an app-wide command (function keys aside), Tab, the editing keys, Ctrl+Alt+F1 to F12, Alt+F4 and the screenshot shortcut can't be saved; the page says why. Two commands on one chord save, and both rows show a warning naming the other. At runtime the clash is settled by focus: the focused control first, then the command the owner changed, then the first in the table.
- **Every hint reads the table.** Tooltips, `aria-keyshortcuts`, the empty chat's list, the composer's hint and the Settings copy that names a chord all show the chord in use, through `useBindings`, so a change on the page shows everywhere at once.
- **In-window only.** None of these commands make sense while the window is unfocused, and a global shortcut would take keys from other apps (ADR 0033 is superseded; `--toggle` is the desktop's job).
- **No Approval shortcuts.** The Approvals / Inbox group is empty, with a note saying so: Tab to the card's buttons, then Enter or Space. A chord with Ctrl or Alt is the only kind an app-wide command can have, so the safety property holds for every rebinding.

## Considered options

- **A When-expression language with a parser and a context built on each press** (the issue's sketch). Every handler's guard would have to be re-expressed as an identifier and kept in step with the code that already has it. The text is shown instead, and a typed scope answers the one question the page needs, which commands can clash.
- **One window dispatcher for every command.** The local keys (Enter in the composer, Escape in the palette) belong to their controls, whose own guards and focus decide. Moving them to the window would re-create those guards from `document.activeElement`.
- **Storing the whole binding table.** A later version's new default would never reach an owner who had saved the table once.
- **Refusing a clash.** The owner may want Ctrl+K on Hide the list and find Search another chord next; a refusal would make them do it in the other order.

## Consequences

- A new command is a row in the table and a `case` in its handler. A literal chord in UI copy is a bug; read `useBindings`.
- A new handler scope needs its guards as before, and its commands can clash only with each other and with app-wide ones.
- The screenshot recorder (`shortcut.ts`) refuses a chord a command uses now and accepts one a command gave up.
- Changing a default in the table changes it for every owner who never overrode that command.
