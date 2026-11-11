// Screenshots for the composer (src/screenshot.rs): which way a capture is taken on each desktop, what slurp, grim and
// the portal's answers mean, and the private folder captures wait in until they are sent or removed. The capture tools
// themselves need a desktop; they were checked by hand (see the PR).
use hermes_chat::screenshot::{self, portal, CaptureError, Captures, Method, Windows};
use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    move |k| map.get(k).cloned()
}
fn tools(names: &'static [&'static str]) -> impl Fn(&str) -> bool {
    move |t| names.contains(&t)
}

#[test]
fn picks_slurp_and_grim_on_wlroots_compositors_and_the_portal_elsewhere() {
    let hypr = env(&[("WAYLAND_DISPLAY", "wayland-1"), ("HYPRLAND_INSTANCE_SIGNATURE", "abc"), ("XDG_CURRENT_DESKTOP", "Hyprland")]);
    assert_eq!(screenshot::plan(&hypr, tools(&["grim", "slurp", "hyprctl"])), Method::GrimSlurp(Windows::Hyprland));
    // Without hyprctl, slurp still picks regions.
    assert_eq!(screenshot::plan(&hypr, tools(&["grim", "slurp"])), Method::GrimSlurp(Windows::None));
    // Without slurp or grim nothing is captured: the portal there can't let the owner pick, so it would take the whole
    // screen without asking.
    assert_eq!(screenshot::plan(&hypr, tools(&["grim"])), Method::NeedsSlurpAndGrim);
    assert_eq!(screenshot::plan(&hypr, tools(&["slurp", "hyprctl"])), Method::NeedsSlurpAndGrim);

    let sway = env(&[("WAYLAND_DISPLAY", "wayland-1"), ("SWAYSOCK", "/run/user/1000/sway-ipc.sock")]);
    assert_eq!(screenshot::plan(&sway, tools(&["grim", "slurp", "swaymsg"])), Method::GrimSlurp(Windows::Sway));
    let river = env(&[("WAYLAND_DISPLAY", "wayland-1"), ("XDG_CURRENT_DESKTOP", "river")]);
    assert_eq!(screenshot::plan(&river, tools(&["grim", "slurp"])), Method::GrimSlurp(Windows::None));

    // GNOME and Plasma have their own picker behind the portal, even with grim and slurp installed.
    let all = tools(&["grim", "slurp", "hyprctl", "swaymsg"]);
    for desktop in ["GNOME", "KDE", "ubuntu:GNOME"] {
        let e = env(&[("WAYLAND_DISPLAY", "wayland-0"), ("XDG_CURRENT_DESKTOP", desktop)]);
        assert_eq!(screenshot::plan(&e, &all), Method::Portal, "{desktop}");
    }
    // An X11 session, even of a desktop named like a wlroots one, goes through the portal.
    let x11 = env(&[("DISPLAY", ":0"), ("XDG_SESSION_TYPE", "x11"), ("XDG_CURRENT_DESKTOP", "sway")]);
    assert_eq!(screenshot::plan(&x11, &all), Method::Portal);
    assert_eq!(screenshot::plan(env(&[]), &all), Method::Portal);
}

#[test]
fn reads_what_slurp_answers() {
    assert_eq!(screenshot::slurp_outcome(true, b"12,-40 300x200\n", b""), Ok("12,-40 300x200".into()));
    assert_eq!(screenshot::slurp_outcome(false, b"", b"selection cancelled\n"), Err(CaptureError::Cancelled));
    assert!(matches!(
        screenshot::slurp_outcome(false, b"", b"compositor doesn't support wlr-layer-shell-unstable-v1\n"),
        Err(CaptureError::Unsupported(m)) if m.contains("layer-shell")
    ));
    assert!(
        matches!(screenshot::slurp_outcome(false, b"", b"failed to create display\n"), Err(CaptureError::Failed(m)) if m.contains("failed to create display"))
    );
    // Anything but a non-empty region is refused, so nothing odd reaches grim's arguments.
    for odd in [&b""[..], b"0,0 0x10", b"--help", b"1,2 3x4 extra", b"a,b cxd"] {
        assert!(matches!(screenshot::slurp_outcome(true, odd, b""), Err(CaptureError::Failed(_))), "{:?}", String::from_utf8_lossy(odd));
    }
}

