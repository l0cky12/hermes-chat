//! The S3 requests behind Publish, the list, Copy link, Revoke and Test (ADR 0123, "Upload, read back and revoke").
//! Path-style addressing, `<endpoint>/<bucket>/<key>`, each request signed with the entry's own key.

use super::sigv4::{self, hex_sha256, Key};
use super::{amz_date, parse_rfc3339, rfc3339, Expiry, HostEntry, Published, Snapshot, SnapshotHost, SnapshotId};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use quick_xml::events::Event;
use reqwest::header::HeaderMap;
use reqwest::{Method, StatusCode};
use std::collections::BTreeMap;
use std::time::Duration;

/// The longest a presigned link lasts.
const MAX_LINK: u64 = 604_800;
/// S3 holds at most 2 KB of user metadata, counted as the UTF-8 bytes of every key and value.
const META_LIMIT: usize = 2048;
const TITLE: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');

/// One bucket, reached with the settings and secret of one keyring entry.
pub struct Bucket {
    entry: HostEntry,
    http: reqwest::Client,
    /// `host` or `host:port`, as the request's Host header carries it.
    authority: String,
}

struct Answer {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

/// What the host made of one upload.
enum Put {
    Stored(Option<String>),
    Exists,
    /// Certainly not written, such as a 403.
    Refused(String),
    /// No answer, or one that doesn't say whether it was written, such as a 500.
    Uncertain(String),
}

/// What a GET of a snapshot's key found.
enum Held {
    Page { version: Option<String>, meta: Meta, body_sha256: String },
    Deleted,
    Missing,
    Failed(String),
}

/// A snapshot's metadata, each field only if it reads.
struct Meta {
    title: Option<String>,
    created: Option<u64>,
    expires: Option<u64>,
    sha256: Option<String>,
}

/// One entry of a version listing: an object's version or a delete marker.
#[derive(Debug)]
struct Version {
    key: String,
    id: String,
    latest: bool,
    marker: bool,
}

impl Bucket {
    pub fn new(entry: HostEntry, timeout: Duration) -> Result<Self, String> {
        let endpoint = url::Url::parse(&entry.host.endpoint).map_err(|e| e.to_string())?;
        let host = endpoint.host_str().unwrap_or_default();
        let authority = match endpoint.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        };
        let http = reqwest::Client::builder().timeout(timeout).redirect(reqwest::redirect::Policy::none()).referer(false).build().map_err(|e| e.to_string())?;
        Ok(Bucket { entry, http, authority })
    }

    pub fn host(&self) -> &SnapshotHost {
        &self.entry.host
    }

