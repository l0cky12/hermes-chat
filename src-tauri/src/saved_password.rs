//! The dashboard passwords, kept in the system keyring (the Secret Service: GNOME Keyring or KWallet; on Windows the
//! Credential Manager) so the app can sign in at launch without asking, and beside them the extra request headers,
//! whose values may be secrets such as a Cloudflare Access client secret. Each saved connection has one entry of each,
//! named by its stable id (`dashboard-password/<id>`). The connection migrated from the single sign-in kept before
//! keeps the entries it already had (`dashboard-password`, `extra-request-headers`). The keyring blocks (D-Bus, or a
//! Windows API call), so each call runs off the async runtime.
//!
//! A dashboard session token (ADR 0058) has its own entry, `dashboard-token/<id>`, which only Rust reads: its value
//! names the addresses it was entered for (`TokenEntry`), and it is sent only to one of those.

use keyring::{Entry, Error};
use serde::{Deserialize, Serialize};

const SERVICE: &str = "hermes-chat";
pub const PASSWORD: &str = "dashboard-password";
pub const HEADERS: &str = "extra-request-headers";
pub const TOKEN: &str = "dashboard-token";

/// Where a secret may be sent: a connection's mode (`ssh` or `url`) and its SSH target or URL as typed, trimmed. The
/// same as the webview's `routeKey`.
pub type Address = [String; 2];

/// The token entry's value: the token, and every address it was entered for.
#[derive(Serialize, Deserialize)]
pub struct TokenEntry {
    pub v: u8,
    #[serde(rename = "for")]
    pub addresses: Vec<Address>,
    pub token: String,
}

impl TokenEntry {
    pub fn new(addresses: Vec<Address>, token: String) -> Self {
        TokenEntry { v: 1, addresses, token }
    }

    /// The saved entry, if it is one this version reads.
    pub fn read(raw: &str) -> Option<Self> {
        serde_json::from_str::<TokenEntry>(raw).ok().filter(|e| e.v == 1 && !e.token.is_empty())
    }

    /// The token, only for an address it was entered for.
    pub fn token_for(&self, address: &Address) -> Option<&str> {
        self.addresses.contains(address).then_some(self.token.as_str())
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("strings serialize")
    }
}

/// Whether `id` is a saved connection's id, a UUID as the webview makes it: lowercase letters, digits and dashes, 8 to
/// 64 of them.
pub fn is_connection_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub const NOT_A_CONNECTION: &str = "That isn't a saved connection's id.";

/// The keyring account for `base` (`PASSWORD`, `HEADERS` or `TOKEN`) of one connection. `None`: the migrated connection's own
/// entry. Only a connection's id (`is_connection_id`) is taken, so it can't name another entry.
pub fn account(base: &str, connection: Option<&str>) -> Result<String, String> {
    match connection {
        None => Ok(base.to_string()),
        Some(id) if is_connection_id(id) => Ok(format!("{base}/{id}")),
        Some(_) => Err(NOT_A_CONNECTION.to_string()),
    }
}

fn entry(account: &str) -> Result<Entry, Error> {
    Entry::new(SERVICE, account)
}

/// The Secret Service holds a secret of any length in one item.
#[cfg(not(windows))]
mod store {
    use super::{entry, Error};

    pub fn load(account: &str) -> Result<String, Error> {
        entry(account)?.get_password()
    }
    pub fn save(account: &str, secret: &str) -> Result<(), Error> {
        entry(account)?.set_password(secret)
    }
    pub fn delete(account: &str) -> Result<(), Error> {
        entry(account)?.delete_credential()
    }
}

/// A Windows credential holds at most 2560 bytes, fewer than a set of extra headers can need, so a secret is split
/// across credentials (`split`).
#[cfg(windows)]
mod store {
    use super::{entry, split, Error};

    struct Credentials;

    impl split::Vault for Credentials {
        fn get(&self, account: &str) -> Result<Vec<u8>, Error> {
            entry(account)?.get_secret()
        }
        fn set(&self, account: &str, blob: &[u8]) -> Result<(), Error> {
            entry(account)?.set_secret(blob)
        }
        fn delete(&self, account: &str) -> Result<(), Error> {
            entry(account)?.delete_credential()
        }
    }

    pub fn load(account: &str) -> Result<String, Error> {
        split::load(&Credentials, account)
    }
    pub fn save(account: &str, secret: &str) -> Result<(), Error> {
        split::save(&Credentials, account, secret)
    }
    pub fn delete(account: &str) -> Result<(), Error> {
        split::delete(&Credentials, account)
    }
}

/// A secret kept in parts no bigger than a store's item limit. The first part, under the account itself, starts with
/// how many parts there are (`3\n`); the rest are `<account>#2`, `#3` and on. An account never holds `#`, so a part
/// can't be another entry. The first part is written after the others, so it never counts parts that aren't there.
#[cfg_attr(not(windows), allow(dead_code))]
mod split {
    use keyring::Error;

