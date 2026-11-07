# An extension runs in a worker behind a sandboxed frame, and reaches the app only through calls the owner granted

> **Proposed** (#100). Nothing here is built. The owner settles the open questions at the end before the first implementation PR.

Issue #100 asks for a way to add optional integrations without adding privileged code to the app each time. Today every feature is app code, and app code has every power the app has. The app's webview can call all 101 Rust commands in `invoke_handler` (`src-tauri/src/lib.rs`), and no capability limits which ones. Among them, `password_load` returns the saved password, `hermes_send_file` reads any local path the webview names, and `terminal_open_local` starts a shell. So the question this ADR answers is where an extension's code runs so that it has none of these powers, and what it gets instead.

## Words

- **Extension.** A package of code from outside this repository that adds commands and views. It runs only in the sandbox that section 1 describes, even when it ships with the app. This ADR doesn't call these packages plugins, because GLOSSARY.md already uses "plugin" for Hermes's own server-side plugins (under Toolset, MCP server, Memory provider and Skill). The GLOSSARY entry waits until the owner accepts the name (open question 1).
- **Built-in module.** Code in this repository, reviewed and shipped with the app. It runs in the app's page with the app's powers, as all code does today. The extension contract gives it nothing more, and no part of it loads at run time.
- **Grant.** The owner's yes to one permission that an extension's manifest asks for.

## What the probe found

The probe is in `docs/research/extension-isolation/`. To rerun it, run `xvfb-run -a python3 -I probe.py page.html` in that folder. It ran on WebKitGTK 2.54.2, the engine of the app's webview on Linux, under Xvfb. The probe's page stands in for the app's page. It has an `http:` origin and the CSP from the app's `index.html`, but it is not the app's own `tauri://localhost` page (Delivery, step 2).

| Test | Result |
| --- | --- |
| T1. A 2-second busy loop in a frame with `sandbox="allow-scripts"` (an opaque origin) | The page's 20 ms timer stalled for 2002 to 2027 ms in 6 runs. The frame runs on the app's main thread. |
| T2. The same loop in a worker that the frame started | The widest timer gap was 28 to 87 ms in 7 runs. The app's page kept running. |
| T3. A worker that loops forever, then the page removes its frame | In 2 runs the worker's last request came 30 ms and 50 ms before the removal, and none came in the next 2 s. Removing the frame stops its worker. |
| T4. A worker in a frame whose `srcdoc` starts with the CSP `default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:` | The CSP refused `fetch`, XHR, `importScripts`, `WebSocket` and `eval`. A nested worker started, and its `fetch` reached nothing. The worker's origin is `null`, and for that reason, not the CSP, `indexedDB.open` threw a `SecurityError`. |
| T4. Code in the frame's own realm, under the same CSP | It couldn't read `parent.document` or `localStorage`, and the CSP refused an image request. Setting `location.href` reached the probe's server, with data in the query string. |

T1 and the last row decide where the code goes. Code in a frame's realm can freeze the app and can send data out by navigating its own frame. Code in that frame's worker can do neither.

The probe puts each worker's source inside the frame's `srcdoc`. The design must not, as review round 1 showed on the same WebKitGTK. A source that contains `</script><meta http-equiv=refresh content=0;url=…>` closes the shim's script element, and the refresh navigates the frame to that address. T4's CSP doesn't stop it, because a refresh isn't a fetch or a script. So no byte of a package may reach an HTML parser (section 1).

## Decisions

### 1. The extension's code runs in a worker behind a sandboxed frame

- Each running extension has one host frame: an `<iframe sandbox="allow-scripts">` whose `srcdoc` the app writes. The sandbox has no `allow-same-origin`, so the frame's origin is opaque. ADR 0007's argument then holds for it: the frame can't read the parent's globals, so it can't learn the invoke key.
- The `srcdoc` is the same for every extension. It is T4's CSP, with the shim's SHA-256 hash in place of `'unsafe-inline'`, and a shim of a few lines. No part of a package is ever in it.
- **The app makes the channel.** Once the frame has loaded, the app creates a `MessageChannel` and posts one port to the frame's window, with the extension's source as a string. The shim takes only the first message whose `source` is `parent`, so another frame in the app's page can't hand it a port first. It makes a `blob:` of the source, starts one dedicated worker from it, and passes the worker the port. Then it ignores every other message. The shim never runs extension code, so nothing in the frame's realm can navigate the frame or hold the main thread.
- The extension's code runs only in that worker: off the main thread (T2), with no network or `eval` (T4) and no origin storage. The port is its only channel to the app.
- The app takes calls only from its end of the port. It never takes a port or a call from a `message` event on `window`. On Windows, web pages in the Preview are frames that can post such events (ADR 0007). On Linux they are in a separate view with no channel to the app (ADR 0081), but the rule is the same on both.

### 2. The contract is a manifest and JSON-RPC over the port

A package has a `manifest.json` and one script:

```json
{
	"manifest": 1,
	"id": "dev.example.chat-stats",
	"name": "Chat stats",
	"version": "1.0.0",
	"api": 1,
	"main": "main.js",
	"commands": [{ "name": "stats", "description": "Count this chat's messages and words" }],
	"views": [{ "id": "stats", "title": "Chat stats" }],
	"permissions": ["chat.read"],
	"needs": ["chat"]
}
```

- The app parses the manifest once, at install, into an `ExtensionManifest`. An `id` that isn't dot-separated parts of lower-case letters, digits and hyphens, at most 64 characters, refuses the install, so an id is always one safe folder name. So does an unknown key, a permission that isn't in section 3's table, a command name with anything but lower-case letters, digits and hyphens, or a version that isn't semver refuses the install with the reason.
- Calls are JSON-RPC 2.0 messages of plain JSON. The app checks each message against its method's shape, as `capabilities.ts` checks Hermes's answers.
- The app calls `activate {api, previousVersion}`, `command.run {call, name, arg}`, `view.render {call, id}` and `deactivate`.
- The extension calls one method for each permission (section 3), `view.update {id, tree}` and `log {level, text}`.
- **A call is the owner's action.** `command.run` and `view.render` carry a `call` id. Every data method except `storage`'s must name an open call, and the app takes the chat, profile and connection from that call, never from the extension. A call stays open until the extension answers it or misses its deadline. When the pane the call came from switches chat, profile or connection, the call ends, and a late answer is dropped, as ADR 0015 drops a command's late answer.
- **One call at a time for each extension.** While a call is open, another command or render for the same extension, from either pane (ADR 0010), is refused with a note that names the open one. This mirrors ADR 0015's one command at a time for each Draft.
- **No subscriptions in v1.** The app sends an extension nothing but `activate`, `deactivate` and the calls above. No chat events, no Hermes frames and no timers from the app reach it. So the resources that disabling has to release are the frame, the commands, the view and the open call (section 4).

### 3. Permissions are a fixed table, granted at install

| Permission | What the extension gets | When |
| --- | --- | --- |
| `chat.read` | The messages of the call's chat as the transcript shows them: role, text and time. No attachments and no tool output. | While its call is open |
| `chat.draft` | Text added to the call's chat's Draft. The owner sends it, or doesn't. | While its call is open |
| `project.read` | The name and folders of the call's chat's project (ADR 0007, projects). | While its call is open |
| `storage` | Up to 1 MB of its own JSON, kept separately for each connection and profile (section 8). | Any time. The one exception to the open-call rule. |

With no permission, an extension has its command's argument and nothing else.

- v1 has no permission to send a message, reach the network, call Hermes's JSON-RPC or REST, read files, read credentials, or read any chat but the call's. The app's broker has no method that returns a password, a header value or a token. Credentials stay where ADR 0058 keeps them.
- The install dialog lists each permission with one line on what it means, and the owner grants all of them or doesn't install. In Settings → Extensions the owner can withdraw any grant later. A call that needs a withdrawn grant gets `permission_denied`, and the app logs it.
- An update that asks for a permission without a grant waits as the extension's `pendingUpdate` (section 4), shown as **Needs your OK**, and the old version keeps running until the owner says yes. An update that asks for fewer permissions drops the grants it no longer names.
- Any grant change restarts the extension (removes its frame), so nothing it read under the old grant stays in its memory. An extension with `chat.read` and `storage` can copy what it read into its storage, and the app can't tell which stored data came from a read. So withdrawing `chat.read` or `project.read` also deletes the extension's storage for every connection and profile, and the dialog says so first.
- The permission table is one typed registry, as `CAPABILITIES` is in ADR 0044. Each entry names its methods and the call state it needs, so the broker is one pure check of the table against the call.

### 4. A missed deadline, a throw or a broken message stops the extension

- An installed extension has three separate parts. `installed` is the version on disk, with its grants, and is `Usable`, `Incompatible` or `Disabled`. `runtime` is `Stopped`, `Starting`, `Running` or `Failed {reason, at}`. `pendingUpdate` is optional: a newer version that waits for the grants it asks for (section 3). An update that waits doesn't change the running version's `runtime`.
- It starts on first use, when the owner runs one of its commands or opens its view. It stops after 5 minutes with no open call and no view on screen.
- Deadlines: 5 s for `activate`, and 10 s for a command or a render. While the extension runs, the app also sends `ping` every 10 s, with a 5 s deadline. A worker in a busy loop can't answer, so a silent loop is stopped within 15 s even while its view stays on screen. On a missed deadline, the app removes the frame (T3), and `runtime` becomes `Failed` with the reason. An uncaught error in the worker, which the shim passes on, does the same. So does a message that isn't valid JSON-RPC, is over 256 KB, or comes more than 50 times in a second.
- The message limits apply only after delivery. A worker's `postMessage` is copied onto the main thread, which the shim and the app share (T1), before the app can measure it. A very large message can still stall or crash the app's page. That is the same shared-process limit as memory (Consequences, open question 6).
- After `Failed`, the owner's next action starts the extension again. After three failures in 10 minutes it is disabled, and Settings → Extensions says why.
- Disabling or uninstalling removes the frame, its commands from the "/" menu and its view. Open calls end as cancelled. Uninstalling also deletes its files, its grants, and its storage for every connection.
- Settings → Diagnostics → Logs (ADR 0087) gets this app's own entries for each extension: each start and stop with its reason, each refused call with its method and permission, and each missed deadline. They go through the Logs redaction (ADR 0033).

### 5. Commands join the "/" menu after skills

- Extension commands come after the app's commands and the skills (ADR 0015), under the extension's name. Picking one fills in `/name `, and a second Enter runs it, as for every command.
- An extension can't take a name that the app's registry, an offered skill or an extension installed earlier has. That command isn't offered, and Settings → Extensions says why. Typing that name does what it does today.
- **This is an exception to ADR 0015.** ADR 0015 sends any "/" text that isn't in the app's registry as a message. While an extension that offers `/stats` is enabled, `/stats` runs that command instead, and "/stats" stops being a message. Starting the text with a space still sends it as a message, as ADR 0015 says.
- Running an extension command sends nothing to Hermes. The answer is a note under the composer, as ADR 0015's answers are, or an update to its view.

### 6. A view is a tree the app draws, never the extension's HTML

- `view.update` sends a tree of a few node kinds: `heading`, `text`, `list`, `table`, `facts` (label and value pairs), `notice` and `button`. A `button` runs one of the extension's own commands, so a click is an owner's action and opens a call. The tree has caps on node count and depth.
- `text` is Markdown drawn without raw HTML and without images. Replies render with `react-markdown`, and `Markdown.tsx` has no image rule, so a remote image in a reply loads (read in the code, not run). In an extension's view, that load would be a way to send data out. A link opens only after the owner's click, through the app's link menu and its address check (ADR 0079).
- **A view opens in the Preview**, as one more kind of item beside web pages, files and tool output (ADR 0007, ADR 0039). The side panel keeps its four tabs, as ADR 0055 and ADR 0066 decided. App components draw the tree, so a view gets the app's keyboard handling, focus, accessible names and narrow layout without extra work from the extension.

### 7. Install, update and compatibility

- **Source.** In stage 1, the only extension is the bundled sample (section 9), loaded from the app's resources. Install from a file comes in stage 3. The owner picks a `.zip` in the native Open dialog, which Rust runs, as for `preview_pick_local` (ADR 0007). Rust checks the limits on file count and on uncompressed size, both from the zip's index and again while it reads each file, so a small zip can't expand past them. It also checks the manifest and that no path leads outside the package. Only then does it copy the package to `<app data>/extensions/<id>/<version>/`. The webview gets an extension's code through one Rust command that takes the extension's id, never a path.
- **Provenance.** The install dialog shows the id, the version, the file the package came from, its SHA-256 and the permissions. v1 checks no publisher signature (open question 3). The app never downloads an extension or updates one by itself.
- **Updates.** The owner picks a newer file with the same id. A lower version asks first.
- **`api`.** The major version of this contract. The app supports one major version at a time. A manifest for another major version installs as `Incompatible`. It is listed but never started, and it says which major version it needs. Additions that don't break an extension, such as a new optional method or node kind, keep the major version. A call to a method the app doesn't have gets `method_not_found`.
- **`needs`.** `CapabilityId`s from `src/hermes/capabilities.ts`. While one of them is *Not supported* on the connection, the extension's commands and view show that capability's `CapabilityGate` note instead. *Unknown* still runs, because ADR 0044 holds a feature back only when Hermes lacks it.
- **Migration.** Moving an extension's own stored data to a new version is the extension's job. `activate` passes the `previousVersion` after an update.

### 8. Storage is per extension, connection and profile

`storage` is one JSON document for each extension, connection and profile. It isn't in `localStorage`, because WebKitGTK gives the app about 5 MB there, and the chat lists, the Saved copies and sign-in share it (`TRANSCRIPT_LIMIT_BYTES` in `src/hermes/chatCache.ts`). Rust keeps each document as a file under `<app data>/extensions/<id>/storage/`, named by the scope parts that `scopeParts` makes (`src/hermes/connections.ts`), with the 1 MB cap. It writes the file the way `defaults_file.rs` writes `project-defaults.json`. `forgetConnectionData` (`src/hermes/forgetConnection.ts`) deletes a connection's documents along with the defaults and tags files it already handles. So an extension can't carry data from one server or profile into a Draft on another.

### 9. A bundled sample, and an adversarial extension for tests

- **Chat stats.** `/stats` counts the call's chat's messages and words by role and shows them in its view, with `chat.read` only. It is bundled and runs in the sandbox as a third-party extension would, so it tests the sandbox.
- **An adversarial extension for tests only.** It never ships. It tries `chat.read` without a grant and outside an open call, then `fetch`, XHR, `WebSocket`, `importScripts`, `eval` and `indexedDB.open`. It posts to `parent` and `top`, calls a method that doesn't exist, and sends a 10 MB message. It also runs a busy loop and throws.

## Verification plan for the implementation

| The issue's acceptance item | How the implementation shows it |
| --- | --- |
| A benign sample, and an adversarial plugin trying chat, network and filesystem access | Vitest tests of the broker for each permission against each call state. A run in the real app (`verify-hermes-chat`) with both extensions, and a local listener that must receive no request. |
| Crashes, timeouts, disable and uninstall cleanup, incompatible versions | Broker tests with a fake port. In the real app, the adversarial busy loop with the app's timer gap measured as in T2, and the frame gone after the deadline. |
| Permission downgrade and upgrade, data scoping, no access through the host webview's origin | Broker tests for grants and for a switch while a call is open. T4 again in the app's own `tauri://localhost` page. |
| Chat sending, recovery, Approvals and server and profile isolation still work | The existing test suite, and a real-app run of a chat on two profiles. |
| The docs state storage scope, unsupported server versions and the limits of verification | README and `docs/compatibility.md`. No Hermes version is needed unless an extension's `needs` names one. |

## Delivery

1. This ADR, docs only.
2. Run the probe again in the app's own `tauri://localhost` page, and in WebView2 on Windows. If either result differs, this ADR changes before any code.
3. The broker, the host frame, the manifest parser, the bundled sample, and Settings → Extensions (enable, disable, grants, diagnostics). No install from a file.
4. Install from a file, update and uninstall, once the owner settles open questions 3 and 6.

## Considered options

- **Extension code in the app's page**, as Obsidian loads plugins. Rejected: the code would have all 101 commands, the password through `password_load` among them.
- **Extension code in a sandboxed frame's own realm**, as VS Code runs webviews. Rejected by T1 and by T4's last row.
- **A worker that the app's page starts.** Rejected: the worker would have the app's origin, and the app has no CSP to limit its network. `tauri.conf.json` sets `"csp": null`, and ADR 0007 decided against turning on Tauri's CSP.
- **A separate process: a plain WebKitGTK view on its own ephemeral context**, as the Preview's page view is (ADR 0081). This option would also contain a memory or crash bomb. Rejected for v1: it works only on Linux, and every message would need a relay in Rust. It is the fallback if open question 6 rules out the shared process.
- **WebAssembly in Rust**, such as wasmtime with fuel or epoch limits. This option has real memory limits and works on every platform. Rejected for v1: it adds a new runtime in Rust, extension authors need a new toolchain or a JS engine compiled to WebAssembly, and its host functions would be a second broker, in Rust.
- **HTML views from extensions.** Rejected for v1: HTML needs a frame's realm (T1, T4). A tree covers an informational view and uses the app's own accessible components.
- **Network access through Rust, to hosts the manifest names.** Deferred. It is the first remote action, and it needs the answer to open question 5.
- **Choosing permissions one by one at install.** Rejected: the owner can withdraw any grant afterwards in Settings → Extensions, so the install dialog stays one decision.

## Consequences

- An extension can't read credentials, local files or Hermes directly. It can read only the chat the owner ran it in, and only while that call is open.
- With `chat.read`, an extension sees what the transcript has, including any secret the agent printed. The install dialog says so.
- With `chat.read` and `chat.draft`, an extension can put text in the composer, which the owner may then send, and Hermes may act on it with its tools. The owner's Send and Hermes's Approvals are still the gate.
- With `chat.read`, a link in an extension's view can carry what it read in its address. The owner's click and ADR 0079's link menu are the gate, as Send is for a Draft. The install dialog says so.
- With `chat.read` and `storage`, an extension keeps what it read after the call ends, until `chat.read` is withdrawn or the extension is uninstalled.
- Workers share the web process with the app's page, and WebKit has no memory limit for a worker. An extension that allocates without end, or posts one very large message, could crash the app's page. This is a guess from WebKit's process model, and the probe didn't test it.
- Commands from extensions add a section to ADR 0015's "/" menu, and they make a "/" text that matches one of them a command instead of a message (section 5). Views add a kind of item to the Preview. The app's own command registry and the side panel's tabs don't change.

## Open questions

1. **Name.** "Extension", as proposed, or "plugin", as issue #100 says? The glossary uses "plugin" for Hermes's server-side plugins.
2. **Remote actions in v1.** None, as proposed, or `chat.send` with a confirmation for each send?
3. **Third-party install.** Local files only, as proposed. Should the app also require a publisher signature, with the key pinned for each id at first install and an update signed by another key refused?
4. **HTML views.** Are they ever wanted? If so, they need the separate-process option, which works only on Linux.
5. **Extension secrets.** An extension for an outside service needs an API key and the network. Should Rust keep the key in the keyring and add it to requests for the hosts the manifest names, so the extension never reads it?
6. **Memory.** Accept the shared web process for stages 3 and 4, as proposed, or require the separate process before install from a file opens?
7. **Numbers.** The deadlines (5 s and 10 s), the idle stop (5 minutes), the message cap (256 KB, 50 a second), the storage cap (1 MB) and the failure limit (3 in 10 minutes) are first guesses.
8. **Where views show.** In the Preview, as proposed, or in a fifth side-panel tab? A fifth tab reopens ADR 0055 and ADR 0066, which keep the panel to Preview, Terminal, Files and Screen.
9. **The first real extension.** Which integration does the owner want first? The contract should fit it before stage 3.
10. **Windows.** The probe ran only on WebKitGTK. WebView2 is untested (Delivery, step 2).
