#![cfg(unix)]
//! Worktrees on the server (ADR 0043): the helper's worktree operations, run as the server runs them (the exact remote
//! command string through `sh -c`), against real Git repositories in a temporary folder. Only ssh itself is left out.

mod common;

use common::write_executable;
use hermes_chat::repo_git::{self, RepoError, Request};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::process::Command;

struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("hc-wt-{name}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        Dir(p.canonicalize().unwrap())
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn join(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = StdCommand::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ALLOW_PROTOCOL", "file")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn write(dir: &Path, name: &str, body: &str) {
    let p = dir.join(name);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(p, body).unwrap();
}

fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap()
}

/// A folder holding `app`, a repository with one commit on `main`; its worktrees go beside it.
fn repo(name: &str) -> (Dir, PathBuf) {
    let d = Dir::new(name);
    let app = d.path().join("app");
    std::fs::create_dir_all(&app).unwrap();
    git(&app, &["init", "-q", "-b", "main"]);
    git(&app, &["config", "user.email", "owner@example.com"]);
    git(&app, &["config", "user.name", "Owner"]);
    write(&app, "README.md", "hello\n");
    write(&app, ".gitignore", ".env\nnode_modules/\n");
    git(&app, &["add", "."]);
    git(&app, &["commit", "-qm", "first"]);
    (d, app)
}

fn helper(env: &[(&str, &str)]) -> Command {
    let mut c = Command::new("sh");
    c.arg("-c").arg(repo_git::remote_command());
    c.env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_ALLOW_PROTOCOL", "file");
    for (k, v) in env {
        c.env(k, v);
    }
    c
}

async fn ask(req: Request) -> Result<Value, RepoError> {
    repo_git::run(helper(&[]), &req).await
}

fn kind(e: RepoError) -> String {
    serde_json::to_value(e).unwrap()["kind"].as_str().unwrap().to_owned()
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

async fn plan(app: &Path, base: &str, branch: &str, new: bool, path: &str, setup: bool) -> Result<Value, RepoError> {
    ask(Request::WorktreePlan { repo: s(app), base: base.into(), branch: branch.into(), new_branch: new, path: path.into(), setup }).await
}

fn create_req(app: &Path, id: &str, p: &Value, setup: bool) -> Request {
    Request::WorktreeCreate {
        repo: s(app),
        id: id.into(),
        base: p["base"].as_str().unwrap().into(),
        branch: p["branch"].as_str().unwrap().into(),
        new_branch: p["newBranch"].as_bool().unwrap(),
        path: p["path"].as_str().unwrap().into(),
        setup,
        expect: p["stamp"].as_str().unwrap().into(),
    }
}

/// Plans and creates a worktree on a new branch from `main`, at the suggested path.
async fn create(app: &Path, id: &str, branch: &str, setup: bool) -> Value {
    let p = plan(app, "main", branch, true, "", setup).await.unwrap();
    ask(create_req(app, id, &p, setup)).await.unwrap()
}

async fn list(app: &Path) -> Value {
    ask(Request::WorktreeList { repo: s(app) }).await.unwrap()
}

fn tree<'a>(l: &'a Value, path: &str) -> &'a Value {
    l["worktrees"].as_array().unwrap().iter().find(|t| t["path"] == path).unwrap_or_else(|| panic!("no {path} in {l}"))
}

async fn remove_plan(app: &Path, id: &str) -> Value {
    ask(Request::WorktreeRemovePlan { repo: s(app), id: id.into() }).await.unwrap()
}

async fn remove(app: &Path, id: &str, stamp: &Value) -> Result<Value, RepoError> {
    ask(Request::WorktreeRemove { repo: s(app), id: id.into(), expect: stamp.as_str().unwrap().into() }).await
}

fn blockers(p: &Value) -> Vec<String> {
    p["blockers"].as_array().unwrap().iter().map(|b| b["kind"].as_str().unwrap().to_owned()).collect()
}

const ID: &str = "0123456789abcdef";
const ID2: &str = "fedcba9876543210";
const TOKEN: &str = "aaaaaaaabbbbbbbb";

#[tokio::test]
async fn a_new_branch_worktree_is_made_beside_the_repository_from_the_base_shown() {
    let (d, app) = repo("new");
    let base = git(&app, &["rev-parse", "HEAD"]);
    let p = plan(&app, "main", "feature/login", true, "", false).await.unwrap();
    // The path preview: beside the repository, never inside it or its .worktrees (Hermes's own clean-up's folder).
    assert_eq!(p["path"], d.join("app-feature-login"));
    assert_eq!(p["suggested"], true);
    assert_eq!(p["baseOid"], base.as_str());
    assert_eq!(p["baseRef"], "refs/heads/main");
    assert_eq!(p["setupCommands"], "unsupported");

    let lines = Arc::new(Mutex::new(Vec::<Value>::new()));
    let seen = lines.clone();
    let made = repo_git::run_streaming(helper(&[]), &create_req(&app, ID, &p, false), &move |v| seen.lock().unwrap().push(v)).await.unwrap();
    assert_eq!(made["worktree"]["state"], "ready");
    assert!(lines.lock().unwrap().iter().any(|l| l["step"] == "create"), "progress came as it went");

    let wt = d.path().join("app-feature-login");
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), base);
    assert_eq!(git(&wt, &["branch", "--show-current"]), "feature/login");
    // Not tracking anything: a new branch starts on its own.
    assert!(StdCommand::new("git").args(["config", "branch.feature/login.merge"]).current_dir(&app).output().unwrap().stdout.is_empty());

    let l = list(&app).await;
    let t = tree(&l, &d.join("app-feature-login"));
    assert_eq!(t["managed"]["id"], ID);
    assert_eq!(t["locked"], format!("hermes-chat: managed worktree {ID}"));
    assert_eq!(t["dirty"]["untracked"], 0);
    assert_eq!(t["protected"].as_array().unwrap().len(), 0);
    let main = tree(&l, &s(&app));
    assert_eq!(main["main"], true);
    assert_eq!(main["protected"][0]["kind"], "main");
    // The record is in the repository, where every desktop sees it.
    assert!(app.join(".git/hermes-chat/managed-worktrees.json").is_file());
}

