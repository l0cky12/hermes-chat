# A message sent while a reply runs is queued or steered, by a setting, through /steer

Issue #189. While Hermes replies, Enter queued the message for after the reply (ADR 0018). Telling the running reply something meant typing `/steer <message>` (ADR 0015). Settings → General → **Chats** now has **Follow-up behavior**: **Queue** (the default, so nothing changes until the owner picks) or **Steer**.

## Decisions

- **Only while a reply runs.** With no reply running, Enter sends, or queues behind messages already queued, as before, and Ctrl+Enter does the same. While a reply runs, Enter does what the setting says and Ctrl+Enter does the other, for that one message. Offline, everything queues, as before.
- **The composer says what Enter does.** Its hint reads "Enter to steer · Ctrl+Enter to queue" or "Enter to queue · Ctrl+Enter to steer". The button beside Stop is the Steer button when Enter steers and the Queue button when it queues. One button, not two, so the button and Enter always agree. When the message can't steer, the hint names only what Enter does, and its tooltip says why.
- **A steer is a typed `/steer`.** It goes through `Hermes.steer`, which calls the same `runServerCommand` → `command.dispatch {name: "steer", arg, session_id}`, and it is offered only when the slash command would run: `commands.why(STEER)`, which reads `listServerCommands`. So a Hermes that doesn't list `/steer`, a quick or plugin command that takes the name (`replaced`), a failed discovery of those (`unsure`), a check still running, and a chat still loading all mean the message is queued. The composer says so once per reason while the app runs: "Your message is queued, not steered. /steer can't run: …".
- **Files are queued.** `command.dispatch` takes words only (`_cmd_steer` passes `arg` to `agent.steer(text)` at `bf0203a`), so a message with attachments is queued, with a note each time.
- **The Draft empties once Hermes took the words**, and only if the owner hasn't changed it meanwhile, as for a slash command. If Hermes refuses, the words stay and the composer says why. One steer at a time per composer.
- **When Hermes has no reply to steer** (`{type: "send"}`: the reply ended, or its agent wasn't ready), the words go to the end of the queue and the composer says Hermes couldn't steer the reply just then. A typed `/steer` sends them at once instead (ADR 0015); a follow-up joins the queue so it never jumps a message queued before it, and the queue's pauses still apply.
- **A steered message shows in the chat** at the end of the transcript, when Hermes accepts it, marked "Steered into the reply" with a dashed outline. It is a user item with `steer: true`. Hermes stores the steer as a user row with `display_kind: "steer"` (`steer_user_row`, `STEER_DISPLAY_KIND`), and `session.resume` sends that `display_kind`, so a reloaded chat marks it too. The Saved copy keeps the mark.
- **A steer doesn't start a turn.** The live turn (where a turn's reply, reasoning, usage and Approvals are looked for at its end) starts after the owner's last message that isn't a steer (`turnStart`). Without this, a provider that repeats the whole reply in `message.complete` would show it twice after a steer, and a voice conversation would stop following its reply.
- **Kept with the display preferences** (`followUp` in `hermes-ui-prefs`), on this computer, for every connection and profile. Nothing goes to Hermes's `display.busy_input_mode`.
- **A fifth General group, Chats.** ADR 0113 asks a new group to argue for itself. Follow-up behavior is about how chats behave, which none of Connection, Launch, Screenshots or Storage covers, and Appearance is about how things look. More chat behavior settings can join it.

## Considered options

- **Hermes's own busy mode (`prompt.submit` while a turn runs with `busy_input_mode: steer`).** It would steer every message from every client of the profile, and it changes Hermes's config. Its fallback, queueing in Hermes, can't be listed, edited or paused (ADR 0018). Rejected.
- **`session.steer`.** A newer legacy method at `bf0203a` with the same effect, but the issue asks for the `/steer` route, whose availability check (catalog, replaced, unsure) already exists and is tested. Using one route keeps one set of rules.
- **Both buttons beside Stop.** Mouse users could pick each time, but two primary buttons next to Stop crowd the composer, and the Enter hint would no longer match "the" button. Ctrl+Enter covers the other choice.
- **Sending a steer's `send` answer at once, as `/steer` does.** Rejected for follow-ups: it could go ahead of queued messages, and after a stopped or failed reply, when the queue would have paused.

## Consequences

- A steer arrives after the reply's next tool call. If the reply makes no more tool calls, Hermes runs the words as the next turn itself (`pending_steer`, `_run_post_turn_followups`); the chat still shows them as a steer until it is read again from history. A queued message going then is held behind that turn, and the queue pauses (ADR 0018).
- Stopping the reply drops a steer Hermes hasn't delivered yet (`interrupt_control`, hard stop). The transcript keeps showing it until the chat is read again.
- The steer is placed where it was sent, at the end of the transcript then. Hermes stores it after the tool call it followed, so a reload can show it a little later in the reply.
- Steered messages are user rows to Hermes's undo, so Edit and Regenerate count them as turns, as for a steer typed with `/steer` (ADR 0035).