    fn key(&self) -> Key<'_> {
        Key { id: &self.entry.host.key_id, secret: &self.entry.secret, region: &self.entry.host.region }
    }

    fn path(&self, key: Option<&str>) -> String {
        match key {
            Some(key) => format!("/{}/{key}", self.entry.host.bucket),
            None => format!("/{}", self.entry.host.bucket),
        }
    }

    fn url(&self, path: &str, query: &[(String, String)]) -> String {
        let path = sigv4::uri_encode(path, true);
        match sigv4::canonical_query(query) {
            q if q.is_empty() => format!("{}{path}", self.entry.host.endpoint),
            q => format!("{}{path}?{q}", self.entry.host.endpoint),
        }
    }

    async fn send(
        &self,
        method: Method,
        key: Option<&str>,
        query: &[(String, String)],
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        now: u64,
    ) -> Result<Answer, String> {
        let path = self.path(key);
        let payload_hash = hex_sha256(&body);
        let date = amz_date(now);
        let mut signed = headers;
        signed.extend([("host".into(), self.authority.clone()), ("x-amz-content-sha256".into(), payload_hash.clone()), ("x-amz-date".into(), date.clone())]);
        let authorization =
            self.key().authorization(&sigv4::Request { method: method.as_str(), path: &path, query, headers: &signed, payload_hash: &payload_hash }, &date);
        let mut request = self.http.request(method, self.url(&path, query)).header("authorization", authorization).body(body);
        for (name, value) in signed.iter().filter(|(name, _)| name != "host") {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|e| self.unanswered(e))?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.bytes().await.map_err(|e| self.unanswered(e))?.to_vec();
        Ok(Answer { status, headers, body })
    }

    /// A sentence for a request with no answer, with the error's causes but not its URL.
    fn unanswered(&self, e: reqwest::Error) -> String {
        let e = e.without_url();
        let mut cause = e.to_string();
        let mut source = std::error::Error::source(&e);
        while let Some(s) = source {
            cause.push_str(": ");
            cause.push_str(&s.to_string());
            source = s.source();
        }
        format!("The host at {} didn't answer ({cause}).", self.authority)
    }

    /// A sentence for an answer that isn't the one asked for. Only the error's code and message are taken from it:
    /// S3's `SignatureDoesNotMatch` also echoes the string it signed.
    fn refusal(&self, answer: &Answer) -> String {
        let leaves = xml_leaves(&answer.body).unwrap_or_default();
        let field = |name: &str| leaves.iter().find(|(path, _)| path.len() == 2 && path[0] == "Error" && path[1] == name).map(|(_, t)| t.trim().to_string());
        let code = field("Code").unwrap_or_default();
        let message: String = field("Message").unwrap_or_default().chars().take(300).collect();
        let detail = match (code.is_empty(), message.is_empty()) {
            (true, true) => answer.status.to_string(),
            (false, true) => code.clone(),
            (true, false) => message.trim_end_matches('.').to_string(),
            (false, false) => format!("{code}: {}", message.trim_end_matches('.')),
        };
        match (answer.status.as_u16(), code.as_str()) {
            (_, "InvalidAccessKeyId" | "SignatureDoesNotMatch" | "AccessDenied" | "InvalidToken" | "ExpiredToken") | (403, _) => {
                format!("The host refused the access key ({detail}).")
            }
            (_, "NoSuchBucket") => format!("The host has no bucket named {} ({detail}).", self.entry.host.bucket),
            (501, _) | (_, "NotImplemented") => format!("The host doesn't support a request snapshots need ({detail})."),
            _ => format!("The host answered {} ({detail}).", answer.status),
        }
    }

    /// Every version and delete marker under `prefix`, following the listing across pages.
    async fn versions(&self, prefix: &str, now: u64) -> Result<Vec<Version>, String> {
        let mut all = Vec::new();
        let mut from: Option<(String, String)> = None;
        loop {
            let mut query = vec![("versions".to_string(), String::new()), ("prefix".to_string(), prefix.to_string())];
            if let Some((key, version)) = &from {
                query.extend([("key-marker".to_string(), key.clone()), ("version-id-marker".to_string(), version.clone())]);
            }
            let answer = self.send(Method::GET, None, &query, Vec::new(), Vec::new(), now).await?;
            if !answer.status.is_success() {
                return Err(self.refusal(&answer));
            }
            let Page { versions, next } = parse_versions(&answer.body)?;
            all.extend(versions);
            match next {
                Some(next) if from.as_ref() != Some(&next) => from = Some(next),
                Some(_) => return Err("The host's version listing didn't move on to its next page.".into()),
                None => return Ok(all),
            }
        }
    }

    /// Lists the prefix's versions, one at most, and writes nothing.
    pub async fn test(&self, now: u64) -> Result<(), String> {
        let query =
            [("versions".to_string(), String::new()), ("prefix".to_string(), self.entry.host.prefix.clone()), ("max-keys".to_string(), "1".to_string())];
        let answer = self.send(Method::GET, None, &query, Vec::new(), Vec::new(), now).await?;
        if !answer.status.is_success() {
            return Err(self.refusal(&answer));
        }
        parse_versions(&answer.body).map(|_| ())
    }

    async fn put(&self, key: &str, html: &[u8], meta: &[(String, String)], now: u64) -> Put {
        let mut headers: Vec<(String, String)> =
            [("content-type", "text/html; charset=utf-8"), ("content-disposition", "inline"), ("cache-control", "private, no-store"), ("if-none-match", "*")]
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .to_vec();
        headers.extend_from_slice(meta);
        match self.send(Method::PUT, Some(key), &[], headers, html.to_vec(), now).await {
            Err(e) => Put::Uncertain(e),
            Ok(a) if a.status.is_success() => Put::Stored(version_of(&a.headers)),
            Ok(a) if a.status == StatusCode::PRECONDITION_FAILED => Put::Exists,
            Ok(a) if a.status == StatusCode::CONFLICT || (a.status.is_server_error() && a.status != StatusCode::NOT_IMPLEMENTED) => {
                Put::Uncertain(self.refusal(&a))
            }
            Ok(a) => Put::Refused(self.refusal(&a)),
        }
    }

    /// Uploads `html` as snapshot `id`, never over an object that is there, and returns it Live only once a read of
    /// the object gives back the same bytes.
    pub async fn publish(&self, id: &SnapshotId, html: &[u8], title: &str, expiry: Expiry, now: u64) -> Published {
        let key = id.key(&self.entry.host.prefix);
        let sha256 = hex_sha256(html);
        let meta = metadata(title, now, now + expiry.seconds(), &sha256);
        let mut answer = self.put(&key, html, &meta, now).await;
        // A lost answer is settled by sending the same PUT again: a 412 then means the first one was written.
        let resent = matches!(answer, Put::Uncertain(_));
        if resent {
            answer = self.put(&key, html, &meta, now).await;
        }
        match answer {
            Put::Stored(version) => self.read_back(id, &key, version, &sha256, now).await,
            Put::Exists => self.read_back(id, &key, None, &sha256, now).await,
            // The only request for a key made moments ago was refused, so nothing is under it.
            Put::Refused(reason) if !resent => Published::NotPublished { reason },
            // The first try may still be in flight and land after any listing, so nothing short of a 412 settles it.
            Put::Refused(why) => {
                Published::MaybeSent { reason: format!("{why} An earlier try had no answer, so the page may be in the bucket. Check Settings → Snapshots.") }
            }
            Put::Uncertain(why) => Published::MaybeSent {
                reason: format!("The upload wasn't confirmed after two tries. {why} The page may be in the bucket. Check Settings → Snapshots."),
            },
        }
    }

    async fn read_back(&self, id: &SnapshotId, key: &str, version: Option<String>, sha256: &str, now: u64) -> Published {
        let maybe = |reason: String| Published::MaybeSent { reason };
        match self.read(key, version.as_deref(), now).await {
            Held::Page { version, meta, body_sha256 } if body_sha256 == sha256 => match self.state(id, version, meta, &body_sha256, now) {
                live @ Snapshot::Live { .. } => Published::Live { snapshot: live },
                _ => maybe("The page was sent, but the host doesn't hold it with the details it was sent with. Check Settings → Snapshots.".into()),
            },
            Held::Page { .. } => maybe(
                "The host holds a different page under this snapshot's name, so a link could show something else. Revoke it in Settings → Snapshots.".into(),
            ),
            Held::Deleted => maybe("The host shows the page deleted right after the upload. Older copies may be left. Check Settings → Snapshots.".into()),
            Held::Missing => maybe("The page was sent, but the host doesn't show it yet. It may appear in Settings → Snapshots.".into()),
            Held::Failed(e) => maybe(format!("The page was sent, but reading it back failed. {e} It may be in the bucket. Check Settings → Snapshots.")),
        }
    }

    async fn read(&self, key: &str, version: Option<&str>, now: u64) -> Held {
        let query: Vec<(String, String)> = version.map(|v| ("versionId".to_string(), v.to_string())).into_iter().collect();
        match self.send(Method::GET, Some(key), &query, Vec::new(), Vec::new(), now).await {
            Err(e) => Held::Failed(e),
            Ok(a) if a.status.is_success() => Held::Page { version: version_of(&a.headers), meta: Meta::from(&a.headers), body_sha256: hex_sha256(&a.body) },
            Ok(a) if header(&a.headers, "x-amz-delete-marker") == Some("true") => Held::Deleted,
            Ok(a) if a.status == StatusCode::NOT_FOUND => Held::Missing,
            Ok(a) => Held::Failed(self.refusal(&a)),
        }
    }

    /// The state of a page the host holds, before the list deletes an expired one.
    fn state(&self, id: &SnapshotId, version: Option<String>, meta: Meta, body_sha256: &str, now: u64) -> Snapshot {
        match meta {
            Meta { title: Some(title), created: Some(created), expires: Some(expires), sha256: Some(sha256) } if sha256 == body_sha256 => {
                let key = id.key(&self.entry.host.prefix);
                let (id, created_at, expires_at) = (id.as_str().to_string(), rfc3339(created), rfc3339(expires));
                if expires > now {
                    let url = self.presigned(&key, version.as_deref(), expires, now);
                    Snapshot::Live { id, title, created: created_at, expires: expires_at, url }
                } else {
                    Snapshot::Expired { id, title, created: created_at, expires: expires_at }
                }
            }
            meta => {
                Snapshot::Changed { id: id.as_str().to_string(), title: meta.title, created: meta.created.map(rfc3339), expires: meta.expires.map(rfc3339) }
            }
        }
    }

    /// A presigned GET of `key` (of `version` when the host named one) that ends at `expires`.
    fn presigned(&self, key: &str, version: Option<&str>, expires: u64, now: u64) -> String {
        let query: Vec<(String, String)> = version.map(|v| ("versionId".to_string(), v.to_string())).into_iter().collect();
        let path = self.path(Some(key));
        let signed = self.key().presign("GET", &self.authority, &path, &query, &amz_date(now), expires.saturating_sub(now).min(MAX_LINK));
        self.url(&path, &signed)
    }

    /// Every snapshot under the prefix, from a complete version listing. An expired one is deleted as Revoke does,
    /// and shown only when that fails.
    pub async fn list(&self, now: u64) -> Result<Vec<Snapshot>, String> {
        let prefix = &self.entry.host.prefix;
        let mut keys: BTreeMap<SnapshotId, Vec<Version>> = BTreeMap::new();
        for version in self.versions(prefix, now).await? {
            if let Some(id) = SnapshotId::from_key(prefix, &version.key) {
                keys.entry(id).or_default().push(version);
            }
        }
        let mut snapshots = Vec::new();
        for (id, versions) in keys {
            let Some(current) = versions.iter().find(|v| v.latest && !v.marker) else {
                snapshots.push(Snapshot::Unrevoked { id: id.as_str().to_string() });
                continue;
            };
            let snapshot = match self.read(&id.key(prefix), Some(current.id.as_str()).filter(|v| *v != "null"), now).await {
                Held::Page { version, meta, body_sha256 } => self.state(&id, version, meta, &body_sha256, now),
                Held::Deleted | Held::Missing => Snapshot::Unrevoked { id: id.as_str().to_string() },
                Held::Failed(e) => return Err(format!("Reading snapshot {} failed. {e}", id.as_str())),
            };
            match snapshot {
                Snapshot::Expired { .. } if self.revoke(&id, now).await.is_ok() => {}
                snapshot => snapshots.push(snapshot),
            }
        }
        snapshots.sort_by(|a, b| created(b).cmp(&created(a)));
        Ok(snapshots)
    }

    /// A fresh link for a Live snapshot's current version, ending at the same time as the first.
    pub async fn link(&self, id: &SnapshotId, now: u64) -> Result<String, String> {
        match self.read(&id.key(&self.entry.host.prefix), None, now).await {
            Held::Page { version, meta, body_sha256 } => match self.state(id, version, meta, &body_sha256, now) {
                Snapshot::Live { url, .. } => Ok(url),
                Snapshot::Expired { .. } => Err("This snapshot has expired, so it has no link.".into()),
                _ => Err("This snapshot's page has changed since it was published, so it gets no link. Revoke it instead.".into()),
            },
            Held::Deleted | Held::Missing => Err("This snapshot isn't in the bucket any more.".into()),
            Held::Failed(e) => Err(e),
        }
    }

    async fn delete(&self, key: &str, version: &str, now: u64) -> Result<(), String> {
        let query = [("versionId".to_string(), version.to_string())];
        let answer = self.send(Method::DELETE, Some(key), &query, Vec::new(), Vec::new(), now).await?;
        if answer.status.is_success() {
            Ok(())
        } else {
            Err(self.refusal(&answer))
        }
    }

    /// The key's versions and delete markers that a fresh listing shows.
    async fn left(&self, key: &str, now: u64) -> Result<Vec<Version>, String> {
        let versions = self.versions(key, now).await.map_err(|e| format!("Revoke may not have worked: {}", lower_first(&e)))?;
        Ok(versions.into_iter().filter(|v| v.key == key).collect())
    }

    /// Deletes every version and delete marker of the snapshot's key. Done only when a fresh listing shows none left.
    pub async fn revoke(&self, id: &SnapshotId, now: u64) -> Result<(), String> {
        let key = id.key(&self.entry.host.prefix);
        let mut refused = None;
        for _ in 0..3 {
            let left = self.left(&key, now).await?;
            if left.is_empty() {
                return Ok(());
            }
            for version in left {
                if let Err(e) = self.delete(&key, &version.id, now).await {
                    refused = Some(e);
                }
            }
        }
        match self.left(&key, now).await?.len() {
            0 => Ok(()),
            n => Err(format!(
                "Revoke may not have worked: {n} {} of the page {} still in the bucket.{}",
                if n == 1 { "copy" } else { "copies" },
                if n == 1 { "is" } else { "are" },
                refused.map(|e| format!(" {e}")).unwrap_or_default()
            )),
        }
    }
}

