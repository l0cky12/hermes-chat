# Projects are Hermes's own, and which chats are in one is kept on this computer

A Project is a named group of chats and of folders on the server. The project itself, its name and its folders, is Hermes's: the profile's `projects.db`, read and written with the legacy `projects.*` JSON-RPC on `/api/ws` (`list`, `create`, `update`, `add_folder`, `remove_folder`, `delete`). The official desktop app and `hermes projects` use the same store, and the owner already had three projects in it. Hermes has no record of which chats belong to a project: the official desktop groups chats by the folder each runs in. So which chats the owner put in each project, and which project the list shows, are kept on this computer, in one versioned document (`hermes-chat.projects`), separately for each connection and profile.

Folders are references. A folder is added only after a read-only `GET /api/fs/list` finds it on the server; `projects.add_folder` itself takes any path, and reads a relative one from Hermes's home folder, so the app sends only absolute paths. A repository's worktrees are read with `GET /api/git/worktrees` (`git worktree list`), and an existing one can be added as a folder. The project screen never calls `worktree/add`, `fs/mkdir` or any other route that creates something on the server. (The Repository screen makes worktrees, through its own helper rather than the dashboard's routes: ADR 0043.)

## Considered options

- **A local-only project store.** Simplest, and it never writes to the server. Rejected: the owner's existing Hermes projects would be missing, and there would be two unrelated things called "project" depending on which client is open.
- **Membership by working folder, as the official desktop does.** Rejected: chats started in this app run in the dashboard's own folder, so they would all land in one project or none. Changing a chat's folder to put it in a project would change where the agent works, which isn't what grouping a chat should do.
- **Showing a project by setting Hermes's active project.** Rejected: `projects.set_active` is profile-wide and also changes what the CLI and the official desktop treat as current. Picking a project in this app's list is a view of the list, kept on this computer.

## Consequences

- Creating, renaming and deleting a project, and adding or taking out a folder, change it in every Hermes client. Renames aren't fenced (Hermes has no revision for projects), so the last rename wins.
- Deleting a project deletes only the project and its folder references (`DELETE FROM projects`, cascading to `project_folders`). Its chats stay in Hermes and in the list, and its folders stay on the server; this app also forgets which chats were in it. Checked against the deployed `bf0203a` with a throwaway `HERMES_HOME`.
- Which chats are in a project doesn't sync between computers, and isn't seen by other Hermes clients. "Clear local cache" doesn't delete it. ADR 0109 moves it to Hermes once Hermes has a membership store; until then this stands.
- A chat started while the list shows a project goes in that project, so it doesn't vanish from the list as soon as it is sent. It still runs in the dashboard's folder, as before.
- A project archived in another client isn't offered; which chats were in it is kept in case it comes back. A project deleted in another client goes from the list at the next read, and with it which chats were in it.
- A server without `projects.*` answers "method not found"; the switcher then says Hermes needs updating, and the chat list works as before.
