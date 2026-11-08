# The office is a 3D building with a floor per profile and a room per state

> **Accepted** (#105). Delivered in three stages, each its own issue under #105. Stage 1 (#281) is built: the building, its four rooms, characters, name tags, the card, the camera, the full view, the `building | list | off` setting and the List fallback, with every agent on one floor. Stage 2 (#282) is built too: walking between rooms, a floor per profile in the tower, live profiles from `session.active_list` every 15 seconds, and going home. Reopened, the office starts from the picture it last drew, so an agent whose entry was dismissed in the inbox meanwhile (opening the inbox closes the office) walks out then. Stage 3 (#283) is built: the Office quality setting, and name tags that show on hover or keyboard focus only.

The owner doesn't like how the agent office looks. The Desks view (ADR 0077) is a stack of cards, and the Scene (ADR 0083) puts small robots inside those same cards. Neither reads as an office the agents work in, and both sit in a narrow panel over the chat. The owner wants a 3D low-poly building seen from above, with the agents in it, and wants it to be a glanceable monitor that is also fun to watch. The owner asked twice for it to cost as little as possible: little CPU and GPU on this computer, and no new load on the server.

## Decisions

### What it shows

- **One building, nothing around it.** The office is a single low-poly building on a plain ground, drawn with three.js from simple shapes and colors made for this app. There is no city, no traffic and no imported art.
- **A floor per profile.** Each Hermes profile on the connection is one floor. The profile shown is the open floor, the one the camera looks into, with no roof. The other profiles are floors of a narrow tower beside the building, one closed floor each, with the profile's name, how many agents it has and a "!" that lights when something there needs the owner. Clicking a tower floor makes it the open floor. Looking at a floor doesn't switch the app's profile; Open chat on an agent's card does, as the inbox does. The owner chose the tower from the prototype.
- **A room per state.** Every floor has the same four rooms:

  | Room | States (`DeskState`) | What the agent does there |
  | --- | --- | --- |
  | **Workroom** | running; queued stands by the door | sits at a desk, typing |
  | **Waiting room** | approval, uncertain (may not have sent) | stands with a "!" bubble, hand up |
  | **Trouble room** | failed | slumped at a desk, red marker |
  | **Lounge** | completed (finished), unread, stopped, ended, idle (not running), unknown | sits on a couch |

  The mapping is one table in code, so a new `DeskState` needs a line and the type checker asks for it, as `POSE` does today.
- **A character per agent.** One for each chat's reply and one for each of its subagents, the same agents `officeRooms` (`src/hermes/office.ts`) lists today. A character is a low-poly person (#302): legs and shoes, a neck and a head with hair, hands, and eyes and a mouth that show only when the camera is close. Its shirt and sleeves are its team color; its skin tone, hair style, hair color and trousers come from a hash of its agent's key, so it looks the same on every launch and forty characters don't look like clones. Skin and trousers never match a team color. Each body part is one instanced mesh for every character. Finished agents sit back on the couch rather than lie on it: four share each couch.
- **A color per team.** Each chat gets a team color, worn by its reply and its subagents as their shirt and name-tag edge, so a team can be told apart once its agents are in different rooms. Team colors stay the same in light and dark; the building's walls, floor and light follow the theme.
- **A team keeps its desks.** In the Workroom a chat's team sits at one group of desks for as long as any of its agents works, so nobody changes seats when another team starts or stops.
- **Name tags show on hover, and a "!" shows without one.** A character's tag appears while the pointer is over it or it has keyboard focus: the agent's name and a state dot, with an edge in its team color. Every agent waiting for the owner (Approval, or may not have sent) has a "!" over its head at all times, so who needs the owner reads from across the building with no tags open. The state is in words for screen readers and in the card. What the agent is doing now is only on its card, so a tag doesn't change every few seconds. The owner chose this from the prototype.
- **Clicking a character opens its card.** The card shows its name, chat, profile, state, goal, what it is doing now, model, how long it has run, and **Open chat**, which goes where its desk goes today (ADR 0077). The card updates while it is open. Nothing is approved, answered, stopped, steered or sent from the office.
- **Characters walk between rooms.** When an agent's state moves it to another room, it walks there along the hallway in about one to two seconds. When the system asks for reduced motion, or the quality is Low, it appears in the new room instead.
- **Finished agents go home.** An agent in the Lounge leaves through the front door when its inbox entry is dismissed, by hand or by the inbox's own rules, or 30 minutes after it last changed state. It comes back if its chat has something new.
- **Too many on one floor.** Characters are drawn as instances, so dozens stay cheap. Above 40 characters on one floor, the rest aren't drawn and a sign at the door says "+N more" and opens List.

### How it is viewed

- **A full view.** The office's rail button opens it in place of the chat panes, with the rail still showing. Escape, or picking a chat, goes back. A separate window for a second screen is a later stage, not this one.
- **The camera turns around the building.** Drag turns it all the way round. The tilt stays between looking from the side and looking almost straight down, never from below the floor. The scroll wheel zooms between the whole building and one room filling the view. A button resets the view. Double-clicking a room zooms to it.
- **The office replaces Desks and Scene. List stays.** `agentOffice` becomes `building` (the default), `list` or `off`. A saved `desks` or `scene` reads as `building`. List is the accessible, low-power view, and the one the office falls back to when this computer has no WebGL. Both views draw the same agents with the same names and the same Open chat.

### What it costs

- **Drawn only when something changes.** The scene renders a frame only when a character moves, an agent's state changes, the camera moves or the window resizes. With no agent working and no one walking, it draws nothing. While something moves, it draws at most 30 frames a second.
- **Nothing is drawn while it can't be seen.** A closed, minimized, tray-hidden or unfocused office draws no frames. A closed office isn't mounted at all, as now.
- **Cheap to draw.** No live shadows (a soft shadow is painted under each character and piece of furniture), simple materials, instanced characters and furniture, and a device pixel ratio capped at 1.5 on Normal.
- **three.js loads with the office.** It is one pinned dependency, loaded only when the office first opens, so it costs nothing until then.
- **An Office quality setting.** Settings → Chats → Office has **Normal** (the default) and **Low**, and the office has the same switch, which applies at once (Settings takes the office's place, so a change there shows when the office opens again). Low draws at most 15 frames a second at a pixel ratio of 1, agents type at 3 frames a second instead of 6, and they appear in their new room instead of walking. Typing is most of what an open office costs, and on a screen at pixel ratio 1 the slower typing is all that makes Low cheaper while agents work. Off stays available.
- **Proof in the PR.** Each stage's PR measures the app's CPU with the office closed, open with nothing moving, and open with agents typing, on the owner's Arch machine and in the verify skill's headless app.

### What it reads

- **No new kind of request.** The office reads what the app already has: the Rail inbox's entries and the subagent trees of the chats this connection has resumed (ADR 0072). It keeps nothing of its own, beyond the go-home times and the team colors held in memory while it is open.
- **Other profiles live from one small check.** While the office is on screen, the app sends `session.active_list` every 15 seconds, the gap `LIVE_MIN_GAP_MS` already allows. It is one small message over the chat socket that is already open, and it says which chats are working or waiting in every profile. The heavier REST read of the other profiles' chat lists stays at `CHECK_EVERY_MS` (2 minutes); the office doesn't speed it up. Both stop when the office is hidden.
- **Other profiles show their replies only.** A chat in another profile has one character, its reply. Its subagents show once the owner switches to that profile and the chat is resumed, as today.
- **ADR 0077's rules still hold.** A reply's state is the inbox's, a subagent's is its tree's, Finished only on Hermes's word, and anything the app can't vouch for is "as last seen": greyed, frozen and labelled.

## Considered options

- **Top-down pixel art.** A flat 2D office is cheaper, but it doesn't look like the owner's reference, and turning the camera or walking between rooms looks flat.
- **A 3D look drawn once as a picture, with 2D characters on top.** Very cheap, but the camera can't turn or zoom.
- **CSS 3D transforms, no WebGL.** No dependency, but the most limited look, and many elements to lay out on every change.
- **A city around the building, as in the reference.** The owner asked for the building only. Other buildings could later stand for other servers (#99).
- **A room per chat.** That is the Desks view again. Rooms by state answer "who needs me" from across the room, and team colors keep each chat's agents together.
- **Other floors stacked on top of the open floor,** as closed slabs. The camera looks into the open floor from above, so slabs over it hide it or have to be cut away; a tower beside the building keeps the open floor clear.
- **Name tags always shown.** With a dozen or more characters on a floor the tags overlap and cover the rooms. The "!" is what has to show at a glance.
- **Name tags hidden only when zoomed out.** Close up they still crowd a busy room, and from far away the waiting agents lose their mark.
- **Activity on every name tag.** It changes every few seconds for every working agent, which is noise to read and a reason to redraw. It is on the card.
- **Polling other profiles' chat lists faster while the office is open,** as ADR 0077 did with the 30-second inbox check. `session.active_list` gives the same working and waiting states for one message instead of a page per profile.
- **Resuming other profiles' chats to see their subagents.** That is a resume per chat, kept up for as long as the office is open.
- **Shrinking a team into one character when zoomed out.** Worth adding if one team gets very large. Not needed for v1.

## Consequences

- ADR 0083 rejected a canvas with characters walking between desks because of a render loop and CPU. This ADR takes that on, with the budget above as the answer, and the stage PRs have to show the numbers.
- The settings value changes. `agentOffice` moves from `desks | list | scene | off` to `building | list | off`, with old values mapped.
- jsdom has no WebGL. Which room, seat, team color and floor each agent gets is a pure function next to `officeRooms`, tested in vitest. The three.js layer only draws that layout, and is checked in the real app with the verify skill.
- A computer without WebGL gets List, and says why.
- The first stage adds three.js, the app's first 3D dependency.
