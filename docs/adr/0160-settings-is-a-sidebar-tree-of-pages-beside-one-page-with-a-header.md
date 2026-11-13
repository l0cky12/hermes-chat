# Settings is a sidebar tree of pages beside one page with a header

Issue #568: the owner said Settings "looks all crowded". Sixteen tabs wrapped onto two rows above the content (ADR 0059, 0113). General, Memory, Gateways and Diagnostics added a second sub-nav column inside the tab. The chat list stayed open beside Settings, and a page ran up to 1180 px wide, with read-only rows (Server, File, Profile), page actions and "When changes take effect" sections mixed in with the settings. The owner asked for several designs, a council of four models (Claude Fable 5.2, GPT-6.1 Sol, GPT-6 Astra, Grok 4.7, all at high effort) to score them, and the work to go on until all four gave the chosen design 10/10. Four layouts were compared: a sidebar tree, a hub of tiles, three "spaces" (App / Profile / Server), and a sidebar with one scroll per page. All four reviewers picked the sidebar tree in round 1. Later rounds refined it.

## Decisions

- **Settings brings its own list in the chat list's column.** While Settings is open, the chat list is hidden but stays mounted, so its scroll position and open sections are kept for the way back. A 264 px sidebar takes its place. Back, the "Settings" title and the search box stay pinned at the top, and only the list of pages scrolls.
- **The pages are in three groups: App, Agent and Server.** App holds General, Appearance, Keyboard Shortcuts, Voice, Snapshots and Extensions. Agent holds the profile's setup on Hermes: Model, Providers, Toolsets, MCP servers, Gateways, Persona, Memory and Skills. Server holds Profiles and Diagnostics. "This computer" was rejected as a group name because Voice's speech providers live on Hermes. The group labels carry no profile name, since the pages that pick a profile say which one in their header.
- **The pages are still tabs.** The 16 page buttons form one vertical `tablist` (`aria-orientation="vertical"`) with the same ids and `tabpanel`, so arrow keys, screen readers and every test that finds a page by `role="tab"` work as before. The group labels are presentation only.
- **The open page's sections sit under it in the tree.** General (Connection; Chats; Launch, tray & updates; Screenshots; Storage & data), Memory (Agent notes, User profile, External memory), Gateways (Telegram, Discord) and Diagnostics (Server, Logs) show one section at a time, as ADR 0113's sub-nav did, and pick it here. On every other page with two or more headed sections, the headings are jump links instead. When a section is picked, its row is filled and the page above it is bold with no fill, so only one item is highlighted.
- **Jump links follow the scroll.** The section at the top of the view is the current jump link. A clicked jump link stays current until any scroll after the jump's own scroll has settled (a wheel, a key, a scrollbar drag). At the end of the scroll, the last section is current, so a short last section never goes unmarked.
- **One page, one header.** The page is one column up to 1024 px wide, 64 px to the right of the sidebar. Its header (`SettingsPage` in `src/ui/SettingsPage.tsx`) has these parts:
  - an eyebrow naming the page, when the title is one of its sections;
  - the title, with the profile slot on the same line;
  - a one-line description, up to 80 characters wide;
  - labelled chips for what the page read: Server, File (a long path is cut on slashes, as `~/.hermes/profiles/…/MEMORY.md`, in full on hover), and the time it was read;
  - the page's actions. They sit at the end of the chip line, or at the end of the description's line when there are no chips, or at the end of the title's line when there is no profile slot either;
  - one summary box.
