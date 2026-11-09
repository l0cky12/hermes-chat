# A web-address sign-in gives the Terminal its host as the SSH target

A URL sign-in (ADR 0004) has no SSH target, so the Terminal's server side (ADR 0022, ADR 0051, `0051-the-terminal-opens-on-the-hermes-server-and-remembers-the-computer-picked.md`) asked the owner to type one before it would connect. The owner signs in at an address such as `http://hermes:9119` and reaches the same machine over ssh as `liam@hermes`. They want the Terminal to connect without being asked.

## Decisions

- **The host of the address is the target.** With no target typed for the connection, a URL sign-in's Terminal connects to the host of its web address: `http://hermes:9119` gives `hermes`, `https://hermes.tail36fb9.ts.net` gives that name, and `http://[fd7a::1]:9119` gives `fd7a::1`. The port, path and any user or password in the address are dropped.
- **No user is added.** ssh picks the user as it would for `ssh hermes` typed in any terminal: a `User` line for that host in `~/.ssh/config`, else the owner's user name on this computer. The app doesn't guess one.
- **Nothing on this computer.** A loopback host (`localhost`, `*.localhost`, `127.*`, `0.0.0.0`, `::`, `::1`, and IPv4-mapped forms of `127.*` and `0.0.0.0`, which `URL` writes in hex such as `::ffff:7f00:1`) gives no target. ssh there opens a shell on this computer, not the server; such a sign-in usually goes through a tunnel the owner made. The Terminal still says "No SSH target for the Hermes server" and offers a field for one, as before. A host that starts with `-` gives none either, and Rust refuses those anyway (`ssh_command`).
- **Typed targets still win.** A target typed for the connection's Terminal (`terminalTargetKey`) comes first, then an SSH sign-in's own, then the address's host. The worked-out target isn't saved, even by **Connect again** to it unchanged: it follows the address if the connection is edited. A target the owner changes in the field is saved, as before.
- **A failed guess is named.** When ssh to a worked-out target fails (exit 255, or ssh can't start), the Terminal says the target came from the sign-in address. It suggests `user@host` in the field, or a `Host` entry with a `User` line in `~/.ssh/config`. Typing another target hides that note.
- **The Repository uses it too.** `repoTarget` falls back to the same target, so the Repository screen (ADR 0110) opens without a target typed.

## Considered options

- **Pick a `Host` alias from `~/.ssh/config` whose `HostName` matches.** Rejected for now: it means running `ssh -G` for each alias. A plain host already goes through the same config: an alias named like the host matches it, and `Match`/wildcard entries apply.
- **Read `~/.ssh/known_hosts` or shell history for a past target.** Rejected: hashed known_hosts names can't be read back, and history is not the app's to read.
- **Ask the Hermes server for its ssh user.** Rejected: Hermes has no such endpoint, and the user on the server is often not the one the owner signs in with.
- **Probe with `ssh -o BatchMode=yes host true` before connecting.** Rejected: a key with a passphrase and no agent fails in batch mode, when the Terminal's own ssh could ask for it.

## Consequences

- A name that only this computer resolves to itself (such as its own host name in `/etc/hosts`) isn't recognised: the app doesn't resolve names. ssh there opens a shell on this computer, as typing that target would.
- A URL sign-in's Terminal starts ssh to the address's host as soon as it opens. If that isn't the server's ssh name, ssh prints why and the field holds the guess to fix.
- The Preview's server pages (ADR 0114) still need an SSH sign-in: Rust holds only the target it signed in with. Since ADR 0120, a connection with an SSH route gives the Terminal, the Repository and server pages that route's target, whichever route the chat connection uses.