fn created(snapshot: &Snapshot) -> Option<&str> {
    match snapshot {
        Snapshot::Live { created, .. } | Snapshot::Expired { created, .. } => Some(created),
        Snapshot::Changed { created, .. } => created.as_deref(),
        Snapshot::Unrevoked { .. } => None,
    }
}

fn lower_first(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().map(|c| c.to_lowercase().chain(chars).collect()).unwrap_or_default()
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// The version the host named, if any. `null` is an unversioned bucket's.
fn version_of(headers: &HeaderMap) -> Option<String> {
    header(headers, "x-amz-version-id").filter(|v| !v.is_empty() && *v != "null").map(str::to_string)
}

impl From<&HeaderMap> for Meta {
    fn from(headers: &HeaderMap) -> Self {
        Meta {
            title: header(headers, "x-amz-meta-title").map(|t| percent_decode_str(t).decode_utf8_lossy().into_owned()),
            created: header(headers, "x-amz-meta-created").and_then(parse_rfc3339),
            expires: header(headers, "x-amz-meta-expires").and_then(parse_rfc3339),
            sha256: header(headers, "x-amz-meta-sha256").filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())).map(str::to_ascii_lowercase),
        }
    }
}

/// The upload's metadata headers. The title is percent-encoded and cut, so every key and value stays within S3's 2 KB.
fn metadata(title: &str, created: u64, expires: u64, sha256: &str) -> Vec<(String, String)> {
    let mut meta = vec![
        ("x-amz-meta-created".to_string(), rfc3339(created)),
        ("x-amz-meta-expires".to_string(), rfc3339(expires)),
        ("x-amz-meta-sha256".to_string(), sha256.to_string()),
    ];
    let mut used = meta.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() + "x-amz-meta-title".len();
    let mut encoded = String::new();
    for c in title.chars() {
        let piece = utf8_percent_encode(c.encode_utf8(&mut [0; 4]), TITLE).to_string();
        if used + piece.len() > META_LIMIT {
            break;
        }
        used += piece.len();
        encoded.push_str(&piece);
    }
    meta.push(("x-amz-meta-title".to_string(), encoded));
    meta
}

