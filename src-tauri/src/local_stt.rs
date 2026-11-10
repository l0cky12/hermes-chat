//! Speech to text on this computer, and where each recording goes (#220 and #192; ADR 0067 and ADR 0065).
//!
//! Finds the engines already installed here, keeps which one the owner picked, downloads Whisper models for whisper.cpp
//! into the app's data folder, and decides, inside `hermes_transcribe`, where a Dictation or Voice conversation
//! recording is transcribed: on Hermes, on this computer, or one with the other as its backup. With "This computer" and
//! no backup, a recording never goes to Hermes, whatever the webview asks.
//!
//! Only programs found on `PATH` under a known engine's name, or one the owner picked in the native Open dialog, are
//! ever run, and only with an argument list built here: no shell. The webview names an engine and model only by
//! choosing among what Rust found or was given through a dialog. The recording goes to a private folder (0700; on
//! Windows, the user's own temp folder's ACL) that is deleted once the text is read, and the engine is killed after a timeout. The choice lives in `local-stt.json` in the
//! app's config folder, for this computer, not per connection or profile.
use std::ffi::{OsStr, OsString};
use std::future::Future;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State as Managed};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::watch;

use crate::transport::Transcript;

const SETTINGS_FILE: &str = "local-stt.json";
/// Serializes the settings file's read-modify-write between this app's commands.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
/// The largest recording taken: Hermes's own limit on one to transcribe, so both sides take the same recordings.
/// Dictation's five minutes of 16 kHz 16-bit mono WAV is 9.6 MB.
const MAX_WAV_BYTES: usize = 25 * 1024 * 1024;

/// How long the primary gets before the backup runs instead, unless the owner sets another time.
pub const DEFAULT_TIMEOUT_SECONDS: u64 = 30;
pub const MIN_TIMEOUT_SECONDS: u64 = 5;
pub const MAX_TIMEOUT_SECONDS: u64 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    WhisperCpp,
    /// faster-whisper's command line, `whisper-ctranslate2`.
    FasterWhisper,
    OpenaiWhisper,
    Vosk,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::WhisperCpp => "whisper.cpp",
            Kind::FasterWhisper => "faster-whisper",
            Kind::OpenaiWhisper => "OpenAI Whisper",
            Kind::Vosk => "Vosk",
        }
    }
    /// Its model is a folder rather than one file.
    fn model_is_folder(self) -> bool {
        matches!(self, Kind::FasterWhisper | Kind::Vosk)
    }
}

/// The program names looked for on `PATH`.
const NAMES: [&str; 5] = ["whisper-cli", "whisper-cpp", "whisper", "whisper-ctranslate2", "vosk-transcriber"];

/// What follows a program's name in its file name: nothing on Linux, where the mode says what runs; on Windows, the
/// extensions Windows runs (pip's and whisper.cpp's programs are `.exe`), in the order looked for.
#[cfg(unix)]
pub const PROGRAM_SUFFIXES: &[&str] = &[""];
#[cfg(windows)]
pub const PROGRAM_SUFFIXES: &[&str] = &[".exe", ".cmd", ".bat", ".com"];

/// A program's name without the suffix its platform gives it (`whisper-cli.exe` is `whisper-cli` on Windows, where
/// case doesn't count), or `None` when it has none of `suffixes`.
pub fn program_name(file_name: &str, suffixes: &[&str]) -> Option<String> {
    suffixes.iter().find_map(|suffix| {
        let cut = file_name.len().checked_sub(suffix.len())?;
        let (name, end) = (file_name.get(..cut)?, file_name.get(cut..)?);
        end.eq_ignore_ascii_case(suffix).then(|| if suffix.is_empty() { name.to_owned() } else { name.to_ascii_lowercase() })
    })
}

/// Which engine a program is, by its file name. `whisper` is both whisper.cpp's old name and OpenAI Whisper's Python
/// script, so a script (`#!`) is OpenAI's. On Windows pip installs that script as a launcher `.exe` with the script
/// zipped onto its end, so one with a `__main__.py` in its last bytes is OpenAI's.
pub fn kind_of(binary: &Path) -> Option<Kind> {
    match program_name(binary.file_name()?.to_str()?, PROGRAM_SUFFIXES)?.as_str() {
        "whisper-cli" | "whisper-cpp" => Some(Kind::WhisperCpp),
        "whisper-ctranslate2" => Some(Kind::FasterWhisper),
        "vosk-transcriber" => Some(Kind::Vosk),
        "whisper" => {
            let mut head = [0u8; 2];
            let script = std::fs::File::open(binary).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head)).is_ok() && &head == b"#!";
            #[cfg(windows)]
            let script = script || is_pip_launcher(binary);
            Some(if script { Kind::OpenaiWhisper } else { Kind::WhisperCpp })
        }
        _ => None,
    }
}

/// A pip console-script launcher: an `.exe` with a zip holding `__main__.py` appended, whose directory is at the end.
#[cfg(windows)]
fn is_pip_launcher(binary: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 64 * 1024;
    let Ok(mut f) = std::fs::File::open(binary) else { return false };
    let Ok(len) = f.seek(SeekFrom::End(0)) else { return false };
    let mut tail = Vec::new();
    if f.seek(SeekFrom::Start(len.saturating_sub(TAIL))).is_err() || f.read_to_end(&mut tail).is_err() {
        return false;
    }
    tail.windows(b"__main__.py".len()).any(|w| w == b"__main__.py")
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Windows runs a file by its extension, not a mode.
#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    let named = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| program_name(n, PROGRAM_SUFFIXES).is_some());
    named && std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// The engines on `path` (a `PATH` value): for each known name, the first executable with it, as the shell would run.
pub fn on_path(path: &OsStr) -> Vec<(Kind, PathBuf)> {
    NAMES
        .iter()
        .filter_map(|name| {
            std::env::split_paths(path)
                .flat_map(|dir| PROGRAM_SUFFIXES.iter().map(move |suffix| dir.join(format!("{name}{suffix}"))))
                .find(|p| p.is_absolute() && is_executable(p))
        })
        .filter_map(|p| Some((kind_of(&p)?, p)))
        .collect()
}

/// The folders models usually sit in: the XDG data and cache folders (on Windows `%LOCALAPPDATA%` and `~\.cache`,
/// which OpenAI Whisper, Hugging Face and Vosk use there too), Hugging Face's cache, the home folder, and the folder
/// this app downloads whisper.cpp models into.
pub struct Places {
    pub home: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub hf: PathBuf,
    pub app_models: Option<PathBuf>,
}

impl Places {
    fn from_env(app_models: Option<PathBuf>) -> Self {
        let var = |name: &str, or: PathBuf| std::env::var_os(name).filter(|v| !v.is_empty()).map_or(or, PathBuf::from);
        #[cfg(unix)]
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        #[cfg(unix)]
        let data = var("XDG_DATA_HOME", home.join(".local/share"));
        #[cfg(windows)]
        let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
        #[cfg(windows)]
        let data = var("LOCALAPPDATA", home.join(r"AppData\Local"));
        let cache = var("XDG_CACHE_HOME", home.join(".cache"));
        let hf = var("HF_HOME", cache.join("huggingface"));
        Places { home, data, cache, hf, app_models }
    }
}

fn children(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
    out.sort();
    out
}

fn name_of(p: &Path) -> &str {
    p.file_name().and_then(|n| n.to_str()).unwrap_or("")
}

/// The system's shared data folders, and Vosk's models among them. Windows has none that these engines use.
#[cfg(unix)]
const SYSTEM_SHARES: &[&str] = &["/usr/share", "/usr/local/share"];
#[cfg(unix)]
const SYSTEM_VOSK: &[&str] = &["/usr/share/vosk"];
#[cfg(windows)]
const SYSTEM_SHARES: &[&str] = &[];
#[cfg(windows)]
const SYSTEM_VOSK: &[&str] = &[];

/// The models of `kind` in their usual folders under `places` (and the system's `/usr/share`, `/usr/local/share`).
pub fn models(kind: Kind, places: &Places) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = match kind {
        Kind::WhisperCpp => {
            // This app's downloads first, then `whisper.cpp`, `whisper.cpp-model-base.en` and the like under each share
            // folder, and their `models`. A download in progress is a hidden `.part` file, so it isn't listed.
            let mut dirs: Vec<PathBuf> = places.app_models.iter().cloned().collect();
            dirs.extend([places.cache.join("whisper.cpp"), places.home.join("whisper.cpp/models")]);
            for share in std::iter::once(places.data.clone()).chain(SYSTEM_SHARES.iter().map(PathBuf::from)) {
                for d in children(&share).into_iter().filter(|d| name_of(d).starts_with("whisper")) {
                    dirs.push(d.join("models"));
                    dirs.push(d);
                }
            }
            let ggml = |p: &PathBuf| name_of(p).starts_with("ggml-") && name_of(p).ends_with(".bin") && p.is_file();
            dirs.iter().flat_map(|d| children(d)).filter(ggml).collect()
        }
        Kind::OpenaiWhisper => children(&places.cache.join("whisper")).into_iter().filter(|p| name_of(p).ends_with(".pt") && p.is_file()).collect(),
        Kind::FasterWhisper => children(&places.hf.join("hub"))
            .into_iter()
            .filter(|d| name_of(d).starts_with("models--") && name_of(d).contains("whisper"))
            .flat_map(|d| children(&d.join("snapshots")))
            .filter(|s| s.join("model.bin").exists())
            .collect(),
        Kind::Vosk => [places.cache.join("vosk"), places.data.join("vosk")]
            .into_iter()
            .chain(SYSTEM_VOSK.iter().map(PathBuf::from))
            .collect::<Vec<_>>()
            .iter()
            .flat_map(|d| children(d))
            .filter(|d| d.join("am").is_dir())
            .collect(),
    };
    found.dedup();
    found
}