    pub const BLOB: usize = 2560;
    const MAX_PARTS: usize = 64;
    /// Room in the first part for its count.
    const HEADER: usize = 8;

    pub trait Vault {
        fn get(&self, account: &str) -> Result<Vec<u8>, Error>;
        fn set(&self, account: &str, blob: &[u8]) -> Result<(), Error>;
        fn delete(&self, account: &str) -> Result<(), Error>;
    }

    fn part(account: &str, n: usize) -> String {
        format!("{account}#{n}")
    }

    /// The blobs `secret` is kept as, first part first.
    pub fn parts(secret: &[u8]) -> Result<Vec<Vec<u8>>, Error> {
        let (head, rest) = secret.split_at(secret.len().min(BLOB - HEADER));
        let count = 1 + rest.len().div_ceil(BLOB);
        if count > MAX_PARTS {
            return Err(Error::TooLong("secret".into(), ((BLOB - HEADER) + (MAX_PARTS - 1) * BLOB) as u32));
        }
        let mut first = format!("{count}\n").into_bytes();
        first.extend_from_slice(head);
        Ok(std::iter::once(first).chain(rest.chunks(BLOB).map(<[u8]>::to_vec)).collect())
    }

    /// How many parts the first one says there are, and its own share of the secret.
    pub fn header(first: &[u8]) -> Result<(usize, &[u8]), Error> {
        let damaged = || Error::Invalid("secret".into(), "its saved parts are damaged".into());
        let end = first.iter().take(HEADER).position(|b| *b == b'\n').ok_or_else(damaged)?;
        let count: usize = std::str::from_utf8(&first[..end]).ok().and_then(|s| s.parse().ok()).ok_or_else(damaged)?;
        if !(1..=MAX_PARTS).contains(&count) {
            return Err(damaged());
        }
        Ok((count, &first[end + 1..]))
    }

    fn count_of(vault: &impl Vault, account: &str) -> Result<usize, Error> {
        match vault.get(account) {
            Ok(first) => Ok(header(&first).map_or(1, |(n, _)| n)),
            Err(Error::NoEntry) => Ok(0),
            Err(e) => Err(e),
        }
    }

    pub fn load(vault: &impl Vault, account: &str) -> Result<String, Error> {
        let first = vault.get(account)?;
        let (count, head) = header(&first)?;
        let mut secret = head.to_vec();
        for n in 2..=count {
            secret.extend(vault.get(&part(account, n)).map_err(|e| match e {
                Error::NoEntry => Error::Invalid("secret".into(), format!("part {n} of {count} is missing")),
                e => e,
            })?);
        }
        String::from_utf8(secret).map_err(|e| Error::BadEncoding(e.into_bytes()))
    }

    pub fn save(vault: &impl Vault, account: &str, secret: &str) -> Result<(), Error> {
        let before = count_of(vault, account)?;
        let parts = parts(secret.as_bytes())?;
        for (i, blob) in parts.iter().enumerate().skip(1) {
            vault.set(&part(account, i + 1), blob)?;
        }
        vault.set(account, &parts[0])?;
        for n in parts.len() + 1..=before {
            let _ = vault.delete(&part(account, n));
        }
        Ok(())
    }

