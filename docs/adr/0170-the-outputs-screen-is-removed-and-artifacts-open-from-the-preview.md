# The Outputs screen is removed, and Artifacts open from the Preview

> **Accepted** (#570). It supersedes ADR 0016 and ADR 0064 as far as the screen goes, and changes where an Artifact (ADR 0029) opens from.

The owner doesn't use the Outputs page and asked for it to go. The screen indexed the files Hermes's tools said they wrote (ADR 0016), kept that index on this computer, and checked where each file was each time it opened (ADR 0064). It was also the only way into the Artifact editor (ADR 0029): its Edit button opened a text Output beside the chat.

## Decisions

- **The screen goes, with everything only it used.** The rail button, the screen, its scopes, search, Add by path, Refresh, Check again and "Unsaved edit" mark are gone. So is the index (`OutputsIndex`), its reads of each chat's stored tool rows, its folder checks, and its document in local storage. No key, menu item or command opened it apart from the rail button.
- **Artifacts open from the Preview.** A Server file shown in the Preview has an **Edit** button (pencil) in the Preview's toolbar. It opens that same file, on that same machine, as an Artifact: one path in this connection and profile, read and saved as ADR 0029 says. Done in the editor goes back to the file's preview. A file reaches the Preview from a link in a reply, an opened tool call, the context inspector or the address box. Whether the file is text the editor can open is the editor's check, as before, so a file it can't open says why there.
- **What stays from ADR 0016 and ADR 0029.** The Artifact editor and its store, drafts, versions and proposals are unchanged. A draft is keyed by its file as before (`artifactKey`), so Edit on the same file brings the draft back. Showing a path with its hidden characters made visible (`shownName`, `shownPath`) and splitting a path into folder and name (`splitPath`) are used by Server files and the Preview, and moved to `serverPaths.ts`.
- **What stays in Connection diagnostics.** The `outputs` capability stays, with its check (`GET /api/fs/list`). Capability ids are part of the extension contract (ADR 0126, section 7): an extension may name `outputs` in `needs`, and removing the id would refuse its install and raise `api`, a major release. Its row now says it is used by extensions that list it, and the compatibility guide says the same.
- **What an older install kept.** The index lived in one local-storage document, `hermes-chat.outputs`. Nothing reads it now. It is deleted at launch (`dropRetiredData`), so a removed connection's file paths aren't kept forever, and a launch whose storage can't be written tries again at the next one.

## Considered options

- **Keep the index for file chips in the transcript or the Preview.** No other feature read it: file links in replies and tool calls come from the chat itself (`preview.ts`), and the Preview reads files directly.
- **Remove the `outputs` capability too.** Rejected for this change: it breaks the extension contract for an id no bundled extension uses. Dropping it belongs with the next raise of `api`.
- **Leave Artifacts with no way in.** Rejected: #570 asks that Artifacts keep working.

## Consequences

- Nothing lists the files a chat made any more. A file is found from the chat that made it.
- An Artifact knows the chat whose tool call named its file only as the sandbox it reads and saves in (below). "Ask Hermes to edit" borrows the model of the chat on screen when Edit was pressed, as Outputs lent the model of the chat that wrote it, and with no chat open it uses the profile's Text generation model.
- Edit opens the file the Preview shows, read the way the Preview reads it. A file a tool call names is in that chat's sandbox (ADR 0062), so the tool call's Preview link names the chat, as Outputs did. The Preview's read, and the Artifact's reads, saves and draft, name it too, so with a terminal backend that mounts a folder per chat, the same path in two chats is two files with a draft each. A path typed into the Preview's address box, or an instruction file from the context inspector, names no chat, and reads the profile's file at that path.
- ChatPane keeps "go to a tool call" (`JumpTarget.callId`), which only Outputs asked for. It is ChatPane's own, with its own tests, and nothing calls it now.
