# Settings tabs keep their strip and gain a sub-nav, so no tab scrolls at 1080p

Issue #187: the Settings screen's eight tabs were right, but what sat under them scrolled. At 1920 × 1080 General was four screens tall, Memory three, Skills three, Model three. Memory → External memory listed every profile's provider in a row, so reaching one meant scrolling past the others. In Skills, a long description (code-review) pushed Edit and the switch under the text. The owner compared ten mockups, reviewed by a council of three models over two rounds, and chose the one that keeps today's tab strip and chat list.

## Decisions

- **The tab strip and the chat list stay as they are.** Settings still opens from the rail's foot, over the chat, with the chat list beside it. The content column widens from 760 px to 1180 px, which the sub-nav uses.
- **A long tab shows one group at a time beside a sub-nav.** General has four groups: Connection (saved connections, the connection in use, sign-out, diagnostics, setup); Launch, tray & updates; Voice & screenshots; Storage & data (local cache, history, import, backup). The sub-nav is a column of buttons with arrow-key movement; under 820 px of content width it becomes a row above the content. Every control keeps its section; only the walls between groups moved.
- **Search still sees every group.** With a word in the search box, General renders all its sections at once, as before, so Ctrl+F finds a setting whichever group it lives in. The sub-nav is not drawn while searching.
- **Memory is a list beside the detail.** The list holds Agent notes and User profile under Built-in, then one entry per profile under External memory. A memory file shows its entries; a profile shows its provider form, with the all-profiles table folded under "All profiles and their stores". Both parts stay mounted whichever is shown, so an unsaved edit in either is kept and, as before, picking another entry asks first through the same guard that switching tabs uses. The provider overview reports the profile names to the list once it has read them; until then the list names only the shown profile.
- **Skills rows are one line with the actions at the end.** Name and source, a one-line description, the category, then Edit and the switch, in fixed columns so nothing wraps under the text. The whole description shows in a tip while the mouse rests on the line (only for a pointer that can hover, as the owner asked); the description's own element still carries the full text for screen readers.
- **Explanations fold.** Toolsets' three scope paragraphs fold under "How a change applies"; Persona's "when it takes effect" paragraph folds too, and the SOUL.md editor grows to the height that frees. Diagnostics puts the server facts beside the features table when the content is at least 1000 px wide. Model's auxiliary rows take one line each.
- **Appearance is unchanged.**

## Considered options

- **The tabs in the chat list's place** (the owner's first idea, and the council's pick). A calm shell, but it hides the chat list while Settings is open and changes a layout the owner already knows. Kept as a possible follow-up; the sub-nav column works the same way inside it.
- **One page of dense rows with the explanations behind (i) tips.** The most compact General, but it hides text the owner wants readable (what signing out deletes, why Close to tray is off).
- **Folds for every section.** Fits by hiding; every toggle costs a click.
- **A profile dropdown inside External memory.** One more click than a list entry, and a second "profile" idea on a screen that already shows the app's profile.

## Consequences

- A new General section joins one of the four groups; a fifth group argues for itself in this record.
- Tests pick a General group or a Memory entry through the sub-nav (`navigation` named "General" or "Memory") before looking for its controls, or type in the search box to see every section.
- `MemorySettings` and `MemoryProviderSettings` accept the shown file or profile from outside and report the profiles; on their own they behave as before.
