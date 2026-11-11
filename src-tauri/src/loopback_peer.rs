//! Who is at the other end of a connection to a relay port on `127.0.0.1` (ADR 0105, ADR 0138, #355, #378). The
//! sign-in tunnel and every server page relay through such a port (`server_page::serve`). Only this process may use
//! the sign-in tunnel's; only the owner's own programs may use a server page's, which WebKit's network process loads.
//!
//! On Linux the peer's socket is looked up in `/proc/net/tcp` and `/proc/net/tcp6`, which name each socket's owner
//! and inode. TCP has no `SO_PEERCRED`. On Windows the peer's row in the IPv4 TCP table names the process that holds
//! it, and that process's token names its account. A connection whose row or owner can't be found or read is refused.
//! Other platforms, which the app isn't built for, admit every connection.

#[cfg(target_os = "linux")]
pub(crate) type Account = libc::uid_t;
/// The security identifier (SID) of the account a token runs as, zero-padded to the largest SID. `None` when the app
/// couldn't read its own, so no connection matches it.
#[cfg(windows)]
pub(crate) type Account = Option<[u8; win::SID_SIZE]>;
#[cfg(not(any(target_os = "linux", windows)))]
#[derive(Clone, Copy)]
pub(crate) struct Account;

/// LocalSystem, S-1-5-18: an account the tests never run as.
#[cfg(all(test, windows))]
pub(crate) fn local_system() -> Account {
    let mut sid = [0u8; win::SID_SIZE];
    sid[..12].copy_from_slice(&[1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0]);
    Some(sid)
}

#[cfg(target_os = "linux")]
pub(crate) fn this_account() -> Account {
    unsafe { libc::getuid() }
}

#[cfg(windows)]
pub(crate) fn this_account() -> Account {
    win::this_account()
}

#[cfg(not(any(target_os = "linux", windows)))]
pub(crate) fn this_account() -> Account {
    Account
}

/// Whether process `pid` runs as this process's account. False when either account can't be read, which is the case
/// for another account's process unless the app runs as an administrator.
#[cfg(windows)]
pub(crate) fn runs_as_this_account(pid: u32) -> bool {
    let this = this_account();
    this.is_some() && win::account_of(pid) == this
}

/// Who a relay port serves.
#[derive(Clone, Copy)]
pub(crate) enum Peers {
    /// Sockets this process holds: the sign-in tunnel, which only Rust uses.
    ThisProcess,
    /// Any program run by this account.
    Account(Account),
}

/// Whether `tcp`, a connection accepted on this computer's loopback, comes from one of `peers`.
#[cfg(target_os = "linux")]
pub(crate) fn admits(peers: Peers, tcp: &tokio::net::TcpStream) -> bool {
    let (Ok(local), Ok(peer)) = (tcp.local_addr(), tcp.peer_addr()) else { return false };
    let Some(socket) = socket_at(local, peer) else { return false };
    match peers {
        Peers::ThisProcess => socket_inodes(std::path::Path::new("/proc/self/fd")).contains(&socket.inode),
        Peers::Account(account) => socket.owner == account,
    }
}

