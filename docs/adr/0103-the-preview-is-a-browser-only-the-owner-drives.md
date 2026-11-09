# The Preview is a browser only the owner drives

Issue #376. The owner uses the side panel's Preview to look at what they are building, as T3 Code's Browser panel does. It had no Back, Forward or Reload beside its address, its address didn't follow a link clicked inside the page, and opening a dev server meant typing its whole address. Hermes must not be able to drive it: no click, typing, navigation or screenshot of the page by a tool. Only the owner controls it.

## Decisions

- **One toolbar row.** Back, Forward and Reload, then an address box that is always there to edit, with the location badge inside it, then Open in your browser and a ⋯ menu. The menu holds Copy address, Open a file on this computer, and the note that a page runs on its own with no access to Hermes Chat. The title header, its `+` button, the start view, the switch row above a loopback page and both "runs on its own" note rows are gone. ADR 0094's Annotate button goes in this row, after the address box.
- **The app owns one history** (`src/ui/previewHistory.ts`). It is a zipper of what the Preview showed: `back`, `here`, `forward`, and a count of reloads. `null` is the empty state, so there is no `start` target. Entries are what the owner sees: a page, a Server file, a Local file, an Output, a tool's output. A Server page is kept as `http://localhost:5173/a` on the server, never as its tunnel's address, which dies with the tunnel. One reducer changes it, on seven steps: open, switch, back, forward, reload, arrived, clear. `App.tsx` holds it, so it outlasts the pane, which is mounted only while shown (ADR 0039). Coming back to the Preview tab shows where the owner left it, with Back still there. Another profile clears it.
- **The page reports its moves, and the history follows them.** `arrived` is the only step the page causes. Rust says whether a move takes the current entry's place (`replace`): where a load the app asked for landed, a redirect, `replaceState`, `location.replace`. Otherwise the history uses its neighbours: the entry behind means the page went back itself, the entry ahead means forward, and anything else is a new entry. At most 50 entries are kept behind.
- **One page view for each run of web entries** (`src-tauri/src/page_view.rs`). The pane makes a view when a web entry shows and ends it when a file, an Output or tool output shows, or when the Preview hides. Rust removes the view from the overlay and drops it, so its page, its web process and WebKit's back-forward list end with it. Every view shares the app run's one ephemeral web context, so a site's sign-in lasts the run, as before. This replaces ADR 0081's single view that loaded `about:blank` on close.
- **`go` reaches an entry the way a browser would.** The pane asks the view to `go` to an entry's address. If WebKit's back item is that address, the view goes back; if its forward item is, forward; otherwise it loads it. So a page comes back from WebKit's page cache, with its scroll and an SPA's state, and makes no request. WebKit's list is only consulted for how to reach an entry the app chose. When the two lists disagree, the result is a load. `reload` is a command of its own, so a page's own move never turns into a reload. The pane doesn't send `go` for an address the view already reported.
- **The view stays over the page while the next one loads.** It shows once the first page commits. After that, a load the app asked for keeps the old page on screen until the new one commits, and Reload's icon turns while it loads. A load that fails hides the view, and the pane says why.
- **A Server page's tunnel stays open while web entries follow one another.** The tunnel is for an origin on the server. A web page elsewhere, or a page on this computer's loopback, keeps the tunnel there is. So Back from a reply's link to the dev server goes back in the same view through the same port. The tunnel closes when a file or other non-web entry shows, when an entry needs another server origin, or when the Preview hides. Reload doesn't open a new one. Reload, or Try again, opens a tunnel that failed or closed.
- **The badge is the switch.** For a page on a loopback address, the badge reads **Server** or **This computer**, and clicking it opens the same page from the other side. Switching takes the entry's place, so it doesn't fill Back. A loopback address typed on the origin shown stays on the side it is shown from.
- **The address box** takes what it took before, plus a bare port: `5173` opens `http://localhost:5173/` as a Server page. Enter on the address shown reloads it. A move made elsewhere (a link in the page, Back) replaces the box's text, unless the owner is typing in it, and Escape puts the address back.
- **The empty Preview lists dev servers** (`src-tauri/src/dev_servers.rs`). On the Hermes server, `ss -ltnpH` runs over the sign-in's SSH target, with the tunnels' ssh options and spawner, for at most 10 s and 64 KiB of output. On this computer, Rust reads `/proc/net/tcp` and `tcp6` and leaves out this process's own sockets, found by inode under `/proc/self/fd`; another program's name comes from `/proc/<pid>/comm`. A port is listed when it is bound to loopback or every address, between 1024 and 32767, not a database or broker's usual port, not ssh's, and on the server not the dashboard's. Ports from 32768 up are where Linux puts a program that asks for any free port, which in the real app were test drivers and tunnels' ends. The list loads when the empty state shows, when the connection comes or goes, and on its refresh button; it isn't polled. Each reason the server's side is empty is its own state: a web address sign-in has no SSH target, the app isn't connected, or ssh or `ss` failed.

