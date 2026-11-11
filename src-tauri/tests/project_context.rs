//! A project's context file commands (ADR 0135) against a stub dashboard with an in-memory disk, whose routes answer as
//! `hermes_cli/web_routers/files.py` does at `bf0203a`: managed files' download, upload-stream, mkdir and delete, and
//! the agent fs routes' read-text, write-text and git-root.

use axum::extract::{Query, RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use hermes_chat::project_context::{self, AttachedFile, ContextDir, ContextPath, GitExclude};
use hermes_chat::transport::{self, Attachable, Credential, Dashboard, SignIn};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use url::Url;

#[derive(Default)]
struct Disk {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
    dirs: Mutex<Vec<String>>,
    writes: Mutex<Vec<String>>,
    reads: Mutex<Vec<String>>,
    /// A symbolic link's path and its target, which Hermes resolves before it lists or reads.
    links: Mutex<BTreeMap<String, String>>,
}

type Shared = Arc<Disk>;

impl Disk {
    fn with(files: &[(&str, &str)]) -> Shared {
        let disk = Shared::default();
        for (path, text) in files {
            disk.put(path, text.as_bytes());
        }
        disk
    }

    fn put(&self, path: &str, bytes: &[u8]) {
        self.files.lock().unwrap().insert(path.to_owned(), bytes.to_vec());
    }

    fn file(&self, path: &str) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(path).cloned()
    }

    fn text(&self, path: &str) -> Option<String> {
        self.file(path).map(|b| String::from_utf8(b).unwrap())
    }

    fn is_dir(&self, path: &str) -> bool {
        let under = format!("{path}/");
        self.dirs.lock().unwrap().iter().any(|d| d == path || d.starts_with(&under)) || self.files.lock().unwrap().keys().any(|f| f.starts_with(&under))
    }

    fn exists(&self, path: &str) -> bool {
        self.file(path).is_some() || self.is_dir(path)
    }

    fn resolved(&self, path: &str) -> String {
        self.links.lock().unwrap().get(path).cloned().unwrap_or_else(|| path.to_owned())
    }

    fn writes(&self) -> Vec<String> {
        self.writes.lock().unwrap().clone()
    }

    fn reads(&self) -> Vec<String> {
        self.reads.lock().unwrap().clone()
    }
}

fn detail(status: StatusCode, detail: &str) -> Response {
    (status, Json(json!({ "detail": detail }))).into_response()
}

async fn login() -> Response {
    (axum::response::AppendHeaders([(axum::http::header::SET_COOKIE, "hermes_session_at=AT; Path=/")]), Json(json!({"ok": true}))).into_response()
}

async fn list(State(disk): State<Shared>, Query(q): Query<HashMap<String, String>>) -> Response {
    let path = q["path"].clone();
    disk.reads.lock().unwrap().push(format!("list {path}"));
    if !disk.is_dir(&path) {
        return detail(StatusCode::NOT_FOUND, "Path not found");
    }
    let under = format!("{path}/");
    let entries: Vec<Value> = disk
        .files
        .lock()
        .unwrap()
        .keys()
        .filter_map(|f| f.strip_prefix(&under).filter(|n| !n.contains('/')).map(|n| (n.to_owned(), f.clone())))
        .map(|(name, f)| json!({"name": name, "path": disk.resolved(&f), "is_directory": false}))
        .collect();
    Json(json!({"path": disk.resolved(&path), "entries": entries})).into_response()
}

async fn download(State(disk): State<Shared>, Query(q): Query<HashMap<String, String>>) -> Response {
    let path = q["path"].clone();
    disk.reads.lock().unwrap().push(format!("download {path}"));
    match disk.file(&path) {
        Some(bytes) => bytes.into_response(),
        None if disk.is_dir(&path) => detail(StatusCode::BAD_REQUEST, "Path is not a file"),
        None => detail(StatusCode::NOT_FOUND, "File not found"),
    }
}

