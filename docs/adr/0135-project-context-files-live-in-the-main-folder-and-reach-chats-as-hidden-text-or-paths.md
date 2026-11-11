# A project's context files live in its main folder on the server, and reach its chats as hidden text or as paths

A project can carry reference files, as a Claude Project carries knowledge: templates, specs, notes. Files added on the project page's Context card are available to every chat in the project. This records where the files are kept, how chats get them, the two modes, and what Hermes lacks for it (#449).

## Where the files live

A project's context files are the files in `<main folder>/context/` on the Hermes server. The main folder is the project's primary folder (`ProjectFolder.primary`), which Hermes keeps with the project (ADR 0131), so every computer and every Hermes client agrees where it is. It is not the working-folder default (ADR 0017), which is this computer's.

**The folder is the list.** Nothing else records which files a project has: not this app, not Hermes's project record, which has no field for files. The card lists the folder each time the page opens, after every change made from it, and again before each message in one of the project's chats. A file the agent or the owner put there by other means is a context file like any other. Folders inside `context/`, hidden files and broken links are left out, and so is a link to a file elsewhere.

A `context` that is a link out of the main folder is refused. `GET /api/files` answers with the resolved path of what it listed, so the app lists the main folder, then `context`, and uses it only if its path is exactly `<main folder's path>/context`. Deleting a project leaves its folder and `context/` on the server, as it always left its folders.

### The folder this app makes

ADR 0131 and the glossary said Hermes Chat never creates a folder for a project. Context files are the one exception:

- When the project has a main folder, the first file added makes `context/` inside it.
- When the project has no folder at all, the first file added makes `<profile's folder>/projects/<slug>/context` on the server (`POST /api/files/mkdir`, which makes the folders above it too), then adds `<profile's folder>/projects/<slug>` to the project with `projects.add_folder`. Hermes makes the first folder added the primary one, so it becomes the main folder. The profile's folder is read from `GET /api/profiles` (`path`), never assumed. `<slug>` is the project's name in lower case, each run of other characters a hyphen, at most 48 long, or `project-<id>` when nothing of the name is left.

Nothing else changed: the project page still adds only folders that exist, and makes no repository or worktree.

### Git

When the main folder is in a Git repository, `context/` is kept out of it through that repository's `info/exclude`, which is local and never committed. Rust finds the repository (`GET /api/fs/git-root`), follows a `.git` file's `gitdir:` and `commondir` for a worktree, and appends one anchored line unless `info/exclude`, the root `.gitignore` or the main folder's `.gitignore` already has an equivalent. The app never writes a `.gitignore`. The repository isn't touched while `context/` doesn't exist, and not by the read made before a send. The card says `context/ is ignored locally in this Git repository` while the line is there.

## How the files are written

The window's REST relay refuses every write under `api/files` and `api/fs` (ADR 0012, ADR 0023), and that stays so. The Context card writes through its own narrow Rust commands (`context_pick`, `context_local_files`, `context_upload`, `context_write_text`, `context_mkdir`, `context_remove`, `context_read_text`, `context_git_exclude`). Each takes only a plain file name directly inside a folder named `context`, and refuses a hidden name and Hermes's credential names, because the dashboard's write routes don't apply the denylist its read routes do.

The Upload rules of Server files hold (ADR 0023): the card says where a file goes, a name that is taken is replaced only after the owner says so, and a file counts as written only once a fresh listing shows it at the size sent. A file over 30 MB is refused by name, and the rest of its batch still goes. Removing a file asks first and deletes it on the server.

## How chats get them

Every chat in the project gets the files: new chats, and chats already open. "In the project" is project membership (ADR 0109, ADR 0131), not the folder a chat works in, so a chat started elsewhere gets the files by their full paths. A chat in two projects gets both projects' files. Taking a chat out of a project stops its updates; what it already received stays in its history.

**A new chat** gets one more hidden seeded row in `session.create`, after the instructions row and by the same carrier (ADR 0017): `messages: [{role: "user", content, display_kind: "hidden"}]`.

**A chat already open** gets what changed since it was last told, with its next message. The app keeps a ledger on this computer (`hermes-chat.projectContext`, versioned, for each connection and profile as project links are): for each chat and project, the mode it was told in and, for each file's path, the version it knows (`<size>:<mtime>`) and whether it has had that version's text. Before each send the folder is read again and compared with the chat's entry. The entry is written only after Hermes accepted the `session.create` or the `prompt.submit`. A chat with no entry, such as one opened before this feature or just put in the project, has been told nothing and gets every file as added. The same text never goes to the same chat twice. A message Hermes may or may not have taken leaves the entry as it was, so the next message tells the chat again rather than risk telling it nothing.

A folder that can't be read when a message goes doesn't hold the message up: it goes as typed, and the next one tries again.

### The carrier for an open chat

Hermes has no route that adds a hidden row to an existing chat without running a turn: `prompt.submit {display_kind: "hidden"}` runs a whole model turn, with a visible reply, which would answer the context update before the owner's question. So the update rides on the owner's own message. The app appends

```
<the owner's message>

--- Attached Context ---

<what changed>
```

