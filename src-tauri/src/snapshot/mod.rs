//! Snapshots (ADR 0123): a chat's HTML page put in an S3-compatible bucket the owner names, reached by a presigned
//! link that ends when it expires or is revoked. The bucket is the record: each snapshot is one object, its metadata
//! the list's row, so nothing about a snapshot is kept on this computer.
//!
//! The host settings and the secret key are one keyring entry (`HostEntry`), so a secret is only ever used with the
//! endpoint, region, bucket, prefix and key id it was entered with. The webview gets the settings, never the secret.

mod bucket;
pub mod sigv4;

pub use bucket::Bucket;

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The host settings as the webview sees them. The secret key is never in it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotHost {
    /// `https://s3.us-east-1.amazonaws.com`: a scheme and a host, with no path.
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    /// Empty, or ends with `/`.
    pub prefix: String,
    pub key_id: String,
}

/// The keyring entry: the settings and the secret they were entered with, made only by `new` (which validates) or
/// `read` (an entry `new` made).
#[derive(Serialize, Deserialize, Clone)]
pub struct HostEntry {
    v: u8,
    #[serde(flatten)]
    host: SnapshotHost,
    secret: String,
}

impl std::fmt::Debug for HostEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostEntry").field("host", &self.host).finish_non_exhaustive()
    }
}

impl HostEntry {
    /// The settings trimmed and normalized, with the secret, or a sentence saying which field is wrong.
    pub fn new(host: SnapshotHost, secret: &str) -> Result<Self, String> {
        let host = SnapshotHost {
            endpoint: endpoint(&host.endpoint)?,
            region: region(&host.region)?,
            bucket: bucket(&host.bucket)?,
            prefix: prefix(&host.prefix)?,
            key_id: credential(&host.key_id, "The access key id")?,
        };
        Ok(HostEntry { v: 1, host, secret: credential(secret, "The secret key")? })
    }

    /// The saved entry, if it is one this version reads.
    pub fn read(raw: &str) -> Option<Self> {
        let saved: HostEntry = serde_json::from_str(raw).ok().filter(|e: &HostEntry| e.v == 1)?;
        HostEntry::new(saved.host, &saved.secret).ok()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("strings serialize")
    }

    pub fn host(&self) -> &SnapshotHost {
        &self.host
    }
}

fn endpoint(raw: &str) -> Result<String, String> {
    let bad = |why: &str| Err(format!("The endpoint {why}. Write it as https://host, such as https://s3.us-east-1.amazonaws.com."));
    let Ok(url) = url::Url::parse(raw.trim()) else { return bad("isn't a web address") };
    let Some(host) = url.host() else { return bad("has no host") };
    if !url.username().is_empty() || url.password().is_some() {
        return bad("has a user name or password in it");
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return bad("has a path, query or fragment");
    }
    let loopback = match host {
        url::Host::Domain(d) => d.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    };
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        "http" => return bad("uses http://, which is only for a store on this computer"),
        _ => return bad("isn't https://"),
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn region(raw: &str) -> Result<String, String> {
    let r = raw.trim();
    if r.is_empty() || !r.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err("The region is lowercase letters, digits and dashes, such as us-east-1 (auto on Cloudflare R2).".into());
    }
    Ok(r.to_string())
}

fn bucket(raw: &str) -> Result<String, String> {
    let b = raw.trim();
    if !(3..=63).contains(&b.len()) || !b.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-') {
        return Err("The bucket name is 3 to 63 lowercase letters, digits, dots and dashes.".into());
    }
    Ok(b.to_string())
}

fn prefix(raw: &str) -> Result<String, String> {
    let p = raw.trim();
    if p.is_empty() {
        return Ok(String::new());
    }
    // A `.` segment too: the URL parser would drop it from the path after the request was signed with it.
    if p.starts_with('/') || !p.bytes().all(|b| (0x20..0x7f).contains(&b)) || p.split('/').any(|s| s == ".." || s == ".") {
        return Err("The prefix is a folder in the bucket, such as hermes-chat-snapshots/, without a leading / or a . or .. folder in it.".into());
    }
    Ok(if p.ends_with('/') { p.to_string() } else { format!("{p}/") })
}

fn credential(raw: &str, what: &str) -> Result<String, String> {
    let c = raw.trim();
    if c.is_empty() || c.chars().any(char::is_whitespace) {
        return Err(format!("{what} is missing or has a space in it."));
    }
    Ok(c.to_string())
}

/// How long a link lasts. 7 days is the most a presigned S3 link can.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Expiry {
    Hour,
    Day,
    Week,
}