async fn upload_stream(State(disk): State<Shared>, mut form: axum::extract::Multipart) -> Response {
    let (mut path, mut overwrite, mut bytes) = (String::new(), String::new(), Vec::new());
    while let Some(field) = form.next_field().await.unwrap() {
        match field.name().unwrap_or_default() {
            "path" => path = field.text().await.unwrap(),
            "overwrite" => overwrite = field.text().await.unwrap(),
            "file" => bytes = field.bytes().await.unwrap().to_vec(),
            _ => {}
        }
    }
    if overwrite == "false" && disk.exists(&path) {
        return detail(StatusCode::CONFLICT, "File already exists");
    }
    disk.writes.lock().unwrap().push(format!("upload-stream {path}"));
    disk.put(&path, &bytes);
    Json(json!({"ok": true, "path": path, "size": bytes.len()})).into_response()
}

async fn mkdir(State(disk): State<Shared>, Json(body): Json<Value>) -> Response {
    let path = body["path"].as_str().unwrap().to_owned();
    disk.writes.lock().unwrap().push(format!("mkdir {path}"));
    disk.dirs.lock().unwrap().push(path.clone());
    Json(json!({"ok": true, "path": path, "entry": {"name": "context", "is_directory": true}})).into_response()
}

async fn delete(State(disk): State<Shared>, Json(body): Json<Value>) -> Response {
    let path = body["path"].as_str().unwrap().to_owned();
    disk.writes.lock().unwrap().push(format!("delete {path} recursive={}", body["recursive"]));
    match disk.files.lock().unwrap().remove(&path) {
        Some(_) => Json(json!({"ok": true, "path": path})).into_response(),
        None => detail(StatusCode::NOT_FOUND, "Path not found"),
    }
}

async fn read_text(State(disk): State<Shared>, Query(q): Query<HashMap<String, String>>) -> Response {
    let path = q["path"].clone();
    disk.reads.lock().unwrap().push(format!("read-text {path} profile={}", q.get("profile").map_or("", String::as_str)));
    match disk.file(&path) {
        Some(data) => {
            let head = &data[..data.len().min(4096)];
            let shown = &data[..data.len().min(512 * 1024)];
            Json(json!({
                "binary": head.contains(&0),
                "byteSize": data.len(),
                "path": disk.resolved(&path),
                "text": String::from_utf8_lossy(shown),
                "truncated": data.len() > 512 * 1024,
            }))
            .into_response()
        }
        None if disk.is_dir(&path) => detail(StatusCode::BAD_REQUEST, "Only regular files can be read"),
        None => detail(StatusCode::NOT_FOUND, "File not found"),
    }
}

async fn write_text(State(disk): State<Shared>, RawQuery(query): RawQuery, Json(body): Json<Value>) -> Response {
    let path = body["path"].as_str().unwrap().to_owned();
    let parent = path.rsplit_once('/').unwrap().0;
    if !disk.is_dir(parent) {
        return detail(StatusCode::BAD_REQUEST, "Parent directory does not exist");
    }
    disk.writes.lock().unwrap().push(format!("write-text {path} {}", query.unwrap_or_default()));
    let content = body["content"].as_str().unwrap();
    disk.put(&path, content.as_bytes());
    Json(json!({"ok": true, "path": path, "byteSize": content.len()})).into_response()
}

async fn git_root(State(disk): State<Shared>, Query(q): Query<HashMap<String, String>>) -> Response {
    let mut dir = q["path"].clone();
    disk.reads.lock().unwrap().push(format!("git-root {dir} profile={}", q.get("profile").map_or("", String::as_str)));
    loop {
        if disk.exists(&format!("{dir}/.git")) {
            return Json(json!({ "root": dir })).into_response();
        }
        match dir.rsplit_once('/') {
            Some((parent, _)) if !parent.is_empty() => dir = parent.to_owned(),
            _ => return Json(json!({ "root": null })).into_response(),
        }
    }
}