/// Each element's text, as the names from the root down and the text, in the order the elements end.
fn xml_leaves(body: &[u8]) -> Option<Vec<(Vec<String>, String)>> {
    let mut reader = quick_xml::Reader::from_str(std::str::from_utf8(body).ok()?);
    let (mut path, mut text, mut leaves) = (Vec::<String>::new(), String::new(), Vec::new());
    let mut roots = 0;
    loop {
        match reader.read_event().ok()? {
            Event::Start(_) | Event::Empty(_) if path.is_empty() && roots > 0 => return None,
            Event::Start(e) => {
                roots += usize::from(path.is_empty());
                path.push(e.local_name().as_ref().to_string());
                text.clear();
            }
            Event::End(_) => {
                leaves.push((path.clone(), std::mem::take(&mut text)));
                path.pop();
            }
            Event::Empty(e) => {
                roots += usize::from(path.is_empty());
                path.push(e.local_name().as_ref().to_string());
                leaves.push((path.clone(), String::new()));
                path.pop();
            }
            Event::Text(t) => text.push_str(&t.xml10_content()),
            Event::CData(t) => text.push_str(&t.xml10_content()),
            Event::GeneralRef(r) => text.push_str(&quick_xml::escape::unescape(&format!("&{};", &*r)).ok()?),
            // A body cut short ends with elements still open, and must never read as a complete answer.
            Event::Eof => return (path.is_empty() && roots == 1).then_some(leaves),
            _ => {}
        }
    }
}