#[test]
fn reads_what_grim_answers() {
    assert_eq!(screenshot::grim_outcome(true, b""), Ok(()));
    assert!(matches!(screenshot::grim_outcome(false, b"compositor doesn't support wlr-screencopy-unstable-v1\n"), Err(CaptureError::Unsupported(_))));
    assert!(matches!(screenshot::grim_outcome(false, b"failed to write png\n"), Err(CaptureError::Failed(m)) if m.contains("failed to write png")));
}

#[cfg(unix)]
#[test]
fn reads_the_portal_answer() {
    assert_eq!(portal::response(0, Some("file:///tmp/Screenshot%20from%20now.png")), Ok(PathBuf::from("/tmp/Screenshot from now.png")));
    assert_eq!(portal::response(1, None), Err(CaptureError::Cancelled));
    assert!(matches!(portal::response(2, None), Err(CaptureError::Denied(m)) if m.contains("privacy")));
    assert!(matches!(portal::response(0, None), Err(CaptureError::Failed(_))));
    assert!(matches!(portal::response(0, Some("https://example.com/a.png")), Err(CaptureError::Failed(_))));
}

#[test]
fn explains_portal_errors() {
    assert!(matches!(portal::explain("org.freedesktop.DBus.Error.ServiceUnknown", "x"), CaptureError::Unsupported(m) if m.contains("xdg-desktop-portal")));
    assert!(matches!(portal::explain("org.freedesktop.DBus.Error.UnknownMethod", "x"), CaptureError::Unsupported(_)));
    assert!(matches!(portal::explain("org.freedesktop.portal.Error.NotAllowed", "x"), CaptureError::Denied(_)));
    assert!(matches!(portal::explain("org.freedesktop.DBus.Error.AccessDenied", "x"), CaptureError::Denied(_)));
    assert!(matches!(portal::explain("org.freedesktop.DBus.Error.NoReply", "timed out"), CaptureError::Failed(m) if m.contains("timed out")));
}

#[test]
fn errors_reach_the_webview_as_kind_and_message() {
    assert_eq!(serde_json::to_value(CaptureError::Cancelled).unwrap(), serde_json::json!({ "kind": "cancelled" }));
    assert_eq!(serde_json::to_value(CaptureError::Denied("no".into())).unwrap(), serde_json::json!({ "kind": "denied", "message": "no" }));
}

#[test]
fn outlines_the_windows_on_screen_for_slurp() {
    let monitors = r#"[{"activeWorkspace":{"id":1},"specialWorkspace":{"id":0}},{"activeWorkspace":{"id":4},"specialWorkspace":{"id":-98}}]"#;
    let clients = r#"[
        {"at":[10,20],"size":[800,600],"workspace":{"id":1},"mapped":true,"hidden":false},
        {"at":[1930,0],"size":[640,480],"workspace":{"id":4},"mapped":true,"hidden":false},
        {"at":[0,0],"size":[300,300],"workspace":{"id":2},"mapped":true,"hidden":false},
        {"at":[5,5],"size":[100,100],"workspace":{"id":1},"mapped":true,"hidden":true},
        {"at":[5,5],"size":[100,100],"workspace":{"id":-98},"mapped":true,"hidden":false},
        {"at":[5,5],"size":[0,100],"workspace":{"id":1},"mapped":true,"hidden":false}
    ]"#;
    assert_eq!(screenshot::hyprland_boxes(clients, monitors), ["10,20 800x600", "1930,0 640x480", "5,5 100x100"]);
    assert!(screenshot::hyprland_boxes("not json", monitors).is_empty());

    let tree = r#"{"type":"root","nodes":[{"type":"output","nodes":[{"type":"workspace","nodes":[
        {"type":"con","pid":42,"app_id":"foot","visible":true,"rect":{"x":0,"y":0,"width":960,"height":1080}},
        {"type":"con","pid":43,"app_id":"firefox","visible":false,"rect":{"x":0,"y":0,"width":960,"height":1080}},
        {"type":"con","layout":"splitv","nodes":[{"type":"con","pid":44,"window":7,"visible":true,"rect":{"x":960,"y":0,"width":960,"height":540}}]}
      ],"floating_nodes":[{"type":"floating_con","pid":45,"app_id":"pavucontrol","visible":true,"rect":{"x":100,"y":100,"width":400,"height":300}}]}]}]}"#;
    assert_eq!(screenshot::sway_boxes(tree), ["0,0 960x1080", "960,0 960x540", "100,100 400x300"]);
}