impl Expiry {
    pub fn seconds(self) -> u64 {
        match self {
            Expiry::Hour => 3600,
            Expiry::Day => 86_400,
            Expiry::Week => 604_800,
        }
    }
}

/// A snapshot's id: 26 lowercase base32 characters (RFC 4648, `a-z2-7`) from 128 random bits. It names the object
/// `<prefix><id>.html`, and can't name any other key.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SnapshotId(String);

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

impl SnapshotId {
    pub fn random() -> Self {
        let mut bits = [0u8; 16];
        getrandom::fill(&mut bits).expect("the system has a random source");
        let n = u128::from_be_bytes(bits);
        // 26 characters hold 130 bits: the last one has the 3 lowest random bits and 2 zero bits.
        let digit = |i: i32| {
            let shift = 123 - 5 * i;
            (if shift >= 0 { n >> shift } else { n << -shift }) & 31
        };
        SnapshotId((0..26).map(|i| BASE32[digit(i) as usize] as char).collect())
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        if raw.len() == 26 && raw.bytes().all(|b| BASE32.contains(&b)) {
            Ok(SnapshotId(raw.to_string()))
        } else {
            Err("That isn't a snapshot's id.".into())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn key(&self, prefix: &str) -> String {
        format!("{prefix}{}.html", self.0)
    }

    /// The id a key under `prefix` names, if it is a snapshot's key.
    pub fn from_key(prefix: &str, key: &str) -> Option<Self> {
        SnapshotId::parse(key.strip_prefix(prefix)?.strip_suffix(".html")?).ok()
    }
}

/// One snapshot in the list, in exactly one state. `created` and `expires` are RFC 3339 UTC.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Snapshot {
    /// The link works until `expires`. `url` is a presigned GET of the current version.
    Live { id: String, title: String, created: String, expires: String, url: String },
    /// Past `expires`, and the list's delete of it failed.
    Expired { id: String, title: String, created: String, expires: String },
    /// The body's SHA-256 doesn't match the one it was published with, or its metadata is unreadable.
    Changed {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        created: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expires: Option<String>,
    },
    /// Only older versions or delete markers are left: a Revoke that didn't finish.
    Unrevoked { id: String },
}

impl Snapshot {
    pub fn id(&self) -> &str {
        match self {
            Snapshot::Live { id, .. } | Snapshot::Expired { id, .. } | Snapshot::Changed { id, .. } | Snapshot::Unrevoked { id } => id,
        }
    }
}

/// What Publish did.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum Published {
    /// Read back and matched: `snapshot` is always `Snapshot::Live`.
    Live { snapshot: Snapshot },
    /// The host refused the upload, and the page certainly isn't in the bucket.
    NotPublished { reason: String },
    /// Anything else: the page may be in the bucket.
    MaybeSent { reason: String },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotList {
    /// The settings the list was read with, so the webview can drop an answer for settings since changed.
    pub host: SnapshotHost,
    pub snapshots: Vec<Snapshot>,
}

/// `(year, month, day, hour, minute, second)` of a Unix time, in UTC.
fn civil(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day, (rem / 3600) as u32, (rem % 3600 / 60) as u32, (rem % 60) as u32)
}

/// `2026-11-11T21:30:00Z`.
pub fn rfc3339(secs: u64) -> String {
    let (y, mo, d, h, mi, s) = civil(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// SigV4's `20261111T213000Z`.
pub fn amz_date(secs: u64) -> String {
    let (y, mo, d, h, mi, s) = civil(secs);
    format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}Z")
}

/// The Unix time of a UTC time written as `rfc3339` writes it.
pub fn parse_rfc3339(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, sec) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    // Howard Hinnant's days-from-civil.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = u64::try_from(days * 86_400 + h * 3600 + mi * 60 + sec).ok()?;
    (rfc3339(secs) == s).then_some(secs)
}

pub fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// The keyring account of the one entry (service `hermes-chat`), per computer and shared by every connection.
const ACCOUNT: &str = "snapshot-host";
const TIMEOUT: Duration = Duration::from_secs(120);
const NO_HOST: &str = "No snapshot host is set. Set one in Settings → Snapshots.";

async fn saved() -> Result<Option<HostEntry>, String> {
    Ok(crate::saved_password::load(ACCOUNT.into()).await?.as_deref().and_then(HostEntry::read))
}

async fn saved_bucket() -> Result<Bucket, String> {
    Bucket::new(saved().await?.ok_or(NO_HOST)?, TIMEOUT)
}

pub const HOST_CHANGED: &str =
    "The snapshot host changed since this screen read it, so nothing was sent. Look at the host in Settings → Snapshots and try again.";

