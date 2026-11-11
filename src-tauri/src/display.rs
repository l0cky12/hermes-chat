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
//! purpose hands control back over `/api/ws` first (transport.ts `releaseScreen`). Hermes not reading the owner's input
//! ends a socket the second way too, once `INPUT_BUDGET` waits: the owner is still there, so control stays theirs.

use crate::backlog::Backlog;
use crate::live::ConnectionId;
use crate::lock::Locked;
use crate::transport::{Dashboard, TransportError};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

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

/// How much of the owner's input may wait for Hermes to read it: about 130,000 pointer events, far past any backlog
/// worth sending. One message larger than this, such as a big clipboard paste, still goes when nothing waits.
const INPUT_BUDGET: usize = 1024 * 1024;
const FELL_BEHIND: &str = "Hermes stopped taking the screen's input";

/// One open screen socket. Dropping it closes the socket normally; `abandon` ends it as a dropped link.
pub struct DisplaySocket {
    outgoing: mpsc::UnboundedSender<Vec<u8>>,
    waiting: Arc<Backlog>,
    /// Set, the socket ends at once with no close frame, as a dropped link, and this as its reason.
    drop_link: watch::Sender<Option<&'static str>>,
}

impl DisplaySocket {
    /// Sends RFB bytes. RFB is one stream, so input can't be left out to catch up: past `INPUT_BUDGET` waiting, the
    /// socket ends as a dropped link, and the Screen watches again as it does after one.
    pub fn send(&self, bytes: Vec<u8>) -> Result<(), TransportError> {
        if !self.waiting.take(bytes.len()) {
            self.drop_link.send_replace(Some(FELL_BEHIND));
            return Err(TransportError::Closed);
        }
        self.outgoing.send(bytes).map_err(|_| TransportError::Closed)
    }

    /// Ends the socket without a close frame, so Hermes keeps control with the owner if they hold it.
    pub fn abandon(self) {
        self.drop_link.send_replace(Some("the connection to Hermes closed"));
    }
}

