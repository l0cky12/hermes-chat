//! Snapshots (ADR 0123) against a stand-in S3 on this computer: Publish and its read-back, the list, Copy link and
//! Revoke, with the stand-in checking every request's signature as S3 does.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use hermes_chat::lock::Locked;
use hermes_chat::snapshot::sigv4::{canonical_query, hex_sha256, uri_encode, Key, Request, UNSIGNED_PAYLOAD};
use hermes_chat::snapshot::{amz_date, parse_rfc3339, unix_now, Bucket, Expiry, HostEntry, Published, Snapshot, SnapshotHost, SnapshotId};
use percent_encoding::percent_decode_str;
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const BUCKET: &str = "snaps";
const PREFIX: &str = "hermes-chat-snapshots/";
const PAGE: &str = "<!doctype html>\r\n<meta charset=utf-8><title>Ünïcode ✓</title><p>bytes as handed in 🧪\n";

/// What the stand-in does with the next request of a method, in place of answering it.
enum Fault {
    /// No answer, nothing stored.
    Hang,
    /// Stores the upload, then never answers.
    StoreThenHang,
    /// Answers this status, nothing stored.
    Status(u16, &'static str),
    /// Stores these bytes in place of the upload's.
    StoreOther(&'static [u8]),
    /// Stores the upload, then a delete marker over it, and names no version.
    StoreThenMarker,
}

struct Stored {
    version: String,
    /// `None`: a delete marker.
    page: Option<(Vec<u8>, BTreeMap<String, String>)>,
}

struct Store {
    key_id: &'static str,
    secret: &'static str,
    versioned: bool,
    lists_versions: bool,
    page_size: usize,
    objects: BTreeMap<String, Vec<Stored>>,
    next_version: u64,
    faults: VecDeque<(Method, Fault)>,
    requests: Vec<String>,
    /// Signatures echoed back in refusals, as S3 does.
    echoed: Vec<String>,
}

type Shared = Arc<Mutex<Store>>;

struct StandIn {
    store: Shared,
    endpoint: String,
}

impl StandIn {
    async fn start(key_id: &'static str, secret: &'static str) -> Self {
        let store = Arc::new(Mutex::new(Store {
            key_id,
            secret,
            versioned: true,
            lists_versions: true,
            page_size: 1000,
            objects: BTreeMap::new(),
            next_version: 1,
            faults: VecDeque::new(),
            requests: Vec::new(),
            echoed: Vec::new(),
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().fallback(handle).with_state(store.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        StandIn { store, endpoint }
    }

    fn host(&self, key_id: &str) -> SnapshotHost {
        SnapshotHost { endpoint: self.endpoint.clone(), region: "us-east-1".into(), bucket: BUCKET.into(), prefix: PREFIX.into(), key_id: key_id.into() }
    }

    fn bucket(&self, key_id: &str, secret: &str) -> Bucket {
        Bucket::new(HostEntry::new(self.host(key_id), secret).unwrap(), Duration::from_millis(500)).unwrap()
    }

    fn fault(&self, method: Method, fault: Fault) {
        self.store.locked().faults.push_back((method, fault));
    }

    /// The versions of `key`, oldest first, each a body or `None` for a delete marker.
    fn versions(&self, key: &str) -> Vec<Option<Vec<u8>>> {
        self.store.locked().objects.get(key).map(|v| v.iter().map(|s| s.page.as_ref().map(|p| p.0.clone())).collect()).unwrap_or_default()
    }

    fn requests(&self) -> Vec<String> {
        self.store.locked().requests.clone()
    }
}

fn query_pairs(raw: &str) -> Vec<(String, String)> {
    let decode = |s: &str| percent_decode_str(s).decode_utf8().unwrap().into_owned();
    raw.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').map_or((decode(p), String::new()), |(k, v)| (decode(k), decode(v)))).collect()
}

fn amz_to_secs(date: &str) -> u64 {
    let d = date.as_bytes();
    let s = |r: std::ops::Range<usize>| std::str::from_utf8(&d[r]).unwrap();
    parse_rfc3339(&format!("{}-{}-{}T{}:{}:{}Z", s(0..4), s(4..6), s(6..8), s(9..11), s(11..13), s(13..15))).unwrap()
}

fn error(status: u16, code: &str, extra: &str) -> Response {
    let body = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>{code}</Code><Message>The stand-in says {code}.</Message>{extra}</Error>");
    (StatusCode::from_u16(status).unwrap(), body).into_response()
}

/// The refusal of a request whose signature, header or presigned, doesn't check out with the stand-in's own key.
fn verify(store: &mut Store, method: &Method, uri: &Uri, headers: &HeaderMap, body: &[u8]) -> Option<Response> {
    let path = percent_decode_str(uri.path()).decode_utf8().unwrap().into_owned();
    let mut query = query_pairs(uri.query().unwrap_or(""));
    let key = Key { id: store.key_id, secret: store.secret, region: "us-east-1" };
    let host = headers["host"].to_str().unwrap().to_string();
    let header = |n: &str| headers.get(n).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
    let (given, expected) = if let Some(i) = query.iter().position(|(k, _)| k == "X-Amz-Signature") {
        let given = query.remove(i).1;
        let get = |n: &str| query.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()).unwrap_or_default();
        if !get("X-Amz-Credential").starts_with(&format!("{}/", store.key_id)) {
            return Some(error(403, "InvalidAccessKeyId", ""));
        }
        let date = get("X-Amz-Date");
        if unix_now() > amz_to_secs(&date) + get("X-Amz-Expires").parse::<u64>().unwrap() {
            return Some(error(403, "AccessDenied", ""));
        }
        let signed = [("host".to_string(), host)];
        (given, key.signature(&Request { method: method.as_str(), path: &path, query: &query, headers: &signed, payload_hash: UNSIGNED_PAYLOAD }, &date))
    } else {
        let auth = header("authorization");
        let field = |name: &str| auth.split([' ', ',']).find_map(|p| p.strip_prefix(name)).unwrap_or_default().to_string();
        if !field("Credential=").starts_with(&format!("{}/", store.key_id)) {
            return Some(error(403, "InvalidAccessKeyId", ""));
        }
        if header("x-amz-content-sha256") != hex_sha256(body) {
            return Some(error(400, "XAmzContentSHA256Mismatch", ""));
        }
        let signed: Vec<(String, String)> = field("SignedHeaders=").split(';').map(|n| (n.to_string(), header(n))).collect();
        let request = Request { method: method.as_str(), path: &path, query: &query, headers: &signed, payload_hash: &header("x-amz-content-sha256") };
        (field("Signature="), key.signature(&request, &header("x-amz-date")))
    };
    if given != expected {
        store.echoed.push(given.clone());
        return Some(error(
            403,
            "SignatureDoesNotMatch",
            &format!("<StringToSign>AWS4-HMAC-SHA256 …</StringToSign><SignatureProvided>{given}</SignatureProvided>"),
        ));
    }
    None
}

fn page_response(version: &str, body: &[u8], meta: &BTreeMap<String, String>) -> Response {
    let mut response = body.to_vec().into_response();
    for (k, v) in meta {
        response.headers_mut().insert(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
    }
    response.headers_mut().insert("x-amz-version-id", version.parse().unwrap());
    response
}

fn listing(store: &Store, query: &[(String, String)]) -> Response {
    let get = |n: &str| query.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
    let prefix = get("prefix").unwrap_or_default();
    if !store.lists_versions {
        return format!("<ListBucketResult><Name>{BUCKET}</Name><Prefix>{prefix}</Prefix></ListBucketResult>").into_response();
    }
    let max = get("max-keys").map_or(1000, |m| m.parse().unwrap()).min(store.page_size);
    let entries: Vec<(&String, &Stored, bool)> = store
        .objects
        .iter()
        .filter(|(k, _)| k.starts_with(&prefix))
        .flat_map(|(k, versions)| versions.iter().rev().enumerate().map(move |(i, s)| (k, s, i == 0)))
        .collect();
    let start = match (get("key-marker"), get("version-id-marker")) {
        (Some(k), Some(v)) => entries.iter().position(|(key, s, _)| **key == k && s.version == v).map_or(0, |i| i + 1),
        _ => 0,
    };
    let page = &entries[start.min(entries.len())..(start + max).min(entries.len())];
    let truncated = start + max < entries.len();
    let mut xml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListVersionsResult><Name>{BUCKET}</Name><IsTruncated>{truncated}</IsTruncated>");
    if let (true, Some((k, s, _))) = (truncated, page.last()) {
        xml += &format!("<NextKeyMarker>{k}</NextKeyMarker><NextVersionIdMarker>{}</NextVersionIdMarker>", s.version);
    }
    for (k, s, latest) in page {
        let tag = if s.page.is_some() { "Version" } else { "DeleteMarker" };
        xml += &format!("<{tag}><Key>{k}</Key><VersionId>{}</VersionId><IsLatest>{latest}</IsLatest></{tag}>", s.version);
    }
    (xml + "</ListVersionsResult>").into_response()
}

enum Then {
    Answer(Response),
    Hang,
}

fn act(store: &mut Store, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Then {
    store.requests.push(format!("{method} {uri}"));
    if let Some(refused) = verify(store, &method, &uri, &headers, &body) {
        return Then::Answer(refused);
    }
    let path = percent_decode_str(uri.path()).decode_utf8().unwrap().into_owned();
    let query = query_pairs(uri.query().unwrap_or(""));
    let version_id = query.iter().find(|(k, _)| k == "versionId").map(|(_, v)| v.clone());
    let Some(rest) = path.strip_prefix(&format!("/{BUCKET}")) else { return Then::Answer(error(404, "NoSuchBucket", "")) };
    let fault = store.faults.iter().position(|(m, _)| *m == method).and_then(|i| store.faults.remove(i)).map(|(_, f)| f);
    if let Some(Fault::Hang) = fault {
        return Then::Hang;
    }
    if let Some(Fault::Status(status, code)) = fault {
        return Then::Answer(error(status, code, ""));
    }
    let key = rest.trim_start_matches('/').to_string();
    if key.is_empty() {
        return Then::Answer(if query.iter().any(|(k, _)| k == "versions") { listing(store, &query) } else { error(400, "NotImplemented", "") });
    }
    let new_version = |store: &mut Store| {
        store.next_version += 1;
        if store.versioned {
            format!("v{}", store.next_version)
        } else {
            "null".to_string()
        }
    };
    match method {
        Method::PUT => {
            let current = store.objects.get(&key).and_then(|v| v.last()).is_some_and(|s| s.page.is_some());
            if current && headers.get("if-none-match").is_some_and(|v| v == "*") {
                return Then::Answer(error(412, "PreconditionFailed", ""));
            }
            let kept = ["content-type", "content-disposition", "cache-control"];
            let meta = headers
                .iter()
                .filter(|(k, _)| k.as_str().starts_with("x-amz-meta-") || kept.contains(&k.as_str()))
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
                .collect();
            let bytes = match fault {
                Some(Fault::StoreOther(other)) => other.to_vec(),
                _ => body.to_vec(),
            };
            let version = new_version(store);
            let versioned = store.versioned;
            let versions = store.objects.entry(key.clone()).or_default();
            if !versioned {
                versions.clear();
            }
            versions.push(Stored { version: version.clone(), page: Some((bytes, meta)) });
            match fault {
                Some(Fault::StoreThenHang) => Then::Hang,
                Some(Fault::StoreThenMarker) => {
                    let marker = new_version(store);
                    store.objects.get_mut(&key).unwrap().push(Stored { version: marker, page: None });
                    Then::Answer(StatusCode::OK.into_response())
                }
                _ => Then::Answer(([("x-amz-version-id", version)], "").into_response()),
            }
        }
        Method::GET => {
            let versions = store.objects.get(&key);
            let found = match &version_id {
                Some(v) => versions.and_then(|vs| vs.iter().find(|s| s.version == *v)),
                None => versions.and_then(|vs| vs.last()),
            };
            Then::Answer(match found {
                Some(Stored { version, page: Some((body, meta)) }) => page_response(version, body, meta),
                Some(Stored { page: None, .. }) => {
                    let status = if version_id.is_some() { StatusCode::METHOD_NOT_ALLOWED } else { StatusCode::NOT_FOUND };
                    (status, [("x-amz-delete-marker", "true")], "").into_response()
                }
                None => error(404, "NoSuchKey", ""),
            })
        }
        Method::DELETE => {
            let versioned = store.versioned;
            match version_id {
                Some(v) => {
                    if let Some(vs) = store.objects.get_mut(&key) {
                        vs.retain(|s| s.version != v);
                    }
                }
                None if versioned => {
                    let marker = new_version(store);
                    store.objects.entry(key.clone()).or_default().push(Stored { version: marker, page: None });
                }
                None => {
                    store.objects.remove(&key);
                }
            }
            store.objects.retain(|_, vs| !vs.is_empty());
            Then::Answer(StatusCode::NO_CONTENT.into_response())
        }
        _ => Then::Answer(error(405, "MethodNotAllowed", "")),
    }
}

async fn handle(State(store): State<Shared>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    let then = act(&mut store.locked(), method, uri, headers, body);
    match then {
        Then::Answer(response) => response,
        Then::Hang => std::future::pending().await,
    }
}

fn live(published: Published) -> (String, String, String) {
    match published {
        Published::Live { snapshot: Snapshot::Live { id, expires, url, .. } } => (id, expires, url),
        other => panic!("not Live: {other:?}"),
    }
}

async fn fetch(url: &str) -> reqwest::Response {
    reqwest::get(url).await.unwrap()
}

fn key_of(id: &SnapshotId) -> String {
    id.key(PREFIX)
}

#[tokio::test]
async fn a_published_page_is_stored_and_linked_byte_for_byte() {
    let s3 = StandIn::start("AKID", "s3cret").await;
    let bucket = s3.bucket("AKID", "s3cret");
    let id = SnapshotId::random();
    let now = unix_now();
    let (got, expires, url) = live(bucket.publish(&id, PAGE.as_bytes(), "A chat ✓", Expiry::Day, now).await);
    assert_eq!(got, id.as_str());
    assert_eq!(parse_rfc3339(&expires), Some(now + 86_400));
    assert_eq!(s3.versions(&key_of(&id)), [Some(PAGE.as_bytes().to_vec())], "the bytes stored are the bytes handed in");
    assert!(url.contains("versionId=v"), "the link names the version: {url}");

    let response = fetch(&url).await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "text/html; charset=utf-8");
    assert_eq!(response.headers()["content-disposition"], "inline");
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    assert_eq!(response.bytes().await.unwrap(), PAGE.as_bytes());

    let again = bucket.link(&id, now + 100).await.unwrap();
    assert!(again.contains("X-Amz-Expires=86300"), "a copied link ends when the first one does: {again}");
    assert_eq!(fetch(&again).await.bytes().await.unwrap(), PAGE.as_bytes());

    let list = bucket.list(now).await.unwrap();
    assert!(matches!(&list[..], [Snapshot::Live { id: listed, title, .. }] if listed == id.as_str() && title == "A chat ✓"), "{list:?}");
}

#[tokio::test]
async fn a_refused_credential_is_not_published_and_its_signature_is_never_shown() {
    let s3 = StandIn::start("AKID", "s3cret").await;
    let wrong = s3.bucket("AKID", "not-the-secret");
    let id = SnapshotId::random();
    let Published::NotPublished { reason } = wrong.publish(&id, PAGE.as_bytes(), "t", Expiry::Hour, unix_now()).await else { panic!("published") };
    assert!(reason.starts_with("The host refused the access key (SignatureDoesNotMatch"), "{reason}");
    let test = wrong.test(unix_now()).await.unwrap_err();
    assert!(test.starts_with("The host refused the access key"), "{test}");
    let echoed = s3.store.locked().echoed.clone();
    assert_eq!(echoed.len(), 2);
    for text in [&reason, &test] {
        assert!(!text.contains("not-the-secret") && !text.contains("StringToSign") && echoed.iter().all(|sig| !text.contains(sig.as_str())), "{text}");
    }
    assert!(s3.versions(&key_of(&id)).is_empty());

    let unknown = s3.bucket("SOMEONE-ELSE", "s3cret");
    assert!(unknown.test(unix_now()).await.unwrap_err().contains("InvalidAccessKeyId"));
    assert_eq!(s3.bucket("AKID", "s3cret").test(unix_now()).await, Ok(()));
}

#[tokio::test]
async fn a_repeated_key_is_never_written_over() {
    let s3 = StandIn::start("AKID", "s3cret").await;
    let bucket = s3.bucket("AKID", "s3cret");
    let id = SnapshotId::random();
    let now = unix_now();
    let (_, first_expires, _) = live(bucket.publish(&id, PAGE.as_bytes(), "t", Expiry::Day, now).await);
    let (_, expires, url) = live(bucket.publish(&id, PAGE.as_bytes(), "t", Expiry::Week, now + 5).await);
    assert_eq!(expires, first_expires, "a 412 reads back the snapshot the host already holds");
    assert_eq!(fetch(&url).await.bytes().await.unwrap(), PAGE.as_bytes());

    let other = bucket.publish(&id, b"<p>another page", "t", Expiry::Day, now).await;
    assert!(matches!(&other, Published::MaybeSent { reason } if reason.contains("different page")), "{other:?}");
    assert_eq!(s3.versions(&key_of(&id)), [Some(PAGE.as_bytes().to_vec())]);
    assert!(s3.requests().iter().filter(|r| r.starts_with("PUT")).count() == 3);
}

#[tokio::test]
async fn a_lost_answer_is_settled_by_sending_the_put_again() {
    let s3 = StandIn::start("AKID", "s3cret").await;
    let bucket = s3.bucket("AKID", "s3cret");
    let now = unix_now();

    let written = SnapshotId::random();
    s3.fault(Method::PUT, Fault::StoreThenHang);
    live(bucket.publish(&written, PAGE.as_bytes(), "t", Expiry::Day, now).await);
    assert_eq!(s3.versions(&key_of(&written)), [Some(PAGE.as_bytes().to_vec())], "the second PUT's 412 settled it, with one copy");

    let unwritten = SnapshotId::random();
    s3.fault(Method::PUT, Fault::Hang);
    live(bucket.publish(&unwritten, PAGE.as_bytes(), "t", Expiry::Day, now).await);
    assert_eq!(s3.versions(&key_of(&unwritten)).len(), 1);

    let twice = SnapshotId::random();
    s3.fault(Method::PUT, Fault::Hang);
    s3.fault(Method::PUT, Fault::StoreThenHang);
    let lost = bucket.publish(&twice, PAGE.as_bytes(), "t", Expiry::Day, now).await;
    assert!(matches!(&lost, Published::MaybeSent { reason } if reason.contains("two tries")), "{lost:?}");

    let refused_after_lost = SnapshotId::random();
    s3.fault(Method::PUT, Fault::Hang);
    s3.fault(Method::PUT, Fault::Status(403, "AccessDenied"));
    let refused = bucket.publish(&refused_after_lost, PAGE.as_bytes(), "t", Expiry::Day, now).await;
    assert!(matches!(&refused, Published::NotPublished { .. }), "a listing shows nothing under the key: {refused:?}");

    let written_then_refused = SnapshotId::random();
    s3.fault(Method::PUT, Fault::StoreThenHang);
    s3.fault(Method::PUT, Fault::Status(403, "AccessDenied"));
    let maybe = bucket.publish(&written_then_refused, PAGE.as_bytes(), "t", Expiry::Day, now).await;
    assert!(matches!(&maybe, Published::MaybeSent { .. }), "a listing shows the first PUT's copy: {maybe:?}");

    let server_error = SnapshotId::random();
    s3.fault(Method::PUT, Fault::Status(500, "InternalError"));
    live(bucket.publish(&server_error, PAGE.as_bytes(), "t", Expiry::Day, now).await);
}

#[tokio::test]
async fn a_read_back_that_fails_or_differs_says_the_page_may_have_been_sent() {
    let s3 = StandIn::start("AKID", "s3cret").await;
    let bucket = s3.bucket("AKID", "s3cret");
    let now = unix_now();
    let maybe = |p: Published, needle: &str| assert!(matches!(&p, Published::MaybeSent { reason } if reason.contains(needle)), "{needle}: {p:?}");

    s3.fault(Method::PUT, Fault::StoreThenMarker);
    maybe(bucket.publish(&SnapshotId::random(), PAGE.as_bytes(), "t", Expiry::Day, now).await, "deleted");

    s3.fault(Method::PUT, Fault::StoreOther(b"<p>not the page"));
    maybe(bucket.publish(&SnapshotId::random(), PAGE.as_bytes(), "t", Expiry::Day, now).await, "different page");

    s3.fault(Method::GET, Fault::Status(500, "InternalError"));
    maybe(bucket.publish(&SnapshotId::random(), PAGE.as_bytes(), "t", Expiry::Day, now).await, "reading it back failed");

    s3.fault(Method::PUT, Fault::Status(501, "NotImplemented"));
    let refused = bucket.publish(&SnapshotId::random(), PAGE.as_bytes(), "t", Expiry::Day, now).await;
    assert!(matches!(&refused, Published::NotPublished { reason } if reason.contains("doesn't support")), "{refused:?}");
}

#[tokio::test]
async fn the_list_deletes_an_expired_snapshot_and_shows_one_it_couldnt() {
    let s3 = StandIn::start("AKID", "s3cret").await;
    let bucket = s3.bucket("AKID", "s3cret");
    let now = unix_now();
    let old = SnapshotId::random();
    live(bucket.publish(&old, PAGE.as_bytes(), "old", Expiry::Hour, now - 7200).await);
    let current = SnapshotId::random();
    live(bucket.publish(&current, PAGE.as_bytes(), "current", Expiry::Day, now).await);

    let list = bucket.list(now).await.unwrap();
    assert_eq!(list.iter().map(Snapshot::id).collect::<Vec<_>>(), [current.as_str()]);
    assert!(s3.versions(&key_of(&old)).is_empty(), "every version of the expired one is gone");
    assert_eq!(bucket.link(&old, now).await.unwrap_err(), "This snapshot isn't in the bucket any more.");

    let stuck = SnapshotId::random();
    live(bucket.publish(&stuck, PAGE.as_bytes(), "stuck", Expiry::Hour, now - 7200).await);
    for _ in 0..3 {
        s3.fault(Method::DELETE, Fault::Status(403, "AccessDenied"));
    }
    let list = bucket.list(now).await.unwrap();
    assert!(list.iter().any(|s| matches!(s, Snapshot::Expired { id, title, .. } if id == stuck.as_str() && title == "stuck")), "{list:?}");
    assert_eq!(bucket.link(&stuck, now).await.unwrap_err(), "This snapshot has expired, so it has no link.");
}

#[tokio::test]
async fn a_page_written_by_something_else_shows_as_changed() {
    let s3 = StandIn::start("AKID", "s3cret").await;
    let bucket = s3.bucket("AKID", "s3cret");
    let now = unix_now();
    let id = SnapshotId::random();
    live(bucket.publish(&id, PAGE.as_bytes(), "t", Expiry::Day, now).await);
    {
        let mut store = s3.store.locked();
        let page = store.objects.get_mut(&key_of(&id)).unwrap().last_mut().unwrap().page.as_mut().unwrap();
        page.0 = b"<script>tampered</script>".to_vec();
    }
    let list = bucket.list(now).await.unwrap();
    assert!(
        matches!(&list[..], [Snapshot::Changed { id: changed, title: Some(t), created: Some(_), expires: Some(_) }] if changed == id.as_str() && t == "t"),
        "{list:?}"
    );
    assert!(bucket.link(&id, now).await.unwrap_err().contains("changed"));
    assert_eq!(bucket.revoke(&id, now).await, Ok(()));
    assert!(bucket.list(now).await.unwrap().is_empty());
}

#[tokio::test]
async fn revoke_removes_every_version_even_when_a_plain_get_already_fails() {
    let s3 = StandIn::start("AKID", "s3cret").await;
    let bucket = s3.bucket("AKID", "s3cret");
    let now = unix_now();
    let id = SnapshotId::random();
    let (_, _, url) = live(bucket.publish(&id, PAGE.as_bytes(), "t", Expiry::Day, now).await);
    {
        let mut store = s3.store.locked();
        store.objects.get_mut(&key_of(&id)).unwrap().push(Stored { version: "v-marker".into(), page: None });
    }
    assert_eq!(bucket.link(&id, now).await.unwrap_err(), "This snapshot isn't in the bucket any more.", "a plain GET fails");
    assert_eq!(fetch(&url).await.status(), 200, "the older version still holds the page");
    let list = bucket.list(now).await.unwrap();
    assert_eq!(list, [Snapshot::Unrevoked { id: id.as_str().to_string() }]);

    for _ in 0..6 {
        s3.fault(Method::DELETE, Fault::Status(403, "AccessDenied"));
    }
    let err = bucket.revoke(&id, now).await.unwrap_err();
    assert!(err.starts_with("Revoke may not have worked: 2 copies of the page are still in the bucket. The host refused the access key"), "{err}");

    assert_eq!(bucket.revoke(&id, now).await, Ok(()));
    assert!(s3.versions(&key_of(&id)).is_empty());
    assert_eq!(fetch(&url).await.status(), 404);
    assert!(bucket.list(now).await.unwrap().is_empty());
    assert_eq!(bucket.revoke(&id, now).await, Ok(()), "a second Revoke finds nothing left");
}

#[tokio::test]
async fn the_list_follows_every_page_of_the_version_listing() {
    let s3 = StandIn::start("AKID", "s3cret").await;
    s3.store.locked().page_size = 2;
    let bucket = s3.bucket("AKID", "s3cret");
    let now = unix_now();
    let mut ids = Vec::new();
    for i in 0..4 {
        let id = SnapshotId::random();
        live(bucket.publish(&id, PAGE.as_bytes(), &format!("t{i}"), Expiry::Day, now + i).await);
        ids.push(id);
    }
    let other = Stored { version: "v-x".into(), page: Some((b"x".to_vec(), BTreeMap::new())) };
    s3.store.locked().objects.insert(format!("{PREFIX}not-a-snapshot.txt"), vec![other]);
    let revoked = &ids[1];
    s3.store.locked().objects.get_mut(&key_of(revoked)).unwrap().push(Stored { version: "v-m".into(), page: None });

    let list = bucket.list(now).await.unwrap();
    let mut listed: Vec<&str> = list.iter().map(Snapshot::id).collect();
    listed.sort();
    let mut expected: Vec<&str> = ids.iter().map(SnapshotId::as_str).collect();
    expected.sort();
    assert_eq!(listed, expected);
    assert!(list.iter().any(|s| *s == Snapshot::Unrevoked { id: revoked.as_str().to_string() }));
    assert!(s3.requests().iter().filter(|r| r.contains("version-id-marker=")).count() >= 2, "the listing came in pages");

    assert_eq!(bucket.revoke(revoked, now).await, Ok(()));
    assert!(s3.versions(&key_of(revoked)).is_empty());
}

#[tokio::test]
async fn settings_and_secret_change_together_so_a_secret_never_goes_to_another_host() {
    let first = StandIn::start("KEY-ONE", "secret-one").await;
    let second = StandIn::start("KEY-TWO", "secret-two").await;
    let now = unix_now();

    let saved = HostEntry::new(first.host("KEY-ONE"), "secret-one").unwrap().to_json();
    let bucket = Bucket::new(HostEntry::read(&saved).unwrap(), Duration::from_secs(5)).unwrap();
    live(bucket.publish(&SnapshotId::random(), PAGE.as_bytes(), "t", Expiry::Day, now).await);
    let to_first = first.requests().len();

    let saved = HostEntry::new(second.host("KEY-TWO"), "secret-two").unwrap().to_json();
    assert!(saved.contains(&second.endpoint) && saved.contains("secret-two") && !saved.contains("secret-one"));
    let bucket = Bucket::new(HostEntry::read(&saved).unwrap(), Duration::from_secs(5)).unwrap();
    assert_eq!(bucket.host(), &second.host("KEY-TWO"));
    live(bucket.publish(&SnapshotId::random(), PAGE.as_bytes(), "t", Expiry::Day, now).await);
    assert_eq!(bucket.list(now).await.unwrap().len(), 1);
    assert_eq!(first.requests().len(), to_first, "nothing more went to the first host");
    assert!(second.store.locked().echoed.is_empty(), "every request to the second host was signed with its own secret");

    let old_secret_new_host = Bucket::new(HostEntry::new(second.host("KEY-TWO"), "secret-one").unwrap(), Duration::from_secs(5)).unwrap();
    assert!(old_secret_new_host.test(now).await.unwrap_err().contains("SignatureDoesNotMatch"));
}

#[tokio::test]
async fn test_refuses_a_host_without_version_listings() {
    let s3 = StandIn::start("AKID", "s3cret").await;
    s3.store.locked().lists_versions = false;
    let err = s3.bucket("AKID", "s3cret").test(unix_now()).await.unwrap_err();
    assert_eq!(err, "The host lists the bucket but not its object versions, which Revoke needs.");
    assert!(s3.requests().iter().all(|r| r.starts_with("GET ")), "Test writes nothing");
}

#[tokio::test]
async fn an_unversioned_bucket_gets_links_without_a_version() {
    let s3 = StandIn::start("AKID", "s3cret").await;
    s3.store.locked().versioned = false;
    let bucket = s3.bucket("AKID", "s3cret");
    let now = unix_now();
    let id = SnapshotId::random();
    let (_, _, url) = live(bucket.publish(&id, PAGE.as_bytes(), "t", Expiry::Day, now).await);
    assert!(!url.contains("versionId"), "{url}");
    assert_eq!(fetch(&url).await.bytes().await.unwrap(), PAGE.as_bytes());
    assert_eq!(bucket.revoke(&id, now).await, Ok(()));
    assert_eq!(fetch(&url).await.status(), 404);
}

#[tokio::test]
#[ignore = "needs a real S3-compatible bucket with versioning on (HERMES_TEST_S3_ENDPOINT, _REGION, _BUCKET, _KEY_ID, _SECRET); writes only under a fresh random prefix and revokes what it publishes"]
async fn against_a_real_bucket_a_link_works_until_revoke_and_no_version_is_left() {
    let var = |name: &str| std::env::var(format!("HERMES_TEST_S3_{name}")).unwrap_or_else(|_| panic!("HERMES_TEST_S3_{name}"));
    let prefix = format!("hermes-chat-live-{}/", SnapshotId::random().as_str());
    let host = SnapshotHost { endpoint: var("ENDPOINT"), region: var("REGION"), bucket: var("BUCKET"), prefix: prefix.clone(), key_id: var("KEY_ID") };
    let secret = var("SECRET");
    let bucket = Bucket::new(HostEntry::new(host.clone(), &secret).unwrap(), Duration::from_secs(60)).unwrap();
    let wrong = Bucket::new(HostEntry::new(host.clone(), "not-the-secret").unwrap(), Duration::from_secs(60)).unwrap();
    let refused = wrong.test(unix_now()).await.unwrap_err();
    println!("Test with a wrong secret: {refused}");
    assert!(refused.starts_with("The host refused the access key"));
    bucket.test(unix_now()).await.expect("Test lists the prefix's versions");
    println!("Test: ok, prefix {prefix}");

    let id = SnapshotId::random();
    let (_, expires, url) = live(bucket.publish(&id, PAGE.as_bytes(), "Live run ✓", Expiry::Day, unix_now()).await);
    println!("Published {} until {expires}", id.as_str());
    let response = fetch(&url).await;
    println!("GET link: {} {:?}", response.status(), response.headers());
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "text/html; charset=utf-8");
    assert_eq!(response.headers()["content-disposition"], "inline");
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    assert_eq!(response.bytes().await.unwrap(), PAGE.as_bytes(), "the bytes served are the bytes handed in");

    let version = |url: &str| query_pairs(url.split_once('?').unwrap().1).into_iter().find(|(k, _)| k == "versionId").map(|(_, v)| v);
    let (_, _, again) = live(bucket.publish(&id, PAGE.as_bytes(), "Live run ✓", Expiry::Day, unix_now()).await);
    println!("Publish again under the same key: versionId {:?} then {:?}", version(&url), version(&again));
    assert!(version(&url).is_some(), "a versioned bucket names the version");
    assert_eq!(version(&url), version(&again), "If-None-Match: * kept the first version");

    let copied = bucket.link(&id, unix_now()).await.unwrap();
    assert_eq!(fetch(&copied).await.bytes().await.unwrap(), PAGE.as_bytes());
    println!("Copy link: 200, same bytes");
    let list = bucket.list(unix_now()).await.unwrap();
    println!("List: {list:?}");
    assert!(matches!(&list[..], [Snapshot::Live { id: listed, title, .. }] if listed == id.as_str() && title == "Live run ✓"));

    let endpoint = url::Url::parse(&host.endpoint).unwrap();
    let authority = match endpoint.port() {
        Some(port) => format!("{}:{port}", endpoint.host_str().unwrap()),
        None => endpoint.host_str().unwrap().to_string(),
    };
    let path = format!("/{}/{}", host.bucket, id.key(&prefix));
    let key = Key { id: &host.key_id, secret: &secret, region: &host.region };
    let signed = |signed_at: u64, expires: u64| {
        let query = key.presign("GET", &authority, &path, &[], &amz_date(signed_at), expires);
        format!("{}{}?{}", host.endpoint, uri_encode(&path, true), canonical_query(&query))
    };
    let fresh = fetch(&signed(unix_now() - 10, 3600)).await.status();
    let hour_old = fetch(&signed(unix_now() - 3610, 3600)).await;
    let hour_old = (hour_old.status(), hour_old.text().await.unwrap());
    let short = signed(unix_now(), 1);
    tokio::time::sleep(Duration::from_secs(3)).await;
    let short = fetch(&short).await;
    let short = (short.status(), short.text().await.unwrap());
    println!("A 1-hour link signed 10 s ago: {fresh}");
    println!("A 1-hour link signed 1 h 10 s ago: {} {}", hour_old.0, hour_old.1);
    println!("A 1-second link after 3 s: {} {}", short.0, short.1);
    assert_eq!(fresh, 200);
    assert_eq!(hour_old.0, 403, "a link past its hour is refused");
    assert_eq!(short.0, 403, "a link past its X-Amz-Expires is refused");

    bucket.revoke(&id, unix_now()).await.expect("Revoke");
    for link in [&url, &again, &copied] {
        let status = fetch(link).await.status();
        println!("GET old link after Revoke: {status}");
        assert_ne!(status, 200);
    }
    assert!(bucket.list(unix_now()).await.unwrap().is_empty(), "no version or delete marker of the key is left");
    println!("List after Revoke: empty");
}
