//! The connections Rust holds open, each under the saved connection it belongs to (ADR 0125, step 1). A command
//! reaches its connection by the attempt that opened it (ADR 0142), so one replaced or closed since is refused.

use crate::saved_password::{self, Address};
use crate::transport::{Dashboard, Pipe, TransportError};
use crate::tunnel::Tunnel;
use std::collections::HashMap;
use std::sync::Arc;

/// A saved connection's id (ADR 0112), checked as `saved_password::account` checks it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ConnectionId(String);

impl ConnectionId {
    pub fn parse(id: &str) -> Result<Self, String> {
        if saved_password::is_connection_id(id) {
            Ok(Self(id.to_owned()))
        } else {
            Err(saved_password::NOT_A_CONNECTION.to_owned())
        }
    }
}

/// The webview's name for one opening of a connection (`hermes_connect`'s `attempt`, ADR 0142).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Attempt(String);

impl Attempt {
    pub(crate) fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }
}

/// What one open connection holds. Dropping it closes its socket and its tunnel.
pub(crate) struct Live {
    pub(crate) dashboard: Arc<Dashboard>,
    pub(crate) pipe: Arc<Pipe>,
    pub(crate) _tunnel: Option<Tunnel>,
    /// The SSH target the sign-in went through, if it did: where the Preview's server pages go (server_page.rs).
    pub(crate) ssh_target: Option<String>,
    /// A token typed for this sign-in, and the address it signed in at, until `token_keep` saves it (ADR 0058).
    pub(crate) typed_token: Option<(String, Address)>,
}

/// One opening of a connection. `live` is locked for as long as its socket is being reopened, so commands for it wait.
pub(crate) struct Slot<L = Live> {
    attempt: Attempt,
    pub(crate) live: tokio::sync::Mutex<L>,
}

impl<L> Slot<L> {
    pub(crate) fn new(attempt: Attempt, live: L) -> Arc<Self> {
        Arc::new(Self { attempt, live: tokio::sync::Mutex::new(live) })
    }
}

/// The open connections by saved connection, at most `limit` of them. The map is locked only to look one up, add one
/// or take one out, never while anything waits, so a slow connect holds up no other connection's commands.
pub(crate) struct Slots<L = Live> {
    map: std::sync::Mutex<HashMap<ConnectionId, Arc<Slot<L>>>>,
    limit: usize,
}

impl<L> Default for Slots<L> {
    fn default() -> Self {
        Self { map: Default::default(), limit: 1 }
    }
}

impl<L> Slots<L> {
    #[cfg(test)]
    pub(crate) fn with_limit(limit: usize) -> Self {
        Self { map: Default::default(), limit }
    }

    /// The slot opened as `attempt`. An attempt with no name opens a connection no command can reach.
    pub(crate) fn find(&self, attempt: &Attempt) -> Result<(ConnectionId, Arc<Slot<L>>), TransportError> {
        let map = self.map.lock().unwrap();
        let found = map.iter().find(|(_, s)| !attempt.0.is_empty() && s.attempt == *attempt);
        found.map(|(id, s)| (id.clone(), s.clone())).ok_or(TransportError::Closed)
    }

    /// Whether `slot` is still the one held for `id`: false once it was replaced or closed.
    pub(crate) fn is_current(&self, id: &ConnectionId, slot: &Arc<Slot<L>>) -> bool {
        self.map.lock().unwrap().get(id).is_some_and(|s| Arc::ptr_eq(s, slot))
    }

    /// Takes out the connections that give way to a new one for `id`, and names them: every one at a limit of 1, as
    /// one connection replaces another; above it only `id`'s own, since which other gives way is not decided yet.
    pub(crate) fn evict_for(&self, id: &ConnectionId) -> Vec<ConnectionId> {
        let mut map = self.map.lock().unwrap();
        if self.limit <= 1 {
            map.drain().map(|(id, _)| id).collect()
        } else {
            map.remove(id).map(|_| id.clone()).into_iter().collect()
        }
    }

    pub(crate) fn insert(&self, id: ConnectionId, slot: Arc<Slot<L>>) {
        self.map.lock().unwrap().insert(id, slot);
    }

    /// Takes `slot` out if it is still the one held for `id`, and says whether it was.
    pub(crate) fn remove_if(&self, id: &ConnectionId, slot: &Arc<Slot<L>>) -> bool {
        let mut map = self.map.lock().unwrap();
        let current = map.get(id).is_some_and(|s| Arc::ptr_eq(s, slot));
        if current {
            map.remove(id);
        }
        current
    }

    /// Takes out the slot opened as `attempt`, and names its connection. None: no such connection is held.
    pub(crate) fn remove_attempt(&self, attempt: &Attempt) -> Option<ConnectionId> {
        let (id, slot) = self.find(attempt).ok()?;
        self.remove_if(&id, &slot).then_some(id)
    }

