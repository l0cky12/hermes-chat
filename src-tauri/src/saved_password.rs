//! The dashboard password, kept in the system keyring (the Secret Service: GNOME Keyring or KWallet) so the
//! app can sign in at launch without asking. The app keeps one sign-in, so there is one entry. The keyring
//! talks D-Bus and blocks, so each call runs off the async runtime.

use keyring::{Entry, Error};

const SERVICE: &str = "hermes-chat";
const ACCOUNT: &str = "dashboard-password";

fn entry() -> Result<Entry, Error> {
    Entry::new(SERVICE, ACCOUNT)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("The system keyring failed: {e}"))
}

/// The saved password, or none if nothing is saved.
pub async fn load() -> Result<Option<String>, String> {
    blocking(|| match entry()?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    })
    .await
}

pub async fn save(password: String) -> Result<(), String> {
    blocking(move || entry()?.set_password(&password)).await
}

/// Deletes the saved password. Nothing saved counts as done.
pub async fn delete() -> Result<(), String> {
    blocking(|| match entry()?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    })
    .await
}
