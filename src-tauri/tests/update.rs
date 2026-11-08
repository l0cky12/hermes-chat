//! Tauri's updater, the verifier this app ships (`tauri-plugin-updater`), against a release served from this computer.
//! The artifact was signed by `tauri signer sign` with two throwaway keys, deleted after signing. Only their public
//! halves and the signatures are here (docs/releases.md, "The verification tests").

use axum::body::{Body, Bytes};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri_plugin_updater::{Error, UpdaterExt};

/// Key A's public half, as `plugins.updater.pubkey` holds it: `a.key.pub` whole.
const KEY_A: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDgyRkJFNkNGQjhENTIwQTEKUldTaElOVzR6K2I3Z3I3cnEzejc0MjVBVzVRQmV3Y0huQUpnTkR0WnlqT3VYR3ZJaFJpSGRESmkK";
const KEY_B: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZDNzZDNjg0MTlCOTJENkYKUldSdkxia1poTVoyL0ppdGVwaHV5cTBSS3gwUnRYMy9WZnc3dFVIOXZnK01hNXNhK01kbk9lR1MK";
/// `tauri signer sign --app-version 2.0.0` over `payload()` with key A, as `latest.json` carries it.
const SIGNED_A_2_0_0: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTaElOVzR6K2I3Z2dnUkJVclVkMEVGQ0h1dGc4QWhUVi84Z0FPKzVoa3B1UXFWakVXeUptazRGNzcrV1V6QW1iTXJmeUtnTCt1VGJ6alJVRkIyRlhoeGhvem9ZYkJLRFFVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzOTE4NzQyCWZpbGU6cGF5bG9hZC5iaW4JdmVyc2lvbjoyLjAuMAo0QUtQOVp0ZGM2bFAwTHk0U21INUhuRG92NTdOdjcyRE51STlwbkwrUEljeGUvd0xSVURadXlDcEs0aldtb0R6Smt3NkJtbDc5M09JTmFaOTBNMk9CQT09Cg==";
const SIGNED_A_1_5_0: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTaElOVzR6K2I3Z3RpVXVobzBnSU0xQUhiQm9maDAydGh3SVJtYUFlNktXN21JdGxBUzd3VjZQYlJTWkthM3UxTVpLSFdWbkFycEllMHcyZ0dmcWFPeXByNzRnWnlmUFFZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzOTE4OTAwCWZpbGU6cGF5bG9hZC5iaW4JdmVyc2lvbjoxLjUuMAppQWFHTjZyK2kyMjVhYVVrYVBsZ3diRklQcXB4OWhseHFOU2liTVhmQkVKbFR0Vnp4Vy9sTUFKWk1mck9WMktCMmpjQnVBYUlBMm5VZ0swNUZ1T05DQT09Cg==";
const SIGNED_B_2_0_0: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSdkxia1poTVoyL0pRaU4vQkUrL2U5RUpscjA2NkxvV3MxWCtaSVkxOFloZ05HMjJNc1lRN1FleWtPTmhEWld2L1R0RTJxRzFndWZvcHdueWduV3hnYk5qQlRIRjd4bHd3PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzOTE4OTAxCWZpbGU6cGF5bG9hZC5iaW4JdmVyc2lvbjoyLjAuMApsVGhPMmRPeXRVWDJwa1p0S0UyNTVuK1dzajlyemlacDRBOGJUaVpUU081UjREY2t6aHhUcmRRVTRYL1ZqM1VmdkdldVlSOTNzbXRFS2ZCdzJuMXJBdz09Cg==";
/// Signed by key A without `--app-version`, as a Tauri CLI older than 2.9 signs.
const SIGNED_A_NO_VERSION: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTaElOVzR6K2I3Z2tlTXl0cUR4MVB3VVRscS9JajExUGlaV1ZZVEk3UGtlMlJLeHlZdkhudnZYSnhkV2tjU1dJaTVzM2JmWWdYODVxcTNna2Jidzk2ZndDVmJSZHovNkFrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzOTE4OTAxCWZpbGU6cGF5bG9hZC5iaW4KRjZ4R2ZnSTh2U0hUK3RrTU0wOGpzREFXRzZxcXRCcFZkbS9Vc0l5MmM1V3VsRFJGVlVRVXU1ajhtd0FIVHdSQzc1YXhVVnBKemprNldGbm9kbG1mQmc9PQo=";

