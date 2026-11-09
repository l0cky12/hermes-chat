# On Windows the page gives up the height the docked touch keyboard covers

Tapping the composer on Windows brings up the touch keyboard. Windows docks it along the bottom of the screen and over the window, without resizing the window, so the keyboard covered the composer and what was being typed (#375). The page has to make room itself, and to do that it has to know where the keyboard is.

## What the page is told

Probed on a `windows-latest` runner (Windows Server 2025, WebView2 and Edge 156, a 1024 × 768 screen) with injected touch taps. The keyboard was set to show on every tap. The [probe run](https://github.com/l0cky12/hermes-chat/actions/runs/42649623932) and the `diag/375-osk-inset` branch have the scripts and screenshots.

- **WebView2 tells the page nothing.** `navigator.virtualKeyboard` exists, but its `boundingRect` stays 0 × 0 while the keyboard is up, and `keyboard-inset-*` stays `0px`, with `overlaysContent` false or true. With it true, `geometrychange` fires only when the keyboard hides, with a 0 × 0 rectangle. `visualViewport` and `innerHeight` don't change, and nothing scrolls.
- **Edge is the same.** A textarea at the bottom of a page that fits the window stays where it was, under the keyboard, and the page gets the same zeros.
- **The input pane API is silent too.** `IFrameworkInputPane::AdviseWithHWND` on the app's own window gets no `Showing` or `Hiding` when the keyboard shows for a field in it, and `Location()` stays empty.
- **TabTip's window shows where the keyboard is.** TabTip draws the keyboard in `IPTip_Main_Window`. While the keyboard shows, that window is visible, not cloaked and not disabled, and its rectangle is the keyboard's: `0,494,1024,768` docked, `70,494,953,768` undocked (floating), in screen pixels. Hidden, it keeps its rectangle but is cloaked and has `WS_DISABLED`.

## Decisions

- **On Windows a thread reads TabTip's window every 200 ms** (`src-tauri/src/touch_keyboard.rs`). When the height the keyboard covers changes, it emits `touch-keyboard` with `{ covered }`, in CSS pixels. The `touch_keyboard_covered` command answers with the same height now, for a page that starts listening while the keyboard is already up, at startup or after a reload. `covered` is the part of the window's client area below the keyboard's top edge. A keyboard counts only while it overlaps the client area sideways and reaches the client area's bottom edge. So a floating keyboard left at the bottom counts, and one moved up the screen doesn't.
- **The page's root gives up that height** (`src/ui/touchKeyboard.ts`). The page listens, then asks `touch_keyboard_covered`, and keeps an event that came while it asked over the answer. It sets `--touch-keyboard` on `<html>`, and `#root` is `calc(100% - var(--touch-keyboard, 0px))` tall. The chat's column ends above the keyboard, with the composer at its bottom. At 0 the property is removed and the page fills the window again.
- **Other platforms don't change.** Nothing emits `touch-keyboard` outside Windows, and an unset `--touch-keyboard` is `0px`.

## Considered options

- **`navigator.virtualKeyboard.overlaysContent` and `env(keyboard-inset-height)`.** This is the web's own answer, and it would need no Rust. WebView2 reports zeros, as measured above.
- **Following `visualViewport` resizes.** It never resizes.
- **`IFrameworkInputPane` or `InputPane` events.** They would avoid polling, but the probe's window, advised on itself, heard nothing.
- **A `SetWinEventHook` on TabTip's cloak and location changes.** It would avoid polling, but which events TabTip's window raises wasn't measured. Five reads a second of one window's state cost little next to the probe evidence this had to be built on.

## Consequences

- The composer and its text stay above a docked keyboard, and above a floating one left at the bottom of the screen.
- Fixed overlays, such as dialogs, keep the full window and can still be covered.
- Only TabTip's keyboard, on Windows Server 2025, was measured. Windows 11 client editions weren't. Where a touch keyboard is drawn by anything other than a shown `IPTip_Main_Window`, nothing changes from before this ADR.
- The rectangle is read in physical pixels and divided by the window's scale factor. Only 100% scaling was measured.
