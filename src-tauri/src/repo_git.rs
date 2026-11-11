//! The Repository screen's Git operations, run on the Hermes server through the owner's own `ssh` (ADR 0110).
//!
//! The remote command is a constant: `python3 -I -c` with the helper program (repo_git_helper.py) built into the app.
//! What the screen asks for travels on ssh's stdin as one JSON request, and the helper runs `git` with an argument list
//! it builds, never through a shell. So no path, file name or message the owner types is ever read by a shell on
//! either machine. The webview can ask only for the operations in `Request`; nothing here runs a command it names.
//!
//! ssh runs with `BatchMode=yes`: there is no terminal to answer a passphrase or a new host key, so ssh fails instead
//! of waiting, and the screen says how to fix it (connect once in the Terminal, or load the key into the agent).

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

/// The helper program, sent unchanged every time: the Git half, then the worktree half (ADR 0043), which ends by
/// running it.
pub const HELPER: &str = concat!(include_str!("repo_git_helper.py"), include_str!("repo_worktree_helper.py"));

/// What the helper prints on stderr before a progress line, which `run_streaming` passes on as it comes.
const PROGRESS: &str = "\u{1f}hermes-progress\u{1f}";

/// What the helper prints before its answer, so anything a login script prints first can't be mistaken for it.
const MARK: &str = "\u{1e}hermes-repo\u{1e}";

/// The most an answer can be (the helper cuts diffs well below this).
const MAX_REPLY: usize = 16 * 1024 * 1024;

/// Which changes of a file a diff shows.
#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DiffSide {
    /// The index against HEAD: what the next commit would include.
    Staged,
    /// The working tree against the index.
    Unstaged,
    /// A file Git doesn't track yet, shown as all added.
    Untracked,
    /// A file with a merge conflict: Git's combined diff.
    Conflict,
}