#[tokio::test]
async fn an_existing_branch_is_checked_out_only_once_and_new_names_must_be_new() {
    let (d, app) = repo("existing");
    git(&app, &["branch", "release"]);
    git(&app, &["branch", "taken"]);
    let p = plan(&app, "", "release", false, "", false).await.unwrap();
    assert_eq!(p["baseRef"], "refs/heads/release");
    ask(create_req(&app, ID, &p, false)).await.unwrap();
    assert_eq!(git(&d.path().join("app-release"), &["branch", "--show-current"]), "release");

    // The same branch again: Git allows it in one worktree at a time.
    assert_eq!(kind(plan(&app, "", "release", false, "", false).await.unwrap_err()), "checked-out");
    // A new branch with a name that exists.
    assert_eq!(kind(plan(&app, "main", "taken", true, "", false).await.unwrap_err()), "branch-exists");
    assert_eq!(kind(plan(&app, "", "nope", false, "", false).await.unwrap_err()), "not-found");
    // Names Hermes's own clean-up deletes when no worktree has them.
    assert_eq!(kind(plan(&app, "main", "hermes/hermes-abc", true, "", false).await.unwrap_err()), "bad-branch");
    assert_eq!(kind(plan(&app, "main", "pr-12", true, "", false).await.unwrap_err()), "bad-branch");
    assert_eq!(kind(plan(&app, "main", "-x", true, "", false).await.unwrap_err()), "bad-branch");
    assert_eq!(kind(plan(&app, "main", "a..b", true, "", false).await.unwrap_err()), "bad-branch");
    assert_eq!(kind(plan(&app, "--upload-pack=x", "b", true, "", false).await.unwrap_err()), "bad-ref");
    assert_eq!(kind(plan(&app, "origin/main", "b", true, "", false).await.unwrap_err()), "bad-ref");
}

#[tokio::test]
async fn paths_are_checked_before_anything_is_made() {
    let (d, app) = repo("paths");
    std::fs::create_dir_all(d.path().join("taken")).unwrap();
    let bad = |p: &str| {
        let p = p.to_owned();
        let app = app.clone();
        async move { plan(&app, "main", "x", true, &p, false).await }
    };
    assert_eq!(kind(bad(&s(&app.join("sub"))).await.unwrap_err()), "bad-path", "inside the main checkout");
    assert_eq!(kind(bad(&s(&app.join(".worktrees/x"))).await.unwrap_err()), "bad-path", "Hermes's clean-up folder");
    assert_eq!(kind(bad(&d.join("taken")).await.unwrap_err()), "exists");
    assert_eq!(kind(bad("relative/x").await.unwrap_err()), "bad-path");
    assert_eq!(kind(bad(&format!("{}/../x", d.join("a"))).await.unwrap_err()), "bad-path");
    assert_eq!(kind(bad(&d.join("no/such/parent")).await.unwrap_err()), "not-found");
    std::fs::create_dir_all(d.path().join("trees")).unwrap();
    let p = bad(&format!("{}//trees//one/", s(d.path()))).await.unwrap();
    assert_eq!(p["path"], d.join("trees/one"), "the path is tidied");
}

#[tokio::test]
async fn a_dirty_source_checkout_stays_where_it_is_and_setup_copies_only_what_worktreeinclude_names() {
    let (d, app) = repo("dirty-source");
    write(&app, ".worktreeinclude", ".env\nnode_modules\nREADME.md\nmissing.txt\n../escape\n");
    git(&app, &["add", ".worktreeinclude"]);
    git(&app, &["commit", "-qm", "include"]);
    write(&app, ".env", "SECRET=1\n");
    write(&app, "node_modules/pkg/index.js", "x\n");
    // The source checkout's own unrelated changes.
    write(&app, "README.md", "hello\nchanged in the source\n");
    write(&app, "scratch.txt", "mine\n");

    let p = plan(&app, "main", "feature/env", true, "", true).await.unwrap();
    assert_eq!(p["sourceDirty"]["unstaged"], 1);
    assert_eq!(p["sourceDirty"]["untracked"], 1);
    let actions: Vec<(String, String)> =
        p["setup"].as_array().unwrap().iter().map(|e| (e["entry"].as_str().unwrap().into(), e["action"].as_str().unwrap().into())).collect();
    assert_eq!(
        actions,
        [(".env", "copy"), ("node_modules", "link"), ("README.md", "skip"), ("missing.txt", "skip"), ("../escape", "skip")]
            .map(|(a, b)| (a.to_string(), b.to_string()))
    );

    let made = ask(create_req(&app, ID, &p, true)).await.unwrap();
    assert_eq!(made["worktree"]["state"], "ready");
    assert_eq!(made["worktree"]["setup"]["state"], "done");
    let wt = d.path().join("app-feature-env");
    assert_eq!(read(&wt, ".env"), "SECRET=1\n");
    assert!(std::fs::symlink_metadata(wt.join("node_modules")).unwrap().file_type().is_symlink());
    // The tracked file comes from the base commit, not the source checkout's edit, and the untracked file stays put.
    assert_eq!(read(&wt, "README.md"), "hello\n");
    assert!(!wt.join("scratch.txt").exists());
    assert_eq!(read(&app, "README.md"), "hello\nchanged in the source\n");
    // Setup's own link isn't counted as a change of the owner's.
    let l = list(&app).await;
    assert_eq!(tree(&l, &s(&wt))["dirty"]["untracked"], 0);
}

