# An Approval is answered in the inbox with the chat's own card, and a notification opens it or denies it

> **Accepted.** It changes ADR 0019's "The inbox never answers an Approval" for a waiting Approval in the profile shown. Everything else ADR 0019 says about the inbox stands.

The owner accepted an idea from the improvement report: make a waiting Approval actionable from the tray inbox and from the desktop notification, through the chat's own answer path, with the same confirmation as in the chat and never an approval nobody saw. Until now the Rail inbox (ADR 0019, opened from the tray's Open Inbox, ADR 0097) listed an Approval and only opened its chat, and a notification only brought the window forward.

The rule for every surface: an answer that approves counts only where the owner can see what runs, the command and its description as the chat's card shows them, with the card's guards (#489's hidden characters and blank-line runs written out, a deliberate click, a broader grant confirmed first). A surface that can't show that offers no way to approve.

## Decisions

- **The Rail inbox shows the chat's card under a waiting Approval's entry.** It is the same `ApprovalCard` the chat shows, fed the same item, so it shows the same command, the same answers Hermes offers, and asks again before Allow for this chat or Always allow. Its answer goes through `Hermes.answerApproval`, as the chat's does, so Hermes gets the same `approval.respond`, the card in the chat shows it answered, and a failed answer puts the card back with the chat saying why. Only entries whose card this connection holds show it: an Approval in the profile shown, on the composer target. An entry for a chat waiting in another profile, or on another live connection, holds no card (the inbox only knows that it waits, ADR 0019), so it still only opens. While Hermes can't be reached, the card's buttons do nothing, as in the chat. The card takes no focus when it shows, so the inbox still opens with focus on its first entry; answering moves focus to the entry that takes the answered one's place. The card ignores clicks for its arming time after the list last changed, so a click aimed at a row that moved doesn't answer.
- **The tray menu itself offers no answer.** A menu item can't show a command safely: its text goes to the tray host (ADR 0034 sends only a count, never chat text), it is cut short, and it can't write out hidden characters. Open Inbox already opens the inbox, which now answers.
- **A notification about a waiting card opens that card.** Clicking an Approval's or a question's notification brings the window forward, as before, and then opens the chat in its profile with focus on the card, the way its inbox entry does. A notification from a background connection makes that connection the target and opens the chat, as its inbox entry does. The notification's text is unchanged: it still never quotes the command (`NOTICES`), so it can't be where an approval happens.
- **An Approval's notification also offers Deny.** Deny gives Hermes no permission, and the chat's card denies with one click too, so the notification can offer it without showing the command. It is answered through `Hermes.answerApproval(…, "deny")`, so a card already answered or no longer waited on is left alone. Deny comes with a Review button that opens the card, so a notification service that draws actions as buttons never shows Deny as the only answer. No action approves.
- **How the click gets back.** The webview tags a notification about a card (`desktopNotify` in `tauriNotify.ts`) and keeps what each tag opens or denies, for the newest 64, as Rust keeps clicks (`notify.rs`, `CLICKABLE_KEPT`). On Linux the notification goes with the actions `default`, and for an Approval `review` and `deny`; `ActionInvoked` on `default` or `review` brings the window forward with the service's activation token and sends `notification-action` `{ tag, action: "open" }`; on `deny` it sends `{ tag, action: "deny" }` and leaves the window where it is. A notification service without actions shows only the notification, whose click still opens the card. On Windows a toast's click opens the card; toasts get no Deny button.

## Considered options

- **Approve from the notification.** Rejected: the notification never shows the command, and a notification server cuts the body short and doesn't write out hidden characters.
- **Approve once in the inbox without the card, beside the entry's summary.** Rejected: the entry's summary never quotes the command (ADR 0019), so the owner would approve what they can't see.
- **A second, inbox-only answer path.** Rejected: two paths can drift apart on which answers Hermes offers, the confirmation of broader grants and what a failed answer does.
- **Deny on Windows toasts.** Not done: it needs the toast's action arguments read back from `ToastActivatedEventArgs`, which this build box can't compile or run. A toast's click opens the card, where Deny is.

## Consequences

- The inbox shows commands for the profile shown. They are the same text the chat shows, in the same window.
- A question (Clarify, a sudo password, a Secret) is still answered only in the chat; its notification and inbox entry open its card.
- A notification clicked after the webview reloaded has no tag to match. It only brings the window forward.
- On a desktop whose notification service lacks actions, a waiting Approval is denied or approved only in the window.
