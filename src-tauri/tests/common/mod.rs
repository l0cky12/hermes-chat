//! Helpers shared by the integration tests and, through `#[path]` in `lib.rs`, the unit tests.
#![cfg(unix)]

use std::path::Path;

/// Writes `text` to `path` as an executable that can be run straight away (issue #331).
///
/// A file this process writes may not be: another test thread can fork while the write handle is open, the child keeps
/// that handle until it execs, and running the file meanwhile fails with "Text file busy". Close-on-exec and renaming
/// don't help. A child shell writes the file instead, so this process never holds a handle to it.
pub fn write_executable(path: &Path, text: &str) {
    let status = std::process::Command::new("sh").args(["-c", r#"printf %s "$1" > "$2" && chmod 755 "$2""#, "sh", text]).arg(path).status().unwrap();
    assert!(status.success(), "couldn't write {}", path.display());
}
