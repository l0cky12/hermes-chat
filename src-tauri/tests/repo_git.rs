#![cfg(unix)]
//! The Repository screen's helper (repo_git_helper.py), run as the server runs it: the exact remote command string
//! through `sh -c`, against real Git repositories in a temporary folder. Only ssh itself is left out.

mod common;

use common::write_executable;
use hermes_chat::repo_git::{self, DiffSide, RepoError, Request};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use tokio::process::Command;

struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("hc-repo-{name}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        Dir(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn s(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = StdCommand::new("git").args(args).current_dir(cwd).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
    assert!(out.status.success() || args[0] == "merge", "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn write(dir: &Path, name: &str, body: &[u8]) {
    let p = dir.join(name);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(p, body).unwrap();
}

/// A repository with one commit on `main`.
fn repo(name: &str) -> Dir {
    let d = Dir::new(name);
    git(d.path(), &["init", "-q", "-b", "main"]);
    git(d.path(), &["config", "user.email", "owner@example.com"]);
    git(d.path(), &["config", "user.name", "Owner"]);
    write(d.path(), "notes.txt", b"one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "first"]);
    d
}

fn helper() -> Command {
    let mut c = Command::new("sh");
    c.arg("-c").arg(repo_git::remote_command());
    c.env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1");
    c
}

async fn ask(req: Request) -> Result<Value, RepoError> {
    repo_git::run(helper(), &req).await
}

async fn status(d: &Dir) -> Value {
    ask(Request::Status { repo: d.s() }).await.unwrap()
}

async fn diff(d: &Dir, path: &str, orig: Option<&str>, side: DiffSide, context: u32) -> Value {
    ask(Request::Diff { repo: d.s(), path: path.into(), orig_path: orig.map(Into::into), side, context }).await.unwrap()
}

fn entry<'a>(s: &'a Value, path: &str) -> &'a Value {
    s["entries"].as_array().unwrap().iter().find(|e| e["path"] == path).unwrap_or_else(|| panic!("no {path} in {s}"))
}

fn kind(e: RepoError) -> String {
    serde_json::to_value(e).unwrap()["kind"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn staged_and_unstaged_changes_in_one_file_have_their_own_diffs() {
    let d = repo("both");
    write(d.path(), "notes.txt", b"one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    git(d.path(), &["add", "notes.txt"]);
    write(d.path(), "notes.txt", b"one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n");

    let s = status(&d).await;
    let e = entry(&s, "notes.txt");
    assert_eq!((e["x"].as_str(), e["y"].as_str()), (Some("M"), Some("M")));
    assert_eq!(e["staged"], serde_json::json!([1, 1]));
    assert_eq!(e["unstaged"], serde_json::json!([1, 1]));
    assert_eq!(s["top"], Value::String(std::fs::canonicalize(d.path()).unwrap().to_string_lossy().into_owned()));
    assert_eq!(s["branch"]["head"], "main");

    let staged = diff(&d, "notes.txt", None, DiffSide::Staged, 1).await;
    let staged = staged["diff"].as_str().unwrap();
    assert!(staged.contains("+TWO") && !staged.contains("NINE"), "{staged}");
    let unstaged = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1).await;
    let unstaged = unstaged["diff"].as_str().unwrap();
    assert!(unstaged.contains("+NINE") && !unstaged.contains("+TWO"), "{unstaged}");
    // One line of context, as asked.
    assert!(unstaged.contains("@@ -8,3 +8,3 @@"), "{unstaged}");
}

#[tokio::test]
async fn the_context_asked_for_is_the_context_shown() {
    let d = repo("context");
    write(d.path(), "notes.txt", b"one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\n");
    let none = diff(&d, "notes.txt", None, DiffSide::Unstaged, 0).await;
    assert!(none["diff"].as_str().unwrap().contains("@@ -5 +5 @@"));
    let all = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1_000_000).await;
    assert!(all["diff"].as_str().unwrap().contains("@@ -1,10 +1,10 @@"));
}

#[tokio::test]
async fn untracked_and_binary_files_are_marked() {
    let d = repo("binary");
    write(d.path(), "logo.bin", b"\x89PNG\x00\x01\x02");
    git(d.path(), &["add", "logo.bin"]);
    git(d.path(), &["commit", "-qm", "logo"]);
    write(d.path(), "logo.bin", b"\x89PNG\x00\x03\x04");
    write(d.path(), "new/blob.dat", b"\x00\x00\x00");
    write(d.path(), "new/readme.md", b"# hi\n");

    let s = status(&d).await;
    let logo = entry(&s, "logo.bin");
    assert_eq!(logo["unstaged"], Value::Null, "binary has no line counts: {logo}");
    assert_eq!(entry(&s, "new/blob.dat")["binary"], true);
    assert_eq!(entry(&s, "new/readme.md")["binary"], false);
    assert_eq!(entry(&s, "new/readme.md")["kind"], "untracked");

    let d1 = diff(&d, "logo.bin", None, DiffSide::Unstaged, 3).await;
    assert!(d1["diff"].as_str().unwrap().contains("Binary files a/logo.bin and b/logo.bin differ"));
    let d2 = diff(&d, "new/readme.md", None, DiffSide::Untracked, 3).await;
    let t = d2["diff"].as_str().unwrap();
    assert!(t.contains("new file mode") && t.contains("+# hi"), "{t}");
}

#[tokio::test]
async fn a_staged_rename_keeps_its_old_path() {
    let d = repo("rename");
    git(d.path(), &["mv", "notes.txt", "docs.txt"]);
    let s = status(&d).await;
    let e = entry(&s, "docs.txt");
    assert_eq!(e["kind"], "renamed");
    assert_eq!(e["origPath"], "notes.txt");
    assert!(s["entries"].as_array().unwrap().iter().all(|e| e["path"] != "notes.txt"));
    let t = diff(&d, "docs.txt", Some("notes.txt"), DiffSide::Staged, 3).await;
    let t = t["diff"].as_str().unwrap();
    assert!(t.contains("rename from notes.txt") && t.contains("rename to docs.txt"), "{t}");
}

#[tokio::test]
async fn a_merge_conflict_is_reported_with_its_stages() {
    let d = repo("conflict");
    git(d.path(), &["checkout", "-qb", "other"]);
    write(d.path(), "notes.txt", b"one\nOTHER\n");
    git(d.path(), &["commit", "-qam", "other"]);
    git(d.path(), &["checkout", "-q", "main"]);
    write(d.path(), "notes.txt", b"one\nMAIN\n");
    git(d.path(), &["commit", "-qam", "main"]);
    git(d.path(), &["merge", "-q", "other"]);

    let s = status(&d).await;
    assert_eq!(s["operation"], "merge");
    let e = entry(&s, "notes.txt");
    assert_eq!(e["kind"], "unmerged");
    assert_eq!((e["x"].as_str(), e["y"].as_str()), (Some("U"), Some("U")));
    let c = diff(&d, "notes.txt", None, DiffSide::Conflict, 3).await;
    assert!(c["diff"].as_str().unwrap().contains("diff --cc notes.txt"));
    assert_eq!(c["stages"], serde_json::json!([1, 2, 3]));
}

#[tokio::test]
async fn paths_are_literal_never_patterns() {
    let d = repo("literal");
    write(d.path(), "a.txt", b"a\n");
    write(d.path(), "b.txt", b"b\n");
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "two"]);
    write(d.path(), "a.txt", b"A\n");
    write(d.path(), "b.txt", b"B\n");
    // A file really called "*.txt" is untracked; the pattern must not reach a.txt or b.txt.
    write(d.path(), "*.txt", b"star\n");
    let star = diff(&d, "*.txt", None, DiffSide::Untracked, 3).await;
    let t = star["diff"].as_str().unwrap();
    assert!(t.contains("+star") && !t.contains("a.txt") && !t.contains("b.txt"), "{t}");
    let tracked = ask(Request::Diff { repo: d.s(), path: "*.txt".into(), orig_path: None, side: DiffSide::Unstaged, context: 3 }).await.unwrap();
    assert_eq!(tracked["diff"], "", "an unstaged diff of '*.txt' is empty, not a.txt and b.txt");
}

#[tokio::test]
async fn ahead_and_behind_come_from_the_upstream() {
    let remote = Dir::new("bare");
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    let d = repo("ahead");
    git(d.path(), &["remote", "add", "origin", &remote.s()]);
    git(d.path(), &["push", "-qu", "origin", "main"]);
    write(d.path(), "notes.txt", b"changed\n");
    git(d.path(), &["commit", "-qam", "local"]);
    let s = status(&d).await;
    assert_eq!(s["branch"]["upstream"], "origin/main");
    assert_eq!(s["branch"]["ahead"], 1);
    assert_eq!(s["branch"]["behind"], 0);
}

#[tokio::test]
async fn bad_folders_are_told_apart() {
    let plain = Dir::new("plain");
    assert_eq!(kind(ask(Request::Status { repo: plain.s() }).await.unwrap_err()), "not-repo");
    assert_eq!(kind(ask(Request::Status { repo: format!("{}/missing", plain.s()) }).await.unwrap_err()), "not-found");
    assert_eq!(kind(ask(Request::Status { repo: "relative/path".into() }).await.unwrap_err()), "bad-path");
    let d = repo("gone");
    let gone = ask(Request::Diff { repo: d.s(), path: "nope.txt".into(), orig_path: None, side: DiffSide::Untracked, context: 3 }).await;
    assert_eq!(kind(gone.unwrap_err()), "stale");
}

#[tokio::test]
async fn what_a_login_script_prints_first_is_ignored() {
    let d = repo("noise");
    let mut c = Command::new("sh");
    c.arg("-c").arg(format!("echo 'Welcome {{\"ok\": false}}'; {}", repo_git::remote_command()));
    let s = repo_git::run(c, &Request::Status { repo: d.s() }).await.unwrap();
    assert_eq!(s["branch"]["head"], "main");
}