/// The operations the screen can ask for. Anything else can't be expressed.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    /// The checkout that holds `repo`: its top folder, branch, upstream and changed files.
    Status { repo: String },
    /// One file's diff. `repo` is the top folder Status gave; `path` (and a rename's `orig_path`) are relative to it.
    #[serde(rename_all = "camelCase")]
    Diff {
        repo: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        orig_path: Option<String>,
        side: DiffSide,
        context: u32,
    },
    /// Stages exactly `files`, each only if its working-tree bytes still hash to the stamp the screen read, and only
    /// if HEAD and the index are still `expect`.
    Stage { repo: String, files: Vec<FileStamp>, expect: Expect },
    /// Takes `paths` out of the index, back to HEAD's version; the working tree is left alone.
    Unstage { repo: String, paths: Vec<String>, expect: Expect },
    /// Stages hunks (or, `reverse`, unstages them): the hunks at positions `hunks` of the diff of `path` shown with
    /// `context` lines, whose bytes hashed to `diff_sha`. The helper reads that diff again, refuses if it changed, and
    /// cuts the hunks from it itself: no patch text comes from the webview.
    #[serde(rename_all = "camelCase")]
    Apply { repo: String, path: String, hunks: Vec<u32>, reverse: bool, context: u32, diff_sha: String, expect: Expect },
    /// What a commit now would hold, and the stamps a commit must match.
    Preview { repo: String },
    /// Commits the index with `message`, verbatim, only if it is still exactly what the preview showed.
    Commit { repo: String, message: String, expect: Expect },
    /// Where a push and a pull request would go: branch, upstream, remotes, unpushed commits, the GitHub repository.
    PublishInfo { repo: String },
    /// Pushes HEAD, if it is still `expect.head` on `branch`, to `remote_branch` on `remote`, if `remote` still pushes
    /// to `push_url` (as shown, without credentials). Never forced.
    #[serde(rename_all = "camelCase")]
    Push { repo: String, remote: String, push_url: String, branch: String, remote_branch: String, expect: HeadExpect },
    /// Opens a pull request from `remote_branch` into `base`, only if `branch` is still checked out at `expect.head`
    /// and the remote has that branch at `expect.head`.
    /// It never pushes.
    #[serde(rename_all = "camelCase")]
    PrCreate {
        repo: String,
        /// The local branch the form was written for: refused if it's no longer checked out at `expect.head`.
        branch: String,
        remote: String,
        /// The GitHub repository (`owner/name`) the form showed: refused if `remote` now names another.
        github_repo: String,
        remote_branch: String,
        base: String,
        title: String,
        body: String,
        draft: bool,
        expect: HeadExpect,
    },
    /// A pull request's state, review and checks, read from GitHub now.
    PrStatus { repo: String, remote: String, number: u64 },
    /// What `remote_branch` is on `remote` now, asked of the remote itself. Settles a push whose answer was lost.
    #[serde(rename_all = "camelCase")]
    RemoteHead { repo: String, remote: String, remote_branch: String },
    /// Every worktree of the repository `repo` is in, with what this app recorded about the ones it made: their
    /// chats, setup and state, and the changes kept from removed ones (ADR 0043).
    WorktreeList { repo: String },
    /// What creating a worktree would do, checked but not done: the base commit, the branch, the folder (a suggested
    /// one when `path` is empty), the setup entries, and a stamp the creation must match.
    #[serde(rename_all = "camelCase")]
    WorktreePlan { repo: String, base: String, branch: String, new_branch: bool, path: String, setup: bool },
    /// Creates the worktree the plan stamped `expect` showed, recorded as `id`, then runs setup once if `setup`.
    #[serde(rename_all = "camelCase")]
    WorktreeCreate { repo: String, id: String, base: String, branch: String, new_branch: bool, path: String, setup: bool, expect: String },
    /// Runs setup again for a worktree whose setup failed or was cut off.
    WorktreeSetup { repo: String, id: String },
    /// Holds the worktree for a chat about to start there (`token`), before Hermes is asked to start it.
    WorktreeAttach { repo: String, id: String, token: String, profile: String, connection: String },
    /// The chat that `token` held a place for has started: Hermes's id for it.
    WorktreeAttachConfirm { repo: String, id: String, token: String, chat: String },
    /// The owner detached a chat from the worktree, or a chat that held a place never started.
    WorktreeDetach { repo: String, id: String, token: String },
    /// Marks a worktree this app made as Protected, or not: a protected one can't be removed.
    WorktreeProtect { repo: String, id: String, protected: bool },
    /// What removing the worktree would touch, what it would keep, what stops it, and a stamp of it all.
    WorktreeRemovePlan { repo: String, id: String },
    /// Removes the worktree, keeping its changes first, only if the plan stamped `expect` still holds.
    WorktreeRemove { repo: String, id: String, expect: String },
    /// Drops the record of a worktree whose folder is gone. Nothing on disk changes.
    WorktreeForget { repo: String, id: String },
}

/// What a push or a pull request expects HEAD to be.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct HeadExpect {
    pub head: Option<String>,
}

/// A file to stage, and the SHA-256 of its working-tree bytes as the screen read them (none: deleted).
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct FileStamp {
    pub path: String,
    pub worktree: Option<String>,
}

/// What a write expects to find: HEAD's commit (none before the first commit), the index's stamp, and for a commit,
/// the stamp of the staged changes the preview showed.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Expect {
    pub head: Option<String>,
    pub index: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_sha: Option<String>,
    /// For a commit: the ref HEAD pointed at in the preview (`refs/heads/<branch>`, or `HEAD` when detached). Two
    /// branches can share a commit, so this keeps a commit on the branch it was previewed on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
}

impl Request {
    /// Reads only: nothing on the server changes. Only these are tried again after a dropped connection.
    pub fn reads_only(&self) -> bool {
        matches!(
            self,
            Request::Status { .. }
                | Request::Diff { .. }
                | Request::Preview { .. }
                | Request::PublishInfo { .. }
                | Request::PrStatus { .. }
                | Request::RemoteHead { .. }
                | Request::WorktreeList { .. }
                | Request::WorktreePlan { .. }
                | Request::WorktreeRemovePlan { .. }
        )
    }