/// The signed artifact: a full ELF header, the least the updater takes for an AppImage.
fn payload() -> Vec<u8> {
    let mut bytes = b"\x7fELF dry-run AppImage payload for tests".to_vec();
    bytes.resize(64, 0);
    bytes
}

const INSTALLED: &[u8] = b"\x7fELF the installed AppImage";

/// The mock app's own version, which every manifest is compared with.
const CURRENT: &str = "0.1.0";

/// What the release host answers for `/app.AppImage`.
enum Artifact {
    Bytes(Vec<u8>),
    Status(StatusCode),
    /// The first bytes, then nothing, for as long as the client waits.
    Stalls(Vec<u8>),
}

fn artifact_response(artifact: &Artifact) -> Response {
    match artifact {
        Artifact::Bytes(bytes) => bytes.clone().into_response(),
        Artifact::Status(status) => (*status).into_response(),
        Artifact::Stalls(first) => {
            let first = Bytes::from(first.clone());
            let stream = futures_util::stream::iter([Ok::<_, std::io::Error>(first)]).chain(futures_util::stream::pending());
            Response::builder().header(header::CONTENT_LENGTH, 1_000_000).body(Body::from_stream(stream)).unwrap()
        }
    }
}

/// A manifest for the host at the base URL given.
type Manifest = Box<dyn FnOnce(&str) -> Value + Send>;

/// Serves `/latest.json` and `/app.AppImage` on a port of this computer's, and returns the base URL.
async fn serve(manifest: Manifest, artifact: Artifact) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let manifest = manifest(&base);
    let artifact = Arc::new(artifact);
    let router = Router::new()
        .route("/latest.json", get(move || async move { axum::Json(manifest) }))
        .route("/app.AppImage", get(move || async move { artifact_response(&artifact) }));
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    base
}

fn target() -> String {
    format!("linux-{}", std::env::consts::ARCH)
}

/// A static manifest in the shape `scripts/release/manifest.mjs` writes.
fn manifest(version: &str, target: &str, base: &str, signature: &str) -> Value {
    json!({
        "version": version,
        "notes": "A dry run.",
        "pub_date": "2026-11-05T00:00:00Z",
        "platforms": { target: { "url": format!("{base}/app.AppImage"), "signature": signature } }
    })
}

/// An app that trusts `pubkey` and checks `endpoint`, as a release build reads them from its config.
fn app(pubkey: &str, endpoint: &str) -> tauri::App<MockRuntime> {
    app_at(CURRENT, pubkey, endpoint)
}

fn app_at(version: &str, pubkey: &str, endpoint: &str) -> tauri::App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = version.parse().unwrap();
    context.config_mut().plugins.0.insert(
        "updater".into(),
        json!({
            "pubkey": pubkey,
            "endpoints": [endpoint],
            "requireSignedVersion": true,
            // The host is this computer. A release build keeps the default and refuses a plain http endpoint.
            "dangerousInsecureTransportProtocol": true,
        }),
    );
    mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context).unwrap()
}

