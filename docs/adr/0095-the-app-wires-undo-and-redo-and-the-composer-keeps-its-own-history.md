# The app wires undo and redo, and the composer keeps its own history

Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y did nothing in any text field (#301). Checked in the real app on Linux with real X key presses: the `keydown` reaches the page uncancelled, but no `beforeinput` of type `historyUndo` follows, in the composer or in a plain uncontrolled `<textarea>`. `document.execCommand("undo")` on the same field does undo. WebKitGTK, in this Tauri shell, binds no key to undo or redo. Cut, copy and paste already work. The composer has a second problem: with `execCommand("undo")` standing in for the key, its history was wrong after the app wrote the text. A slash command pick, a Draft shown again after a chat switch (the same textarea), a Draft shared by two panes, Dictation, and the Edit or Quote append all write the value from React, and undo then gave text the field never held.

## Decisions

- **The app handles the keys.** `src/ui/editKeys.ts` reads Ctrl+Z (Cmd+Z) as undo and Ctrl+Shift+Z or Ctrl+Y as redo, in one place.
- **The composer keeps its own undo history, per Draft, in the drafts store** (`src/hermes/drafts.ts`), in memory only. Every writer of a Draft already goes through the store, two panes on one Draft share it, and a chat switch is not a write, so the history follows the Draft and never crosses chats. Typing within a second joins one step, and anything else (a pick, a paste, an append) is a step of its own, as in the Artifact editor, whose history code (`src/hermes/editHistory.ts`) the composer now shares. A sent or queued message takes its history with it, so undo can't bring sent text back. The composer always cancels the keys and the webview's own `historyUndo`/`historyRedo` (its context menu), so the webview's history never runs on it.
- **Every other text field uses the webview's own history**, through `document.execCommand`, from one window listener set up at launch (`followEditKeys`), the sign-in screen included. A field with its own history (the composer, the Artifact editor) cancels the key first. Dialogs that keep the app's shortcuts from reaching past them let a text field's undo and redo through. The terminal keeps every key from the window, so the shell still gets ^Z.
- **Only the focused field is ever stepped.** The webview's history is the page's, not the field's: with nothing left to undo in the focused field, its undo steps whichever field changed last. Checked in the real app: text typed in the composer, then Ctrl+Z in an empty Search field, emptied the composer. One capture listener cancels any `historyUndo` or `historyRedo` aimed at an element other than the focused one. A date or time input counts as a text field for Ctrl+Z but holds no text history, so the webview's undo isn't run for it at all.
- **Ctrl+Z outside a text field runs the Undo of the notice on screen**, as its button does, unless a dialog is open. In a text field, Ctrl+Z is always text undo.

## Considered options

- **A native accelerator in Rust**, binding the keys to the webview's undo through GTK. Dropped: Linux only, and the composer would still undo against text the app wrote.
- **Keeping the webview's history in the composer**, writing app text with `execCommand("insertText")` so it lands in that history. Dropped: it can't cover a chat switch, where the same textarea shows another Draft, or a second pane writing the same Draft.
- **Only the keys**, `execCommand` everywhere, the composer included. Dropped: the composer's history is wrong after any app write, as the context shows.

## Consequences

- Undo in a plain field can stop short: when the page's last edit belongs to another field, that step is cancelled, not skipped, so the focused field's older steps stay out of reach until it is edited again.
- A Draft's undo history lasts while the app runs. A restart keeps the text, not its history.
- A new text field gets undo with nothing to add. A new field that keeps its own history must cancel the keys in its `keydown`. A new dialog that stops keys must let `isTextEdit` keys through, as `useModal` does.
