# The office is a flat floor plan, with a Design menu, and profiles as a filter

> **Accepted** (#569). The owner picked it from the screenshots, keeping the 3D building as one of its designs. It supersedes, in ADR 0122, the tower (a floor per profile) as the way to tell profiles apart, the building as the default, the people and furniture as the default look, and the `building | list | off` setting; in ADR 0077, the one setting with three values. ADR 0122's rooms by state, its card, its rule that nothing is done from the office, and everything it reads stay. So do ADR 0077's rules on state: the inbox's word for a reply, the tree's for a subagent, Finished only on Hermes's word, and "as last seen" for what the app can't vouch for.

The owner finds the 3D building cartoonish: little people with faces and hair, brown desks and blue couches, in an app that is otherwise hairlines, greys and one copper accent. And the profiles stack: each is a floor of a tower beside the building, so the owner's forty profiles make a wall of slabs and label columns over the floor being looked at. The owner asked for a menu to see different designs. A council of four models (Claude Fable 5.2, GPT-6.1 Sol, GPT-6 Astra, Grok 4.7) proposed the designs below and reviewed them in the real app.

## Decisions

- **A profile is a filter, not a place.** The office header has a **Profile** menu: All profiles (the default), then the profiles with agents, then the rest under "Quiet · N", each group in name order. Each row has its count of agents and, in the warn color, how many need the owner or failed. Past six profiles it has a filter box, and Enter picks the first row shown. It is one control high at 1 profile or 100. Picking one shows only its agents, and doesn't switch the app's profile; Open chat on an agent's card does, as before. While one profile is shown, a link such as "3 need you, 1 failed elsewhere" (chats in the profiles not shown) goes back to All. No design draws a profile as an object. The 3D building draws every profile as before, so the filter applies to the flat designs and List only.
- **A Design menu** replaces Building | List in the header. Each choice has a name, a line on what it is, and a small sketch of it:
  - **Floor plan**, the default. An architect's plan in the app's own lines and greys: one outer wall, rooms parted by 1 px walls, and doors drawn as plans draw them, a leaf and its swing. Needs you and Trouble are two small rooms side by side at the top, opening onto the open-plan Working floor; At rest runs across the foot. Where the plan has under 560 px, the rooms stack in that order. A room's name and count turn warn or bad while someone is in it. In a room, each chat's agents sit at one pod under the chat's title, each subagent stepped in under the agent that started it; a chat with only its reply there is one desk, named for the chat, with its profile beside the name. Each agent is a workstation: a screen outline in its state's color (filled only when it needs the owner or failed), its name, its state in words with its icon, and how long ago it was last heard from, which a desk drops only when it doesn't fit beside the state's words. Nothing about an agent is behind a hover.
  - **Board.** A lane per chat and a column per room. Lanes with someone who needs the owner or failed come first, marked on their left edge, then lanes at work, then lanes at rest. A chat's title takes up to two lines. An agent is a chip with its state's icon and a short state ("Approval", "Running"; the column names the room, and the full words are in its accessible name and card); a subagent's chip has its name above, and a reply's chip has the time. Where the board has under 830 px, the columns fold and each lane lists its chips. Its column header stays at the top while it scrolls.
  - **List**, as before.
  - **3D building**, as ADR 0122 built it, tower and all. It stays: the owner keeps it as a design to pick, not a step on the way out.
- **Rooms are the building's.** The plan and the board use `ROOM_OF` (`officeFloor.ts`): Needs you is the Waiting room, Working the Workroom, Trouble the Trouble room, At rest the Lounge.
- **Color means state, and only state.** Accent at work, warn when it needs the owner, bad on a failure, ok when Hermes said it finished, muted for the rest (an unread reply too), from the theme's tokens. Secondary text is muted, which reads at 4.5:1 or more in both themes. There are no team colors in the flat designs: a chat's agents are kept together by its pod or lane. Each of the twelve states also has its own icon and its own words, so none is told apart by color alone.
- **Profiles are named only where it helps.** Each desk, lane and List group names its profile while the agents shown span more than one profile, and none does when they are all in one.
- **Every agent shows.** No cap at 40 and no "+N more": a room or the board scrolls.
- **The card stays.** Clicking an agent opens its card (ADR 0122), its top edge in the state's color. Where the office is 900 px or wider it docks beside the design, which reflows, so it covers nothing; narrower, it floats over it. Either way it is never taller than the office and scrolls inside. The design measures the width left to it beside the card, so the plan and board fold the same with a card open. Escape closes it, back on the agent, before Escape leaves the office. Switching designs closes it.
- **The setting.** `agentOffice` is `plan | board | list | building | off`, default `plan`. A saved `building` reads as `plan` once (preferences version 4), so the owner sees the new look; picking the building after that keeps it. Office quality applies to the 3D building only.

## What it costs

The floor plan and the board are DOM. They render when the office's data changes and never on a timer, and nothing in them moves: a running agent's icon is still, as in List. three.js loads only if the 3D building is picked.

## Considered options

- **The building in quieter materials** (grey capsules, no faces). Still a diorama, and still needs somewhere to put forty floors.
- **An isometric drawing.** The same stacking problem, and text at an angle.
- **Profiles as a side list or tabs.** Forty rows or tabs is the tower again, in the DOM.
- **Board as the default** (Fable). It answers "who needs me" fastest, but three of four council members kept the office's sense of place as the default.
- **Two designs only, Floor plan and List** (Sol, Astra). The owner asked for a menu of designs to choose from; the Board is a different enough view to earn its place.
- **Team colors on the shirts or edges.** With color reserved for state, a second meaning made both harder to read.
- **Door gaps with no door.** In the first shots a bare gap read as a broken line. A leaf and its swing read as a door.
- **A spinning icon on every running agent.** Fourteen spinners is the motion the redesign set out to remove.

## Consequences

- The tower, its label packing (#459) and the building's 40-character cap stay, and now apply to the 3D building only.
- three.js and the building's code stay in the app, loaded only when the 3D building is picked.
- The flat designs are tested in vitest like the list, which jsdom can draw.
