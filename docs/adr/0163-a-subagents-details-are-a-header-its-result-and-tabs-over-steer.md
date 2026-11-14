# A subagent's details are a header, its result, and tabs over Steer

The owner said the Subagents list (ADR 0072) looks fine, but the view that opens when a row is clicked should look better. That view was a column of everything the app knows: a back button, the goal, a grid of facts (state, started by, model, started, tool calls, id), its subagents, an activity list with a clock time on every line, the output tail, the Steer box with a hint, Stop, and a note about approvals. In the drawer's 45% of the window, Steer and Stop sat below the fold, and every line had the same weight.

The owner asked for research into how T3 Code, OpenAI Codex and Claude Code show one subagent, several designs, and a council of three models (Claude Opus 5.5, GPT-6.1 Sol, Grok 4.7, all at high effort) to score them until all three gave the chosen design 10/10. Six designs were mocked on the app's real rendered page and CSS: header and sections, tabs, a taller two-column drawer, a side-panel inspector, a small transcript, and rows that expand in the list. Round 1 put "Tabs" and "Header and sections" on top (7–8.5); the rest scored 4–6.5. Design 7 combines them, and later rounds refined it in the app itself.

## Decisions

- **It stays in the drawer, under its 45% cap.** A side panel or a taller drawer gave the details more room but crushed the chat at 1100×760, and the side panel already holds Preview, Terminal, Files and Screen.
- **A fixed header says what it is, whether it is alive, and how it went.** Back (Esc), the goal as the title (two lines; all of it on keyboard focus, and in its tooltip), a state pill, and one meta line: model, run time ("1m 35s so far", ticking each second; "ran 41s" once ended), tool calls, and who started it. A parent subagent is a link that opens it. Each part carries its separating dot, which is clipped when the part starts a line. A **Partial** chip sits beside the pill when the app heard of it part way through.
  - The pill: running is the accent with a still dot (an endless animation costs a core, #406); finished green; failed and timed out red; queued, stopped, ended and unknown neutral.
  - ‹ n / m › steps through the subagents beside it (Alt+←/→). It shows only when there are others.
  - (i) holds the id with a copy button, the clock time it started, and the note that a subagent never asks the owner for approval.
- **Below the header, one part scrolls.** It holds the result first, then the tabs (which stick to its top), then the tab's content. An ended subagent opens at its result; a running one opens at its newest line.
  - **The result** is Hermes's summary or error, headed "How it ended", "Why it failed" or "Where it stopped". A long one shows 3 lines (2 in a window under 820 px tall) with Show all.
  - **Tabs**: Activity, Output (only while it runs and the app can ask Hermes for it), and Subagents (only when it has some). They are a `tablist` with ←/→, Home and End. With Activity alone there is a plain heading instead.
  - **Activity** uses the chat's tool-line look: an icon per tool, the tool name, its preview, and the time since its start (+0:31), with the clock time on hover. One heard of only part way gets its start from when it ended and how long it ran. Only a preview the line cuts short is a button, and it opens in full with a click or Enter. While it runs, the newest line is highlighted and the list follows new lines unless the owner has scrolled up. When one the owner was following ends, the view goes to the top to show how it ended. Its end is the last line, in the state's color.
  - **Output** says how much it is ("The last 16 KB of its transcript, read 8:30:32 PM") and opens at its end, in the same scroll as everything else. Refresh, or R when not typing, reads it again.
  - **Subagents** reuses the list's own rows.
- **The foot is Steer and Stop.** Steer, Stop's question and the notes that replace them share one minimum height while it runs.
  - Steer is a box tagged "Steer" so it isn't mistaken for "Message Hermes". The accent shows only on focus. On focus, a line says only this subagent reads it, after its current tool call, and how Enter and Shift+Enter work. The box grows to four lines. A rejected steer keeps its text, and Esc in a box with text leaves the box rather than going back.
  - Stop is neutral until hovered or focused. Its question replaces the Steer row. It names the target by goal and id, and names the running subagents that stop with it. It starts on Cancel, and Esc cancels it and puts focus back on Stop.
  - Once it has ended, the foot says it can't be steered or stopped. A running one with no Hermes id, or one Hermes hasn't described, says why instead.
- **While the details are open, the drawer never shrinks**, up to its cap. It opens fitted to what it shows; switching tabs or stepping to a shorter subagent keeps the height, so nothing moves under the pointer. Going back to the list resets it. A fixed 45% height was tried and left half the drawer blank under a short log.

## Considered options

- **Header and sections** (one long scroll): clear, but at 1100×760 the output and later activity sat below the fold.
- **Tabs alone**: the best fit, but it dropped the outcome-first emphasis and the sibling arrows, which design 7 takes from the header design.
- **Taller drawer with two columns** (70% of the window): covered the chat and left empty columns for an ended subagent.
- **Side-panel inspector**: roomy at 1920, but it crushed the chat at 1100 and took over the side panel.
- **Transcript** (the goal as a chat bubble, tool lines, output as a reply): the goal read as the owner's own message, and the identity scrolled away.
- **Expand in the list**: changed the list the owner likes, and the controls scrolled with the row.
- **A pinned live tail above the activity**: at 1100×760 it left two activity lines.

## Consequences

- `tools/shots/shoot.mjs` has `subagents-list` and `subagent-details*` scenes. A fake Hermes sends a tree of five subagents (running, finished, failed, and a stopped partial one under another), with the clock set back so the times read as 95 seconds of work.
- The record and the events are unchanged (ADR 0072). The view shows only what Hermes sends: no tokens, no cost, no per-tool duration.
