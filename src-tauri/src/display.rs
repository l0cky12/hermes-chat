//! The side panel's Screen: a profile's Bot Desktop on the Hermes server, streamed as raw RFB over
//! `/api/display/ws` (ADR 0039). The webview asks Hermes for a single-use ticket over `/api/ws` (`display.observe`) and
//! hands it here. Rust opens the socket on the signed-in connection, with the owner's extra request headers, and moves
//! bytes both ways; noVNC in the webview speaks RFB. What input reaches the screen is Hermes's call (its lease and its
//! RFB filter), not this relay's.
//!
//! Two ways a socket ends, because Hermes reads them differently (ADR 0039). The Screen letting go (`close`) is a normal
//! close (1000): the viewer left, so control the owner took goes back to the agent. The connection being replaced or
//! closed (`close_for`, as transfers are stopped, ADR 0023) abandons each of its sockets with no close frame: to Hermes that
//! is a dropped link, which keeps the owner in control, since they may be part-way through a sign-in. Leaving on
//! purpose hands control back over `/api/ws` first (transport.ts `releaseScreen`).

use crate::live::ConnectionId;
use crate::transport::{Dashboard, TransportError};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

/// Hermes's tickets are short; anything far longer isn't one.
const MAX_TICKET: usize = 512;
/// How long a close may take to send before the socket is just dropped.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

/// What a screen socket reports: RFB bytes as they come, then, once, how it closed. `code` is the WebSocket close
/// code: Hermes's own (4000 control taken by another viewer, 4001 the screen isn't running, 4401 a bad ticket), 1000
/// for a normal close, 1006 when the connection broke.
#[derive(Debug, PartialEq)]
pub enum DisplayEvent {
    Data(Vec<u8>),
    Closed { code: u16, reason: String },
}

enum Out {
    Bytes(Vec<u8>),
    /// Ends the socket with no close frame.
    Abandon,
}

/// One open screen socket. Dropping it closes the socket normally; `abandon` ends it as a dropped link.
pub struct DisplaySocket {
    outgoing: mpsc::UnboundedSender<Out>,
}

impl DisplaySocket {
    pub fn send(&self, bytes: Vec<u8>) -> Result<(), TransportError> {
        self.outgoing.send(Out::Bytes(bytes)).map_err(|_| TransportError::Closed)
    }

    /// Ends the socket without a close frame, so Hermes keeps control with the owner if they hold it.
    pub fn abandon(self) {
        let _ = self.outgoing.send(Out::Abandon);
    }
}

fn checked_ticket(ticket: &str) -> Result<&str, TransportError> {
    let ok = !ticket.is_empty() && ticket.len() <= MAX_TICKET && ticket.chars().all(|c| c.is_ascii_graphic());
    if ok {
        Ok(ticket)
    } else {
        Err(TransportError::WebSocket("Hermes gave the screen a ticket that isn't one.".into()))
    }
}

/// How long the Screen's socket may take to open (#473).
const OPEN_LIMIT: std::time::Duration = std::time::Duration::from_secs(15);

/// Opens `/api/display/ws` with `ticket` on `dashboard`'s connection.
pub async fn open(dashboard: Arc<Dashboard>, ticket: &str, on_event: impl Fn(DisplayEvent) + Send + 'static) -> Result<DisplaySocket, TransportError> {
    let handshake = dashboard.ws_handshake("api/display/ws", &[("display_ticket", checked_ticket(ticket)?)])?;
    let (ws, _) = tokio::time::timeout(OPEN_LIMIT, tokio_tungstenite::connect_async(handshake))
        .await
        .map_err(|_| TransportError::WebSocket(format!("it didn't open within {}s.", OPEN_LIMIT.as_secs())))?
        .map_err(|e| TransportError::WebSocket(e.to_string()))?;
    let (outgoing, mut to_server) = mpsc::unbounded_channel::<Out>();
    tokio::spawn(async move {
        let (mut sink, mut stream) = ws.split();
        let (code, reason) = loop {
            tokio::select! {
                out = to_server.recv() => match out {
                    Some(Out::Bytes(bytes)) => {
                        if let Err(e) = sink.send(Message::binary(bytes)).await {
                            break (1006, e.to_string());
                        }
                    }
                    // The socket is dropped below with no close frame.
                    Some(Out::Abandon) => break (1006, "the connection to Hermes closed".into()),
                    None => {
                        let close = CloseFrame { code: CloseCode::Normal, reason: "".into() };
                        let _ = tokio::time::timeout(CLOSE_WAIT, sink.send(Message::Close(Some(close)))).await;
                        break (1000, "closed by the app".into());
                    }
                },
                msg = stream.next() => match msg {
                    Some(Ok(Message::Binary(bytes))) => on_event(DisplayEvent::Data(bytes.to_vec())),
                    Some(Ok(Message::Close(frame))) => break frame.map_or((1005, String::new()), |f| (u16::from(f.code), f.reason.to_string())),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break (1006, e.to_string()),
                    None => break (1006, "the connection closed".into()),
                },
            }
        };
        let reason = if dashboard.hides_reason(&reason) { String::new() } else { reason };
        on_event(DisplayEvent::Closed { code, reason });
    });
    Ok(DisplaySocket { outgoing })
}