- **Components fill the header through `HeadPart`.** A page's own component renders its picker, chips, actions and summary box into the header through a portal, so it keeps the state behind them. Outside the header (a component rendered alone in a test) a part renders in place. In search results the summary box renders in place as a `<section>`, so search can find it, and the other parts are left out.
- **The profile slot says which profile a page changes.** On Persona, Memory (including External memory), Skills, MCP servers and Gateways it reads "Editing profile [picker]", with a "not in use" badge while the picked profile isn't the one the app uses. Model, Providers, Toolsets and Voice change the profile in use and say so with a static "Profile in use: default" chip. External memory picks its profile in the header now, in place of ADR 0113's one sub-nav entry per profile.
- **"When changes take effect" is one summary box under the header.** One line is always visible ("Saved edits reach new chats. Chats already going keep the memory they started with."), with a chevron. Opening it shows the full rows, and any safety checks under their own sub-heading: Memory's "Entries Hermes leaves out", Model's Guardrails. Toolsets' box says whether the profile has its own list, and what the open chat has.
- **Re-reading from Hermes is always a labelled "Reload" in the header.** This replaces MCP's "Read again" row, Gateways' and Voice's "Read again", Toolsets' "Refresh", Profiles' icon-only refresh, and the Reloads in Memory's, Skills' and Persona's bodies. Skills' Select stays with the list it acts on. Diagnostics' "Check again" stays, because it reruns the feature checks rather than re-reading something.
- **Less loose text on the pages.**
  - A long intro shows its first sentence with an inline More: Snapshot host's key permissions, and Extensions' paragraph, which joins the page description.
  - The keys that can't be changed fold into the last line of each Keyboard Shortcuts card. Profiles' list keys fold the same way.
  - Gateways' Save row reads like Model's footer: the state on the left, Discard and Save on the right. Model's "changes wait here until you apply them" moved from the intro to that footer.
  - Cards of six or more rows are a little tighter.
  - Every select uses the app's select style.
- **A narrow window (900 px or less) has a bar in place of the sidebar.** The bar has one row: Back, then the page and section as a button that opens the same tree as a sheet, then a search icon. The sheet's own header (Settings and Close) is pinned. Ctrl+F opens the search icon's box too. Under the row, the page's sections (or jump links) are a scrolling row of chips. The page header leaves out the title (the bar names the page) and puts the profile slot and the actions on its first line. A connection's buttons sit on one line under its name.
- **Search keeps ADR 0047's unit.** Typing filters every page's rendered sections, and the content shows the matching sections grouped by page. Each group names its page, and pages that change the profile in use say so with the "Profile in use" chip. A section that commits with Apply or Save is shown whole, so a match on "Reasoning effort" still shows the model it belongs to and its Apply. In the tree, a page with no match is dimmed and the others show their match count. Folds that hold a match open.

## Supersedes

- **ADR 0113**, in part: the horizontal tab strip and the sub-nav column beside a tab's content. General's and Diagnostics' groups, Memory's list and Gateways' platforms are now picked in the sidebar's tree, and External memory picks its profile in the header. ADR 0113's "search still sees every group" and "Memory parts stay mounted" still hold.
- **ADR 0059**, in part: "the tab strip stays, and a narrow window draws it on one line" (the narrow bar replaces it), and the per-component "Server", "Profile" and "File" rows and section actions where a page header now holds them. Sections stay a heading and a card of rows, and help stays behind (i).

## Considered options

- **Hub** (a home page of tiles, each with a live status line). It had the calmest landing page. But it has no persistent navigation, so moving between unrelated pages went back through the home page, and each tile's status would need data from every page's API. Scores 6–7.
- **Three spaces** (an App / Profile / Server switch, with that space's pages beside the content). The lists were short, but the reader has to guess the space before finding a page, and the narrow layout went back to unlabeled icons. Scores 5–6.
- **Sidebar plus one scroll per page, opening on an Overview.** The section index works well on long pages, but Memory and General became very long scrolls with repeated controls, and the Overview duplicated the sidebar. Scores 7–8.
- **An Overview landing in the sidebar tree.** Declined: two reviewers found it unnecessary, and it would need live status from every page. Settings opens on General › Connection, the most-used page.
- **Readable names for Keyboard Shortcuts' context codes** (`composerFocus`). Declined as new catalogue copy rather than layout. It can be its own issue.

## Consequences

- Tests that picked a General group or a Memory entry through the sub-nav (`navigation` named "General" or "Memory") now pick it through the tree's section buttons (`group` named "General: sections"). Tests that looked for "Read again" or "Refresh" look for "Reload". Tests that expected the Server, File or Profile rows inside a page's card find the chips and picker in the page header instead.
- A new page goes into one of the three groups. A page that edits a profile on Hermes says which one in its header, with the picker or the "Profile in use" chip.
- `SubNav.tsx` is gone. `GatewaySettings` takes the platform from outside, and `MemorySettings`, `SkillSettings`, `McpSettings` and `GatewaySettings` take `shown` (the profile in use) to mark a picked profile that isn't it.
- The council's scores and the mockup gallery are in the pull request.
