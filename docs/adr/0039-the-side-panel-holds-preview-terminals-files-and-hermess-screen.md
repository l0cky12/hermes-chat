# The side panel holds the Preview, both terminals, Server files and Hermes's own screen

The pane beside the chat was only the Preview. The Terminal (ADR 0022) and Server files (ADR 0012) were screens that covered the chat, so the owner couldn't watch a reply while using either. The pane is now a side panel with four tabs: Preview, Terminal, Files and Screen. The rail's Terminal and Server files buttons open the panel at that tab. The panel keeps its edge, its width and its narrow-window overlay. A tab is made the first time it is opened and kept from then on, so a shell or the screen keeps running while another tab shows or the panel is closed.

## Decisions

- **A terminal on this computer too.** The Terminal tab has two shells: the server's, through the owner's own ssh as before, and the owner's login shell here (`$SHELL -l` if it is an absolute path to a file, else `/bin/sh`, started in `$HOME`). Rust picks the program and its arguments (`terminal::local_shell_command`), and the webview can only ask to start one. Each shell starts when its tab is first picked. Since ADR 0051 the Terminal opens on the side picked last, the server's until then.
- **The Screen is Hermes's Bot Desktop, not a browser of our own.** Hermes runs a headless Xfce desktop for each profile on the server. When it is running, the agent's `computer_use` and its browser tools draw there. Hermes owns every decision about it: whether it runs (`display.status`, `display.start`), and who may drive it (the lease, `display.lease.acquire` and `release`). The Screen shows `display.observe`'s single-use ticket stream from `/api/display/ws` in noVNC. It is read-only until the owner presses Take over. Hermes's own RFB filter drops input from anyone but the lease's holder, so `viewOnly` in noVNC is only for the interface. While the owner holds the lease, Hermes's computer use refuses to act.
- **Rust relays the stream** (`display.rs`). The webview can't open the socket itself: through the SSH tunnel its origin is `tauri://localhost`, which the dashboard's WebSocket check would refuse, and a direct sign-in's extra request headers (ADR 0104) can't be added to a browser WebSocket. Rust opens it on the signed-in connection, with those headers and no cookie, as `/api/ws` is opened. RFB bytes reach the webview raw as an `ArrayBuffer` on a channel, and go back as a raw request body. A small WebSocket-shaped adapter (`RelayedSocket`) hands both to noVNC.
- **Leaving hands back; a drop doesn't.** Hermes hands the lease back when a viewer closes with 1000 or 1001. A dropped link keeps the owner in control, since they may be part-way through a sign-in. The app keeps to that:
  - When the owner leaves on purpose (sign-out, or another profile), the app first releases the lease over `/api/ws`, on the connection whose viewer id Hermes accepts. That works even if the stream was lost while they held the screen. A second pick made meanwhile waits for it, and the latest pick wins.
  - When the Screen lets go of its stream (it goes, or watches again), the relay closes normally.
  - When the connection goes for any reason, Rust drops every stream with no close frame (`close_all`), and the Screen sends nothing either. So a connection that drops leaves the owner in control, and the Screen watches again once the connection is back.
- **A page in the Preview runs only while it is on screen.** Shells and the screen keep running in a hidden tab, but a web page or file doesn't. A closed or covered Preview stops, as before, so a page can't keep playing out of sight.
- **No CSS containment on the panel's tabs.** A container query would make the tab the containing block for fixed elements, and confine the Files dialogs, which must cover the whole window, to the panel. The app tells the panel when it is narrow instead.
- **Not installed means a command, not an install button.** When the server lacks the desktop packages, the Screen shows what's missing and Hermes's own install command, with a copy button, to run in the Terminal tab. `display.install` would need the masked `display.install.sudo` request, which this app doesn't answer yet.

## Considered options

- **A remote browser of our own** (a headless Chromium on the server with a screencast, or the official desktop's browser pane). Rejected: the agent's browser and computer use already run on the Bot Desktop, with Hermes's takeover lease. Another browser would be one the agent can't see.
- **Computer use on this computer** (the agent driving the owner's own desktop). Not built. Hermes's `computer_use` runs where the gateway runs. Driving this desktop from a remote agent would need a local driver and a new trust boundary that this app doesn't have.
- **Keeping the Terminal and Server files as covering screens, with panel tabs as well.** Rejected: there would be two of each, with sessions and transfers that are hard to tell apart.
- **A local file browser in the Files tab.** Rejected: ADR 0007 keeps the webview from naming local files to read. The local terminal can do that.

## Consequences

- A local shell runs as the owner, with everything they can do in any other terminal. The webview could already run anything on the server through the server's terminal. Now it can do the same on this computer, so a script injected into the app's own page would have both. Framed content still can't reach the IPC (ADR 0007).
- The Screen keeps its stream open while the panel is hidden, as the official desktop does. That costs bandwidth while Hermes's screen changes.
- The Screen needs Hermes with `display.*` (September 2026 or later), a Linux server and the desktop packages. Without them the tab says which is missing.
- noVNC (`@novnc/novnc` 1.7.0, MPL-2.0, the version the official desktop uses) loads only when a screen is first watched.