## What WebKit does

Settled first, on WebKitGTK under Xvfb, and kept as `page_view::tests::a_view_reports_each_move_once` (`--ignored`, it needs a display):

- `load_uri`, `go_back` and `go_forward` set the view's `uri` and fire `notify::uri` inside the call, before `load-changed Started`. Rust marks a load the app asked for before it calls WebKit, and reports nothing from `notify::uri` until that load commits. Without that, a redirect the app asked for was two entries.
- `pushState` grows the back list by one; `replaceState` and `location.replace` keep both lengths; a fragment pushes; the page's own `history.back()` moves an entry from back to forward. So both lengths unchanged means `replace`.
- A link the page follows fires `notify::uri` between `Started` and `Committed`, with the lengths already changed. A 302 fires it at `Redirected`. Rust reports the move once, at the commit.
- A move within the page the app asked for (a fragment, or back to a `pushState` entry) never starts or commits a load. It ends when `is-loading` goes false at the asked address. A failed or stopped load puts the old address back and says so just before `load-failed`; Rust doesn't report a move when nothing moved.

## The Hermes boundary

Hermes reaches the app only through the transport's server requests. Its `read_preview`, `drive_preview` and `annotate_preview` tools ask `preview.read` and `preview.act`, and the transport answers every request but `approval` with JSON-RPC -32601 (`src/hermes/transport.ts`). Real Hermes offers those tools only to a session whose platform is `desktop` (`tui_gateway/agent_factory.py` `_gui_surface_toolsets`). Three checks keep it that way, and each was seen to fail against a transport that answered `preview.act`:

- **Behaviour** (`src/ui/previewPane.test.tsx`): with a dev server open and a link followed, `preview.read` and `preview.act` with every action (elements, click, hover, type, scroll, press, strobe, back, forward, reload, pin, hold, unpin) each get -32601, and the page view, its tunnel, the address and Back are as they were. It also catches a handler that answers -32601 but moves the page anyway.
- **Structure** (`src/ui/previewBoundary.test.ts`): the transport's imports reach no `ui/` module; only `ui/tauriPreview.ts` names the page view's, tunnels' and dev servers' commands; only `App.tsx` takes the real page view and tunnels.
- **Rust**: the commands are `#[tauri::command]`s on the main window's invoke key, and `go` checks the address with `web_page::web_url`. The page view still has no IPC (ADR 0081).

The verify stand-in's `POST /__ask` control asks the real app the same requests; each answer in the real app was -32601, and the page didn't move.

## Considered options

- **WebKit owns history, as in T3 Code.** Rejected: files and tool output can't be entries, history dies with the view on every tab switch, and a closed tunnel's port would sit in the list.
- **The app's history, with every Back a load.** Rejected: every Back in a dev server reloads the whole app, losing its state and its HMR connection. The chosen `go` falls back to exactly this when WebKit's neighbour doesn't match.
- **One view for the app run that blocks traversals outside the app's list.** Rejected: more Rust and more state than a view per run of web entries, which the real app showed keeps keyboard focus, Escape and X11 holes under a menu.
- **Treating every page-reported address as a new entry unless a load is in flight.** Rejected: `replaceState`, a page's own `history.back()` and a redirecting link each made a duplicate entry, which is wrong for ordinary SPA dev servers.
- **A stable local port per server origin.** Rejected: Rust would hold a port on this computer while nothing shows, against ADR 0052.
- **An ESLint rule for the boundary.** Not possible: the repo has no ESLint. The import-graph test does its work.
- **A typed port with recent ones instead of detection.** The owner didn't choose; detection was the default asked for, and the address box takes a bare port anyway.

## Consequences

- **A page's move that lands in the same tick as the owner's Back can leave one extra entry.** Accepted rather than designed for.
- **Back after another tab or a file in between is a load**, since the view that had the page cache ended.
- **A Server page's tunnel stays open while the owner browses other web pages in the Preview**, by design, until a non-web entry shows or the Preview hides.
- **On Windows the frame can't report its moves.** Back, Forward and Reload go through the app's history and reload the frame; a link followed inside the frame doesn't move the address, and the ⋯ menu says so.
- **A link inside a Server page to another loopback address loads that address on this computer**, not through a tunnel, as it did before this change. The address box then shows it as a This computer page.
- **A page view per run of web entries means a web process per run.** Only one runs at a time, and none while the Preview shows something else.
- **History isn't kept across restarts.**
- **The dev server list can be stale** until it is shown again or refreshed.
- **There are no keyboard shortcuts for Back and Forward yet.**
- ADR 0081's last consequence (a followed link doesn't change the address) and its `about:blank` close no longer hold. ADR 0052's switch row and its "Reload opens a new tunnel" no longer hold.
