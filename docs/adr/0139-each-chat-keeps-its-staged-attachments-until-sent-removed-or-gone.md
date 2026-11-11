# Each chat keeps its staged attachments until they are sent, removed, or the chat goes

Attachments staged in a chat's composer lived in that composer's React state. When the composer went (another chat opened, a pane closed, Settings covering it), its cleanup deleted every staged screenshot or pasted file and forgot the rest. The Draft text survived the same switch, because drafts are kept outside the composer (`drafts.ts`). So an owner who attached a screenshot in chat A, answered something in chat B, and came back to A found the text but not the screenshot (#443).

## Decisions

- **Staged attachments are kept per chat, keyed as the Draft is.** The screenshot desk (`screenshots.ts`), which already owns the lifetime of captured and pasted files, keeps a list of staged attachments for each Draft key: connection, profile and chat id, with the New chat pane as its own key. The composer reads and changes its chat's list and no longer owns it.
- **One list of events changes a chat's list.** `added` (attached, or back from a message Hermes didn't confirm), `sent` (the message holds them from then on), `removed` (the owner took them out), and `gone` (the chat was deleted or archived from this app). Signing out, removing the connection in use, or switching connection ends the desk and deletes them all, as before.
- **A file the app owns is staged in one chat at a time.** The desk deletes a captured or pasted file once it is removed, its chat goes, or its message no longer needs it. The app never stages one in two chats itself. The owner can, by picking it from the captures folder in another chat, and then it moves to that chat: Rust deletes it once that chat's message no longer needs it, so it can't stay in the first. A closing composer deletes nothing. A file the owner picked from their own folders is never deleted, and can be staged in several chats.
- **Two panes on one chat share its staged attachments**, as they share its Draft. A send from either pane takes the Draft's text, so it takes the files staged with it too. A screenshot still goes to the composer on screen when it lands.
- **A New chat pane's attachments behave like its Draft.** The first send takes them with the text. When the chat can't start, the text comes back to the New chat Draft and its screenshots come back to the New chat pane's list.
- **They are kept for this run only.** A restart drops them, as ADR 0060 already says for files attached in a composer. Settings → Updates names every chat's staged files before a restart, whether or not that chat is on screen. The startup sweep in Rust only clears capture folders of instances that are no longer running, so it never touches a file a chat holds in this run.

## Considered options

- **Keep them across a restart, like the Draft text.** It needs the staged files' paths saved per chat and kept out of the startup sweep. Left for a follow-up if the owner wants it.
- **Let an owned file stay in several chats, and tell Rust which files are staged.** Rust's outbox cleanup deletes a capture once no message needs it, so the desk would send every staged path with the outbox's paths and reconcile on each change. Only a file picked by hand from the captures folder gets there, so moving it is enough.
- **A store separate from the desk.** It would need to call the desk to delete files and share its lifetime with it. Keeping the lists in the desk puts every deletion decision in one place.
- **Each pane keeps its own staged files on a shared chat.** A send from one pane would take the shared Draft text and leave the other pane's files staged for a message already sent.

## Consequences

- Files staged in chats the owner has left stay on disk until they are sent or removed, the chat is deleted or archived here, or the owner signs out. A chat deleted or archived from another Hermes client keeps its staged files here until sign-out.
- When Hermes doesn't confirm a message, its screenshots go back to the chat it was sent from, not to whichever composer is on screen. The note saying so shows only if that chat's composer is on screen at the time.
