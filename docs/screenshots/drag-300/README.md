# Dragging a chat onto a tab strip or pane edge (#300)

Real-app screenshots for ADR 0094. Every drag is real OS pointer input, not synthetic events.

- `linux-*`: the fixed build on Arch, under Xvfb and openbox, driven by the verify-hermes-chat skill with xdotool. The file comes from Thunar. Thunar's list of this machine's drives is painted over.
- `windows-before-*` and `windows-after-*`: a GitHub `windows-latest` runner, with mouse input through `mouse_event` and msedgedriver attached to the app's WebView2. Both builds include PR #309, because without it opening a chat blanks the window on Windows (#308). The file comes from a small WinForms drag source.

| Platform | Build | Row onto tab strip | Row onto right edge | File onto pane |
| --- | --- | --- | --- | --- |
| Windows | main + #309 | nothing opens; the page gets `dragstart` and `dragend` only | no split | attaches (native handler) |
| Windows | this branch + #309 | opens as a tab | splits | attaches (HTML5 drop) |
| Linux | this branch | opens as a tab | splits | attaches once (native handler) |
