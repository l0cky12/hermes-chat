# The rail has no Inbox button, and the tray opens the Rail inbox

Issue #276 asked for the Inbox icon to come off the rail. The icon was the only button that opened the Rail inbox (ADR 0019, 0116), so removing it left that screen without a way in unless another one stayed. The tray already had one: its menu's Open Inbox (ADR 0034) shows the window and opens the Rail inbox.

## Decisions

- **The rail loses its Inbox button.** The top of the rail is the "H" mark, New chat, Search, Bots (when this Hermes has Bot Mode) and Office (unless Settings turns it off). The spacing and alignment of the rest are unchanged.
- **The Rail inbox opens from the tray's Open Inbox.** Opening it there closes the Bots view and the Office, as the button did, so one of them shows at a time. The tray's count of entries that need the owner, and the dot on its icon, stay (ADR 0034).
- **The Rail inbox itself is unchanged.** Its entries, filters, dismissals, Clear done and the time after which finished entries dismiss themselves (ADR 0019, 0088) work as before. It still closes on a press outside it and on Escape (ADR 0116). Escape puts focus back where it was before the inbox opened.
- **The rail's count is gone.** The rail no longer shows how many entries need the owner. That number is in the tray menu. The chat list's Inbox section still counts the chats that need the owner in the profile shown, though not in the other profiles (ADR 0063).
- **Settings → Chats → Rail inbox says how it opens.** Its hint now names Open Inbox in the tray menu.

## Considered options

- **A keyboard shortcut or a Search entry as another way in.** Not asked for. The issue removes the icon and does not ask for a replacement, and a new shortcut would need a key that no other screen, the terminal or Hermes's own shortcuts use.
- **Keeping the button.** Rejected: the issue removes it.

## Gaps

- With no tray, nothing opens the Rail inbox. That is the case on GNOME without the AppIndicator extension, where Settings → General → Tray says the icon isn't showing (ADR 0034). The Office, unless Settings turns it off, still shows the same work in every profile, and the chat list's Inbox section shows it for the profile shown.
- The tray menu opens it only when no modal dialog is open (ADR 0034). The window comes forward and the owner finishes the dialog first.