/// A fresh copy of the installed AppImage, in a folder of its own under the temporary directory, which the updater
/// needs to share a file system with.
fn installed(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("hermes-chat-update-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let appimage = dir.join("Hermes Chat.AppImage");
    std::fs::write(&appimage, INSTALLED).unwrap();
    std::fs::set_permissions(&appimage, std::fs::Permissions::from_mode(0o755)).unwrap();
    appimage
}

#[derive(Debug)]
enum Outcome {
    UpToDate,
    Installed,
    Refused(Error),
}

/// Checks the host and installs what it offers, as the app's Install button does, with the AppImage's bytes after.
async fn update(name: &str, pubkey: &str, manifest: Manifest, artifact: Artifact) -> (Outcome, Vec<u8>) {
    let base = serve(manifest, artifact).await;
    let appimage = installed(name);
    let app = app(pubkey, &format!("{base}/latest.json"));
    let updater = app.updater_builder().executable_path(&appimage).build().unwrap();
    let outcome = match updater.check().await {
        Ok(None) => Outcome::UpToDate,
        Ok(Some(update)) => match update.download_and_install(|_, _| {}, || {}).await {
            Ok(()) => Outcome::Installed,
            Err(e) => Outcome::Refused(e),
        },
        Err(e) => Outcome::Refused(e),
    };
    let after = std::fs::read(&appimage).unwrap();
    let _ = std::fs::remove_dir_all(appimage.parent().unwrap());
    (outcome, after)
}

/// A 2.0.0 release for this computer, with the signature given.
fn signed(signature: &'static str) -> Manifest {
    Box::new(move |base| manifest("2.0.0", &target(), base, signature))
}

#[tokio::test]
async fn a_genuine_release_replaces_the_appimage() {
    let base = serve(signed(SIGNED_A_2_0_0), Artifact::Bytes(payload())).await;
    let appimage = installed("genuine");
    let app = app(KEY_A, &format!("{base}/latest.json"));
    let updater = app.updater_builder().executable_path(&appimage).build().unwrap();
    let update = updater.check().await.unwrap().expect("2.0.0 is newer than 0.1.0");
    assert_eq!((update.version.as_str(), update.current_version.as_str()), ("2.0.0", CURRENT));
    assert_eq!(update.download_url.as_str(), format!("{base}/app.AppImage"));
    update.download_and_install(|_, _| {}, || {}).await.unwrap();
    assert_eq!(std::fs::read(&appimage).unwrap(), payload());
    assert_eq!(std::fs::metadata(&appimage).unwrap().permissions().mode() & 0o777, 0o755);
    std::fs::remove_dir_all(appimage.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn a_tampered_artifact_is_refused() {
    let mut tampered = payload();
    tampered[20] ^= 0x01;
    let (outcome, after) = update("tampered", KEY_A, signed(SIGNED_A_2_0_0), Artifact::Bytes(tampered)).await;
    assert!(matches!(outcome, Outcome::Refused(Error::Minisign(_))), "{outcome:?}");
    assert_eq!(after, INSTALLED);
}

#[tokio::test]
async fn a_truncated_artifact_is_refused() {
    let (outcome, after) = update("truncated", KEY_A, signed(SIGNED_A_2_0_0), Artifact::Bytes(payload()[..40].to_vec())).await;
    assert!(matches!(outcome, Outcome::Refused(Error::Minisign(_))), "{outcome:?}");
    assert_eq!(after, INSTALLED);
}

#[tokio::test]
async fn a_release_signed_with_another_key_is_refused() {
    // Key B's signature is sound: a build that trusts key B installs it. One that trusts key A refuses it, so a key
    // the app wasn't built with (a rotated one, or an attacker's) can't update it.
    let (outcome, after) = update("key-b-trusted", KEY_B, signed(SIGNED_B_2_0_0), Artifact::Bytes(payload())).await;
    assert!(matches!(outcome, Outcome::Installed), "{outcome:?}");
    assert_eq!(after, payload());
    let (outcome, after) = update("key-b-refused", KEY_A, signed(SIGNED_B_2_0_0), Artifact::Bytes(payload())).await;
    assert!(matches!(outcome, Outcome::Refused(Error::Minisign(_))), "{outcome:?}");
    assert_eq!(after, INSTALLED);
}

#[tokio::test]
async fn a_manifest_without_this_computers_target_is_refused() {
    let elsewhere: Manifest = Box::new(|base| manifest("2.0.0", "darwin-aarch64", base, SIGNED_A_2_0_0));
    let (outcome, after) = update("target", KEY_A, elsewhere, Artifact::Bytes(payload())).await;
    assert!(matches!(outcome, Outcome::Refused(Error::TargetsNotFound(_))), "{outcome:?}");
    assert_eq!(after, INSTALLED);
}

#[tokio::test]
async fn a_manifest_announcing_a_version_the_artifact_was_not_signed_for_is_refused() {
    // The manifest isn't signed. Without this check, a manifest edited to say 2.0.0 could serve the genuine 1.5.0
    // artifact, and the app would believe it had updated.
    let (outcome, after) = update("version", KEY_A, signed(SIGNED_A_1_5_0), Artifact::Bytes(payload())).await;
    assert!(matches!(outcome, Outcome::Refused(Error::SignedVersionMismatch { .. })), "{outcome:?}");
    assert_eq!(after, INSTALLED);
}

#[tokio::test]
async fn a_signature_without_a_version_is_refused() {
    let (outcome, after) = update("unversioned", KEY_A, signed(SIGNED_A_NO_VERSION), Artifact::Bytes(payload())).await;
    assert!(matches!(outcome, Outcome::Refused(Error::MissingSignedVersion)), "{outcome:?}");
    assert_eq!(after, INSTALLED);
}

#[tokio::test]
async fn an_older_or_the_same_version_is_not_an_update() {
    for (name, version) in [("older", "0.0.9"), ("same", CURRENT)] {
        let not_newer: Manifest = Box::new(move |base| manifest(version, &target(), base, SIGNED_A_2_0_0));
        let (outcome, after) = update(name, KEY_A, not_newer, Artifact::Status(StatusCode::INTERNAL_SERVER_ERROR)).await;
        assert!(matches!(outcome, Outcome::UpToDate), "{version}: {outcome:?}");
        assert_eq!(after, INSTALLED);
    }
}

#[tokio::test]
async fn a_download_that_fails_leaves_the_appimage_alone() {
    let (outcome, after) = update("failed", KEY_A, signed(SIGNED_A_2_0_0), Artifact::Status(StatusCode::INTERNAL_SERVER_ERROR)).await;
    assert!(matches!(outcome, Outcome::Refused(Error::Network(_))), "{outcome:?}");
    assert_eq!(after, INSTALLED);
}

#[tokio::test]
async fn a_download_given_up_on_leaves_the_appimage_alone() {
    // The updater has no cancel: the app gives up by dropping the download, as closing it does.
    let base = serve(signed(SIGNED_A_2_0_0), Artifact::Stalls(payload()[..32].to_vec())).await;
    let appimage = installed("stalled");
    let app = app(KEY_A, &format!("{base}/latest.json"));
    let updater = app.updater_builder().executable_path(&appimage).build().unwrap();
    let update = updater.check().await.unwrap().unwrap();
    let download = update.download_and_install(|_, _| {}, || {});
    assert!(tokio::time::timeout(Duration::from_secs(2), download).await.is_err(), "the download should still be waiting");
    assert_eq!(std::fs::read(&appimage).unwrap(), INSTALLED);
    std::fs::remove_dir_all(appimage.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn an_endpoint_that_does_not_answer_is_an_error_not_an_update() {
    let free = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    let appimage = installed("down");
    let app = app(KEY_A, &format!("http://{free}/latest.json"));
    let updater = app.updater_builder().executable_path(&appimage).build().unwrap();
    assert!(matches!(updater.check().await, Err(Error::Reqwest(_))));
    assert_eq!(std::fs::read(&appimage).unwrap(), INSTALLED);
    std::fs::remove_dir_all(appimage.parent().unwrap()).unwrap();
}

/// The folder `scripts/release/dry-run.sh` staged, installed by an app at 0.0.0 that trusts its public key:
/// what the pipeline produces is what the app's verifier takes. Runs only with `HERMES_TEST_RELEASE=<folder>`, which
/// the dry-run workflow sets after staging.
#[tokio::test]
async fn a_staged_release_installs() {
    let Some(dir) = std::env::var_os("HERMES_TEST_RELEASE").map(PathBuf::from) else {
        eprintln!("HERMES_TEST_RELEASE isn't set, so there is no staged release to install");
        return;
    };
    let staged: Value = serde_json::from_slice(&std::fs::read(dir.join("latest.json")).unwrap()).unwrap();
    let pubkey = std::fs::read_to_string(dir.join("updater.key.pub")).unwrap();
    let version = staged["version"].as_str().unwrap().to_owned();
    let platform = &staged["platforms"][target()];
    let signature = platform["signature"].as_str().unwrap().to_owned();
    let bytes = std::fs::read(dir.join(platform["url"].as_str().unwrap().rsplit('/').next().unwrap())).unwrap();
    let served = version.clone();
    let base = serve(Box::new(move |base| manifest(&served, &target(), base, &signature)), Artifact::Bytes(bytes.clone())).await;
    let appimage = installed("staged");
    let app = app_at("0.0.0", &pubkey, &format!("{base}/latest.json"));
    let update = app.updater_builder().executable_path(&appimage).build().unwrap().check().await.unwrap().expect("the staged version is newer");
    assert_eq!(update.version, version);
    update.download_and_install(|_, _| {}, || {}).await.unwrap();
    assert!(std::fs::read(&appimage).unwrap() == bytes, "the AppImage is the staged one");
    std::fs::remove_dir_all(appimage.parent().unwrap()).unwrap();
}

#[cfg(target_os = "linux")]
mod owned_by_a_package {
    use super::*;
    use hermes_chat::update::{Progress, Updates};
    use std::path::Path;
    use std::sync::OnceLock;

    /// Written once, before any test runs it: a script still open for writing in one test while another forks can't be
    /// run ("Text file busy").
    fn fake_pacman() -> &'static Path {
        static SCRIPT: OnceLock<PathBuf> = OnceLock::new();
        SCRIPT.get_or_init(|| {
            let script = Path::new(env!("CARGO_TARGET_TMPDIR")).join("fake-pacman");
            let body = "#!/bin/sh\ncase \"$1\" in\n  -Qqo) [ -e \"$2.owned\" ] && echo hermes-chat ;;\n  -Q) echo \"$2 0.2.0-1\" ;;\n  *) exit 2 ;;\nesac\n";
            std::fs::write(&script, body).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            script
        })
    }

    fn owned(appimage: &Path) -> PathBuf {
        PathBuf::from(format!("{}.owned", appimage.display()))
    }

    fn take_over(appimage: &Path) {
        std::fs::write(owned(appimage), "").unwrap();
    }

    fn release(appimage: &Path) {
        std::fs::remove_file(owned(appimage)).unwrap();
    }

    async fn setup(name: &str) -> (tauri::App<MockRuntime>, PathBuf, Updates) {
        let base = serve(signed(SIGNED_A_2_0_0), Artifact::Bytes(payload())).await;
        let appimage = installed(name);
        let updates = Updates::with_pacman(fake_pacman());
        (app(KEY_A, &format!("{base}/latest.json")), appimage, updates)
    }

    #[tokio::test]
    async fn an_appimage_no_package_owns_is_replaced() {
        let (app, appimage, updates) = setup("pkg-free").await;
        let updater = app.updater_builder().executable_path(&appimage).build().unwrap();
        assert!(updates.check(&updater, &appimage).await.unwrap().is_some());
        updates.install(&appimage, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&appimage).unwrap(), payload());
        std::fs::remove_dir_all(appimage.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn an_appimage_a_package_owns_is_refused_and_left_alone() {
        let (app, appimage, updates) = setup("pkg-owned").await;
        take_over(&appimage);
        let updater = app.updater_builder().executable_path(&appimage).build().unwrap();
        assert!(updates.check(&updater, &appimage).await.is_err());
        assert!(updates.install(&appimage, |_| {}).await.is_err());
        assert_eq!(std::fs::read(&appimage).unwrap(), INSTALLED);
        std::fs::remove_dir_all(appimage.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn an_appimage_a_package_takes_over_during_the_download_is_not_replaced() {
        let (app, appimage, updates) = setup("pkg-takeover").await;
        let updater = app.updater_builder().executable_path(&appimage).build().unwrap();
        assert!(updates.check(&updater, &appimage).await.unwrap().is_some());
        let result = updates
            .install(&appimage, |progress| {
                if matches!(progress, Progress::Downloading { .. }) {
                    take_over(&appimage);
                }
            })
            .await;
        assert!(result.is_err());
        assert_eq!(std::fs::read(&appimage).unwrap(), INSTALLED);
        release(&appimage);
        updates.install(&appimage, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&appimage).unwrap(), payload());
        std::fs::remove_dir_all(appimage.parent().unwrap()).unwrap();
    }
}