/// The saved host's bucket, only when it is the host the owner was shown, so a request never goes somewhere the
/// screen didn't name. Another window or computer can change the entry at any time.
async fn shown_bucket(shown: &SnapshotHost) -> Result<Bucket, String> {
    only_shown(saved_bucket().await?, shown)
}

pub fn only_shown(bucket: Bucket, shown: &SnapshotHost) -> Result<Bucket, String> {
    if bucket.host() == shown {
        Ok(bucket)
    } else {
        Err(HOST_CHANGED.into())
    }
}

#[tauri::command]
pub async fn snapshot_host() -> Result<Option<SnapshotHost>, String> {
    Ok(saved().await?.map(|e| e.host))
}

/// Saves the settings with the secret, always together: a changed setting is never used with the old secret.
#[tauri::command]
pub async fn snapshot_host_save(host: SnapshotHost, secret: String) -> Result<SnapshotHost, String> {
    let entry = HostEntry::new(host, &secret)?;
    crate::saved_password::save(ACCOUNT.into(), entry.to_json()).await?;
    Ok(entry.host)
}

#[tauri::command]
pub async fn snapshot_host_clear() -> Result<(), String> {
    crate::saved_password::delete(ACCOUNT.into()).await
}

#[tauri::command]
pub async fn snapshot_host_test(host: SnapshotHost) -> Result<(), String> {
    shown_bucket(&host).await?.test(unix_now()).await
}

#[tauri::command]
pub async fn snapshot_publish(host: SnapshotHost, html: String, title: String, expiry: Expiry) -> Result<Published, String> {
    Ok(shown_bucket(&host).await?.publish(&SnapshotId::random(), html.as_bytes(), &title, expiry, unix_now()).await)
}

#[tauri::command]
pub async fn snapshot_list(host: SnapshotHost) -> Result<SnapshotList, String> {
    // The list deletes expired snapshots, so it too may act only on the host the owner was shown.
    let bucket = shown_bucket(&host).await?;
    let snapshots = bucket.list(unix_now()).await?;
    Ok(SnapshotList { host: bucket.host().clone(), snapshots })
}

#[tauri::command]
pub async fn snapshot_link(host: SnapshotHost, id: String) -> Result<String, String> {
    let id = SnapshotId::parse(&id)?;
    shown_bucket(&host).await?.link(&id, unix_now()).await
}

