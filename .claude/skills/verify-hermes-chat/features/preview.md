# Preview

The side panel's Preview tab is a small browser only the owner drives. One toolbar row holds Back, Forward, Reload, an address box with a location badge inside it (Server, This computer, Web, Tool output), Open in your browser and a ⋯ menu. With nothing open it shows "Nothing open" and the dev servers listening on the Hermes server and on this computer. A link clicked inside the page moves the address and adds to Back. Hermes can't drive it: its `preview.read` and `preview.act` requests are turned down.

## Sub-features

- `preview-empty`: "Nothing open", the Dev servers list (each row tagged Server or This computer, with the program's name when known), its refresh button, the reason the server's side is empty, and Open a file on this computer.
- `preview-address`: the address box takes a web address, `localhost:3000`, a bare port (`5180` is a Server page) or a server path; Enter on the same address reloads; Escape puts back an edit.
- `preview-follow`: a link clicked inside the page moves the address and enables Back.
- `preview-back-forward-reload`: Back and Forward go back and forward in the same page view (the page comes from the page cache, no new request); Reload loads it again.
- `preview-badge`: clicking the badge of a loopback page opens it from the other side.
- `preview-second-view`: after a file in between, Back makes a new page view; keys, Escape and a menu over the page still work.
- `preview-hermes-asks`: the stand-in asks the app `preview.read` and every `preview.act` action; each answer is -32601 and the page doesn't move.

## How to get to it (user POV)

- The chat header's **Open the side panel**, then the **Preview** tab.
- A link in a reply (opens it in the Preview), a tool call's page or file chip, or Outputs' **Preview**.
- In the empty Preview: a **Dev servers** row, the address box, or **Open a file on this computer…**.

## Driving it with wd.mjs

Preconditions:

- Signed in per [sign-in.md](sign-in.md). A dev server of your own on this computer, with links between pages, on a port below 32768: for example `python3 -m http.server 5180 --bind 127.0.0.1` in a folder of HTML files, started by you and killed by its PID afterwards.
- The page shows in a native WebKit view over the pane. WebDriver can't see into it and `wd.mjs shot` doesn't draw it, so press inside the page with `$S/hv x` (mousemove, short sleep, mousedown 1, about 120 ms, mouseup 1) and capture with `$S/hv shot`.
- A helper for the toolbar's state: `$S/wd.mjs eval 'return document.querySelector("input[aria-label=Address]").value + " | " + [...document.querySelectorAll(".preview-toolbar .icon-btn")].slice(0,3).map(b => b.title + "=" + (b.disabled ? "off" : "on")).join(", ")'`.

- **Empty.** Run `$S/wd.mjs click button "Open the side panel"`, then `$S/wd.mjs wait h2 "Nothing open"` and `$S/wd.mjs wait .preview-dev "localhost:5180"`. `$S/wd.mjs text .preview-devs` lists `localhost:5180 This computer python3` and, on the stand-in (a URL sign-in), "Sign in through SSH to see the Hermes server's dev servers." Back, Forward and Reload are off.
- **Open a dev server.** Run `$S/wd.mjs click .preview-dev "localhost:5180"`. `$S/wd.mjs value input Address` prints `localhost:5180`, and `$S/wd.mjs text ".preview-address .where"` prints `This computer`. `$S/hv shot` shows the page over the pane.
- **Follow a link.** Find the link in an `hv shot` and press it with `$S/hv x`. The address prints the page's path (`localhost:5180/notes.html`) and Back is on.
- **Back, Forward, Reload.** Run `$S/wd.mjs click button Back`, then `Forward`, then `Reload`, reading the toolbar after each. Back and Forward make no request to the dev server (its log shows none, and a page that prints its load time shows the earlier time); Reload makes one.
- **Bare port.** Run `$S/wd.mjs fill input Address -- 5180` and `$S/wd.mjs press Enter`. The badge reads `Server`; on the stand-in, `$S/wd.mjs wait [role=alert] "No SSH target"`, then `$S/wd.mjs click button "Open on this computer instead"` switches the badge to `This computer`.
- **Second view.** Run `$S/wd.mjs fill input Address -- /etc/hostname`, `$S/wd.mjs press Enter` (a file, which ends the page view), then `$S/wd.mjs click button Back`. The page loads again. Run `$S/wd.mjs click button More` and `$S/hv shot`: the menu is drawn over the page. Press inside the page's text field with `$S/hv x` and run `$S/hv x type "typed by the owner"`: the text shows in the page. Run `$S/hv x key Escape`: the panel stays open and `document.activeElement` is `.preview-web-frame`. A second `$S/hv x key Escape` closes the panel.
- **Hermes asks.** Open a chat so it has a live session (`$S/wd.mjs click button Settled`, `$S/wd.mjs click button "Nightly backup failing"`), and reopen the Preview. Then for each method and action run `curl -s -XPOST "$DASHBOARD_URL/__ask?chat=backup&method=preview.act" -d '{"action":"click","ref":"e1"}'` (and `method=preview.read`). It prints the request's id. `curl -s $DASHBOARD_URL/__state` lists each under `answers` with `"code": -32601`. The address, Back and Forward read as before, the dev server's log shows no request, and `hv shot` shows the same page.
- **Proof.** Keep the numbered `hv shot` images, the dev server's log, and `/__state` saved after the asks.

## Gotchas

- On a busy box the This computer list shows other people's servers too. Ports from 32768 up are left out as the system's own, so start yours below that.
- A Server page needs an SSH sign-in. On the stand-in (a web address sign-in) it stops at "No SSH target for this server"; the switch to this computer is the path to drive here.
- `wd.mjs` can't type into the page itself, and `wd.mjs press` sends keys to the app's webview, not to the page view. Use `hv x` for anything inside the page.
- `/__ask` needs the chat's live session: open the chat in the app first, or it answers 400.