#[test]
fn names_captures_plainly() {
    assert_eq!(screenshot::capture_stem("screenshot-2026-11-02-153417"), "screenshot-2026-11-02-153417");
    assert_eq!(screenshot::capture_stem("screenshot.png"), "screenshot");
    for odd in ["", "../../etc/passwd", ".hidden", "a b", "name\n", &"x".repeat(101)] {
        assert_eq!(screenshot::capture_stem(odd), "screenshot", "{odd:?}");
    }
    assert_eq!(screenshot::image_ext(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
    assert_eq!(screenshot::image_ext(b"\xff\xd8\xff\xe0"), Some("jpg"));
    assert_eq!(screenshot::image_ext(b"GIF89a"), None);
}

/// A captures folder under a fresh private temp root, removed when the test ends.
struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn fresh_root(tag: &str) -> (Root, Captures) {
    let base = std::env::temp_dir().join(format!("hermes-chat-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let captures = Captures::open(base.join("captures")).unwrap();
    (Root(base), captures)
}
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot really an image";
#[cfg(unix)]
fn mode(p: &Path) -> u32 {
    std::fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn stages_captures_privately_and_deletes_the_portals_scratch_copy() {
    let (root, captures) = fresh_root("adopt");
    let source = root.0.join("portal-out.png");
    std::fs::write(&source, PNG).unwrap();

    let a = captures.adopt(&source, "screenshot-2026-11-02-153417", true).unwrap();
    assert_eq!(a.file_name().unwrap(), "screenshot-2026-11-02-153417.png");
    assert!(a.starts_with(captures.mine()), "{a:?}");
    assert_eq!(std::fs::read(&a).unwrap(), PNG);
    #[cfg(unix)]
    {
        assert_eq!(mode(&a), 0o600);
        assert_eq!(mode(a.parent().unwrap()), 0o700);
        assert_eq!(mode(captures.mine()), 0o700);
        assert_eq!(mode(&root.0), 0o700);
    }
    assert!(!source.exists(), "the scratch copy is deleted");

    // A copy the desktop saved elsewhere is kept, and the same name twice is two files.
    std::fs::write(&source, PNG).unwrap();
    let b = captures.adopt(&source, "screenshot-2026-11-02-153417", false).unwrap();
    assert!(source.exists());
    assert_ne!(a, b);
    assert_eq!(a.file_name(), b.file_name());

    // Not an image: refused, and nothing is left behind, not even the portal's scratch copy.
    std::fs::write(&source, b"<html>").unwrap();
    assert!(matches!(captures.adopt(&source, "x", true), Err(CaptureError::Failed(_))));
    assert!(!source.exists());
    assert_eq!(std::fs::read_dir(captures.mine()).unwrap().count(), 2);
    // The desktop's own copy is kept, even when refused.
    std::fs::write(&source, b"<html>").unwrap();
    assert!(captures.adopt(&source, "x", false).is_err());
    assert!(source.exists());
}

#[test]
fn writes_an_image_the_app_made_into_a_private_slot_of_its_own() {
    let (_root, captures) = fresh_root("write");
    let a = captures.write("annotation-1", PNG).unwrap();
    assert_eq!(a.file_name().unwrap(), "annotation-1.png");
    assert_eq!(std::fs::read(&a).unwrap(), PNG);
    #[cfg(unix)]
    {
        assert_eq!(mode(&a), 0o600);
        assert_eq!(mode(a.parent().unwrap()), 0o700);
    }
    assert!(captures.owns(&a));
    let b = captures.write("annotation-1", PNG).unwrap();
    assert_ne!(a.parent(), b.parent(), "each write has a fresh slot");
    assert_eq!(captures.write("../../evil", PNG).unwrap().file_name().unwrap(), "screenshot.png", "an odd name is replaced");

    assert!(matches!(captures.write("x", b"<html>"), Err(CaptureError::Failed(_))), "not an image");
    assert_eq!(std::fs::read_dir(captures.mine()).unwrap().count(), 3, "and nothing is left of it");

    assert!(captures.discard(&a));
    assert!(!a.exists() && !a.parent().unwrap().exists());
}

#[test]
fn discards_only_its_own_captures() {
    let (root, captures) = fresh_root("discard");
    let source = root.0.join("s.png");
    std::fs::write(&source, PNG).unwrap();
    let a = captures.adopt(&source, "shot", false).unwrap();
    let b = captures.adopt(&source, "shot", false).unwrap();

    // Nothing outside this process's folder can be deleted through discard.
    for other in [source.clone(), captures.mine().join("x.png"), a.parent().unwrap().join("../../../s.png"), PathBuf::from("relative/x/y.png")] {
        assert!(!captures.discard(&other), "{other:?}");
    }
    assert!(source.exists());

    assert!(captures.discard(&a));
    assert!(!a.exists() && !a.parent().unwrap().exists());
    assert!(b.exists());
    assert!(captures.discard(&a), "discarding twice is fine");

    captures.clear();
    assert!(!b.exists() && !captures.mine().exists());
}

#[test]
fn sweeps_captures_left_by_a_process_that_is_gone() {
    let (root, captures) = fresh_root("sweep");
    let source = root.0.join("s.png");
    std::fs::write(&source, PNG).unwrap();
    let kept = captures.adopt(&source, "mine", false).unwrap();
    let folder = |name: &str| {
        let f = root.0.join("captures").join(name);
        std::fs::create_dir_all(f.join("0")).unwrap();
        std::fs::write(f.join("0").join("old.png"), PNG).unwrap();
        f
    };
    let (gone, running, other) = (folder("4194999"), folder("4242"), folder("notes"));

    captures.sweep_except(|pid| pid == 4242);
    assert!(!gone.exists());
    // Another Hermes Chat still running keeps its captures; anything not named like a pid is left alone, and so are
    // this process's own.
    assert!(running.exists() && other.exists() && kept.exists());
}

#[cfg(unix)]
#[test]
fn counts_only_a_running_hermes_chat_as_alive() {
    // This test binary is running, under its own name.
    assert!(screenshot::instance_alive(std::process::id()));
    // pid 1 runs, but isn't this program: a reused pid doesn't keep a crashed run's captures.
    assert!(!screenshot::instance_alive(1));
    // pid_max is at most 2^22 on Linux, so no process has this one.
    assert!(!screenshot::instance_alive(4_194_999));
    // A child that has exited but isn't reaped yet is a zombie: gone.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap()).arg("--list").stdout(std::process::Stdio::null()).spawn().unwrap();
    let pid = child.id();
    for _ in 0..200 {
        let state = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        if state.rsplit_once(") ").unwrap().1.starts_with('Z') {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!screenshot::instance_alive(pid));
    child.wait().unwrap();
}

#[cfg(unix)]
#[test]
fn refuses_a_captures_folder_someone_else_could_open() {
    let base = std::env::temp_dir().join(format!("hermes-chat-test-open-{}", std::process::id()));
    let _root = Root(base.clone());
    std::fs::create_dir_all(base.join("captures")).unwrap();
    std::fs::set_permissions(base.join("captures"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(Captures::open(base.join("captures")), Err(CaptureError::Failed(m)) if m.contains("private")));

    // A link in place of the folder is refused too, even to a private folder.
    let real = base.join("real");
    std::fs::create_dir(&real).unwrap();
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::os::unix::fs::symlink(&real, base.join("linked")).unwrap();
    assert!(Captures::open(base.join("linked")).is_err());
}

#[test]
fn knows_a_scratch_file_from_the_desktops_own_copy() {
    let (root, _captures) = fresh_root("scratch");
    let tmp = root.0.join("s.png");
    std::fs::write(&tmp, PNG).unwrap();
    assert!(screenshot::is_scratch(&tmp));
    // Not in a temporary folder: the desktop's (say, ~/Pictures). A folder or a missing file isn't one either.
    assert!(!screenshot::is_scratch(Path::new("/etc/hostname")));
    assert!(!screenshot::is_scratch(&root.0));
    assert!(!screenshot::is_scratch(&root.0.join("missing.png")));
}

#[cfg(windows)]
#[test]
fn counts_only_a_running_hermes_chat_as_alive_on_windows() {
    assert!(screenshot::instance_alive(std::process::id()));
    // The System process runs, but isn't this program.
    assert!(!screenshot::instance_alive(4));
    let mut child = std::process::Command::new(std::env::current_exe().unwrap()).arg("--list").stdout(std::process::Stdio::null()).spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    assert!(!screenshot::instance_alive(pid));
}

#[test]
fn reads_the_command_line_flag() {
    let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(hermes_chat::remote::asked(args(&["hermes-chat", "--screenshot"])));
    assert!(!hermes_chat::remote::asked(args(&["hermes-chat"])));
    // The program's own name doesn't count.
    assert!(!hermes_chat::remote::asked(args(&["--screenshot"])));
}

#[test]
fn outbox_captures_survive_exit_and_startup_until_the_message_leaves_the_outbox() {
    let (root, captures) = fresh_root("outbox");
    let source = root.0.join("source.png");
    std::fs::write(&source, PNG).unwrap();
    let mine = captures.adopt(&source, "pending", false).unwrap();
    let dead_slot = root.0.join("captures/4194999/0");
    std::fs::create_dir_all(&dead_slot).unwrap();
    let old = dead_slot.join("unknown.png");
    std::fs::write(&old, PNG).unwrap();
    let unrelated = root.0.join("unrelated.png");
    std::fs::write(&unrelated, PNG).unwrap();

    captures.retain_outbox([mine.clone(), old.clone(), unrelated.clone()]);
    captures.clear();
    assert!(mine.exists() && old.exists());
    assert!(!captures.discard(&mine));
    drop(captures);

    let restarted = Captures::open(root.0.join("captures")).unwrap();
    restarted.retain_outbox([mine.clone(), old.clone()]);
    assert!(mine.exists() && old.exists());
    // Confirmation, history reconciliation or dismissal removes the outbox reference.
    restarted.retain_outbox([]);
    assert!(!mine.exists() && !old.exists());
    assert!(unrelated.exists());
}

#[test]
fn a_reused_process_slot_never_overwrites_an_outbox_capture() {
    let (root, captures) = fresh_root("slot-reuse");
    let old = captures.mine().join("0");
    std::fs::create_dir_all(&old).unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(captures.mine(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let old_file = old.join("old.png");
    std::fs::write(&old_file, PNG).unwrap();
    let new = captures.slot("new.png").unwrap();
    assert_ne!(new.parent(), Some(old.as_path()));
    assert!(old_file.exists());
    assert!(new.starts_with(root.0.join("captures")));
}

#[test]
fn shutdown_before_retention_ipc_preserves_bytes_for_startup_reconciliation() {
    let (root, captures) = fresh_root("shutdown-race");
    let source = root.0.join("source.png");
    std::fs::write(&source, PNG).unwrap();
    let pending = captures.adopt(&source, "pending", false).unwrap();
    // The renderer persisted this path but the retention IPC never ran. Native shutdown drops the store without
    // clearing it. Use a dead pid to model the next launch's view of the previous process.
    let dead = root.0.join("captures/4194999");
    std::fs::rename(captures.mine(), &dead).unwrap();
    let pending = dead.join(pending.strip_prefix(captures.mine()).unwrap());
    drop(captures);
    assert!(pending.exists());
    let restarted = Captures::open(root.0.join("captures")).unwrap();
    restarted.retain_outbox([pending.clone()]);
    assert!(pending.exists());
    restarted.retain_outbox([]);
    assert!(!pending.exists());
}

#[cfg(unix)]
#[test]
fn cleanup_never_follows_linked_instances_or_retargeted_outbox_ancestors() {
    use std::os::unix::fs::symlink;
    let (root, captures) = fresh_root("cleanup-links");
    let outside = root.0.join("outside");
    std::fs::create_dir_all(outside.join("0")).unwrap();
    let kept = outside.join("0/kept.png");
    std::fs::write(&kept, PNG).unwrap();
    let dead = root.0.join("captures/4194999");
    symlink(&outside, &dead).unwrap();
    captures.sweep_except(|_| false);
    captures.retain_outbox([dead.join("0/kept.png")]);
    captures.retain_outbox([]);
    assert!(kept.exists());
    std::fs::remove_file(&dead).unwrap();

    // A previously valid retained instance is replaced by a symlink before its reference disappears.
    std::fs::create_dir_all(dead.join("0")).unwrap();
    let old = dead.join("0/kept.png");
    std::fs::write(&old, PNG).unwrap();
    captures.retain_outbox([old]);
    std::fs::remove_dir_all(&dead).unwrap();
    symlink(&outside, &dead).unwrap();
    captures.retain_outbox([]);
    assert!(kept.exists());

    // Discard also refuses a linked slot, even in this process's own instance.
    let slot = captures.slot("kept.png").unwrap();
    std::fs::remove_dir(slot.parent().unwrap()).unwrap();
    symlink(outside.join("0"), slot.parent().unwrap()).unwrap();
    captures.discard(&slot);
    assert!(kept.exists());
}
