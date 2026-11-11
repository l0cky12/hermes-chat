# A send whose outcome is unknown is settled by reading the chat's history back

A message sent from this app is marked in its chat until Hermes answers `prompt.submit`: `sending`, then plain once Hermes takes it. If Hermes refuses it, or it never goes out, it is `failed`. If the connection drops, or the app closes, after the frame went out and before the answer came back, it is `unknown`: Hermes may be running it. A failed or unknown message stays in its chat with its words, its files and why, and a Retry control. Retry sends the same words and files as a new message. It never continues the first one. Nothing sends a message again on its own.

An unknown message is settled by reading the chat's history back, and the history wins over what the app showed. When the chat resumes, its whole history is read. At every list refresh, the newest 100 stored rows (`GET /api/sessions/{id}/messages`) are read for a chat not loaded on this connection. The message counts as arrived when the history has an owner's message with the same prompt that is newer than the newest stored row the chat had when it went out (`row_id` on resume rows, `user_row_id` and `persisted_turn` on turns). Then it goes from the outbox, and the chat shows the history's row. If not, it is marked failed. When the rows read don't reach back that far, it stays unknown until the next read.

Failed and unknown messages are kept in each chat's outbox on this computer, per connection, profile and chat. They are never in a Saved copy, which holds only what Hermes stores. Clear local cache keeps the outbox, as it keeps drafts. A message still `sending` when the app closed comes back `unknown` if it had gone out, and `failed` if it hadn't.

## Considered options

- **Hold the words beside the composer, and leave an unknown send for the owner to judge for ever.** This was the first version. Its reasoning was that matching words don't prove which send arrived. Rejected: the row id baseline makes the match specific to this send, and leaving it unknown meant a message could sit unresolved after every restart. The optimistic message also stayed in the transcript looking delivered, and it went into the Saved copy as if Hermes had it.
- **Match by words alone.** Rejected: the same words sent earlier in the chat would count as this send arriving.
- **Send an idempotency key with the prompt, so Hermes dedupes a retry.** The research doc lists no such field on legacy `prompt.submit` (§ "Legacy contracts at `bf0203a`"). This hasn't been checked against the Hermes source. If Hermes gains one, it beats reading back.
- **Put the words back in the composer when Hermes refuses.** Rejected: the message would show twice, once in the chat and once in the composer, and Enter would send it again without the files. Edit takes the words back on purpose.

## Consequences

- A message whose turn ran more than 100 rows past it stays unknown until its chat is opened, because the refresh read doesn't reach back that far.
- On a server that doesn't send `row_id`, the baseline is missing. Then any owner's message with the same words in the history counts as arrival.
- Hermes may store a message sent with files with more text around the owner's words. For such a message, the owner's words appearing in the history row are enough.
- If a retry can't go out at all, an unknown message stays unknown. The first send may still have arrived.
- A new chat has no row on Hermes until its first message is stored, so the list read wouldn't have it. A chat holding a failed or unknown message, or a queued one, stays in the list anyway, across reconnects and restarts, until the message is retried or dismissed (#468). Retry there resumes the chat by its id, and Hermes makes the row for an id it minted that has none (`_resume_materialize_minted` at `bf0203a`).
