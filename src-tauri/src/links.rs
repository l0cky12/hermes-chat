//! Chat links (ADR 0037): `hermes-chat://chat?v=1&connection=…&profile=…&id=…`. The desktop starts Hermes Chat with
//! the link as its argument (`%u` in the .desktop file). A Hermes Chat already running is handed the link over the
//! session bus (remote.rs, `OpenLink`) and this process exits; otherwise this one keeps it until the window takes it.
//!
//! Rust only picks out what could be a link: the right scheme and not too long. The window reads it fully
//! (src/hermes/chatLinks.ts) and refuses anything else. A link only ever shows a chat.

use crate::lock::Locked;
use std::sync::Mutex;

/// Tells the window a link is waiting (`chat_link_take`).
pub const EVENT: &str = "chat-link";
const SCHEME: &str = "hermes-chat:";
/// The longest link passed on, in bytes; the window allows the same in characters.
pub const MAX_LEN: usize = 1024;

/// Could be a chat link: starts with the scheme, in any case, and is no longer than `MAX_LEN`.
pub fn candidate(arg: &str) -> bool {
    arg.len() <= MAX_LEN && arg.get(..SCHEME.len()).is_some_and(|p| p.eq_ignore_ascii_case(SCHEME))
}

/// The link on the command line, if any: the last argument that could be one.
pub fn from_args(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter().skip(1).filter(|a| candidate(a)).last()
}

/// The link waiting for the window. Only the latest is kept: opening a link replaces one not yet opened.
#[derive(Default)]
pub struct Links {
    pending: Mutex<Option<String>>,
}

impl Links {
    pub fn new(first: Option<String>) -> Self {
        Self { pending: Mutex::new(first.filter(|l| candidate(l))) }
    }

    /// Keeps `link` for the window; false, and nothing kept, when it can't be a link.
    pub fn put(&self, link: String) -> bool {
        if !candidate(&link) {
            return false;
        }
        *self.pending.locked() = Some(link);
        true
    }

    /// The link waiting, which the window now has; it isn't handed out twice.
    pub fn take(&self) -> Option<String> {
        self.pending.locked().take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK: &str = "hermes-chat://chat?v=1&connection=abcdefghijklmnopqrst&profile=default&id=20261103_101500_ab12cd";

    #[test]
    fn only_the_scheme_and_a_sane_length_count_as_a_link() {
        assert!(candidate(LINK));
        assert!(candidate("HERMES-CHAT://chat"));
        assert!(!candidate("https://example.com"));
        assert!(!candidate("--screenshot"));
        assert!(!candidate("hermes-cha"));
        assert!(!candidate(&format!("hermes-chat://chat?{}", "a".repeat(MAX_LEN))));
        // A multi-byte character at the cut doesn't panic.
        assert!(!candidate("hermes-cha\u{e9}t://"));
    }

    #[test]
    fn the_last_link_on_the_command_line_is_taken() {
        let args = ["hermes-chat", "--screenshot", "hermes-chat://chat?a", "other", "hermes-chat://chat?b"].map(String::from);
        assert_eq!(from_args(args).as_deref(), Some("hermes-chat://chat?b"));
        assert_eq!(from_args(["hermes-chat", "hermes-chat://x"].map(String::from)).as_deref(), Some("hermes-chat://x"));
        // The program's own name is never a link.
        assert_eq!(from_args(["hermes-chat://x"].map(String::from)), None);
    }

    #[test]
    fn a_link_is_handed_out_once_and_a_newer_one_replaces_it() {
        let links = Links::new(Some(LINK.into()));
        assert!(links.put("hermes-chat://chat?newer".into()));
        assert!(!links.put("https://example.com".into()));
        assert_eq!(links.take().as_deref(), Some("hermes-chat://chat?newer"));
        assert_eq!(links.take(), None);
        assert_eq!(Links::new(Some("nope".into())).take(), None);
    }
}