#[tokio::test]
async fn failed_setup_keeps_the_worktree_and_retry_finishes_it() {
    let (d, app) = repo("setup-fail");
    // `data` is a tracked file in the worktree, so `data/seed.db` can't be put there.
    write(&app, "data", "a file\n");
    write(&app, ".worktreeinclude", "data/seed.db\n");
    git(&app, &["add", "."]);
    git(&app, &["commit", "-qm", "data"]);
    std::fs::remove_file(app.join("data")).unwrap();
    write(&app, "data/seed.db", "rows\n");

    let p = plan(&app, "main", "feature/seed", true, "", true).await.unwrap();
    let made = ask(create_req(&app, ID, &p, true)).await.unwrap();
    assert_eq!(made["worktree"]["state"], "setup-failed");
    assert_eq!(made["worktree"]["setup"]["entries"][0]["result"], "failed");
    assert!(made["worktree"]["setup"]["log"].as_str().unwrap().contains("Failed data/seed.db"));
    let wt = d.path().join("app-feature-seed");
    assert!(wt.is_dir(), "the worktree stays, to retry or open");

    // A chat can still start there (Open), and the failure stays listed.
    ask(Request::WorktreeAttach { repo: s(&app), id: ID.into(), token: TOKEN.into(), profile: "default".into(), connection: "c".into() }).await.unwrap();
    ask(Request::WorktreeDetach { repo: s(&app), id: ID.into(), token: TOKEN.into() }).await.unwrap();

    std::fs::remove_file(wt.join("data")).unwrap();
    let again = ask(Request::WorktreeSetup { repo: s(&app), id: ID.into() }).await.unwrap();
    assert_eq!(again["worktree"]["state"], "ready");
    assert_eq!(read(&wt, "data/seed.db"), "rows\n");
    // Setup runs once: not again after it worked.
    assert_eq!(kind(ask(Request::WorktreeSetup { repo: s(&app), id: ID.into() }).await.unwrap_err()), "not-needed");
}

#[tokio::test]
async fn a_creation_cut_off_part_way_is_found_and_can_be_finished_or_forgotten() {
    let (d, app) = repo("cut-off");
    write(&app, ".worktreeinclude", ".env\n");
    write(&app, ".env", "A=1\n");
    let p = plan(&app, "main", "feature/slow", true, "", true).await.unwrap();

    // The connection drops during setup: the helper is killed, as a dropped ssh does.
    let started = Arc::new(Mutex::new(false));
    let flag = started.clone();
    let req = create_req(&app, ID, &p, true);
    let cut = tokio::time::timeout(
        Duration::from_secs(4),
        repo_git::run_streaming(helper(&[("HERMES_REPO_TEST_SETUP_DELAY", "30")]), &req, &move |l| {
            if l["step"] == "setup" {
                *flag.lock().unwrap() = true;
            }
        }),
    )
    .await;
    assert!(cut.is_err(), "it was cut off");
    assert!(*started.lock().unwrap());
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Reconnected: the list finds it, and says what happened.
    let l = list(&app).await;
    let t = tree(&l, &d.join("app-feature-slow"));
    assert_eq!(t["managed"]["state"], "setup-interrupted");
    assert_eq!(t["managed"]["running"], false);
    // Asking again under the same id doesn't make a second one.
    assert_eq!(kind(ask(req.clone()).await.unwrap_err()), "duplicate");
    let attach = ask(Request::WorktreeAttach { repo: s(&app), id: ID.into(), token: TOKEN.into(), profile: "p".into(), connection: "c".into() }).await;
    assert!(attach.is_ok(), "a chat can still start in a worktree whose setup was cut off");
    ask(Request::WorktreeDetach { repo: s(&app), id: ID.into(), token: TOKEN.into() }).await.unwrap();
    let done = ask(Request::WorktreeSetup { repo: s(&app), id: ID.into() }).await.unwrap();
    assert_eq!(done["worktree"]["state"], "ready");

    // A creation cut off before Git made anything: the record says so, and forgetting it touches nothing on disk.
    let rec = app.join(".git/hermes-chat/managed-worktrees.json");
    let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(&rec).unwrap()).unwrap();
    doc["worktrees"][ID2] = serde_json::json!({
        "id": ID2, "path": d.join("app-never"), "branch": "never", "state": "creating",
        "run": {"pid": 999_999_999u64, "boot": "", "start": 1}, "chats": [], "setup": {"state": "skipped"}
    });
    std::fs::write(&rec, serde_json::to_vec(&doc).unwrap()).unwrap();
    let l = list(&app).await;
    let missing = l["missing"].as_array().unwrap();
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0]["state"], "create-interrupted");
    assert_eq!(missing[0]["exists"], false);
    ask(Request::WorktreeForget { repo: s(&app), id: ID2.into() }).await.unwrap();
    assert_eq!(list(&app).await["missing"].as_array().unwrap().len(), 0);
    // Forgetting a worktree that is there is refused.
    assert_eq!(kind(ask(Request::WorktreeForget { repo: s(&app), id: ID.into() }).await.unwrap_err()), "exists");
}

