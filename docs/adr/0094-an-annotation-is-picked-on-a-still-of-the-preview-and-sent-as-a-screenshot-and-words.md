# An annotation is picked on a still of the Preview and sent as a Screenshot and words

**Status: proposed (#96). Nothing is built yet. The owner's open questions are at the end.**

Issue #96 asks for a way to point at part of a web page and send that to Hermes as exact context, instead of describing where it is in words. The owner picks an element or a region, adds a note, reviews what will be sent, and the result waits in the composer until the owner sends it. Cookies, passwords, hidden values and tokens are never collected. When the app can't read a part of the page, the annotation falls back to a screenshot and a box.

## What exists today

Read in this repository on 2026-11-07, and in the deployed Hermes source (`f0d94882`, `/tmp/hermes-98/src`).

- **Hermes needs no new method to receive an annotation.** It takes images with `image.attach_bytes` and words with `prompt.submit`, the path every Screenshot already uses. No Hermes method or route lets a client pick, inspect or annotate a page element. Hermes's `annotate_preview` tool works the other way round: the agent marks the owner's Preview through the server→client request `preview.act`, which Hermes Chat refuses today.
- **The official Hermes desktop has this feature ("Browser Comment Mode", `apps/desktop/src/lib/preview-annotate/`), built entirely on the client.** It injects a script into its page view, picks with `elementFromPoint`, removes secrets from a copy of the element, and caps every field: text at 80 characters, the selector at 180, each style value at 80, HTML at 600. Then it adds `Comment_N.png` and a block of words to the composer. It never sends on its own. The design below takes its caps and its words format as a reference. It does not copy its in-page picker (see Considered options).
- **On Linux a web page in the Preview has a WebKitGTK view of its own, with no channel to the app** (ADR 0081). From Rust, `webkit2gtk` can run a fixed function in a named isolated world (`call_async_javascript_function`) and take a picture of the page alone, without the app's layers (`WebViewExt::snapshot`). Neither is used yet. App elements can't be drawn over the native view: on Wayland any overlap hides the whole page.
- **On Windows the page is a sandboxed cross-origin frame** (ADR 0007). App scripts can't read it. Rust could reach it only through WebView2's frame `ExecuteScript`, which runs in the page's own script world, where the page can replace any function the script calls.
- **Screenshots already have a lifecycle** (`src-tauri/src/screenshot.rs` `Captures`, `src/hermes/screenshots.ts` `ScreenshotDesk`). A capture is kept in a private folder. It is deleted when the owner removes it or leaves it behind, and kept for Retry while its message is unconfirmed.
- **The Preview is one per window,** shared by every pane, and cleared when the profile changes (`App.tsx`, `setPreview(null)` in the profile switch).

## Decisions

### One flow on a still image

1. **Annotate** is a button in the Preview's header for a web page or a Server page, next to the badge that says where the page is (`Server · <address>`, `This computer`, or the external site's host). Local files and tool output don't offer it.
2. Pressing it takes a **still** of the page as it is now. The live page stays loaded but is hidden, and the still takes its place in the pane. From here every mark, highlight and card is drawn by the app over the still, so nothing is drawn inside the page and nothing floats over the native view.
3. The owner moves the pointer over the still. On Linux the app asks the page which element is under that point, at most once every 100 ms, and outlines it. Up and Down select the parent or the first child. A click, or Enter, picks the element. A drag draws a region instead, which is always available.
4. A **review card** shows what will be sent: the still with the mark outlined, the page address, the time of the still, and each field from "What an annotation carries", with the owner's note last. **Add to message** stages it. **Cancel**, or Escape, discards the still and sends nothing.
5. **Add to message** stages the marked still as a Screenshot attachment named `annotation-N.png`, and inserts the words block at the composer's cursor. The owner can read and edit the words before sending. Sending stays the composer's Send.

The still makes every surface the same. Only two things vary by platform: where the still comes from, and whether element queries are possible. A surface without element queries offers regions only, with the reason shown on the card.

| Surface | Still | Element details |
|---|---|---|
| Linux, web page or Server page (native WebKitGTK view) | `WebViewExt::snapshot` of the visible area | Yes, through a fixed query function in an isolated world |
| Windows, web page or Server page (sandboxed frame) | WebView2 `CapturePreview`, cropped to the frame's box | No: regions only. "The app can't read this page on Windows." |
| A frame from another site inside the page | Part of the page's still | No: the mark is the frame's box. "This part comes from `<host>`, which the app can't read." |
| The Screen (Bot Desktop) | Not offered | See "Capability gap" |

### The element query is pull-only

