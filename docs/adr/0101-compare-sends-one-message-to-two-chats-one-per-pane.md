# Compare sends one message to two chats, one per pane

Issue #351. The owner wants to send one prompt to two models at once and read the answers side by side, so picking a model for a task is a quick comparison instead of two chats and two sends by hand. The app already has two panes (ADR 0010) and a model picker in each composer. Each pane holds its own chat, so until now a message typed in one went to one model.

## Decisions

- **Two ordinary chats, one per pane.** Compare starts from the model picker: **Compare with another model** turns the same popover into a pick of the second model. The other pane, or a new one, goes to the New chat pane on that model. The pane Compare started from keeps its chat and stays the active one. Each side is a normal Hermes chat, so its history, usage, branching and title work as for any chat, and stopping Compare leaves two ordinary chats.
- **One state value in `Main`.** `compare` holds the two sides, each a pane and the chat it shows, and the second side's model. Compare is live only while both panes exist and each still shows its side's chat. A chat started from a compared New chat pane updates its side in the same step that puts it in the pane. Anything else that changes what a pane shows (opening another chat there, closing it, the chat being deleted, switching profile) ends Compare without code of its own at those places.
- **Each pane sends through its own `ChatView`.** A pane's `deliver` starts its chat if it hasn't started, with that pane's model, the shown project's folder and instructions, and the folder and worktree checks, then sends. A send in a compared pane calls its own `deliver` and the other pane's, which `Main` keeps by pane key. The second chat starts fresh: it has none of the first chat's history.
- **Screenshots are held once for both.** A captured screenshot is held before the two deliveries and let go after both, since the screenshot desk doesn't count holds and letting go after the first would delete a file the second still uploads.
- **The message typed belongs to the pane it was typed in.** The other pane's draft is left as it is. If the other chat can't start, its pane shows why, as a New chat pane does, and the text is not put back there.
- **Refuse rather than queue or steer.** While comparing, if either chat has a reply running or messages waiting, or Hermes isn't connected, Enter and Send say "Compare sends to both chats, so it waits until both replies have ended. Nothing was sent." and keep the draft. The composers in a compared pair neither queue nor steer, and their hint says "Enter to send". A queue a chat already had still shows and still goes.
- **Skills and attachments go to both**, through the same `deliver`.
- **The approval mode.** Smart and Manual are the profile's (ADR 0091), so they already apply to both chats. A chat's YOLO flag is not copied to the other: ADR 0091 shows the YOLO warning every time YOLO turns on, and copying it would turn it on in a chat the owner never saw the warning for.

## Considered options

- **`Main` owning the send for both panes.** Rejected: what a new chat starts with (the chosen model, the shown project's defaults, the worktree, the folder check, the profile check) lives in each pane's `ChatView`. Moving it up would duplicate that path or move all of it.
- **Queue in both chats.** Rejected: a partner chat that hasn't started has no queue, and two queues would drift as soon as one pauses, fails or is edited, so the two chats would stop getting the same messages in the same order.
- **Copying a chat's YOLO flag to the other.** Rejected for the warning above.
- **A third pane or more.** The layout has two panes. More columns are left for later, as the issue says.

## Consequences

- **Compare doesn't survive a restart.** Like the split layout, it lasts for the current run.
- **A message that fails in one chat still went to the other.** Each chat shows its own Failed message, and Retry sends it in that chat alone.
- **Two New chat panes share one draft.** Starting Compare from the New chat pane shows the same text in both composers until the chats start, since the New chat draft is one per connection and profile.
