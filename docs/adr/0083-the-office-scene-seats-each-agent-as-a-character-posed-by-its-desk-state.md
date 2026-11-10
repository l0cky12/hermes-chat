# The office scene seats each agent as a character, posed by its desk's state

> **Partly superseded by [ADR 0122](0122-the-office-is-a-3d-building-with-a-floor-per-profile-and-a-room-per-state.md)** (#281). The Scene view, its robots and its shared room are gone; the building draws each agent as a low-poly person in a room for its state. Its rules that carry over: an agent's pose follows its state, a team sits together, only a current agent at work moves, nothing moves for reduced motion, and the building and List give each agent the same accessible name and the same open.

Issue #257, a later stage of #105. The owner wants the agent office drawn as one room where each agent (a chat's reply and each subagent) is a character at a desk, so the picture reads as "these are my agents and this is what each one is doing". ADR 0077 built the office's rooms and its Desks and List views, and left characters for a later stage. This is that stage.

## Decisions

- **A third view of the same rooms.** The scene draws the `Room[]` that `officeRooms` (`src/hermes/office.ts`) already makes. Nothing new is read from Hermes or kept. Each character is a button with the same accessible name (`deskLabel`) and the same open as its desk in the Desks and List views. The office's arrow keys, Home, End, Enter and Escape, and its focus recovery when a desk goes, act on all three views, because they act on whatever desks are drawn.
- **One shared room.** The scene is one floor. Each chat's team sits together on its own rug, titled with the chat, in the inbox's order. In a team the reply sits first, then its subagents depth first, each right after the one that started it. A nested subagent says "for" the subagent that started it, as on its desk. So a chat's team is grouped and the reading order is the Desks view's.
- **The desk's state picks the pose, from one table.** `POSE` maps every `DeskState` to one of five poses:

  | Pose | States | Drawn as |
  | --- | --- | --- |
  | typing | running | hands on the laptop, head down |
  | hand-up | approval, may not have sent | one hand raised, facing the owner |
  | done | finished (Hermes's word only, as in ADR 0077) | leaning back, hands behind its head, smiling |
  | slumped | failed | head down on the desk, crossed-out eyes |
  | idle | queued, stopped, ended, not running, not known yet, new and not read yet | sitting back, arms down |

  The state's tint from the theme lights the character's eyes, antenna and laptop, and a badge shows the state's icon from the Desks view. The state is in words under each character too, so nothing depends on the drawing or on color. "New, not read yet" stays idle, never done, since it doesn't confirm the reply finished.
- **As last seen never looks current.** A stale desk's character is greyed and faded, its seat dashed, and its state says "as last seen", as ADR 0077 requires of a desk.
- **Only a running, current character moves.** Its hands type. A character moves only when its desk is running, is not stale, and the system doesn't ask for reduced motion (`prefers-reduced-motion`, read in JS, and in CSS as a backstop). The scene marks such a character with `data-moving`, which the CSS animates and the tests read. A closed, minimized or tray-hidden office isn't drawn at all (ADR 0077).
- **Original, light art.** Each character is a small robot in inline SVG, about 20 shapes, drawn here: a rounded head with a visor and an antenna, a body, a chair, a laptop seen from behind, and a desk. The reply's body takes the accent color, so it reads as its team's lead; a subagent's is muted. The robot's head, visor and laptop keep their own colors in either theme; the floor, rugs, desks and tints follow the theme, light and dark. No images, sprites, canvas or new dependencies.
- **One more value for the setting.** `agentOffice` takes `desks` (still the default), `list`, `scene` or `off`. The office's view switch and Settings → Chats → Office write it.

## Considered options

- **People instead of robots.** A person's skin tone and features are choices the owner didn't ask for, and they are harder to keep readable in both themes. A robot reads as an agent, and keeps one look for every agent.
- **A canvas or sprite sheet with characters walking between desks.** A render loop, art assets and a separate accessibility layer, for motion the issue asks to limit. Rejected, as in ADR 0077.
- **Each chat as its own walled room.** That is the Desks view again with characters. One floor with a rug per team reads as one office, which the issue asks for, and still groups each team.
- **A pose per state (eleven drawings).** Most states differ only in what the owner can do about them; five poses carry that, and the words and badge say the exact state.

## Consequences

- The scene adds one table and one small drawing to `src/ui/Office.tsx`. A new desk state needs a line in `POSE`; the type checker asks for it.
- Checked in tests with the real transport and a fake Hermes: a chat's two subagents seated after its reply and all typing, one stopped, an Approval, a finished and a failed subagent, and a drop to "as last seen"; the scene agreeing with the other views on every name and open; keyboard use and focus recovery in all three views; and reduced motion (`src/ui/office.test.tsx`). Live in the real app through the verify skill's stand-in, which starts two subagents when a prompt asks it to delegate (PR body).
