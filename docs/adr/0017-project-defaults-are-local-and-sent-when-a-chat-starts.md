# A project's defaults for new chats are kept on this computer, and reach Hermes only when a chat starts

A project can carry defaults for the chats started while the list shows it: instructions, a model with its reasoning effort, and a working folder on the server. A new chat takes each value from the first of: what the owner chose for that chat in its New chat pane (only the model can be chosen there), the project's default, and the profile's own. The New chat pane lists the values it will start with, and where each one comes from.

## Where the defaults live

Hermes keeps projects (ADR 0105) but has nowhere to keep these. `projects.update` takes only `name`, `description`, `icon`, `color` and `board_slug`, and the `projects` table has no other column for them (`hermes_cli/projects_db.py` at the deployed `bf0203a`). Putting them in `description` would show them as a description in the official desktop app, and would be overwritten by any client that edits it. So this computer keeps them, in one versioned JSON file in the app's data folder, `$XDG_DATA_HOME/net.l0cky12.hermes-chat/project-defaults.json` (version 1: `{v, scopes: {[connection and profile]: {[project id]: defaults}}}`, readable only by the owner), keyed by connection and profile the same way as which chats are in each project (`hermes-chat.projects`, unchanged).

- Each project's defaults carry a revision. A save names the revision the owner started editing from, and is refused if another save landed meanwhile. The owner then chooses to load the saved ones or to save theirs over them.
- The app isn't single-instance, and two running copies have separate webview storage and separate Web Locks registries (WebKitGTK keeps one per website data store), so neither could keep their saves apart. The file is shared by every instance, and changes only by compare-and-swap (`defaults_file.rs`): the webview reads it, decides from that read (revision check included), and asks Rust to write the new text only if the file still holds exactly what it read. Rust checks and writes while holding an exclusive `flock` on a lock file beside it, writing a private temporary file and renaming it over the old one. If another instance's write landed in between, the webview decides again from what is there now, so a save over a newer revision becomes a conflict and a save to another project keeps that project's. No other write touches the file.
- A project's defaults are forgotten only when Hermes has said the project is gone: deleted from this app, or answering that it no longer exists. A project list that merely leaves it out could be older than a save made since, so it never decides this. Defaults left behind by a project deleted in another client are never shown or used.
- A document written by a newer Hermes Chat is read for what this version knows, and this version never writes it, in whatever shape the newer version left it.
- The form can't be edited while a save is under way. Instructions over 20,000 characters are refused beside the field, and Save waits until they're shorter. A save the file system refuses fails and says so.
- The file is read again when the app opens a project's screen, after a save, when the window comes back to the front, and before each chat starts. Removing every default keeps the revision, so the project inherits from the profile and an editor opened earlier still meets a conflict.
- A chat starts with the defaults of the project shown, and the profile, at the moment it starts. The file is read again first, and that read's own answer is used; if it can't be read, the chat doesn't start, rather than starting on older defaults. If the owner, or another window, changes the project shown, or the owner switches profile, while the folder is checked, nothing starts and the message goes back in the composer.
- They don't sync between computers and other Hermes clients don't use them. Clear local cache keeps them.

## How a chat starts with them

Everything goes in the legacy `session.create` (`tui_gateway/contracts/sessions.py` `SessionCreateParams`, `tui_gateway/methods_session.py` `_create_session`):

- **Model and effort**: `model`, `provider`, `reasoning_effort`, as the composer's model pick already sent. A project model that Hermes's model list doesn't offer, or lists as unavailable, stops the chat from starting with a message; the app never swaps in another model.
- **Folder**: `cwd` with `cwd_explicit: true`. `cwd_explicit` marks it a deliberate pick, which beats a profile's configured `terminal.cwd` (`_completion_cwd`). Before the call the folder is listed read-only with `GET /api/fs/list?path=&profile=`, which refuses a missing folder, a file, or one the dashboard's user can't open. After the call, the chat is kept only if `info.cwd` is exactly that folder. Otherwise the app closes the session (`session.close`), deletes the stored row if one was written, says where Hermes would have run it, and puts the message back in the composer.
- **Instructions**: `session.create` has no instructions field, and the profile-wide `custom_prompt` and `personality` settings would change every chat. The supported per-session carrier is a seeded transcript row: `messages: [{role: "user", content, display_kind: "hidden"}]`. The content is `Instructions for this chat from the project "<name>". Follow them unless a later message says otherwise.` followed by the instructions. Hermes stores it at once and sends it to the model before the owner's first message, as part of the conversation and not as the system prompt. Strict providers get it merged into the first user turn (`_merge_consecutive_roles`). No Hermes client shows a hidden row: `session.resume` drops it (`_history_to_messages`), search skips it, and Regenerate title now skips it too. It is sent once, at creation, so it is never inserted again. A `system` row was rejected: the Anthropic adapter keeps only the last system message, so it would replace Hermes's own system prompt.

## Checked live

On 2026-11-02 an isolated `hermes dashboard` (the deployed checkout `bf0203a`, a throwaway `HERMES_HOME`, bound to `127.0.0.2` so its password gate was on) and a fake OpenAI-compatible model endpoint that recorded each request showed:

- `cwd` + `cwd_explicit` set the session's `info.cwd`, and after the first prompt the stored row's `cwd`.
- A `cwd` that doesn't exist is silently replaced by Hermes's own folder (`info.cwd` was `HERMES_HOME`), with no error. A folder with mode `000` is accepted as the `cwd`, while `GET /api/fs/list` answers `EACCES`. Hence both checks.
- The model request carried `model: fake-alt`, `reasoning_effort: high`, and one user message holding the hidden instructions and then the owner's message. The title-generation call didn't include them. `session.resume` didn't return the hidden row; `GET /api/sessions/{id}/messages` did, with `display_kind: "hidden"`.
- `session.cwd.set` moves an idle chat's folder and answers `4017 working directory does not exist` for a missing one.

## Changing defaults, and Apply to this chat

Saving defaults changes only chats started afterwards. A started chat in the shown project has **Apply the project's defaults**, which first lists what would change and asks:

- the model and effort, through the same per-chat switch as the composer (`config.set ... --session`), from the next reply;
- the folder, through `session.cwd.set`, which Hermes allows only between replies and only to a folder that exists; the app says it worked only when Hermes answers with that folder;
- not the instructions. Hermes can't replace or remove a row already in a chat, and adding another would only stack a second set. The dialog says so and suggests a new chat.

## Considered options

- **Store the defaults in Hermes's project `description`.** Rejected, as above.
- **Send the instructions with the first `prompt.submit`.** Rejected: the owner would see them in their own message in every client, and a retried send could add them twice.
- **Fall back to the profile when a project's folder or model fails.** Rejected: the chat would quietly run somewhere, or on something, the owner didn't choose.

## Backend gap

For these to sync and be seen by other clients, Hermes would need project columns (for example `instructions`, `default_model`, `default_provider`, `default_reasoning_effort`, `default_cwd`, and a `revision` for fenced updates through `projects.update`), and a `session.create` `instructions` field that Hermes adds to the system prompt and keeps with the session. Until then, the hidden row is the closest supported carrier.
