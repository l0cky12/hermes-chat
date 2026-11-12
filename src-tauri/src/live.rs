//! The connections Rust holds open, each under the saved connection it belongs to (ADR 0125, step 1). A command
//! reaches its connection by the attempt that opened it (ADR 0142), so one replaced or closed since is refused.

use crate::lock::Locked;
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
    pub(crate) pipe: Pipe,
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

/// The most connections held open, whatever limit the owner sets (ADR 0125).
pub(crate) const MAX_LIVE: usize = 8;

/// A connect refused because `held` are open already, as many as the limit allows. Nothing is closed to make room.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AtLimit {
    pub(crate) limit: usize,
}

impl std::fmt::Display for AtLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Hermes Chat already has {} connections open, the most it keeps open. Disconnect one first.", self.limit)
    }
}

/// The open connections by saved connection, at most the owner's limit of them. The map is locked only to look one up,
/// add one or take one out, never while anything waits, so a slow connect holds up no other connection's commands.
/// `limit` is the one used when a connect names none: 1, as before the webview kept several.
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
        let map = self.map.locked();
        let found = map.iter().find(|(_, s)| !attempt.0.is_empty() && s.attempt == *attempt);
        found.map(|(id, s)| (id.clone(), s.clone())).ok_or(TransportError::Closed)
    }

    /// Whether `slot` is still the one held for `id`: false once it was replaced or closed.
    pub(crate) fn is_current(&self, id: &ConnectionId, slot: &Arc<Slot<L>>) -> bool {
        self.map.locked().get(id).is_some_and(|s| Arc::ptr_eq(s, slot))
    }

    /// Takes out the connections that give way to a new one for `id`, and names them: every one at a limit of 1, as
    /// one connection replaces another; above it only `id`'s own opening. `asked` is the owner's limit, kept within
    /// 1 to `MAX_LIVE`. Above 1, a connect that would hold more than the limit is refused and nothing is taken out: a
    /// silent close would drop the Approvals of every chat that connection holds.
    pub(crate) fn evict_for(&self, id: &ConnectionId, asked: Option<usize>) -> Result<Vec<ConnectionId>, AtLimit> {
        let limit = self.limit_of(asked);
        let mut map = self.map.locked();
        if limit == 1 {
            return Ok(map.drain().map(|(id, _)| id).collect());
        }
        Self::room(&map, id, limit)?;
        Ok(map.remove(id).map(|_| id.clone()).into_iter().collect())
    }

    /// Whether `evict_for` would make room for `id`, checked before a connect begins so a refused one opens nothing.
    pub(crate) fn room_for(&self, id: &ConnectionId, asked: Option<usize>) -> Result<(), AtLimit> {
        let limit = self.limit_of(asked);
        if limit == 1 {
            return Ok(());
        }
        Self::room(&self.map.locked(), id, limit)
    }

    fn limit_of(&self, asked: Option<usize>) -> usize {
        asked.unwrap_or(self.limit).clamp(1, MAX_LIVE)
    }

    fn room(map: &HashMap<ConnectionId, Arc<Slot<L>>>, id: &ConnectionId, limit: usize) -> Result<(), AtLimit> {
        if map.keys().filter(|k| *k != id).count() >= limit {
            return Err(AtLimit { limit });
        }
        Ok(())
    }

    pub(crate) fn insert(&self, id: ConnectionId, slot: Arc<Slot<L>>) {
        self.map.locked().insert(id, slot);
    }

    /// Takes `slot` out if it is still the one held for `id`, and says whether it was.
    pub(crate) fn remove_if(&self, id: &ConnectionId, slot: &Arc<Slot<L>>) -> bool {
        let mut map = self.map.locked();
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
        self.map.locked().keys().cloned().collect()
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
        assert_eq!(one.evict_for(&id("server-two"), None), Ok(vec![id("server-one")]));
        assert!(one.ids().is_empty());
        open(&one, "server-one", "A");
        assert_eq!(one.evict_for(&id("server-one"), None), Ok(vec![id("server-one")]));

        let two = Slots::with_limit(2);
        open(&two, "server-one", "A");
        assert_eq!(two.evict_for(&id("server-two"), None), Ok(vec![]));
        open(&two, "server-two", "B");
        assert_eq!(two.evict_for(&id("server-two"), None), Ok(vec![id("server-two")]));
        assert_eq!(two.ids(), [id("server-one")]);
    }

    #[test]
    fn at_the_owners_limit_a_connect_is_refused_and_nothing_is_closed() {
        let slots = Slots::default();
        open(&slots, "server-one", "A");
        open(&slots, "server-two", "B");
        assert_eq!(slots.room_for(&id("server-three"), Some(2)), Err(AtLimit { limit: 2 }));
        assert_eq!(slots.evict_for(&id("server-three"), Some(2)), Err(AtLimit { limit: 2 }));
        assert_eq!(slots.room_for(&id("server-two"), Some(2)), Ok(()));
        let mut held = slots.ids();
        held.sort_by_key(|i| i.0.clone());
        assert_eq!(held, [id("server-one"), id("server-two")], "a refused connect closed one");
        assert_eq!(slots.evict_for(&id("server-two"), Some(2)), Ok(vec![id("server-two")]), "opening one held again replaces only it");
        assert_eq!(slots.evict_for(&id("server-three"), Some(3)), Ok(vec![]), "a raised limit makes room");
        open(&slots, "server-three", "C");
        let mut replaced = slots.evict_for(&id("server-four"), Some(1)).unwrap();
        replaced.sort_by_key(|i| i.0.clone());
        assert_eq!(replaced, [id("server-one"), id("server-three")], "a limit of 1 replaces, as before");
    }

    #[test]
    fn no_limit_holds_more_than_eight() {
        let slots = Slots::default();
        for n in 0..MAX_LIVE {
            assert!(slots.evict_for(&id(&format!("server-{n:04}")), Some(100)).is_ok());
            open(&slots, &format!("server-{n:04}"), &format!("A{n}"));
        }
        assert_eq!(slots.evict_for(&id("server-nine"), Some(100)), Err(AtLimit { limit: MAX_LIVE }));
        assert_eq!(slots.evict_for(&id("server-nine"), Some(0)).map(|v| v.len()), Ok(MAX_LIVE), "a limit below 1 is 1");
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
