# One link menu, and a server page reaches the browser only through the Preview

Issue #240. A link in a reply, a Side question, a Markdown file in the Preview or the Artifact editor opens in the Preview on a click. A right click showed WebKitGTK's own menu, whose Open Link replaces Hermes Chat's window. The owner wants three actions there: Open in the Preview, Open in your browser and Copy link.

## Decisions

- **One menu, owned by `LinksProvider`.** Main mounts it once (`src/ui/previewContext.tsx`) with the Preview's opener, the browser opener and the toast. Every link reaches it through one context function, so the Markdown `components` stay module-level (#224) and no link holds menu state. The menu keeps its own copy of the link, so a streaming reply re-rendering it (ADR 0068) leaves an open menu correct. Only one can be open.
- **The link decides the items, through `linkTarget`.** A link's `href` is parsed once (`src/hermes/preview.ts`) into one of three. A page that `checkWebUrl` passes gets all three items. A server page, on a loopback address, gets all three with Open in your browser shown but doing nothing. Anything else the Preview won't load (`mailto:`, a relative path, credentials, the app's own origin) gets only Copy link. A same-page `#anchor` gets no menu and keeps WebKit's own. react-markdown empties the address of any scheme it doesn't trust, such as `file:` or `javascript:`, before the link renders. Such a link has nothing to open or copy, so it gets no menu, and WebKit's is blocked too, because its Open Link would load this window's own page. Keeping those addresses would mean replacing react-markdown's URL check, which also keeps `javascript:` out of the page.
- **A server page goes to the browser only through the Preview.** Its address names the Hermes server's loopback. This computer's browser would open this computer's port, a different page or nothing. The Preview's own button opens it through the page's SSH tunnel while the page is shown (ADR 0114). The menu's item says so in a note under it rather than opening the Preview and the browser together: that browser tab would die as soon as the Preview moved on.
- **Copy link copies the address that opens.** For a page or a server page it is the checked URL the Preview loads, the same as the Preview's own copy button (a normalised host, a trailing slash added). For anything else it is the link as written.
- **A tool call's web page chips get the same menu.** Their server file and Output chips have no address to open elsewhere and get nothing new.
- **The keyboard opens it too.** The Menu key and Shift+F10 send a `contextmenu` with no pointer position; the menu then opens under the link's first line, as the chat list's does.

## Considered options

- **Menu state in each link, with the browser opener and the toast added to the Preview's context.** Rejected: every link would hold a bag of App capabilities and state for a menu almost never open, and a streaming re-render could drop an open menu.
- **A native Tauri menu.** Rejected: a second menu system beside `Menu`, styled by GTK, whose items need the same App capabilities.
- **A working Open in your browser for a server page**, opening the Preview, waiting for its tunnel, then the tunnel's address. Rejected for the reason above.