    /// Reads from the connection opened as `attempt`, once any reopen of its socket has ended and only while it is
    /// still the one held, so a command for a connection replaced or closed meanwhile is refused as `Closed`, however
    /// long it waited (#474).
    pub(crate) async fn read<T>(&self, attempt: &Attempt, read: impl FnOnce(&ConnectionId, &L) -> T) -> Result<T, TransportError> {
        let (id, slot) = self.find(attempt)?;
        let live = slot.live.lock().await;
        if !self.is_current(&id, &slot) {
            return Err(TransportError::Closed);
        }
        Ok(read(&id, &live))
    }

    #[cfg(test)]
    pub(crate) fn ids(&self) -> Vec<ConnectionId> {
        self.map.lock().unwrap().keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(s: &str) -> ConnectionId {
        ConnectionId::parse(s).unwrap()
    }

    fn open(slots: &Slots<&'static str>, connection: &str, attempt: &str) -> Arc<Slot<&'static str>> {
        let slot = Slot::new(Attempt::new(attempt), "live");
        slots.insert(id(connection), slot.clone());
        slot
    }

    #[test]
    fn a_connection_id_is_what_the_keyring_takes_as_one() {
        assert!(ConnectionId::parse("3f2b8c1e-0d4a-4a6b-9c7e-1a2b3c4d5e6f").is_ok());
        assert!(ConnectionId::parse("migrated").is_ok());
        for bad in ["", "short", "UPPER-CASE-ID", "../../other", "has space in it", &"a".repeat(65)] {
            assert_eq!(ConnectionId::parse(bad), Err(saved_password::NOT_A_CONNECTION.to_owned()), "{bad:?}");
        }
    }

    #[test]
    fn a_slot_is_found_by_the_attempt_that_opened_it_and_by_no_other() {
        let slots = Slots::with_limit(2);
        let a = open(&slots, "server-one", "A");
        let b = open(&slots, "server-two", "B");
        let (found, slot) = slots.find(&Attempt::new("A")).unwrap();
        assert!(found == id("server-one") && Arc::ptr_eq(&slot, &a));
        let (found, slot) = slots.find(&Attempt::new("B")).unwrap();
        assert!(found == id("server-two") && Arc::ptr_eq(&slot, &b));
        assert!(matches!(slots.find(&Attempt::new("C")), Err(TransportError::Closed)));

        let nameless = open(&slots, "server-two", "");
        assert!(matches!(slots.find(&Attempt::new("")), Err(TransportError::Closed)), "a connection opened with no attempt answers to none");
        assert!(matches!(slots.find(&Attempt::new("B")), Err(TransportError::Closed)), "B was replaced");
        assert!(slots.is_current(&id("server-two"), &nameless) && !slots.is_current(&id("server-two"), &b));
    }

    #[test]
    fn at_a_limit_of_one_a_new_connection_takes_every_place_and_above_it_only_its_own() {
        let one = Slots::default();
        open(&one, "server-one", "A");
        assert_eq!(one.evict_for(&id("server-two")), [id("server-one")]);
        assert!(one.ids().is_empty());
        open(&one, "server-one", "A");
        assert_eq!(one.evict_for(&id("server-one")), [id("server-one")]);

        let two = Slots::with_limit(2);
        open(&two, "server-one", "A");
        assert_eq!(two.evict_for(&id("server-two")), []);
        open(&two, "server-two", "B");
        assert_eq!(two.evict_for(&id("server-two")), [id("server-two")]);
        assert_eq!(two.ids(), [id("server-one")]);
    }

    #[test]
    fn only_the_slot_still_held_is_taken_out() {
        let slots = Slots::default();
        let old = open(&slots, "server-one", "A1");
        let new = open(&slots, "server-one", "A2");
        assert!(!slots.remove_if(&id("server-one"), &old), "the replaced slot is gone already");
        assert_eq!(slots.remove_attempt(&Attempt::new("A1")), None);
        assert!(slots.is_current(&id("server-one"), &new));
        assert_eq!(slots.remove_attempt(&Attempt::new("A2")), Some(id("server-one")));
        assert!(slots.ids().is_empty());
    }

    #[tokio::test]
    async fn a_read_that_waited_out_a_reopen_is_refused_once_its_slot_was_replaced() {
        let slots = Arc::new(Slots::default());
        let old = open(&slots, "server-one", "A1");
        let reopening = old.live.lock().await;
        let waiting = tokio::spawn({
            let slots = slots.clone();
            async move { slots.read(&Attempt::new("A1"), |_, live| *live).await }
        });
        tokio::task::yield_now().await;
        open(&slots, "server-one", "A2");
        drop(reopening);
        assert!(matches!(waiting.await.unwrap(), Err(TransportError::Closed)));
        assert_eq!(slots.read(&Attempt::new("A2"), |id, live| (id.clone(), *live)).await.unwrap(), (id("server-one"), "live"));
    }
}