/// Why the socket is to end as a dropped link, once it is. Never, if its `DisplaySocket` went without saying.
async fn dropped(drop_link: &mut watch::Receiver<Option<&'static str>>) -> &'static str {
    let why = drop_link.wait_for(Option::is_some).await.map(|why| why.unwrap_or_default());
    match why {
        Ok(why) => why,
        Err(_) => std::future::pending().await,
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
    Ok(relay(ws, move |reason| dashboard.hides_reason(reason), on_event))
}

/// Moves bytes both ways on the open socket `ws` until it closes. A close reason `hides` matches isn't passed on.
fn relay<S>(ws: WebSocketStream<S>, hides: impl Fn(&str) -> bool + Send + 'static, on_event: impl Fn(DisplayEvent) + Send + 'static) -> DisplaySocket
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (outgoing, mut to_server) = mpsc::unbounded_channel::<Vec<u8>>();
    let waiting = Arc::new(Backlog::new(INPUT_BUDGET));
    let (drop_link, mut link_dropped) = watch::channel(None);
    let written = waiting.clone();
    tokio::spawn(async move {
        let (mut sink, mut stream) = ws.split();
        let (code, reason) = loop {
            tokio::select! {
                biased;
                // The socket is dropped below with no close frame.
                why = dropped(&mut link_dropped) => break (1006, why.into()),
                out = to_server.recv() => match out {
                    Some(bytes) => {
                        let len = bytes.len();
                        // Hermes not reading leaves this waiting, so dropping the link mustn't wait for it.
                        let sent = tokio::select! {
                            biased;
                            why = dropped(&mut link_dropped) => break (1006, why.into()),
                            sent = sink.send(Message::binary(bytes)) => sent,
                        };
                        written.written(len);
                        if let Err(e) = sent {
                            break (1006, e.to_string());
                        }
                    }
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
        let reason = if hides(&reason) { String::new() } else { reason };
        on_event(DisplayEvent::Closed { code, reason });
    });
    DisplaySocket { outgoing, waiting, drop_link }
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
        self.epochs.locked().get(connection).copied().unwrap_or(0)
    }

    /// Keeps `socket` under a new id, unless `connection`'s sockets were closed since `epoch`: then it is abandoned,
    /// as `close_for` would have, and the answer is None.
    pub fn keep(&self, connection: &ConnectionId, epoch: u64, socket: DisplaySocket) -> Option<u64> {
        let mut open = self.open.locked();
        if self.epoch(connection) != epoch {
            socket.abandon();
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        open.insert(id, (connection.clone(), socket));
        Some(id)
    }

    pub fn send(&self, id: u64, bytes: Vec<u8>) -> Result<(), TransportError> {
        self.open.locked().get(&id).ok_or(TransportError::Closed)?.1.send(bytes)
    }

    /// Closes socket `id`; one already gone is left alone.
    pub fn close(&self, id: u64) {
        self.open.locked().remove(&id);
    }

    /// Abandons every socket opened on `connection`, which is going; another connection's stay. Hermes sees dropped
    /// links, so control the owner holds stays theirs; leaving on purpose has already handed it back.
    pub fn close_for(&self, connection: &ConnectionId) {
        let mut open = self.open.locked();
        *self.epochs.locked().entry(connection.clone()).or_default() += 1;
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

    /// Hermes not reading what the Screen sends: past a megabyte waiting, a send is refused, and the socket ends as a
    /// dropped link does (1006, no close frame), so the Screen's own way back from a lost stream applies.
    #[tokio::test]
    async fn input_hermes_isnt_reading_is_refused_past_a_megabyte_and_ends_the_socket() {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.set_recv_buffer_size(64 * 1024).unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let listener = socket.listen(1).unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            // Opened and never read.
            let _ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            std::future::pending::<()>().await;
        });
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/")).await.unwrap();
        let (events, mut heard) = mpsc::unbounded_channel();
        let socket = relay(ws, |_| false, move |e| drop(events.send(e)));

        let chunk = vec![0u8; 64 * 1024];
        let mut taken = 0;
        while socket.send(chunk.clone()).is_ok() {
            taken += chunk.len();
            assert!(taken <= 64 * 1024 * 1024, "64 MiB taken and nothing refused");
            // Lets the relay write what the socket takes, as it does between the webview's sends.
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert!(taken >= 1024 * 1024, "refused after only {taken} bytes");
        let closed = tokio::time::timeout(Duration::from_secs(5), heard.recv()).await.expect("the socket didn't end");
        assert!(matches!(closed, Some(DisplayEvent::Closed { code: 1006, .. })), "{closed:?}");
    }

    /// A socket with no relay behind it: what it sends, and whether it was abandoned.
    fn unrelayed() -> (DisplaySocket, mpsc::UnboundedReceiver<Vec<u8>>, watch::Receiver<Option<&'static str>>) {
        let (outgoing, sent) = mpsc::unbounded_channel();
        let (drop_link, dropped) = watch::channel(None);
        (DisplaySocket { outgoing, waiting: Arc::new(Backlog::new(INPUT_BUDGET)), drop_link }, sent, dropped)
    }

    #[test]
    fn a_socket_kept_after_its_connection_went_is_closed_instead() {
        let displays = Displays::default();
        let one = ConnectionId::parse("server-one").unwrap();
        let (socket, _, dropped) = unrelayed();
        let epoch = displays.epoch(&one);
        displays.close_for(&one);
        assert_eq!(displays.keep(&one, epoch, socket), None);
        // Abandoned, as the connection it was opened on went: no normal close for Hermes to take as leaving.
        assert!(dropped.borrow().is_some());

        let (socket, mut sent, dropped) = unrelayed();
        let id = displays.keep(&one, displays.epoch(&one), socket).unwrap();
        displays.send(id, vec![1, 2]).unwrap();
        displays.close_for(&one);
        assert_eq!(sent.try_recv().ok(), Some(vec![1, 2]));
        assert!(dropped.borrow().is_some(), "the connection going abandons the socket");
        assert!(matches!(displays.send(id, vec![3]), Err(TransportError::Closed)));
    }

    #[test]
    fn one_connection_going_leaves_another_connections_sockets_open() {
        let displays = Displays::default();
        let (one, two) = (ConnectionId::parse("server-one").unwrap(), ConnectionId::parse("server-two").unwrap());
        let (socket, mut sent, dropped) = unrelayed();
        let asked = displays.epoch(&two);
        let kept = displays.keep(&two, asked, socket).unwrap();
        displays.close_for(&one);
        displays.send(kept, vec![7]).unwrap();
        assert_eq!(sent.try_recv().ok(), Some(vec![7]));
        assert!(dropped.borrow().is_none(), "the other connection's socket was abandoned");
        // A socket asked for on the connection still open, before the other went, is kept too.
        let (socket, _, _) = unrelayed();
        assert!(displays.keep(&two, asked, socket).is_some());
    }
}
