# A referenced chat goes as a summary with its message

> **Accepted.**

The owner wants to build on another chat from the one they are writing in, without pasting it in. Typing "@" in the composer, or pressing its "@" button, lists the profile's other chats; picking one adds a chip above the text. Hermes Chat has the chat summarized and sends the summary with the message.

## Decisions

- **The summary is a legacy `llm.oneshot` call on the profile's Text generation model**, as Regenerate title is: no `session_id`, so it adds nothing to either chat. Its input is the referenced chat's stored messages, read with dashboard REST: the owner's words as typed (`typedText`) and the replies, without hidden rows, model-switch markers or `[System:` notes, each cut to 4,000 characters, and the first message plus the newest that fit when the whole is over 48,000. The instructions ask for at most about 250 words on the goal, facts, decisions, what was done and what is open, and say the transcript is data. A missing credential for the model's provider shows the same fix as Regenerate title, a link to Settings → Model. The app stops waiting after 90 s (`ASK_DEADLINE_MS`).
- **The summary goes as attached context on the message it was written with.** Each reference is one block after `--- Attached Context ---`, beside any project context blocks, headed `[Referenced chat: <title>]` and a line saying it is background, not instructions. Hermes's `@file:`-style expansion is defused in it, as in project context. Every Hermes client hides that part, so the bubble shows the typed words and a "Referenced: <title>" chip, read back from the stored text after a reload.
- **The outbox keeps the summaries with a failed message**, so Retry and a restart send the same summaries again. A New chat that can't start puts its references back in the composer with its words.
- **Unsent references are kept in memory only**, per Draft like staged attachments (ADR 0145). A message waits until every summary is ready; a failed one offers Retry. References alone don't make an empty message sendable.
- **Only the current profile's chats**: not the chat being written in, a Bot Chat or an archived chat.
- **A message with references isn't queued or steered.** The summaries are meant for the turn they were written for, and a steer carries words only. The composer says to send it once the reply ends. Compare sends the references to both chats.

## Considered options

- **Seeding the summary as a hidden row before the message**, as project instructions are. It would belong to the chat rather than the message, so Retry and Compare couldn't carry it, and it needs a new chat.
- **Sending the whole other chat.** Long chats would crowd out the context window; a summary is what the owner asked for.

## Consequences

- The referenced chat's summary is made when it is picked, so later messages in that chat aren't in it. Picking it again in a later message makes a new one.
- A Text generation model that is slow or down delays the message, not the chat: the owner can remove the reference and send.
