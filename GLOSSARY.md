# Hermes Chat

A personal desktop chat client for the owner's own Hermes Agent servers, one at a time. Chats that need attention sit in the Inbox; finished ones are settled out of the way.

## Language

**Chat**:
One Hermes conversation as this app shows it, with its full message history.
_Avoid_: session (Hermes's word for the same thing; keep it for server-side talk), conversation, thread

**Active**:
The state of a chat the owner is currently working in: any chat that isn't Settled. The list doesn't label it. An Active chat shows in the Inbox when it needs the owner or is done, in Working while Hermes replies in it or waits on work it handed off, and in Snoozed while it is snoozed (ADR 0036, ADR 0063). A chat becomes Active when the owner starts it in this app, or when the owner sends a message in it from this app.
_Avoid_: open, live, current

**Settled**:
The state of a chat the owner has put out of the way. Settled chats sit in the Settled drawer at the foot of the chat list, closed until the owner opens it (ADR 0090). Only the owner settles a chat; nothing settles on its own. A new message from another platform leaves a Settled chat where it is.
_Avoid_: archived, done, closed

**Settle** / **Unsettle**:
The owner's manual actions, from a chat's row or its right-click menu, that move a chat from Active to Settled, and back to the Inbox. On the row both are the same icon-only button, named when hovered. Settling is how a chat is cleared from the Inbox (ADR 0090). Dragging a row onto the Settled drawer settles it, and dragging a Settled chat onto the Inbox unsettles it (issue #299). Settling a snoozed chat forgets the snooze. **Settle all**, on the Inbox's header, settles every chat the Inbox shows at once, after a question that counts the ones with an Approval waiting or a failure (issue #303, ADR 0090).

**Working**:
Where the list shows an Active chat while Hermes is writing a reply in it, or the chat has Dispatched work outstanding, and Hermes isn't waiting on the owner. Nobody puts a chat there: it moves there when a reply starts, and back to the Inbox once Hermes asks the owner something (an Approval), or once no reply runs and no Dispatched work is outstanding. A reply running shows a spinner on the row; Dispatched work with no reply running shows an hourglass (ADR 0096). A Settled or snoozed chat stays where it is while Hermes works in it.
_Avoid_: running (fine in conversation), busy, in progress

**Dispatched work**:
Work a chat's reply handed to another agent before it ended its turn: a kanban task it created that is still outstanding (triage, to do, scheduled, ready or running on Hermes's board), or a Subagent of its own that is queued or running after the reply ended. For a chat not opened since launch, the app knows its Subagents only as Hermes's count of those still running. Hermes starts a new turn in the chat when the work comes back, and that turn writes the answer. While a chat has some, it stays in Working. A task that is blocked or waiting for review needs the owner instead, and the chat goes to the Inbox with that reason. **Stop waiting**, in the row's menu, ignores the work outstanding now, on this computer only; a newer dispatch counts again, and nothing on Hermes is cancelled (ADR 0096).
_Avoid_: background job, pending task, handoff (fine in conversation)

**Snoozed**:
An Active chat the owner has put out of the way until a time they chose. It sits in the Snoozed section after the Inbox, collapsed until the owner opens it, soonest to wake first, and shows when it wakes. When that time comes it goes back to the Inbox, as new as when it woke. Snoozes are kept on this computer only, for each connection and profile; Hermes and other Hermes clients don't see them (ADR 0036).
_Avoid_: hidden, deferred, reminder

**Inbox**:
The first section of the chat list: the Active chats in the profile shown that need the owner or have finished, newest first: an Approval waiting, a failure, a reply done, a dispatched task that is blocked or waiting for review, something new. A chat that handed work off reaches it only once that work is done and Hermes's follow-up reply has ended (ADR 0096). A chat stays there until the owner settles it (clearing it from the Inbox) or snoozes it, or a reply starts in it (ADR 0063, ADR 0090).
_Avoid_: top of the list (its name before ADR 0063), feed

**Clear from the Inbox**:
What settling a chat in the Inbox does: it goes to the Settled drawer (ADR 0090). Until then a clear was kept on this computer only and put the chat in an Unsettled section, which is gone; the clears an older version kept were settled once.
_Avoid_: close (Close closes tabs and panes, and "closed" is kept away from Settled), dismiss (the Rail inbox's word), Unsettled (the section that is gone)

**Pinned** / **Pin** / **Unpin**:
The owner's actions, from a chat's right-click menu or its header's More menu (P in either), that keep a chat in the Pinned section at the top of the chat list, and put it back in its place. Pinned lists the chats in the order they were pinned, whatever happens in them; only Archived takes a chat out of it. Pins are kept on this computer only, for each connection and profile, since Hermes's own pin flag holds Active (ADR 0002, ADR 0085).
_Avoid_: favourite, star (starred models are the model picker's), sticky

**Chat list section**:
One of the chat list's groups: Pinned, Inbox, Snoozed, Archived and Working in the list's scroll, in that order, so Working sits right above Settled, then Settled, a drawer at the list's foot that opens upward with its own scroll (ADR 0090). Each chat is in exactly one. Each has a header with its count that collapses or expands it; which are collapsed is kept on this computer across restarts. Settings → General picks which sections show, any mix but never none; a chat in a hidden section is still found by Search (ADR 0063).
_Avoid_: group, folder, tab

**Snooze** / **Unsnooze**:
The owner's actions, from a chat's right-click menu, that snooze an Active chat (for 1 hour, 3 hours, until tomorrow at 9, until next Monday at 9, or for a duration or until a date and time the owner picks) and wake it early. Sending a message in a snoozed chat from this app wakes it. A new message from another platform doesn't. Settled chats can't be snoozed.
_Avoid_: remind me, defer

**Archived**:
A chat the owner has hidden in every Hermes client without deleting it. Its history stays on the server, and so does whether it is Active or Settled. Archived chats show only in the list's Archived section, when Settings → General shows it, or in a search the owner asks to include them. A chat archived in another Hermes client is Archived here too.
_Avoid_: hidden, settled, deleted

**Archive** / **Restore**:
The owner's actions that make a chat Archived, and bring it back to the list, Active or Settled as it was. A chat with a reply running can't be archived or restored. The app says it worked only once Hermes, read back, has the chat that way.
_Avoid_: unarchive, hide, remove

**Delete**:
The owner's action that removes a chat from Hermes for good, in every Hermes client. Unlike settling, it can't be undone, so the app asks first. A chat with a reply running can't be deleted.
_Avoid_: remove, archive

**Export**:
Saving one chat as a Markdown file, in a place the owner picks in the Save dialog. The Export dialog comes first: the owner picks the messages, whether tool calls and Approvals and the names of attached files go in (left out at first), and what is redacted, and sees the file exactly as it will be saved. Likely secrets are flagged and redacted unless the owner keeps them, and the owner can redact any text they select. The file holds only what Hermes Chat has loaded for the chat, as it was when the dialog opened, and never an attachment's contents. It warns that it may still contain sensitive information, since detection can miss a secret. Nothing is uploaded (ADR 0076).
_Avoid_: download, backup, snapshot (#92's published copy, which waits for a hosting service), share

**Backup**:
A zip file of what Hermes Chat keeps on this computer, saved where the owner picks: settings and templates, and for each connection and profile, drafts, queued messages, project membership and defaults, tags and Saved filters, and branch origins. It never holds a password or other credential, the sign-in, or anything Hermes keeps on the server. **Restore a backup** checks all of it first, previews it, maps each of its connections and profiles to a profile here (only an identical one on its own), and writes each category by the owner's choice, Merge or Replace, after saving a recovery backup. Nothing restored is sent: queued messages come back paused (ADR 0038).
_Avoid_: export (that is one chat as Markdown), sync, restore (alone: that brings back an Archived chat), snapshot

**Rename**:
The owner's action that changes a chat's title, in every Hermes client. If the chat was renamed or edited elsewhere since the owner started, nothing is overwritten: the app shows the newer title and the owner chooses whether to save again.
_Avoid_: retitle

**Regenerate title**:
The owner's action that asks Hermes for a new title made from the chat's last five messages, then saves it as a Rename does. Asking adds nothing to the chat. If Hermes gives no usable title, the old one stays and the row says why. The title comes from the profile's Text generation model, which Hermes keeps and Settings → Model sets. If Hermes has no sign-in or key for that model's provider, the row says so, says how to fix it, and offers the setting. The app never tries another provider on its own.
_Avoid_: auto-title (Hermes's own titling of a new chat), retitle

**Unread**:
A chat with something new in it since the owner last opened it, in this app or any other Hermes client. It shows a dot, and so does a collapsed section's header when a chat in it is unread. A chat visible on screen never shows the dot. With two panes, both visible chats stay read; a pane hidden by the narrow-window switcher or Settings does not mark its chat read.
_Avoid_: new, unseen

**Source**:
The platform a chat was started on: this app, Telegram, Discord, the command line, the official Hermes desktop app, or a transcript file (an Imported transcript). A chat's source never changes, even after the owner replies from this app. Chats whose source is this app show no source icon.
_Avoid_: origin, platform (as an attribute of a chat)

**Imported chat**:
A chat whose source is anything other than this app. Imported chats start Settled.

**Imported transcript**:
A chat brought into Hermes from an export file with Import transcripts: a Hermes Chat Markdown export, or a Hermes session export (JSONL). Its Source is a transcript file (`import` in Hermes), in every Hermes client. It starts Settled and is read-only here: Hermes has its words, not everything the original chat had, so the owner starts a new chat to carry on. It is known by an id taken from the file, the session's own id or one made from the file's SHA-256, so the same file imported again adds nothing (ADR 0031).
_Avoid_: restored chat, backup, upload

**Import** (of transcripts):
Reading an export file the owner picks, checking all of it, showing what it holds and what won't come in, and only then having Hermes write its chats, all or none. Chats Hermes already has are skipped. It counts as imported once Hermes, read back, has each chat.
_Avoid_: restore, sync, upload

**Profile**:
A separate Hermes agent setup on the server, with its own chats. The app shows one profile's chats at a time. The profile switcher shows which other profiles have Unread chats, checked every two minutes, so it can lag behind.
Switching profile happens in place, with the same sign-in: the list shows what this computer saved for the profile, says it is connecting and loading, and is remembered for the next launch only once its chats load. If they can't, it says why and offers to try again or go back. Each profile keeps its own drafts, Saved copies and Model pick, and nothing that arrives for the profile left shows in the new one. If a reply is running or an Approval waiting, the switcher asks first. Hermes keeps the reply going, and the Approval waits until Hermes stops waiting; switching back brings both back.
_Avoid_: account, workspace, agent (as a name for a profile), connection (the server signed in to, which covers every profile)

**Clone profile**:
Making a new profile on the server from another one, from the profile switcher's menu. By default the clone is fresh, with only the parts the owner picks: the source's persona, model, description and own skills. It has no API keys. The full copy, which the owner turns on after a warning, also copies the source's API keys, memory and every setting. Chats, scheduled jobs and messaging channels are never copied. The new profile is read back before it can be opened, and the dialog says which parts didn't copy (ADR 0074).
_Avoid_: duplicate, fork, copy (as a name for the feature; a copy is what Hermes's full copy does)

**Bot Mode**:
Hermes's way of treating each profile as a bot with a lasting identity, each with one Bot Chat. The Bots view shows it, opened from the rail. A Hermes without Bot Mode has no Bots button, and Connection diagnostics says why (ADR 0066).
_Avoid_: agents mode, roster (Hermes's desktop calls its list that, but here it is the Bots view)

**Bot**:
A profile as the Bots view shows it: its name, picture and description, from Hermes. Its row shows its Bot Chat's last message, and whether it is Replying or Needs you. Clicking the row opens its Bot Chat; the pen beside it starts an ordinary chat in that profile.
_Avoid_: agent (Hermes's own word for what runs the chat), assistant, persona (that is the profile's SOUL.md)

**Bot Chat**:
A bot's one chat that always continues: the profile's chat titled exactly "Bot Chat". Hermes finds it by that title each time it opens, never by a remembered id or by which chat is newest. It is created only when the bot has none, with no message sent. It stays out of the chat list and search: the bot's row is the way to it. `/new` in it compacts it instead of starting a new chat (ADR 0066).
_Avoid_: forever chat, canonical chat, DM, main chat

**Connection**:
A Hermes server this computer can sign in to, saved with a name, its Routes, its dashboard username, and when it was last used. Each keeps its own password and Extra request headers in the system keyring, and its own Drafts, Queued messages, Failed messages, Saved copies, profile shown, Model pick and chat to reopen on this computer, so the same profile name on two servers never shares them. One is in use at a time. Switching to another asks first when a reply is running or an Approval waiting; Hermes keeps the reply going, and switching back brings both back. Removing one deletes only what this computer keeps for it, after saying what that is; its chats stay on the server. Nothing picks a connection by its name, or on its own: launch signs in to the one in use, showing its saved chat list meanwhile, Connecting, when there is one (ADR 0089), and when that one is removed, the sign-in screen offers the others and waits (ADR 0112).
_Avoid_: server (the machine itself), account, sign-in (the act of signing in), profile (an agent setup on the server)

**Connection attempt**:
One time the app opens a Connection, at launch or to reconnect: the Routes it tried, each by its kind and id, the connect steps each reached (keyring, DNS or SSH tunnel, status, sign-in, ticket, WebSocket, ready) and how long each took, and how it ended, with the error after redaction and with every address taken out. The newest 50 are kept on this computer between launches, never uploaded, and shown in Logs → Connection attempts; one the app was closed during reads as unfinished at the step it was on (ADR 0033).
_Avoid_: connection log, sign-in log

**Route**:
One way to reach a Connection's server: a LAN address, a Tailscale address, a web address (https://), or an SSH target. A Connection has one or more, in the owner's order; connecting tries the ones turned on in that order and uses the first that reaches Hermes and signs in, and a connection that drops comes back over whichever works then. The password belongs to the Connection, Extra request headers to the route that needs them. Before the password goes over a route, the app checks that the route reaches the same Hermes the Connection signed in to before; a route that reaches anything else is the **wrong server** and is skipped. Plain http:// routes only go to this computer, a LAN or Tailscale. With several routes, each step of a route (looking up its name, the status, the sign-in, the chat connection) has a short limit, so one that stalls gives way to the next within seconds. A route that failed lately is tried last, even after a restart. While on a later route, the earlier ones are checked now and then, and the connection moves back once one answers and nothing is running (ADR 0120).
_Avoid_: path, endpoint, address (one part of a route), connection (all of a server's routes together)

**Sign-in method**:
How a Connection signs in to the dashboard: **Password**, a username and password for a provider Hermes lists (usually `basic`), or **Token**, the dashboard's session token (`HERMES_DASHBOARD_SESSION_TOKEN`). The sign-in screen and Setup offer only the methods the server advertises that the app supports, with a picker when there is more than one. The Connection records the method it used, which isn't a secret; the token itself stays in the keyring, where only Rust reads it, and is sent only to an address it was entered for (ADR 0058).
_Avoid_: auth mode, login type, provider (Hermes's own word for what checks a sign-in)

**Project**:
A named group of chats and of folders on the server, in one profile. Hermes keeps the project, its name and its folders, so other Hermes clients show it too. Which chats are in it is kept by Hermes when it has a membership store, so every computer shows the same, and on this computer only when it doesn't, which is every Hermes today (ADR 0109). Picking a project in the list shows only its chats; a chat started meanwhile goes in it. A chat can be in several projects, or none. A project has a page: a composer that starts a chat in it, its chats, its instructions (part of its Project defaults) and its Context files, with its folders, defaults, Rename and Delete behind a menu (ADR 0135). Deleting a project keeps its chats in Hermes and its folders on the server, context files included.
_Avoid_: workspace, group, folder (for the project itself)

**Tag**:
A label the owner puts on chats, in one profile. A chat can have several tags, or none. The owner creates, renames and deletes tags; a renamed tag stays on its chats. No two tags in a profile share a name, whatever its case. Tags are kept on this computer only, for each connection and profile; Hermes and other Hermes clients don't see them (ADR 0106).
_Avoid_: label (in the app), category, folder, project

**Chat filter**:
What the search palette narrows the profile's chats by: words, Tags, Source, model, when the chat was last active, and whether it is Active, Settled or Archived. A chat must match every part. Hermes searches the words and lists the chats; the rest is checked on what Hermes answered, and the results say when more chats may match. Applying a filter changes no chat (ADR 0106).
_Avoid_: query, view

**Saved filter**:
A Chat filter the owner named, listed in its own section of the chat list and opened again from there. It is a search, not a group: unlike a Project, it puts no chat anywhere. Kept on this computer only, for each connection and profile (ADR 0106).
_Avoid_: smart folder, saved search (fine in conversation), view

**Membership** (of a project):
Which chats are in which project, one link per chat and project. Kept by Hermes when it answers `projects.membership.*`, and on this computer when it doesn't. Moving this computer's membership to Hermes shows a preview first and keeps a recovery copy. A change Hermes hasn't confirmed yet is **waiting to sync**. A change that another computer contradicted after this one last synced is a **conflict**: Hermes's version is shown until the owner keeps theirs or Hermes's (ADR 0109).
_Avoid_: sync conflict (for a change that is only waiting), assignment

**Folder** (of a project):
A path on the server that a project refers to, shown with the connection it is on. The one Hermes names primary is the project's **main folder**: every computer agrees on it, and the project's Context files are kept in its `context` folder. Hermes Chat adds only a folder that is already there, and never moves or deletes one. It makes a folder in one case only: for Context files, it makes `context` in the main folder, and for a project with no folder it first makes `<profile's folder>/projects/<project's name>` on the server and adds it as the main folder (ADR 0135). A folder in a git repository shows its branch, and the repository's other worktrees can be added as folders too. Worktrees are made and removed only in the Repository screen's Worktrees view.
_Avoid_: directory, workspace, repo (unless it is one), primary folder (the main folder)

**Context file** (of a project):
A file in the `context` folder of a project's main folder on the server, which every chat in the project gets, whatever folder the chat works in. The folder is the list: a file put there by any means is one, and nothing else records them. While the files fit (up to 100% of the project's capacity, half the context window of its default model, or 100,000 tokens when that isn't known) a chat gets their text: a new chat as a hidden message when it starts, a chat already open as what was added, replaced and removed, below its next message where no Hermes client shows it, and never the same text twice. Over 100% the project is in **list mode**, and chats get each file's path to open with their own tools. A file with no readable text is always given by path. They are added, replaced, previewed and removed on the project page's Context card, which asks before replacing or deleting (ADR 0135).
_Avoid_: project knowledge, knowledge base, source, attachment (an Attachment goes with one message), project file

**Project defaults**:
What a project gives the chats started while the list shows it: instructions, a model with its reasoning effort, and a working folder on the server. A new chat takes each from what the owner chose for it, then the project's default, then the profile's own, and its New chat pane says which. They are kept on this computer only, for each connection and profile; Hermes has nowhere to keep them. Saving them changes only chats started afterwards. A chat starts only in a folder that is on the server and that Hermes says it took; the instructions go in once, as a hidden message the model reads and no Hermes client shows. Apply the project's defaults asks first, and can change a started chat's model and folder, never its instructions (ADR 0017).
_Avoid_: project settings (the project screen also renames and deletes), workspace, system prompt (the instructions aren't one)

**Attachment**:
A local file the owner sends with a message: an image Hermes looks at, or any other file Hermes can read. Hermes takes images up to 25 MB and other files up to 256 MB.
_Avoid_: upload, file (when the attachment is meant)

**Screenshot**:
An image of a region or window of the owner's screen, taken from the composer by a shortcut or the camera button, and staged as an Attachment. It stays on this computer until the message is sent. Composer captures are deleted when removed or left behind; a failed or uncertain message keeps its Screenshot for Retry until confirmed, reconciled or dismissed.
_Avoid_: screen capture, snapshot

**Annotation** (proposed, not built):
A pointer at part of a web page in the Preview, staged in the composer: a Screenshot of the page with the picked element or region marked, plus a block of words with the page's address, the time, the box and the owner's note. An element also adds its details. A region has none. The owner picks it on a still of the page, which covers the live page while they annotate; the page stays loaded behind it. Nothing is sent until the owner sends the message (ADR 0094).
_Avoid_: comment (the official desktop app's word), inspector

**Global shortcut** (removed):
The app no longer registers a key of its own (#169; ADR 0107 is superseded). A key the owner binds in their desktop's own config to `hermes-chat --show` or `hermes-chat --toggle` brings Hermes Chat's one window forward from any app, with the cursor in the selected pane's composer; `--toggle` hides it when it's already in front.
_Avoid_: summon key, screenshot shortcut (that one works only inside the app, unless bound to `--screenshot`)

**Branch**:
A new chat that starts with another chat's history up to one message, made from that message with Branch from here. Hermes copies the history and keeps which chat the branch came from, so every Hermes client has it. Hermes copies what the owner and Hermes said, and Hermes's reasoning, but not tool outputs. A file a copied message refers to stays where it is on the server, for the branch to read while it's there. The chat it came from stays as it was. A branch has its own Draft and Queued messages, and what the owner sends goes to it alone. It is Active, runs on its parent's model in its parent's folder, and takes Hermes's name for it (the parent's title with a number) unless the owner gives one. Its top says where it came from. Which message that was is kept on this computer only. A branch can't be made while a reply is running or an Approval waits. Branching never undoes anything Hermes did on the server (ADR 0027).
_Avoid_: fork, copy, clone, thread

**Version** (of a turn):
Another take on one turn of a chat, made with Edit under the owner's message or Regenerate under the turn's last reply. Each version is a Branch made through the owner's message. Hermes takes back the branch's copy of the message, then the message goes again in the branch: the owner's new words for Edit, the same words for Regenerate. The chat it was asked from keeps its message, its answer and everything after. Under the turn's last reply, a switcher shows which version this chat is (2 / 3), whether it is the Original, Edited or Regenerated, and the model and settings it ran on, and opens the others. A turn is numbered by the owner's messages before it, so it is the same in a chat and its branches. Which turn a version is of is kept on this computer only. A message sent with an image can't be sent again, so it has no versions (ADR 0035).
_Avoid_: variant (in the UI), alternative, retry, rerun

**Draft**:
The text the owner has typed in a chat's composer and not sent. Each chat keeps its own draft, and so does the New chat pane, separately for each connection and profile. A draft is still there after switching chats or restarting the app. Sending or queuing it empties it. A message Hermes doesn't take becomes a Failed message, not a draft again. Only when a new chat can't be started does the text come back into the composer. Attachments aren't kept in a draft.
_Avoid_: unsent message, saved message

**Queued message**:
A message the owner lined up while Hermes replied, to go after the reply. Each chat has its own queue, and both panes of a chat show it. The owner can edit, reorder and remove queued messages, and pause and resume the queue. Hermes Chat sends them one at a time, each once the previous reply has ended and nothing in the chat waits on the owner. It sends them only while it is open, connected and showing their profile. The queue pauses on its own after a reply that was stopped, failed, or asked for an Approval. It also pauses when a queued message doesn't go, when the connection drops, and when the queue is loaded again after a restart or a profile switch. A queued message that goes becomes an outgoing message, and if Hermes doesn't take it, a Failed message. Queued messages and their attachments are kept on this computer, for each connection, profile and chat, never on the server (ADR 0018).
_Avoid_: pending message, scheduled message, Hermes's queue (Hermes's own queue holds messages sent while a turn runs; this app doesn't use it as the queue)

**Steered message**:
A message the owner sent into a running reply instead of queueing it, through Hermes's `/steer`. Hermes adds it to the reply after the reply's next tool call, without stopping it, so it doesn't start a turn of its own. It shows in the chat marked "Steered into the reply", and Hermes stores it so (`display_kind: "steer"`). The Follow-up behavior setting picks whether Enter queues or steers while a reply runs; Ctrl+Enter does the other. A message with files, or one sent to a Hermes whose `/steer` can't run here, is queued instead (ADR 0057).
_Avoid_: interrupt, redirect (Hermes's words for cutting the running reply short), injected message

**Side question (/btw)**:
A question the owner asks about a chat with `/btw <question>`, while a reply runs or with the chat idle, without interrupting the reply or adding to the chat. Hermes answers it from a snapshot of the conversation, with no tools, and stores nothing. The question and its answer show in the transcript where it was asked, as the owner's message and Hermes's reply, each marked "Side question · not part of the conversation"; they are never among the chat's messages. The answer can be copied, and the pair dismissed. A chat shows up to three; a fourth takes the oldest one's place. They stay while switching chats and go on a profile switch or a reload; they are never saved, exported, branched or put in the Saved copy. A question Hermes couldn't answer says why in its answer, never as a Failed message (ADR 0070, ADR 0086).
_Avoid_: aside, background question, `/background` (Hermes's command for a separate background session), btw message

**Slash command**:
A command the owner types at the start of the composer, after a "/", picked from the menu that opens there or typed in full. Each is either an action of this app or a command Hermes runs for the chat, and says which. Only the commands in the app's list run; any other text starting with "/" is sent as an ordinary message. Picking from the menu only fills the command in; Enter then runs it. A command that can't run says why and keeps the text. Deleting asks first, as it does in the chat list. The same menu lists the profile's skills after the commands (see Skill) (ADR 0015).
_Avoid_: quick command (Hermes's word for commands defined in its config), shortcut, macro

**Template**:
A message the owner reuses, kept in a library on this computer: a name, an optional description, the message with blanks to fill in (`{host}`, `{port=22}`, `{notes...?}`), and optionally the one project it is offered in. Filling one in shows the whole message as it will be; Insert puts it in the composer and never sends. With a draft already there, the owner chooses to replace it or add after it, and Cancel leaves it alone. Templates are data: nothing in one runs (ADR 0028).
_Avoid_: snippet, macro, prompt (for the template itself), quick command (Hermes's own)

**Dictation**:
Speaking a message instead of typing it. The microphone is open only between the owner starting a recording and pressing Done or cancelling. The recording is turned into text where Speech to text runs, and the text goes into the composer after anything already typed, for the owner to edit and send. Nothing reaches the chat until the owner sends it. Cancelling, or opening another chat, drops the recording. A recording that couldn't be transcribed is held in memory until the owner tries again or discards it. Recordings are never saved on this computer.
_Avoid_: voice message, voice mode (Hermes's own hands-free voice chat), speech input

**Speech to text on this computer**:
The side of Speech to text that runs here: a speech-to-text engine installed on this computer (whisper.cpp, faster-whisper, OpenAI Whisper or Vosk) with a model already here, or a Whisper model downloaded for whisper.cpp in Settings → Voice. Only the text goes to Hermes. Chosen with no backup, the recording never leaves this computer, not even when the engine can't run (ADR 0067, ADR 0065).
_Avoid_: local mode, offline transcription, Local Whisper (Hermes's own server-side provider)

**Read aloud**:
The owner's action that has Hermes speak one reply with the profile's text-to-speech provider, played on this computer. One reply plays at a time, and opening another chat stops it. The audio isn't saved.
_Avoid_: TTS, playback, voice mode

**Voice conversation**:
Talking with Hermes hands-free in a started chat, from Start voice conversation until End: Dictation and Read aloud in turn. The microphone on this computer listens, a turn ends after the profile's `voice.silence_duration` of quiet (or on Send now), Hermes transcribes it, the text goes to the chat as the owner's message, and the reply is spoken. It never listens while anything plays, so Hermes's voice can't become a turn. "What Hermes got" shows each turn's text and whether it was sent. It pauses, closing the microphone, when Hermes disconnects, the window is hidden or minimized, or its pane loses focus, and only the owner resumes it. Opening another chat or profile ends it. Its audio is never saved on this computer; the text sent is a chat message, kept here as typed messages are (ADR 0111).
_Avoid_: voice mode (Hermes's own), voice chat, live mode, hands-free mode

**Speech provider**:
The service Hermes turns speech into text with (speech-to-text), or text into speech with (text-to-speech), for one profile, such as Local Whisper or ElevenLabs. Read aloud and Voice conversations speak with the profile's text-to-speech one, on the server. Dictation and Voice conversations transcribe with its speech-to-text one, unless Speech to text runs on this computer. Settings → Voice lists the ones Hermes offers, says which are set up (installed, signed in, or with a key), and picks one for each side, with its model, voice and language and its API key. A key is write-only: Hermes says only whether one is set. Each save is checked against Hermes first and confirmed by reading back (ADR 0115).
_Avoid_: STT/TTS engine, voice backend, voice model

**Speech to text** (where it runs):
Where Dictation and Voice conversations turn a recording into text: on **Hermes**, with the profile's speech-to-text Speech provider, or on **this computer** (see Speech to text on this computer). The owner picks where it runs first and may make the other one the Backup, which transcribes the same recording when the first fails or is slower than a set time; the chat then says which one did it. Rust decides where each recording goes, so the app can't send one to Hermes that the owner kept here. On this computer the recording is written to a private temporary folder for the engine to read, and deleted when the run ends. The choice is kept on this computer, for every connection and profile (ADR 0065).
_Avoid_: local mode, offline mode, STT engine

**Close to tray**:
The owner's setting that has closing the window hide it in the tray instead of quitting. It is off unless the owner turns it on, and works only while the desktop shows the tray icon; otherwise closing quits. A hidden window keeps its chats, drafts and replies coming in, but drops a Dictation recording, stops Read aloud, pauses a Voice conversation, and the chat it shows doesn't count as on screen, so new replies leave it Unread. The tray menu, `hermes-chat --show` or `--toggle`, or launching Hermes Chat again brings back the same window. Quit in the tray menu always exits. The setting is kept on this computer (ADR 0034).
_Avoid_: minimize to tray, background mode, run in background

**Failed message**:
A message sent from this app that Hermes didn't take, or may not have. Either the connection dropped, or the app closed, before Hermes confirmed it. It stays in its chat with its words and files, says why, and offers Retry, Edit and Dismiss. Retry sends the same words and files again as a new message. Edit takes the words back into the composer. Nothing sends it again on its own. For one Hermes may have, the chat's history is read back once Hermes is connected. If the history has it, the message shows from the history. If not, it is marked failed (ADR 0006). Failed messages are kept on this computer, and Clear local cache keeps them.
_Avoid_: undelivered, pending, unsent message

**Stopped**:
A reply the owner, or another Hermes client, interrupted before it finished. The reply keeps what it had said and is labelled Stopped. The message it answered was sent, so it isn't a Failed message.
_Avoid_: cancelled, failed

**Subagent**:
An agent Hermes started from a chat's reply to do part of its work (Hermes's `delegate_task`). A subagent can start subagents of its own. The chat's Subagents panel, above the composer, shows them as a tree with each one's goal, model, state and last activity. Opening one shows what it did and its latest output, apart from the chat. **Steer** sends one subagent words to read after its current tool call. **Stop** ends one subagent and the running subagents it started. Each names its target first, and neither reaches the chat's reply or other subagents. A subagent never asks for an Approval. The tree is kept only while the app runs. After a reconnect the app reads it again from Hermes. A subagent that ended unheard while the app was disconnected, or whose end Hermes didn't explain, shows as Ended (ADR 0072).
_Avoid_: child agent, worker, delegate (in the UI). Subagent model settings in Settings → Model pick models, not running work

**Office** / **Desk**:
The agent office, opened from the rail in place of the chat panes: every agent at work on the connection, one for each chat's reply, in the state the Rail inbox gives it, and one for each of its Subagents. **Building** (the default) draws them as low-poly people in a 3D building with four rooms by state: the **Workroom** (running, queued at its door, and a reply waiting on its Dispatched work), the **Waiting room** (waiting for an Approval, or a message that may not have sent), the **Trouble room** (failed) and the **Lounge** (everything else). Each chat's agents are a **team**, in one team color, and a team keeps its group of Workroom desks while any of its agents works. A name tag shows only while the pointer is over its agent or it has focus, and stays for the picked one. Clicking an agent opens its **card**, whose only action is Open chat. **Office quality** (Normal or Low) caps the frame rate and resolution; Low also types at half the pace and has agents appear in their new room instead of walking. **List** shows the same agents as rows, and is what a computer without WebGL gets (ADR 0122). An agent opens its chat, or the subagent in the chat's Subagents panel; it never approves or starts anything. One that can't be checked shows "as last seen", and only Hermes's word that a subagent completed makes it Finished (ADR 0077). A **Desk** is one agent's entry in `officeRooms`, the data both views draw.

**Approval**:
Hermes asking the owner before it runs a command it counts as dangerous. It shows as a card in the chat, and the reply waits until the owner approves or denies it, Hermes stops waiting, or the reply is stopped. The card offers only the answers Hermes offers: once, for the rest of the chat, always, or deny. The two broader grants ask the owner to confirm first.
_Avoid_: permission, confirmation, prompt

**Approval mode**:
How Hermes decides, in a chat, whether to ask for an Approval before a command it counts as dangerous, as Hermes reports it for the chat. The pill in the composer shows it and changes it. **Smart**: Hermes's checker lets safe-looking commands run and asks about the rest. **Manual**: Hermes asks before every command it flags as dangerous. Smart and Manual are the profile's setting, so a change reaches every chat on the profile, CLI and messaging ones too, from Hermes's next command. **YOLO**, shown "YOLO · this chat": Hermes runs every command in the chat without asking. It is the chat's own, other chats still ask, and the app warns every time it is turned on. Writes to AGENTS.md, CLAUDE.md and SOUL.md still ask, and Hermes's blocklist still blocks. Picking Smart or Manual in a YOLO chat turns its YOLO off. **YOLO · all chats**: the profile's mode is off, set outside this app, so no chat on it asks; the app shows it but doesn't offer it. A Hermes launched with `--yolo` reads as YOLO in every chat (ADR 0091).
_Avoid_: permission mode, auto-approve, safe mode

**Toolset**:
A named group of tools Hermes can offer the model, such as Web Search or Terminal. Which toolsets are on is a setting of the profile, kept by Hermes on the server: the list new chats in the profile start with, in every Hermes client, unless the server pins its own or the profile's coding focus mode picks one in a code workspace. A change reaches chats Hermes starts, or opens again, afterwards. A chat Hermes already has open, and a reply running in it, keeps the tools it started with, on its next turns too. Settings → Toolsets says a change is saved only once Hermes reads it back that way. It also shows, apart from the profile's setting, what the open chat has, as Hermes reads it for that chat. The profile's list is **inherited** while the profile hasn't saved one of its own: it is Hermes's default. A toolset is **forced off** when `agent.disabled_toolsets` turns it off on every platform, whatever the list says. A toolset being on doesn't let Hermes run anything it would otherwise ask about: the Approval mode decides that.
_Avoid_: tool permissions, capabilities, plugins (a plugin can bring a toolset, but isn't one)

**MCP server**:
A program Hermes starts on the server (a command, "stdio") or a service it connects to (a URL, HTTP or SSE) that gives the model more tools, through the Model Context Protocol. Each profile has its own, kept by Hermes in the profile's config, with their secrets (env values, a bearer token) in the profile's `.env`; a plugin can bring one too, which can't be changed from here. Settings → MCP servers shows any profile's, picked in the tab, and adds (from a blank form or Hermes's catalog), edits, removes after asking, turns on and off, tests (Hermes connects and lists its tools) and signs in to them (OAuth, finished in the browser). Secrets are write-only: the screen never shows one, and a blank one keeps what Hermes has. Each change counts only once Hermes, read back, has it so. A change reaches chats started afterwards; a chat already going keeps the tools it started with. Toolsets' `no_mcp` turns every MCP server off for one platform's chats in the profile (ADR 0121).
_Avoid_: plugin (a plugin may bring an MCP server, but isn't one), connector, integration, mcpo (a separate proxy that serves MCP servers to OpenAPI clients)

**Gateway**:
Hermes's messaging gateway: the process on the server that connects a profile to Telegram, Discord and other platforms, so people can talk to Hermes there. Each profile has its own, with each platform's on/off switch in its config and its bot token in its `.env`. Settings → Gateways shows any profile's Telegram and Discord: their state as the gateway reports it, the switch, the token (only Hermes's redacted preview; Replace and Remove change it on Save, and a row left alone keeps it), who may talk to the bot, and Hermes's status check, which sends no message. A save reads the platform first and sends nothing if it changed on the server, then reads it again. The gateway uses a change once it restarts on the server; the app doesn't restart it (ADR 0073).
_Avoid_: channel (a place inside Telegram or Discord), bridge, integration, gateway in front of the dashboard (that's what Extra request headers are for)

**Rail inbox**:
The list, opened from the tray's Open Inbox (the rail has no Inbox button, ADR 0097), of what needs the owner or has finished in any profile on the server: a reply running, a chat waiting on its Dispatched work (listed as running, "Hermes is waiting on work it handed off."), an Approval waiting, a dispatched task that needs the owner, a failure or Failed message, or a chat with something new. Each entry names its profile and chat, says when, and opens the chat in its profile. Nothing is answered, retried or sent from it. Dismissing an entry takes it out of the rail inbox only, on this computer: the chat stays Unread, Active or Settled, and Archived or not, as it was. An entry shows again only for something newer. Completed entries can also be dismissed all at once with Clear done, or on their own once older than a time set in Settings, off until set (ADR 0088). Running work in other profiles shows only for chats the dashboard itself runs (ADR 0019).
_Avoid_: notifications, activity, feed

**Chat link**:
A `hermes-chat://` link that opens one chat in its profile, made with Copy chat link. It holds only ids: a random reference this computer made for the connection, the profile's name and the chat's id, never an address or sign-in. Opening one checks everything first (the connection is the one signed in, Hermes is connected, the server has the profile and the profile has the chat), then switches profile if it must, asking first as the switcher does, and opens the chat. If a check fails, nothing on screen changes and a notice says why. A link only ever opens a chat: it never sends, runs, answers or signs in to anything. It opens on the computer it was copied on; one from elsewhere opens only when the owner says it is for the connection signed in (ADR 0037).
_Avoid_: deep link (fine in conversation), share link (nothing is shared with anyone), URL (for the link itself)

**Capability**:
A feature of this app that needs something from the Hermes server, such as a route or a method, and whether the connected server has it: Supported, Not supported, Unknown (Hermes answered, but that settles nothing) or Couldn't check (no answer, which may pass). Learnt from what Hermes says about itself, from the app's own requests, or from one request that only reads; never from a version number alone. Kept in memory for the current sign-in only (ADR 0044).
_Avoid_: feature flag (Hermes's own advertised switches, which diagnostics lists separately), permission, support (alone)

**Connection diagnostics**:
The Settings tab whose Server group shows what the connected Hermes says it is (version, protocol, sign-in, feature flags) and each Capability, with how and when it was learnt. Check again checks everything; Copy report copies it with secrets taken out. A screen whose Capability is Not supported shows a note linking here and to the compatibility guide, in its place. Its other group is Logs (ADR 0087).
_Avoid_: health check, status page, Logs (the app's and Hermes's log lines, the tab's other group)

**Logs**:
The group of Settings → Diagnostics, beside Server, that shows one source at a time: this app's own diagnostics (connection changes, failures it showed, uncaught errors), or one of the profile's Hermes logs (agent, errors, gateway, MCP servers). Following reads a Hermes log's last 500 lines every 2 seconds while it is on screen. Notes in the list mark where reading stopped and started again, and where lines may be missing. Pausing keeps the view still while reading carries on. Every line is redacted before the app keeps it. Nothing is kept after Logs closes, by showing another group, tab or profile or leaving Settings, except this app's diagnostics, which last until the app quits (ADR 0033, ADR 0087).
_Avoid_: console, debug log, activity

**Support bundle**:
One text file, saved where the owner picks, with every line kept of the sources they tick in Logs. Before saving it shows what goes in, how many of each kind of secret were redacted, and that redaction can miss a secret written another way. It is never uploaded (ADR 0033).
_Avoid_: debug report, debug share (Hermes's own, which uploads to a paste service)

**Saved copy**:
The transcript of a chat the owner opened lately, kept on this computer so it can be read while Hermes can't be reached, even after a restart. It shows with a note saying when it was saved, until the chat loads from Hermes again. Each connection and profile keeps its own, without the password. A copy never holds Approvals, errors or Failed messages. The least recently saved copies are deleted first once they pass the storage limit, deleting a chat deletes its copy, and Clear local cache deletes them all.
_Avoid_: cache (for one chat's copy), offline mode

**Model pick**:
The model, reasoning effort and fast mode the composer starts new chats on. It is sticky: it stays after starting a chat, switching chats or restarting the app, and is kept on this computer only. It never changes the profile's default model in Hermes. Picking with a chat on screen switches that chat alone, and becomes the pick for new chats. Switching profile restores that profile's own pick, or its default model until one is chosen.
_Avoid_: default model (that is the profile's, in Hermes), current model

**Memory**:
What Hermes remembers about the owner and their work between chats, for one profile. Hermes keeps it on the server in two files: its own notes, and what it knows about the owner. Each is a list of entries. The agent adds, changes and removes entries during chats; the owner can change or remove one in Settings → Memory, which saves to the server and reads it back. Hermes reads memory into a chat when the chat starts, so an edit reaches chats started after it. Settings → Memory shows any profile's memory, picked in the tab, and removes several entries at once in Select mode (ADR 0118); on a Hermes older than its profile-scoped memory routes, only the profile the dashboard runs as can be edited. Entries can't be copied to another profile: Hermes has no call that adds one. What a save from here replaced can be put back with Restore previous version until sign-out or quit, while the entry still holds what was saved; it's kept in the app's memory only (ADR 0040).
_Avoid_: notes, knowledge, context (for memory), cache (a Saved copy is not memory)

**Memory provider**:
An external store a profile uses for memory besides its own Memory files, such as Honcho: one at a time, or none ("Built-in only"). Which provider a profile uses, and that provider's settings, are the profile's own, kept by Hermes on the server. Profiles share memory only when they use the same provider pointed at the same store; for Honcho that is the same server, account, workspace and peers. Settings → Memory shows every profile's provider and, for Honcho, which profiles use the same server, workspace and peers; it switches a profile's provider, saves its settings (which also makes it the profile's provider, as Hermes does), copies another profile's settings to share its memory, and installs what a provider needs on the server, each confirmed by reading back (ADR 0045). A change reaches chats started after it.
_Avoid_: memory backend, memory plugin (a plugin can bring a provider, but isn't one), integration

**Skill**:
Instructions Hermes can load for a kind of task: a folder on the server holding a SKILL.md, whose front matter gives the skill's name and description, and sometimes other files the skill names. The agent sees each skill's name and description in every chat, and loads the rest when it needs it. A skill is the profile's own, in its skills folder, or shared, in a folder the profile's config names that other profiles may use too. Settings → Skills turns one on or off for the profile and edits its SKILL.md, saying either worked only once Hermes, read back, has it so (ADR 0030). An edit reaches the agent's next load of the skill in any chat; turning one off keeps it out of new chats and refused in all of them. Settings → Skills shows any profile's skills, picked in the tab; in Select mode it copies skills to another profile (their SKILL.md only), moves them (a copy, then an archive of the original), or deletes them, which archives them on the server, where `hermes curator restore` brings one back. Only a profile's own (Local) skills can be moved or deleted (ADR 0118). A skill that is on for the profile and for this app's chats can also be run from the composer, as other Hermes clients run it: picked after "/" at the start of a message, or typed as "$" and its name anywhere in it. The message then goes with the skill's whole SKILL.md loaded, and the chat shows it as "/name" and the owner's words (ADR 0015).
_Avoid_: plugin, tool, toolset (a toolset is a group of tools, not instructions), command (a skill runs from the same menu, but it isn't one of the app's slash commands, and a command of the same name wins after "/")

**Reasoning effort**:
How hard the model thinks before it answers: Off, Low, Medium, High, Extra high or Max. The pill beside the model picker shows it and changes it, and is hidden for a model without reasoning.
_Avoid_: thinking level

**Favorite model**:
A model the owner starred in the model picker. Favorites are listed first, and are kept on this computer even when Hermes no longer offers the model.
_Avoid_: pinned model (pinning is how Hermes stores Active, ADR 0002)

**Setup**:
The steps that connect Hermes Chat to a Hermes server: the server, the dashboard sign-in, then optionally a Provider key, which can be skipped. Setup tests the connection before it keeps anything, and says what to fix when the test fails. It opens by itself only on a computer with nothing set up, and again to add a Connection or change a saved one, from Settings, the rail or the sign-in screen (**Run setup again**). Cancelling it, or stopping Save and connect, leaves every Connection as it was.
_Avoid_: onboarding (fine in conversation, not in the app), wizard, first-run (that's only when setup opens by itself)

**Provider key**:
A model provider's API key that the owner gives Hermes, through Setup or Settings → Providers. The provider checks it first. Hermes keeps it in the profile's `.env` on the server, and Hermes Chat never stores it. Settings → Providers lists the shown profile's saved keys by Hermes's redacted preview, replaces a key, and removes one after asking; a removed key leaves the list only once Hermes reads back as not having it (ADR 0095). A subscription sign-in and a custom endpoint aren't Provider keys.
_Avoid_: token, secret, credential (too broad), login (a subscription sign-in isn't a key)

**Subscription sign-in**:
A profile's sign-in to a model provider's subscription, such as Nous Portal or ChatGPT, that Hermes keeps on the server in place of an API key. Settings → Providers signs in to a provider whose sign-in Hermes runs as a device code: Hermes gives a code, the provider's page opens in the browser, and the screen shows signed in once Hermes's list says so. A provider whose sign-in is external, such as an Anthropic Account, is signed in on the server's command line. Signing out asks first (ADR 0133).
_Avoid_: OAuth (the mechanism, not the thing), account (Hermes's word, too broad), login

**Custom endpoint**:
An OpenAI-compatible server a profile can use as a model provider, such as Ollama, LM Studio, vLLM or Groq, named by its base URL. Hermes checks it by asking it for its models, and reaches it from the server, so `localhost` is the Hermes server. Its API key, if any, goes to the profile's `.env` like a Provider key. Settings → Providers adds, activates as the default, and removes one (ADR 0133).
_Avoid_: local model (it may be hosted), custom provider (Hermes's older config name)
**Usage**:
The tokens a chat's model calls took in and gave out: input, cache read and written, output and its reasoning, and how many calls. A chat's usage is Hermes's own total for every call in it, from any client and across model changes. A reply's usage is shown only for a reply this app watched from start to finish, and is kept as long as its Saved copy.
_Avoid_: tokens (alone, for the whole breakdown), stats

**Cost**:
What a chat's usage cost, only as Hermes recorded it: reported by the provider, estimated, at least an estimate, included in a subscription, or unknown. It counts only the calls Hermes could price. The app keeps no prices of its own, and shows no cost per reply.
_Avoid_: price, spend, bill (except for a cost the provider reported)

**Usage analytics**:
The rail's Usage screen: the Usage and Cost Hermes stored for each chat started in a period, added up across chats, models, where chats started, projects, profiles and days. A chat counts in the period it started in, with all its usage so far, and a compressed chat counts once. The total cost says how much of the usage Hermes priced and is never a bill. Hermes's own sums sit beside it for a period ending now, with its helper tasks and subagent runs, which no chat carries. Nothing is kept on this computer; Export CSV saves the chats counted where the owner picks (ADR 0026).
_Avoid_: dashboard, stats, report, billing

**Context window**:
What the model reads on each call in a chat: Hermes's instructions, the tool descriptions, instruction files, memory, and the conversation, up to the model's limit. The status bar's meter shows how full it is, and its **context inspector** shows what fills it, as Hermes measures and estimates it. Hermes's total is labelled Exact (the provider's count), Partly estimated, or Estimated; its split by category is always its estimate (ADR 0025).
_Avoid_: context (alone, for memory), prompt, tokens (for the window)

**Compaction**:
Hermes swapping a chat's older messages for one summary that the model reads in their place, when the window fills or when the owner asks with **Compact now**. Every message stays in the chat and in Hermes, but the model no longer reads the ones taken out word for word. The context inspector lists the compactions Hermes stored, with the summary it kept. Compact now asks first, and is offered only between replies on a Hermes that can compact.
_Avoid_: compression (Hermes's word, fine in server-side talk), summary (that is what a compaction leaves), truncation

**Idle compaction**:
This app having Hermes compact a chat the owner has left: one open in this app, idle for the time set in Settings → Model, whose context window Hermes last measured at the mark set there or past it. It compacts a chat once for each measure Hermes takes, one chat at a time, and says what Hermes did. Off until the owner turns it on; kept on this computer. Hermes's own compaction when the window fills during a reply is separate (ADR 0119).
_Avoid_: auto-compact (Hermes's own compaction is automatic too), auto-compress, cleanup

**Side panel**:
The resizable panel beside the chat, with four tabs: Preview, Terminal, Files and Screen. It opens from the chat's header, and at a tab from the rail, a link or a tool call. In a window too narrow for both, it covers the chat until the owner goes back to it. Closing it, or going to another tab, leaves what runs in it running (ADR 0039).
_Avoid_: drawer, sidebar (that is the chat list), inspector

**Preview**:
The Side panel's tab that shows a web page, a Server page, a Server file, a Local file or a tool call's output. It works like a small browser that only the owner drives: Back, Forward, Reload, and an address box that follows a link clicked inside the page and takes a bare port such as `5173`. Back and Forward cross from a page to a file and back, and the Preview is where the owner left it after another tab. With nothing open, it lists Dev servers. It opens from a link in a reply, an opened tool call, Outputs or its address box, never on Hermes's own: Hermes's requests to read or drive it are turned down (ADR 0103). What it shows can't reach the app, the sign-in or this computer's other files (ADR 0007). On Linux a web page is the top level of a view of its own, so a site that refuses to be shown inside other apps still shows (ADR 0081). On Windows such a site gets a note and Open in your browser instead (ADR 0011).
_Avoid_: preview pane (its name before the Side panel), viewer, artifact (the official desktop app's word), browser panel (T3 Code's)

**Server page**:
A web page on the Hermes server's own loopback (`localhost`, `127.0.0.1`, `[::1]` or `0.0.0.0`), such as a dev server Hermes started there. The Preview opens a loopback address as a Server page unless the owner clicks its **Server** badge to open it from **This computer**. It loads through an SSH tunnel to the sign-in's SSH target, opened when it shows. The tunnel stays open while web pages follow one another in the Preview, so Back to the Server page needs no new one, and closes when a file shows or the Preview hides. A URL sign-in has no SSH target, so its Server pages don't open (ADR 0114, ADR 0103).
_Avoid_: remote page, tunnelled page, port forward (the mechanism)

**Dev server**:
A program listening on a port the Preview could open: on the Hermes server's loopback, found over the sign-in's SSH target, or on this computer's. The empty Preview lists them, each tagged Server or This computer, with the program's name when it can be read, and a click opens one. Only loopback or every-address listeners from port 1024 to 32767 count, less databases, brokers, ssh and the dashboard (ADR 0103).
_Avoid_: listener, open port, running app

**Link menu**:
The menu a right click, the Menu key or Shift+F10 opens on a link in a reply, a Side question, a Markdown file in the Preview or the Artifact editor, or on a tool call's web page chip: Open in the Preview, Open in your browser and Copy link. A Server page's Open in your browser does nothing and says why: it reaches the browser only through the Preview. A link the Preview won't load, such as `mailto:`, can only be copied. A same-page link has none (ADR 0079).
_Avoid_: context menu (fine in conversation), integrated browser (that is the Preview), system browser (say your browser)

**Server file**:
A file on the Hermes server, by its full path there. Hermes reads it, and Hermes may refuse, for example a file with credentials. Paths in tool calls are Server files, since that is where Hermes runs its tools.
_Avoid_: remote file

**Local file**:
A file on this computer that the owner picked to preview in the Open dialog. Hermes Chat reads it, and it isn't sent to Hermes.
_Avoid_: attachment (that is a file sent with a message)

**Extra request header**:
A header name and value the owner adds to a URL Connection, for a gateway in front of the dashboard such as Cloudflare Access. Hermes Chat sends it with every request to that dashboard and never to another site, or another Connection. Its value is kept in the system keyring, for that Connection only, and never shown in Settings (ADR 0104).
_Avoid_: custom header, gateway token

**Server files** (the Files tab):
The Side panel's browser for the Server files on the machine the Hermes dashboard runs on. It lists folders through the dashboard's managed files, as the server's own user can open them, the same for every profile, and never shows credential files such as `.env`. The server may limit it to one folder. Nothing on this computer is shown there. A file can be downloaded from it, a file the owner picks can be uploaded into the folder on screen, and a text file can be edited; nothing else on the server can be changed from it (ADR 0012, ADR 0023, ADR 0024).
_Avoid_: remote files, file manager, workspace (Hermes's word for a session's working folder)

**Download** (of a Server file):
Saving a copy of one Server file on this computer, where the owner picks in the Save dialog, which asks before replacing a file. It shows the server path, where it goes, and how far it got, and Cancel stops it. Until every byte has arrived, nothing takes the place of the file already there. It stops if the connection closes or changes (ADR 0025).
_Avoid_: export (that is a chat saved as Markdown), save

**Upload** (to the server):
Sending one file the owner picked on this computer into the folder Server files shows. Before anything is sent, it shows where the file goes. If the name is taken, the owner chooses to keep both or replace. Hermes is asked not to replace a file unless the owner chose that; it checks just before writing, not at the same moment. It counts as uploaded once the folder, listed again, has the file at the size sent. Credential files such as `.env` are never uploaded over (ADR 0025).
_Avoid_: attach, attachment (that is a file sent with a message), sync

**Edit** (of a Server file):
Changing a text file on the server from Server files, and saving it back. Save shows the changes first, and writes only if the server still has the version the edit started from. It counts as saved once Hermes, read back, has the edit. If the file changed on the server, nothing is written, and both versions stay: the owner merges them, takes the server's, or saves theirs as a copy (ADR 0024).
_Avoid_: patch, sync, overwrite

**Repository**:
The rail's screen for a Git checkout on the Hermes server: its folder, branch, upstream, and changed files with their diffs. It reads through the owner's own ssh, the Terminal's target or the sign-in's, not through the dashboard, so it works while Hermes is away. Git runs there as the SSH user, with that user's config, hooks and credentials (ADR 0110).
_Avoid_: repo (in the interface), project (a Project is Hermes's group of chats and folders), workspace

**Worktree**:
A separate working folder of a repository on the server, with its own branch, made by Git (`git worktree add`). The Repository screen's Worktrees view lists them all. A **managed** worktree is one Hermes Chat made: it is recorded in the repository with its setup and the chats working in it, and only it can be removed from here. A chat started in a worktree works only there. A worktree with a chat **attached** can't be removed until the owner detaches it: a quiet chat still counts. A **Protected** worktree, the main checkout, and one Hermes Chat didn't make are never removed (ADR 0043).
_Avoid_: workspace, sandbox, clone (a clone has its own `.git`), checkout (for a worktree that isn't the main one)

**Setup** (of a worktree):
What runs once in a new worktree before a chat works there: the files and folders the repository's `.worktreeinclude` names, copied or linked from the checkout it was made from, as Hermes does for its own worktrees. Setup commands, such as an install script, aren't run. A failed or cut-off setup leaves the worktree, with Retry.
_Avoid_: bootstrap, provisioning, install

**Kept changes**:
What a worktree's removal saved first: every changed and untracked file, as a commit on top of its HEAD (or HEAD itself, for commits no branch had), under `refs/hermes-chat/kept/` in the repository. Restore in a new worktree starts one from it. Nothing here deletes them.
_Avoid_: stash (it isn't one), backup, archive (Hermes's own sweep uses `refs/hermes/archive/`)

**Staged** / **Not staged** / **Untracked**:
Where a change in the Repository screen is. Staged changes are in Git's index, what the next commit would hold. Not staged changes are in the working tree only. An Untracked file isn't in Git yet. One file can have changes in both of the first two, and the screen shows each side's diff on its own.
_Avoid_: cached, added (for staged), dirty, unversioned

**Commit preview**:
What the Repository screen shows before it commits: every staged file, the whole staged diff, the message exactly as it will be committed, the author, the branch and the commit it goes on top of, and the hooks that will run. Commit happens only if the repository still has exactly that, on the same branch; otherwise nothing is committed and the preview is read again.
_Avoid_: dry run, summary

**Push** / **Create pull request**:
The Repository screen's two separate ways to publish a branch. Push sends the commit shown to the remote branch shown, with the server's own credentials, and never forces. Create pull request asks GitHub, through `gh` on the server, for a pull request from a branch the remote already has. It never pushes. Each goes only where it showed: if the branch, its commit, the remote's URL or its GitHub repository changed meanwhile, it's refused and nothing is sent.
_Avoid_: publish (for either one alone), sync, ship

**Terminal**:
The Side panel's tab with the owner's own shells: one on the Hermes server, through their ssh to the sign-in's SSH target (for a web-address sign-in, the address's host), or one typed for it, and one on this computer, their login shell. ssh asks there for anything it needs, such as a passphrase or a new host key. A switch at the top picks **Hermes server** or **This computer**. The tab opens on the one picked last, the server's until then, and says so plainly when the server has no SSH target. Each session runs on while the other is shown or the panel is closed, and the rail shows it; signing out ends both. They are the owner's shells, not Hermes's: nothing typed there reaches a chat, an Approval or the agent (ADR 0022, ADR 0039, ADR 0051, ADR 0055).
_Avoid_: console, shell (for the tab), Hermes's terminal tool (the agent's, which runs in a chat)

**Screen**:
The Side panel's view of Hermes's Bot Desktop for the profile shown: a desktop on the server where the agent's computer use and its browser run. The owner watches it, and can Take over and Hand back. Hermes starts, stops and keeps it, one per profile; this computer only shows it (ADR 0039). When the server has no Chrome or Chromium for the agent to open there, the Screen and Settings → Diagnostics say so, with the command that installs one (ADR 0078).
_Avoid_: remote desktop, VNC, browser (for the whole screen), computer use (that is the agent's tool)

**Take over** / **Hand back**:
The owner's actions that make their keys and pointer drive the Screen, and give it back to the agent. While the owner holds it, Hermes's computer use waits. Another viewer taking over puts the owner back to watching; leaving the Screen hands back.
_Avoid_: control, lease (Hermes's word, fine in server-side talk), takeover (as a verb)

**Output**:
A Server file that one of Hermes's tools reported writing in a chat: `write_file`, a file `patch` created, `text_to_speech` audio or an `image_generate` image. It is known by its path, the tool call that made it, and that call's chat. A path a reply or another tool only mentions isn't an Output. The same path written twice is two Outputs, two versions, and only the newest is what the path holds now. The owner can also add a Server file to Outputs by its path. Outputs shows them for the open chat, the project the list shows, or every chat in the profile, and checks each time it opens whether each file is still at its path: one that is gone shows Missing, and can't be opened. This computer keeps only their paths and where they came from (ADR 0016, ADR 0064).
_Avoid_: artifact for an Output in general (the official desktop app's word, which also counts mentioned paths and links; here an **Artifact** is an Output open to edit), attachment, generated file (in the app's text)

**Artifact**:
An Output that is a text file, open to edit in the Preview beside the chat. It is one path on one machine (where the profile's tools run, or the dashboard's own), opened in one connection and profile. Its draft stays in this app's memory, apart from the file, until Save. Save writes only if the server still has the version the edit started from, and counts as saved once Hermes, read back, has it. "Ask Hermes to edit" gets a **proposal**: Hermes's new text for the selection, made against the editor's exact text, which the owner reviews and applies to the editor, never straight to the file. The versions a save replaced stay recoverable until the app quits or the owner signs out (ADR 0029).
_Avoid_: document (any file), canvas, patch (for the proposal before it's applied)

**Unsecure**:
The warning on a connection whose traffic between this app and the server isn't encrypted.
_Avoid_: insecure (the app's label is "Unsecure"), unsafe

**Persona**:
A profile's SOUL.md on the Hermes server: who Hermes is and how it speaks in that profile's chats. Settings → Persona edits the file of any profile on the server as plain text, picked at the top of the screen and starting on the profile in use; picking one doesn't switch the app's profile. A Save writes only if Hermes still has what the edit started from, and the app says it saved only once Hermes, read back, has it. If the file changed elsewhere, nothing is written until the owner chooses. Chats started afterwards use the new persona; a chat under way keeps the one it started with. Hermes needs no restart, and the app never restarts it. An edit not saved stays on this computer, per connection and profile, and the last five versions that saves from here replaced are kept to put back. The saved SOUL.md can be copied over another profile's, checked first and read back (ADR 0118).
_Avoid_: soul, personality (Hermes's `/personality` presets are another thing), system prompt

**Scheduled job**:
A Hermes cron job in one profile: a prompt Hermes runs at the times its schedule sets, delivering the reply where the job says. Hermes keeps the job on the server and its gateway runs it there, so it runs while Hermes Chat is closed. The Scheduled jobs screen lists the profile's jobs with their schedule, Schedule time zone, next run, last result and delivery, and creates (in any profile), edits, pauses, resumes, runs and deletes them through Hermes, with each job's Job runs. A change shows only once Hermes, read back, has it. Deleting a job, or running it now, asks first (ADR 0013).
_Avoid_: cron (Hermes's name, fine in server-side talk), task, automation, reminder

**Automation**:
A Hermes webhook route in one profile: when GitHub sends an event to it, Hermes checks the event's signature, filters it, and starts a task with a prompt made from the event. Hermes keeps the route and runs the task on the server, so it works while Hermes Chat is closed. The Automations screen sets routes up, previews what an example event would do, and shows what became of the events that arrived (ADR 0108).
_Avoid_: webhook (fine for the transport), trigger, hook, scheduled job (that runs on a clock, not on an event)

**Delivery**:
One event a provider sent to an Automation, identified by the provider's delivery id. Its state says what Hermes did with it: received, filtered out, waiting to coalesce, replaced by a later event, queued, running, completed or failed. A request whose signature, size or timing didn't check out isn't a delivery: it is only counted. A copy of a delivery, or its signed body sent again under a new id, is counted on it and never runs again.
_Avoid_: event (the provider's word for what's inside), request, hit

**Run now**:
The owner's action that has Hermes run a Scheduled job at once, on the server, as its schedule would: a real run with the job's real delivery. Hermes answers when the run has finished, and resumes the job if it was paused. Hermes refuses it while a run of the job is under way.
_Avoid_: trigger, test run

**Job run**:
One run of a Scheduled job, as Hermes recorded it: an agent session, or the output a script job printed. Its state is running, succeeded, failed, or unknown, when Hermes recorded no outcome (the run's process stopped, or Hermes went on in a session it doesn't list). Its result is the agent's last reply, read from the session, or the script's output.
_Avoid_: execution (Hermes's ledger word, fine in server-side talk), attempt, chat (an agent run is a Hermes session, but not one of the chats)

**Troubleshoot** (a Scheduled job):
The owner's action, on a job or on one of its failed Job runs, that hands the job to Hermes in a new Chat in the job's profile. The first message carries the job, its newest runs with their errors and results, and the problems the Scheduled jobs screen flags, with long text cut and recognisable secrets hidden; the owner sees and can edit it before it is sent. Hermes finds the cause and changes the job with its own cron tools, saying what it changed. When its reply ends, the Scheduled jobs screen reads the job again, shows what changed since the chat started, and offers Run now (ADR 0053).
_Avoid_: diagnose, debug, fix (Hermes fixes; the owner troubleshoots), repair

**Schedule time zone**:
The time zone Hermes reads a profile's schedules in and runs its jobs on: the profile's `timezone` setting, else the server's own zone. Times on the Scheduled jobs screen are on it, with this computer's time beside them when it reads differently; daylight-saving changes follow it.
_Avoid_: local time (ambiguous between the server and this computer), display time zone (this computer's)

**Pane**:
One view of a chat, its transcript and composer. The app can show two, side by side or one above the other. Each pane
has its own tabs; a tab dragged to the other pane or to a pane's edge moves there (ADR 0052). The focused pane is the one the
chat list, Search and keyboard shortcuts target. This focus does not change whether a chat is Active or Settled.
Two panes of one chat share its Draft, Queued messages and running reply; each has its own scroll, Find and pending
Attachments.

**Compare**:
Two panes whose sends go to both: one message typed in either pane goes to the chat in each, so two models answer it side
by side. It starts from the model picker, which opens a new chat on the second model in the other pane. Each is an
ordinary chat. While either has a reply running or messages queued, sending is refused rather than queued. It ends when
the owner stops it, or when either pane shows another chat or closes (ADR 0101).

**Update**:
A newer version of Hermes Chat itself. For the packaged app, the owner installs it with pacman, and the app never replaces pacman's files. For a standalone build made with an update key, the app installs it, after checking its signature. Either way the new version runs only after the owner restarts the app. Drafts, unsent and uncertain messages, and queues are kept across the restart, for every connection, profile and chat. Files attached in a composer and a second pane aren't. A saved copy that can't be put back is set aside in a file of its own and never put back automatically (ADR 0060).
_Avoid_: upgrade (pacman's word, for the package step only)

**Release**:
A signed standalone AppImage, its signature and the `latest.json` manifest that names it, built from `src-tauri/tauri.release.conf.json`. A dry run builds and checks one with a throwaway key and keeps it as a workflow artifact. Only a published release, served at the update endpoint, reaches installed copies (ADR 0075).
_Avoid_: build (any compile), package (pacman's)

**Update key**:
The key pair a Release is signed with. The public half is built into a standalone AppImage, which installs only what that key signed. The private half is the owner's, kept out of Git and logs.
_Avoid_: signing key (ambiguous with Git commit signing)

**Interface language**:
The language Hermes Chat's own words are in, picked in Settings → Appearance: System, or a language by its own name. System takes the first of the desktop's languages the app has words for, else English. Dates and numbers follow it too, in the desktop's region where that is in the same language. A screen not yet translated stays English, and a word a language lacks shows in English (ADR 0100). It changes nothing Hermes writes: replies come in whatever language the model answers in.
_Avoid_: locale (the code's word for the language, its tag and its formats together), translation

## Relationships

- Every **Chat** is either **Active** or **Settled**, never both. An **Archived** chat keeps that state for when it is restored.
- An **Active** chat shows in one place in the list: **Snoozed** if it is snoozed, **Working** if Hermes is replying in it, otherwise the **Inbox**.
- Every **Chat** has exactly one **Source**.
- Every **Chat** belongs to exactly one **Profile**; Active and Settled are kept per profile.
- An **Imported chat** becomes **Active** only when the owner sends a message in it from this app.
- An **Imported transcript** is an **Imported chat** that stays **Settled** until the owner unsettles it: nothing can be sent in it from this app.
- A **Branch** has exactly one parent chat, in the same **Profile**; a chat can have any number of branches.
- Every **Screen** belongs to exactly one **Profile**; switching profile shows the other profile's.
- Every **Version** of a turn is a **Branch**; a turn's versions share one root chat, whose own answer is the Original.
- Every **Project** belongs to exactly one **Profile**. A **Chat** can be in any number of its profile's projects, or none; being in one doesn't change whether it is **Active**, **Settled**, **Archived** or **Unread**.

## Flagged ambiguities

- **Screen** vs a web page in the **Preview**: both can show a site, but the Screen's browser runs on the server and is the agent's, with its sign-ins; the Preview loads the page on this computer, isolated from the app, and is the owner's alone.
- **Artifact** vs **Edit** (of a Server file): both edit a text file's text with the same checked save, but an Artifact is an Output, edited beside the chat on the machine its tool wrote it on, with Hermes's proposed edits and kept versions. A Server file edit is made in the Files tab and only reaches the dashboard's machine.
- **Output** vs a path in a reply: Outputs counts only what a tool's own result says it wrote. A reply that says "saved to /srv/x.pdf", or a `terminal` command that creates a file, makes no Output, though the owner can add that file by its path.
- **Inbox** vs **Rail inbox**: the Inbox is the chat list's first section, one profile's Active chats; the Rail inbox, opened from the tray's Open Inbox, lists what needs the owner across every profile on the server, chats in any state included. Settling a chat doesn't dismiss its Rail inbox entry, and dismissing an entry doesn't settle the chat (ADR 0063).
- **Settled** vs **Archived**: they are different things. Archiving sets Hermes's own "archived" flag and hides a chat in every Hermes client; settling is this app's view of the owner's attention, stored as the "pinned" flag. Neither touches the other (ADR 0005).
- **Queued message** vs **Draft** vs **Failed message**: a Draft hasn't been sent or queued; a Queued message waits in the chat's queue to be sent by this app; a Failed message was sent, and Hermes didn't take it or may not have. A queued message that goes leaves the queue, and becomes a Failed message only if Hermes doesn't take it.
- **Imported chat** vs pulling older history: the list holds the past month's chats until the owner pulls older history in Settings, after which it holds all of the profile's chats. Pulled chats come in Settled unless pinned, but they are Imported chats only if their Source isn't this app.
- **Imported chat** vs **Imported transcript**: an Imported chat is any chat started outside this app, which the owner can carry on here. An Imported transcript was made from an export file, has the Source `import`, and is read-only here.
- **Restore** (an Archived chat) vs **Restore a backup**: the first is Hermes's, for one chat; the second writes this computer's own data from a Backup file, and changes nothing on the server.
- **Import** vs **Export** and **Upload**: Export saves one chat as a file on this computer; Import makes chats in Hermes from such a file; Upload puts a file on the server's disk, not in a chat.
- **Draft** vs the New chat pane: the code also calls the pane for a chat not started yet "the draft". In this glossary a Draft is only the composer's unsent text.
- **Approval** vs **Approval mode**: an Approval is one question Hermes asks, as a card in the chat; the Approval mode decides which commands Hermes asks about at all.
- **Toolset** vs **Approval** and the **Approval mode**: a toolset decides which tools the model is offered at all; the Approval mode, and the Approvals it leads to, decide whether a command Hermes counts as dangerous runs without asking. Turning a toolset on or off changes neither. Speech-to-text is listed among the toolsets because Hermes lists it there, but it has no tools: its switch is the profile's `stt.enabled`, which Dictation uses.
- **Dictation**, **Read aloud** and **Voice conversation** vs Hermes's voice mode: Hermes's `/voice` mode (`voice.record`, `voice.tts` over the socket) records with the server's own microphone and speaks through the server's speakers. This app never uses it. Dictation and a Voice conversation record on this computer, and all three use the server only to transcribe and to make the audio. A Voice conversation borrows only voice mode's turn settings (`voice.silence_*`, `voice.max_recording_seconds`).
- **Stop speaking** vs **Stop reply** (in a Voice conversation): Stop speaking stops the reply's audio and leaves the reply as it is; Stop reply is the composer's Stop, which has Hermes stop the reply itself.
- **Automation** vs **Scheduled job**: both start Hermes tasks on the server, an automation when an event arrives, a scheduled job at set times. A route can also start a scheduled job on each event (`cron_job`); Hermes Chat shows such a route but doesn't set it up. An automation's tasks are `webhook` sessions, listed among the chats as from another Hermes platform.
- **Retry** (of a Delivery) vs **Retry** (of a Failed message): retrying a delivery has Hermes run the stored event again as a new task on the server, through the automation's rules as they are now; it never undoes what the failed attempt did.
- **Scheduled job** vs its **Job runs**: each run of an agent job is a Hermes session with source `cron`. The chat list leaves those out; the job's runs show on the Scheduled jobs screen, where Show the result reads a run's reply without opening it as a chat.
- **Branch** vs Hermes's other children of a session: Hermes also gives `parent_session_id` to a chat it compressed onto a new session, and to subagent and tool sessions. Only one made with Branch from here is shown as a Branch, with where it came from. Hermes stores a branch made here with source `tui`, because of how the legacy resume records the live session; the app shows it as this app's chat (ADR 0027).
- **Edit** (of a message) vs **Edit** of a Failed message vs **Edit** of a Server file: Edit under a message Hermes has makes a Version in a new branch and never changes the chat. Edit on a Failed message takes its words back into the composer. Edit of a Server file changes that file. **Regenerate** (a reply) makes a Version too; **Regenerate title** only renames the chat.
- **Source** vs the `source` field on a Hermes session: the app derives a chat's Source from that field, but the field has more values than the app shows. `gui` (what this app stamps on chats it starts) and `hermes-chat` (what it stamped before; Hermes won't edit those) count as this app, and `cli` and `tui` as the command line. `cron` chats aren't listed, and any other value (for example `api_server`, `webhook`) shows as "another Hermes platform".
- **Context window** vs **Usage**: the window is what the model reads on one call, now. Usage, cache reads included, adds up over every call in the chat, so a chat's cache reads can far exceed its window. The context inspector shows the cache as billing, apart from the window's size.
- **Memory** vs a **Saved copy** and the local cache: memory is the agent's, on the server, and changes what Hermes knows. Saved copies and drafts are this computer's copies of chats and change nothing in Hermes. Memory vs a memory *provider*: a profile may also use an external provider (such as Honcho) whose memories live with that provider; Settings → Memory names it but doesn't show or edit what it stores.
- The project the list shows vs Hermes's *active* project: Hermes keeps one active project per profile for its own CLI and the official desktop app (`projects.set_active`). Picking a project in this app's list never changes it; the pick is kept on this computer.
- **Persona** vs Hermes's personalities: `/personality` and `agent.personalities` in Hermes's config are named presets laid over a chat's prompt. Settings → Persona edits only the profile's `SOUL.md`. It never sets or changes a personality.
- **Project** vs a chat's working folder: Hermes also groups chats by the folder each one runs in (`cwd`). This app doesn't: a chat is in a project only when the owner put it there, or started it while the list showed the project. Putting a chat in a project doesn't change the folder it runs in. Only a project's default folder, or Apply the project's defaults, sets the folder a chat runs in, so other clients may then group that chat by it.