    /// How long the whole round trip may take, ssh's connection included. A commit runs the repository's hooks,
    /// which the helper gives ten minutes.
    fn timeout(&self) -> Duration {
        match self {
            Request::Commit { .. } => Duration::from_secs(660),
            // A push runs a pre-push hook and talks to the remote; the helper gives it five minutes.
            Request::Push { .. } => Duration::from_secs(400),
            // gh talks to GitHub, more than once.
            Request::PublishInfo { .. } | Request::PrStatus { .. } | Request::RemoteHead { .. } => Duration::from_secs(240),
            // ls-remote, a list, the create and the read-back: the helper's own limits add up to five minutes.
            Request::PrCreate { .. } => Duration::from_secs(360),
            // Git checks out every file (it gets 15 minutes), then setup copies and links what .worktreeinclude names.
            Request::WorktreeCreate { .. } | Request::WorktreeSetup { .. } => Duration::from_secs(1800),
            // Keeping every changed file, then Git removing the folder.
            Request::WorktreeRemove { .. } => Duration::from_secs(1200),
            // Each worktree's status, or every changed file read and hashed.
            Request::WorktreeList { .. } | Request::WorktreeRemovePlan { .. } | Request::WorktreePlan { .. } => Duration::from_secs(300),
            _ => Duration::from_secs(60),
        }
    }
}

/// A failure, as the screen tells them apart. `kind` is what the screen keys on; `message` is shown as it is.
#[derive(Debug, Clone, PartialEq)]
pub enum RepoError {
    BadTarget,
    Spawn(String),
    /// ssh couldn't get in: `why` is "ssh-auth", "ssh-host-key", "ssh-unreachable" or "ssh", and `detail` is what ssh said.
    Ssh {
        why: &'static str,
        detail: String,
    },
    /// The server can't run the helper (no python3).
    Unsupported(String),
    /// No answer in time. Whether a write happened isn't known, so the screen reads the repository again before
    /// saying anything about it.
    Timeout(u64),
    /// Something answered, but not the helper.
    BadReply(String),
    /// The helper ran and refused, or git did: `kind` and `message` are the helper's.
    Helper {
        kind: String,
        message: String,
        output: String,
    },
}

impl std::fmt::Display for RepoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RepoError::BadTarget => write!(f, "Enter an SSH target such as liam@hermes or a host alias from ~/.ssh/config."),
            RepoError::Spawn(e) => write!(f, "Couldn't start ssh: {e}"),
            RepoError::Ssh { why: "ssh-auth", .. } => {
                write!(f, "ssh couldn't sign in to the server without asking. The key needs to be in your SSH agent, or unencrypted.")
            }
            RepoError::Ssh { why: "ssh-host-key", .. } => {
                write!(f, "ssh doesn't know this server's host key yet. Connect once from the Terminal and accept it, then try again.")
            }
            RepoError::Ssh { why: "ssh-unreachable", .. } => write!(f, "ssh couldn't reach the server."),
            RepoError::Ssh { .. } => write!(f, "ssh failed."),
            RepoError::Unsupported(e) => write!(f, "{e}"),
            RepoError::Timeout(s) => write!(f, "The server didn't answer within {s} s."),
            RepoError::BadReply(e) => write!(f, "The server's answer wasn't one this app understands: {e}"),
            RepoError::Helper { message, .. } => write!(f, "{message}"),
        }
    }
}

impl Serialize for RepoError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let (kind, output): (&str, &str) = match self {
            RepoError::BadTarget => ("bad-target", ""),
            RepoError::Spawn(_) => ("spawn", ""),
            RepoError::Ssh { why, detail } => (why, detail.as_str()),
            RepoError::Unsupported(_) => ("unsupported", ""),
            RepoError::Timeout(_) => ("timeout", ""),
            RepoError::BadReply(_) => ("bad-reply", ""),
            RepoError::Helper { kind, output, .. } => (kind.as_str(), output.as_str()),
        };
        let mut st = s.serialize_struct("RepoError", 3)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &self.to_string())?;
        st.serialize_field("output", output)?;
        st.end()
    }
}

