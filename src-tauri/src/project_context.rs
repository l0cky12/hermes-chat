//! A project's context files (ADR 0135): the files in `<main folder>/context/` on the Hermes server that every chat in
//! the project gets. The webview lists the folder and writes the messages. Rust writes, removes and reads the files,
//! extracts their text, and keeps `context/` out of Git. The REST relay sends no writes to the file routes (ADR 0012),
//! and Hermes's write routes don't guard credential files, so every write here takes a path that `ContextPath::parse`
//! or `ContextDir::parse` checked.

use crate::transport::{self, Attachable, Dashboard, TransportError, UploadSource};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::Read as _;
use std::time::Duration;

const MIB: u64 = 1024 * 1024;
pub const CONTEXT_FILE_MAX_BYTES: u64 = 30 * MIB;
const EXTRACTED_MAX_BYTES: usize = 8 * MIB as usize;
const DOCX_XML_MAX_BYTES: u64 = 64 * MIB;
/// The blocking thread can't be stopped, so it finishes on its own.
const EXTRACT_TIME_LIMIT: Duration = Duration::from_secs(30);
/// `read-text` sends at most 512 KiB of text, which JSON escaping can make several times longer.
const READ_TEXT_ANSWER_MAX_BYTES: u64 = 4 * MIB;
const GIT_FILE_MAX_BYTES: u64 = MIB;
const ANSWER_MAX_BYTES: u64 = 64 * 1024;

/// What a write is refused with when a file is already at its path and `overwrite` is false.
pub const EXISTS: &str = "exists";
/// What adding a file that isn't UTF-8 text up to 8 MiB on an SSH profile is refused with: `/api/fs` has no binary
/// write (ADR 0135).
pub const SSH_BINARY_REFUSED: &str = "can't add this file to a project on an SSH profile yet";

/// A project's `context` folder on the server: a full path, without empty, `.` or `..` segments, whose last segment is
/// `context`, and not in a credential folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextDir(String);