#[tokio::test]
async fn a_server_without_python_is_unsupported() {
    let d = repo("nopython");
    let mut c = Command::new("/bin/sh");
    c.arg("-c").arg(repo_git::remote_command()).env("PATH", "/nonexistent");
    let e = repo_git::run(c, &Request::Status { repo: d.s() }).await.unwrap_err();
    assert_eq!(kind(e), "unsupported");
}

#[tokio::test]
async fn paths_outside_the_checkout_are_refused() {
    let d = repo("outside");
    let elsewhere = Dir::new("outside-secret");
    write(elsewhere.path(), "secret.txt", b"not yours\n");
    std::os::unix::fs::symlink(elsewhere.path(), d.path().join("link")).unwrap();
    for path in ["../outside-secret/secret.txt", "link/secret.txt", "./notes.txt", "a//b", "/etc/passwd"] {
        let e = ask(Request::Diff { repo: d.s(), path: path.into(), orig_path: None, side: DiffSide::Untracked, context: 3 }).await.unwrap_err();
        assert_eq!(kind(e), "bad-path", "{path}");
    }
    // A link inside the checkout is still diffed, as a link: its target's name, never what it points at.
    let link = diff(&d, "link", None, DiffSide::Untracked, 3).await;
    assert!(!link["diff"].as_str().unwrap().contains("not yours"));
}

#[tokio::test]
async fn the_owners_diff_settings_dont_change_what_is_shown() {
    let d = repo("noprefix");
    git(d.path(), &["config", "diff.noprefix", "true"]);
    git(d.path(), &["config", "diff.external", "false"]);
    let t = diff(&d, "notes.txt", None, DiffSide::Unstaged, 3).await;
    assert_eq!(t["diff"], "", "no change yet");
    git(d.path(), &["config", "--unset", "diff.noprefix"]);
    git(d.path(), &["config", "diff.srcPrefix", "x/nested/"]);
    git(d.path(), &["config", "diff.dstPrefix", "y/nested/"]);
    write(d.path(), "notes.txt", b"changed\n");
    let t = diff(&d, "notes.txt", None, DiffSide::Unstaged, 3).await;
    assert!(t["diff"].as_str().unwrap().contains("--- a/notes.txt\n+++ b/notes.txt"), "{}", t["diff"]);
}

// ── stage 2: staging and committing ─────────────────────────────────────────

use hermes_chat::repo_git::{Expect, FileStamp};

fn expect_of(v: &Value) -> Expect {
    Expect { head: v["head"].as_str().map(Into::into), index: v["index"].as_str().unwrap().into(), raw_sha: None, head_ref: None }
}

fn stamp_of(s: &Value, path: &str) -> FileStamp {
    FileStamp { path: path.into(), worktree: entry(s, path)["worktree"].as_str().map(Into::into) }
}

fn staged_names(d: &Dir) -> String {
    git(d.path(), &["diff", "--cached", "--name-only"])
}

async fn preview(d: &Dir) -> Value {
    ask(Request::Preview { repo: d.s() }).await.unwrap()
}

async fn commit(d: &Dir, p: &Value, message: &str) -> Result<Value, RepoError> {
    let expect = Expect { raw_sha: p["rawSha"].as_str().map(Into::into), head_ref: p["headRef"].as_str().map(Into::into), ..expect_of(p) };
    ask(Request::Commit { repo: d.s(), message: message.into(), expect }).await
}

fn hook(d: &Dir, name: &str, body: &str) {
    let p = d.path().join(".git/hooks").join(name);
    write_executable(&p, &format!("#!/bin/sh\n{body}\n"));
}

/// A repository with two changed files and an untracked one.
fn busy(name: &str) -> Dir {
    let d = repo(name);
    write(d.path(), "other.txt", b"a\n");
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "two files"]);
    write(d.path(), "notes.txt", b"one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    write(d.path(), "other.txt", b"b\n");
    write(d.path(), "new.txt", b"new\n");
    d
}

#[tokio::test]
async fn staging_takes_only_the_files_named() {
    let d = busy("stage-one");
    let s = status(&d).await;
    let r = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt"), stamp_of(&s, "new.txt")], expect: expect_of(&s) }).await.unwrap();
    assert_eq!(staged_names(&d), "new.txt\nnotes.txt");
    assert_ne!(r["index"], s["index"], "the new index stamp comes back");
}

#[tokio::test]
async fn a_file_changed_after_it_was_read_is_not_staged() {
    let d = busy("stage-stale-file");
    let s = status(&d).await;
    // Another agent writes to the file after the screen read it.
    write(d.path(), "notes.txt", b"rewritten by an agent\n");
    let e = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn nothing_is_staged_when_the_index_moved_meanwhile() {
    let d = busy("stage-stale-index");
    let s = status(&d).await;
    git(d.path(), &["add", "other.txt"]);
    let e = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(staged_names(&d), "other.txt");
}

#[tokio::test]
async fn a_deleted_file_is_staged_as_deleted() {
    let d = busy("stage-delete");
    std::fs::remove_file(d.path().join("other.txt")).unwrap();
    let s = status(&d).await;
    assert_eq!(entry(&s, "other.txt")["worktree"], Value::Null);
    ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "other.txt")], expect: expect_of(&s) }).await.unwrap();
    assert_eq!(git(d.path(), &["diff", "--cached", "--name-status"]), "D\tother.txt");
}

#[tokio::test]
async fn unstaging_leaves_the_working_tree_alone() {
    let d = busy("unstage");
    git(d.path(), &["add", "notes.txt", "other.txt"]);
    let s = status(&d).await;
    ask(Request::Unstage { repo: d.s(), paths: vec!["notes.txt".into()], expect: expect_of(&s) }).await.unwrap();
    assert_eq!(staged_names(&d), "other.txt");
    assert!(std::fs::read_to_string(d.path().join("notes.txt")).unwrap().contains("TWO"));
}

#[tokio::test]
async fn unstaging_works_before_the_first_commit() {
    let d = Dir::new("unborn");
    git(d.path(), &["init", "-q", "-b", "main"]);
    write(d.path(), "a.txt", b"a\n");
    git(d.path(), &["add", "a.txt"]);
    let s = status(&d).await;
    assert_eq!(s["head"], Value::Null);
    ask(Request::Unstage { repo: d.s(), paths: vec!["a.txt".into()], expect: expect_of(&s) }).await.unwrap();
    assert_eq!(staged_names(&d), "");
    assert!(d.path().join("a.txt").exists());

    // Staged, then edited again: the index and the file now differ, and `git rm --cached` would refuse without -f.
    // Unstaging still takes it out of the index, and the edited file stays as it is.
    write(d.path(), "b.txt", b"first\n");
    git(d.path(), &["add", "b.txt"]);
    write(d.path(), "b.txt", b"second\n");
    let s = status(&d).await;
    assert_eq!(s["head"], Value::Null);
    ask(Request::Unstage { repo: d.s(), paths: vec!["b.txt".into()], expect: expect_of(&s) }).await.unwrap();
    assert_eq!(staged_names(&d), "");
    assert_eq!(std::fs::read(d.path().join("b.txt")).unwrap(), b"second\n");
    assert_eq!(git(d.path(), &["ls-files", "--others", "--exclude-standard"]).trim(), "a.txt\nb.txt");
}

/// notes.txt with changes at its top and its bottom: two hunks with one line of context.
fn two_hunks(name: &str) -> Dir {
    let d = repo(name);
    write(d.path(), "notes.txt", b"ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
    d
}

#[tokio::test]
async fn one_hunk_can_be_staged_and_unstaged_on_its_own() {
    let d = two_hunks("hunk");
    let s = status(&d).await;
    let shown = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1).await;
    let text = shown["diff"].as_str().unwrap();
    assert_eq!(text.matches("\n@@").count(), 2, "{text}");
    ask(Request::Apply {
        repo: d.s(),
        path: "notes.txt".into(),
        hunks: vec![1],
        reverse: false,
        context: 1,
        diff_sha: shown["sha"].as_str().unwrap().into(),
        expect: expect_of(&s),
    })
    .await
    .unwrap();
    let cached = git(d.path(), &["diff", "--cached"]);
    assert!(cached.contains("+TEN") && !cached.contains("+ONE"), "{cached}");
    let unstaged = git(d.path(), &["diff"]);
    assert!(unstaged.contains("+ONE") && !unstaged.contains("+TEN"), "{unstaged}");

    // And back out of the index, from the staged diff.
    let s = status(&d).await;
    let staged = diff(&d, "notes.txt", None, DiffSide::Staged, 1).await;
    ask(Request::Apply {
        repo: d.s(),
        path: "notes.txt".into(),
        hunks: vec![0],
        reverse: true,
        context: 1,
        diff_sha: staged["sha"].as_str().unwrap().into(),
        expect: expect_of(&s),
    })
    .await
    .unwrap();
    assert_eq!(staged_names(&d), "");
    assert!(std::fs::read_to_string(d.path().join("notes.txt")).unwrap().contains("TEN"), "the working tree keeps it");
}

#[tokio::test]
async fn a_hunk_from_a_diff_with_no_context_applies_too() {
    let d = two_hunks("hunk-zero");
    let s = status(&d).await;
    let shown = diff(&d, "notes.txt", None, DiffSide::Unstaged, 0).await;
    let text = shown["diff"].as_str().unwrap();
    assert!(text.contains("@@ -1 +1 @@") && text.contains("@@ -10 +10 @@"), "{text}");
    ask(Request::Apply {
        repo: d.s(),
        path: "notes.txt".into(),
        hunks: vec![0],
        reverse: false,
        context: 0,
        diff_sha: shown["sha"].as_str().unwrap().into(),
        expect: expect_of(&s),
    })
    .await
    .unwrap();
    let cached = git(d.path(), &["diff", "--cached"]);
    assert!(cached.contains("+ONE") && !cached.contains("+TEN"), "{cached}");
}