#[tokio::test]
async fn removal_keeps_dirty_untracked_files_and_unpushed_commits_and_never_deletes_the_branch() {
    let (d, app) = repo("keep");
    create(&app, ID, "feature/work", false).await;
    let wt = d.path().join("app-feature-work");
    write(&wt, "done.txt", "committed\n");
    git(&wt, &["add", "done.txt"]);
    git(&wt, &["-c", "user.name=A", "-c", "user.email=a@x", "commit", "-qm", "unpushed work"]);
    write(&wt, "README.md", "hello\nedited\n");
    write(&wt, "staged.txt", "staged\n");
    git(&wt, &["add", "staged.txt"]);
    write(&wt, "notes/new.txt", "untracked\n");
    write(&wt, ".env", "ignored\n");

    let p = remove_plan(&app, ID).await;
    assert_eq!(blockers(&p), Vec::<String>::new());
    let files: Vec<&str> = p["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(files, ["README.md", "staged.txt", "notes/new.txt"]);
    assert_eq!(p["unpublishedCount"], 2, "no remote has either commit");
    assert_eq!(p["unpublished"][0]["subject"], "unpushed work");
    assert_eq!(p["ignored"], serde_json::json!([".env"]));
    assert_eq!(p["keep"], true);

    // A change after the preview: refused, nothing removed.
    write(&wt, "notes/new.txt", "untracked, edited again\n");
    assert_eq!(kind(remove(&app, ID, &p["stamp"]).await.unwrap_err()), "stale");
    assert!(wt.is_dir());

    let p = remove_plan(&app, ID).await;
    let done = remove(&app, ID, &p["stamp"]).await.unwrap();
    assert!(!wt.exists());
    assert_eq!(done["branch"], "feature/work");
    // The branch and its commit are kept; Git's worktree entry is gone.
    assert_eq!(git(&app, &["log", "-1", "--format=%s", "feature/work"]), "unpushed work");
    assert!(!git(&app, &["worktree", "list"]).contains("app-feature-work"));
    // Every change is in the kept commit, on top of the branch's HEAD.
    let kept = done["kept"]["ref"].as_str().unwrap();
    assert!(kept.starts_with(&format!("refs/hermes-chat/kept/{ID}-")));
    // `staged.txt` was staged: the staged state is a commit of its own between HEAD and the kept files.
    assert_eq!(git(&app, &["rev-parse", &format!("{kept}^^")]), git(&app, &["rev-parse", "feature/work"]));
    assert_eq!(git(&app, &["show", &format!("{kept}^:staged.txt")]), "staged");
    assert_eq!(git(&app, &["show", &format!("{kept}^:README.md")]), "hello", "README.md wasn't staged");
    assert_eq!(git(&app, &["show", &format!("{kept}:README.md")]), "hello\nedited");
    assert_eq!(git(&app, &["show", &format!("{kept}:staged.txt")]), "staged");
    assert_eq!(git(&app, &["show", &format!("{kept}:notes/new.txt")]), "untracked, edited again");
    assert!(git(&app, &["ls-tree", "--name-only", kept]).lines().all(|f| f != ".env"), "ignored files aren't kept");
    // The list offers it back.
    let l = list(&app).await;
    assert_eq!(l["kept"][0]["ref"], kept);
    assert_eq!(l["kept"][0]["branch"], "feature/work");
    let restore = plan(&app, kept, "feature/work-restored", true, "", false).await.unwrap();
    assert_eq!(restore["baseOid"].as_str().unwrap(), git(&app, &["rev-parse", kept]));
}

#[tokio::test]
async fn a_clean_worktree_is_removed_without_force_and_keeps_nothing() {
    let (d, app) = repo("clean");
    create(&app, ID, "feature/clean", false).await;
    let p = remove_plan(&app, ID).await;
    assert_eq!(p["keep"], false);
    let done = remove(&app, ID, &p["stamp"]).await.unwrap();
    assert!(done["kept"].is_null());
    assert!(!d.path().join("app-feature-clean").exists());
    assert_eq!(git(&app, &["branch", "--list", "feature/clean"]), "feature/clean");
    assert!(list(&app).await["kept"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_detached_head_with_commits_no_branch_has_is_kept() {
    let (d, app) = repo("detached");
    create(&app, ID, "feature/d", false).await;
    let wt = d.path().join("app-feature-d");
    git(&wt, &["switch", "-q", "--detach"]);
    write(&wt, "x.txt", "x\n");
    git(&wt, &["add", "x.txt"]);
    git(&wt, &["-c", "user.name=A", "-c", "user.email=a@x", "commit", "-qm", "only here"]);
    let only = git(&wt, &["rev-parse", "HEAD"]);
    let p = remove_plan(&app, ID).await;
    assert_eq!(p["lost"], 1);
    assert_eq!(p["keep"], true);
    let done = remove(&app, ID, &p["stamp"]).await.unwrap();
    assert_eq!(git(&app, &["rev-parse", done["kept"]["ref"].as_str().unwrap()]), only);
}

#[tokio::test]
async fn submodules_with_work_block_removal_and_clean_ones_dont() {
    let (d, app) = repo("submodules");
    let lib = d.path().join("lib");
    std::fs::create_dir_all(&lib).unwrap();
    git(&lib, &["init", "-q", "-b", "main"]);
    write(&lib, "lib.txt", "lib\n");
    git(&lib, &["add", "."]);
    git(&lib, &["-c", "user.name=A", "-c", "user.email=a@x", "commit", "-qm", "lib"]);
    git(&app, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &s(&lib), "vendor/lib"]);
    git(&app, &["commit", "-qm", "submodule"]);

    let p = plan(&app, "main", "feature/sub", true, "", false).await.unwrap();
    assert_eq!(p["submodules"], serde_json::json!(["vendor/lib"]), "the preview names the submodules it won't check out");
    ask(create_req(&app, ID, &p, false)).await.unwrap();
    let wt = d.path().join("app-feature-sub");
    git(&wt, &["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);

    write(&wt, "vendor/lib/lib.txt", "edited inside the submodule\n");
    let p = remove_plan(&app, ID).await;
    assert!(blockers(&p).contains(&"submodule".to_string()), "{p}");
    assert_eq!(kind(remove(&app, ID, &p["stamp"]).await.unwrap_err()), "blocked");
    assert_eq!(read(&wt, "vendor/lib/lib.txt"), "edited inside the submodule\n");

    git(&wt.join("vendor/lib"), &["checkout", "-q", "--", "lib.txt"]);
    let p = remove_plan(&app, ID).await;
    assert_eq!(blockers(&p), Vec::<String>::new(), "{p}");
    assert_eq!(p["submodules"][0]["path"], "vendor/lib");
    remove(&app, ID, &p["stamp"]).await.unwrap();
    assert!(!wt.exists());
}

#[tokio::test]
async fn protected_main_unmanaged_and_foreign_locked_worktrees_cant_be_removed() {
    let (d, app) = repo("protected");
    create(&app, ID, "feature/p", false).await;
    ask(Request::WorktreeProtect { repo: s(&app), id: ID.into(), protected: true }).await.unwrap();
    let p = remove_plan(&app, ID).await;
    assert_eq!(blockers(&p), ["marked"]);
    assert_eq!(kind(remove(&app, ID, &p["stamp"]).await.unwrap_err()), "blocked");
    ask(Request::WorktreeProtect { repo: s(&app), id: ID.into(), protected: false }).await.unwrap();

    // Locked by another tool: its lock isn't this app's to lift.
    let wt = d.join("app-feature-p");
    git(&app, &["worktree", "unlock", &wt]);
    git(&app, &["worktree", "lock", "--reason", "my backup job", &wt]);
    let p = remove_plan(&app, ID).await;
    assert_eq!(blockers(&p), ["locked"]);
    git(&app, &["worktree", "unlock", &wt]);

    // A worktree made by hand is listed, and protected: no record, so no id to remove it by.
    git(&app, &["worktree", "add", "-q", "-b", "byhand", &d.join("byhand")]);
    let l = list(&app).await;
    let by_hand = tree(&l, &d.join("byhand"));
    assert!(by_hand["managed"].is_null());
    assert_eq!(by_hand["protected"][0]["kind"], "unmanaged");
    assert_eq!(kind(ask(Request::WorktreeRemovePlan { repo: s(&app), id: ID2.into() }).await.unwrap_err()), "not-found");
}

#[tokio::test]
async fn an_attached_chat_or_a_process_in_the_folder_blocks_removal_however_quiet() {
    let (d, app) = repo("attached");
    create(&app, ID, "feature/a", false).await;
    let wt = d.path().join("app-feature-a");
    // The chat's place is held before Hermes starts it, then confirmed.
    ask(Request::WorktreeAttach { repo: s(&app), id: ID.into(), token: TOKEN.into(), profile: "work".into(), connection: "ssh liam@hermes".into() })
        .await
        .unwrap();
    let p = remove_plan(&app, ID).await;
    assert_eq!(blockers(&p), ["chats"], "a chat that hasn't started yet counts");
    let confirmed = ask(Request::WorktreeAttachConfirm { repo: s(&app), id: ID.into(), token: TOKEN.into(), chat: "20261104_abc".into() }).await.unwrap();
    assert_eq!(confirmed["chats"][0]["chat"], "20261104_abc");
    assert_eq!(confirmed["chats"][0]["profile"], "work");
    // A stamp read while the chat was attached can't remove it.
    assert_eq!(kind(remove(&app, ID, &p["stamp"]).await.unwrap_err()), "blocked");

    ask(Request::WorktreeDetach { repo: s(&app), id: ID.into(), token: TOKEN.into() }).await.unwrap();
    let mut sleeper = StdCommand::new("sleep").arg("30").current_dir(&wt).spawn().unwrap();
    let p = remove_plan(&app, ID).await;
    assert_eq!(blockers(&p), ["processes"]);
    assert_eq!(p["processes"][0]["name"], "sleep");
    sleeper.kill().unwrap();
    sleeper.wait().unwrap();
    let p = remove_plan(&app, ID).await;
    assert!(remove(&app, ID, &p["stamp"]).await.is_ok());
}

#[tokio::test]
async fn a_second_task_cant_change_the_record_while_another_holds_it() {
    let (_d, app) = repo("concurrent");
    create(&app, ID, "feature/c", false).await;
    let p = remove_plan(&app, ID).await;
    // Another task holds the record's lock (an attach or a removal under way in another copy of the app).
    let lock = app.join(".git/hermes-chat/worktrees.lock");
    let mut holder = StdCommand::new("python3")
        .args(["-c", "import fcntl,os,sys,time;fd=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX);print('held',flush=True);time.sleep(30)"])
        .arg(&lock)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = holder.stdout.take().unwrap();
    let mut buf = [0u8; 4];
    std::io::Read::read_exact(&mut out, &mut buf).unwrap();
    let req = Request::WorktreeRemove { repo: s(&app), id: ID.into(), expect: p["stamp"].as_str().unwrap().into() };
    let busy = repo_git::run(helper(&[("HERMES_REPO_TEST_LOCK_WAIT", "0.5")]), &req).await;
    assert_eq!(kind(busy.unwrap_err()), "busy");
    let attach = Request::WorktreeAttach { repo: s(&app), id: ID.into(), token: TOKEN.into(), profile: "p".into(), connection: "c".into() };
    assert_eq!(kind(repo_git::run(helper(&[("HERMES_REPO_TEST_LOCK_WAIT", "0.5")]), &attach).await.unwrap_err()), "busy");
    holder.kill().unwrap();
    holder.wait().unwrap();

    // Two removals one after the other: the second finds nothing to remove.
    remove(&app, ID, &p["stamp"]).await.unwrap();
    assert_eq!(kind(remove(&app, ID, &p["stamp"]).await.unwrap_err()), "not-found");
}

#[tokio::test]
async fn ids_and_tokens_from_the_webview_are_checked() {
    let (_d, app) = repo("ids");
    let r = ask(Request::WorktreeRemovePlan { repo: s(&app), id: "../../etc".into() }).await;
    assert_eq!(kind(r.unwrap_err()), "internal");
    create(&app, ID, "feature/i", false).await;
    let r = ask(Request::WorktreeAttach { repo: s(&app), id: ID.into(), token: "x".into(), profile: "p".into(), connection: "c".into() }).await;
    assert_eq!(kind(r.unwrap_err()), "internal");
    let r = ask(Request::WorktreeAttach { repo: s(&app), id: ID.into(), token: TOKEN.into(), profile: "p\n".into(), connection: "c".into() }).await;
    assert_eq!(kind(r.unwrap_err()), "internal");
    // A plan's stamp must match: a create for a different plan is refused, and nothing is made.
    let p = plan(&app, "main", "feature/j", true, "", false).await.unwrap();
    let mut req = create_req(&app, ID2, &p, false);
    if let Request::WorktreeCreate { expect, .. } = &mut req {
        *expect = "0".repeat(64);
    }
    assert_eq!(kind(ask(req).await.unwrap_err()), "stale");
    assert!(!Path::new(p["path"].as_str().unwrap()).exists());
}

#[tokio::test]
async fn removal_keeps_what_was_staged_apart_from_the_working_files_and_ignored_files_added_with_force() {
    let (d, app) = repo("staged");
    create(&app, ID, "feature/s", false).await;
    let wt = d.path().join("app-feature-s");
    write(&wt, "README.md", "hello\nstaged version\n");
    git(&wt, &["add", "README.md"]);
    write(&wt, "README.md", "hello\nworking version\n");
    write(&wt, ".env", "SECRET=staged\n");
    git(&wt, &["add", "-f", ".env"]);
    let p = remove_plan(&app, ID).await;
    let done = remove(&app, ID, &p["stamp"]).await.unwrap();
    let kept = done["kept"]["ref"].as_str().unwrap();
    // The kept commit holds the working files; its parent holds what was staged, on top of HEAD.
    assert_eq!(git(&app, &["show", &format!("{kept}:README.md")]), "hello\nworking version");
    assert_eq!(git(&app, &["show", &format!("{kept}^:README.md")]), "hello\nstaged version");
    assert_eq!(git(&app, &["show", &format!("{kept}:.env")]), "SECRET=staged");
    assert_eq!(git(&app, &["show", &format!("{kept}^:.env")]), "SECRET=staged");
    assert_eq!(git(&app, &["rev-parse", &format!("{kept}^^")]), git(&app, &["rev-parse", "feature/s"]));
}

#[tokio::test]
async fn an_ignored_file_or_a_staging_after_the_preview_makes_it_stale() {
    let (d, app) = repo("ignored-late");
    create(&app, ID, "feature/i", false).await;
    let wt = d.path().join("app-feature-i");
    let p = remove_plan(&app, ID).await;
    write(&wt, ".env", "appeared after the preview\n");
    assert_eq!(kind(remove(&app, ID, &p["stamp"]).await.unwrap_err()), "stale");
    assert!(wt.join(".env").is_file());
    let p = remove_plan(&app, ID).await;
    assert_eq!(p["ignored"], serde_json::json!([".env"]));
    git(&wt, &["add", "-f", ".env"]);
    assert_eq!(kind(remove(&app, ID, &p["stamp"]).await.unwrap_err()), "stale", "staging after the preview counts too");
}

#[tokio::test]
async fn two_retries_of_setup_cant_both_run() {
    let (d, app) = repo("retries");
    write(&app, "data", "a file\n");
    write(&app, ".worktreeinclude", "data/seed.db\n");
    git(&app, &["add", "."]);
    git(&app, &["commit", "-qm", "data"]);
    std::fs::remove_file(app.join("data")).unwrap();
    write(&app, "data/seed.db", "rows\n");
    let made = create(&app, ID, "feature/r", true).await;
    assert_eq!(made["worktree"]["state"], "setup-failed");
    std::fs::remove_file(d.path().join("app-feature-r/data")).unwrap();

    let started = Arc::new(Mutex::new(false));
    let flag = started.clone();
    let repo_path = s(&app);
    let first = tokio::spawn(async move {
        let req = Request::WorktreeSetup { repo: repo_path, id: ID.into() };
        // Long enough for the second Retry and the removal plan to run inside it, on a busy machine too.
        repo_git::run_streaming(helper(&[("HERMES_REPO_TEST_SETUP_DELAY", "5")]), &req, &move |l| {
            if l["step"] == "setup" {
                *flag.lock().unwrap() = true;
            }
        })
        .await
    });
    while !*started.lock().unwrap() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(kind(ask(Request::WorktreeSetup { repo: s(&app), id: ID.into() }).await.unwrap_err()), "busy");
    // Nor can it be removed, or a chat start there, while setup runs.
    assert!(blockers(&remove_plan(&app, ID).await).contains(&"busy".to_string()));
    assert_eq!(first.await.unwrap().unwrap()["worktree"]["state"], "ready");
}

#[tokio::test]
async fn an_ignored_setup_link_doesnt_stop_changes_being_kept() {
    let (d, app) = repo("ignored-link");
    // `node_modules` without a slash ignores the link too, so Git doesn't list it at all.
    write(&app, ".gitignore", ".env\nnode_modules\n");
    write(&app, ".worktreeinclude", "node_modules\n");
    git(&app, &["add", "."]);
    git(&app, &["commit", "-qm", "ignore the link"]);
    write(&app, "node_modules/pkg/index.js", "x\n");
    create(&app, ID, "feature/l", true).await;
    let wt = d.path().join("app-feature-l");
    assert!(std::fs::symlink_metadata(wt.join("node_modules")).unwrap().file_type().is_symlink());
    write(&wt, "README.md", "hello\nedited\n");
    let p = remove_plan(&app, ID).await;
    assert_eq!(blockers(&p), Vec::<String>::new());
    let done = remove(&app, ID, &p["stamp"]).await.unwrap();
    let kept = done["kept"]["ref"].as_str().unwrap();
    assert_eq!(git(&app, &["show", &format!("{kept}:README.md")]), "hello\nedited");
    assert!(!git(&app, &["ls-tree", "--name-only", kept]).lines().any(|f| f == "node_modules"));
    // The link was removed, never what it pointed at.
    assert!(app.join("node_modules/pkg/index.js").is_file());
}

#[tokio::test]
async fn a_failing_post_checkout_hook_leaves_the_worktree_recorded_with_retry() {
    let (d, app) = repo("hook");
    let hook = app.join(".git/hooks/post-checkout");
    write_executable(&hook, "#!/bin/sh\necho 'post-checkout: npm ci failed' >&2\nexit 1\n");
    let made = create(&app, ID, "feature/h", false).await;
    assert_eq!(made["worktree"]["state"], "setup-failed");
    assert!(made["worktree"]["setup"]["log"].as_str().unwrap().contains("npm ci failed"));
    let wt = d.join("app-feature-h");
    let l = list(&app).await;
    let t = tree(&l, &wt);
    assert_eq!(t["managed"]["id"], ID, "still this app's, so it can be retried or removed");
    assert_eq!(t["locked"], format!("hermes-chat: managed worktree {ID}"));
    std::fs::remove_file(&hook).unwrap();
    assert_eq!(ask(Request::WorktreeSetup { repo: s(&app), id: ID.into() }).await.unwrap()["worktree"]["state"], "ready");
}

#[tokio::test]
async fn two_creations_for_the_same_folder_cant_both_be_recorded() {
    let (_d, app) = repo("same-path");
    let p = plan(&app, "main", "feature/twice", true, "", false).await.unwrap();
    let (a, b) = tokio::join!(ask(create_req(&app, ID, &p, false)), ask(create_req(&app, ID2, &p, false)));
    assert_eq!([a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count(), 1, "{a:?} {b:?}");
    let refused = if a.is_ok() { b } else { a };
    assert!(["exists", "busy", "stale", "branch-exists"].contains(&kind(refused.unwrap_err()).as_str()));
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(app.join(".git/hermes-chat/managed-worktrees.json")).unwrap()).unwrap();
    assert_eq!(doc["worktrees"].as_object().unwrap().len(), 1);
}

#[tokio::test]
async fn edits_an_index_flag_hides_are_listed_and_kept() {
    let (d, app) = repo("hidden");
    create(&app, ID, "feature/hid", false).await;
    let wt = d.path().join("app-feature-hid");
    git(&wt, &["update-index", "--assume-unchanged", "README.md"]);
    write(&wt, "README.md", "hello\nhidden edit\n");
    write(&wt, "other.txt", "an ordinary new file\n");
    let p = remove_plan(&app, ID).await;
    assert_eq!(p["hidden"], serde_json::json!(["README.md"]));
    let done = remove(&app, ID, &p["stamp"]).await.unwrap();
    let kept = done["kept"]["ref"].as_str().unwrap();
    assert_eq!(git(&app, &["show", &format!("{kept}:README.md")]), "hello\nhidden edit");
    assert_eq!(git(&app, &["show", &format!("{kept}:other.txt")]), "an ordinary new file");
}

#[tokio::test]
async fn a_submodule_branch_no_remote_has_blocks_removal_even_with_head_published() {
    let (d, app) = repo("sub-branch");
    let lib = d.path().join("lib");
    std::fs::create_dir_all(&lib).unwrap();
    git(&lib, &["init", "-q", "-b", "main"]);
    write(&lib, "lib.txt", "lib\n");
    git(&lib, &["add", "."]);
    git(&lib, &["-c", "user.name=A", "-c", "user.email=a@x", "commit", "-qm", "lib"]);
    git(&app, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &s(&lib), "vendor/lib"]);
    git(&app, &["commit", "-qm", "submodule"]);
    create(&app, ID, "feature/sb", false).await;
    let wt = d.path().join("app-feature-sb");
    git(&wt, &["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);
    let sub = wt.join("vendor/lib");
    git(&sub, &["switch", "-q", "-c", "private"]);
    write(&sub, "private.txt", "only here\n");
    git(&sub, &["add", "."]);
    git(&sub, &["-c", "user.name=A", "-c", "user.email=a@x", "commit", "-qm", "private work"]);
    git(&sub, &["switch", "-q", "--detach", "origin/main"]);
    let p = remove_plan(&app, ID).await;
    assert!(blockers(&p).contains(&"submodule".to_string()), "{p}");
}

#[tokio::test]
async fn an_edit_deep_in_an_ignored_folder_after_the_preview_makes_it_stale() {
    let (d, app) = repo("ignored-deep");
    create(&app, ID, "feature/deep", false).await;
    let wt = d.path().join("app-feature-deep");
    write(&wt, "node_modules/pkg/lib/index.js", "one\n");
    let p = remove_plan(&app, ID).await;
    std::thread::sleep(Duration::from_millis(20));
    write(&wt, "node_modules/pkg/lib/index.js", "two, longer\n");
    assert_eq!(kind(remove(&app, ID, &p["stamp"]).await.unwrap_err()), "stale", "an edited file");
    let p = remove_plan(&app, ID).await;
    write(&wt, "node_modules/pkg/lib/new.js", "new\n");
    assert_eq!(kind(remove(&app, ID, &p["stamp"]).await.unwrap_err()), "stale", "a new file in a nested folder");
}

#[tokio::test]
async fn a_removal_that_fails_leaves_a_failed_setup_failed() {
    let (d, app) = repo("remove-fails");
    write(&app, "data", "a file\n");
    write(&app, ".worktreeinclude", "data/seed.db\n");
    write(&app, "locked/inside.txt", "x\n");
    git(&app, &["add", "."]);
    git(&app, &["commit", "-qm", "data"]);
    std::fs::remove_file(app.join("data")).unwrap();
    write(&app, "data/seed.db", "rows\n");
    assert_eq!(create(&app, ID, "feature/f", true).await["worktree"]["state"], "setup-failed");
    let wt = d.path().join("app-feature-f");
    // Git can't delete a file in a read-only folder, so the removal fails.
    std::fs::set_permissions(wt.join("locked"), std::os::unix::fs::PermissionsExt::from_mode(0o555)).unwrap();
    let p = remove_plan(&app, ID).await;
    let failed = remove(&app, ID, &p["stamp"]).await;
    std::fs::set_permissions(wt.join("locked"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    assert!(failed.is_err());
    // Git dropped its own entry but couldn't delete the whole folder. The record keeps the state it had, and the
    // list shows it with what is left on disk: nothing is forgotten for the owner.
    let l = list(&app).await;
    let rec = &l["missing"][0];
    assert_eq!(rec["state"], "setup-failed", "the failed setup isn't marked ready");
    assert_eq!(rec["exists"], true);
    assert!(wt.join("locked/inside.txt").is_file());
}

#[tokio::test]
async fn a_worktree_from_the_first_design_is_not_taken_for_one_made_here() {
    // ADR 0042's helper recorded its worktrees in `<git common dir>/hermes-chat/worktrees.json`, in another format,
    // and locked them `hermes-chat <id>`. This helper never reads or writes that file, and treats those trees as not
    // made here: shown, but not removed, attached to or set up from here.
    let (d, app) = repo("first-design");
    let old = d.join("app.worktrees/old");
    git(&app, &["worktree", "add", "-q", "-b", "old", &old, "main"]);
    git(&app, &["worktree", "lock", "--reason", &format!("hermes-chat {ID2}"), "--", &old]);
    let first = serde_json::to_vec(&serde_json::json!({"v": 1, "worktrees": {ID2: {
        "id": ID2, "path": old, "branch": "old", "newBranch": true, "base": "main", "baseSha": "", "setup": [],
        "state": "ready", "protected": false, "chats": [], "createdAt": 1, "createdBy": "owner"
    }}}))
    .unwrap();
    std::fs::create_dir_all(app.join(".git/hermes-chat")).unwrap();
    std::fs::write(app.join(".git/hermes-chat/worktrees.json"), &first).unwrap();

    let l = list(&app).await;
    let t = tree(&l, &old);
    assert!(t["managed"].is_null(), "{t}");
    let why: Vec<&str> = t["protected"].as_array().unwrap().iter().map(|b| b["kind"].as_str().unwrap()).collect();
    assert!(why.contains(&"unmanaged") && why.contains(&"locked"), "{why:?}");
    assert!(l["missing"].as_array().unwrap().is_empty());
    let attach = ask(Request::WorktreeAttach { repo: s(&app), id: ID2.into(), token: TOKEN.into(), profile: "p".into(), connection: "c".into() }).await;
    assert_eq!(kind(attach.unwrap_err()), "not-found");
    assert_eq!(kind(ask(Request::WorktreeSetup { repo: s(&app), id: ID2.into() }).await.unwrap_err()), "not-found");
    assert_eq!(kind(ask(Request::WorktreeRemovePlan { repo: s(&app), id: ID2.into() }).await.unwrap_err()), "not-found");

    // Making one here goes in this helper's own record and leaves the first design's untouched.
    create(&app, ID, "feature/new", false).await;
    assert_eq!(tree(&list(&app).await, &d.join("app-feature-new"))["managed"]["id"], ID);
    assert_eq!(std::fs::read(app.join(".git/hermes-chat/worktrees.json")).unwrap(), first);
    assert!(app.join(".git/hermes-chat/managed-worktrees.json").is_file());
}

// ── #483: repository and worktree helper bugs ───────────────────────────────

#[tokio::test]
async fn a_folder_written_with_a_trailing_slash_is_linked_like_one_without() {
    let (d, app) = repo("include-slash");
    // As .gitignore writes it. Kept with its slash, setup made an empty folder there and failed to link it; a Retry
    // then answered "ready" over the empty folder.
    write(&app, ".worktreeinclude", "node_modules/\n.env/\n");
    write(&app, "node_modules/pkg/index.js", "x\n");
    write(&app, ".env", "A=1\n");
    let p = plan(&app, "main", "feature/slash", true, "", true).await.unwrap();
    assert_eq!(p["setup"][0]["entry"], "node_modules");
    assert_eq!(p["setup"][0]["action"], "link");
    assert_eq!(p["setup"][1]["entry"], ".env");
    assert_eq!(p["setup"][1]["action"], "skip", "a slash names a folder, and .env is a file: {}", p["setup"][1]);

    let made = ask(create_req(&app, ID, &p, true)).await.unwrap();
    assert_eq!(made["worktree"]["state"], "ready", "{made}");
    let wt = d.path().join("app-feature-slash");
    assert!(std::fs::symlink_metadata(wt.join("node_modules")).unwrap().file_type().is_symlink());
    assert_eq!(read(&wt, "node_modules/pkg/index.js"), "x\n");
    assert!(!wt.join(".env").exists());
    // The link is setup's own, not a change of the owner's.
    let l = list(&app).await;
    assert_eq!(tree(&l, &s(&wt))["dirty"]["untracked"], 0, "{l}");
}

/// The helper as sshd leaves it when the connection drops: started in the background on the same stdin, so killing
/// what `run` started (as giving up does) closes only its stdin. Its pid goes to `pidfile`. (As in repo_git.rs.)
fn behind_sshd(pidfile: &Path, env: &[(&str, &str)]) -> Command {
    let mut c = Command::new("sh");
    c.arg("-c").arg(r#"exec 3<&0; sh -c "$1" <&3 3<&- & echo $! > "$2"; wait"#).arg("sh").arg(repo_git::remote_command()).arg(pidfile);
    c.env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_ALLOW_PROTOCOL", "file");
    for (k, v) in env {
        c.env(k, v);
    }
    c
}

fn ended(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(s) => s.rsplit(')').next().is_some_and(|rest| rest.trim_start().starts_with('Z')),
        Err(_) => (unsafe { libc::kill(pid, 0) }) != 0,
    }
}

async fn wait_for(what: &str, ok: impl Fn() -> bool) {
    for _ in 0..400 {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{what} didn't happen");
}

#[tokio::test]
async fn a_connection_dropped_between_unlocking_and_removing_leaves_the_worktree_locked() {
    let (d, app) = repo("drop-unlock");
    create(&app, ID, "feature/u", false).await;
    let wt = d.path().join("app-feature-u");
    let p = remove_plan(&app, ID).await;
    // A git that unlocks, then keeps the helper waiting, so the connection drops between the unlock and the removal.
    let bin = Dir::new("drop-unlock-bin");
    let marker = bin.path().join("unlocked");
    let real = String::from_utf8(StdCommand::new("sh").arg("-c").arg("command -v git").output().unwrap().stdout).unwrap();
    write_executable(
        &bin.path().join("git"),
        &format!("#!/bin/sh\n'{}' \"$@\" || exit $?\nfor a; do [ \"$a\" = unlock ] && {{ touch '{}'; exec sleep 300; }}; done\nexit 0\n", real.trim(), marker.display()),
    );
    let pidfile = bin.path().join("helper-pid");
    let path = format!("{}:{}", s(bin.path()), std::env::var("PATH").unwrap());
    let command = behind_sshd(&pidfile, &[("PATH", path.as_str())]);
    let req = Request::WorktreeRemove { repo: s(&app), id: ID.into(), expect: p["stamp"].as_str().unwrap().into() };
    let task = tokio::spawn(async move { repo_git::run(command, &req).await });
    wait_for("the unlock", || marker.exists()).await;
    let helper: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
    task.abort();
    let _ = task.await;
    wait_for("the helper's end", || ended(helper)).await;

    assert!(wt.is_dir(), "nothing was removed");
    let listed = git(&app, &["worktree", "list", "--porcelain"]);
    let entry = listed.split("\n\n").find(|e| e.contains("app-feature-u")).unwrap();
    assert!(entry.contains(&format!("locked hermes-chat: managed worktree {ID}")), "locked again: {entry}");
    let l = list(&app).await;
    assert_eq!(tree(&l, &s(&wt))["managed"]["state"], "ready", "the record is as it was: {l}");
}