/// An engine to run: its program and model, which the owner picked from what was found or through a dialog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Engine {
    pub kind: Kind,
    pub binary: PathBuf,
    pub model: Option<PathBuf>,
}

/// The owner's choice. `on_this_computer`: this computer is the primary, else Hermes is (as before this setting).
/// `backup`: the other one transcribes the same recording when the primary fails or takes over `timeout_seconds`.
/// `language`: `auto` or a Whisper language code, for the Whisper engines here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub on_this_computer: bool,
    #[serde(default)]
    pub engine: Option<Engine>,
    #[serde(default)]
    pub backup: bool,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    #[serde(default = "default_language")]
    pub language: String,
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECONDS
}

fn default_language() -> String {
    "auto".into()
}

impl Default for Settings {
    fn default() -> Self {
        Settings { on_this_computer: false, engine: None, backup: false, timeout_seconds: DEFAULT_TIMEOUT_SECONDS, language: default_language() }
    }
}

impl Settings {
    /// A timeout out of range is brought into it, and a language that isn't one is `auto`. Where a recording goes is
    /// never guessed: a file that doesn't parse is an error (`read_settings`).
    fn sanitized(mut self) -> Self {
        self.timeout_seconds = self.timeout_seconds.clamp(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
        if !valid_language(&self.language) {
            self.language = default_language();
        }
        self
    }
}

/// `auto`, or a Whisper language code: two or three lowercase letters (`en`, `haw`, `yue`).
pub fn valid_language(language: &str) -> bool {
    language == "auto" || ((2..=3).contains(&language.len()) && language.bytes().all(|b| b.is_ascii_lowercase()))
}

/// The settings, or the default when there is no file yet. A file that can't be read is an error, not the default:
/// the default sends recordings to Hermes, which the owner may have turned off.
fn read_settings(path: &Path) -> Result<Settings, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Settings>(&text)
            .map(Settings::sanitized)
            .map_err(|e| format!("The speech-to-text setting in {} can't be read: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(format!("The speech-to-text setting in {} can't be read: {e}", path.display())),
    }
}

/// Writes the file whole (a temp file renamed over it), then reads it back: what is returned is what was stored.
fn write_settings(path: &Path, settings: &Settings) -> Result<Settings, String> {
    let dir = path.parent().ok_or("No folder for the speech-to-text setting.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let text = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })?;
    let back = read_settings(path)?;
    if &back != settings {
        return Err("The speech-to-text setting didn't read back as it was saved.".into());
    }
    Ok(back)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join(SETTINGS_FILE))
}

/// Where this app downloads whisper.cpp models.
fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("whisper-models"))
}

/// Why `engine` can't run now, or `None`.
pub fn problem(engine: Option<&Engine>) -> Option<String> {
    let Some(e) = engine else { return Some("No speech-to-text engine is chosen on this computer.".into()) };
    if !is_executable(&e.binary) {
        return Some(format!("{} isn't at {} any more, or can't be run.", e.kind.label(), e.binary.display()));
    }
    let Some(model) = &e.model else { return Some(format!("No model is chosen for {}.", e.kind.label())) };
    let there = if e.kind.model_is_folder() { model.is_dir() } else { model.is_file() };
    if !there {
        return Some(format!("The model {} isn't there any more.", model.display()));
    }
    None
}

/// The arguments that have `engine` transcribe `wav` into `<out>/audio.txt`, in `language` (`auto`: the engine
/// detects it). Each is one argument: nothing is parsed by a shell. The input file is named `audio.wav`, so the
/// Whisper command lines name their output `audio.txt`. Vosk's language is its model's.
pub fn args(engine: &Engine, model: &Path, wav: &Path, out: &Path, language: &str) -> Vec<OsString> {
    let s = |v: &str| OsString::from(v);
    let p = |v: &Path| v.as_os_str().to_owned();
    let lang = |mut v: Vec<OsString>| {
        if language != "auto" {
            v.extend([s("--language"), s(language)]);
        }
        v
    };
    match engine.kind {
        // `-l auto`: a multilingual model detects the language; an English-only one ignores it. `-np`: results only.
        Kind::WhisperCpp => vec![s("-m"), p(model), s("-f"), p(wav), s("-l"), s(language), s("-nt"), s("-np"), s("-otxt"), s("-of"), p(&out.join("audio"))],
        Kind::FasterWhisper => {
            lang(vec![p(wav), s("--model_directory"), p(model), s("--output_dir"), p(out), s("--output_format"), s("txt"), s("--verbose"), s("False")])
        }
        Kind::OpenaiWhisper => lang(vec![
            p(wav),
            s("--model"),
            p(model),
            s("--output_dir"),
            p(out),
            s("--output_format"),
            s("txt"),
            s("--verbose"),
            s("False"),
            s("--fp16"),
            s("False"),
        ]),
        Kind::Vosk => vec![s("-m"), p(model), s("-i"), p(wav), s("-o"), p(&out.join("audio.txt"))],
    }
}

