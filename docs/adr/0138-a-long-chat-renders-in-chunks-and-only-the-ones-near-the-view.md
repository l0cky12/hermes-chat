# A long chat renders in chunks, and only the ones near the view

Issues #453 and #454. A long chat was slow and heavy because every message was in the page. In a 1000-turn chat (4,968 blocks) each streamed delta took a frame of about 40 ms in WebKitGTK 2.54, since the browser laid out every block again. The web process used about 190 MB signed in, 670 to 765 MB with that chat open, and still 410 to 458 MB after switching to another chat.

Grouping the blocks into memoized chunks (#453) brought the frame to 25 to 29 ms. Memory did not move, because every message was still in the page.

## Decisions

- **The transcript's blocks are grouped into chunks of about 64** (`src/ui/transcriptChunks.ts`). A chunk starts at a block whose id hashes to a multiple of 64. Where a chunk starts depends only on that block, so adding or removing a block changes one chunk and the others keep their key. Each chunk is memoized: a streamed delta renders only the chunk it changes.
- **Only the chunks near the view are in the page** (`src/ui/transcriptWindow.ts`). These are the chunks in view, and one view's height of them above and below. One spacer stands in for the chunks before them and one for those after, each as tall as the chunks it replaces.
- **A chunk's height is measured while it is in the page and remembered** for as long as the pane is open, until the pane's width changes. A chunk never measured is taken to be as tall as the measured average for its number of blocks. That estimate is taken again only when the window moves, so a reply streaming at the bottom does not resize the spacer above it every frame.
- **The window is placed again** once a frame while scrolling, when the pane or its content changes size, and when the chat changes. Chunk positions are counted from a chunk that is in the page, so a wrong estimate for a far chunk does not move the window.
- **The transcript keeps its own place.** WebKitGTK 2.54 does not anchor this scroller (#418). When the window changes, the first chunk in view is put back where it was, in the same commit, before the page is drawn. `.transcript` has `overflow-anchor: none`, so a later WebKitGTK that anchors cannot correct a second time. At the bottom of the chat, following the stream comes first.
- **Some chats render whole**: a chat of four chunks or fewer, a chat with a find query, and a pane whose scroller has no height yet (a pane mounted hidden, or a test without layout). Find marks and counts its matches in the page, so it needs every message there.
- **Going to a message looks in the chat, not the page.** Jump-to (a stored row, a turn, a tool call), Show in chat and Go to the Approval find the block's chunk in the chat's data and render it before they look for its element. An Inbox or office entry's message or waiting Approval is passed to its pane, which keeps that chunk rendered until the app has scrolled to it. The window then stays around it. A jump reports a message as missing only when the loaded history does not have it.

## Measured

On 2026-11-11, against main `2a7e829e`, each build run in turn with the other:

- The real app with a 1000-turn chat open: the web process holds 225 to 228 MB, down from 692 to 701 MB, and 219 to 221 MB after switching to a short chat, down from 410 to 412 MB. It is 193 MB after sign-in on both (`bench/app-split/memory.sh`).
- The real app streaming into an 800-turn chat: a frame takes 18 to 20 ms at p50, down from 89 to 97 ms (`bench/app-split/run.sh 800 … single`).
- The bench page in WebKitGTK at 1000 turns: a streamed frame takes 16 to 20 ms at p50, down from 35 to 73 ms. Opening the chat takes 128 ms, down from about 3 s (`bench/webkit.py`).
- Wheel steps of 150 and 400 px move the view that far, find counts the same matches as main, and the view holds still above a streaming reply and follows it at the bottom (`bench/app-split/window.mjs`).

## Considered options

- **`content-visibility: auto` on each block** (#418). Rejected: WebKitGTK does not anchor the scroller, so scrolling up jumped by 790 to 1,620 px for a 600 px wheel step. It also clips the hover overhang of tool lines, and the messages would stay in the page, so memory would not fall.
- **`@tanstack/react-virtual`** (#454). Not needed yet: it adds a dependency of 10.3 KB gzipped and windows by row. Rows here are whole chunks with known keys, so the hand-written window is one small module. It stays an option if this one proves hard to keep right.
- **A window of single messages.** Rejected: messages differ a lot in height, so there would be many more estimates to get wrong and more scroll corrections. Find, selection and the per-message state would break at every scroll step, not only far from the view. A chunk is the unit that is already memoized.
- **Searching the chat's data for find**, so find could stay windowed. Not done: find marks what Markdown shows, not the stored text, and its count is the number of marks. Rendering the whole chat while a query is typed keeps find exactly as it was.

## Consequences

- With a long chat open, the page holds a few chunks, not the whole chat. Typing a find query renders the whole chat until the query is cleared.
- Select all (Ctrl+A) and a selection dragged far across the transcript cover only the messages in the page. Selecting and copying one message works as before.
- A chunk that leaves the page loses what its messages kept only on screen: an opened tool group or thinking row closes, and focus inside it is lost.
- Scrolling fast into a part never seen shows the spacer for a frame, and the scroll bar's length shifts a little as estimates turn into measurements.
- A test without layout sees every message, as before. Tests of the window give the scroller and the chunks their sizes.