    pub fn delete(vault: &impl Vault, account: &str) -> Result<(), Error> {
        let count = count_of(vault, account)?;
        vault.delete(account)?;
        for n in 2..=count {
            match vault.delete(&part(account, n)) {
                Ok(()) | Err(Error::NoEntry) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?.map_err(|e| format!("The system keyring failed: {e}"))
}

/// The saved secret, or none if nothing is saved.
pub async fn load(account: String) -> Result<Option<String>, String> {
    blocking(move || match store::load(&account) {
        Ok(p) => Ok(Some(p)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    })
    .await
}

pub async fn save(account: String, secret: String) -> Result<(), String> {
    blocking(move || store::save(&account, &secret)).await
}

/// Deletes the saved secret. Nothing saved counts as done.
pub async fn delete(account: String) -> Result<(), String> {
    blocking(move || match store::delete(&account) {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    #[test]
    fn the_migrated_connection_keeps_its_old_entries() {
        assert_eq!(account(PASSWORD, None).unwrap(), "dashboard-password");
        assert_eq!(account(HEADERS, None).unwrap(), "extra-request-headers");
    }

    #[test]
    fn each_connection_has_its_own_entries() {
        let id = "3f2c1a9e-7b4d-4c1e-9a2f-0d6b8e5c4a31";
        assert_eq!(account(PASSWORD, Some(id)).unwrap(), format!("dashboard-password/{id}"));
        assert_eq!(account(HEADERS, Some(id)).unwrap(), format!("extra-request-headers/{id}"));
    }

    #[test]
    fn a_token_goes_only_to_an_address_it_was_entered_for() {
        let lan: Address = ["url".into(), "http://hermes:9119".into()];
        let ssh: Address = ["ssh".into(), "liam@hermes".into()];
        let saved = TokenEntry::read(&TokenEntry::new(vec![lan.clone(), ssh.clone()], "t0k3n".into()).to_json()).unwrap();
        assert_eq!(saved.token_for(&lan), Some("t0k3n"));
        assert_eq!(saved.token_for(&ssh), Some("t0k3n"));
        assert_eq!(saved.token_for(&["url".into(), "http://evil:9119".into()]), None);
        assert_eq!(saved.token_for(&["ssh".into(), "http://hermes:9119".into()]), None);
        for bad in ["", "t0k3n", r#"{"v":2,"for":[],"token":"x"}"#, r#"{"v":1,"for":[["url","x"]],"token":""}"#] {
            assert!(TokenEntry::read(bad).is_none(), "{bad:?}");
        }
        assert_eq!(account(TOKEN, Some("3f2c1a9e-7b4d")).unwrap(), "dashboard-token/3f2c1a9e-7b4d");
    }

    #[test]
    fn an_id_cant_name_another_entry() {
        for bad in ["", "short", "../dashboard-password", "ABCDEF12-0000", "a b c d e f g h", "x/../../y-123456", "abcdefgh#2", &"a".repeat(65)] {
            assert!(account(PASSWORD, Some(bad)).is_err(), "{bad:?}");
        }
    }

    /// A keyring in memory, holding at most `split::BLOB` bytes an item as Windows does.
    #[derive(Default)]
    struct Memory(RefCell<BTreeMap<String, Vec<u8>>>);

    impl split::Vault for Memory {
        fn get(&self, account: &str) -> Result<Vec<u8>, Error> {
            self.0.borrow().get(account).cloned().ok_or(Error::NoEntry)
        }
        fn set(&self, account: &str, blob: &[u8]) -> Result<(), Error> {
            if blob.len() > split::BLOB {
                return Err(Error::TooLong("secret".into(), split::BLOB as u32));
            }
            self.0.borrow_mut().insert(account.into(), blob.to_vec());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), Error> {
            self.0.borrow_mut().remove(account).map(|_| ()).ok_or(Error::NoEntry)
        }
    }

    #[test]
    fn a_secret_too_big_for_one_item_is_kept_in_parts() {
        let m = Memory::default();
        let big: String = "é-header-value ".repeat(1000);
        split::save(&m, "extra-request-headers", &big).unwrap();
        assert!(m.0.borrow().len() > 1);
        assert_eq!(split::load(&m, "extra-request-headers").unwrap(), big);

        split::save(&m, "extra-request-headers", "short").unwrap();
        assert_eq!(m.0.borrow().keys().collect::<Vec<_>>(), ["extra-request-headers"]);
        assert_eq!(split::load(&m, "extra-request-headers").unwrap(), "short");

        split::save(&m, "extra-request-headers", &big).unwrap();
        split::delete(&m, "extra-request-headers").unwrap();
        assert!(m.0.borrow().is_empty());
        assert!(matches!(split::load(&m, "extra-request-headers"), Err(Error::NoEntry)));
        assert!(matches!(split::delete(&m, "extra-request-headers"), Err(Error::NoEntry)));
    }

    #[test]
    fn every_size_round_trips_across_part_edges() {
        for len in [0, 1, split::BLOB - 8, split::BLOB - 7, split::BLOB, 2 * split::BLOB - 8, 2 * split::BLOB - 7, 10_000] {
            let m = Memory::default();
            let s = "x".repeat(len);
            split::save(&m, "a", &s).unwrap();
            assert_eq!(split::load(&m, "a").unwrap(), s, "{len}");
            assert_eq!(split::header(&m.0.borrow()["a"]).unwrap().0, m.0.borrow().len(), "{len}");
        }
    }

    #[test]
    fn a_damaged_or_incomplete_secret_is_an_error_not_a_wrong_secret() {
        let m = Memory::default();
        m.0.borrow_mut().insert("a".into(), b"no count here".to_vec());
        assert!(matches!(split::load(&m, "a"), Err(Error::Invalid(..))));
        split::save(&m, "a", &"y".repeat(3 * split::BLOB)).unwrap();
        m.0.borrow_mut().remove("a#3");
        assert!(matches!(split::load(&m, "a"), Err(Error::Invalid(..))));
        assert!(matches!(split::parts(&vec![b'z'; 64 * split::BLOB]), Err(Error::TooLong(..))));
    }
}