/// An engine's output as one line of text, without the lines that are only a note in brackets: whisper.cpp's
/// `[BLANK_AUDIO]`, `(silence)`, `*music*`. So silence is empty.
pub fn clean(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| {
            let bracketed = |open: char, close: char| l.len() > 1 && l.starts_with(open) && l.ends_with(close);
            !(bracketed('[', ']') || bracketed('(', ')') || bracketed('*', '*'))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// An engine's program to run, without a console window flashing up on Windows.
fn command(program: &Path) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut command = tokio::process::Command::new(program);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

/// A private folder for one recording, deleted with everything in it when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> std::io::Result<Self> {
        use std::sync::atomic::AtomicU64;
        static N: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!("hermes-chat-stt-{}-{nanos}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        // `create`, not `create_all`: it fails if anything, a link included, is already there. On Windows the folder
        // takes the ACL of the user's own temp folder.
        #[allow(unused_mut)]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&dir)?;
        Ok(Scratch(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// How long an engine may take: a minute to load, plus three times the recording's length.
fn time_limit(wav_bytes: usize) -> Duration {
    Duration::from_secs(60 + 3 * (wav_bytes.saturating_sub(44) / 32_000) as u64)
}

/// Has `engine` transcribe a WAV recording in `language`, within `limit`. The recording is written to a private folder
/// that is deleted afterwards, whatever happens. Errors say why, for the owner.
pub async fn transcribe(engine: &Engine, wav: &[u8], limit: Duration, language: &str) -> Result<Transcript, String> {
    if let Some(why) = problem(Some(engine)) {
        return Err(why);
    }
    if wav.len() > MAX_WAV_BYTES {
        return Err(format!("The recording is over {} MB.", MAX_WAV_BYTES / 1024 / 1024));
    }
    let model = engine.model.as_deref().expect("checked by problem");
    let scratch = Scratch::new().map_err(|e| format!("Couldn't make a private folder for the recording: {e}"))?;
    let wav_path = scratch.0.join("audio.wav");
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut f = options.open(&wav_path).map_err(|e| format!("Couldn't save the recording to transcribe: {e}"))?;
        f.write_all(wav).map_err(|e| format!("Couldn't save the recording to transcribe: {e}"))?;
    }
    let label = engine.kind.label();
    let child = command(&engine.binary)
        .args(args(engine, model, &wav_path, &scratch.0, language))
        .current_dir(&scratch.0)
        // faster-whisper's model is already here; it must never fetch one.
        .env("HF_HUB_OFFLINE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("{label} couldn't be started: {e}"))?;
    let out = match tokio::time::timeout(limit, child.wait_with_output()).await {
        Err(_) => return Err(format!("{label} took longer than {} s, so it was stopped.", limit.as_secs())),
        Ok(r) => r.map_err(|e| format!("{label} failed: {e}"))?,
    };
    if !out.status.success() {
        // whisper-ctranslate2 prints some of its errors on stdout, so that is the fallback.
        let last_line = |b: &[u8]| String::from_utf8_lossy(b).lines().rev().map(str::trim).find(|l| !l.is_empty()).map(str::to_owned);
        let last = last_line(&out.stderr).or_else(|| last_line(&out.stdout)).unwrap_or_else(|| "no message".into());
        let how = out.status.code().map_or_else(|| "was killed".to_string(), |c| format!("exited with {c}"));
        return Err(format!("{label} {how}: {}", last.chars().filter(|c| !c.is_control()).take(300).collect::<String>()));
    }
    let text = std::fs::read_to_string(scratch.0.join("audio.txt")).map_err(|e| format!("{label} finished but wrote no transcript: {e}"))?;
    Ok(Transcript { text: clean(&text), provider: Some(label.into()) })
}

// ---------------------------------------------------------------------------------------------------------------------
// Where a recording goes: the primary, then, if it fails, the backup (ADR 0065).

/// One of the two places a recording can be transcribed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Server,
    Local,
}

impl Side {
    pub fn other(self) -> Side {
        match self {
            Side::Server => Side::Local,
            Side::Local => Side::Server,
        }
    }
    fn who(self) -> &'static str {
        match self {
            Side::Server => "Hermes",
            Side::Local => "This computer",
        }
    }
    pub fn parse(v: &str) -> Option<Side> {
        match v {
            "server" => Some(Side::Server),
            "local" => Some(Side::Local),
            _ => None,
        }
    }
}

/// The primary didn't give the text, and why: the backup did.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FellBack {
    pub from: Side,
    pub why: String,
}

/// A transcript, where it ran, and whether the backup gave it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Routed {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub ran: Side,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fell_back: Option<FellBack>,
}

pub const CANCELLED: &str = "Cancelled.";

/// "Hermes couldn't transcribe it: …", "This computer couldn't transcribe it either: …", without saying it twice.
pub fn couldnt(side: Side, why: &str, either: bool) -> String {
    let mut reason = why.trim();
    for who in ["Hermes", "This computer"] {
        if let Some(rest) = reason.strip_prefix(who).and_then(|r| r.strip_prefix(" couldn't transcribe")) {
            if let Some((_, after)) = rest.split_once(':') {
                reason = after.trim_start();
            }
        }
    }
    let end = if reason.ends_with(['.', '!', '?']) { "" } else { "." };
    format!("{} couldn't transcribe it{}: {reason}{end}", side.who(), if either { " either" } else { "" })
}

/// The sides a recording is tried on, in order. `only`: one side alone, as Settings → Voice's Test asks; Hermes only
/// when it is in the route, so a recording the owner keeps on this computer can't be sent to Hermes that way either.
pub fn order(settings: &Settings, only: Option<Side>) -> Result<Vec<Side>, String> {
    let primary = if settings.on_this_computer { Side::Local } else { Side::Server };
    match only {
        Some(Side::Server) if primary == Side::Local && !settings.backup => {
            Err("Speech to text runs only on this computer, so the recording isn't sent to Hermes.".into())
        }
        Some(side) => Ok(vec![side]),
        None if settings.backup => Ok(vec![primary, primary.other()]),
        None => Ok(vec![primary]),
    }
}

type Run<'a> = Pin<Box<dyn Future<Output = Result<Transcript, String>> + Send + 'a>>;

/// Resolves once `cancel` is set; never, if its sender is gone without setting it.
async fn cancelled(mut cancel: watch::Receiver<bool>) {
    if cancel.wait_for(|c| *c).await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// Tries `sides` in order, each at most once, on the one recording `server` and `local` would transcribe; neither
/// future is started unless its side is tried. The first side gets `timeout` when one is given (a backup is waiting),
/// and an answer after that is dropped. An empty transcript is an answer: the owner said nothing. Once `cancel` is set,
/// the side running is dropped (a local engine is killed) and nothing more is tried.
///
/// Errors: one side alone says its own error (Hermes's unchanged; this computer's as "This computer couldn't
/// transcribe it: …", unless `plain`); both say what each said.
pub async fn route<'a>(
    sides: &[Side],
    timeout: Option<Duration>,
    plain: bool,
    server: impl Future<Output = Result<Transcript, String>> + Send + 'a,
    local: impl Future<Output = Result<Transcript, String>> + Send + 'a,
    cancel: watch::Receiver<bool>,
) -> Result<Routed, String> {
    let mut server: Option<Run<'a>> = Some(Box::pin(server));
    let mut local: Option<Run<'a>> = Some(Box::pin(local));
    let mut tried: Vec<(Side, String)> = Vec::new();
    for (i, &side) in sides.iter().enumerate() {
        if *cancel.borrow() {
            return Err(CANCELLED.into());
        }
        let Some(run) = (match side {
            Side::Server => server.take(),
            Side::Local => local.take(),
        }) else {
            continue;
        };
        let timed = timeout.filter(|_| i == 0);
        let run = async move {
            match timed {
                Some(t) => tokio::time::timeout(t, run).await.unwrap_or_else(|_| Err(format!("It took longer than {} s.", t.as_secs()))),
                None => run.await,
            }
        };
        let got = tokio::select! {
            biased;
            () = cancelled(cancel.clone()) => return Err(CANCELLED.into()),
            got = run => got,
        };
        match got {
            Ok(t) => {
                let fell_back = tried.into_iter().next().map(|(from, why)| FellBack { from, why });
                return Ok(Routed { text: t.text, provider: t.provider, ran: side, fell_back });
            }
            Err(why) => tried.push((side, why)),
        }
    }
    Err(match tried.as_slice() {
        [(Side::Server, why)] => why.clone(),
        [(Side::Local, why)] if plain => why.clone(),
        [(side, why)] => couldnt(*side, why, false),
        [(first, a), (second, b)] => format!("{} {}", couldnt(*first, a, false), couldnt(*second, b, true)),
        _ => "Nothing could transcribe the recording.".into(),
    })
}

/// Transcribes a recording where the settings at `path` say: `server` is Hermes's transcribing, started only if Hermes
/// is tried. `only`: one side alone (Test). A settings file that can't be read is an error, never "Hermes".
pub async fn transcribe_routed_at<'a>(
    path: &Path,
    mime: &str,
    wav: &'a [u8],
    only: Option<Side>,
    cancel: watch::Receiver<bool>,
    server: impl Future<Output = Result<Transcript, String>> + Send + 'a,
) -> Result<Routed, String> {
    let settings = read_settings(path)?;
    let sides = order(&settings, only)?;
    let timeout = (only.is_none() && settings.backup).then(|| Duration::from_secs(settings.timeout_seconds));
    let engine = settings.engine.clone();
    let language = settings.language.clone();
    let mime = mime.to_owned();
    let local = async move {
        if mime != "audio/wav" {
            return Err(format!("This computer's engine takes WAV recordings, not {mime}."));
        }
        let Some(engine) = engine else { return Err(problem(None).unwrap_or_default()) };
        transcribe(&engine, wav, time_limit(wav.len()), &language).await
    };
    route(&sides, timeout, only.is_some(), server, local, cancel).await
}

/// `transcribe_routed_at` with this app's settings, cancelled by `local_stt_cancel` with the same `run` id.
pub async fn transcribe_routed<'a>(
    app: &AppHandle,
    mime: &str,
    wav: &'a [u8],
    only: Option<Side>,
    run: Option<String>,
    server: impl Future<Output = Result<Transcript, String>> + Send + 'a,
) -> Result<Routed, String> {
    let path = settings_path(app)?;
    let ticket = run.map(Ticket::new);
    let cancel = ticket.as_ref().map_or_else(|| watch::channel(false).1, |t| t.cancel.clone());
    transcribe_routed_at(&path, mime, wav, only, cancel, server).await
}

/// The transcriptions running, by the webview's id, and cancels that came before their transcription did (kept a
/// minute, so a cancel sent just after the recording isn't lost to the order the two commands arrive in).
static RUNS: Mutex<Vec<RunEntry>> = Mutex::new(Vec::new());
/// One of `RUNS`: the webview's run id, the cancel its transcription watches, when it was entered, and whether the
/// transcription has started (false while only a cancel has arrived).
type RunEntry = (String, watch::Sender<bool>, Instant, bool);
const EARLY_CANCEL_KEPT: Duration = Duration::from_secs(60);
/// The most cancels kept waiting for their transcription; the oldest go first.
const EARLY_CANCELS_MAX: usize = 64;

/// Drops cancels that waited too long for their transcription (or came after it ended), and the oldest past the most.
fn prune(runs: &mut Vec<(String, watch::Sender<bool>, Instant, bool)>) {
    runs.retain(|(_, _, at, running)| *running || at.elapsed() < EARLY_CANCEL_KEPT);
    let waiting = runs.iter().filter(|(.., running)| !running).count();
    let mut over = waiting.saturating_sub(EARLY_CANCELS_MAX);
    // Oldest first: they are pushed in order.
    runs.retain(|(.., running)| {
        if *running || over == 0 {
            return true;
        }
        over -= 1;
        false
    });
}

/// A transcription's place in `RUNS`, taken out when it ends.
struct Ticket {
    id: String,
    cancel: watch::Receiver<bool>,
}

impl Ticket {
    fn new(id: String) -> Ticket {
        let mut runs = RUNS.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut runs);
        let cancel = match runs.iter_mut().find(|(i, ..)| *i == id) {
            Some((_, tx, _, running)) => {
                *running = true;
                tx.subscribe()
            }
            None => {
                let (tx, rx) = watch::channel(false);
                runs.push((id.clone(), tx, Instant::now(), true));
                rx
            }
        };
        Ticket { id, cancel }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        RUNS.lock().unwrap_or_else(|e| e.into_inner()).retain(|(i, ..)| *i != self.id);
    }
}