/// The helper program, deflated, then base64.
fn packed_helper() -> &'static str {
    static PACKED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PACKED.get_or_init(|| {
        use std::io::Write;
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        z.write_all(HELPER.as_bytes()).expect("deflate in memory");
        base64::engine::general_purpose::STANDARD.encode(z.finish().expect("deflate in memory"))
    })
}

/// The command ssh runs on the server. It is the same string every time: nothing in it comes from the owner. The
/// program is deflated, then base64: the remote shell gets it as one argument, and Linux allows one argument 128 KiB.
pub fn remote_command() -> String {
    format!("exec python3 -I -c 'import base64,zlib;exec(zlib.decompress(base64.b64decode(\"{}\")))'", packed_helper())
}

/// The remote command when the helper comes on stdin: it reads one line, the packed helper, and runs it, which then
/// reads the request from the rest of stdin.
pub const STDIN_REMOTE_COMMAND: &str = "exec python3 -I -c 'import base64,sys,zlib;exec(zlib.decompress(base64.b64decode(sys.stdin.buffer.readline())))'";

/// How the helper program reaches the server's python3. Windows caps a whole command line at 32,767 characters
/// (CreateProcess), which the packed helper alone is over, so there it goes on stdin, one line ahead of the request.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HelperDelivery {
    InCommand,
    OnStdin,
}

#[cfg(windows)]
pub const HELPER_DELIVERY: HelperDelivery = HelperDelivery::OnStdin;
#[cfg(not(windows))]
pub const HELPER_DELIVERY: HelperDelivery = HelperDelivery::InCommand;

impl HelperDelivery {
    /// What ssh asks the server to run.
    pub fn remote_command(self) -> String {
        match self {
            HelperDelivery::InCommand => remote_command(),
            HelperDelivery::OnStdin => STDIN_REMOTE_COMMAND.to_owned(),
        }
    }

    /// What goes on stdin ahead of the request.
    fn stdin_prefix(self) -> Option<String> {
        match self {
            HelperDelivery::InCommand => None,
            HelperDelivery::OnStdin => Some(format!("{}\n", packed_helper())),
        }
    }
}

/// `ssh` to `target`, running the helper. The target is checked as the tunnel checks it: no leading '-', no whitespace.
pub fn ssh_command(target: &str) -> Result<Command, RepoError> {
    let target = target.trim();
    if target.is_empty() || target.starts_with('-') || target.contains(char::is_whitespace) {
        return Err(RepoError::BadTarget);
    }
    let mut command = crate::tunnel::background_ssh();
    command.args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        // A LocalForward in the owner's config would clash with the sign-in tunnel, and isn't needed here.
        "-o",
        "ClearAllForwardings=yes",
        "--",
        target,
    ]);
    command.arg(HELPER_DELIVERY.remote_command());
    Ok(command)
}

/// sshd dropped the connection during key exchange, before signing in, as it does when too many connections start at
/// once (its MaxStartups). Nothing ran on the server.
pub fn dropped_before_login(e: &RepoError) -> bool {
    matches!(e, RepoError::Ssh { why: "ssh", detail } if detail.contains("kex_exchange_identification") || detail.contains("Connection reset by peer") || detail.contains("Connection closed by remote host"))
}

/// Runs `request` through ssh to `target`. A read whose connection sshd dropped before signing in is tried once more,
/// half a second later; a write never is, so nothing is ever done twice.
pub async fn run_over_ssh(target: &str, request: &Request) -> Result<serde_json::Value, RepoError> {
    run_over_ssh_streaming(target, request, |_| {}).await
}