async fn stub(disk: &Shared) -> Dashboard {
    let app = Router::new()
        .route("/auth/password-login", post(login))
        .route("/api/files/download", get(download))
        .route("/api/files/upload-stream", post(upload_stream))
        .route("/api/files/mkdir", post(mkdir))
        .route("/api/files", axum::routing::delete(delete).get(list))
        .route("/api/fs/read-text", get(read_text))
        .route("/api/fs/write-text", post(write_text))
        .route("/api/fs/git-root", get(git_root))
        .with_state(disk.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let sign_in = SignIn { credential: Credential::password("liam", "hunter2"), headers: Default::default() };
    Dashboard::sign_in(transport::client(&sign_in.headers).unwrap(), &base, &sign_in).await.expect("signed in")
}

fn scratch(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("hermes-chat-context-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn attached(attachable: &Attachable, dir: &std::path::Path, name: &str, bytes: &[u8]) -> String {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    let path = path.to_str().unwrap().to_owned();
    attachable.add([path.clone()]);
    path
}

fn path(p: &str) -> ContextPath {
    ContextPath::parse(p).unwrap()
}

#[tokio::test]
async fn an_upload_lands_in_the_context_folder_and_a_taken_name_is_refused_as_exists() {
    let disk = Disk::with(&[]);
    let dashboard = stub(&disk).await;
    let attachable = Attachable::default();
    let local = attached(&attachable, &scratch("upload"), "spec.md", b"# Spec\nThe answer is 42.\n");
    let to = path("/srv/plan/context/spec.md");

    let progress = Arc::new(Mutex::new(Vec::new()));
    let seen = progress.clone();
    let report = move |done, total| seen.lock().unwrap().push((done, total));
    project_context::upload(&dashboard, AttachedFile::check(&attachable, &local).unwrap(), &to, false, None, report).await.expect("uploaded");
    assert_eq!(disk.text("/srv/plan/context/spec.md").as_deref(), Some("# Spec\nThe answer is 42.\n"));
    assert_eq!(progress.lock().unwrap().last(), Some(&(25, Some(25))));

    std::fs::write(&local, b"newer").unwrap();
    let err = project_context::upload(&dashboard, AttachedFile::check(&attachable, &local).unwrap(), &to, false, None, |_, _| {}).await.unwrap_err();
    assert_eq!(err, "exists");
    assert_eq!(disk.text("/srv/plan/context/spec.md").as_deref(), Some("# Spec\nThe answer is 42.\n"), "nothing was replaced");
    project_context::upload(&dashboard, AttachedFile::check(&attachable, &local).unwrap(), &to, true, None, |_, _| {}).await.expect("replaced");
    assert_eq!(disk.text("/srv/plan/context/spec.md").as_deref(), Some("newer"));
    assert_eq!(disk.writes(), ["upload-stream /srv/plan/context/spec.md", "upload-stream /srv/plan/context/spec.md"]);
}

#[test]
fn only_an_attached_file_up_to_30_mb_may_be_uploaded() {
    let attachable = Attachable::default();
    let dir = scratch("attached");
    let loose = dir.join("loose.md");
    std::fs::write(&loose, b"x").unwrap();
    let err = AttachedFile::check(&attachable, loose.to_str().unwrap()).err().unwrap();
    assert!(err.contains("wasn't attached in this app"), "{err}");

    let big = attached(&attachable, &dir, "big.bin", b"");
    std::fs::File::options().write(true).open(&big).unwrap().set_len(project_context::CONTEXT_FILE_MAX_BYTES + 1).unwrap();
    let err = AttachedFile::check(&attachable, &big).err().unwrap();
    assert_eq!(err, "big.bin is 30.0 MB, over the 30 MB a context file may hold.");
    std::fs::File::options().write(true).open(&big).unwrap().set_len(project_context::CONTEXT_FILE_MAX_BYTES).unwrap();
    AttachedFile::check(&attachable, &big).expect("exactly 30 MB is let through");
}

#[tokio::test]
async fn text_content_is_written_as_a_file_and_a_taken_name_is_refused_as_exists() {
    let disk = Disk::with(&[("/srv/plan/context/Notes.md", "old")]);
    let dashboard = stub(&disk).await;
    project_context::write_text(&dashboard, &path("/srv/plan/context/Ideas.md"), "- one\n- two\n".into(), false, None).await.expect("written");
    assert_eq!(disk.text("/srv/plan/context/Ideas.md").as_deref(), Some("- one\n- two\n"));
    let err = project_context::write_text(&dashboard, &path("/srv/plan/context/Notes.md"), "new".into(), false, None).await.unwrap_err();
    assert_eq!(err, "exists");
    assert_eq!(disk.text("/srv/plan/context/Notes.md").as_deref(), Some("old"));
}

#[tokio::test]
async fn mkdir_creates_only_a_context_folder_and_answers_with_its_path() {
    let disk = Disk::with(&[]);
    let dashboard = stub(&disk).await;
    for bad in ["/home/me/.hermes/projects/plan", "/home/me/.hermes/projects/plan/notes", "/home/me/.hermes/pairing/context", "relative/context"] {
        assert!(ContextDir::parse(bad).is_err(), "{bad} was let through");
    }
    let dir = ContextDir::parse("/home/me/.hermes/projects/plan/context").unwrap();
    assert_eq!(project_context::mkdir(&dashboard, &dir).await.unwrap(), "/home/me/.hermes/projects/plan/context");
    assert_eq!(disk.writes(), ["mkdir /home/me/.hermes/projects/plan/context"]);
}

#[tokio::test]
async fn remove_deletes_one_file_never_recursively() {
    let disk = Disk::with(&[("/srv/plan/context/old.pdf", "%PDF"), ("/srv/plan/context/keep.md", "keep")]);
    let dashboard = stub(&disk).await;
    project_context::remove(&dashboard, &path("/srv/plan/context/old.pdf")).await.expect("removed");
    assert_eq!(disk.file("/srv/plan/context/old.pdf"), None);
    assert_eq!(disk.text("/srv/plan/context/keep.md").as_deref(), Some("keep"));
    assert_eq!(disk.writes(), ["delete /srv/plan/context/old.pdf recursive=false"]);
    let err = project_context::remove(&dashboard, &path("/srv/plan/context/old.pdf")).await.unwrap_err();
    assert!(err.contains("404") && err.contains("Path not found"), "{err}");
}

#[tokio::test]
async fn on_an_ssh_profile_only_text_goes_through_write_text_and_binary_is_refused() {
    let disk = Disk::with(&[("/srv/plan/context/taken.md", "old")]);
    disk.dirs.lock().unwrap().push("/srv/plan/context".into());
    let dashboard = stub(&disk).await;
    let attachable = Attachable::default();
    let dir = scratch("ssh");

    let image = attached(&attachable, &dir, "logo.png", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
    let to = path("/srv/plan/context/logo.png");
    let err = project_context::upload(&dashboard, AttachedFile::check(&attachable, &image).unwrap(), &to, false, Some("work"), |_, _| {}).await.unwrap_err();
    assert_eq!(err, "can't add this file to a project on an SSH profile yet");
    let big = attached(&attachable, &dir, "big.txt", &vec![b'a'; transport::AGENT_TEXT_MAX_BYTES as usize + 1]);
    let to_big = path("/srv/plan/context/big.txt");
    let err = project_context::upload(&dashboard, AttachedFile::check(&attachable, &big).unwrap(), &to_big, true, Some("work"), |_, _| {}).await.unwrap_err();
    assert_eq!(err, project_context::SSH_BINARY_REFUSED);
    assert!(disk.writes().is_empty(), "nothing was written: {:?}", disk.writes());

    let notes = attached(&attachable, &dir, "notes.md", "naïve ✓\n".as_bytes());
    let to = path("/srv/plan/context/notes.md");
    project_context::upload(&dashboard, AttachedFile::check(&attachable, &notes).unwrap(), &to, false, Some("work"), |_, _| {}).await.expect("text goes");
    assert_eq!(disk.text("/srv/plan/context/notes.md").as_deref(), Some("naïve ✓\n"));
    assert_eq!(disk.writes(), ["write-text /srv/plan/context/notes.md profile=work"]);

    let err = project_context::write_text(&dashboard, &path("/srv/plan/context/taken.md"), "new".into(), false, Some("work")).await.unwrap_err();
    assert_eq!(err, "exists", "write-text always replaces, so a taken name is looked for first");
    assert_eq!(disk.text("/srv/plan/context/taken.md").as_deref(), Some("old"));
    project_context::write_text(&dashboard, &path("/srv/plan/context/taken.md"), "new".into(), true, Some("work")).await.expect("replaced");
    assert_eq!(disk.text("/srv/plan/context/taken.md").as_deref(), Some("new"));
}

#[tokio::test]
async fn on_an_ssh_profile_a_file_keeps_its_byte_order_mark_and_its_size_past_what_read_text_sends() {
    let disk = Disk::with(&[]);
    disk.dirs.lock().unwrap().push("/srv/plan/context".into());
    let dashboard = stub(&disk).await;
    let attachable = Attachable::default();
    let dir = scratch("ssh-sizes");

    let bom = "\u{feff}# Notes\n".as_bytes();
    let local = attached(&attachable, &dir, "bom.md", bom);
    let to = path("/srv/plan/context/bom.md");
    project_context::upload(&dashboard, AttachedFile::check(&attachable, &local).unwrap(), &to, false, Some("work"), |_, _| {}).await.expect("text goes");
    assert_eq!(disk.file("/srv/plan/context/bom.md").as_deref(), Some(bom), "written byte for byte");
    let listed = project_context::ssh_file(&dashboard, &to, "work").await.unwrap();
    assert_eq!(listed.size, bom.len() as u64);
    assert_eq!(listed.text.as_deref(), Some("# Notes\n"));

    let long = vec![b'a'; 600 * 1024];
    let local = attached(&attachable, &dir, "long.md", &long);
    let to = path("/srv/plan/context/long.md");
    project_context::upload(&dashboard, AttachedFile::check(&attachable, &local).unwrap(), &to, false, Some("work"), |_, _| {})
        .await
        .expect("text up to 8 MiB goes");
    let listed = project_context::ssh_file(&dashboard, &to, "work").await.unwrap();
    assert_eq!(listed, project_context::SshFile { size: 600 * 1024, text: None }, "read-text cut it short, so it is listed by path at its real size");
}

#[tokio::test]
async fn read_text_extracts_what_it_can_and_says_none_for_the_rest() {
    let disk = Disk::with(&[("/srv/p/context/notes.md", "# Notes\nThe vault code is 4471.\n")]);
    disk.put("/srv/p/context/logo.png", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
    let dashboard = stub(&disk).await;
    let md = path("/srv/p/context/notes.md");
    assert_eq!(project_context::read_text(&dashboard, &md, 32, None).await.unwrap().as_deref(), Some("# Notes\nThe vault code is 4471.\n"));
    assert_eq!(project_context::read_text(&dashboard, &md, 32, Some("work")).await.unwrap().as_deref(), Some("# Notes\nThe vault code is 4471.\n"));
    assert_eq!(project_context::read_text(&dashboard, &path("/srv/p/context/logo.png"), 14, None).await.unwrap(), None);
    assert_eq!(project_context::read_text(&dashboard, &path("/srv/p/context/logo.png"), 14, Some("work")).await.unwrap(), None);
    assert_eq!(
        disk.reads(),
        [
            "download /srv/p/context/notes.md",
            "read-text /srv/p/context/notes.md profile=work",
            "download /srv/p/context/logo.png",
            "read-text /srv/p/context/logo.png profile=work"
        ]
    );
    let huge = project_context::CONTEXT_FILE_MAX_BYTES + 1;
    assert_eq!(project_context::read_text(&dashboard, &md, huge, None).await.unwrap(), None);
    assert_eq!(disk.reads().len(), 4, "a file listed over 30 MB isn't read");
    let err = project_context::read_text(&dashboard, &path("/srv/p/context/gone.md"), 3, None).await.unwrap_err();
    assert_eq!(err, "gone.md isn't in the context folder any more.");
}

#[tokio::test]
async fn git_exclude_adds_one_anchored_line_to_info_exclude_once() {
    let disk =
        Disk::with(&[("/r/.git/HEAD", "ref: refs/heads/main\n"), ("/r/.git/info/exclude", "# git ls-files --others --exclude-from=.git/info/exclude\n")]);
    let dashboard = stub(&disk).await;
    assert_eq!(project_context::git_exclude(&dashboard, "/r/app", None).await.unwrap(), GitExclude::Added);
    assert_eq!(disk.text("/r/.git/info/exclude").unwrap(), "# git ls-files --others --exclude-from=.git/info/exclude\n/app/context/\n");
    assert_eq!(project_context::git_exclude(&dashboard, "/r/app", None).await.unwrap(), GitExclude::Already);
    assert_eq!(disk.writes(), ["upload-stream /r/.git/info/exclude"], "written once, and nothing else");
}

#[tokio::test]
async fn git_exclude_leaves_a_folder_already_ignored_by_a_gitignore() {
    let disk = Disk::with(&[("/r/.git/HEAD", "ref: refs/heads/main\n"), ("/r/app/.gitignore", "node_modules/\n/context/\n")]);
    let dashboard = stub(&disk).await;
    assert_eq!(project_context::git_exclude(&dashboard, "/r/app", None).await.unwrap(), GitExclude::Already);
    let disk = Disk::with(&[("/r/.git/HEAD", "ref: refs/heads/main\n"), ("/r/.gitignore", "context/\n")]);
    let dashboard = stub(&disk).await;
    assert_eq!(project_context::git_exclude(&dashboard, "/r", None).await.unwrap(), GitExclude::Already);
    assert!(disk.writes().is_empty());
}

#[tokio::test]
async fn git_exclude_follows_a_worktree_to_the_common_dir() {
    let disk = Disk::with(&[
        ("/r/.git/HEAD", "ref: refs/heads/main\n"),
        ("/wt/.git", "gitdir: /r/.git/worktrees/wt\n"),
        ("/r/.git/worktrees/wt/HEAD", "ref: refs/heads/feature\n"),
        ("/r/.git/worktrees/wt/commondir", "../..\n"),
    ]);
    let dashboard = stub(&disk).await;
    assert_eq!(project_context::git_exclude(&dashboard, "/wt", None).await.unwrap(), GitExclude::Added);
    assert_eq!(disk.text("/r/.git/info/exclude").as_deref(), Some("/context/\n"));
    assert_eq!(disk.writes(), ["upload-stream /r/.git/info/exclude"]);
}

#[tokio::test]
async fn git_exclude_writes_nothing_outside_a_repository() {
    let disk = Disk::with(&[("/home/me/notes/a.md", "x")]);
    let dashboard = stub(&disk).await;
    assert_eq!(project_context::git_exclude(&dashboard, "/home/me/notes", None).await.unwrap(), GitExclude::None);
    let disk = Disk::with(&[("/home/me/proj/.git", "gitdir: /home/me/.ssh\n"), ("/home/me/.ssh/id_ed25519", "secret")]);
    let dashboard = stub(&disk).await;
    let err = project_context::git_exclude(&dashboard, "/home/me/proj", None).await.unwrap_err();
    assert!(err.contains("isn't /home/me/proj's own Git folder"), "{err}");
    assert!(disk.writes().is_empty(), "a .git file naming another folder gets nothing written there");
}

#[tokio::test]
async fn git_exclude_writes_nothing_to_another_repository_a_git_file_or_commondir_names() {
    let other = [("/other/.git/HEAD", "ref: refs/heads/main\n"), ("/other/.git/info/exclude", "keep\n")];
    let named_by_gitdir = Disk::with(&[other[0], other[1], ("/proj/.git", "gitdir: /other/.git\n")]);
    let by_commondir = Disk::with(&[
        other[0],
        other[1],
        ("/r/.git/HEAD", "ref: refs/heads/main\n"),
        ("/wt/.git", "gitdir: /r/.git/worktrees/wt\n"),
        ("/r/.git/worktrees/wt/commondir", "/other/.git\n"),
    ]);
    let main_with_commondir = Disk::with(&[other[0], other[1], ("/proj/.git/HEAD", "ref: refs/heads/main\n"), ("/proj/.git/commondir", "/other/.git\n")]);
    for (disk, main) in [(named_by_gitdir, "/proj"), (by_commondir, "/wt"), (main_with_commondir, "/proj")] {
        let dashboard = stub(&disk).await;
        let err = project_context::git_exclude(&dashboard, main, None).await.unwrap_err();
        assert!(err.contains("own Git folder"), "{main}: {err}");
        assert!(disk.writes().is_empty(), "{main}: {:?}", disk.writes());
        assert_eq!(disk.text("/other/.git/info/exclude").as_deref(), Some("keep\n"));
    }
}

#[tokio::test]
async fn git_exclude_leaves_a_linked_or_non_utf8_info_exclude_alone() {
    for ssh in [None, Some("work")] {
        let disk = Disk::with(&[("/r/.git/HEAD", "ref: refs/heads/main\n"), ("/r/.git/info/exclude", "x"), ("/etc/target", "keep\n")]);
        disk.links.lock().unwrap().insert("/r/.git/info/exclude".into(), "/etc/target".into());
        let dashboard = stub(&disk).await;
        let err = project_context::git_exclude(&dashboard, "/r", ssh).await.unwrap_err();
        assert!(err.contains("is a link"), "{ssh:?}: {err}");
        assert!(disk.writes().is_empty(), "{ssh:?}: {:?}", disk.writes());
    }
    let disk = Disk::with(&[("/r/.git/HEAD", "ref: refs/heads/main\n")]);
    disk.put("/r/.git/info/exclude", b"caf\xe9\n");
    let dashboard = stub(&disk).await;
    let err = project_context::git_exclude(&dashboard, "/r", None).await.unwrap_err();
    assert!(err.contains("isn't UTF-8 text"), "{err}");
    assert_eq!(disk.file("/r/.git/info/exclude").as_deref(), Some(&b"caf\xe9\n"[..]), "left byte for byte");
}

#[tokio::test]
async fn git_exclude_on_an_ssh_profile_reads_and_writes_through_the_fs_routes() {
    let disk = Disk::with(&[("/r/.git/HEAD", "ref: refs/heads/main\n"), ("/r/.git/info/exclude", "*.log")]);
    let dashboard = stub(&disk).await;
    assert_eq!(project_context::git_exclude(&dashboard, "/r/docs", Some("work")).await.unwrap(), GitExclude::Added);
    assert_eq!(disk.text("/r/.git/info/exclude").as_deref(), Some("*.log\n/docs/context/\n"));
    assert_eq!(disk.writes(), ["write-text /r/.git/info/exclude profile=work"]);
    assert!(disk.reads().iter().all(|r| r.ends_with("profile=work")), "{:?}", disk.reads());
}
