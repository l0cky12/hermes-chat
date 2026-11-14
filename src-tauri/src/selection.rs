//! The text selected or copied in another app, which a message can start with when `hermes-chat --show` or
//! `--toggle` brings the window forward (ADR 0172). Read only when the webview asks, with the owner's setting on; the
//! text goes to the webview's composer and nowhere else.

use serde::Serialize;
use std::time::Duration;
use tokio::sync::oneshot;

/// How long each selection's owner has to hand over its text. Past it, the selection counts as unreadable.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(1);
/// Longer text counts as unreadable, so a message never starts with a whole copied file.
const MAX_CHARS: usize = 100_000;
/// The target KeePassXC, KDE's Klipper and other password managers add to a secret they copy.
pub const PASSWORD_HINT: &str = "x-kde-passwordManagerHint";

/// The PRIMARY selection (what is selected now) and the clipboard (what was copied). `None`: empty, unreadable, longer
/// than `MAX_CHARS`, or marked as a password.
#[derive(Serialize, Default, Debug, PartialEq, Eq)]
pub struct Selections {
    pub primary: Option<String>,
    pub clipboard: Option<String>,
}

/// `text` as a selection a message can start with.
fn usable(text: Option<&str>) -> Option<String> {
    text.filter(|t| !t.trim().is_empty() && t.chars().count() <= MAX_CHARS).map(str::to_owned)
}

/// Both selections. GTK's clipboards belong to the main thread.
pub async fn read(app: &tauri::AppHandle) -> Result<Selections, String> {
    let (primary_tx, primary) = oneshot::channel();
    let (clipboard_tx, clipboard) = oneshot::channel();
    app.run_on_main_thread(move || {
        text_of(&gtk::Clipboard::get(&gtk::gdk::SELECTION_PRIMARY), move |t| drop(primary_tx.send(t)));
        text_of(&gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD), move |t| drop(clipboard_tx.send(t)));
    })
    .map_err(|e| e.to_string())?;
    let answer = |rx: oneshot::Receiver<Option<String>>| async move { tokio::time::timeout(ANSWER_TIMEOUT, rx).await.ok()?.ok()? };
    let (primary, clipboard) = tokio::join!(answer(primary), answer(clipboard));
    Ok(Selections { primary, clipboard })
}

/// Calls `done` with `clipboard`'s text as a message can start with it: none when its owner marks it as a password.
pub fn text_of(clipboard: &gtk::Clipboard, done: impl FnOnce(Option<String>) + 'static) {
    clipboard.request_contents(&gtk::gdk::Atom::intern("TARGETS"), move |c, targets| {
        if targets.targets().unwrap_or_default().into_iter().any(|t| t.name() == PASSWORD_HINT) {
            return done(None);
        }
        c.request_text(move |_, text| done(usable(text)));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_and_overlong_text_is_no_selection() {
        assert_eq!(usable(None), None);
        assert_eq!(usable(Some(" \n\t")), None);
        assert_eq!(usable(Some("  df -h\n")), Some("  df -h\n".to_owned()), "kept as selected, spaces and all");
        assert_eq!(usable(Some(&"é".repeat(MAX_CHARS))).map(|t| t.chars().count()), Some(MAX_CHARS), "counted in characters, not bytes");
        assert_eq!(usable(Some(&"x".repeat(MAX_CHARS + 1))), None);
    }
}