impl ContextDir {
    pub fn parse(path: &str) -> Result<ContextDir, String> {
        if segments(path)?.last() != Some(&"context") {
            return Err(format!("{path} isn't a project's context folder."));
        }
        if transport::protected_server_path(path) {
            return Err(credential(path));
        }
        Ok(ContextDir(path.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A file directly in a project's `context` folder on the server: a full path, without empty, `.` or `..` segments,
/// whose parent's last segment is `context`, with a plain name that doesn't start with a dot, and not a credential file
/// or in a credential folder (`protected_server_path`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextPath(String);

impl ContextPath {
    pub fn parse(server_path: &str) -> Result<ContextPath, String> {
        let segs = segments(server_path)?;
        let [.., "context", name] = segs.as_slice() else {
            return Err(format!("{server_path} isn't a file in a project's context folder."));
        };
        if name.starts_with('.') {
            return Err(format!("{name} starts with a dot, so it would be hidden. Give it another name."));
        }
        if name.contains('\\') {
            return Err(format!("{name} has a backslash in it. Give it another name."));
        }
        if transport::protected_server_path(server_path) {
            return Err(credential(server_path));
        }
        Ok(ContextPath(server_path.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or_default()
    }
}

fn segments(path: &str) -> Result<Vec<&str>, String> {
    let Some(rest) = path.strip_prefix('/') else {
        return Err(format!("{path} isn't a full path on the server."));
    };
    if path.chars().any(char::is_control) {
        return Err(format!("{path:?} has a control character in it."));
    }
    let segs: Vec<&str> = rest.split('/').collect();
    if segs.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return Err(format!("{path} has an empty, '.' or '..' folder in it."));
    }
    Ok(segs)
}

fn credential(path: &str) -> String {
    format!("Hermes Chat never writes {path}: it's where Hermes keeps credentials.")
}

/// A local file the owner attached (`Attachable`, ADR 0129) that may be added to a project: a regular file no bigger
/// than `CONTEXT_FILE_MAX_BYTES`.
pub struct AttachedFile {
    path: std::path::PathBuf,
    name: String,
    size: u64,
}

impl AttachedFile {
    pub fn check(attachable: &Attachable, local: &str) -> Result<AttachedFile, String> {
        let path = std::path::PathBuf::from(local);
        let name = path.file_name().map_or_else(|| local.to_owned(), |n| n.to_string_lossy().into_owned());
        attachable.check(local).map_err(|e| format!("Couldn't add {name}: {e}."))?;
        let meta = std::fs::metadata(&path).map_err(|e| format!("Couldn't add {name}: {e}."))?;
        if !meta.is_file() {
            return Err(format!("Couldn't add {name}: it isn't a file."));
        }
        let size = meta.len();
        if size > CONTEXT_FILE_MAX_BYTES {
            return Err(format!("{name} is {:.1} MB, over the {} MB a context file may hold.", size as f64 / MIB as f64, CONTEXT_FILE_MAX_BYTES / MIB));
        }
        Ok(AttachedFile { path, name, size })
    }
}

#[derive(Clone, Copy)]
enum Machine<'a> {
    Dashboard,
    Ssh(&'a str),
}

impl<'a> Machine<'a> {
    fn of(ssh_profile: Option<&'a str>) -> Machine<'a> {
        ssh_profile.map_or(Machine::Dashboard, Machine::Ssh)
    }
}

enum Read {
    Bytes(Vec<u8>),
    Missing,
    NotAFile,
    NotText,
}

/// `read-text`'s answer (`fs_read_text` in `hermes_cli/web_routers/files.py` at `bf0203a`).
#[derive(Deserialize)]
struct ReadText {
    #[serde(default)]
    text: String,
    #[serde(default)]
    binary: bool,
    #[serde(default)]
    truncated: bool,
}

fn query(pairs: &[(&str, &str)]) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        q.append_pair(k, v);
    }
    q.finish()
}

async fn read(dashboard: &Dashboard, on: Machine<'_>, path: &str, max_bytes: u64) -> Result<Read, TransportError> {
    let answer = match on {
        Machine::Dashboard => dashboard.send_limited(Method::GET, "api/files/download", &query(&[("path", path)]), None, max_bytes).await,
        Machine::Ssh(profile) => {
            let q = query(&[("path", path), ("profile", profile)]);
            dashboard.send_limited(Method::GET, "api/fs/read-text", &q, None, READ_TEXT_ANSWER_MAX_BYTES).await
        }
    };
    let body = match answer {
        Ok(body) => body,
        Err(TransportError::Unexpected { status: 404, .. }) => return Ok(Read::Missing),
        Err(TransportError::Unexpected { status: 400, .. }) => return Ok(Read::NotAFile),
        Err(e) => return Err(e),
    };
    match on {
        Machine::Dashboard => Ok(Read::Bytes(body)),
        Machine::Ssh(_) => {
            let answer: ReadText = serde_json::from_slice(&body)
                .map_err(|_| TransportError::Unexpected { status: 200, body: "the answer to reading a file wasn't Hermes's".into() })?;
            Ok(if answer.binary || answer.truncated { Read::NotText } else { Read::Bytes(answer.text.into_bytes()) })
        }
    }
}

fn written(e: TransportError) -> String {
    match e {
        TransportError::Unexpected { status: 409, .. } => EXISTS.into(),
        e => e.to_string(),
    }
}

/// Uploads an attached file to `to` (ADR 0023). On an SSH profile only UTF-8 text up to 8 MiB goes, else
/// `SSH_BINARY_REFUSED`. `overwrite` false: `EXISTS` when a file is already there.
pub async fn upload(
    dashboard: &Dashboard,
    file: AttachedFile,
    to: &ContextPath,
    overwrite: bool,
    ssh_profile: Option<&str>,
    progress: impl Fn(u64, Option<u64>) + Send + Sync + 'static,
) -> Result<(), String> {
    let Some(profile) = ssh_profile else {
        return dashboard.upload(to.as_str(), UploadSource::File(file.path), overwrite, progress).await.map(drop).map_err(written);
    };
    if file.size > transport::AGENT_TEXT_MAX_BYTES {
        return Err(SSH_BINARY_REFUSED.into());
    }
    let bytes = tokio::fs::read(&file.path).await.map_err(|e| format!("Couldn't read {} on this computer: {e}.", file.name))?;
    let text = match plain_text(&bytes) {
        Some(text) if bytes.len() as u64 <= transport::AGENT_TEXT_MAX_BYTES => text,
        _ => return Err(SSH_BINARY_REFUSED.into()),
    };
    let size = bytes.len() as u64;
    progress(0, Some(size));
    write_over_ssh(dashboard, profile, to, text, overwrite).await?;
    progress(size, Some(size));
    Ok(())
}

/// Writes `text` as the file `to`, up to `CONTEXT_FILE_MAX_BYTES`, or 8 MiB on an SSH profile. `overwrite` false:
/// `EXISTS` when a file is already there.
pub async fn write_text(dashboard: &Dashboard, to: &ContextPath, text: String, overwrite: bool, ssh_profile: Option<&str>) -> Result<(), String> {
    match ssh_profile {
        Some(profile) => write_over_ssh(dashboard, profile, to, &text, overwrite).await,
        None => {
            let size = text.len() as u64;
            if size > CONTEXT_FILE_MAX_BYTES {
                return Err(TransportError::FileTooLarge { size, max: CONTEXT_FILE_MAX_BYTES }.to_string());
            }
            dashboard.upload(to.as_str(), UploadSource::Bytes(text.into_bytes()), overwrite, |_, _| {}).await.map(drop).map_err(written)
        }
    }
}

async fn write_over_ssh(dashboard: &Dashboard, profile: &str, to: &ContextPath, text: &str, overwrite: bool) -> Result<(), String> {
    // `write-text` always replaces, so a taken name is looked for first. A file created in between is still replaced.
    let taken = || async { read(dashboard, Machine::Ssh(profile), to.as_str(), CONTEXT_FILE_MAX_BYTES).await.map(|r| !matches!(r, Read::Missing)) };
    if !overwrite && taken().await.map_err(written)? {
        return Err(EXISTS.into());
    }
    dashboard.write_agent_text(profile, to.as_str(), text, None).await.map(drop).map_err(written)
}

/// Creates `dir` and its missing parents. Returns the path Hermes answers with.
pub async fn mkdir(dashboard: &Dashboard, dir: &ContextDir) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Made {
        path: String,
    }
    let body = json!({ "path": dir.as_str() });
    let answer = dashboard.send_limited(Method::POST, "api/files/mkdir", "", Some(&body), ANSWER_MAX_BYTES).await.map_err(|e| e.to_string())?;
    serde_json::from_slice::<Made>(&answer).map(|m| m.path).map_err(|_| "Hermes's answer to creating the context folder didn't name it.".into())
}

/// Deletes the file `file`, never a folder's contents.
pub async fn remove(dashboard: &Dashboard, file: &ContextPath) -> Result<(), String> {
    let body = json!({ "path": file.as_str(), "recursive": false });
    dashboard.send_limited(Method::DELETE, "api/files", "", Some(&body), ANSWER_MAX_BYTES).await.map(drop).map_err(|e| e.to_string())
}

/// The text of the context file `file`, `size` bytes as listed, for full-text mode. `None`: it has no text Hermes Chat
/// can read, it's over `CONTEXT_FILE_MAX_BYTES`, or on an SSH profile it isn't plain text up to 512 KiB.
pub async fn read_text(dashboard: &Dashboard, file: &ContextPath, size: u64, ssh_profile: Option<&str>) -> Result<Option<String>, String> {
    if size > CONTEXT_FILE_MAX_BYTES {
        return Ok(None);
    }
    match read(dashboard, Machine::of(ssh_profile), file.as_str(), CONTEXT_FILE_MAX_BYTES).await.map_err(|e| e.to_string())? {
        Read::Bytes(bytes) => Ok(extract(file.name().to_owned(), bytes).await),
        Read::NotText => Ok(None),
        Read::Missing => Err(format!("{} isn't in the context folder any more.", file.name())),
        Read::NotAFile => Err(format!("{} isn't a file.", file.name())),
    }
}

/// `extract_text` on a blocking thread, which catches a panic in the PDF parser as a `JoinError`, and given up after
/// `EXTRACT_TIME_LIMIT`.
pub async fn extract(name: String, bytes: Vec<u8>) -> Option<String> {
    let work = tokio::task::spawn_blocking(move || extract_text(&name, &bytes));
    tokio::time::timeout(EXTRACT_TIME_LIMIT, work).await.ok()?.ok()?
}

/// The text of a file named `name`, for full-text mode: a `.docx`'s paragraphs, a `.pdf`'s text, or a plain-text file
/// as it is. `None` for anything else, a document with no text, or text over `EXTRACTED_MAX_BYTES`.
pub fn extract_text(name: &str, bytes: &[u8]) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let text = if lower.ends_with(".docx") {
        docx_text(bytes).filter(|t| !t.trim().is_empty())?
    } else if lower.ends_with(".pdf") {
        pdf_text(bytes).filter(|t| !t.trim().is_empty())?
    } else {
        plain_text(bytes)?.to_owned()
    };
    (text.len() <= EXTRACTED_MAX_BYTES).then_some(text)
}

fn plain_text(bytes: &[u8]) -> Option<&str> {
    if bytes[..bytes.len().min(4096)].contains(&0) {
        return None;
    }
    Some(std::str::from_utf8(bytes).ok()?.trim_start_matches('\u{feff}'))
}

fn docx_text(bytes: &[u8]) -> Option<String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let entry = archive.by_name("word/document.xml").ok()?;
    let mut xml = String::new();
    entry.take(DOCX_XML_MAX_BYTES + 1).read_to_string(&mut xml).ok()?;
    if xml.len() as u64 > DOCX_XML_MAX_BYTES {
        return None;
    }
    Some(document_xml_text(&xml))
}

fn document_xml_text(xml: &str) -> String {
    let mut out = String::new();
    let (mut in_text, mut in_tab_stops) = (false, false);
    let mut rest = xml;
    while let Some(lt) = rest.find('<') {
        if in_text {
            out.push_str(&decode_entities(&rest[..lt]));
        }
        let Some(gt) = rest[lt..].find('>') else { break };
        let tag = &rest[lt + 1..lt + gt];
        rest = &rest[lt + gt + 1..];
        let closing = tag.starts_with('/');
        let empty = tag.ends_with('/');
        let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or_default();
        match (closing, name) {
            (false, "w:t") => in_text = !empty,
            (true, "w:t") => in_text = false,
            (true, "w:p") => out.push('\n'),
            (false, "w:p") if empty => out.push('\n'),
            // A paragraph's tab stops (`w:tabs`) are `w:tab` too.
            (false, "w:tabs") => in_tab_stops = !empty,
            (true, "w:tabs") => in_tab_stops = false,
            (false, "w:tab") if !in_tab_stops => out.push('\t'),
            (false, "w:br" | "w:cr") => out.push('\n'),
            _ => {}
        }
    }
    out
}

fn decode_entities(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains('&') {
        return s.into();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let entity = rest.find(';').and_then(|semi| {
            let c = match &rest[1..semi] {
                "lt" => '<',
                "gt" => '>',
                "amp" => '&',
                "quot" => '"',
                "apos" => '\'',
                e => {
                    let code = match e.strip_prefix("#x").or_else(|| e.strip_prefix("#X")) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                        None => e.strip_prefix('#')?.parse().ok()?,
                    };
                    char::from_u32(code)?
                }
            };
            Some((c, semi))
        });
        match entity {
            Some((c, semi)) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out.into()
}

fn pdf_text(bytes: &[u8]) -> Option<String> {
    let doc = lopdf::Document::load_mem(bytes).ok()?;
    let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
    doc.extract_text(&pages).ok()
}

/// What `git_exclude` did: the main folder isn't in a Git repository, the line was added to `info/exclude`, or
/// `context/` was already ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitExclude {
    None,
    Added,
    Already,
}

struct ExcludeFile(String);

impl ExcludeFile {
    fn in_common_dir(common: &str) -> ExcludeFile {
        ExcludeFile(format!("{}/info/exclude", common.trim_end_matches('/')))
    }
}

/// Keeps `<main_folder>/context/` out of the Git repository the main folder is in, if any, by appending an anchored line
/// to the repository's `info/exclude`, unless `info/exclude`, the root's `.gitignore` or the main folder's already
/// ignores it. Never writes a `.gitignore`.
pub async fn git_exclude(dashboard: &Dashboard, main_folder: &str, ssh_profile: Option<&str>) -> Result<GitExclude, String> {
    #[derive(Deserialize)]
    struct GitRoot {
        root: Option<String>,
    }
    segments(main_folder)?;
    let on = Machine::of(ssh_profile);
    let mut pairs = vec![("path", main_folder)];
    pairs.extend(ssh_profile.map(|p| ("profile", p)));
    let answer = dashboard.send_limited(Method::GET, "api/fs/git-root", &query(&pairs), None, ANSWER_MAX_BYTES).await.map_err(|e| e.to_string())?;
    let found: GitRoot = serde_json::from_slice(&answer).map_err(|_| "Hermes's answer to finding the Git repository wasn't one Hermes Chat knows.")?;
    let Some(root) = found.root else { return Ok(GitExclude::None) };
    let root = normalize(&root).ok_or_else(|| format!("Hermes named {root} as the Git repository, which isn't a full path."))?;
    let rel = relative(&root, main_folder)
        .ok_or_else(|| format!("Hermes named {root} as the Git repository, which doesn't hold {main_folder}, so context/ wasn't excluded."))?;

    let unreadable = |path: &str| format!("Couldn't read {path} to keep context/ out of Git.");
    let read_git = |path: String| async move { read(dashboard, on, &path, GIT_FILE_MAX_BYTES).await.map_err(|e| e.to_string()).map(|r| (path, r)) };
    let text_or_empty = |(path, read): (String, Read)| match read {
        Read::Bytes(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Read::Missing => Ok(String::new()),
        Read::NotAFile | Read::NotText => Err(unreadable(&path)),
    };

    let git_dir = match read_git(format!("{root}/.git")).await? {
        (_, Read::NotAFile) => format!("{root}/.git"),
        (path, Read::Bytes(bytes)) => gitdir_of(&root, &String::from_utf8_lossy(&bytes)).ok_or_else(|| unreadable(&path))?,
        (path, _) => return Err(unreadable(&path)),
    };
    let common = match read_git(format!("{git_dir}/commondir")).await? {
        (_, Read::Missing) => git_dir,
        (path, Read::Bytes(bytes)) => join(&git_dir, String::from_utf8_lossy(&bytes).trim()).ok_or_else(|| unreadable(&path))?,
        (path, _) => return Err(unreadable(&path)),
    };
    // `.git` and `commondir` can name any folder, and the upload route creates missing parents: only a folder that
    // looks like a repository gets an `info/exclude`.
    if !matches!(read_git(format!("{common}/HEAD")).await?, (_, Read::Bytes(_))) {
        return Err(format!("{common} doesn't look like a Git repository, so context/ wasn't excluded."));
    }
    let exclude = ExcludeFile::in_common_dir(&common);
    let exclude_text = text_or_empty(read_git(exclude.0.clone()).await?)?;
    let root_ignore = text_or_empty(read_git(format!("{root}/.gitignore")).await?)?;
    let main_ignore = if rel.is_empty() { String::new() } else { text_or_empty(read_git(format!("{main_folder}/.gitignore")).await?)? };
    let Some(text) = exclude_with_context(&rel, &exclude_text, &root_ignore, &main_ignore) else {
        return Ok(GitExclude::Already);
    };
    match on {
        Machine::Dashboard => dashboard.upload(&exclude.0, UploadSource::Bytes(text.into_bytes()), true, |_, _| {}).await.map(drop),
        Machine::Ssh(profile) => dashboard.write_agent_text(profile, &exclude.0, &text, None).await.map(drop),
    }
    .map_err(|e| e.to_string())?;
    Ok(GitExclude::Added)
}

/// `info/exclude`'s new text with the line that ignores `context/` in the main folder at `rel` under the repository's
/// root (`""`: the root itself), or `None` when `exclude` (from the root), `root_ignore` (the root's `.gitignore`) or
/// `main_ignore` (the main folder's) already has a line that ignores exactly that folder.
pub fn exclude_with_context(rel: &str, exclude: &str, root_ignore: &str, main_ignore: &str) -> Option<String> {
    let rel = escape_pattern(rel);
    let anywhere = ["context".to_owned(), "context/".to_owned()];
    let at = |dir: &str| [format!("/{dir}context"), format!("/{dir}context/")];
    let from_main: Vec<String> = anywhere.iter().cloned().chain(at("")).collect();
    let from_root: Vec<String> = if rel.is_empty() {
        from_main.clone()
    } else {
        // A pattern with a slash before its end is anchored, with or without a leading one.
        let inner = [format!("{rel}/context"), format!("{rel}/context/")];
        anywhere.iter().cloned().chain(inner).chain(at(&format!("{rel}/"))).collect()
    };
    let has = |text: &str, lines: &[String]| text.lines().map(str::trim_end).any(|l| lines.iter().any(|w| w == l));
    if has(exclude, &from_root) || has(root_ignore, &from_root) || has(main_ignore, &from_main) {
        return None;
    }
    let mut text = exclude.to_owned();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&if rel.is_empty() { "/context/".to_owned() } else { format!("/{rel}/context/") });
    text.push('\n');
    Some(text)
}

fn escape_pattern(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if matches!(c, '\\' | '*' | '?' | '[') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn relative(root: &str, main: &str) -> Option<String> {
    if main == root {
        return Some(String::new());
    }
    main.strip_prefix(root.trim_end_matches('/'))?.strip_prefix('/').map(str::to_owned)
}

fn gitdir_of(root: &str, dot_git: &str) -> Option<String> {
    join(root, dot_git.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim())
}

fn join(base: &str, rel: &str) -> Option<String> {
    match rel {
        "" => None,
        r if r.starts_with('/') => normalize(r),
        r => normalize(&format!("{base}/{r}")),
    }
}

fn normalize(path: &str) -> Option<String> {
    let rest = path.strip_prefix('/')?;
    let mut out: Vec<&str> = Vec::new();
    for seg in rest.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s),
        }
    }
    Some(format!("/{}", out.join("/")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn a_context_path_is_a_plain_file_directly_in_a_context_folder() {
        let ok = ContextPath::parse("/home/me/projects/plan/context/Spec v2.md").unwrap();
        assert_eq!(ok.as_str(), "/home/me/projects/plan/context/Spec v2.md");
        assert_eq!(ok.name(), "Spec v2.md");
        ContextPath::parse("/context/a.pdf").expect("a context folder at the root");
        for bad in [
            "relative/context/a.md",
            "~/p/context/a.md",
            "/p/context/",
            "/p/context",
            "/p/notes/a.md",
            "/p/context/sub/a.md",
            "/p/Context/a.md",
            "/p/context/.hidden",
            "/p/context/.env",
            "/p/context/.env.local",
            "/p/context/..",
            "/p/context/.",
            "/p/../context/a.md",
            "/p/./context/a.md",
            "/p//context/a.md",
            "/p/context/a\\b.md",
            "/p/context/a\nb.md",
            "/p/context/a\0b.md",
            "/p/context/auth.json",
            "/p/context/Credentials",
            "/p/context/config.yaml",
            "/p/context/google_token.json",
            "/p/context/.git-credentials",
            "/home/me/.hermes/mcp-tokens/context/a.md",
            "/home/me/.hermes/PAIRING/context/a.md",
        ] {
            assert!(ContextPath::parse(bad).is_err(), "{bad:?} was let through");
        }
    }

    #[test]
    fn a_context_dir_ends_in_context_outside_credential_folders() {
        assert_eq!(ContextDir::parse("/home/me/.hermes/projects/plan/context").unwrap().as_str(), "/home/me/.hermes/projects/plan/context");
        for bad in ["/p/context/", "/p/contexts", "/p", "p/context", "/p/../context", "/x/pairing/context", "/x/mcp-tokens/context", "/"] {
            assert!(ContextDir::parse(bad).is_err(), "{bad:?} was let through");
        }
    }

    #[test]
    fn an_exclude_line_is_added_once_and_anchored_to_the_main_folder() {
        assert_eq!(exclude_with_context("app", "", "", "").as_deref(), Some("/app/context/\n"));
        assert_eq!(exclude_with_context("", "# git ls-files\n*.log", "", "").as_deref(), Some("# git ls-files\n*.log\n/context/\n"));
        assert_eq!(exclude_with_context("a b/[x]", "", "", "").as_deref(), Some("/a b/\\[x]/context/\n"), "globs are escaped");
        let added = exclude_with_context("app", "", "", "").unwrap();
        assert_eq!(exclude_with_context("app", &added, "", ""), None, "a second run adds nothing");
    }

    #[test]
    fn an_equivalent_ignore_line_anywhere_counts_as_already_ignored() {
        for line in ["context", "context/", "/app/context/", "/app/context", "app/context", "app/context/", "context/  "] {
            assert_eq!(exclude_with_context("app", &format!("x\n{line}\n"), "", ""), None, "info/exclude {line:?}");
            assert_eq!(exclude_with_context("app", "", &format!("{line}\r\n"), ""), None, "root .gitignore {line:?}");
        }
        for line in ["context", "context/", "/context", "/context/"] {
            assert_eq!(exclude_with_context("app", "", "", line), None, "main .gitignore {line:?}");
            assert_eq!(exclude_with_context("", line, "", ""), None, "info/exclude at the root {line:?}");
        }
    }

    #[test]
    fn a_line_that_ignores_another_folder_does_not_count() {
        for (exclude, root, main) in
            [("/context/", "", ""), ("", "/context", ""), ("", "", "app/context/"), ("# context/", "!context/", ""), ("other/context/", "", "")]
        {
            assert!(exclude_with_context("app", exclude, root, main).is_some(), "{exclude:?} {root:?} {main:?}");
        }
    }

    #[test]
    fn a_worktree_git_file_leads_to_the_common_dir() {
        assert_eq!(gitdir_of("/r/wt", "gitdir: /r/main/.git/worktrees/wt\n").as_deref(), Some("/r/main/.git/worktrees/wt"));
        assert_eq!(gitdir_of("/r/wt", "gitdir: ../main/.git/worktrees/wt").as_deref(), Some("/r/main/.git/worktrees/wt"));
        assert_eq!(join("/r/main/.git/worktrees/wt", "../.."), Some("/r/main/.git".into()));
        assert_eq!(gitdir_of("/r", "nonsense"), None);
        assert_eq!(join("/", "../../x"), None, "nothing above /");
        assert_eq!(relative("/r", "/r/a/b").as_deref(), Some("a/b"));
        assert_eq!(relative("/r", "/r").as_deref(), Some(""));
        assert_eq!(relative("/", "/a").as_deref(), Some("a"));
        assert_eq!(relative("/r", "/rx/a"), None);
    }

    fn docx(document_xml: &str) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("[Content_Types].xml", deflated).unwrap();
        zip.write_all(b"<Types/>").unwrap();
        zip.start_file("word/document.xml", deflated).unwrap();
        zip.write_all(document_xml.as_bytes()).unwrap();
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn a_docx_gives_its_paragraphs_as_lines() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Launch code:</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> 7 &amp; 9 &lt;ok&gt; &#233;&#x2713;</w:t></w:r></w:p>
<w:p/>
<w:p><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>Second</w:t><w:br/><w:t>line</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>
</w:body></w:document>"#;
        assert_eq!(extract_text("Brief.DOCX", &docx(xml)).as_deref(), Some("Launch code:\t 7 & 9 <ok> é✓\n\nSecond\nline\n"));
        assert_eq!(extract_text("empty.docx", &docx("<w:document><w:body><w:p/></w:body></w:document>")), None, "no text");
        assert_eq!(extract_text("broken.docx", b"PK not a zip"), None);
    }

    fn pdf(text: &str) -> Vec<u8> {
        use lopdf::content::{Content, Operation};
        use lopdf::{dictionary, Document, Object, Stream};
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier" });
        let resources_id = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font_id } });
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 24.into()]),
                Operation::new("Td", vec![72.into(), 700.into()]),
                Operation::new("Tj", vec![Object::string_literal(text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        let page_id = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => content_id });
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn a_pdf_gives_its_text() {
        let text = extract_text("Report.pdf", &pdf("The vault code is 4471")).expect("text");
        assert!(text.contains("The vault code is 4471"), "{text:?}");
        assert_eq!(extract_text("scan.pdf", b"%PDF-1.4 not really"), None);
    }

    #[tokio::test]
    async fn extraction_off_the_runtime_survives_a_bad_file() {
        assert_eq!(extract("x.pdf".into(), vec![0xff; 4096]).await, None);
        assert!(extract("r.pdf".into(), pdf("hello pdf")).await.unwrap().contains("hello pdf"));
    }

    #[test]
    fn plain_text_is_utf8_without_a_nul_up_front() {
        assert_eq!(extract_text("notes.md", "\u{feff}# Notes\nnaïve ✓\n".as_bytes()).as_deref(), Some("# Notes\nnaïve ✓\n"));
        assert_eq!(extract_text("Makefile", b"all:\n\techo hi\n").as_deref(), Some("all:\n\techo hi\n"));
        assert_eq!(extract_text("empty.txt", b"").as_deref(), Some(""));
        assert_eq!(extract_text("logo.png", b"\x89PNG\r\n\x1a\n\0\0"), None);
        assert_eq!(extract_text("latin1.txt", b"caf\xe9"), None);
        let mut late_nul = vec![b'a'; 5000];
        late_nul.push(0);
        assert!(extract_text("late.txt", &late_nul).is_some(), "only the first 4 KiB are checked for NUL");
        assert_eq!(extract_text("huge.txt", &vec![b'a'; EXTRACTED_MAX_BYTES + 1]), None);
    }
}