#[cfg(windows)]
pub(crate) fn admits(peers: Peers, tcp: &tokio::net::TcpStream) -> bool {
    let (Ok(SocketAddr::V4(local)), Ok(SocketAddr::V4(peer))) = (tcp.local_addr(), tcp.peer_addr()) else { return false };
    let Ok(rows) = win::tcp_table() else { return false };
    let Some(pid) = far_end(&rows, local, peer) else { return false };
    match peers {
        Peers::ThisProcess => pid == std::process::id(),
        Peers::Account(account) => account.is_some() && win::account_of(pid) == account,
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
pub(crate) fn admits(_peers: Peers, _tcp: &tokio::net::TcpStream) -> bool {
    true
}

#[cfg(windows)]
use std::net::SocketAddr;
#[cfg(any(windows, test))]
use std::net::SocketAddrV4;

/// One row of Windows' IPv4 TCP table: a connection's two ends and the process that holds it.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Row {
    local: SocketAddrV4,
    remote: SocketAddrV4,
    pid: u32,
}

/// The process holding the peer's end of a connection the relay accepted on `local` from `peer`: the row whose local
/// end is `peer` and whose remote end is `local`.
#[cfg(any(windows, test))]
fn far_end(rows: &[Row], local: SocketAddrV4, peer: SocketAddrV4) -> Option<u32> {
    rows.iter().find(|r| r.local == peer && r.remote == local).map(|r| r.pid)
}

#[cfg(windows)]
mod win {
    use super::{Account, Row};
    use std::net::SocketAddrV4;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, HANDLE, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_CONNECTIONS};
    use windows_sys::Win32::Networking::WinSock::AF_INET;
    use windows_sys::Win32::Security::{GetLengthSid, GetTokenInformation, IsValidSid, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

    pub(crate) const SID_SIZE: usize = 68;

    pub(super) fn this_account() -> Account {
        // SAFETY: the pseudo-handle for this process needs no closing.
        unsafe { user_of(GetCurrentProcess()) }
    }

    /// The account process `pid` runs as. `None` when Windows won't open the process or its token, which is the case
    /// for another account's process unless the app runs as an administrator.
    pub(super) fn account_of(pid: u32) -> Account {
        // SAFETY: the handle is closed before returning.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let user = user_of(process);
            CloseHandle(process);
            user
        }
    }

    /// # Safety
    /// `process` is a live process handle with at least limited query access.
    unsafe fn user_of(process: HANDLE) -> Account {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        // A TOKEN_USER and the SID it points to, which Windows puts right after it. 8-aligned, as TOKEN_USER needs.
        let mut buf = [0u64; 16];
        let mut len = 0u32;
        let read = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), size_of_val(&buf) as u32, &mut len);
        CloseHandle(token);
        if read == 0 {
            return None;
        }
        let sid = (*buf.as_ptr().cast::<TOKEN_USER>()).User.Sid;
        if IsValidSid(sid) == 0 {
            return None;
        }
        let n = GetLengthSid(sid) as usize;
        let mut out = [0u8; SID_SIZE];
        out.get_mut(..n)?.copy_from_slice(std::slice::from_raw_parts(sid.cast::<u8>(), n));
        Some(out)
    }

    /// Every established IPv4 TCP connection on this computer, with the process that holds each end.
    pub(super) fn tcp_table() -> std::io::Result<Vec<Row>> {
        let mut buf: Vec<u64> = Vec::new();
        loop {
            let mut size = (buf.len() * 8) as u32;
            let table = if buf.is_empty() { std::ptr::null_mut() } else { buf.as_mut_ptr().cast() };
            // SAFETY: `table` is null with a size of 0, or `buf`, which holds `size` bytes, 8-aligned as the table needs.
            let r = unsafe { GetExtendedTcpTable(table, &mut size, 0, AF_INET.into(), TCP_TABLE_OWNER_PID_CONNECTIONS, 0) };
            match r {
                NO_ERROR if !buf.is_empty() => break,
                NO_ERROR => return Ok(Vec::new()),
                ERROR_INSUFFICIENT_BUFFER => buf = vec![0; (size as usize).div_ceil(8)],
                e => return Err(std::io::Error::from_raw_os_error(e as i32)),
            }
        }
        let table = buf.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();
        // SAFETY: Windows filled `buf` with a table that starts at `table`'s `table` field. At most as many rows as fit
        // in `buf` are read.
        let rows = unsafe {
            let first = std::ptr::addr_of!((*table).table).cast::<MIB_TCPROW_OWNER_PID>();
            let fit = (buf.len() * 8 - (first as usize - table as usize)) / size_of::<MIB_TCPROW_OWNER_PID>();
            std::slice::from_raw_parts(first, ((*table).dwNumEntries as usize).min(fit))
        };
        // Addresses and ports are in network byte order, a port in the low two bytes of its field.
        let end = |addr: u32, port: u32| SocketAddrV4::new(addr.to_ne_bytes().into(), u16::from_be(port as u16));
        Ok(rows.iter().map(|r| Row { local: end(r.dwLocalAddr, r.dwLocalPort), remote: end(r.dwRemoteAddr, r.dwRemotePort), pid: r.dwOwningPid }).collect())
    }
}

/// The inodes of the sockets open in `fd_dir`, a process's `/proc/<pid>/fd`.
#[cfg(target_os = "linux")]
pub(crate) fn socket_inodes(fd_dir: &std::path::Path) -> Vec<u64> {
    std::fs::read_dir(fd_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|fd| std::fs::read_link(fd.path()).ok())
        .filter_map(|link| link.to_str()?.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok())
        .collect()
}

/// A socket's row in `/proc/net/tcp{,6}`.
#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq)]
struct Socket {
    owner: Account,
    inode: u64,
}

/// The socket at `peer` that is connected to `local`. A program on an IPv6 socket that reaches `127.0.0.1` through
/// `::ffff:127.0.0.1` is listed in `tcp6`.
#[cfg(target_os = "linux")]
fn socket_at(local: std::net::SocketAddr, peer: std::net::SocketAddr) -> Option<Socket> {
    ["/proc/net/tcp", "/proc/net/tcp6"].into_iter().find_map(|table| socket_in(&std::fs::read_to_string(table).ok()?, local, peer))
}