#[tokio::test]
async fn a_hunk_from_a_diff_that_changed_is_refused() {
    let d = two_hunks("hunk-stale");
    let s = status(&d).await;
    let shown = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1).await;
    write(d.path(), "notes.txt", b"ONE\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nTEN\n");
    let e = ask(Request::Apply {
        repo: d.s(),
        path: "notes.txt".into(),
        hunks: vec![1],
        reverse: false,
        context: 1,
        diff_sha: shown["sha"].as_str().unwrap().into(),
        expect: expect_of(&s),
    })
    .await
    .unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn the_preview_is_exactly_what_the_commit_holds() {
    let d = busy("commit");
    git(d.path(), &["add", "notes.txt"]);
    git(d.path(), &["mv", "other.txt", "renamed.txt"]);
    let p = preview(&d).await;
    let files: Vec<_> = p["files"].as_array().unwrap().iter().map(|f| format!("{} {}", f["status"].as_str().unwrap(), f["path"].as_str().unwrap())).collect();
    assert_eq!(files, ["M notes.txt", "D other.txt", "A renamed.txt"]);
    assert_eq!(p["renames"]["renamed.txt"]["from"], "other.txt");
    assert!(p["diff"].as_str().unwrap().contains("+TWO"));
    assert_eq!(p["author"], "Owner <owner@example.com>");
    let before = git(d.path(), &["rev-parse", "HEAD"]);

    let message = "Shout the second line\n\nAnd rename other.txt.\n# kept verbatim\n";
    let c = commit(&d, &p, message).await.unwrap();
    assert_eq!(c["matches"], true);
    assert_eq!(git(d.path(), &["rev-parse", "HEAD^"]), before);
    assert_eq!(git(d.path(), &["log", "-1", "--format=%B"]), message.trim_end());
    // What wasn't staged stayed out: the moved file's unstaged edit, and the untracked file.
    assert_eq!(git(d.path(), &["status", "--porcelain"]), "M renamed.txt\n?? new.txt");
}

#[tokio::test]
async fn a_concurrent_change_to_the_index_stops_the_commit() {
    let d = busy("commit-race-index");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    // Another agent stages a file between the preview and Commit.
    git(d.path(), &["add", "new.txt"]);
    let before = git(d.path(), &["rev-parse", "HEAD"]);
    let e = commit(&d, &p, "Only notes").await.unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), before);
}

#[tokio::test]
async fn a_concurrent_commit_stops_the_commit() {
    let d = busy("commit-race-head");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    git(d.path(), &["commit", "-qm", "someone else"]);
    git(d.path(), &["add", "other.txt"]);
    let e = commit(&d, &p, "Mine").await.unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(git(d.path(), &["log", "-1", "--format=%s"]), "someone else");
}

#[tokio::test]
async fn a_failing_hook_refuses_the_commit_and_says_why() {
    let d = busy("commit-hook");
    hook(&d, "pre-commit", "echo 'lint: notes.txt has shouting' >&2\nexit 1");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    assert_eq!(p["hooks"], serde_json::json!(["pre-commit"]));
    let before = git(d.path(), &["rev-parse", "HEAD"]);
    let e = commit(&d, &p, "Shout").await.unwrap_err();
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["kind"], "hook");
    assert!(v["output"].as_str().unwrap().contains("lint: notes.txt has shouting"), "{v}");
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), before);
    assert_eq!(staged_names(&d), "notes.txt", "the staged change is still staged");
}

