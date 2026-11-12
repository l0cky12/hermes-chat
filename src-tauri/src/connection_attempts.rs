//! The record of recent connection attempts (#270, ADR 0033): `connection-attempts.jsonl` in the app's data folder, one
//! JSON line per attempt, the newest `CAP` kept. The webview builds each line (src/hermes/attempts.ts) and puts it here
//! whole each time the attempt moves on, so an attempt the app was closed during is on disk at the step it reached.
//!
//! A line names a route by its kind and id, never its address, and its only free text is error messages the webview has
//! already redacted and stripped of addresses. This store checks that again before anything touches the disk: a line
//! with an unknown field, a malformed id, or text holding a URL, an `@`, or an IPv4 or IPv6 address is refused. Dotted
//! host names are the webview's to erase, since a plain sentence can hold a dotted word too (`gateway.ready`).
//!
//! Every write, from any running copy of the app, takes the lock beside the file, merges by id, keeps the newest `CAP`
//! by start time and replaces the file whole, so the file never holds more than `CAP` lines, even after a crash.
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::connect_steps::Step;
use crate::private_file::{self, owner_only};

/// The most attempts the file keeps.
pub const CAP: usize = 50;
const FILE: &str = "connection-attempts.jsonl";
const LOCK: &str = "connection-attempts.lock";
/// The longest error text kept, in characters (the webview cuts to this).
const TEXT_MAX: usize = 300;
/// routes.ts `ROUTES_MAX`.
const ROUTES_MAX: usize = 8;

/// One attempt to open a connection: every route tried, in order, then how it ended. `run`: the launch of the app that
/// made it, so a reader can tell an attempt still going from one the app was closed during.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    v: u8,
    id: String,
    run: String,
    /// When it began, in ms since the epoch.
    at: u64,
    /// How long it took, once it ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ms: Option<u64>,
    outcome: Outcome,
    routes: Vec<RouteTry>,
    /// Why the attempt as a whole failed, when that isn't one route's error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteTry {
    id: String,
    kind: RouteKind,
    /// The steps reached, in order; each but a step still running, or the one it stopped at, has its duration.
    steps: Vec<StepTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StepTime {
    step: Step,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ms: Option<u64>,
}

/// routes.ts `RouteKind`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RouteKind {
    Lan,
    Tailscale,
    Web,
    Ssh,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Outcome {
    Unfinished,
    Connected,
    Failed,
    Stopped,
}

/// A v4 UUID's shape, as `crypto.randomUUID()` makes them.
fn uuid_shaped(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_digit() || (b'a'..=b'f').contains(&b) })
}

