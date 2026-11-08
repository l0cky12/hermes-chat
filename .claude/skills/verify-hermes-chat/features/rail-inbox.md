# Rail inbox

The tray's Open Inbox opens a list of what needs the owner or has finished, in every profile: Approvals, failures, running replies and Unread chats. Each entry can be dismissed by hand. Clear done dismisses every completed entry shown. Settings → Chats, Rail inbox, "Days of inactivity before auto-dismiss" dismisses completed entries older than that many days on their own. Dismissals are kept on this computer only.

## Sub-features

- `open`: the tray's Open Inbox opens the list, and the rail has no Inbox button. Check now reads the other profiles again.
- `dismiss`: an entry's × dismisses that one.
- `clear-done`: Clear done, in the header, dismisses the completed entries under the current filter.
- `auto-dismiss`: a days field, empty (Off) by default. Whole days from 1 to 365 save on Enter, on leaving the field, or when Settings closes. Any other value isn't saved, and an alert says what is still in effect.

## How to get to it (user POV)

- The tray menu's Open Inbox (ADR 0097). The rail has no Inbox button.
- Settings (Ctrl+,) → Chats → Rail inbox, for the auto-dismiss setting.

## Driving it with wd.mjs

Preconditions:

- `HV_INBOX=1 $S/hv up`, so `work` holds "Morning brief, Monday" (Unread, 3 days old) and "Convert 12 GB to MB" (Unread, an hour old). Then sign in per [sign-in.md](sign-in.md).

- **A failure and an Approval.** Run `$S/wd.mjs press Control+n`, `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs keys 'fail this one\n'` and `$S/wd.mjs wait .msg overloaded`. Then do the same with `'needs approval to run\n'`. The rail has no Inbox button: `$S/wd.mjs eval 'return document.querySelectorAll(".rail [aria-label^=Inbox]").length'` prints 0.
- **Open.** The tray menu isn't available under Xvfb, and the frontend opens the inbox on the Tauri event `tray-open-inbox` that Rust emits when Open Inbox is picked (`src/hermes/tauriTray.ts`). The stand-in for that pick is one `eval` that emits the same event, the one place this feature goes around the real user path: `$S/wd.mjs eval 'window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "tray-open-inbox", payload: null }); return true'`. Then `$S/wd.mjs wait '[role=dialog]' Inbox` and `$S/wd.mjs click button "Check now"`. List the rows with `$S/wd.mjs eval 'return [...document.querySelectorAll(".inbox-row")].map(r=>r.className+" | "+r.querySelector(".inbox-title").textContent).join("\n")'`. There are four: approval, failed, and two completed. The ones that need you are `$S/wd.mjs count '.inbox-row:not(.kind-running):not(.is-ended)'`, which is 4.
- **Auto-dismiss.** Run `$S/wd.mjs press Escape`, `$S/wd.mjs press Control+,`, `$S/wd.mjs click button General`, `$S/wd.mjs click button Chats`, `$S/wd.mjs fill 'input[aria-labelledby=inbox-auto-dismiss-label]' -- 2` and `$S/wd.mjs press Enter`. Typing `14` first and pressing Enter changes nothing, because the `1` on the way is never saved. Open the inbox again as in Open, and press Check now. `$S/wd.mjs count '.inbox-row:not(.kind-running):not(.is-ended)'` is 3. "Morning brief, Monday" is gone, and the other three stay.
- **It is stored.** Read `$S/wd.mjs eval 'return Object.entries(localStorage).filter(([k])=>k.startsWith("hermes-chat.inbox-dismissed.")).map(([k,v])=>v).join("\n")'`. It shows `completed work brief` with `[its time, now]`. Clear the field and press Enter to set it back to Off, then `$S/wd.mjs close`, `$S/wd.mjs open` and sign in again. The entry is still gone.
- **Clear done.** With the inbox open, run `$S/wd.mjs click button "Clear done"`. Every completed row goes, Approvals and failures stay, and the button is gone.
- **Nothing reaches Hermes.** `bridge.log` has no PATCH for `brief` or `convert`.

## Gotchas

- The emit in Open was checked against the built app for #276: `plugin:event|emit` resolves and the inbox opens. If a later build drops `__TAURI_INTERNALS__` or the `core:event` permission, `eval` throws and the inbox stays shut. Say so rather than opening it another way.
- The tray's own count (`tray_inbox`) can't be read headless; the inbox's rows are what is counted.
- A failure is seen only on the socket, and Hermes keeps no error row a reload can read. After a relaunch, make a new one with a `fail…` prompt.
- The other profiles are read every two minutes. Press Check now rather than waiting.
