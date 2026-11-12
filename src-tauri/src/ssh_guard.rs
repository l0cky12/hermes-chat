//! The arguments of every `ssh` this app starts: the sign-in tunnel, a server page's tunnel and the listing of the
//! server's ports, Repository Git, and the Terminal. Each gets every option that only takes something away from ssh,
//! and differs from the others only where its job needs it, as `Kind` names.
//!
//! ssh keeps the first value it reads for an option, and reads the command line before the owner's ~/.ssh/config, so
//! none of these can be undone there.

use std::ffi::OsString;
use std::time::Duration;

/// An SSH target ssh reads as one host: trimmed, not empty, no leading '-' (ssh would read it as an option), and no
/// whitespace (it would be more than a target).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Target<'a>(&'a str);

impl<'a> Target<'a> {
    pub fn parse(raw: &'a str) -> Option<Self> {
        let target = raw.trim();
        (!target.is_empty() && !target.starts_with('-') && !target.contains(char::is_whitespace)).then_some(Target(target))
    }

    pub fn as_str(self) -> &'a str {
        self.0
    }
}

/// What an ssh is for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind<'a> {
    /// The owner's own shell in a terminal (ADR 0022). ssh can ask for a password, a passphrase or an unknown host key,
    /// and the owner answers. Host keys and agent, X11 and port forwarding are the owner's config's, as from any terminal.
    Terminal,
    /// `remote` run in the background (ADR 0110), forwarding nothing.
    Command { remote: &'a [&'a str] },
    /// One forward from `local` on this computer to `far_end` (`host:port`) as the server sees it, and no command, in
    /// the background.
    Forward { local: Local<'a>, far_end: &'a str, host_keys: HostKeys, on_failure: ForwardFailure },
}

