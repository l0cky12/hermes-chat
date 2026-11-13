# The side panel opens on a launcher until a tab is picked

The chat header's side panel button opened the panel at the last tab, which was the Preview until the owner picked another. Opening the panel to reach the Terminal, Files or the Screen meant first landing on an empty Preview, then finding the tab (#574).

## Decisions

- **The panel starts on a launcher, "Open a surface".** It lists the four tabs (ADR 0039) as rows: icon, name, and the key that opens it, P, T, F or S. A click, the key, or Up/Down then Enter picks one. The first row takes focus when the launcher shows.
- **No tab strip until a tab is opened.** Before then the launcher alone offers the tabs, so the panel's top bar holds only + and Close (and Back, over the chat). Once a tab has been opened the strip shows all four, and stays, since an opened tab is kept.
- **The panel remembers the launcher as it remembers a tab.** The header button opens the panel on what it showed last: the launcher until a tab is picked, then that tab. A **+** button beside the tab strip shows the launcher again.
- **Anything that opens a particular tab skips the launcher.** A link, a tool call or a file opened from the chat opens its tab, as before.
- **The keys work only while the launcher shows**, and not with Ctrl, Alt or Meta held, so the app's own shortcuts (Alt+Up and Alt+Down among them) still work. No text field or terminal is on screen then, so a letter never reaches one. On a non-Latin layout a letter's key works by its place on the keyboard.
- **The launcher makes no tab.** A tab is still made the first time it is picked and kept from then on, so going back to the launcher leaves a shell or the screen running.

## Considered options

- **Always opening on the launcher.** Rejected: the owner who works in one tab would pick it again at every open.
- **Global shortcuts for each tab.** Not built. Single letters can't be global, and the panel's tabs are a click away in the strip.

## Consequences

- Opening the empty Preview from the header is one step further the first time: the button, then Preview (or P).
