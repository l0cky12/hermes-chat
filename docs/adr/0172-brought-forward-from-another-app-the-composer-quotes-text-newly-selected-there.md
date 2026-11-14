# Brought forward from another app, the composer quotes text newly selected there

> **Accepted.**

The owner accepted an idea from the improvement report: when the key that brings Hermes Chat forward is pressed with text selected in another app, put that text in the composer and focus it, sending nothing; with the clipboard as the way in, used only if it changed since the window last had focus; plain show-window when unchanged or unreadable; a Settings switch, on by default. There is no global shortcut in the app (ADR 0107 is superseded): the key is one the owner binds in their desktop to `hermes-chat --toggle` or `--show`, which reach the running app over the session bus (`remote.rs`).

## Decisions

- **Only a summon from another app reads it.** `summon.rs` tells the webview, with its `summoned` event, whether the window was brought forward by `--show`, `--toggle` or a second launch while another window had focus (`fromElsewhere`). A chat link (ADR 0037) also brings the window forward, but never reads the selection: the link names what to show. A press while the window has focus reads nothing.
- **The selection first, then the clipboard, on Linux.** X11 and Wayland keep what is selected in the PRIMARY selection, without a copy, so selecting and pressing the key is enough, as the owner described. The clipboard is read too, for text copied with a Copy button, which sets no PRIMARY selection. Each is compared with what it held when the window last lost focus (read then, and once at start): PRIMARY is used if it changed, otherwise the clipboard if it changed. Text selected in Hermes Chat itself before leaving it is what PRIMARY held at that moment, so it never comes back as new. Once used, text is what the selection holds, so the next summon doesn't add it again. Both are read in Rust through GTK's clipboards (`selection.rs`), the way `copied_files.rs` reads copied files (ADR 0143), so no crate or plugin is added. On Wayland an app reads the selections only while it has focus, so the webview reads once the window has focus, or after 1.5 seconds without it. Reads can be answered out of order, so each takes a ticket when it starts (`SelectionWatch.reading`), and one that lands after a later-started read has landed is dropped: a slow read made on leaving can't put an older baseline back after a summon has read.
- **Never a password, a blank or a whole file.** Text a password manager marks with the `x-kde-passwordManagerHint` target (KeePassXC, KDE's Klipper) is not read. Blank text and text over 100,000 characters count as nothing to use. Nothing to use means the window only comes forward, as before. A selection whose owner doesn't answer within a second is unreadable, which is not the same: Rust leaves it out, and the webview keeps what it last read of that selection, so text that didn't change never comes back as new because one read failed.
- **Quoted after the draft, never over it.** The text goes in the selected pane's composer, each line after `> `, with a blank line after it for the owner's question. A Draft already there stays, and the quote follows it after a blank line, as other text the app adds to a Draft does. It is one undo step, so Ctrl+Z takes it out. The cursor goes to the end. If Settings, another screen, Search, or the side panel on a narrow window covers the chat, nothing is added and focus stays where it was, as a summon already does.
- **Nothing leaves the computer.** The text goes into the local Draft, kept as any typed Draft is (`drafts.ts`). Hermes gets it only if the owner sends the message.
- **Settings → General → Launch, tray & updates → Brought forward: "Start a message with the selected text", on by default.** It lives in the display preferences (`summonSelection`), on this computer. Off, the selections are never read.

## Considered options

- **The clipboard only**, as the idea was first written. Rejected as the only source on Linux: the owner selects text without copying it, which only PRIMARY holds. Kept as the second source.
- **Replacing the Draft with the selection.** Rejected: it would throw away what the owner typed.
- **Sending the selection, or opening a new chat for it.** Rejected: the owner asked for nothing to be sent, and the chat on screen is where they were.
- **Reading in the webview with `navigator.clipboard`.** Rejected: the Clipboard API reaches only the clipboard, never PRIMARY.
- **Simulating Ctrl+C in the other app.** Rejected: an app can't send keys to another window on Wayland.

## Gaps

- Windows has no PRIMARY selection, and the clipboard isn't read there yet: on Windows the window only comes forward. Reading it would use the Win32 clipboard API from Rust, which this build box can't compile or run.
- A selection or copy made for something else since the owner last left Hermes Chat is quoted too. It is one undo step to take out, and the switch turns it off.
- Password managers that don't mark what they copy (some browser extensions) aren't recognized.