to the submitted text. That marker is the one Hermes itself writes when it expands `@file:` references, and both clients already hide everything from it on: the official desktop (`hydration.ts`) and this app (`typedText`, which the transcript now applies to every stored message of the owner's). Hermes stores the message once, so the text is in the chat's history for later turns, and the owner sees only what they typed. A sent message is matched in the history by the owner's words alone.

Hermes scans a submitted message for `@file:`, `@folder:`, `@git:`, `@url:`, `@diff` and `@staged`, expands them, and fetches a `@url:`. A context file's text must not trigger that, so in everything the app adds, a word joiner (U+2060) follows the `@` of each such pattern.

Considered and not taken: a hidden turn (a second reply the owner didn't ask for, and a model call for each update); `file.attach` (it stages a copy in the session's working folder, which is what project files are meant to avoid, and lets Hermes refuse past half the context window); sending nothing and relying on the agent to list the folder (a new file would go unnoticed).

## The two modes

- **Capacity.** 100% is half the context window of the project's default model, the share Hermes itself allows expanded files (`@file` expansion refuses past 50%). When the window isn't known it is 100,000 tokens. Hermes's model list names no context window, so the window is the `context_max` a chat on that model has reported in this app; until one has, and for a project with no default model, the card says it is using 100,000. Tokens are Hermes's own estimate, a token for every four UTF-8 bytes. A text file counts by its size, a PDF or Word document by its extracted text, and a file without readable text not at all.
- **Full-text mode** (at or under 100%). A new chat's hidden message holds each file's text under its path, then the paths of the files with no text. An open chat is told what was added (with its text), replaced (with its new text) and removed.
- **List mode** (over 100%). The message holds each file's full path, size and type, and tells the agent to open the ones it needs with its own file tools. The card shows a List mode badge. An open chat that was in full-text mode gets the whole list once, then only what changed, without text. Back under 100%, the next message sends the text of every file the chat hasn't had the text of.

The message texts:

```
Context files from the project "<name>". Every chat in this project has them. Each file's text follows its path.

## <path> (<size>, <TYPE>)
<text>

These files have no text to include. Open them with your file tools if you need them:
- <path> (<size>, <TYPE>)
```

```
Context files from the project "<name>" are too large to include here. They are in <folder>. Open the ones you need with your file tools:
- <path> (<size>, <TYPE>)
```

```
The context files of the project "<name>" changed since this chat last got them.

Added: <path> (<size>, <TYPE>)
<text>

Replaced: <path> (<size>, <TYPE>)
<new text>

Removed: <path>
```

## Text extraction is the app's

Hermes has no route that extracts a document's text, so Rust does it: a file that is valid UTF-8 with no NUL in its first 4 KiB is text; `.docx` is read from `word/document.xml`, a paragraph a line; `.pdf` through a PDF text extractor. Anything else, and any file whose extraction fails (a scanned PDF), is listed by its path in either mode and takes no capacity. Extracted text is kept in memory by path and version, so a file is read once until it changes.

## Profiles whose tools run over SSH

When a profile's `terminal.backend` is `ssh` (`GET /api/config?profile=`), the agent's tools and `/api/fs/*` run on the SSH machine, while the managed-files routes still see the dashboard's machine. Context files must be where the agent can open them, so for such a profile the card uses the agent's routes: `GET /api/fs/list` for the folder, `GET /api/fs/read-text` for sizes and text, and `POST /api/fs/write-text` to add a file. That route takes only text, up to 8 MiB, into a folder that already exists. So on an SSH profile:

- a text file is added; any other file is refused with `can't add this file to a project on an SSH profile yet`;
- the card can't make `context/` or a project folder, and can't remove a file, and says so instead of offering either;
- the listing gives no sizes or times, so a file's version is its text's size and a hash of it, and a file that isn't text shows without a size;
- `/api/fs/list` doesn't answer with a resolved path, so a `context` that is a link can't be told from a folder there.

## What Hermes lacks (capability gaps)

- **Binary write, mkdir and delete on the agent's file routes.** Proposed: `POST /api/fs/write` taking a multipart `file`, `path`, `overwrite` and `profile`, with the limits of `POST /api/files/upload-stream`; `POST /api/fs/mkdir {path, profile}`; `DELETE /api/fs {path, profile}`; and `size`, `mtime` and the resolved `path` in `GET /api/fs/list`. With them an SSH profile's Context card works as any other.
- **A hidden row on an existing chat.** Proposed: `session.append {session_id, messages: [{role: "user", content, display_kind: "hidden"}]}`, storing the rows as `session.create` seeds them and running no turn. With it an open chat's update would be a hidden row of its own, as a new chat's is, and the Attached Context carrier could go.
- **The credential denylist on the managed-files write routes.** `upload-stream`, `mkdir` and `DELETE /api/files` accept the names the read routes refuse. Until Hermes refuses them, Rust does.
- **A context window in the model list.** `model.options` names no window, which is why capacity falls back to 100,000 tokens until a chat has run on the model.
- **Project files in Hermes's project record.** With a field for them, the official desktop app and other computers could show the same card. Until then the folder is the record, which every client can at least browse.

The card is gated on the routes it needs: on a server without the managed-files routes (or, for an SSH profile, without `/api/fs/list`) it says what is missing and offers no button.

## The project page

The project screen is laid out as Claude's project page. The main column has a composer and the project's chats. The composer writes the New chat draft, and its Start chat opens the New chat pane and sends from there, so a chat started on the page starts by the one road every new chat takes (ADR 0017), with the project's defaults and context. Beside it, or below it when the page is narrow, are the Instructions card, whose pencil opens the instructions in the existing defaults form, and the Context card. The folders, the defaults, Rename and Delete are behind a ⋯ menu. There is no new-project dialog: a project is made by naming it, the app opens its page, and the Context card there takes the first files. Project-wide Outputs and an Activity tab are left for a later issue.

## Consequences

- The ledger is this computer's. A chat opened on another computer is told every file again there, once.
- A context update costs room in the chat's context each time the files change; a file replaced often is sent often while the project is in full-text mode.
- A late answer never updates the card: each read is for one connection, profile, project and main folder, and an answer for another is dropped.
- A file the agent rewrites in `context/` is a changed file, and every chat in the project hears of it with its next message.
