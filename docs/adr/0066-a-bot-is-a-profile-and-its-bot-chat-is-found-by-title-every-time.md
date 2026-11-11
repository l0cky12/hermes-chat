# A bot is a profile, and its Bot Chat is found by title every time

Issue #222 asked for Hermes's Bot Mode, as the official Hermes desktop app has it. Hermes `f0d94882` was read and probed live (research doc, "Bot Mode"). There, each bot is a Hermes profile with a lasting identity: a name, a picture and a description. Each bot has one Bot Chat, the profile's session titled exactly "Bot Chat". Hermes's state database keeps titles unique within a profile, so that title names at most one session. Hermes's own `apps/desktop/src/AGENTS.md` calls one rule settled: the Bot Chat's only identity is its title. The rule came after five rounds of fixes to a stored session id that dangled, or was taken by another session, and lost users' history each time.

## Decisions

- **A Bots view, from the rail** (`src/ui/Bots.tsx`). It opens beside the chat list, like the Inbox. It has one row per profile, in Hermes's order with pinned bots first. Bots the owner hid in Hermes wait behind a "Hidden in Hermes" disclosure. Each row shows:
  - the bot's picture (`profiles.get_asset`), or its initial on its Bot Mode colour;
  - its name, from its Bot Mode title, then its display name, then "Hermes" for the default profile, then the profile name (Hermes's `displayName`);
  - its description;
  - its Bot Chat's last message, as `profiles.list` reports it in `canonical_session`;
  - **Replying** or **Needs you** when its Bot Chat has a reply running or an Approval waiting, else how long ago it was last active.

  The app reads `profiles.list` and the bots' pictures once after each connection. The view shows the roster and pictures last read at once, then reads `profiles.list` again in the background when it opens and every 15 seconds while it is open. It also asks for the inbox's check of live sessions, as the Inbox does.
- **A row opens its Bot Chat, found by title every time** (`src/hermes/bots.ts` `BotChats`). The rules are Hermes's own:
  1. Every open asks `session.list {profile, title: "Bot Chat", include_hidden: true}`. The row that comes back opens, at its compression lineage's tip.
  2. Only when there is none is one created: `session.create {title: "Bot Chat", hidden: true, follow_profile_config: true}`, then `session.title` on the new session. The title stores the session at once, so the next lookup finds it.
  3. If Hermes says the title is already in use (4022), another client made the chat in the meantime. That chat opens, and the session started here stays empty, for Hermes to prune.
  4. Fail closed: a lookup that fails creates nothing and says to try again. So does an empty lookup when the last roster said the bot had a Bot Chat.
  5. A second click while a creation runs joins it.

  No session id is kept as the bot's chat: not in memory between opens, not on disk, and not as the chat to reopen at the next launch. Recency never picks the chat. A bot in another profile switches the profile first, as the switcher does, and asks first if leaving that profile would leave a reply or Approval behind.
- **No intro is sent.** Hermes's desktop greets a bot with "Hey, tell me about yourself!" only when its New Agent flow creates the bot. Its comments say why a click must not: an intro on every re-created chat used a model turn each time and put a message in the owner's name into the chat. This app doesn't create bots, so the owner speaks first. The issue described the intro on every creation. This follows Hermes's code instead.
- **A Bot Chat stays out of the chat list and search.** Hermes's list already leaves hidden sessions out, except in the archived view. Its search doesn't. So the app leaves out these sessions itself:
  - any listed row titled "Bot Chat", which also covers one created visible by an older client;
  - any search hit with that title, or whose id or lineage root the roster named.

  A Bot Chat this app opens is in the chats it holds, for its pane, but is marked `bot` and never listed. Its bot's row is the way back to it.
- **Bot mode: the chat list panel shows the bots while a Bot Chat is open** (#445; `bots` on `ChatList`, `BotList` in `src/ui/Bots.tsx`). The panel keeps its profile switcher, New chat and Search at the top. Below them, a "Bots" heading sits over the Bots view's own rows, with the open bot marked as current. They replace the project switcher, the chat sections and the Settled drawer. A row there opens its bot's Bot Chat as the view's rows do, and asks first in the same cases. The panel stays in bot mode until that chat opens. While shown, it reads the roster again every 15 seconds and asks for the live check, as the view does.

  Bot mode isn't stored. It follows the chat in the active pane. So New chat or Ctrl+N leaves it, and so does any ordinary chat opened from search, the Inbox, the tray or a tab. Issue #445 left two questions open:
  - The profile switcher and Search stay. The switcher is the panel's header (ADR 0001), and New chat beside Search is the way back to the chats.
  - Bot mode doesn't survive a restart. A launch never reopens a Bot Chat, so the panel starts on the chat list.
- **"New chat with this bot"** is the pen on each row. It switches to the bot's profile and opens the New chat pane, and the chat it starts is an ordinary chat in that profile's list.
- **`/new` in a Bot Chat compacts it** (Hermes's `/new` → `/compact` guard). A Bot Chat is one continuous conversation. So `/new` there asks Hermes to compact it, and says so.
- **Bot Mode is a capability** (`botMode` in `src/hermes/capabilities.ts`, docs/compatibility.md "Bot Mode"). It is checked with `profiles.list`, and only an answer whose rows report `canonical_session` counts. A Hermes without the method, or whose rows don't report Bot Chats, shows no Bots button, and Connection diagnostics says why. If the view finds out on opening, it says so and the button goes once the view closes.

## Considered options

- **A Bots section in the side panel.** Rejected. The side panel holds tools for the chat on screen (Preview, Terminal, Files, Screen). Bots span profiles, as the Inbox does, and they open chats.
- **Editing a bot's name, picture and description.** Not built now. The routes exist: `profiles.configure` (with a compare-and-swap on `ui_meta`) and `profiles.set_asset`, both probed. But a Bot Mode title lives in `ui_meta['hermes-bots']`, beside presentation state that Hermes's desktop owns (sections, groups, pins). Writing there safely needs that compare-and-swap round trip, and it's a feature of its own. It can come later.
- **Hermes's hide sweep**, which re-hides rows titled "Bot Chat" that were created visible, with `session.set_hidden`. Rejected: it writes to sessions the owner didn't touch. Leaving such rows out of this app's list is enough here.
- **Remembering the Bot Chat's id to open it faster.** Rejected for the reason Hermes gives: an id can dangle or point at another session, and a title can't.

## Consequences

- Clicking a bot costs one `session.list` before the chat opens. That is the price of having no stored id.
- A session the owner made and titled "Bot Chat" by hand is that profile's Bot Chat, in Hermes and here.
- A Bot Chat reached from the Inbox is marked as one too, and stays out of the list.
- Bots talking to each other (`message_agent`, `bot_relay`) runs inside Hermes. It needs nothing from this app, and its messages show up in the bots' Bot Chats like any other turn.