/// `run_over_ssh`, passing each progress line the helper prints to `on_progress` as it comes.
pub async fn run_over_ssh_streaming(
    target: &str,
    request: &Request,
    on_progress: impl Fn(serde_json::Value) + Send + Sync,
) -> Result<serde_json::Value, RepoError> {
    let prefix = HELPER_DELIVERY.stdin_prefix();
    match run_fed(ssh_command(target)?, prefix.as_deref(), request, &on_progress).await {
        Err(e) if request.reads_only() && dropped_before_login(&e) => {
            tokio::time::sleep(Duration::from_millis(500)).await;
            run_fed(ssh_command(target)?, prefix.as_deref(), request, &on_progress).await
        }
        other => other,
    }
}

/// What ssh's own failure (exit status 255) was about, from what it printed.
pub fn ssh_failure(stderr: &str) -> &'static str {
    let s = stderr.to_ascii_lowercase();
    if s.contains("host key verification failed") || s.contains("remote host identification has changed") {
        "ssh-host-key"
    } else if s.contains("permission denied") || s.contains("too many authentication failures") {
        "ssh-auth"
    } else if s.contains("could not resolve")
        || s.contains("connection refused")
        || s.contains("connection timed out")
        || s.contains("no route to host")
        || s.contains("network is unreachable")
        || s.contains("operation timed out")
    {
        "ssh-unreachable"
    } else {
        "ssh"
    }
}

/// Runs `command` (ssh, or in tests the helper itself), sends it `request`, and reads the helper's answer: its
/// `result` on success, or what it refused with.
pub async fn run(command: Command, request: &Request) -> Result<serde_json::Value, RepoError> {
    run_streaming(command, request, &|_| {}).await
}

/// `run`, reading the helper's stderr line by line: a progress line (`PROGRESS`, then JSON) goes to `on_progress` as it
/// comes; anything else is kept, as ssh's own words, for the failure.
pub async fn run_streaming(
    command: Command,
    request: &Request,
    on_progress: &(dyn Fn(serde_json::Value) + Send + Sync),
) -> Result<serde_json::Value, RepoError> {
    run_fed(command, None, request, on_progress).await
}