#[tokio::test]
async fn hook_output_is_kept_and_a_hook_that_changes_the_commit_is_reported() {
    let d = busy("commit-hook-adds");
    hook(&d, "pre-commit", "echo 'formatting'\ngit add other.txt");
    hook(&d, "post-commit", "echo 'post-commit ran'");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let c = commit(&d, &p, "Shout").await.unwrap();
    assert_eq!(c["matches"], false);
    let files: Vec<_> = c["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_owned()).collect();
    assert_eq!(files, ["notes.txt", "other.txt"]);
    let out = c["output"].as_str().unwrap();
    assert!(out.contains("formatting") && out.contains("post-commit ran"), "{out}");
}

#[tokio::test]
async fn nothing_staged_commits_nothing_rather_than_everything() {
    let d = busy("commit-empty");
    let p = preview(&d).await;
    assert_eq!(p["files"], serde_json::json!([]));
    let e = commit(&d, &p, "Everything?").await.unwrap_err();
    assert_eq!(kind(e), "nothing-staged");
    assert_eq!(git(d.path(), &["log", "--format=%s"]).lines().count(), 2);
}

#[tokio::test]
async fn a_missing_identity_is_its_own_failure() {
    let d = busy("commit-ident");
    git(d.path(), &["config", "--unset", "user.name"]);
    git(d.path(), &["config", "--unset", "user.email"]);
    git(d.path(), &["config", "user.useConfigOnly", "true"]);
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    assert_eq!(p["author"], Value::Null);
    assert_eq!(kind(commit(&d, &p, "Who?").await.unwrap_err()), "identity");
}

#[tokio::test]
async fn an_empty_message_is_refused() {
    let d = busy("commit-message");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    assert_eq!(kind(commit(&d, &p, "  \n").await.unwrap_err()), "empty-message");
}

#[tokio::test]
async fn a_hunk_that_isnt_there_is_refused() {
    let d = two_hunks("hunk-missing");
    let s = status(&d).await;
    let shown = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1).await;
    let e = ask(Request::Apply {
        repo: d.s(),
        path: "notes.txt".into(),
        hunks: vec![5],
        reverse: false,
        context: 1,
        diff_sha: shown["sha"].as_str().unwrap().into(),
        expect: expect_of(&s),
    })
    .await
    .unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn hunks_apply_under_the_owners_whitespace_and_prefix_settings() {
    let d = repo("hunk-config");
    git(d.path(), &["config", "diff.noprefix", "true"]);
    git(d.path(), &["config", "apply.whitespace", "error"]);
    write(d.path(), "notes.txt", b"one  \ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    let s = status(&d).await;
    let shown = diff(&d, "notes.txt", None, DiffSide::Unstaged, 1).await;
    ask(Request::Apply {
        repo: d.s(),
        path: "notes.txt".into(),
        hunks: vec![0],
        reverse: false,
        context: 1,
        diff_sha: shown["sha"].as_str().unwrap().into(),
        expect: expect_of(&s),
    })
    .await
    .unwrap();
    assert!(git(d.path(), &["diff", "--cached"]).contains("+one  "), "staged exactly as shown, trailing spaces kept");
}

#[tokio::test]
async fn folders_and_submodules_are_never_staged_whole() {
    let d = busy("stage-folder");
    write(d.path(), "dir/secret.env", b"TOKEN=x\n");
    let s = status(&d).await;
    for path in ["dir", "src"] {
        std::fs::create_dir_all(d.path().join(path)).unwrap();
        let e = ask(Request::Stage { repo: d.s(), files: vec![FileStamp { path: path.into(), worktree: None }], expect: expect_of(&s) }).await.unwrap_err();
        assert_eq!(kind(e), "bad-path", "{path}");
    }
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn a_commit_during_a_merge_is_refused() {
    let d = repo("commit-merge");
    git(d.path(), &["checkout", "-qb", "other"]);
    write(d.path(), "notes.txt", b"one\nOTHER\n");
    git(d.path(), &["commit", "-qam", "other"]);
    git(d.path(), &["checkout", "-q", "main"]);
    write(d.path(), "notes.txt", b"one\nMAIN\n");
    git(d.path(), &["commit", "-qam", "main"]);
    git(d.path(), &["merge", "-q", "other"]);
    write(d.path(), "notes.txt", b"one\nBOTH\n");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let before = git(d.path(), &["rev-parse", "HEAD"]);
    assert_eq!(kind(commit(&d, &p, "Merge").await.unwrap_err()), "operation");
    assert_eq!(git(d.path(), &["rev-parse", "HEAD"]), before);
}

#[tokio::test]
async fn a_commit_that_fails_for_another_reason_isnt_blamed_on_a_hook() {
    let d = busy("commit-not-hook");
    hook(&d, "pre-commit", "echo 'pre-commit: fine'");
    git(d.path(), &["config", "commit.gpgSign", "true"]);
    git(d.path(), &["config", "gpg.program", "false"]);
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let e = serde_json::to_value(commit(&d, &p, "Signed?").await.unwrap_err()).unwrap();
    assert_eq!(e["kind"], "git", "{e}");
    assert!(e["output"].as_str().unwrap().contains("gpg"), "{e}");
}

#[tokio::test]
async fn nothing_another_agent_stages_during_the_commit_gets_in() {
    let d = busy("commit-concurrent");
    // The hook plays an agent working in the same checkout: mid-commit it tries to stage new.txt in the real index.
    hook(
        &d,
        "pre-commit",
        "if env -u GIT_INDEX_FILE git add new.txt 2>/dev/null; then echo 'agent staged new.txt'; else echo 'agent blocked by the index lock'; fi",
    );
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let c = commit(&d, &p, "Only notes").await.unwrap();
    assert!(c["output"].as_str().unwrap().contains("agent blocked by the index lock"), "{c}");
    let files: Vec<_> = c["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_owned()).collect();
    assert_eq!(files, ["notes.txt"]);
    assert_eq!(c["matches"], true);
    assert!(!d.path().join(".git/index.lock").exists(), "the lock is let go");
    assert_eq!(git(d.path(), &["status", "--porcelain", "--", "new.txt"]), "?? new.txt");
}

#[tokio::test]
async fn a_held_index_lock_changes_nothing() {
    let d = busy("index-locked");
    let s = status(&d).await;
    std::fs::write(d.path().join(".git/index.lock"), b"").unwrap();
    let e = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap_err();
    assert_eq!(kind(e), "locked");
    assert!(d.path().join(".git/index.lock").exists(), "someone else's lock is left alone");
    std::fs::remove_file(d.path().join(".git/index.lock")).unwrap();
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn a_mode_change_after_reading_is_a_change() {
    use std::os::unix::fs::PermissionsExt;
    let d = busy("stage-chmod");
    let s = status(&d).await;
    std::fs::set_permissions(d.path().join("notes.txt"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let e = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap_err();
    assert_eq!(kind(e), "stale");
    // Read again, it stages with the mode it now has, and the bytes that were read.
    let s = status(&d).await;
    ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap();
    assert!(git(d.path(), &["ls-files", "--stage", "notes.txt"]).starts_with("100755 "));
    assert_eq!(git(d.path(), &["show", ":notes.txt"]), std::fs::read_to_string(d.path().join("notes.txt")).unwrap().trim_end());
}

#[tokio::test]
async fn a_deleted_file_is_still_staged_as_deleted_and_a_link_as_a_link() {
    let d = busy("stage-kinds");
    std::os::unix::fs::symlink("notes.txt", d.path().join("alias")).unwrap();
    let s = status(&d).await;
    ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "alias")], expect: expect_of(&s) }).await.unwrap();
    assert!(git(d.path(), &["ls-files", "--stage", "alias"]).starts_with("120000 "));
    assert_eq!(git(d.path(), &["show", ":alias"]), "notes.txt");
}

#[tokio::test]
async fn an_interrupted_commit_that_landed_leaves_the_index_matching_it() {
    use tokio::io::AsyncWriteExt;
    let d = busy("commit-interrupted");
    let marker = d.path().join(".git/post-commit-started");
    let pidfile = d.path().join(".git/post-commit-pid");
    // A formatter stages its change during the commit, then a slow post-commit hook keeps Git busy.
    hook(&d, "pre-commit", "printf 'formatted\\n' > notes.txt && git add notes.txt");
    hook(&d, "post-commit", &format!("echo $$ > '{}'; touch '{}'; sleep 30", pidfile.display(), marker.display()));
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let before = git(d.path(), &["rev-parse", "HEAD"]);
    let req = Request::Commit {
        repo: d.s(),
        message: "Interrupted".into(),
        expect: Expect { raw_sha: p["rawSha"].as_str().map(Into::into), head_ref: p["headRef"].as_str().map(Into::into), ..expect_of(&p) },
    };
    let mut child = helper().stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    // The request is one line, and stdin stays open, as `run` keeps it: its end would stop the helper by itself.
    stdin.write_all(&serde_json::to_vec(&req).unwrap()).await.unwrap();
    stdin.write_all(b"\n").await.unwrap();
    for _ in 0..200 {
        if marker.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(marker.exists(), "the post-commit hook started");
    // What a dropped ssh does: the helper gets a signal while Git is still in the post-commit hook.
    unsafe { libc::kill(child.id().unwrap() as i32, libc::SIGTERM) };
    let _ = child.wait().await;
    drop(stdin);
    if let Ok(pid) = std::fs::read_to_string(&pidfile) {
        unsafe { libc::kill(pid.trim().parse().unwrap(), libc::SIGKILL) };
    }
    assert_ne!(git(d.path(), &["rev-parse", "HEAD"]), before, "the commit landed");
    assert_eq!(git(d.path(), &["show", "HEAD:notes.txt"]), "formatted");
    assert_eq!(git(d.path(), &["diff", "--cached", "--name-only"]), "", "the index matches the commit, with the hook's change");
    assert!(!d.path().join(".git/index.lock").exists(), "the lock is let go");
}

#[tokio::test]
async fn the_mode_staged_is_the_one_read_even_if_a_filter_changes_it() {
    let d = busy("stage-filter-chmod");
    std::fs::write(d.path().join(".git/info/attributes"), "notes.txt filter=chmodder\n").unwrap();
    // git status runs clean filters too, so the filter only changes the mode once the flag exists: during staging.
    git(d.path(), &["config", "filter.chmodder.clean", "sh -c '[ -e .git/chmod-now ] && chmod +x \"$1\"; cat' sh %f"]);
    let s = status(&d).await;
    assert!(!git(d.path(), &["ls-files", "--stage", "notes.txt"]).is_empty());
    std::fs::write(d.path().join(".git/chmod-now"), b"").unwrap();
    ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap();
    assert!(git(d.path(), &["ls-files", "--stage", "notes.txt"]).starts_with("100644 "), "{}", git(d.path(), &["ls-files", "--stage", "notes.txt"]));
    use std::os::unix::fs::PermissionsExt;
    assert!(std::fs::metadata(d.path().join("notes.txt")).unwrap().permissions().mode() & 0o111 != 0, "the filter did run");
}

// ── stage 3: pushing and pull requests ──────────────────────────────────────

use hermes_chat::repo_git::HeadExpect;

/// A repository on branch `feature` with one commit its bare remote doesn't have yet.
fn with_remote(name: &str) -> (Dir, Dir) {
    let remote = Dir::new(&format!("{name}-bare"));
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    let d = repo(name);
    git(d.path(), &["remote", "add", "origin", &remote.s()]);
    git(d.path(), &["push", "-qu", "origin", "main"]);
    git(d.path(), &["checkout", "-qb", "feature"]);
    write(d.path(), "notes.txt", b"feature work\n");
    git(d.path(), &["commit", "-qam", "Feature work"]);
    (d, remote)
}

/// The push URL Push's confirmation shows for `remote`: credentials in an http(s) URL taken out, as the helper does.
fn shown_url(d: &Dir, remote: &str) -> String {
    let url = git(d.path(), &["remote", "get-url", "--push", remote]);
    for scheme in ["https://", "http://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            if let Some(at) = rest.find('@').filter(|&at| !rest[..at].contains('/')) {
                return format!("{scheme}{}", &rest[at + 1..]);
            }
        }
    }
    url
}

fn head(d: &Dir) -> String {
    git(d.path(), &["rev-parse", "HEAD"])
}

async fn push(d: &Dir, expect: Option<String>) -> Result<Value, RepoError> {
    ask(Request::Push {
        repo: d.s(),
        remote: "origin".into(),
        push_url: shown_url(d, "origin"),
        branch: "feature".into(),
        remote_branch: "feature".into(),
        expect: HeadExpect { head: expect },
    })
    .await
}

#[tokio::test]
async fn publish_info_names_the_remote_branch_and_the_commits_to_push() {
    let (d, _remote) = with_remote("publish-info");
    git(d.path(), &["remote", "add", "mirror", "https://someone:s3cret-token@example.com/team/app.git"]);
    let p = ask(Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["branch"], "feature");
    assert_eq!(p["upstream"], Value::Null);
    assert_eq!(p["remote"], "origin", "with no upstream, origin is where a push goes");
    assert_eq!(p["remoteBranch"], "feature");
    assert_eq!(p["ahead"], 1);
    assert_eq!(p["commits"][0]["subject"], "Feature work");
    assert_eq!(p["bases"], serde_json::json!(["main"]));
    assert_eq!(p["github"], Value::Null, "a remote that isn't GitHub has no pull requests");
    let mirror = p["remotes"].as_array().unwrap().iter().find(|r| r["name"] == "mirror").unwrap();
    assert_eq!(mirror["url"], "https://example.com/team/app.git", "credentials in a URL are never shown");
    assert!(!p.to_string().contains("s3cret-token"));
}

#[tokio::test]
async fn a_push_sends_exactly_the_commit_shown_and_reads_the_remote_back() {
    let (d, remote) = with_remote("push");
    let h = head(&d);
    let r = push(&d, Some(h.clone())).await.unwrap();
    assert_eq!(r["pushed"], Value::String(h.clone()));
    assert_eq!(r["remoteHead"], Value::String(h.clone()));
    assert_eq!(r["matches"], true);
    assert_eq!(r["upstreamSet"], true);
    assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/feature"]), h);
    assert_eq!(git(d.path(), &["rev-parse", "--abbrev-ref", "feature@{upstream}"]), "origin/feature");
    let p = ask(Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["ahead"], 0);
    assert_eq!(p["remoteBranchExists"], true, "{p}");
    assert_eq!(p["upstream"]["branch"], "feature");
}

#[tokio::test]
async fn a_new_branch_on_commits_the_remote_has_can_still_be_pushed() {
    // A branch made at a commit the remote already has under another name: nothing new to send, but the remote has
    // no branch of this name. That's not "nothing to push": a push creates the branch, so a pull request can follow.
    let (d, remote) = with_remote("push-new-at-known");
    push(&d, Some(head(&d))).await.unwrap();
    git(d.path(), &["switch", "-qc", "fresh"]);
    let p = ask(Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["branch"], "fresh");
    assert_eq!(p["remoteBranch"], "fresh");
    assert_eq!(p["ahead"], 0, "every commit is already on the remote: {p}");
    assert_eq!(p["remoteBranchExists"], false, "but the remote has no branch called fresh: {p}");
    ask(Request::Push {
        repo: d.s(),
        remote: "origin".into(),
        push_url: shown_url(&d, "origin"),
        branch: "fresh".into(),
        remote_branch: "fresh".into(),
        expect: HeadExpect { head: Some(head(&d)) },
    })
    .await
    .unwrap();
    assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/fresh"]), head(&d));
    let p = ask(Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["ahead"], 0);
    assert_eq!(p["remoteBranchExists"], true, "{p}");
}

#[tokio::test]
async fn a_push_from_a_moved_head_is_refused() {
    let (d, remote) = with_remote("push-stale");
    let shown = head(&d);
    write(d.path(), "notes.txt", b"an agent committed more\n");
    git(d.path(), &["commit", "-qam", "More"]);
    assert_eq!(kind(push(&d, Some(shown)).await.unwrap_err()), "stale");
    assert_eq!(git(remote.path(), &["branch", "--list", "feature"]), "");
}

#[tokio::test]
async fn a_rejected_push_is_never_forced() {
    let (d, remote) = with_remote("push-rejected");
    push(&d, Some(head(&d))).await.unwrap();
    // Someone else pushes to the branch from another clone.
    let other = Dir::new("push-rejected-other");
    git(other.path(), &["clone", "-q", "-b", "feature", &remote.s(), "."]);
    git(other.path(), &["-c", "user.name=O", "-c", "user.email=o@e", "commit", "-q", "--allow-empty", "-m", "theirs"]);
    git(other.path(), &["push", "-q"]);
    let theirs = git(other.path(), &["rev-parse", "HEAD"]);
    write(d.path(), "notes.txt", b"mine\n");
    git(d.path(), &["commit", "-qam", "Mine"]);
    let e = push(&d, Some(head(&d))).await.unwrap_err();
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["kind"], "rejected", "{v}");
    assert!(v["output"].as_str().unwrap().contains("[rejected]"));
    assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/feature"]), theirs, "their commit is still there");
}

#[tokio::test]
async fn a_server_side_refusal_and_a_pre_push_hook_are_told_apart() {
    let (d, remote) = with_remote("push-hooks");
    hook(&d, "pre-push", "echo 'pre-push: tests must pass first' >&2\nexit 1");
    let e = serde_json::to_value(push(&d, Some(head(&d))).await.unwrap_err()).unwrap();
    assert_eq!(e["kind"], "hook");
    assert!(e["output"].as_str().unwrap().contains("tests must pass first"));
    std::fs::remove_file(d.path().join(".git/hooks/pre-push")).unwrap();

    let p = remote.path().join("hooks/pre-receive");
    write_executable(&p, "#!/bin/sh\necho 'feature is protected' >&2\nexit 1\n");
    let e = serde_json::to_value(push(&d, Some(head(&d))).await.unwrap_err()).unwrap();
    assert_eq!(e["kind"], "remote-rejected", "{e}");
    assert!(e["output"].as_str().unwrap().contains("feature is protected"));
}

#[tokio::test]
async fn a_push_to_an_unreachable_remote_is_a_network_failure() {
    let (d, _remote) = with_remote("push-network");
    git(d.path(), &["remote", "set-url", "origin", "https://nohost.invalid/team/app.git"]);
    assert_eq!(kind(push(&d, Some(head(&d))).await.unwrap_err()), "network");
}

#[tokio::test]
async fn names_that_could_be_options_are_refused() {
    let (d, _remote) = with_remote("push-names");
    let e = ask(Request::Push {
        repo: d.s(),
        remote: "origin".into(),
        push_url: shown_url(&d, "origin"),
        branch: "feature".into(),
        remote_branch: "--force".into(),
        expect: HeadExpect { head: Some(head(&d)) },
    })
    .await
    .unwrap_err();
    assert_eq!(kind(e), "bad-branch");
    let e = ask(Request::Push {
        repo: d.s(),
        remote: "--mirror".into(),
        push_url: String::new(),
        branch: "feature".into(),
        remote_branch: "feature".into(),
        expect: HeadExpect { head: Some(head(&d)) },
    })
    .await
    .unwrap_err();
    assert_eq!(kind(e), "bad-remote");
}

#[tokio::test]
async fn pull_requests_need_a_github_remote_and_never_push() {
    let (d, remote) = with_remote("pr-local");
    let e = ask(Request::PrCreate {
        repo: d.s(),
        branch: "feature".into(),
        remote: "origin".into(),
        github_repo: "acme/widgets".into(),
        remote_branch: "feature".into(),
        base: "main".into(),
        title: "Feature".into(),
        body: String::new(),
        draft: false,
        expect: HeadExpect { head: Some(head(&d)) },
    })
    .await
    .unwrap_err();
    assert_eq!(kind(e), "unsupported");
    assert_eq!(git(remote.path(), &["branch", "--list", "feature"]), "", "nothing was pushed");
}

#[tokio::test]
async fn a_branch_tracking_main_is_never_pushed_to_main() {
    let (d, remote) = with_remote("push-tracks-main");
    git(d.path(), &["checkout", "-q", "main"]);
    git(d.path(), &["fetch", "-q", "origin"]);
    git(d.path(), &["switch", "-qc", "fix", "origin/main"]);
    write(d.path(), "notes.txt", b"a fix\n");
    git(d.path(), &["commit", "-qam", "Fix"]);
    let main_before = git(remote.path(), &["rev-parse", "refs/heads/main"]);
    let p = ask(Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["upstream"]["branch"], "main");
    assert_eq!(p["remoteBranch"], "fix", "{p}");
    ask(Request::Push {
        repo: d.s(),
        remote: "origin".into(),
        push_url: shown_url(&d, "origin"),
        branch: "fix".into(),
        remote_branch: "fix".into(),
        expect: HeadExpect { head: Some(head(&d)) },
    })
    .await
    .unwrap();
    assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/main"]), main_before);
    assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/fix"]), head(&d));
}

#[tokio::test]
async fn push_remote_settings_choose_the_remote() {
    let (d, _remote) = with_remote("push-remote");
    let fork = Dir::new("push-remote-fork");
    git(fork.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(d.path(), &["remote", "add", "fork", &fork.s()]);
    git(d.path(), &["config", "branch.feature.pushRemote", "fork"]);
    let p = ask(Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["remote"], "fork");
    git(d.path(), &["config", "--unset", "branch.feature.pushRemote"]);
    git(d.path(), &["config", "remote.pushDefault", "fork"]);
    let p = ask(Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["remote"], "fork");
}

#[tokio::test]
async fn a_hook_mentioning_403_is_still_a_hook() {
    let (d, _remote) = with_remote("push-hook-403");
    hook(&d, "pre-push", "echo 'tests: expected 403, got 200; Permission denied for fixture' >&2\nexit 1");
    let e = serde_json::to_value(push(&d, Some(head(&d))).await.unwrap_err()).unwrap();
    assert_eq!(e["kind"], "hook", "{e}");
}

#[tokio::test]
async fn a_configured_remote_named_like_an_option_is_refused() {
    let (d, remote) = with_remote("push-option-remote");
    git(d.path(), &["config", "remote.--no-verify.url", &remote.s()]);
    let p = ask(Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert!(p["remotes"].as_array().unwrap().iter().all(|r| r["name"] != "--no-verify"));
    let e = ask(Request::Push {
        repo: d.s(),
        remote: "--no-verify".into(),
        push_url: String::new(),
        branch: "feature".into(),
        remote_branch: "feature".into(),
        expect: HeadExpect { head: Some(head(&d)) },
    })
    .await
    .unwrap_err();
    assert_eq!(kind(e), "bad-remote");
}

#[tokio::test]
async fn a_push_is_checked_where_it_went_not_where_fetches_come_from() {
    let (d, fetch_from) = with_remote("push-url");
    let push_to = Dir::new("push-url-target");
    git(push_to.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(d.path(), &["remote", "set-url", "--push", "origin", &push_to.s()]);
    let r = push(&d, Some(head(&d))).await.unwrap();
    assert_eq!(r["matches"], true, "{r}");
    assert_eq!(git(push_to.path(), &["rev-parse", "refs/heads/feature"]), head(&d));
    assert_eq!(git(fetch_from.path(), &["branch", "--list", "feature"]), "");
    let h = ask(Request::RemoteHead { repo: d.s(), remote: "origin".into(), remote_branch: "feature".into() }).await.unwrap();
    assert_eq!(h["remoteHead"], Value::String(head(&d)));
}

#[tokio::test]
async fn a_remote_that_pushes_to_two_places_is_refused() {
    let (d, remote) = with_remote("push-two");
    let other = Dir::new("push-two-other");
    git(other.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(d.path(), &["remote", "set-url", "--add", "--push", "origin", &remote.s()]);
    git(d.path(), &["remote", "set-url", "--add", "--push", "origin", &other.s()]);
    let p = ask(Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["remotePushUrls"].as_array().unwrap().len(), 2);
    assert_eq!(kind(push(&d, Some(head(&d))).await.unwrap_err()), "unsupported");
    assert_eq!(git(remote.path(), &["branch", "--list", "feature"]), "");
    assert_eq!(git(other.path(), &["branch", "--list", "feature"]), "");
}

#[tokio::test]
async fn credentials_in_a_remote_url_never_come_back_in_output() {
    let (d, _remote) = with_remote("push-redact");
    git(d.path(), &["remote", "set-url", "origin", "https://someone:s3cret-token@nohost.invalid/team/app.git"]);
    let e = serde_json::to_value(push(&d, Some(head(&d))).await.unwrap_err()).unwrap();
    assert!(!e.to_string().contains("s3cret-token"), "{e}");
}

#[tokio::test]
async fn a_push_never_takes_tags_along() {
    let (d, remote) = with_remote("push-tags");
    git(d.path(), &["config", "push.followTags", "true"]);
    git(d.path(), &["tag", "-a", "v9.9.9", "-m", "release"]);
    push(&d, Some(head(&d))).await.unwrap();
    assert_eq!(git(remote.path(), &["tag", "--list"]), "", "only the branch was pushed");
    assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/feature"]), head(&d));
}

#[tokio::test]
async fn a_separate_push_destination_is_asked_not_assumed() {
    let (d, fetch_from) = with_remote("push-separate");
    // The fetch remote has the branch at HEAD (pushed there and fetched), so its tracking ref says "nothing to push".
    git(d.path(), &["push", "-q", "-u", "origin", "feature"]);
    let push_to = Dir::new("push-separate-target");
    git(push_to.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(d.path(), &["remote", "set-url", "--push", "origin", &push_to.s()]);
    let p = ask(Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["remoteAsked"], true);
    assert_eq!(p["remoteHead"], Value::Null, "the push destination doesn't have the branch");
    assert_eq!(p["remoteBranchExists"], false, "{p}");
    assert_ne!(p["ahead"], 0, "{p}");
    assert_eq!(git(fetch_from.path(), &["rev-parse", "refs/heads/feature"]), head(&d));
}

#[tokio::test]
async fn a_pull_request_made_but_slow_to_read_back_keeps_its_link() {
    let (d, remote) = with_remote("pr-readback");
    push(&d, Some(head(&d))).await.unwrap();
    // The remote is written as a GitHub URL, and rewritten to the local bare repository for Git.
    git(d.path(), &["remote", "set-url", "origin", "https://github.com/acme/widgets.git"]);
    git(d.path(), &["config", &format!("url.{}.insteadOf", remote.s()), "https://github.com/acme/widgets.git"]);
    // A stand-in gh: makes the pull request, then never answers the read-back in time.
    let bin = Dir::new("pr-readback-bin");
    let gh = bin.path().join("gh");
    write_executable(&gh, "#!/bin/sh\ncase \"$1 $2\" in\n  'pr list') echo '[]';;\n  'pr create') cat >/dev/null; echo 'https://github.com/acme/widgets/pull/5';;\n  'pr view') sleep 5;;\nesac\n");
    let mut c = helper();
    c.env("PATH", format!("{}:{}", bin.s(), std::env::var("PATH").unwrap())).env("HERMES_REPO_READBACK_TIMEOUT", "1");
    let r = repo_git::run(
        c,
        &Request::PrCreate {
            repo: d.s(),
            branch: "feature".into(),
            remote: "origin".into(),
            github_repo: "acme/widgets".into(),
            remote_branch: "feature".into(),
            base: "main".into(),
            title: "Feature".into(),
            body: "Body".into(),
            draft: false,
            expect: HeadExpect { head: Some(head(&d)) },
        },
    )
    .await
    .unwrap();
    assert_eq!(r["pr"]["url"], "https://github.com/acme/widgets/pull/5");
    assert_eq!(r["readBack"], false);
    assert!(r["readBackError"].as_str().unwrap().contains("longer than"), "{r}");
}

// ── Codex review round 1 (consolidation for #66) ────────────────────────────

#[tokio::test]
async fn a_commit_is_refused_when_another_branch_was_checked_out_at_the_same_commit() {
    // Another process switches to a branch at the same commit, carrying the staged change along: HEAD's commit, the
    // index and the staged diff all still match the preview, but the commit would land on the other branch.
    let d = repo("commit-branch-switch");
    git(d.path(), &["checkout", "-qb", "feature"]);
    git(d.path(), &["branch", "-q", "release"]);
    write(d.path(), "notes.txt", b"feature work\n");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    assert_eq!(p["headRef"], "refs/heads/feature");
    let before = head(&d);
    git(d.path(), &["switch", "-q", "release"]);
    let e = commit(&d, &p, "Feature work").await.unwrap_err();
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["kind"], "stale", "{v}");
    assert!(v["message"].as_str().unwrap().contains("feature, now release"), "{v}");
    assert_eq!(git(d.path(), &["rev-parse", "refs/heads/release"]), before, "nothing landed on release");
    assert_eq!(git(d.path(), &["rev-parse", "refs/heads/feature"]), before);
    assert_eq!(staged_names(&d), "notes.txt", "the staged change is still staged");
}

#[tokio::test]
async fn a_commit_without_the_previewed_branch_is_refused() {
    let d = repo("commit-no-head-ref");
    write(d.path(), "notes.txt", b"changed\n");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let expect = Expect { raw_sha: p["rawSha"].as_str().map(Into::into), ..expect_of(&p) };
    let e = ask(Request::Commit { repo: d.s(), message: "No branch said".into(), expect }).await.unwrap_err();
    assert_eq!(kind(e), "internal");
    assert_eq!(git(d.path(), &["rev-list", "--count", "HEAD"]), "1");
}

#[tokio::test]
async fn a_staged_submodule_is_previewed_even_when_config_says_to_ignore_submodules() {
    // A gitlink (a submodule's commit) staged beside an ordinary file, with the owner's config told to ignore
    // submodules in diffs, both globally and for this submodule. Git still commits the gitlink, so the preview,
    // the status list and the read-back must all show it.
    let d = repo("submodule-hidden");
    let pinned = head(&d);
    git(d.path(), &["update-index", "--add", "--cacheinfo", &format!("160000,{pinned},vendor/lib")]);
    git(d.path(), &["config", "diff.ignoreSubmodules", "all"]);
    git(d.path(), &["config", "submodule.vendor/lib.ignore", "all"]);
    write(d.path(), "notes.txt", b"ordinary change\n");
    git(d.path(), &["add", "notes.txt"]);
    let s = status(&d).await;
    assert!(s["entries"].as_array().unwrap().iter().any(|e| e["path"] == "vendor/lib"), "status lists the gitlink: {s}");
    let p = preview(&d).await;
    let files: Vec<&str> = p["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert!(files.contains(&"vendor/lib") && files.contains(&"notes.txt"), "{files:?}");
    let shown = diff(&d, "vendor/lib", None, DiffSide::Staged, 3).await;
    assert!(shown["diff"].as_str().unwrap().contains(&format!("+Subproject commit {pinned}")), "the gitlink's diff shows its commit: {shown}");
    let r = commit(&d, &p, "Pin the library").await.unwrap();
    assert_eq!(r["matches"], true, "the commit holds exactly what was previewed: {r}");
    assert_eq!(git(d.path(), &["ls-tree", "HEAD", "vendor/lib"]).split_whitespace().nth(2), Some(pinned.as_str()));
}

#[tokio::test]
async fn a_pull_request_is_refused_when_the_local_branch_or_commit_moved() {
    let (d, remote) = with_remote("pr-stale-local");
    push(&d, Some(head(&d))).await.unwrap();
    let shown = head(&d);
    let pr = |branch: &str, h: &str| Request::PrCreate {
        repo: d.s(),
        branch: branch.into(),
        remote: "origin".into(),
        github_repo: "acme/widgets".into(),
        remote_branch: "feature".into(),
        base: "main".into(),
        title: "Feature".into(),
        body: String::new(),
        draft: false,
        expect: HeadExpect { head: Some(h.into()) },
    };
    // An agent committed here after the form was read.
    write(d.path(), "notes.txt", b"an agent's later work\n");
    git(d.path(), &["commit", "-qam", "Later"]);
    assert_eq!(kind(ask(pr("feature", &shown)).await.unwrap_err()), "stale");
    // Or switched to another branch at the commit shown.
    git(d.path(), &["switch", "-qc", "other", &shown]);
    assert_eq!(kind(ask(pr("feature", &shown)).await.unwrap_err()), "stale");
    assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/feature"]), shown, "nothing was pushed");
}

// ── Codex review round 2 (consolidation for #66) ────────────────────────────

#[tokio::test]
async fn a_push_is_refused_when_the_remote_now_points_somewhere_else() {
    // The confirmation showed origin's URL; then origin was pointed at another repository.
    let (d, first) = with_remote("push-url-moved");
    let shown = shown_url(&d, "origin");
    let second = Dir::new("push-url-moved-other");
    git(second.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(d.path(), &["remote", "set-url", "origin", &second.s()]);
    let e = ask(Request::Push {
        repo: d.s(),
        remote: "origin".into(),
        push_url: shown,
        branch: "feature".into(),
        remote_branch: "feature".into(),
        expect: HeadExpect { head: Some(head(&d)) },
    })
    .await
    .unwrap_err();
    assert_eq!(kind(e), "stale");
    assert_eq!(git(first.path(), &["branch", "--list", "feature"]), "");
    assert_eq!(git(second.path(), &["branch", "--list", "feature"]), "", "nothing went to the new URL");
}

#[tokio::test]
async fn a_pull_request_is_refused_when_the_remote_now_names_another_github_repository() {
    let (d, _remote) = with_remote("pr-repo-moved");
    git(d.path(), &["remote", "set-url", "origin", "https://github.com/acme/other.git"]);
    let e = ask(Request::PrCreate {
        repo: d.s(),
        branch: "feature".into(),
        remote: "origin".into(),
        github_repo: "acme/widgets".into(),
        remote_branch: "feature".into(),
        base: "main".into(),
        title: "Feature".into(),
        body: String::new(),
        draft: false,
        expect: HeadExpect { head: Some(head(&d)) },
    })
    .await
    .unwrap_err();
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["kind"], "stale", "{v}");
    assert!(v["message"].as_str().unwrap().contains("acme/other"), "{v}");
}

#[tokio::test]
async fn push_recurse_submodules_config_neither_replaces_nor_adds_to_the_push() {
    let (d, remote) = with_remote("push-recurse");
    git(d.path(), &["config", "push.recurseSubmodules", "only"]);
    let r = push(&d, Some(head(&d))).await.unwrap();
    assert_eq!(r["matches"], true, "{r}");
    assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/feature"]), head(&d), "the confirmed branch itself was pushed");
}

/// A repository whose origin is written as a GitHub URL and rewritten to its local bare remote for Git.
fn github_written(name: &str) -> (Dir, Dir) {
    let (d, remote) = with_remote(name);
    git(d.path(), &["remote", "set-url", "origin", "https://github.com/acme/widgets.git"]);
    git(d.path(), &["config", &format!("url.{}.insteadOf", remote.s()), "https://github.com/acme/widgets.git"]);
    (d, remote)
}

#[tokio::test]
async fn publish_info_still_offers_push_when_gh_is_missing() {
    let (d, _remote) = github_written("publish-no-gh");
    // A PATH with sh, python3 and git, and no gh.
    let bin = Dir::new("publish-no-gh-bin");
    for tool in ["sh", "python3", "git"] {
        let found = std::process::Command::new("sh").arg("-c").arg(format!("command -v {tool}")).output().unwrap();
        std::os::unix::fs::symlink(String::from_utf8(found.stdout).unwrap().trim(), bin.path().join(tool)).unwrap();
    }
    let mut c = helper();
    c.env("PATH", bin.s());
    let p = repo_git::run(c, &Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["remote"], "origin", "{p}");
    assert_eq!(p["ahead"], 1);
    assert_eq!(p["commits"][0]["subject"], "Feature work");
    assert_eq!(p["github"]["repo"], "acme/widgets");
    assert!(p["github"]["error"].as_str().unwrap().contains("gh"), "the failure goes to the pull request card: {p}");
}

#[tokio::test]
async fn publish_info_still_offers_push_when_gh_is_too_slow() {
    let (d, _remote) = github_written("publish-slow-gh");
    let bin = Dir::new("publish-slow-gh-bin");
    let gh = bin.path().join("gh");
    write_executable(&gh, "#!/bin/sh\nsleep 5\n");
    let mut c = helper();
    c.env("PATH", format!("{}:{}", bin.s(), std::env::var("PATH").unwrap())).env("HERMES_REPO_GH_TIMEOUT", "1");
    let p = repo_git::run(c, &Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["ahead"], 1, "{p}");
    assert!(p["github"]["error"].as_str().unwrap().contains("longer than"), "{p}");
}

// ── #475: a tag named like the branch ───────────────────────────────────────

#[tokio::test]
async fn a_tag_named_like_the_branch_never_changes_which_branch_is_pushed() {
    let (d, remote) = github_written("tag-like-branch");
    git(d.path(), &["tag", "feature"]);
    // What `--short` trips on: with the tag there, the branch's short name is ambiguous.
    assert_eq!(git(d.path(), &["symbolic-ref", "--short", "HEAD"]), "heads/feature");
    // A local branch named like a remote one makes `%(refname:short)` ambiguous for the bases too.
    git(d.path(), &["branch", "origin/main", "main"]);
    // A stand-in gh that writes down what it was asked.
    let bin = Dir::new("tag-like-branch-bin");
    let asked = bin.path().join("asked");
    write_executable(
        &bin.path().join("gh"),
        &format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\ncase \"$1 $2\" in\n  'repo view') echo '{{\"nameWithOwner\":\"acme/widgets\",\"url\":\"https://github.com/acme/widgets\",\"defaultBranchRef\":{{\"name\":\"main\"}}}}';;\n  'pr list') echo '[]';;\n  'pr create') cat >/dev/null; echo 'https://github.com/acme/widgets/pull/7';;\n  'pr view') echo '{{\"number\":7,\"url\":\"https://github.com/acme/widgets/pull/7\"}}';;\nesac\n",
            asked.display()
        ),
    );
    let with_gh = |req: Request| {
        let mut c = helper();
        c.env("PATH", format!("{}:{}", bin.s(), std::env::var("PATH").unwrap()));
        async move { repo_git::run(c, &req).await }
    };

    let p = with_gh(Request::PublishInfo { repo: d.s() }).await.unwrap();
    assert_eq!(p["branch"], "feature", "{p}");
    assert_eq!(p["remoteBranch"], "feature", "{p}");
    assert_eq!(p["bases"], serde_json::json!(["main"]), "{p}");
    let branch = p["branch"].as_str().unwrap().to_owned();
    let remote_branch = p["remoteBranch"].as_str().unwrap().to_owned();

    // Push sends the branch, named in full on the remote, and sets the branch's own upstream.
    let h = head(&d);
    ask(Request::Push {
        repo: d.s(),
        remote: "origin".into(),
        push_url: shown_url(&d, "origin"),
        branch: branch.clone(),
        remote_branch: remote_branch.clone(),
        expect: HeadExpect { head: Some(h.clone()) },
    })
    .await
    .unwrap();
    assert_eq!(git(remote.path(), &["rev-parse", "refs/heads/feature"]), h);
    assert_eq!(git(remote.path(), &["for-each-ref", "--format=%(refname)", "refs/heads/heads"]), "", "no stray remote branch heads/feature");
    assert_eq!(git(d.path(), &["config", "--get", "branch.feature.merge"]), "refs/heads/feature");
    assert!(git(d.path(), &["config", "--list"]).lines().all(|l| !l.starts_with("branch.heads/")), "no upstream config for heads/feature");

    // The pull request opens from the branch itself.
    let r = with_gh(Request::PrCreate {
        repo: d.s(),
        branch: branch.clone(),
        remote: "origin".into(),
        github_repo: "acme/widgets".into(),
        remote_branch,
        base: "main".into(),
        title: "Feature".into(),
        body: String::new(),
        draft: false,
        expect: HeadExpect { head: Some(h) },
    })
    .await
    .unwrap();
    assert_eq!(r["pr"]["number"], 7, "{r}");
    let asked = std::fs::read_to_string(&asked).unwrap();
    assert!(asked.lines().any(|l| l.starts_with("pr create") && l.contains("--head feature ")), "{asked}");
    assert!(!asked.contains("heads/feature"), "{asked}");

    // The commit preview and the commit name it too.
    write(d.path(), "notes.txt", b"more\n");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    assert_eq!(p["branch"], "feature");
    assert_eq!(commit(&d, &p, "More").await.unwrap()["branch"], "feature");
}

// ── #482: a dropped connection ends the helper ──────────────────────────────

/// The helper as sshd leaves it when the connection drops. sshd runs it without a terminal, so no hangup comes, and
/// nobody kills it: only its pipes close. This stand-in for sshd starts the helper in the background on the same
/// stdin, writes its pid to `pidfile`, and is itself what `run` kills when the request is given up.
fn behind_sshd(pidfile: &Path) -> Command {
    let mut c = Command::new("sh");
    // sh gives a background job /dev/null for stdin unless it's given another: fd 3 keeps the real one.
    c.arg("-c").arg(r#"exec 3<&0; sh -c "$1" <&3 3<&- & echo $! > "$2"; wait"#).arg("sh").arg(repo_git::remote_command()).arg(pidfile);
    c.env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1");
    c
}

/// Whether process `pid` has ended (a zombie nobody has reaped yet counts).
fn ended(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(s) => s.rsplit(')').next().is_some_and(|rest| rest.trim_start().starts_with('Z')),
        Err(_) => (unsafe { libc::kill(pid, 0) }) != 0,
    }
}

async fn pid_in(file: &Path) -> i32 {
    for _ in 0..400 {
        if let Some(pid) = std::fs::read_to_string(file).ok().and_then(|s| s.trim().parse().ok()) {
            return pid;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("nothing wrote {}", file.display());
}

#[tokio::test]
async fn a_dropped_connection_ends_the_helper_and_the_hook_it_was_waiting_on() {
    let d = busy("dropped");
    let hook_pid = d.path().join(".git/hook-pid");
    let helper_pid = d.path().join(".git/helper-pid");
    // A hook that ignores SIGTERM: it ends only with SIGKILL.
    hook(&d, "pre-commit", &format!("trap '' TERM\necho $$ > '{}'\nexec sleep 300", hook_pid.display()));
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let before = head(&d);
    let req = Request::Commit {
        repo: d.s(),
        message: "Never lands".into(),
        expect: Expect { raw_sha: p["rawSha"].as_str().map(Into::into), head_ref: p["headRef"].as_str().map(Into::into), ..expect_of(&p) },
    };
    let command = behind_sshd(&helper_pid);
    let task = tokio::spawn(async move { repo_git::run(command, &req).await });
    let hook = pid_in(&hook_pid).await;
    let helper = pid_in(&helper_pid).await;
    assert!(!ended(helper) && !ended(hook), "the commit is waiting on its hook");
    // The app gives up (its time limit, or the connection drops): ssh is killed and stdin closes.
    task.abort();
    let _ = task.await;
    for _ in 0..300 {
        if ended(helper) && ended(hook) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(ended(helper), "the helper ended with the connection");
    assert!(ended(hook), "and so did the hook Git was running for it");
    assert_eq!(head(&d), before, "nothing was committed");
    let git_dir = std::fs::read_dir(d.path().join(".git")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect::<Vec<_>>();
    assert!(!git_dir.iter().any(|n| n.starts_with("index.") || n.ends_with(".lock")), "no lock or index copy is left: {git_dir:?}");
    // The checkout works as before.
    let s = status(&d).await;
    ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "other.txt")], expect: expect_of(&s) }).await.unwrap();
}

// ── #483: stale locks, lost answers, odd names, slow Status ─────────────────

#[tokio::test]
async fn a_failure_while_taking_the_index_lets_its_lock_go() {
    let d = busy("enter-fails");
    let s = status(&d).await;
    // The index can't be copied, as on a full disk: here it's a folder.
    let git_dir = d.path().join(".git");
    std::fs::rename(git_dir.join("index"), git_dir.join("index.real")).unwrap();
    std::fs::create_dir(git_dir.join("index")).unwrap();
    assert!(ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.is_err());
    assert!(!git_dir.join("index.lock").exists(), "the lock it took is let go");
    std::fs::remove_dir(git_dir.join("index")).unwrap();
    std::fs::rename(git_dir.join("index.real"), git_dir.join("index")).unwrap();
    ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap();
    assert_eq!(staged_names(&d), "notes.txt");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_name_that_isnt_utf8_is_listed_but_never_staged() {
    use std::os::unix::ffi::OsStrExt;
    let d = repo("latin1");
    std::fs::write(d.path().join(std::ffi::OsStr::from_bytes(b"caf\xe9.txt")), b"x\n").unwrap();
    write(d.path(), "notes.txt", b"changed\n");
    let s = status(&d).await;
    let e = entry(&s, "caf\u{fffd}.txt");
    assert_eq!(e["nameLossy"], true, "{e}");
    assert_eq!(entry(&s, "notes.txt").get("nameLossy"), None);
    // Asked anyway, by the name shown: that names no file, so nothing is staged and the helper says so.
    let err = ask(Request::Stage { repo: d.s(), files: vec![FileStamp { path: "caf\u{fffd}.txt".into(), worktree: None }], expect: expect_of(&s) })
        .await
        .unwrap_err();
    assert_eq!(kind(err), "stale");
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn a_write_through_a_memory_mapping_after_the_list_is_still_caught() {
    // Linux changes no file time for a write to a shared mapping's page that is already dirty, so only the bytes
    // themselves show this change.
    let d = busy("mmap");
    let path = d.path().join("notes.txt");
    let file = std::fs::File::options().read(true).write(true).open(&path).unwrap();
    let len = file.metadata().unwrap().len() as usize;
    use std::os::fd::AsRawFd;
    let map = unsafe { libc::mmap(std::ptr::null_mut(), len, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, file.as_raw_fd(), 0) } as *mut u8;
    assert_ne!(map as *mut libc::c_void, libc::MAP_FAILED);
    unsafe { *map = b'O' };
    // Long after that write, as an editor or agent leaves a file.
    tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
    let s = status(&d).await;
    unsafe { *map = b'Q' };
    let e = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap_err();
    unsafe { libc::munmap(map as *mut libc::c_void, len) };
    assert_eq!(kind(e), "stale");
    assert_eq!(staged_names(&d), "");
}

#[tokio::test]
async fn past_what_one_status_hashes_files_are_stamped_by_metadata_and_still_checked() {
    let d = busy("hash-budget");
    // With a full budget, every file is hashed.
    let s = status(&d).await;
    assert!(!entry(&s, "notes.txt")["worktree"].as_str().unwrap().starts_with("meta:"));
    // With none left, each is stamped by its metadata.
    let no_budget = |req: Request| {
        let mut c = helper();
        c.env("HERMES_REPO_TEST_HASH_BUDGET", "0");
        async move { repo_git::run(c, &req).await }
    };
    let s = no_budget(Request::Status { repo: d.s() }).await.unwrap();
    let notes = entry(&s, "notes.txt")["worktree"].as_str().unwrap().to_owned();
    assert!(notes.starts_with("meta:"), "{notes}");
    // A diff read later carries the same metadata stamp, so the screen can compare them.
    let dd = diff(&d, "notes.txt", None, DiffSide::Unstaged, 3).await;
    assert_eq!(dd["worktreeMeta"].as_str(), Some(notes.as_str()), "{dd}");
    // Rewritten with the same size and its modification time set back: the change time still tells.
    let path = d.path().join("notes.txt");
    let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
    let mut new = std::fs::read(&path).unwrap();
    new[4] = b'X';
    std::fs::write(&path, &new).unwrap();
    std::fs::File::options().write(true).open(&path).unwrap().set_modified(mtime).unwrap();
    let err = ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "notes.txt")], expect: expect_of(&s) }).await.unwrap_err();
    assert_eq!(kind(err), "stale");
    // A file that didn't change stages from its metadata stamp, with the bytes it holds.
    ask(Request::Stage { repo: d.s(), files: vec![stamp_of(&s, "other.txt")], expect: expect_of(&s) }).await.unwrap();
    assert_eq!(git(d.path(), &["show", ":other.txt"]), "b");
}

#[tokio::test]
async fn a_hook_that_ignores_sigterm_ends_when_the_commit_times_out() {
    let d = busy("stubborn-hook");
    let hook_pid = d.path().join(".git/hook-pid");
    hook(&d, "pre-commit", &format!("trap '' TERM\necho $$ > '{}'\nexec sleep 300", hook_pid.display()));
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let mut c = helper();
    c.env("HERMES_REPO_TEST_COMMIT_TIMEOUT", "2");
    let expect = Expect { raw_sha: p["rawSha"].as_str().map(Into::into), head_ref: p["headRef"].as_str().map(Into::into), ..expect_of(&p) };
    let e = repo_git::run(c, &Request::Commit { repo: d.s(), message: "Slow".into(), expect }).await.unwrap_err();
    assert_eq!(kind(e), "timeout");
    let hook = pid_in(&hook_pid).await;
    assert!(ended(hook), "the hook doesn't outlive the helper's answer");
    assert!(!d.path().join(".git/index.lock").exists());
}

#[tokio::test]
async fn a_commit_git_made_is_reported_as_made_even_if_git_then_failed() {
    let d = busy("exit-after-commit");
    // A git that makes the commit, then exits 1, as when it can't write the new index afterwards.
    let bin = Dir::new("exit-after-commit-bin");
    let real = String::from_utf8(StdCommand::new("sh").arg("-c").arg("command -v git").output().unwrap().stdout).unwrap();
    write_executable(&bin.path().join("git"), &format!("#!/bin/sh\n'{}' \"$@\"; s=$?\nfor a; do [ \"$a\" = commit ] && exit 1; done\nexit $s\n", real.trim()));
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let before = head(&d);
    let mut c = helper();
    c.env("PATH", format!("{}:{}", bin.s(), std::env::var("PATH").unwrap()));
    let expect = Expect { raw_sha: p["rawSha"].as_str().map(Into::into), head_ref: p["headRef"].as_str().map(Into::into), ..expect_of(&p) };
    let r = repo_git::run(c, &Request::Commit { repo: d.s(), message: "Made".into(), expect }).await.unwrap();
    assert_ne!(head(&d), before);
    assert_eq!(r["head"], Value::String(head(&d)));
    assert_eq!(r["exitCode"], 1);
}

#[tokio::test]
async fn a_hook_that_prints_a_lot_is_cut_to_its_end() {
    let d = busy("loud-hook");
    hook(&d, "pre-commit", "head -c 2000000 /dev/zero | tr '\\000' a\necho\necho 'the reason is at the end'\nexit 1");
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let e = serde_json::to_value(commit(&d, &p, "Loud").await.unwrap_err()).unwrap();
    assert_eq!(e["kind"], "hook", "{}", e["message"]);
    let out = e["output"].as_str().unwrap();
    assert!(out.len() < 300 * 1024, "{} bytes", out.len());
    assert!(out.starts_with("[The first ") && out.trim_end().ends_with("the reason is at the end"));
}

#[tokio::test]
async fn the_remote_is_asked_for_the_branch_itself_not_a_ref_ending_like_it() {
    let (d, remote) = with_remote("ls-remote-exact");
    // A branch on the remote whose name ends like refs/heads/feature: ls-remote's pattern matches it too.
    git(remote.path(), &["branch", "nested/refs/heads/feature", "main"]);
    let h = ask(Request::RemoteHead { repo: d.s(), remote: "origin".into(), remote_branch: "feature".into() }).await.unwrap();
    assert_eq!(h["remoteHead"], Value::Null, "{h}");
}

#[tokio::test]
async fn a_stop_while_git_is_starting_still_stops_it() {
    // The connection drops just as the helper starts Git: Git is running, but Popen hasn't handed the helper its
    // handle yet. The stop waits until it has, so Git is stopped, not left to finish the commit on its own.
    let d = busy("stop-at-spawn");
    let marker = d.path().join(".git/hook-ran");
    hook(&d, "pre-commit", &format!("trap '' TERM\nsleep 1\ntouch '{}'", marker.display()));
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let before = head(&d);
    let mut c = helper();
    c.env("HERMES_REPO_TEST_STOP_AT", "commit");
    let expect = Expect { raw_sha: p["rawSha"].as_str().map(Into::into), head_ref: p["headRef"].as_str().map(Into::into), ..expect_of(&p) };
    let e = repo_git::run(c, &Request::Commit { repo: d.s(), message: "Never".into(), expect }).await.unwrap_err();
    assert_eq!(kind(e), "bad-reply", "it was stopped before it answered");
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    assert!(!marker.exists(), "Git didn't go on to run its hook");
    assert_eq!(head(&d), before, "nor commit");
    let git_dir = std::fs::read_dir(d.path().join(".git")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect::<Vec<_>>();
    assert!(!git_dir.iter().any(|n| n.starts_with("index.") || n.ends_with(".lock")), "no lock or index copy is left: {git_dir:?}");
}

#[tokio::test]
async fn a_drop_while_a_stubborn_command_is_being_stopped_still_ends_it() {
    // A commit hits its time limit, and the helper starts stopping Git: SIGTERM, then up to 5 s before SIGKILL. The
    // connection drops during those 5 s. That stop must not cut the first one short: this Git ignores SIGTERM, so only
    // the SIGKILL at the end ends it.
    let d = busy("drop-during-grace");
    let bin = Dir::new("drop-during-grace-bin");
    let git_pid = bin.path().join("git-pid");
    let real = String::from_utf8(StdCommand::new("sh").arg("-c").arg("command -v git").output().unwrap().stdout).unwrap();
    write_executable(
        &bin.path().join("git"),
        &format!(
            "#!/bin/sh\nfor a; do [ \"$a\" = commit ] && {{ trap '' TERM; echo $$ > '{}'; exec sleep 300; }}; done\nexec '{}' \"$@\"\n",
            git_pid.display(),
            real.trim()
        ),
    );
    git(d.path(), &["add", "notes.txt"]);
    let p = preview(&d).await;
    let helper_pid = bin.path().join("helper-pid");
    let mut command = behind_sshd(&helper_pid);
    command.env("PATH", format!("{}:{}", bin.s(), std::env::var("PATH").unwrap())).env("HERMES_REPO_TEST_COMMIT_TIMEOUT", "1");
    let req = Request::Commit {
        repo: d.s(),
        message: "Stuck".into(),
        expect: Expect { raw_sha: p["rawSha"].as_str().map(Into::into), head_ref: p["headRef"].as_str().map(Into::into), ..expect_of(&p) },
    };
    let task = tokio::spawn(async move { repo_git::run(command, &req).await });
    let stuck = pid_in(&git_pid).await;
    let helper = pid_in(&helper_pid).await;
    // Past the 1 s time limit, and inside the 5 s grace that follows.
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    assert!(!ended(stuck) && !ended(helper), "the helper is still waiting out the grace");
    task.abort();
    let _ = task.await;
    for _ in 0..300 {
        if ended(stuck) && ended(helper) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(ended(stuck), "the Git that ignored SIGTERM was ended");
    assert!(ended(helper), "and the helper with it");
    assert!(!d.path().join(".git/index.lock").exists());
}