The page never gets a channel to the app. Rust calls one fixed function, compiled into the app, with `call_async_javascript_function` in an isolated world named `hermes-chat-annotate`. It passes only numbers, a point in CSS pixels, as arguments. Nothing is joined into a script string. The function returns one plain JSON value, and Rust parses it against a fixed shape and caps each field again. The page can't send a message, can't see the function's objects, and can't call anything in the app. This amends the security boundary of ADR 0081: Rust may now ask the view one fixed question and read one answer. The view still has no IPC, no message handler, and no app origin.

Each query carries the still's generation. When the page navigates, the Preview changes, or the profile changes, Rust cancels queries in flight, and the app drops any answer for an older generation.

Same-origin frames are entered, up to four deep. A frame from another site stops the query there, and the answer names its host and box.

### What an annotation carries

The words block, as the composer shows it:

```
Annotation 1. annotation-1.png marks it in blue.
Page: http://localhost:5173/settings (Server page), still taken 14:02:31
Element: button, text from the page: "Save changes"
Selector: main > form#profile > button.primary
Box: 412, 380, 120 × 36 CSS px, in a 1280 × 800 view at scale 2
Styles: color rgb(255,255,255); background-color rgb(37,99,235); font-size 14px; padding 8px 16px
Note: make this match the secondary button
```

A region drops the Element, Selector and Styles lines and says why. A Server page shows the address the owner opened on the server, not the tunnel's local port.

The query function collects only these fields:

- **Element:** the tag, the `role`, and either `aria-label` or the visible text, with whitespace collapsed and capped at 80 characters. Text from the page is always quoted and labelled as the page's, so the agent reads it as data.
- **Form fields:** for `input`, `textarea`, `select` and editable elements, only the tag, the type and the label's text. The function never reads `value`, `checked`, `selected` or the text of an editable element. Password and hidden inputs are never described beyond "password field" or "hidden field".
- **Selector:** built from the tag, the `id`, up to two classes and `nth-of-type`, at most five levels deep, capped at 180 characters. An id or class longer than 40 characters, or one that looks like a secret (`key`, `token`, `secret`, `password`, `auth`, `session`, `credential`), is left out. The selector is shown and sent as text. Nothing ever runs it.
- **Box:** the element's box in CSS pixels, the view's size, the scroll position and the device scale.
- **Styles:** a fixed list of computed properties (display, position, size, margin, padding, gap, color, background color, border, border radius, font family, size, weight and line height, text alignment, opacity), each value capped at 80 characters. A value that contains `url(` is left out, since it can carry a signed address.

The function never reads `document.cookie`, storage, the page's HTML, or any attribute not listed above. The words block is capped at 1,500 characters. The still is a PNG of the visible area with the mark drawn on it, scaled down to at most 2,560 pixels on its longest side.

### When the page changes

- **Before the pick.** The query answer includes the scroll position and the view's size. If they differ from the still's, the page moved after the still was taken, and the app keeps the annotation as a region with "The page changed after the still. Element details are left out."
- **After staging.** On Linux, Rust sends a new page event with the address when the view's URI changes, which also catches in-page navigation. On Windows the frame's `load` event says a navigation happened, but not where. A staged annotation from an earlier page shows "Taken on `<address>` at 14:02. The page has changed since." on its chip. It still sends, since the words already carry the address and the time.

### Where it goes, and what is kept

- The annotation goes to the composer that last had focus, as a Screenshot does. The review card names that chat. If that composer is gone when the owner presses Add, the card says so and keeps the still until Cancel.
- The still is a capture in the existing `Captures` folder. It is deleted on Cancel, when its chip is removed, when the composer goes away, or when its message is confirmed, and kept for Retry while unconfirmed. This is the same lifecycle as a Screenshot.
- The annotation's address, time and page generation stay in memory beside the capture, only to label the chip. The words block is ordinary composer text, so it is kept in the chat's Draft like any other text.
- Nothing else is written. The page view's cookies and storage stay in its in-memory context (ADR 0081).

### Server versions

An annotation needs only what a Screenshot needs: `image.attach_bytes` and `prompt.submit` on the legacy protocol. Any Hermes that takes a Screenshot from this app takes an annotation, so no new Capability id is added. Whether the model looks at the image depends on the profile's model and Hermes's vision setting. The words alone carry the element, so an annotation still says what it points at to a model that can't see images.

## Capability gap in Hermes, and a proposed backend design

The Screen shows the agent's own browser on the Bot Desktop, with the agent's sign-ins. The client receives it only as pixels (RFB from `/api/display/ws`, or `display.thumbnail`). Only the agent's CDP tools reach its DOM, and no client method returns element details. So element annotations on the Screen need Hermes to add a read-only method, for example:

- `browser.inspect {profile, x, y}` on `/api/ws`: `{url, tag, role, text, selector, rect, viewport, styles}`, taken through Hermes's own CDP session with the same fields, removals and caps as above. Refused while the owner holds the Take over lease, and when the Bot Desktop has no browser (ADR 0078). Named in `client.capabilities` or the proposed `GET /api/capabilities` (ADR 0044), so the app can say when it is missing.