/// The screen sockets open now, by id, each with the connection it was opened on.
#[derive(Default)]
pub struct Displays {
    next: AtomicU64,
    open: Mutex<HashMap<u64, (ConnectionId, DisplaySocket)>>,
    /// Counts the times each connection's sockets were closed, so one opened across a reconnect is closed too. Locked
    /// only while `open` is, or alone.
    epochs: Mutex<HashMap<ConnectionId, u64>>,
}

impl Displays {
    pub fn epoch(&self, connection: &ConnectionId) -> u64 {
        self.epochs.lock().unwrap().get(connection).copied().unwrap_or(0)
    }

    /// Keeps `socket` under a new id, unless `connection`'s sockets were closed since `epoch`: then it is abandoned,
    /// as `close_for` would have, and the answer is None.
    pub fn keep(&self, connection: &ConnectionId, epoch: u64, socket: DisplaySocket) -> Option<u64> {
        let mut open = self.open.lock().unwrap();
        if self.epoch(connection) != epoch {
            socket.abandon();
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        open.insert(id, (connection.clone(), socket));
        Some(id)
    }

    pub fn send(&self, id: u64, bytes: Vec<u8>) -> Result<(), TransportError> {
        self.open.lock().unwrap().get(&id).ok_or(TransportError::Closed)?.1.send(bytes)
    }

    /// Closes socket `id`; one already gone is left alone.
    pub fn close(&self, id: u64) {
        self.open.lock().unwrap().remove(&id);
    }

    /// Abandons every socket opened on `connection`, which is going; another connection's stay. Hermes sees dropped
    /// links, so control the owner holds stays theirs; leaving on purpose has already handed it back.
    pub fn close_for(&self, connection: &ConnectionId) {
        let mut open = self.open.lock().unwrap();
        *self.epochs.lock().unwrap().entry(connection.clone()).or_default() += 1;
        let going: Vec<u64> = open.iter().filter(|(_, (on, _))| on == connection).map(|(id, _)| *id).collect();
        for id in going {
            if let Some((_, socket)) = open.remove(&id) {
                socket.abandon();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_ticket_that_isnt_one() {
        for bad in ["", "a b", "tab\there", "line\nbreak", &"x".repeat(MAX_TICKET + 1)] {
            assert!(checked_ticket(bad).is_err(), "{bad:?}");
        }
        assert!(checked_ticket("Abc-123_x.y~z").is_ok());
    }

    #[test]
    fn a_socket_kept_after_its_connection_went_is_closed_instead() {
        let displays = Displays::default();
        let one = ConnectionId::parse("server-one").unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let epoch = displays.epoch(&one);
        displays.close_for(&one);
        assert_eq!(displays.keep(&one, epoch, DisplaySocket { outgoing: tx }), None);
        // Abandoned, as the connection it was opened on went: no normal close for Hermes to take as leaving.
        assert!(matches!(rx.try_recv(), Ok(Out::Abandon)));

        let (tx, mut rx) = mpsc::unbounded_channel();
        let id = displays.keep(&one, displays.epoch(&one), DisplaySocket { outgoing: tx }).unwrap();
        displays.send(id, vec![1, 2]).unwrap();
        displays.close_for(&one);
        assert!(matches!(rx.try_recv(), Ok(Out::Bytes(b)) if b == [1, 2]));
        assert!(matches!(rx.try_recv(), Ok(Out::Abandon)), "the connection going abandons the socket");
        assert!(matches!(displays.send(id, vec![3]), Err(TransportError::Closed)));
    }

    #[test]
    fn one_connection_going_leaves_another_connections_sockets_open() {
        let displays = Displays::default();
        let (one, two) = (ConnectionId::parse("server-one").unwrap(), ConnectionId::parse("server-two").unwrap());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let asked = displays.epoch(&two);
        let kept = displays.keep(&two, asked, DisplaySocket { outgoing: tx }).unwrap();
        displays.close_for(&one);
        displays.send(kept, vec![7]).unwrap();
        assert!(matches!(rx.try_recv(), Ok(Out::Bytes(b)) if b == [7]));
        assert!(rx.try_recv().is_err(), "the other connection's socket was abandoned");
        // A socket asked for on the connection still open, before the other went, is kept too.
        let (tx, _rx) = mpsc::unbounded_channel();
        assert!(displays.keep(&two, asked, DisplaySocket { outgoing: tx }).is_some());
    }
}
