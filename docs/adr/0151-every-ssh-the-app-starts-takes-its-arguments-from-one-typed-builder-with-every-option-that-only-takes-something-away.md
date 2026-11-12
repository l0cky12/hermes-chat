# Every ssh the app starts takes its arguments from one typed builder, with every option that only takes something away

Issue #521: four places built ssh command lines (`tunnel.rs`, `server_page.rs`, `repo_git.rs`, `terminal.rs`), each with its own option list and its own copy of the target check. Only the server page's tunnel passed `PermitLocalCommand=no`, so the owner's `~/.ssh/config` could still have the sign-in tunnel, Repository Git or the Terminal run a `LocalCommand` on this computer. Repository Git and the Terminal turned off connection sharing only on Windows.

## Decisions

- **One builder** (`src-tauri/src/ssh_guard.rs`): `Target::parse` is the one target check (trimmed, not empty, no leading `-`, no whitespace), and `args(target, kind, connect_timeout)` returns the whole argument list. `--` and the target always come last, and only the remote command follows them. Callers pass no option strings of their own.
- **Kinds, not option lists.** A caller says what the ssh is for: `Terminal`, `Command { remote }` or `Forward { local, far_end, host_keys, on_failure }`. Where callers differ by design, the difference is a typed choice: `HostKeys::AcceptNew` for the sign-in, the first ssh to a server, and `OwnersConfig` elsewhere. `ForwardFailure::Exit` for the sign-in tunnel, and `KeepGoing` for a server page, whose owner's `LocalForward` may clash (ADR 0114).
- **Every ssh gets** `ControlMaster=no`, `ControlPath=none`, `PermitLocalCommand=no` and `ServerAliveInterval=15`, on every platform.
- **Every ssh in the background** (not the Terminal) also gets `BatchMode=yes`, `ServerAliveCountMax=3`, `ForwardAgent=no` and `ForwardX11=no`. Commands (Repository Git, the server's port listing) add `ClearAllForwardings=yes`.
- **A forward's local end is typed too.** `Local::Socket(path)` is `-N -T`, `StreamLocalBindMask=0177`, `StreamLocalBindUnlink=yes` and `-L <path>:<far_end>`, as on Linux (ADR 0098). `Local::Stdio` is `ClearAllForwardings=yes`, `StdinNull=no` and `-W <far_end>`, one ssh per connection that listens on nothing, as on Windows (ADR 0157, on Windows each tunnel connection is an ssh of its own). Both get the same options otherwise, which `ssh_guard.rs`'s tests check.
- **Tunnels alone get `ForkAfterAuthentication=no`.** OpenSSH before 8.7 refuses the option outright, which would break the Terminal and Repository Git on Windows 10's built-in ssh (8.1). A tunnel always needed 8.7. The page tunnel's port listing loses the option. It runs beside a page tunnel that still needs 8.7, and the option keeps ssh within the app's reach without taking anything away on the server.
- **The Terminal stays the owner's own ssh** (ADR 0022). It keeps prompts, the owner's host-key policy, and agent, X11 and port forwarding, but it no longer joins the owner's ControlMaster.

## Considered options

- **The strictest set for every caller, `BatchMode=yes` included.** The Terminal could no longer ask for a password, a passphrase or a new host key.
- **`ForkAfterAuthentication=no` everywhere.** It's the stricter set, but it costs the Terminal and Repository Git on OpenSSH 8.1–8.6.

## Consequences

- ADRs 0022, 0110 and 0114 list the options their ssh had when they were written. This record says what each gets now.
- An owner whose Terminal used a ControlMaster from their config is asked to sign in again in each Terminal, and Repository Git no longer rides on a shared connection. ADR 0110 already needed a key that works without a prompt.
- Repository Git no longer forwards the owner's agent. ADR 0110 already says it uses the server's own credentials, but a push to an ssh remote that relied on a forwarded agent now fails.
- A new ssh is a new `Kind`, or an existing one, and `ssh_guard.rs`'s tests check that every kind gets `PermitLocalCommand=no` and the rest of the shared set.