/// `socket_at`, from the text of one table. A socket in TIME_WAIT is listed with uid 0 and inode 0, so it is none.
#[cfg(target_os = "linux")]
fn socket_in(table: &str, local: std::net::SocketAddr, peer: std::net::SocketAddr) -> Option<Socket> {
    const TIME_WAIT: &str = "06";
    let (local, peer) = (canonical(local), canonical(peer));
    table.lines().skip(1).find_map(|row| {
        let fields: Vec<&str> = row.split_whitespace().collect();
        let (from, to, state, uid, inode) = (fields.get(1)?, fields.get(2)?, fields.get(3)?, fields.get(7)?, fields.get(9)?);
        if *state == TIME_WAIT || address(from)? != peer || address(to)? != local {
            return None;
        }
        Some(Socket { owner: uid.parse().ok()?, inode: inode.parse().ok()? })
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
    async fn a_connection_from_this_process_is_its_own_and_this_accounts_and_no_other_accounts() {
        let (_client, server) = accepted(|port| format!("127.0.0.1:{port}")).await;
        assert!(admits(Peers::ThisProcess, &server));
        assert!(admits(Peers::Account(this_account()), &server));
        assert!(!admits(Peers::Account(this_account() + 1), &server));
    }

    #[tokio::test]
    async fn a_connection_from_an_ipv6_socket_through_a_mapped_address_is_found_in_tcp6() {
        let (client, server) = accepted(|port| format!("[::ffff:127.0.0.1]:{port}")).await;
        assert!(client.local_addr().unwrap().is_ipv6(), "the client's socket is IPv6");
        assert!(admits(Peers::ThisProcess, &server));
        assert!(admits(Peers::Account(this_account()), &server));
        assert!(!admits(Peers::Account(this_account() + 1), &server));
    }

    const HEAD: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

    fn at(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[cfg(target_endian = "little")]
    #[test]
    fn the_peers_row_names_its_owner_and_inode_and_anything_else_names_none() {
        let listening = "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0\n";
        let served = "   1: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0 20 4 30 10 -1\n";
        let peer = "   2: 0100007F:D431 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1001        0 3 1 0 20 4 30 10 -1\n";
        let (local, from) = (at("127.0.0.1:8080"), at("127.0.0.1:54321"));

        assert_eq!(socket_in(&format!("{HEAD}{listening}{served}{peer}"), local, from), Some(Socket { owner: 1001, inode: 3 }));
        assert_eq!(socket_in(&format!("{HEAD}{listening}{served}"), local, from), None, "no row for the peer");
        let waiting = peer.replace(" 01 ", " 06 ").replace("1001", "   0");
        assert_eq!(socket_in(&format!("{HEAD}{waiting}"), local, from), None, "a TIME_WAIT row has no owner");
        assert_eq!(socket_in(&format!("{HEAD}   2: 0100007F:D431 0100007F:1F90 01\n"), local, from), None, "a short row");
        assert_eq!(socket_in(&format!("{HEAD}   2: 0100007F:D431 0100007F:1F90 01 0 0 0 x\n"), local, from), None, "no uid");
        assert_eq!(socket_in(&format!("{HEAD}   2: 0100007F:D431 0100007F:1F90 01 0 0 0 1001 0 x\n"), local, from), None, "no inode");
        assert_eq!(socket_in("", local, from), None);
    }

    #[cfg(target_endian = "little")]
    #[test]
    fn a_tcp6_row_for_a_mapped_address_matches_the_ipv4_peer() {
        let mapped = "0000000000000000FFFF00000100007F";
        let row = format!("   0: {mapped}:D431 {mapped}:1F90 01 00000000:00000000 00:00000000 00000000  1001        0 3 1 0\n");
        assert_eq!(socket_in(&format!("{HEAD}{row}"), at("127.0.0.1:8080"), at("127.0.0.1:54321")), Some(Socket { owner: 1001, inode: 3 }));
        assert_eq!(address("00000000000000000000000001000000:0019"), Some(at("[::1]:25")));
        assert_eq!(address("0100007F"), None);
        assert_eq!(address("0100007:0019"), None);
    }
}

#[cfg(test)]
mod row_tests {
    use super::*;

    #[test]
    fn the_peers_row_names_the_process_that_holds_it() {
        let at = |s: &str| s.parse::<SocketAddrV4>().unwrap();
        let (relay, peer) = (at("127.0.0.1:8080"), at("127.0.0.1:54321"));
        let served = Row { local: relay, remote: peer, pid: 10 };
        let theirs = Row { local: peer, remote: relay, pid: 20 };
        let elsewhere = Row { local: peer, remote: at("127.0.0.1:9000"), pid: 30 };
        assert_eq!(far_end(&[served, elsewhere, theirs], relay, peer), Some(20));
        assert_eq!(far_end(&[served, elsewhere], relay, peer), None, "no row for the peer");
        assert_eq!(far_end(&[], relay, peer), None);
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use tokio::net::{TcpListener, TcpStream};

    #[tokio::test]
    async fn a_connection_from_this_process_is_its_own_and_this_accounts_and_no_other_accounts() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let _client = TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        assert!(this_account().is_some(), "the app reads its own account");
        assert!(admits(Peers::ThisProcess, &server));
        assert!(admits(Peers::Account(this_account()), &server));
        assert!(!admits(Peers::Account(local_system()), &server));
        assert!(!admits(Peers::Account(None), &server), "an account the app couldn't read matches nothing");
    }
}
