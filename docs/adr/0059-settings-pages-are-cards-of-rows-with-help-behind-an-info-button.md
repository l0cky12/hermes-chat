# Settings pages are cards of rows, with longer help behind an (i) button

> **Partly superseded by [ADR 0160](0160-settings-is-a-sidebar-tree-of-pages-beside-one-page-with-a-header.md)** (#568). The tab strip, and its one-line narrow form, gave way to a sidebar tree and, in a narrow window, a bar that opens it as a sheet. A page's Server, Profile and File rows and its page-wide actions moved into the page header. The rest of this ADR stands.

Issue #174: every Settings page was a long run of paragraphs and controls. The settings were hard to find among the explanations, and sections, buttons and spacing differed from one page to the next. ADR 0113 (#195) kept the tab strip, added a sub-nav, and made no tab scroll at 1080p. It didn't change how a page reads. At the 760 px minimum width the tab strip also wrapped onto three lines, and General's sub-nav onto two more (#154). This record sets one layout for every page. General is the first page to use it; the other tabs follow in later pull requests.

## Decisions

- **A section is a heading and a card of rows.** The heading may have one line under it and an action at its end, such as Add connection or Check for updates. The card holds the section's rows, separated by thin lines. Sections are spaced apart, not ruled apart. `SettingsSection` in `src/ui/SettingRows.tsx` draws it, and it stays a `<section>`, the unit Settings' search shows or hides (ADR 0113, `settingsSearch.ts`).
- **A row is a setting's name and a one-line hint on the left, and its control on the right** (`SettingRow`). A control is a switch, buttons, a value or a badge. A narrow window puts the control under the text. Anything the control needs to say afterwards goes full-width under the row: a confirmation, a test result, an error.
- **Longer help folds behind an (i) button** beside the name or heading. It is a real button with `aria-expanded`. It sits outside the name and the heading, so it never joins a control's or a heading's accessible name. The help stays in the page, so search finds its words. While Settings is searched every fold is open (`SettingsSearching`), so a match is never hidden. When the search ends, each fold returns to how the owner left it.
- **Some text never folds:** warnings, errors, the state of something, and what a destructive action deletes. Examples: the tray isn't showing, the keyring couldn't save the extra headers, "Signing out deletes it", and the Clear local cache confirmation. ADR 0113 rejected (i) tips because they hid this kind of text. This layout folds only explanation.
- **A line that isn't a setting is a note across the card** (`SettingNote`), toned muted, warn or bad: the tray's state, "Connect to Hermes to see…", a storage-full alert.
- **The tab strip stays, and a narrow window draws it on one line.** Below 820 px of content width, the tab strip shows icons only, except for the tab shown, which keeps its label. Each tab keeps its name and a tip. General's sub-nav (`SubNav compact`) does the same. Memory's sub-nav doesn't, because its profiles share one icon. At 760 × 500 General's first section now starts 198 px down the window. Before, it started at 338 px, under five wrapped lines of tabs and groups.
- **A section is a landmark only when it's named on purpose** (`titleId`, as Connections already was). If every section were a named region, a screen reader's list of landmarks would be noise.

## Considered options

- **The tabs in a side list** (#174's suggestion). ADR 0113 kept the strip so the chat list stays beside Settings, and General and Memory already have a side column. A second column would leave the content about 400 px at 1080p, and nothing at the minimum width. The one-line narrow strip fixes the sideways problem without that cost.
- **"Learn more" links under each hint.** These add a line to every row that has help. The (i) keeps the row at two lines.
- **Native `<details>` for the help.** The summary has to come first in the element and the help right after it, which puts the toggle on a line of its own. A button and a panel let the toggle sit beside the name.
- **Search per row, not per section.** This would make more precise results, but it changes the search's unit and its tests. Sections are short enough now that a section's worth of results is easy to scan.

## Consequences

- General, Connections, Sending while Hermes replies (ADR 0057, follow-ups), On launch, Tray, Updates, Screenshots, Local cache, History, Import transcripts and Backup use the layout, and so does the Voice tab's set-up section (Dictation, Read aloud and Voice conversation), which moved out of General to its own tab (ADR 0115, speech providers). Their headings, control names and statuses are unchanged, so their tests and the search still find them. Hints were shortened; the text they lost is behind the (i).
- The other tabs moved together in one later PR (#174's stage 2), not one page per PR as first planned. With General merged as the agreed pattern, the remaining pages were mechanical, and one PR lets the old `.settings section` rule go in the same change. The mapping each page followed:
  - **Appearance:** each `appearance-row` becomes a `SettingRow`. The theme gallery and the preview become free-form content in a card (`set-block`).
  - **Model:** each model and auxiliary row becomes a `SettingRow` with its picker as the control. Apply, Discard and the part's state (not applied yet, a conflict) are the card's last line, so they stay beside what they apply. Voice's speech providers do the same with Save.
  - **Voice:** the speech providers become a row for each side, with its picker as the control. The picked provider's model, voice, language and key go in a `set-block` under its row.
  - **Toolsets:** each toolset becomes a row with its switch. The open chat's line becomes the hint. "How a change applies" becomes the section's (i).
  - **Persona:** the SOUL.md editor goes in a `set-block`. Its "when it takes effect" text becomes the section's (i).
  - **Memory and Skills:** each entry or skill becomes a row in a card. Editors open in a `set-block` under their row.
  - **Diagnostics:** server facts become rows of a name and a value. The features table goes in a `set-block`.
- Every Settings tab now uses `SettingsSection`. `.settings section`'s old rule (a top border and padding) stays, because Automations, Projects, Scheduled jobs and Usage reuse the `.settings` frame with plain sections. New Settings sections use `SettingsSection` and never write that markup by hand.
- Skills, Memory, Persona and Diagnostics are still offered as "Open <tab>" by Settings search, not searched in place (`ABOUT` in `Settings.tsx`, since #163), so their folded help is reached by opening the tab; it is in each section's search text for when they are.