/// One page of `ListObjectVersions`.
#[derive(Debug)]
struct Page {
    versions: Vec<Version>,
    /// Where the next page starts, its key marker and version-id marker, if there is one.
    next: Option<(String, String)>,
}

fn parse_versions(body: &[u8]) -> Result<Page, String> {
    let leaves = xml_leaves(body).ok_or("The host's version listing wasn't readable XML.")?;
    match leaves.last().map(|(path, _)| path.iter().map(String::as_str).collect::<Vec<_>>()).as_deref() {
        Some(["ListVersionsResult"]) => {}
        Some(["ListBucketResult"]) => return Err("The host lists the bucket but not its object versions, which Revoke needs.".into()),
        _ => return Err("The host's answer wasn't a version listing.".into()),
    }
    if !leaves.iter().any(|(path, _)| matches!(path.iter().map(String::as_str).collect::<Vec<_>>()[..], [_, "IsTruncated"])) {
        return Err("The host's version listing didn't say whether it was complete.".into());
    }
    let mut versions = Vec::new();
    let mut current = Version { key: String::new(), id: String::new(), latest: false, marker: false };
    let (mut truncated, mut next_key, mut next_version) = (false, None, None);
    for (path, text) in leaves {
        match path.iter().map(String::as_str).collect::<Vec<_>>()[..] {
            [_, "Version" | "DeleteMarker", "Key"] => current.key = text,
            [_, "Version" | "DeleteMarker", "VersionId"] => current.id = text,
            [_, "Version" | "DeleteMarker", "IsLatest"] => current.latest = text.trim() == "true",
            [_, "Version" | "DeleteMarker"] if current.key.is_empty() || current.id.is_empty() => {
                return Err("The host's version listing has a version without its key or version id.".into());
            }
            [_, kind @ ("Version" | "DeleteMarker")] => {
                current.marker = kind == "DeleteMarker";
                versions.push(std::mem::replace(&mut current, Version { key: String::new(), id: String::new(), latest: false, marker: false }));
            }
            [_, "IsTruncated"] => truncated = text.trim() == "true",
            [_, "NextKeyMarker"] => next_key = Some(text),
            [_, "NextVersionIdMarker"] => next_version = Some(text),
            _ => {}
        }
    }
    let next = match (truncated, next_key) {
        (false, _) => None,
        (true, Some(key)) => Some((key, next_version.unwrap_or_default())),
        (true, None) => return Err("The host's version listing was cut short without saying where it goes on.".into()),
    };
    Ok(Page { versions, next })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_title_is_cut_so_all_metadata_stays_within_2_kb() {
        let sha = "a".repeat(64);
        for title in ["short title", &"é".repeat(2000), &"𝄞".repeat(1000), &"x".repeat(5000)] {
            let meta = metadata(title, 0, 3600, &sha);
            let total: usize = meta.iter().map(|(k, v)| k.len() + v.len()).sum();
            assert!(total <= META_LIMIT, "{total}");
            let stored = &meta.iter().find(|(k, _)| k == "x-amz-meta-title").unwrap().1;
            assert!(stored.is_ascii());
            let back = percent_decode_str(stored).decode_utf8().unwrap();
            assert!(title.starts_with(&*back), "a cut lands between characters");
            assert!(total + 12 > META_LIMIT || back == title, "only a title that doesn't fit is cut");
        }
    }

    #[test]
    fn a_version_listing_reads_versions_markers_and_its_next_page() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix>p/</Prefix>
<IsTruncated>true</IsTruncated><NextKeyMarker>p/a&amp;b.html</NextKeyMarker><NextVersionIdMarker>v2</NextVersionIdMarker>
<Version><Key>p/a.html</Key><VersionId>v1</VersionId><IsLatest>true</IsLatest><Size>3</Size></Version>
<DeleteMarker><Key>p/a&amp;b.html</Key><VersionId>v2</VersionId><IsLatest>true</IsLatest></DeleteMarker>
</ListVersionsResult>"#;
        let Page { versions, next } = parse_versions(xml).unwrap();
        assert_eq!(
            versions.iter().map(|v| (v.key.as_str(), v.id.as_str(), v.latest, v.marker)).collect::<Vec<_>>(),
            [("p/a.html", "v1", true, false), ("p/a&b.html", "v2", true, true)]
        );
        assert_eq!(next, Some(("p/a&b.html".to_string(), "v2".to_string())));
        assert!(parse_versions(b"<ListBucketResult><Name>b</Name></ListBucketResult>").unwrap_err().contains("not its object versions"));
        assert!(parse_versions(b"not xml <").is_err());
    }

    #[test]
    fn a_listing_cut_short_or_missing_a_version_id_is_never_read_as_complete() {
        let cut = [
            &b"<ListVersionsResult><IsTruncated>false</IsTruncated>"[..],
            b"<ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>p/a.html</Key>",
            b"<ListVersionsResult><Name>b</Name></ListVersionsResult>",
            b"<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult><ListVersionsResult></ListVersionsResult>",
            b"<ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>p/a.html</Key><IsLatest>true</IsLatest></Version></ListVersionsResult>",
            b"<ListVersionsResult><IsTruncated>false</IsTruncated><DeleteMarker><VersionId>v</VersionId></DeleteMarker></ListVersionsResult>",
        ];
        for body in cut {
            assert!(parse_versions(body).is_err(), "{}", String::from_utf8_lossy(body));
        }
        let empty = parse_versions(b"<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>").unwrap();
        assert!(empty.versions.is_empty() && empty.next.is_none());
    }
}