Until then the Screen offers no annotations (see open question 2).

## Considered options

- **An in-page picker, as the official desktop builds it.** It draws the highlight inside the page and waits there for a click. That needs a message handler or a long-running call in the page, and it draws app controls where a hostile page can see and change them. With the still, the app draws everything and asks the page only short questions.
- **A script message handler in an isolated world** (`register_script_message_handler_with_reply`). It works, but it gives the page a way to start a message to Rust, which is the channel ADR 0081 says the view does not have.
- **Element details on Windows through WebView2's frame `ExecuteScript`.** It runs in the page's own script world, so the page can replace `getComputedStyle` or `elementFromPoint` and return anything. The isolated world on Linux prevents that. Windows starts with regions only (open question 1).
- **The OS screenshot picker from `screenshot.rs` for the still.** It captures the app around the page and other windows, needs a portal dialog on some desktops, and gives no mapping from image pixels to the page's CSS pixels. The WebKitGTK snapshot captures the page alone.
- **A new `annotation` Attachment kind.** Saved outboxes and queues accept only `image` and `file` (`chatCache.isAttachment`), and the limits, previews, export and backup all branch on that. A sent chip shows only until the history reloads, so a structured summary in the chip would not last. A Screenshot plus words needs none of those changes.
- **The words as an attached Markdown file (`file.attach`).** The owner would not see the context inline before sending, and after a reload the message shows a raw `@file:` reference.

## Consequences

- **The page is hidden while the owner annotates.** A page that changes on its own, such as a video or a live chart, keeps running behind the still. The still is what is sent.
- **The words are editable.** The owner can change or delete what the query found before sending. This is how the owner sees all the context that will be transmitted. A page can put misleading text in its own elements, and the card and the words label that text as the page's.
- **Removing the image chip leaves its words** in the composer, and deleting the words leaves the image (open question 6).
- **Element details are Linux-only at first.** On Windows every annotation is a region.

## Verification plan for the implementation

Each acceptance check in #96, and how the implementation proves it:

- **Nested frames, navigation, scaled displays, changed DOM.** Rust tests for the query's answer parser and caps. Real-app runs through `verify-hermes-chat` against stand-in pages: a page with a same-origin frame and a cross-origin frame, a page that navigates after a still, a page that moves its content between the still and the pick, and a run at scale 2.
- **Cancel sends nothing, and cleanup releases the still.** The stand-in's log shows no `image.attach_bytes` after Cancel. The captures folder is empty after Cancel, after the chip is removed, and after the message is confirmed.
- **Hostile pages.** A stand-in page with a password field holding a value, a hidden input, a `data-token` attribute, an id like `session-8f3a…`, a `background-image: url(...?sig=...)`, 10,000 characters of text, and scripts that replace `Element.prototype.getBoundingClientRect` and `window.getComputedStyle` in the page's world. The words block must contain none of the secrets, must stay under its cap, and must show the real box.
- **Existing behaviour.** The full frontend and Rust suites, plus a real-app send, Retry, approval and profile switch with an annotation staged.
- **Limits of this verification.** WebDriver screenshots leave out the native view, so the page's pixels can be proved only by whole-screen captures. The Windows path can't run on this Linux machine and needs the Windows smoke test (#309). Whether the deployed model sees the image is checked once against the live Hermes and reported, not assumed.

Facts the first implementation PR must check before building on them: `WebViewExt::snapshot` works while the view is hidden and returns device pixels at scale 2; a hidden view still answers `call_async_javascript_function`; same-origin frames can be entered from the isolated world; and WebView2 `CapturePreview` leaves out app layers that aren't over the frame.

## Open questions for the owner

1. **Windows element details.** Keep Windows on regions only, or later accept WebView2's frame scripts, which a hostile page can fool, for element details? The default here is regions only.
2. **The Screen.** Offer region-only annotations on the Screen from its canvas now, knowing the image can show the agent's signed-in pages? Or wait for a Hermes `browser.inspect`? The default here is to wait.
3. **An HTML snippet.** The official desktop sends up to 600 characters of the element's cleaned HTML. Should annotations include it? The default here is no, to keep page content out of messages.
4. **Stale stills.** Should a staged annotation from an earlier page only show a label, or block Send until the owner confirms? The default here is a label.
5. **Which chat.** The Preview is shared by every pane. Should an annotation go to the composer that last had focus (the default here), or to the chat whose reply opened the page?
6. **Removing one half.** Should removing the image chip also remove its words block while the block is unedited?
7. **The name.** "Annotation" follows #96. The official desktop calls the same thing a "comment". Which word should the app use?