/// routes.ts `isRouteId`.
fn route_id(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Whether `text` holds none of the shapes an address can't be written without: a URL's `://`, the `@` of user@host or
/// an email, four dot-joined numbers (IPv4), or a run of hex digits and colons with `::` or three colons (IPv6). A
/// time such as `10:00:00` has two. Plain scans; nothing here is a pattern a sentence needs.
pub fn address_free(text: &str) -> bool {
    if text.contains("://") || text.contains('@') {
        return false;
    }
    let ipv4 = text.split(|c: char| !(c.is_ascii_digit() || c == '.')).any(|t| {
        let parts: Vec<&str> = t.trim_matches('.').split('.').collect();
        parts.windows(4).any(|w| w.iter().all(|p| (1..=3).contains(&p.len()) && p.parse::<u16>().is_ok_and(|n| n <= 255)))
    });
    let ipv6 = text
        .split(|c: char| !(c.is_ascii_hexdigit() || c == ':'))
        .any(|t| t.bytes().any(|b| b.is_ascii_hexdigit()) && (t.contains("::") || t.matches(':').count() >= 3));
    !ipv4 && !ipv6
}

fn text_ok(text: &Option<String>) -> Result<(), String> {
    let Some(t) = text else { return Ok(()) };
    if t.chars().count() > TEXT_MAX {
        return Err(format!("an error text is over {TEXT_MAX} characters"));
    }
    if t.chars().any(|c| c.is_control() || matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')) {
        return Err("an error text holds a control character".into());
    }
    if !address_free(t) {
        return Err("an error text looks like it holds an address".into());
    }
    Ok(())
}

impl Attempt {
    /// Whether this is a line the file may hold. The reason it isn't names the rule, never the text.
    pub fn check(&self) -> Result<(), String> {
        if self.v != 1 {
            return Err("unknown version".into());
        }
        if !uuid_shaped(&self.id) || !uuid_shaped(&self.run) {
            return Err("its id isn't a UUID".into());
        }
        if self.routes.len() > ROUTES_MAX {
            return Err(format!("more than {ROUTES_MAX} routes"));
        }
        for r in &self.routes {
            if !route_id(&r.id) {
                return Err("a route id isn't one".into());
            }
            if !r.steps.windows(2).all(|w| w[0].step < w[1].step) {
                return Err("a route's steps are out of order".into());
            }
            if r.steps.iter().rev().skip(1).any(|s| s.ms.is_none()) {
                return Err("a step before the last has no duration".into());
            }
            text_ok(&r.error)?;
        }
        text_ok(&self.error)
    }
}

/// What the file holds: the attempts that read as good lines, oldest first, and how many lines didn't.
#[derive(Debug, Default, Serialize)]
pub struct Read {
    pub attempts: Vec<Attempt>,
    pub unreadable: usize,
}

fn parse(text: &str) -> Read {
    let mut read = Read::default();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<Attempt>(line) {
            Ok(a) if a.check().is_ok() => read.attempts.push(a),
            _ => read.unreadable += 1,
        }
    }
    read
}

/// Runs `f` holding the lock every copy of the app takes for this file.
fn locked<T>(dir: &Path, f: impl FnOnce(&Path) -> io::Result<T>) -> io::Result<T> {
    fs::create_dir_all(dir)?;
    let lock = owner_only(OpenOptions::new().create(true).truncate(false).write(true)).open(dir.join(LOCK))?;
    // Released when `lock` is closed at the end.
    lock.lock()?;
    f(&dir.join(FILE))
}

fn read_text(path: &Path) -> io::Result<String> {
    match fs::read_to_string(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        other => other,
    }
}

/// Keeps `a`: replaces the line with its id, or adds it, then keeps the newest `CAP` by start time. A line that isn't
/// good is refused before the disk is touched; lines already there that don't read are dropped.
pub fn put(dir: &Path, a: Attempt) -> Result<(), String> {
    a.check().map_err(|why| format!("Not kept: {why}."))?;
    locked(dir, |path| {
        let mut all = parse(&read_text(path)?).attempts;
        match all.iter_mut().find(|x| x.id == a.id) {
            Some(x) => *x = a,
            None => all.push(a),
        }
        all.sort_by_key(|x| x.at);
        let drop = all.len().saturating_sub(CAP);
        let text: String = all[drop..].iter().map(|x| serde_json::to_string(x).expect("serializable") + "\n").collect();
        private_file::write(path, text.as_bytes())
    })
    .map_err(|e| e.to_string())
}

