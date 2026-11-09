//! Which account a connection to a relay port on `127.0.0.1` comes from (ADR 0103, #355). The sign-in tunnel and
//! every server page relay through such a port (`server_page::serve`), and only the owner's own programs may use it.
//!
//! On Linux the peer's socket is looked up in `/proc/net/tcp` and `/proc/net/tcp6`, which name each socket's owner.
//! TCP has no `SO_PEERCRED`. A connection whose row can't be found or read counts as another account's. Other
//! platforms admit every connection (#378).

#[cfg(target_os = "linux")]
pub(crate) type Account = libc::uid_t;
#[cfg(not(target_os = "linux"))]
#[derive(Clone, Copy)]
pub(crate) struct Account;

#[cfg(target_os = "linux")]
pub(crate) fn this_account() -> Account {
    unsafe { libc::getuid() }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn this_account() -> Account {
    Account
}

/// Whether the program at the other end of `tcp`, a connection accepted on this computer's loopback, runs as
/// `account`.
#[cfg(target_os = "linux")]
pub(crate) fn runs_as(tcp: &tokio::net::TcpStream, account: Account) -> bool {
    let (Ok(local), Ok(peer)) = (tcp.local_addr(), tcp.peer_addr()) else { return false };
    owner(local, peer) == Some(account)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn runs_as(_tcp: &tokio::net::TcpStream, _account: Account) -> bool {
    true
}

/// The owner of the socket at `peer` that is connected to `local`. A program on an IPv6 socket that reaches
/// `127.0.0.1` through `::ffff:127.0.0.1` is listed in `tcp6`.
#[cfg(target_os = "linux")]
fn owner(local: std::net::SocketAddr, peer: std::net::SocketAddr) -> Option<Account> {
    ["/proc/net/tcp", "/proc/net/tcp6"].into_iter().find_map(|table| owner_in(&std::fs::read_to_string(table).ok()?, local, peer))
}

/// `owner`, from the text of one table. A socket in TIME_WAIT is listed with uid 0, so it names no owner.
#[cfg(target_os = "linux")]
fn owner_in(table: &str, local: std::net::SocketAddr, peer: std::net::SocketAddr) -> Option<Account> {
    const TIME_WAIT: &str = "06";
    let (local, peer) = (canonical(local), canonical(peer));
    table.lines().skip(1).find_map(|row| {
        let fields: Vec<&str> = row.split_whitespace().collect();
        let (from, to, state, uid) = (fields.get(1)?, fields.get(2)?, fields.get(3)?, fields.get(7)?);
        if *state == TIME_WAIT || address(from)? != peer || address(to)? != local {
            return None;
        }
        uid.parse().ok()
    })
}

/// A `/proc/net/tcp{,6}` address: the IP as 32-bit words in this computer's byte order, then the port, in hex.
#[cfg(target_os = "linux")]
fn address(field: &str) -> Option<std::net::SocketAddr> {
    let (hex, port) = field.split_once(':')?;
    if hex.len() != 8 && hex.len() != 32 {
        return None;
    }
    let mut bytes = Vec::with_capacity(16);
    for i in (0..hex.len()).step_by(8) {
        bytes.extend(u32::from_str_radix(hex.get(i..i + 8)?, 16).ok()?.to_ne_bytes());
    }
    let ip = match <[u8; 4]>::try_from(bytes.as_slice()) {
        Ok(v4) => std::net::IpAddr::from(v4),
        Err(_) => std::net::IpAddr::from(<[u8; 16]>::try_from(bytes.as_slice()).ok()?),
    };
    Some(canonical(std::net::SocketAddr::new(ip, u16::from_str_radix(port, 16).ok()?)))
}

#[cfg(target_os = "linux")]
fn canonical(a: std::net::SocketAddr) -> std::net::SocketAddr {
    std::net::SocketAddr::new(a.ip().to_canonical(), a.port())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::net::{TcpListener, TcpStream};

    async fn accepted(client_to: impl Fn(u16) -> String) -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = TcpStream::connect(client_to(port)).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        (client, server)
    }

    #[tokio::test]
    async fn a_connection_from_this_account_is_its_own_and_no_other_accounts() {
        let (_client, server) = accepted(|port| format!("127.0.0.1:{port}")).await;
        assert!(runs_as(&server, this_account()));
        assert!(!runs_as(&server, this_account() + 1));
    }

    #[tokio::test]
    async fn a_connection_from_an_ipv6_socket_through_a_mapped_address_is_found_in_tcp6() {
        let (client, server) = accepted(|port| format!("[::ffff:127.0.0.1]:{port}")).await;
        assert!(client.local_addr().unwrap().is_ipv6(), "the client's socket is IPv6");
        assert!(runs_as(&server, this_account()));
        assert!(!runs_as(&server, this_account() + 1));
    }

    const HEAD: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

    fn at(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[cfg(target_endian = "little")]
    #[test]
    fn the_peers_row_names_its_owner_and_anything_else_names_none() {
        let listening = "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0\n";
        let served = "   1: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0 20 4 30 10 -1\n";
        let peer = "   2: 0100007F:D431 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1001        0 3 1 0 20 4 30 10 -1\n";
        let (local, from) = (at("127.0.0.1:8080"), at("127.0.0.1:54321"));

        assert_eq!(owner_in(&format!("{HEAD}{listening}{served}{peer}"), local, from), Some(1001));
        assert_eq!(owner_in(&format!("{HEAD}{listening}{served}"), local, from), None, "no row for the peer");
        let waiting = peer.replace(" 01 ", " 06 ").replace("1001", "   0");
        assert_eq!(owner_in(&format!("{HEAD}{waiting}"), local, from), None, "a TIME_WAIT row has no owner");
        assert_eq!(owner_in(&format!("{HEAD}   2: 0100007F:D431 0100007F:1F90 01\n"), local, from), None, "a short row");
        assert_eq!(owner_in(&format!("{HEAD}   2: 0100007F:D431 0100007F:1F90 01 0 0 0 x\n"), local, from), None, "no uid");
        assert_eq!(owner_in("", local, from), None);
    }

    #[cfg(target_endian = "little")]
    #[test]
    fn a_tcp6_row_for_a_mapped_address_matches_the_ipv4_peer() {
        let mapped = "0000000000000000FFFF00000100007F";
        let row = format!("   0: {mapped}:D431 {mapped}:1F90 01 00000000:00000000 00:00000000 00000000  1001        0 3 1 0\n");
        assert_eq!(owner_in(&format!("{HEAD}{row}"), at("127.0.0.1:8080"), at("127.0.0.1:54321")), Some(1001));
        assert_eq!(address("00000000000000000000000001000000:0019"), Some(at("[::1]:25")));
        assert_eq!(address("0100007F"), None);
        assert_eq!(address("0100007:0019"), None);
    }
}
