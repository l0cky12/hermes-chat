//! The files copied in a file manager, read from the GTK clipboard (#442, ADR 0143). WebKitGTK tells a paste event the
//! clipboard has a `text/uri-list` but hides the URIs, and `navigator.clipboard.read()` gives only the first one.

/// The local paths among `uris`, in order. A URI that isn't a `file://` one on this computer is left out.
pub fn local_paths<'a>(uris: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    uris.into_iter().filter_map(|uri| url::Url::parse(uri.trim()).ok()?.to_file_path().ok()).map(|path| path.to_string_lossy().into_owned()).collect()
}

use std::time::Duration;
use tokio::sync::oneshot;

/// How long the clipboard's owner has to hand over its URIs before the paste says it couldn't attach them.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

/// The local files on the clipboard. Empty when it holds no `file://` URIs or has no owner.
pub async fn read(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = oneshot::channel();
    // GTK's clipboard belongs to the main thread.
    app.run_on_main_thread(move || {
        gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).request_uris(move |_, uris| {
            let _ = tx.send(local_paths(uris.iter().map(|u| u.as_str())));
        });
    })
    .map_err(|e| e.to_string())?;
    answer(rx, ANSWER_TIMEOUT).await
}

/// The paths the clipboard read sends, or why there are none once it hasn't sent them within `timeout`, so a paste
/// never waits on an owner that doesn't answer. An answer after that finds no one waiting: nothing in it is attached.
async fn answer(rx: oneshot::Receiver<Vec<String>>, timeout: Duration) -> Result<Vec<String>, String> {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(paths)) => Ok(paths),
        Ok(Err(_)) => Err("The clipboard went away before it gave the copied files.".into()),
        Err(_) => Err(format!("The clipboard didn't give the copied files within {} seconds.", timeout.as_secs())),
    }
}

#[cfg(test)]
mod tests {
    use super::{answer, local_paths};
    use std::time::Duration;
    use tokio::sync::oneshot;

    #[test]
    fn keeps_only_local_files_in_order_and_decodes_them() {
        let uris = [
            "file:///home/owner/disk%20report.txt",
            "https://example.com/a.png",
            "file:///home/owner/notes.md\r\n",
            "sftp://nas/home/owner/backup.tar",
            "file://other-host/share/x.txt",
            "file:///home/owner/caf%C3%A9.png",
            "not a uri",
        ];
        assert_eq!(local_paths(uris), ["/home/owner/disk report.txt", "/home/owner/notes.md", "/home/owner/café.png"]);
    }

    #[tokio::test]
    async fn gives_up_on_an_answer_that_doesnt_come_and_drops_a_late_one() {
        let (tx, rx) = oneshot::channel::<Vec<String>>();
        let waited = answer(rx, Duration::from_millis(50)).await;
        assert!(waited.is_err_and(|why| why.starts_with("The clipboard didn't give the copied files within")));
        assert!(tx.send(vec!["/home/owner/late.txt".into()]).is_err(), "a late answer has no one to give its files to");

        let (tx, rx) = oneshot::channel::<Vec<String>>();
        drop(tx);
        assert!(answer(rx, Duration::from_secs(5)).await.is_err());

        let (tx, rx) = oneshot::channel();
        tx.send(vec!["/home/owner/notes.md".to_owned()]).unwrap();
        assert_eq!(answer(rx, Duration::from_secs(5)).await, Ok(vec!["/home/owner/notes.md".to_owned()]));
    }

    #[test]
    fn nothing_on_the_clipboard_is_no_files() {
        assert!(local_paths([]).is_empty());
    }
}