/// Stops the transcription the webview started with this `run` id: what runs is dropped, and the backup isn't tried.
#[tauri::command]
pub fn local_stt_cancel(run: String) {
    let mut runs = RUNS.lock().unwrap_or_else(|e| e.into_inner());
    match runs.iter().find(|(i, ..)| *i == run) {
        Some((_, tx, ..)) => {
            tx.send_replace(true);
        }
        None => {
            let (tx, _) = watch::channel(true);
            runs.push((run, tx, Instant::now(), false));
            prune(&mut runs);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Whisper models for whisper.cpp, downloaded into this app's data folder (ADR 0065).

/// A Whisper model this app can download: its size name, exact byte count and SHA-256, as whisper.cpp's Hugging Face
/// repository (`ggerganov/whisper.cpp`, branch `main`) lists them (its LFS object ids, read 2026-11-04).
#[derive(Debug, Clone, Copy)]
pub struct ModelInfo {
    pub name: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

impl ModelInfo {
    pub fn file_name(&self) -> String {
        format!("ggml-{}.bin", self.name)
    }
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo { name: "tiny", bytes: 77_691_713, sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" },
    ModelInfo { name: "base", bytes: 147_951_465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" },
    ModelInfo { name: "small", bytes: 487_601_967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" },
    ModelInfo { name: "medium", bytes: 1_533_763_059, sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208" },
    ModelInfo { name: "large-v3", bytes: 3_095_033_483, sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2" },
];

/// Where the models are downloaded from: whisper.cpp's own repository, at a file name from `MODELS` only.
pub const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

pub fn model_info(name: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.name == name)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A download's progress, as the webview's Channel gets it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub name: String,
    pub done: u64,
    pub total: u64,
}

/// Downloads `info` from `base_url` into `dir`: to a hidden `.part` file, checked for its exact size and SHA-256, then
/// renamed into place. Anything else is deleted, so a wrong or partial file is never taken as the model.
pub async fn download_model(
    client: &reqwest::Client,
    base_url: &str,
    dir: &Path,
    info: &ModelInfo,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<PathBuf, String> {
    use tokio::io::AsyncWriteExt;
    tokio::fs::create_dir_all(dir).await.map_err(|e| format!("Couldn't make the models folder: {e}"))?;
    let dest = dir.join(info.file_name());
    let part = dir.join(format!(".{}.part", info.file_name()));
    let result = async {
        let mut response = interruptible(cancel, client.get(format!("{base_url}{}", info.file_name())).send())
            .await?
            .map_err(|e| format!("Couldn't reach the download: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("The download answered {}.", response.status()));
        }
        let mut file = tokio::fs::File::create(&part).await.map_err(|e| format!("Couldn't write the model: {e}"))?;
        let mut hash = Sha256::new();
        let mut done: u64 = 0;
        while let Some(chunk) = interruptible(cancel, response.chunk()).await?.map_err(|e| format!("The download broke off: {e}"))? {
            done += chunk.len() as u64;
            if done > info.bytes {
                return Err("The download is bigger than the model should be, so it was dropped.".into());
            }
            hash.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| format!("Couldn't write the model: {e}"))?;
            progress(done);
        }
        file.flush().await.map_err(|e| e.to_string())?;
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
        // A cancel that came with the last chunk, or while the file was written out, still wins.
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        if done != info.bytes {
            return Err(format!("The download ended at {done} of {} bytes.", info.bytes));
        }
        if hex(&hash.finalize()) != info.sha256 {
            return Err("The download doesn't match the model's checksum, so it was dropped.".into());
        }
        tokio::fs::rename(&part, &dest).await.map_err(|e| format!("Couldn't put the model in place: {e}"))?;
        Ok(dest.clone())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    result
}

/// How long a download may go without a byte before it is given up.
pub const DOWNLOAD_STALL: Duration = Duration::from_secs(60);

/// Waits for `step`, but gives up as soon as `cancel` is set (checked every 100 ms) or after `DOWNLOAD_STALL` with
/// nothing: a server that stops sending can't hold the download, and its slot, for ever.
async fn interruptible<T>(cancel: &AtomicBool, step: impl Future<Output = T>) -> Result<T, String> {
    let cancelled = async {
        while !cancel.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    if cancel.load(Ordering::Relaxed) {
        return Err(CANCELLED.into());
    }
    tokio::select! {
        biased;
        () = cancelled => Err(CANCELLED.into()),
        out = step => Ok(out),
        () = tokio::time::sleep(DOWNLOAD_STALL) => Err(format!("The download stalled: nothing came for {} s.", DOWNLOAD_STALL.as_secs())),
    }
}

/// A model size as Settings lists it: its size, whether it is downloaded (the file is there at its exact size), and
/// its path, to choose it as whisper.cpp's model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelState {
    pub name: String,
    pub bytes: u64,
    pub downloaded: bool,
    pub path: PathBuf,
}

/// The downloadable sizes, the folder they go in, and the download running, if any.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Models {
    pub dir: PathBuf,
    pub models: Vec<ModelState>,
    pub downloading: Option<DownloadProgress>,
}

/// The download running (one at a time) and its cancel flag.
#[derive(Default)]
pub struct Downloads(Mutex<Option<(DownloadProgress, Arc<AtomicBool>)>>);

impl Downloads {
    fn now(&self) -> Option<DownloadProgress> {
        self.0.lock().ok()?.as_ref().map(|(p, _)| p.clone())
    }
}

pub fn models_in(dir: &Path, downloading: Option<DownloadProgress>) -> Models {
    let models = MODELS
        .iter()
        .map(|m| {
            let path = dir.join(m.file_name());
            let downloaded = std::fs::metadata(&path).is_ok_and(|md| md.is_file() && md.len() == m.bytes);
            ModelState { name: m.name.into(), bytes: m.bytes, downloaded, path }
        })
        .collect();
    Models { dir: dir.to_owned(), models, downloading }
}

#[tauri::command]
pub fn local_stt_models(app: AppHandle, downloads: Managed<'_, Downloads>) -> Result<Models, String> {
    Ok(models_in(&models_dir(&app)?, downloads.now()))
}

/// Downloads a model size into the models folder, reporting progress on `on_progress`. One download runs at a time.
#[tauri::command]
pub async fn local_stt_download(
    app: AppHandle,
    downloads: Managed<'_, Downloads>,
    name: String,
    on_progress: Channel<DownloadProgress>,
) -> Result<Models, String> {
    let info = model_info(&name).ok_or_else(|| format!("There's no Whisper model called {name}."))?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut held = downloads.0.lock().map_err(|e| e.to_string())?;
        if let Some((running, _)) = held.as_ref() {
            return Err(format!("The {} model is downloading already.", running.name));
        }
        *held = Some((DownloadProgress { name: name.clone(), done: 0, total: info.bytes }, cancel.clone()));
    }
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string());
    let dir = models_dir(&app);
    let result = match (client, &dir) {
        (Ok(client), Ok(dir)) => {
            let mut last = Instant::now();
            download_model(&client, MODEL_BASE_URL, dir, info, &cancel, |done| {
                if let Ok(mut held) = downloads.0.lock() {
                    if let Some((p, _)) = held.as_mut() {
                        p.done = done;
                    }
                }
                if last.elapsed() >= Duration::from_millis(200) || done == info.bytes {
                    last = Instant::now();
                    let _ = on_progress.send(DownloadProgress { name: name.clone(), done, total: info.bytes });
                }
            })
            .await
        }
        (Err(e), _) => Err(e),
        (_, Err(e)) => Err(e.clone()),
    };
    if let Ok(mut held) = downloads.0.lock() {
        *held = None;
    }
    result?;
    Ok(models_in(&dir?, None))
}

#[tauri::command]
pub fn local_stt_cancel_download(downloads: Managed<'_, Downloads>) {
    if let Ok(held) = downloads.0.lock() {
        if let Some((_, cancel)) = held.as_ref() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// Deletes a downloaded model size from the models folder. Only those five files can be deleted this way; a model
/// found elsewhere or picked in a dialog is never deleted.
#[tauri::command]
pub fn local_stt_delete(app: AppHandle, downloads: Managed<'_, Downloads>, name: String) -> Result<Models, String> {
    let info = model_info(&name).ok_or_else(|| format!("There's no Whisper model called {name}."))?;
    if downloads.now().is_some_and(|d| d.name == name) {
        return Err(format!("The {name} model is still downloading. Cancel it first."));
    }
    let dir = models_dir(&app)?;
    let path = dir.join(info.file_name());
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Couldn't delete {}: {e}", path.display())),
    }
    Ok(models_in(&dir, downloads.now()))
}

// ---------------------------------------------------------------------------------------------------------------------
// The commands Settings → Voice → Speech to text uses.

/// What Settings → Voice shows of the choice.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub on_this_computer: bool,
    pub engine: Option<Engine>,
    pub label: Option<&'static str>,
    /// Why the engine can't run now.
    pub problem: Option<String>,
    pub backup: bool,
    pub timeout_seconds: u64,
    pub language: String,
}

fn state_of(s: Settings) -> State {
    State {
        on_this_computer: s.on_this_computer,
        label: s.engine.as_ref().map(|e| e.kind.label()),
        problem: problem(s.engine.as_ref()),
        engine: s.engine,
        backup: s.backup,
        timeout_seconds: s.timeout_seconds,
        language: s.language,
    }
}

/// An engine found on `PATH`, its version if it says, and the models found for it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub kind: Kind,
    pub label: &'static str,
    pub binary: PathBuf,
    pub version: Option<String>,
    pub models: Vec<PathBuf>,
}

/// The engines found on `PATH`, with each one's models (whisper.cpp's include this app's downloads).
fn found_now(app_models: Option<PathBuf>) -> Vec<(Kind, PathBuf, Vec<PathBuf>)> {
    let places = Places::from_env(app_models);
    on_path(&std::env::var_os("PATH").unwrap_or_default()).into_iter().map(|(k, b)| (k, b, models(k, &places))).collect()
}

/// The first line a program prints for `--version`, if it answers in 5 s.
async fn version(binary: &Path) -> Option<String> {
    let run = command(binary).arg("--version").stdin(Stdio::null()).kill_on_drop(true).output();
    let out = tokio::time::timeout(Duration::from_secs(5), run).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = [out.stdout, out.stderr].concat();
    String::from_utf8_lossy(&text).lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.chars().take(80).collect())
}

fn update(app: &AppHandle, change: impl FnOnce(&mut Settings) -> Result<(), String>) -> Result<State, String> {
    let path = settings_path(app)?;
    let _held = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = read_settings(&path)?;
    change(&mut settings)?;
    Ok(state_of(write_settings(&path, &settings)?))
}

#[tauri::command]
pub fn local_stt_state(app: AppHandle) -> Result<State, String> {
    Ok(state_of(read_settings(&settings_path(&app)?)?))
}

#[tauri::command]
pub async fn local_stt_detect(app: AppHandle) -> Result<Vec<Found>, String> {
    let app_models = models_dir(&app).ok();
    let found = tokio::task::spawn_blocking(move || found_now(app_models)).await.map_err(|e| e.to_string())?;
    let versions = futures_util::future::join_all(found.iter().map(|(_, b, _)| version(b))).await;
    Ok(found.into_iter().zip(versions).map(|((kind, binary, models), version)| Found { kind, label: kind.label(), binary, version, models }).collect())
}

/// Checks a choice the webview sends against what is allowed to run: a program found on `PATH` now or the one already
/// chosen (picked in a dialog earlier), and a model found for it now or the one already chosen for that program.
pub fn allowed(choice: &Engine, current: Option<&Engine>, found: &[(Kind, PathBuf, Vec<PathBuf>)]) -> Result<Engine, String> {
    let same_program = current.filter(|c| c.binary == choice.binary);
    let kind = match found.iter().find(|(_, b, _)| *b == choice.binary) {
        Some((k, _, _)) => *k,
        None => same_program.ok_or("That program wasn't found on PATH. Pick it with Choose a program instead.")?.kind,
    };
    if let Some(model) = &choice.model {
        let detected = found.iter().any(|(k, _, ms)| *k == kind && ms.contains(model));
        let kept = same_program.is_some_and(|c| c.model.as_ref() == Some(model));
        if !detected && !kept {
            return Err("That model wasn't found for this engine. Pick it with Choose a model instead.".into());
        }
    }
    Ok(Engine { kind, binary: choice.binary.clone(), model: choice.model.clone() })
}

/// A change to the choice; what is left out stays as it is.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub on_this_computer: Option<bool>,
    pub engine: Option<Engine>,
    pub backup: Option<bool>,
    pub timeout_seconds: Option<u64>,
    pub language: Option<String>,
}

/// Applies `change` to `s` whole or not at all: a timeout or language out of range, or an engine that wasn't found,
/// is refused, and nothing else in that change is made.
pub fn apply(s: &mut Settings, change: Change, found: &[(Kind, PathBuf, Vec<PathBuf>)]) -> Result<(), String> {
    if change.timeout_seconds.is_some_and(|t| !(MIN_TIMEOUT_SECONDS..=MAX_TIMEOUT_SECONDS).contains(&t)) {
        return Err(format!("The time before the backup must be {MIN_TIMEOUT_SECONDS} to {MAX_TIMEOUT_SECONDS} seconds."));
    }
    if change.language.as_deref().is_some_and(|l| !valid_language(l)) {
        return Err("The language must be auto or a code such as en or es.".into());
    }
    let engine = change.engine.as_ref().map(|choice| allowed(choice, s.engine.as_ref(), found)).transpose()?;
    if let Some(e) = engine {
        s.engine = Some(e);
    }
    if let Some(t) = change.timeout_seconds {
        s.timeout_seconds = t;
    }
    if let Some(l) = change.language {
        s.language = l;
    }
    if let Some(on) = change.on_this_computer {
        s.on_this_computer = on;
    }
    if let Some(b) = change.backup {
        s.backup = b;
    }
    Ok(())
}

/// Saves where speech becomes text, the backup and its time, the language, and which found engine and model run here.
#[tauri::command]
pub async fn local_stt_set(app: AppHandle, change: Change) -> Result<State, String> {
    let found = match change.engine {
        Some(_) => {
            let app_models = models_dir(&app).ok();
            tokio::task::spawn_blocking(move || found_now(app_models)).await.map_err(|e| e.to_string())?
        }
        None => vec![],
    };
    update(&app, |s| apply(s, change, &found))
}

async fn pick(app: &AppHandle, title: &str, folder: bool) -> Result<Option<PathBuf>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let send = move |p: Option<tauri_plugin_dialog::FilePath>| {
        let _ = tx.send(p);
    };
    if folder {
        dialog.pick_folder(send)
    } else {
        dialog.pick_file(send)
    }
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    path.into_path().map(Some).map_err(|e| e.to_string())
}

/// The owner points at an engine's program in the native Open dialog. `None`: cancelled.
#[tauri::command]
pub async fn local_stt_pick_program(app: AppHandle) -> Result<Option<State>, String> {
    let Some(binary) = pick(&app, "Choose a speech-to-text program", false).await? else { return Ok(None) };
    let kind = kind_of(&binary).ok_or(if cfg!(windows) {
        "Hermes Chat can run whisper-cli.exe, whisper-cpp.exe, whisper.exe, whisper-ctranslate2.exe or vosk-transcriber.exe."
    } else {
        "Hermes Chat can run whisper-cli, whisper-cpp, whisper, whisper-ctranslate2 or vosk-transcriber."
    })?;
    if !is_executable(&binary) {
        return Err(format!("{} can't be run: it isn't an executable file.", binary.display()));
    }
    update(&app, |s| {
        let model = s.engine.take().filter(|e| e.kind == kind).and_then(|e| e.model);
        s.engine = Some(Engine { kind, binary, model });
        Ok(())
    })
    .map(Some)
}

/// The owner points at a model file (or folder, for faster-whisper and Vosk) for the chosen engine. `None`: cancelled.
#[tauri::command]
pub async fn local_stt_pick_model(app: AppHandle) -> Result<Option<State>, String> {
    let path = settings_path(&app)?;
    let kind = read_settings(&path)?.engine.ok_or("Choose an engine first.")?.kind;
    let title = if kind.model_is_folder() { "Choose the model's folder" } else { "Choose a model file" };
    let Some(model) = pick(&app, title, kind.model_is_folder()).await? else { return Ok(None) };
    update(&app, |s| {
        let engine = s.engine.as_mut().filter(|e| e.kind == kind).ok_or("The engine changed meanwhile. Choose the model again.")?;
        engine.model = Some(model);
        Ok(())
    })
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hc-stt-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn file(path: &Path, text: &str, mode: u32) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
        #[cfg(windows)]
        let _ = mode;
    }

    fn settings(on_this_computer: bool, engine: Option<Engine>) -> Settings {
        Settings { on_this_computer, engine, ..Settings::default() }
    }

    #[test]
    fn a_programs_name_drops_only_its_platforms_suffix() {
        let windows = &[".exe", ".cmd", ".bat", ".com"];
        assert_eq!(program_name("whisper-cli.exe", windows).as_deref(), Some("whisper-cli"));
        assert_eq!(program_name("Whisper-CLI.EXE", windows).as_deref(), Some("whisper-cli"));
        assert_eq!(program_name("whisper.cmd", windows).as_deref(), Some("whisper"));
        assert_eq!(program_name("whisper-cli", windows), None);
        assert_eq!(program_name("whisper-cli.exe.txt", windows), None);
        assert_eq!(program_name("whisper-cli", &[""]).as_deref(), Some("whisper-cli"));
        // Linux names keep their case and any dots.
        assert_eq!(program_name("Whisper-cli.exe", &[""]).as_deref(), Some("Whisper-cli.exe"));
        assert_eq!(program_name("\u{e9}.exe", windows).as_deref(), Some("\u{e9}"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_engines_are_found_on_path_by_name_and_extension() {
        let d = temp("path-windows");
        let (a, b) = (d.join("a"), d.join("b"));
        file(&a.join("whisper-cli.exe"), "MZ", 0);
        file(&b.join("whisper-cli.exe"), "MZ", 0);
        file(&a.join("vosk-transcriber"), "MZ", 0); // no extension: Windows wouldn't run it
        let launcher = [b"MZ".as_slice(), &[0; 100], b"#!python.exe\nPK\x03\x04__main__.pyPK\x05\x06"].concat();
        std::fs::write(b.join("whisper.exe"), launcher).unwrap();
        let path = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(on_path(&path), vec![(Kind::WhisperCpp, a.join("whisper-cli.exe")), (Kind::OpenaiWhisper, b.join("whisper.exe"))]);
        file(&a.join("whisper.exe"), "MZ", 0);
        assert_eq!(kind_of(&a.join("whisper.exe")), Some(Kind::WhisperCpp));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn engines_are_found_on_path_by_name_first_match_wins_and_only_if_executable() {
        let d = temp("path");
        let (a, b) = (d.join("a"), d.join("b"));
        file(&a.join("whisper-cli"), "\x7fELF", 0o755);
        file(&b.join("whisper-cli"), "\x7fELF", 0o755);
        file(&a.join("whisper"), "#!/usr/bin/python3\n", 0o755);
        file(&b.join("vosk-transcriber"), "#!/bin/sh\n", 0o644); // not executable
        file(&b.join("whisper-ctranslate2"), "#!/usr/bin/python3\n", 0o755);
        file(&b.join("ls"), "", 0o755);
        let path = std::env::join_paths([&a, &b, &PathBuf::from("relative")]).unwrap();
        let got = on_path(&path);
        assert_eq!(
            got,
            vec![(Kind::WhisperCpp, a.join("whisper-cli")), (Kind::OpenaiWhisper, a.join("whisper")), (Kind::FasterWhisper, b.join("whisper-ctranslate2")),]
        );
        // whisper.cpp's old `whisper` is a binary, not a script.
        file(&a.join("whisper"), "\x7fELF", 0o755);
        assert_eq!(kind_of(&a.join("whisper")), Some(Kind::WhisperCpp));
        assert_eq!(kind_of(Path::new("/usr/bin/sh")), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn models_are_found_in_each_engines_usual_folders_and_this_apps_downloads() {
        let d = temp("models");
        let places =
            Places { home: d.join("home"), data: d.join("data"), cache: d.join("cache"), hf: d.join("hf"), app_models: Some(d.join("app/whisper-models")) };
        file(&d.join("data/whisper.cpp/ggml-base.en.bin"), "", 0o644);
        file(&d.join("data/whisper.cpp/models/ggml-tiny.bin"), "", 0o644);
        file(&d.join("data/whisper.cpp/models/notes.txt"), "", 0o644);
        file(&d.join("home/whisper.cpp/models/ggml-small.bin"), "", 0o644);
        file(&d.join("app/whisper-models/ggml-base.bin"), "", 0o644);
        file(&d.join("app/whisper-models/.ggml-small.bin.part"), "", 0o644);
        file(&d.join("cache/whisper/small.en.pt"), "", 0o644);
        file(&d.join("hf/hub/models--Systran--faster-whisper-small/snapshots/abc/model.bin"), "", 0o644);
        file(&d.join("hf/hub/models--Systran--faster-whisper-tiny/snapshots/def/config.json"), "", 0o644); // incomplete
        file(&d.join("hf/hub/models--bert/snapshots/x/model.bin"), "", 0o644);
        std::fs::create_dir_all(d.join("cache/vosk/vosk-model-small-en-us-0.15/am")).unwrap();
        std::fs::create_dir_all(d.join("cache/vosk/not-a-model")).unwrap();

        let cpp = models(Kind::WhisperCpp, &places);
        assert_eq!(cpp[0], d.join("app/whisper-models/ggml-base.bin"), "this app's downloads come first");
        for m in
            [d.join("data/whisper.cpp/ggml-base.en.bin"), d.join("data/whisper.cpp/models/ggml-tiny.bin"), d.join("home/whisper.cpp/models/ggml-small.bin")]
        {
            assert!(cpp.contains(&m), "{m:?} in {cpp:?}");
        }
        assert!(!cpp.iter().any(|m| m.ends_with("notes.txt") || name_of(m).ends_with(".part")));
        assert_eq!(models(Kind::OpenaiWhisper, &places), vec![d.join("cache/whisper/small.en.pt")]);
        assert_eq!(models(Kind::FasterWhisper, &places), vec![d.join("hf/hub/models--Systran--faster-whisper-small/snapshots/abc")]);
        assert_eq!(models(Kind::Vosk, &places), vec![d.join("cache/vosk/vosk-model-small-en-us-0.15")]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn each_engine_gets_a_fixed_argument_list_writing_audio_txt() {
        let (m, w, o) = (Path::new("/m/model"), Path::new("/t/audio.wav"), Path::new("/t"));
        let of = Path::new("/t").join("audio").display().to_string();
        let txt = Path::new("/t").join("audio.txt").display().to_string();
        let e = |kind| Engine { kind, binary: "/bin/x".into(), model: Some(m.into()) };
        let strs = |k, l| args(&e(k), m, w, o, l).into_iter().map(|a| a.into_string().unwrap()).collect::<Vec<_>>().join(" ");
        assert_eq!(strs(Kind::WhisperCpp, "auto"), format!("-m /m/model -f /t/audio.wav -l auto -nt -np -otxt -of {of}"));
        assert_eq!(strs(Kind::FasterWhisper, "auto"), "/t/audio.wav --model_directory /m/model --output_dir /t --output_format txt --verbose False");
        assert_eq!(strs(Kind::OpenaiWhisper, "auto"), "/t/audio.wav --model /m/model --output_dir /t --output_format txt --verbose False --fp16 False");
        assert_eq!(strs(Kind::Vosk, "auto"), format!("-m /m/model -i /t/audio.wav -o {txt}"));
        // A language other than auto goes to each Whisper engine; Vosk's is its model's.
        assert_eq!(strs(Kind::WhisperCpp, "es"), format!("-m /m/model -f /t/audio.wav -l es -nt -np -otxt -of {of}"));
        assert!(strs(Kind::FasterWhisper, "es").ends_with("--verbose False --language es"));
        assert!(strs(Kind::OpenaiWhisper, "es").ends_with("--fp16 False --language es"));
        assert_eq!(strs(Kind::Vosk, "es"), format!("-m /m/model -i /t/audio.wav -o {txt}"));
        // A path with spaces and a leading dash stays one argument.
        let odd = Path::new("/m/-x y.bin");
        assert_eq!(args(&e(Kind::WhisperCpp), odd, w, o, "auto")[1], OsString::from("/m/-x y.bin"));
    }

    #[test]
    fn transcripts_lose_bracketed_notes_and_line_breaks() {
        assert_eq!(clean(" Hello there.\n\n[BLANK_AUDIO]\n How are you? \n"), "Hello there. How are you?");
        assert_eq!(clean("[BLANK_AUDIO]\n"), "");
        assert_eq!(clean("(silence)\n *music*\n"), "");
        assert_eq!(clean("[Music] then words\n"), "[Music] then words");
    }

    #[test]
    fn the_choice_survives_a_restart_and_a_broken_file_is_an_error_not_the_server() {
        let d = temp("settings");
        let path = d.join(SETTINGS_FILE);
        assert_eq!(read_settings(&path).unwrap(), Settings::default(), "no file: Hermes transcribes");
        let s = Settings {
            on_this_computer: true,
            engine: Some(Engine { kind: Kind::Vosk, binary: "/usr/bin/vosk-transcriber".into(), model: Some("/m".into()) }),
            backup: true,
            timeout_seconds: 20,
            language: "es".into(),
        };
        assert_eq!(write_settings(&path, &s).unwrap(), s);
        assert_eq!(read_settings(&path).unwrap(), s);
        // A file from before the backup existed reads as no backup, 30 s, any language.
        std::fs::write(&path, r#"{"onThisComputer":true,"engine":null}"#).unwrap();
        assert_eq!(read_settings(&path).unwrap(), settings(true, None));
        // A value out of range is brought into it; where the recording goes is kept.
        std::fs::write(&path, r#"{"onThisComputer":true,"timeoutSeconds":1,"language":"English!"}"#).unwrap();
        let back = read_settings(&path).unwrap();
        assert!(back.on_this_computer);
        assert_eq!((back.timeout_seconds, back.language.as_str()), (MIN_TIMEOUT_SECONDS, "auto"));
        std::fs::write(&path, "{").unwrap();
        assert!(read_settings(&path).is_err());
        assert!(valid_language("haw") && valid_language("auto") && !valid_language("EN") && !valid_language("e") && !valid_language("en-US"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_webview_can_choose_only_found_programs_and_models() {
        let found = vec![(Kind::WhisperCpp, PathBuf::from("/usr/bin/whisper-cli"), vec![PathBuf::from("/m/ggml-base.bin")])];
        let choice = |b: &str, m: Option<&str>| Engine { kind: Kind::Vosk, binary: b.into(), model: m.map(PathBuf::from) };
        // The kind comes from what was found, not from the webview.
        assert_eq!(allowed(&choice("/usr/bin/whisper-cli", Some("/m/ggml-base.bin")), None, &found).unwrap().kind, Kind::WhisperCpp);
        assert!(allowed(&choice("/bin/rm", None), None, &found).is_err());
        assert!(allowed(&choice("/usr/bin/whisper-cli", Some("/etc/passwd")), None, &found).is_err());
        // A program and model picked in a dialog earlier stay allowed.
        let picked = Engine { kind: Kind::WhisperCpp, binary: "/opt/w/whisper-cli".into(), model: Some("/opt/m.bin".into()) };
        assert_eq!(allowed(&choice("/opt/w/whisper-cli", Some("/opt/m.bin")), Some(&picked), &found).unwrap(), picked);
        assert!(allowed(&choice("/opt/w/whisper-cli", Some("/etc/passwd")), Some(&picked), &found).is_err());
    }

    #[test]
    fn a_change_keeps_what_it_leaves_out_and_is_refused_whole_when_out_of_range() {
        let mut s = settings(true, None);
        apply(&mut s, Change { backup: Some(true), timeout_seconds: Some(60), language: Some("de".into()), ..Change::default() }, &[]).unwrap();
        assert_eq!((s.on_this_computer, s.backup, s.timeout_seconds, s.language.as_str()), (true, true, 60, "de"));
        assert!(apply(&mut s, Change { timeout_seconds: Some(4), backup: Some(false), ..Change::default() }, &[]).is_err());
        assert!(apply(&mut s, Change { language: Some("en-US".into()), ..Change::default() }, &[]).is_err());
        // An engine that wasn't found is refused, and nothing else in that change is made.
        let bad = Change {
            engine: Some(Engine { kind: Kind::WhisperCpp, binary: "/bin/rm".into(), model: None }),
            on_this_computer: Some(false),
            ..Change::default()
        };
        assert!(apply(&mut s, bad, &[]).is_err());
        assert_eq!((s.on_this_computer, s.backup, s.timeout_seconds, s.language.as_str()), (true, true, 60, "de"));
    }

    /// Each in its own folder: rewriting a program just run can fail with "text file busy".
    #[cfg(unix)]
    fn fake_engine(dir: &Path, name: &str, script: &str) -> Engine {
        let binary = dir.join(name).join("whisper-cli");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        crate::test_common::write_executable(&binary, &format!("#!/bin/sh\n{script}\n"));
        file(&dir.join("ggml-tiny.bin"), "", 0o644);
        Engine { kind: Kind::WhisperCpp, binary, model: Some(dir.join("ggml-tiny.bin")) }
    }

    /// The private folders left behind in the temp dir by this process.
    fn leftovers() -> usize {
        let prefix = format!("hermes-chat-stt-{}-", std::process::id());
        children(&std::env::temp_dir()).iter().filter(|p| name_of(p).starts_with(&prefix)).count()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_run_reads_the_transcript_and_deletes_the_recording_whatever_happens() {
        let d = temp("run");
        // Writes what it was given, as whisper-cli does with `-of <out>`; records the folder's mode and the language.
        let ok = fake_engine(
            &d,
            "ok",
            r#"l="$6"; while [ "$1" != "-of" ]; do shift; done; echo "$(stat -c %a "$(dirname "$2")") $l" > "$2.txt"; echo "[BLANK_AUDIO]" >> "$2.txt""#,
        );
        let got = transcribe(&ok, b"RIFF....", Duration::from_secs(10), "es").await.unwrap();
        assert_eq!(got.text, "700 es", "the recording's folder is private, and the language is passed on");
        assert_eq!(got.provider.as_deref(), Some("whisper.cpp"));

        let fails = fake_engine(&d, "fails", "echo 'error: failed to load model' >&2; exit 3");
        assert_eq!(transcribe(&fails, b"RIFF", Duration::from_secs(10), "auto").await.unwrap_err(), "whisper.cpp exited with 3: error: failed to load model");

        let hangs = fake_engine(&d, "hangs", "exec sleep 30");
        let err = transcribe(&hangs, b"RIFF", Duration::from_millis(300), "auto").await.unwrap_err();
        assert!(err.contains("took longer than"), "{err}");

        let mut gone = ok.clone();
        gone.model = Some(d.join("missing.bin"));
        assert!(transcribe(&gone, b"RIFF", Duration::from_secs(10), "auto").await.unwrap_err().contains("isn't there any more"));
        assert!(transcribe(&ok, &vec![0; MAX_WAV_BYTES + 1], Duration::from_secs(10), "auto").await.unwrap_err().contains("over 25 MB"));
        assert_eq!(leftovers(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failure_printed_only_on_stdout_is_still_said() {
        let d = temp("stdout");
        let e = fake_engine(&d, "stdout", "echo 'RuntimeError: Unable to open file model.bin'; exit 1");
        assert_eq!(
            transcribe(&e, b"RIFF", Duration::from_secs(10), "auto").await.unwrap_err(),
            "whisper.cpp exited with 1: RuntimeError: Unable to open file model.bin"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A Hermes that answers `text`, or fails with it, and counts the recordings it got.
    fn hermes(got: &Arc<AtomicUsize>, answer: Result<&'static str, &'static str>) -> impl Future<Output = Result<Transcript, String>> + Send + 'static {
        let got = got.clone();
        async move {
            got.fetch_add(1, Ordering::SeqCst);
            answer.map(|t| Transcript { text: t.into(), provider: Some("openai".into()) }).map_err(str::to_owned)
        }
    }

    fn not_cancelled() -> watch::Receiver<bool> {
        watch::channel(false).1
    }

    /// The routing `hermes_transcribe` follows, with the settings file it reads.
    #[cfg(unix)]
    #[tokio::test]
    async fn with_this_computer_chosen_and_no_backup_a_recording_never_goes_to_hermes() {
        let d = temp("route");
        let path = d.join(SETTINGS_FILE);
        let sent = Arc::new(AtomicUsize::new(0));
        let go = |only: Option<Side>| {
            let (path, sent) = (path.clone(), sent.clone());
            async move { transcribe_routed_at(&path, "audio/wav", b"RIFF", only, not_cancelled(), hermes(&sent, Ok("from Hermes"))).await }
        };
        assert_eq!(go(None).await.unwrap().ran, Side::Server, "no file: Hermes, as before");
        write_settings(&path, &settings(false, Some(fake_engine(&d, "unused", "exit 0")))).unwrap();
        assert_eq!(go(None).await.unwrap().text, "from Hermes", "Hermes server chosen");
        assert_eq!(sent.swap(0, Ordering::SeqCst), 2);

        write_settings(&path, &settings(true, None)).unwrap();
        assert_eq!(go(None).await.unwrap_err(), "This computer couldn't transcribe it: No speech-to-text engine is chosen on this computer.");
        let failing = fake_engine(&d, "failing", "echo boom >&2; exit 2");
        write_settings(&path, &settings(true, Some(failing))).unwrap();
        assert_eq!(go(None).await.unwrap_err(), "This computer couldn't transcribe it: whisper.cpp exited with 2: boom.");
        // Test can't send it to Hermes either, and gets this computer's own words.
        assert!(go(Some(Side::Server)).await.unwrap_err().contains("isn't sent to Hermes"));
        assert_eq!(go(Some(Side::Local)).await.unwrap_err(), "whisper.cpp exited with 2: boom");
        let mut missing = fake_engine(&d, "missing", "exit 0");
        missing.binary = d.join("nowhere/whisper-cli");
        write_settings(&path, &settings(true, Some(missing))).unwrap();
        assert!(go(None).await.is_err());
        let ok = fake_engine(&d, "fine", r#"while [ "$1" != "-of" ]; do shift; done; echo "hello" > "$2.txt""#);
        write_settings(&path, &settings(true, Some(ok))).unwrap();
        let got = go(None).await.unwrap();
        assert_eq!((got.text.as_str(), got.ran, got.fell_back), ("hello", Side::Local, None));
        let webm = transcribe_routed_at(&path, "audio/webm", b"x", None, not_cancelled(), hermes(&sent, Ok("no"))).await;
        assert!(webm.unwrap_err().contains("takes WAV"), "only WAV, and still not to Hermes");

        std::fs::write(&path, "not json").unwrap();
        assert!(go(None).await.unwrap_err().contains("can't be read"), "an unreadable choice isn't taken as Hermes server");
        assert_eq!(sent.load(Ordering::SeqCst), 0, "nothing reached Hermes");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_backup_transcribes_when_the_primary_fails_and_the_text_says_so() {
        let d = temp("backup");
        let path = d.join(SETTINGS_FILE);
        let sent = Arc::new(AtomicUsize::new(0));
        let ok = fake_engine(&d, "ok", r#"while [ "$1" != "-of" ]; do shift; done; echo "Check the NAS" > "$2.txt""#);
        let fails = fake_engine(&d, "fails", "echo 'error: failed to load model' >&2; exit 1");
        let backed = |on: bool, engine: Engine| Settings { backup: true, ..settings(on, Some(engine)) };

        // Hermes first, failing: this computer gives the text, and says why Hermes didn't.
        write_settings(&path, &backed(false, ok.clone())).unwrap();
        let got =
            transcribe_routed_at(&path, "audio/wav", b"RIFF", None, not_cancelled(), hermes(&sent, Err("The speech-to-text provider failed"))).await.unwrap();
        assert_eq!((got.text.as_str(), got.ran), ("Check the NAS", Side::Local));
        assert_eq!(got.fell_back, Some(FellBack { from: Side::Server, why: "The speech-to-text provider failed".into() }));

        // This computer first, failing: Hermes gets the recording, as the owner allowed.
        write_settings(&path, &backed(true, fails.clone())).unwrap();
        let got = transcribe_routed_at(&path, "audio/wav", b"RIFF", None, not_cancelled(), hermes(&sent, Ok("from Hermes"))).await.unwrap();
        assert_eq!((got.text.as_str(), got.ran), ("from Hermes", Side::Server));
        assert_eq!(got.fell_back.unwrap().why, "whisper.cpp exited with 1: error: failed to load model");

        // Both failing: each says why.
        let err = transcribe_routed_at(&path, "audio/wav", b"RIFF", None, not_cancelled(), hermes(&sent, Err("Not connected to Hermes."))).await.unwrap_err();
        assert_eq!(err, "This computer couldn't transcribe it: whisper.cpp exited with 1: error: failed to load model. Hermes couldn't transcribe it either: Not connected to Hermes.");

        // An empty transcript is an answer: the backup isn't tried.
        write_settings(&path, &backed(false, ok)).unwrap();
        let before = sent.load(Ordering::SeqCst);
        let got = transcribe_routed_at(&path, "audio/wav", b"RIFF", None, not_cancelled(), hermes(&sent, Ok(""))).await.unwrap();
        assert_eq!((got.text.as_str(), got.ran), ("", Side::Server));
        assert_eq!(sent.load(Ordering::SeqCst), before + 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_slow_primary_is_dropped_for_the_backup_after_the_time_set() {
        let quick = async { Ok(Transcript { text: "quick".into(), provider: None }) };
        let slow = async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(Transcript { text: "late".into(), provider: None })
        };
        let started = Instant::now();
        let got = route(&[Side::Server, Side::Local], Some(Duration::from_millis(1200)), false, slow, quick, not_cancelled()).await.unwrap();
        assert_eq!((got.text.as_str(), got.ran), ("quick", Side::Local));
        assert_eq!(got.fell_back.unwrap().why, "It took longer than 1 s.");
        assert!(started.elapsed() < Duration::from_secs(10));
        // With no backup waiting, the primary isn't timed.
        let slowish = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            Ok(Transcript { text: "slow but good".into(), provider: None })
        };
        let never = async { Err::<Transcript, String>("not tried".into()) };
        assert_eq!(route(&[Side::Server], None, false, slowish, never, not_cancelled()).await.unwrap().text, "slow but good");
    }

    #[tokio::test]
    async fn a_cancel_stops_the_run_and_the_backup_is_never_tried() {
        let tried = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = watch::channel(false);
        let primary = async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Err::<Transcript, String>("too late".into())
        };
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            tx.send_replace(true);
        });
        let started = Instant::now();
        let err = route(&[Side::Local, Side::Server], None, false, hermes(&tried, Ok("no")), primary, rx).await.unwrap_err();
        assert_eq!(err, CANCELLED);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(tried.load(Ordering::SeqCst), 0, "Hermes never got the recording");
        // A cancel that arrives before its transcription does still stops it, and nothing is left behind after.
        local_stt_cancel("early".into());
        let ticket = Ticket::new("early".into());
        assert!(*ticket.cancel.borrow());
        drop(ticket);
        assert!(RUNS.lock().unwrap().iter().all(|(i, ..)| i != "early"));
        // One cancelled while it runs.
        let ticket = Ticket::new("running".into());
        assert!(!*ticket.cancel.borrow());
        local_stt_cancel("running".into());
        assert!(*ticket.cancel.borrow());
    }

    #[test]
    fn the_errors_name_each_side_once_and_the_order_follows_the_choice() {
        assert_eq!(couldnt(Side::Server, "Hermes couldn't transcribe the recording: no key", false), "Hermes couldn't transcribe it: no key.");
        assert_eq!(couldnt(Side::Local, "boom!", true), "This computer couldn't transcribe it either: boom!");
        let s = |on, backup| Settings { backup, ..settings(on, None) };
        assert_eq!(order(&s(false, false), None).unwrap(), [Side::Server]);
        assert_eq!(order(&s(true, false), None).unwrap(), [Side::Local]);
        assert_eq!(order(&s(false, true), None).unwrap(), [Side::Server, Side::Local]);
        assert_eq!(order(&s(true, true), None).unwrap(), [Side::Local, Side::Server]);
        assert_eq!(order(&s(false, false), Some(Side::Local)).unwrap(), [Side::Local]);
        assert_eq!(order(&s(true, true), Some(Side::Server)).unwrap(), [Side::Server]);
        assert!(order(&s(true, false), Some(Side::Server)).is_err());
    }

    /// Serves `body` at every path, over loopback.
    async fn serve(body: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(move || {
            let body = body.clone();
            async move { body }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/")
    }

    #[tokio::test]
    async fn a_download_is_kept_only_when_its_size_and_checksum_match() {
        let body = b"pretend ggml model".to_vec();
        let digest = hex(&Sha256::digest(&body));
        let digest: &'static str = Box::leak(digest.into_boxed_str());
        let good = ModelInfo { name: "tiny", bytes: body.len() as u64, sha256: digest };
        let url = serve(body.clone()).await;
        let client = reqwest::Client::new();
        let dir = temp("download");
        let mut seen = 0;
        let path = download_model(&client, &url, &dir, &good, &AtomicBool::new(false), |d| seen = d).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), body);
        assert_eq!(seen, body.len() as u64);

        let wrong_hash = ModelInfo { name: "base", sha256: "00", ..good };
        let err = download_model(&client, &url, &dir, &wrong_hash, &AtomicBool::new(false), |_| {}).await.unwrap_err();
        assert!(err.contains("checksum"));
        let wrong_size = ModelInfo { name: "small", bytes: 5, ..good };
        assert!(download_model(&client, &url, &dir, &wrong_size, &AtomicBool::new(false), |_| {}).await.unwrap_err().contains("bigger"));
        let cancelled = ModelInfo { name: "medium", ..good };
        assert_eq!(download_model(&client, &url, &dir, &cancelled, &AtomicBool::new(true), |_| {}).await.unwrap_err(), CANCELLED);
        // Only the good one is there, and no part file is left.
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["ggml-tiny.bin"]);
        // A size counts as downloaded only at its exact size: the pinned tiny is bigger than this stand-in.
        let listed = models_in(&dir, None);
        assert!(listed.models.iter().all(|m| !m.downloaded));
        assert_eq!(listed.models[0].path, dir.join("ggml-tiny.bin"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_stalled_download_can_be_cancelled() {
        // Headers, then a body that never comes.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(|| async { axum::body::Body::from_stream(futures_util::stream::pending::<Result<Vec<u8>, std::io::Error>>()) });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = temp("stalled");
        let info = ModelInfo { name: "tiny", bytes: 10, sha256: "00" };
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            flag.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let err = download_model(&reqwest::Client::new(), &format!("http://{addr}/"), &dir, &info, &cancel, |_| {}).await.unwrap_err();
        assert_eq!(err, CANCELLED);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "the part file was left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_cancel_with_the_last_chunk_still_drops_the_download() {
        let body = b"pretend ggml model".to_vec();
        let digest: &'static str = Box::leak(hex(&Sha256::digest(&body)).into_boxed_str());
        let info = ModelInfo { name: "base", bytes: body.len() as u64, sha256: digest };
        let url = serve(body.clone()).await;
        let dir = temp("last-chunk");
        let cancel = AtomicBool::new(false);
        let err = download_model(&reqwest::Client::new(), &url, &dir, &info, &cancel, |done| {
            if done == info.bytes {
                cancel.store(true, Ordering::Relaxed);
            }
        })
        .await
        .unwrap_err();
        assert_eq!(err, CANCELLED);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "nothing was put in place");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancels_that_never_meet_their_transcription_are_dropped() {
        let (tx, _) = watch::channel(true);
        let old = Instant::now().checked_sub(EARLY_CANCEL_KEPT + Duration::from_secs(1)).unwrap();
        let mut runs = vec![("stale".to_string(), tx.clone(), old, false), ("running".to_string(), tx.clone(), old, true)];
        for i in 0..EARLY_CANCELS_MAX + 10 {
            runs.push((format!("c{i}"), tx.clone(), Instant::now(), false));
        }
        prune(&mut runs);
        assert!(runs.iter().all(|(i, ..)| i != "stale"), "a cancel past its minute is dropped");
        assert!(runs.iter().any(|(i, ..)| i == "running"), "a running transcription is kept");
        assert_eq!(runs.iter().filter(|(.., r)| !r).count(), EARLY_CANCELS_MAX);
        assert!(runs.iter().all(|(i, ..)| !matches!(i.as_str(), "c0" | "c9")), "the oldest go first");
        assert!(runs.iter().any(|(i, ..)| i == "c10"));
    }

    #[test]
    fn the_pinned_models_are_the_five_sizes_with_full_checksums() {
        let names: Vec<&str> = MODELS.iter().map(|m| m.name).collect();
        assert_eq!(names, ["tiny", "base", "small", "medium", "large-v3"]);
        assert!(MODELS.iter().all(|m| m.sha256.len() == 64 && m.sha256.bytes().all(|b| b.is_ascii_hexdigit())));
    }

    /// Against a real whisper.cpp, on its own JFK sample: `HERMES_TEST_WHISPER_CLI=…/whisper-cli
    /// HERMES_TEST_WHISPER_MODEL=…/ggml-tiny.bin HERMES_TEST_WHISPER_WAV=…/samples/jfk.wav cargo test real_whisper_cpp`.
    /// Skipped when they aren't set.
    #[tokio::test]
    async fn real_whisper_cpp() {
        let (Some(cli), Some(model), Some(wav)) =
            (std::env::var_os("HERMES_TEST_WHISPER_CLI"), std::env::var_os("HERMES_TEST_WHISPER_MODEL"), std::env::var_os("HERMES_TEST_WHISPER_WAV"))
        else {
            eprintln!("skipped: no HERMES_TEST_WHISPER_CLI/MODEL/WAV");
            return;
        };
        let engine = Engine { kind: Kind::WhisperCpp, binary: cli.into(), model: Some(model.into()) };
        let wav = std::fs::read(wav).unwrap();
        let started = Instant::now();
        let got = transcribe(&engine, &wav, time_limit(wav.len()), "auto").await.unwrap();
        println!("{:?} in {:?}: {}", version(&engine.binary).await, started.elapsed(), got.text);
        assert!(got.text.to_lowercase().contains("ask not what your country can do for you"), "{}", got.text);
        assert_eq!(leftovers(), 0);
    }
}