/// This computer's end of a forward.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Local<'a> {
    /// ssh listens on this Unix socket (`-L`), in a folder only the owner can open (Linux, ADR 0098).
    Socket(&'a str),
    /// ssh listens on nothing and carries one connection on its stdin and stdout (`-W`): Windows' OpenSSH can't
    /// listen on a Unix socket, and a port it listened on would take every account's connections (#506).
    Stdio,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HostKeys {
    /// As the owner's config says, which by default refuses a key ssh doesn't know.
    OwnersConfig,
    /// A key ssh doesn't know yet is kept, and one that changed is refused: the sign-in, the first ssh to a server.
    AcceptNew,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ForwardFailure {
    /// ssh exits when any forward fails, its own or one in the owner's config.
    Exit,
    /// ssh runs on, and the caller sees for itself whether its forward works: the owner's config may add a
    /// `LocalForward` whose port the sign-in tunnel already holds.
    KeepGoing,
}

/// Every ssh gets these.
///
/// - `ControlMaster=no`, `ControlPath=none`: through the owner's ControlMaster, a forward would be set up in the master
///   and outlive this ssh, and a new master with `ControlPersist` would itself outlive it. Windows' OpenSSH can't share
///   connections, so there a config that turns sharing on would fail every connection.
/// - `PermitLocalCommand=no`: the owner's config can't have ssh run a command of its own on this computer.
const EVERY: &[&str] = &["-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "PermitLocalCommand=no"];

/// ssh's arguments for `kind` to `target`, giving up connecting after `connect_timeout`: options, then `--`, the
/// target and the remote command.
///
/// An ssh in the background (not `Kind::Terminal`) has no terminal and nothing to answer a prompt with, so a key that
/// needs one fails rather than waiting, and nothing of this computer's (the agent, the X display) is forwarded to the
/// server.
pub fn args(target: Target, kind: Kind, connect_timeout: Option<Duration>) -> Vec<OsString> {
    let background = kind != Kind::Terminal;
    let mut args: Vec<OsString> = Vec::new();
    let mut push = |a: &[&str]| args.extend(a.iter().map(OsString::from));
    match kind {
        // `-t`: a login shell in a terminal even if the owner's config sets a RemoteCommand.
        Kind::Terminal => push(&["-t"]),
        Kind::Command { .. } => push(&["-T"]),
        // `-W` is `-N -T` already.
        Kind::Forward { local: Local::Socket(_), .. } => push(&["-N", "-T"]),
        Kind::Forward { local: Local::Stdio, .. } => {}
    }
    if background {
        push(&["-o", "BatchMode=yes"]);
    }
    if let Some(t) = connect_timeout {
        push(&["-o", &format!("ConnectTimeout={}", t.as_secs().max(1))]);
    }
    push(&["-o", "ServerAliveInterval=15"]);
    if background {
        push(&["-o", "ServerAliveCountMax=3"]);
    }
    push(EVERY);
    if background {
        push(&["-o", "ForwardAgent=no", "-o", "ForwardX11=no"]);
    }
    match kind {
        Kind::Terminal => {}
        // A LocalForward in the owner's config would clash with the sign-in tunnel, and isn't needed here.
        Kind::Command { .. } => push(&["-o", "ClearAllForwardings=yes"]),
        Kind::Forward { local, far_end, host_keys, on_failure } => {
            // The owner's config can't send a tunnel to the background, out of the app's reach and its death signal.
            // OpenSSH before 8.7 refuses this option outright, so the Terminal and commands, which ran on any ssh
            // before, go without it; a tunnel always needed 8.7.
            push(&["-o", "ForkAfterAuthentication=no"]);
            if host_keys == HostKeys::AcceptNew {
                push(&["-o", "StrictHostKeyChecking=accept-new"]);
            }
            push(&["-o", if on_failure == ForwardFailure::Exit { "ExitOnForwardFailure=yes" } else { "ExitOnForwardFailure=no" }]);
            match local {
                // Only the owner can connect to a forwarded socket (its folder is 0700 as well).
                Local::Socket(path) => push(&["-o", "StreamLocalBindMask=0177", "-o", "StreamLocalBindUnlink=yes", "-L", &format!("{path}:{far_end}")]),
                // `-W` drops the config's forwards only while the config leaves `ClearAllForwardings` unset, and a
                // config's `StdinNull yes` would stop ssh reading the connection, so both are set here.
                Local::Stdio => push(&["-o", "ClearAllForwardings=yes", "-o", "StdinNull=no", "-W", far_end]),
            }
        }
    }
    push(&["--", target.as_str()]);
    if let Kind::Command { remote } = kind {
        push(remote);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINDS: [Kind; 7] = [
        Kind::Terminal,
        Kind::Command { remote: &["ss", "-ltnpH"] },
        Kind::Command { remote: &[] },
        Kind::Forward {
            local: Local::Socket("/run/user/1000/d/s"),
            far_end: "127.0.0.1:9119",
            host_keys: HostKeys::AcceptNew,
            on_failure: ForwardFailure::Exit,
        },
        Kind::Forward {
            local: Local::Socket("/run/user/1000/p/s"),
            far_end: "localhost:3000",
            host_keys: HostKeys::OwnersConfig,
            on_failure: ForwardFailure::KeepGoing,
        },
        Kind::Forward { local: Local::Stdio, far_end: "127.0.0.1:9119", host_keys: HostKeys::AcceptNew, on_failure: ForwardFailure::Exit },
        Kind::Forward { local: Local::Stdio, far_end: "[::1]:8080", host_keys: HostKeys::OwnersConfig, on_failure: ForwardFailure::KeepGoing },
    ];

    fn strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter().map(|a| a.into_string().unwrap()).collect()
    }

    fn options(args: &[String]) -> Vec<&str> {
        let end = args.iter().position(|a| a == "--").expect("--");
        args[..end].windows(2).filter(|w| w[0] == "-o").map(|w| w[1].as_str()).collect()
    }

    #[test]
    fn refuses_a_target_ssh_would_read_as_an_option_or_more_than_a_host() {
        for bad in ["", "  ", "-oProxyCommand=evil", "-oProxyCommand=sh", "liam@hermes ls", "liam@hermes -L 1:2:3", "a\tb", "a\nb"] {
            assert_eq!(Target::parse(bad), None, "{bad:?}");
        }
        assert_eq!(Target::parse("  liam@hermes  ").map(Target::as_str), Some("liam@hermes"));
        assert_eq!(Target::parse("hermes").map(Target::as_str), Some("hermes"));
    }

    #[test]
    fn every_ssh_gets_every_option_that_only_takes_something_away() {
        let target = Target::parse("liam@hermes").unwrap();
        for kind in KINDS {
            let args = strings(args(target, kind, None));
            let options = options(&args);
            for o in ["ControlMaster=no", "ControlPath=none", "PermitLocalCommand=no", "ServerAliveInterval=15"] {
                assert!(options.contains(&o), "{kind:?} got -o {o}: {args:?}");
            }
            if kind != Kind::Terminal {
                for o in ["BatchMode=yes", "ForwardAgent=no", "ForwardX11=no"] {
                    assert!(options.contains(&o), "{kind:?} got -o {o}: {args:?}");
                }
                assert!(args.iter().any(|a| a == "-T" || a == "-W"), "{kind:?} asks for no terminal (`-W` is `-T`)");
            }
        }
    }

    #[test]
    fn only_a_tunnel_needs_openssh_8_7() {
        let target = Target::parse("liam@hermes").unwrap();
        for kind in KINDS {
            let args = strings(args(target, kind, None));
            let forked = options(&args).contains(&"ForkAfterAuthentication=no");
            assert_eq!(forked, matches!(kind, Kind::Forward { .. }), "{kind:?}: {args:?}");
        }
    }

    #[test]
    fn each_option_is_set_once() {
        let target = Target::parse("liam@hermes").unwrap();
        for kind in KINDS {
            let args = strings(args(target, kind, Some(Duration::from_secs(15))));
            let mut names: Vec<&str> = options(&args).iter().map(|o| o.split('=').next().unwrap()).collect();
            let all = names.len();
            names.sort_unstable();
            names.dedup();
            assert_eq!(names.len(), all, "{kind:?}: {args:?}");
        }
    }

    #[test]
    fn the_terminal_can_ask_the_owner_and_keeps_the_owners_host_keys() {
        let args = strings(args(Target::parse(" liam@hermes ").unwrap(), Kind::Terminal, None));
        assert_eq!(args[0], "-t");
        assert!(!options(&args).iter().any(|o| o.starts_with("BatchMode") || o.starts_with("StrictHostKeyChecking")), "{args:?}");
        assert_eq!(args[args.len() - 2..], ["--", "liam@hermes"]);
    }

    #[test]
    fn a_command_forwards_nothing_and_comes_after_the_target() {
        let args = strings(args(Target::parse("liam@hermes").unwrap(), Kind::Command { remote: &["ss", "-ltnpH"] }, Some(Duration::from_secs(15))));
        assert!(options(&args).contains(&"ClearAllForwardings=yes"));
        assert!(options(&args).contains(&"ConnectTimeout=15"));
        assert!(!args.iter().any(|a| a == "-L" || a == "-N"));
        assert_eq!(args[args.len() - 4..], ["--", "liam@hermes", "ss", "-ltnpH"]);
    }

    #[test]
    fn a_forward_is_one_l_and_nothing_after_the_target() {
        let target = Target::parse("liam@hermes").unwrap();
        let local = Local::Socket("/run/user/1000/d/s");
        let far_end = "127.0.0.1:9119";
        let tunnel = strings(args(target, Kind::Forward { local, far_end, host_keys: HostKeys::AcceptNew, on_failure: ForwardFailure::Exit }, None));
        assert_eq!(tunnel[..2], ["-N", "-T"]);
        assert_eq!(tunnel[tunnel.len() - 4..], ["-L", "/run/user/1000/d/s:127.0.0.1:9119", "--", "liam@hermes"]);
        let options = options(&tunnel);
        // `ClearAllForwardings` would clear this forward too.
        assert!(!options.iter().any(|o| o.starts_with("ClearAllForwardings") || o.starts_with("ConnectTimeout")), "{tunnel:?}");
        assert!(options.contains(&"StrictHostKeyChecking=accept-new") && options.contains(&"ExitOnForwardFailure=yes"));

        let page = strings(args(target, Kind::Forward { local, far_end, host_keys: HostKeys::OwnersConfig, on_failure: ForwardFailure::KeepGoing }, None));
        assert!(!page.iter().any(|o| o.starts_with("StrictHostKeyChecking")));
        assert!(page.iter().any(|o| o == "ExitOnForwardFailure=no"));
    }

    #[test]
    fn a_forward_over_stdio_listens_on_nothing_with_the_same_options_as_over_a_socket() {
        let target = Target::parse("liam@hermes").unwrap();
        let far_end = "[::1]:8080";
        for (host_keys, on_failure) in [(HostKeys::AcceptNew, ForwardFailure::Exit), (HostKeys::OwnersConfig, ForwardFailure::KeepGoing)] {
            let socket =
                strings(args(target, Kind::Forward { local: Local::Socket("/tmp/d/s"), far_end, host_keys, on_failure }, Some(Duration::from_secs(5))));
            let stdio = strings(args(target, Kind::Forward { local: Local::Stdio, far_end, host_keys, on_failure }, Some(Duration::from_secs(5))));
            assert_eq!(stdio[..stdio.len() - 8], socket[2..socket.len() - 8], "the same options, without -N -T");
            assert_eq!(stdio[stdio.len() - 8..], ["-o", "ClearAllForwardings=yes", "-o", "StdinNull=no", "-W", far_end, "--", "liam@hermes"]);
            assert!(!stdio.iter().any(|a| ["-L", "-D", "-R", "-N"].contains(&a.as_str())), "ssh listens on nothing: {stdio:?}");
        }
    }
}
