# The office's characters as people (#302)

Each image is the same view before (left, `main` at a68f173) and after (right, this change), taken in the real app with the verify skill (`.claude/skills/verify-hermes-chat`), headless, against the stand-in dashboard. The camera starts at **Reset view** and zooms toward one character with the scroll wheel, as the owner would. The CPU measurements are in [cpu.md](cpu.md).

The floor has every pose at once: a chat whose reply delegated to two subagents and queued a third (`delegate the audit and queue the summary`), an Approval (`needs approval to run`), a failure (`fail this one`) and the `work` profile's two Unread chats (`HV_INBOX=1`).

1. `*-0-building.png`: the whole building at **Reset view**.
2. `*-1-near-everyone.png`: halfway in. The Workroom team types, the queued subagent stands at the door, and the Approval waits with its hand up.
3. `*-2-typing-and-door.png`: close up on the queued subagent at the Workroom door, with its team typing behind it. Faces show from this distance.
4. `*-3-hand-up.png`: the Approval in the Waiting room, one hand raised, under its "!".
5. `*-4-slumped.png`: the failure, slumped over its Trouble room desk under the red marker.
6. `*-5-couch.png`: the two Unread chats sitting back on a Lounge couch.

Each comes in `dark-` and `light-`. The building's colors follow the theme; team colors, skin, hair and trousers don't.

The legs of an agent at a desk stay hidden inside the desk, which is drawn as one solid box, like a desk with a front panel.

`desktop-gpu-three-typing.png` is the new build on the owner's Hyprland desktop, drawn on its AMD Radeon RX 6400, during the CPU run there: the delegating chat's three agents typing (dark).