#[tauri::command]
pub async fn snapshot_revoke(host: SnapshotHost, id: String) -> Result<(), String> {
    let id = SnapshotId::parse(&id)?;
    shown_bucket(&host).await?.revoke(&id, unix_now()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn host(endpoint: &str, prefix: &str) -> SnapshotHost {
        SnapshotHost { endpoint: endpoint.into(), region: "us-east-1".into(), bucket: "my-bucket".into(), prefix: prefix.into(), key_id: "AKID".into() }
    }

    #[test]
    fn settings_are_trimmed_and_normalized() {
        let entry = HostEntry::new(host(" https://S3.example.com/ ", "snaps"), " s3cret ").unwrap();
        assert_eq!(entry.host().endpoint, "https://s3.example.com");
        assert_eq!(entry.host().prefix, "snaps/");
        assert_eq!(HostEntry::new(host("https://h.example:9000", ""), "s").unwrap().host().endpoint, "https://h.example:9000");
        assert_eq!(HostEntry::new(host("http://127.0.0.1:9000", "a/b/"), "s").unwrap().host().prefix, "a/b/");
        for ok in ["http://localhost:9000", "http://[::1]:9000", "http://127.8.0.1"] {
            assert!(HostEntry::new(host(ok, ""), "s").is_ok(), "{ok}");
        }
    }

    #[test]
    fn a_bad_setting_is_refused_with_a_sentence() {
        for bad in
            ["", "s3.example.com", "http://s3.example.com", "ftp://h", "https://u:p@h", "https://h/path", "https://h/?q", "https://h/#f", "http://10.0.0.1"]
        {
            let err = HostEntry::new(host(bad, ""), "s").unwrap_err();
            assert!(err.starts_with("The endpoint") && err.ends_with('.'), "{bad}: {err}");
        }
        for bad in ["/abs/", "a/../b/", "..", "tab\there/", "é/"] {
            assert!(HostEntry::new(host("https://h", bad), "s").is_err(), "{bad}");
        }
        let mut h = host("https://h", "");
        h.region = "US East".into();
        assert!(HostEntry::new(h, "s").is_err());
        for b in ["ab", "Upper", "under_score", &"a".repeat(64)] {
            let mut h = host("https://h", "");
            h.bucket = b.into();
            assert!(HostEntry::new(h, "s").is_err(), "{b}");
        }
        assert!(HostEntry::new(host("https://h", ""), "").is_err());
        assert!(HostEntry::new(host("https://h", ""), "a b").is_err());
        let mut h = host("https://h", "");
        h.key_id = String::new();
        assert!(HostEntry::new(h, "s").is_err());
    }

    #[test]
    fn the_entry_keeps_settings_and_secret_together_and_shows_no_secret() {
        let entry = HostEntry::new(host("https://h.example", "p/"), "s3cret").unwrap();
        let raw: serde_json::Value = serde_json::from_str(&entry.to_json()).unwrap();
        assert_eq!(
            raw,
            json!({"v": 1, "endpoint": "https://h.example", "region": "us-east-1", "bucket": "my-bucket", "prefix": "p/", "keyId": "AKID", "secret": "s3cret"})
        );
        let back = HostEntry::read(&entry.to_json()).unwrap();
        assert_eq!(back.host(), entry.host());
        assert!(!format!("{back:?}").contains("s3cret"));
        assert!(!serde_json::to_string(back.host()).unwrap().contains("s3cret"));
        for bad in ["", "{}", r#"{"v":2,"endpoint":"https://h","region":"r","bucket":"bbb","prefix":"","keyId":"k","secret":"s"}"#] {
            assert!(HostEntry::read(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn an_id_is_26_base32_characters_and_names_only_its_own_key() {
        let a = SnapshotId::random();
        assert_eq!(a.as_str().len(), 26);
        assert_eq!(SnapshotId::parse(a.as_str()), Ok(a.clone()));
        assert_ne!(SnapshotId::random(), a);
        assert_eq!(SnapshotId::from_key("p/", &a.key("p/")), Some(a.clone()));
        assert_eq!(SnapshotId::from_key("p/", &a.key("q/")), None);
        for bad in ["", "abc", "../../etc/passwd.html.....", "abcdefghijklmnopqrstuvwxy1", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz2"] {
            assert!(SnapshotId::parse(bad).is_err(), "{bad}");
        }
        // The last character carries 3 random bits, so only 8 of the 32 are possible.
        assert!(BASE32.iter().step_by(4).any(|c| *c as char == a.as_str().chars().last().unwrap()));
    }

    #[test]
    fn times_are_utc_and_round_trip() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_369_353_600), "2013-05-24T00:00:00Z");
        assert_eq!(amz_date(1_369_353_600), "20130524T000000Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        for t in [0, 951_782_400, 1_794_000_000, 4_102_444_799] {
            assert_eq!(parse_rfc3339(&rfc3339(t)), Some(t));
        }
        for bad in ["", "2026-02-30T00:00:00Z", "2026-11-11T21:30:00", "2026-11-11 21:30:00Z", "2026-13-01T00:00:00Z"] {
            assert_eq!(parse_rfc3339(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_webview_gets_the_contract_shapes() {
        let live = Snapshot::Live { id: "a".into(), title: "T".into(), created: "c".into(), expires: "e".into(), url: "u".into() };
        assert_eq!(serde_json::to_value(&live).unwrap(), json!({"state": "live", "id": "a", "title": "T", "created": "c", "expires": "e", "url": "u"}));
        let changed = Snapshot::Changed { id: "a".into(), title: None, created: Some("c".into()), expires: None };
        assert_eq!(serde_json::to_value(&changed).unwrap(), json!({"state": "changed", "id": "a", "created": "c"}));
        assert_eq!(serde_json::to_value(Snapshot::Unrevoked { id: "a".into() }).unwrap(), json!({"state": "unrevoked", "id": "a"}));
        assert_eq!(
            serde_json::to_value(Published::Live { snapshot: Snapshot::Unrevoked { id: "a".into() } }).unwrap(),
            json!({"outcome": "live", "snapshot": {"state": "unrevoked", "id": "a"}})
        );
        assert_eq!(serde_json::to_value(Published::NotPublished { reason: "r".into() }).unwrap(), json!({"outcome": "notPublished", "reason": "r"}));
        assert_eq!(serde_json::to_value(Published::MaybeSent { reason: "r".into() }).unwrap(), json!({"outcome": "maybeSent", "reason": "r"}));
        assert_eq!(serde_json::from_value::<Expiry>(json!("week")).unwrap().seconds(), 604_800);
        let h: SnapshotHost = serde_json::from_value(json!({"endpoint": "https://h", "region": "r", "bucket": "bbb", "prefix": "", "keyId": "k"})).unwrap();
        assert_eq!(h.key_id, "k");
    }
}