/// The file's attempts, oldest first.
pub fn read(dir: &Path) -> Result<Read, String> {
    locked(dir, |path| Ok(parse(&read_text(path)?))).map_err(|e| e.to_string())
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connection_attempts_put(app: AppHandle, attempt: Attempt) -> Result<(), String> {
    let dir = dir(&app)?;
    tokio::task::spawn_blocking(move || put(&dir, attempt)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn connection_attempts_read(app: AppHandle) -> Result<Read, String> {
    let dir = dir(&app)?;
    tokio::task::spawn_blocking(move || read(&dir)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const RUN: &str = "0b9f3c2e-6d7a-4e1f-9a2b-3c4d5e6f7a8b";

    fn id(n: usize) -> String {
        format!("00000000-0000-4000-8000-{n:012x}")
    }

    fn line(n: usize, at: u64) -> Value {
        json!({
            "v": 1, "id": id(n), "run": RUN, "at": at, "ms": 5200, "outcome": "failed",
            "routes": [
                {"id": "k3x9q2ab", "kind": "lan", "steps": [{"step": "keyring", "ms": 3}, {"step": "resolve", "ms": 11}, {"step": "status", "ms": 5000}],
                 "error": "Can't reach the Hermes dashboard: error sending request for url ([address])"},
                {"id": "main", "kind": "ssh", "steps": [{"step": "keyring", "ms": 2}, {"step": "tunnel"}]}
            ],
            "error": "No route reached Hermes."
        })
    }

    fn attempt(v: Value) -> Attempt {
        serde_json::from_value(v).unwrap()
    }

    fn file(dir: &Path) -> String {
        fs::read_to_string(dir.join(FILE)).unwrap()
    }

    #[test]
    fn the_cap_holds_and_keeps_the_newest() {
        let dir = tempdir();
        for n in 0..120 {
            put(&dir, attempt(line(n, 1_000 + n as u64))).unwrap();
            assert!(file(&dir).lines().count() <= CAP);
        }
        let kept = read(&dir).unwrap();
        assert_eq!(kept.attempts.len(), CAP);
        assert_eq!(kept.unreadable, 0);
        let ids: Vec<_> = kept.attempts.iter().map(|a| a.id.clone()).collect();
        assert_eq!(ids, (70..120).map(id).collect::<Vec<_>>());
    }

    #[test]
    fn a_file_over_the_cap_or_with_bad_lines_comes_back_under_it() {
        let dir = tempdir();
        fs::create_dir_all(&dir).unwrap();
        let mut text: String = (0..500).map(|n| line(n, n as u64).to_string() + "\n").collect();
        text.push_str("not json\n");
        text.push_str(&"x".repeat(1 << 20));
        text.push('\n');
        fs::write(dir.join(FILE), &text).unwrap();
        assert_eq!(read(&dir).unwrap().unreadable, 2);
        put(&dir, attempt(line(999, 10_000))).unwrap();
        assert_eq!(file(&dir).lines().count(), CAP);
        assert_eq!(read(&dir).unwrap().unreadable, 0);
    }

    #[test]
    fn putting_the_same_attempt_again_replaces_its_line() {
        let dir = tempdir();
        let mut v = line(1, 5);
        v["outcome"] = json!("unfinished");
        v.as_object_mut().unwrap().remove("ms");
        put(&dir, attempt(v)).unwrap();
        put(&dir, attempt(line(1, 5))).unwrap();
        let kept = read(&dir).unwrap().attempts;
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].outcome, Outcome::Failed);
    }

    #[test]
    fn two_writers_lose_nothing_and_stay_under_the_cap() {
        let dir = tempdir();
        let threads: Vec<_> = (0..2)
            .map(|t| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for n in 0..40 {
                        let k = t * 1000 + n;
                        put(&dir, attempt(line(k, (n * 2 + t) as u64))).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let kept = read(&dir).unwrap();
        assert_eq!((kept.attempts.len(), kept.unreadable), (CAP, 0));
        // The newest 50 by start time, whichever thread wrote them.
        let mut want: Vec<(u64, String)> = (0..2).flat_map(|t| (0..40).map(move |n| ((n * 2 + t) as u64, id(t * 1000 + n)))).collect();
        want.sort();
        let want: Vec<String> = want[80 - CAP..].iter().map(|(_, i)| i.clone()).collect();
        assert_eq!(kept.attempts.iter().map(|a| a.id.clone()).collect::<Vec<_>>(), want);
    }

    #[test]
    fn lines_that_could_hold_an_address_or_secret_are_refused_before_the_disk() {
        let refused = [
            ("error", json!("error sending request for url (http://192.168.1.10:9119/api/status)")),
            ("error", json!("Plain http:// is only used on this computer")),
            ("error", json!("liam@box: Permission denied (publickey)")),
            ("error", json!("ssh: connect to host 203.0.113.77 port 22: Connection refused")),
            ("error", json!("The chat connection failed: IO error at [fd7a:115c:a1e0::1]:9119")),
            ("error", json!("dial 2001:db8:0:1:2:3:4:5 failed")),
            ("error", json!("tab\there")),
            ("error", json!("x".repeat(TEXT_MAX + 1))),
            ("id", json!("box.example.com")),
            ("run", json!("not-a-uuid")),
            ("v", json!(2)),
        ];
        for (field, value) in refused {
            let dir = tempdir();
            let mut v = line(1, 1);
            v[field] = value.clone();
            let a: Result<Attempt, _> = serde_json::from_value(v);
            if let Ok(a) = a {
                assert!(put(&dir, a).is_err(), "{field} = {value} was kept");
            }
            assert!(!dir.join(FILE).exists(), "{field} = {value} touched the disk");
        }
        // A route id that is an address, steps out of order, a step before the last without a duration, an unknown
        // field, an unknown step or kind.
        let mut bad: Vec<Value> = Vec::new();
        for (path, value) in [
            ("/routes/0/id", json!("10.0.0.5")),
            ("/routes/0/id", json!("hermes.lan")),
            ("/routes/0/steps/1/step", json!("sign-in")),
            ("/routes/0/steps/0/ms", Value::Null),
            ("/routes/0/address", json!("10.0.0.5")),
            ("/routes/0/kind", json!("url")),
            ("/routes/0/steps/0/step", json!("dns")),
            ("/target", json!("hermes.lan")),
        ] {
            let mut v = line(1, 1);
            let (parent, key) = path.rsplit_once('/').unwrap();
            let p = if parent.is_empty() { &mut v } else { v.pointer_mut(parent).unwrap() };
            if value.is_null() {
                p.as_object_mut().unwrap().remove(key);
            } else {
                p[key] = value;
            }
            bad.push(v);
        }
        for v in bad {
            let dir = tempdir();
            if let Ok(a) = serde_json::from_value::<Attempt>(v.clone()) {
                assert!(put(&dir, a).is_err(), "{v} was kept");
            }
            assert!(!dir.join(FILE).exists());
        }
    }

    #[test]
    fn sentences_without_addresses_pass() {
        for t in [
            "Hermes didn't send gateway.ready in time.",
            "Can't reach the Hermes dashboard: error sending request for url ([address])",
            "Wrong username or password.",
            "The dashboard answered 502: Bad gateway at 10:00:00",
            "Hermes didn't finish connecting within 60s.",
            "os error 10060",
        ] {
            assert!(address_free(t), "{t}");
        }
        for t in ["10.0.0.5", "at 192.168.1.10:9119", "[::1]:9119", "fe80::1%eth0", "a@b", "wss://x"] {
            assert!(!address_free(t), "{t}");
        }
    }

    /// Every string in the file is a key this module names, an enum tag, an id, or a checked error text: a field added
    /// later with free text in it fails here, whatever it is called.
    #[test]
    fn the_file_holds_only_known_keys_tags_ids_and_checked_text() {
        let dir = tempdir();
        put(&dir, attempt(line(1, 1))).unwrap();
        const KEYS: [&str; 13] = ["v", "id", "run", "at", "ms", "outcome", "routes", "error", "kind", "steps", "step", "ms", "error"];
        const TAGS: [&str; 16] = [
            "unfinished",
            "connected",
            "failed",
            "stopped",
            "lan",
            "tailscale",
            "web",
            "ssh",
            "keyring",
            "resolve",
            "tunnel",
            "status",
            "sign-in",
            "ticket",
            "websocket",
            "ready",
        ];
        fn walk(v: &Value, key: &str) {
            match v {
                Value::Object(m) => m.iter().for_each(|(k, v)| {
                    assert!(KEYS.contains(&k.as_str()), "key {k}");
                    walk(v, k)
                }),
                Value::Array(a) => a.iter().for_each(|v| walk(v, key)),
                Value::String(s) => match key {
                    "error" => assert!(address_free(s)),
                    "id" | "run" => assert!(uuid_shaped(s) || route_id(s), "{s}"),
                    _ => assert!(TAGS.contains(&s.as_str()), "{key}: {s}"),
                },
                _ => {}
            }
        }
        for l in file(&dir).lines() {
            walk(&serde_json::from_str(l).unwrap(), "");
        }
    }

    fn tempdir() -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("hermes-attempts-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = fs::remove_dir_all(&d);
        d
    }
}