/// `run_streaming`, writing `prefix` on stdin ahead of the request.
pub async fn run_fed(
    mut command: Command,
    prefix: Option<&str>,
    request: &Request,
    on_progress: &(dyn Fn(serde_json::Value) + Send + Sync),
) -> Result<serde_json::Value, RepoError> {
    let mut body = prefix.unwrap_or_default().as_bytes().to_vec();
    // One line: compact JSON escapes every newline inside a string.
    body.extend(serde_json::to_vec(request).map_err(|e| RepoError::BadReply(e.to_string()))?);
    body.push(b'\n');
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| RepoError::Spawn(e.to_string()))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let limit = request.timeout();
    let work = async {
        let write = async move {
            // A helper that never starts (no python3) closes stdin early; its exit status says why.
            let _ = stdin.write_all(&body).await;
            // Kept open until the helper has answered and exited. The helper takes its end as the connection
            // dropping, or this side giving up (the time limit drops it, and kills ssh), and stops what it's doing
            // (ADR 0043): ssh runs it without a terminal, so no hangup reaches it.
            stdin
        };
        let read_out = async {
            let mut buf = Vec::new();
            let _ = (&mut stdout).take(MAX_REPLY as u64 + 1).read_to_end(&mut buf).await;
            // Past the cap the answer is refused below, but the rest is still read and dropped: a helper blocked on
            // a full pipe would never exit, and a write that landed would only be reported at the time limit.
            let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
            buf
        };
        let read_err = async {
            use tokio::io::AsyncBufReadExt;
            let mut buf = Vec::new();
            let mut lines = tokio::io::BufReader::new(&mut stderr);
            let mut line = Vec::new();
            loop {
                line.clear();
                match (&mut lines).take(1024 * 1024).read_until(b'\n', &mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let s = String::from_utf8_lossy(&line);
                if let Some(json) = s.strip_prefix(PROGRESS) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(json.trim_end()) {
                        on_progress(v);
                        continue;
                    }
                }
                if buf.len() < 64 * 1024 {
                    buf.extend_from_slice(&line[..line.len().min(64 * 1024 - buf.len())]);
                }
            }
            buf
        };
        let (stdin, out, err) = tokio::join!(write, read_out, read_err);
        let status = child.wait().await;
        drop(stdin);
        (status, out, err)
    };
    let (status, out, err) = tokio::time::timeout(limit, work).await.map_err(|_| RepoError::Timeout(limit.as_secs()))?;
    let status = status.map_err(|e| RepoError::Spawn(e.to_string()))?;
    let err = String::from_utf8_lossy(&err).trim().to_owned();
    if out.len() > MAX_REPLY {
        return Err(RepoError::BadReply("it was too big.".into()));
    }
    let out = String::from_utf8_lossy(&out);
    let Some(at) = out.rfind(MARK) else {
        return Err(match status.code() {
            Some(255) => RepoError::Ssh { why: ssh_failure(&err), detail: err },
            Some(127) => RepoError::Unsupported(format!(
                "The server has no python3 on the PATH ssh gives it, which the Repository screen needs.{}",
                if err.is_empty() { String::new() } else { format!(" ({err})") }
            )),
            _ => RepoError::BadReply(if err.is_empty() { "no answer.".into() } else { err }),
        });
    };
    let reply: serde_json::Value = serde_json::from_str(&out[at + MARK.len()..]).map_err(|e| RepoError::BadReply(e.to_string()))?;
    if reply.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        return Ok(reply.get("result").cloned().unwrap_or(serde_json::Value::Null));
    }
    let e = reply.get("error").cloned().unwrap_or_default();
    let field = |k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_owned();
    Err(RepoError::Helper { kind: field("kind"), message: field("message"), output: field("output") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_remote_command_is_constant_and_quotes_nothing_from_outside() {
        let c = remote_command();
        assert_eq!(c, remote_command());
        let program = c.split('"').nth(1).unwrap();
        assert!(program.chars().all(|ch| ch.is_ascii_alphanumeric() || "+/=".contains(ch)));
        let deflated = base64::engine::general_purpose::STANDARD.decode(program).unwrap();
        let mut helper = String::new();
        std::io::Read::read_to_string(&mut flate2::read::ZlibDecoder::new(&deflated[..]), &mut helper).unwrap();
        assert_eq!(helper, HELPER);
        // One argument to the remote shell: Linux's MAX_ARG_STRLEN is 128 KiB.
        assert!(c.len() < 120 * 1024, "the remote command is {} bytes", c.len());
        assert!(HELPER.trim_end().ends_with("main()"), "the program ends by running main()");
    }

    #[test]
    fn ssh_refuses_a_target_that_could_be_an_option() {
        assert_eq!(ssh_command("-oProxyCommand=x").err(), Some(RepoError::BadTarget));
        assert_eq!(ssh_command("a b").err(), Some(RepoError::BadTarget));
        assert_eq!(ssh_command("  ").err(), Some(RepoError::BadTarget));
        let cmd = ssh_command("liam@hermes").unwrap();
        let args: Vec<_> = cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        let dashdash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dashdash + 1], "liam@hermes");
        assert_eq!(args[dashdash + 2], HELPER_DELIVERY.remote_command());
        assert_eq!(args.len(), dashdash + 3);
        assert!(args.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
    }

    #[test]
    fn the_helper_fits_a_windows_command_line_only_when_it_comes_on_stdin() {
        assert!(remote_command().len() > 32_767, "if the helper fits now, Windows can pass it in the command");
        assert!(STDIN_REMOTE_COMMAND.len() < 1024);
        assert!(!STDIN_REMOTE_COMMAND.contains('"'), "nothing for Windows's argument quoting to escape");
        let prefix = HelperDelivery::OnStdin.stdin_prefix().unwrap();
        assert_eq!(prefix.matches('\n').count(), 1);
        assert!(prefix.ends_with('\n'));
        assert_eq!(HelperDelivery::InCommand.stdin_prefix(), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_helper_on_stdin_reads_the_request_after_it() {
        let mut c = Command::new("sh");
        c.arg("-c").arg(STDIN_REMOTE_COMMAND);
        let prefix = HelperDelivery::OnStdin.stdin_prefix();
        let dir = std::env::temp_dir().join(format!("hermes-chat-helper-on-stdin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let request = Request::Status { repo: dir.to_str().unwrap().to_owned() };
        let err = run_fed(c, prefix.as_deref(), &request, &|_| {}).await.unwrap_err();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(matches!(&err, RepoError::Helper { .. }), "the helper ran and answered the request: {err:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_answer_over_the_cap_is_refused_without_waiting_for_the_time_limit() {
        // A program that writes more than the cap, then exits: it can only exit if all of it is read.
        let mut c = Command::new("sh");
        c.arg("-c").arg(format!("head -c {} /dev/zero", MAX_REPLY + 4 * 1024 * 1024));
        let r = tokio::time::timeout(Duration::from_secs(20), run(c, &Request::Status { repo: "/r".into() })).await;
        assert!(matches!(r, Ok(Err(RepoError::BadReply(_)))), "{r:?}");
    }

    #[test]
    fn only_reads_are_tried_again_and_only_after_a_drop_before_login() {
        let drop = RepoError::Ssh { why: "ssh", detail: "kex_exchange_identification: read: Connection reset by peer".into() };
        assert!(dropped_before_login(&drop));
        assert!(!dropped_before_login(&RepoError::Ssh { why: "ssh-auth", detail: "Permission denied (publickey).".into() }));
        assert!(!dropped_before_login(&RepoError::Timeout(60)));
        assert!(Request::Status { repo: "/r".into() }.reads_only());
        assert!(Request::PublishInfo { repo: "/r".into() }.reads_only());
        let push = Request::Push {
            repo: "/r".into(),
            remote: "o".into(),
            push_url: "u".into(),
            branch: "b".into(),
            remote_branch: "b".into(),
            expect: HeadExpect { head: None },
        };
        assert!(!push.reads_only());
        let commit =
            Request::Commit { repo: "/r".into(), message: "m".into(), expect: Expect { head: None, index: "i".into(), raw_sha: None, head_ref: None } };
        assert!(!commit.reads_only());
    }

    #[test]
    fn ssh_failures_are_told_apart() {
        assert_eq!(ssh_failure("Host key verification failed."), "ssh-host-key");
        assert_eq!(ssh_failure("liam@x: Permission denied (publickey)."), "ssh-auth");
        assert_eq!(ssh_failure("ssh: Could not resolve hostname nope: Name or service not known"), "ssh-unreachable");
        assert_eq!(ssh_failure("kex_exchange_identification: read: Connection reset by peer"), "ssh");
    }

    #[test]
    fn requests_carry_only_their_own_fields() {
        let r: Request = serde_json::from_str(r#"{"op":"diff","repo":"/r","path":"a","side":"staged","context":3,"argv":["rm"]}"#).unwrap();
        let back = serde_json::to_value(&r).unwrap();
        assert!(back.get("argv").is_none());
        assert!(serde_json::from_str::<Request>(r#"{"op":"exec","argv":["rm"]}"#).is_err());
    }

    #[test]
    fn errors_serialize_with_their_kind() {
        let v = serde_json::to_value(RepoError::Ssh { why: "ssh-auth", detail: "Permission denied".into() }).unwrap();
        assert_eq!(v["kind"], "ssh-auth");
        assert_eq!(v["output"], "Permission denied");
        let v = serde_json::to_value(RepoError::Helper { kind: "stale".into(), message: "m".into(), output: String::new() }).unwrap();
        assert_eq!(v["kind"], "stale");
        assert_eq!(v["message"], "m");
    }
}
