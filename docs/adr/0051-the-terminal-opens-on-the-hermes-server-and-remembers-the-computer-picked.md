# The Terminal opens on the Hermes server and remembers the computer picked

The Terminal tab (ADR 0022, ADR 0039) has two shells: one on the Hermes server through the owner's own ssh, and one on this computer. Before this ADR, the tab showed the server's shell every time the app started, and the switch at the top said "Server". With a URL sign-in and no target typed yet, the server's shell showed a bare "SSH target" field. Its text described a shell, not the missing target. The owner wants the Terminal to open a shell on the Hermes server straight away (#170). They want a clear switch to this computer, the last choice kept, and a plain message when there's no SSH target.

## Decisions

- **The server's shell is the default.** Until the owner picks, the Terminal opens on the Hermes server. Its shell connects straight away to the SSH target the sign-in uses (or one typed for this connection, as before). This computer's shell isn't started until its side is picked.
- **The pick is kept as a display preference.** `terminalKind` (`"server"` or `"local"`) is a field of the UI prefs document (`uiPrefs.ts`, key `hermes-ui-prefs`), not a key of its own. That module asks later settings to add fields there. It is checked like the other fields: anything else reads as `"server"`. It applies to every saved connection, and a backup's Settings keep it.
- **Remembered "This computer" opens that shell first.** When the Terminal opens on this computer's side, the local shell starts and the server's waits until the owner switches. Switching starts a side's shell only the first time, as before. Neither shell is ended by a switch.
- **The switch reads "Hermes server" / "This computer".** Same two-button group (`Which computer`) as before, with the server's label naming Hermes.
- **No SSH target is said plainly.** When the server's side has no target, it says "No SSH target for the Hermes server." It explains that a web-address sign-in gives the app no way to reach the server over ssh, and that the target set here is kept for this connection. The field takes the keys, and the button reads "Set and connect". A second button, "Use this computer instead", switches to the local shell.

## Considered options

- **Keep the pick in React state only (as before).** Rejected: the issue asks for the last choice to be remembered across launches.
- **A localStorage key of its own, like `hermes-chat.terminal-target`.** Rejected: the target is per connection (`terminalTargetKey`), but which computer the owner works on is a display preference of this computer. The prefs document is where those live. It already validates, migrates and backs them up.
- **Per connection.** Rejected: the local shell is the same on every connection. Being on this computer last isn't something about one server.
- **Start both shells at once.** Rejected: a local shell nobody asked for, or an ssh that may ask for a passphrase out of sight, is surprising. Each still starts when its side is first shown.
- **Offer to edit the connection to add an SSH target.** Rejected for now: an SSH target on the connection would switch the sign-in to the SSH tunnel, a much bigger change. The Terminal's own target (ADR 0022) is enough to open a shell there, and the Repository screen reuses it (ADR 0110, `0110-repository-git-runs-a-fixed-helper-over-the-owners-ssh.md`).

## Consequences

- A launch after the owner last used This computer starts a local login shell when the Terminal is first opened, not ssh.
- Restoring a backup's Settings restores the pick, alongside the terminal target.
- An older build reading the document ignores `terminalKind` and opens on the server, as it did.
