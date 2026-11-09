//! Which program is on the other end of a loopback connection, on Windows (ADR 0104, #354).
//!
//! Windows' OpenSSH can't forward a Unix socket, so there a tunnel's local end is a loopback port ssh binds after it
//! signs in, and another program can bind it first (ADR 0052, ADR 0098). Every connection to that port is checked
//! before anything is sent on it: Windows' TCP table names the process that holds the far end, and it must be the ssh
//! this app started or a process ssh started (a Scoop or Chocolatey shim named ssh.exe runs the real ssh.exe as its
//! child).

#[cfg(any(windows, test))]
use std::net::SocketAddrV4;

/// The ssh this app started: its process id and when it started, in Windows' `FILETIME` ticks.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SshProcess {
    pub pid: u32,
    pub started: u64,
}

/// A process another one started, as a snapshot of all of them names it.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug)]
struct Process {
    parent: u32,
    started: u64,
}

/// One row of Windows' IPv4 TCP table (`MIB_TCPROW_OWNER_PID`).
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Row {
    local: SocketAddrV4,
    remote: SocketAddrV4,
    pid: u32,
}

#[cfg(any(windows, test))]
impl Row {
    /// A row from the table's fields: addresses in network byte order, ports in network byte order in the low two
    /// bytes of a `u32`, as Windows lays them out in memory.
    fn new(local_addr: u32, local_port: u32, remote_addr: u32, remote_port: u32, pid: u32) -> Row {
        fn end(addr: u32, port: u32) -> SocketAddrV4 {
            let [hi, lo, ..] = port.to_ne_bytes();
            SocketAddrV4::new(addr.to_ne_bytes().into(), u16::from_be_bytes([hi, lo]))
        }
        Row { local: end(local_addr, local_port), remote: end(remote_addr, remote_port), pid }
    }
}

/// The process holding the far end of the connection from `ours` to `theirs`: the row whose local end is `theirs` and
/// whose remote end is `ours`. A connection ssh hasn't accepted yet already has that row, owned by the listener's
/// process.
#[cfg(any(windows, test))]
fn far_end(rows: &[Row], ours: SocketAddrV4, theirs: SocketAddrV4) -> Option<u32> {
    rows.iter().find(|r| r.local == theirs && r.remote == ours).map(|r| r.pid)
}

/// How many shims deep the real ssh may be.
#[cfg(any(windows, test))]
const MAX_DEPTH: usize = 8;

/// Whether `pid` is `ssh` or was started by it, directly or through other processes it started. Each process must have
/// started no earlier than its parent, so a process whose parent's id has since gone to another process doesn't count.
/// A process `process` can't name doesn't count either.
#[cfg(any(windows, test))]
fn started_by(pid: u32, ssh: SshProcess, process: impl Fn(u32) -> Option<Process>) -> bool {
    let mut pid = pid;
    for _ in 0..=MAX_DEPTH {
        if pid == ssh.pid {
            return true;
        }
        let Some(p) = process(pid) else { return false };
        let parent_started = if p.parent == ssh.pid {
            ssh.started
        } else {
            match process(p.parent) {
                Some(parent) => parent.started,
                None => return false,
            }
        };
        if p.started < parent_started {
            return false;
        }
        pid = p.parent;
    }
    false
}

#[cfg(windows)]
pub(crate) use win::check;

#[cfg(windows)]
mod win {
    use super::{far_end, started_by, Process, Row, SshProcess};
    use std::collections::HashMap;
    use std::io::{Error, ErrorKind};
    use std::net::SocketAddr;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, FILETIME, HANDLE, INVALID_HANDLE_VALUE, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL};
    use windows_sys::Win32::Networking::WinSock::AF_INET;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    impl SshProcess {
        /// The ssh `child` is. Its handle stays open while the child is kept, so Windows gives its id to no other
        /// process meanwhile.
        pub(crate) fn of(child: &tokio::process::Child) -> std::io::Result<SshProcess> {
            let gone = || Error::other("ssh has exited");
            let pid = child.id().ok_or_else(gone)?;
            let handle = child.raw_handle().ok_or_else(gone)?;
            Ok(SshProcess { pid, started: started(handle as HANDLE)? })
        }
    }

    /// Fails with `ErrorKind::PermissionDenied` unless the far end of `stream`, a connection to a loopback port, is
    /// held by `ssh` or a process it started. Not knowing who holds it fails too; the message says which it was.
    pub(crate) fn check(stream: &tokio::net::TcpStream, ssh: SshProcess) -> std::io::Result<()> {
        let denied = |why: String| Error::new(ErrorKind::PermissionDenied, why);
        let (SocketAddr::V4(ours), SocketAddr::V4(theirs)) = (stream.local_addr()?, stream.peer_addr()?) else {
            return Err(denied("the tunnel isn't on IPv4 loopback".into()));
        };
        let unknown = |e: String| denied(format!("Hermes Chat couldn't check which program is listening on {theirs}: {e}"));
        let rows = tcp_table().map_err(|e| unknown(e.to_string()))?;
        let pid = far_end(&rows, ours, theirs).ok_or_else(|| unknown("Windows lists no program for the connection".into()))?;
        if pid == ssh.pid {
            return Ok(());
        }
        let parents = parents().map_err(|e| unknown(format!("couldn't list the programs running: {e}")))?;
        let process = |pid| Some(Process { parent: *parents.get(&pid)?, started: opened(pid).ok()? });
        if started_by(pid, ssh, process) {
            Ok(())
        } else {
            Err(denied(format!("process {pid} is listening on {theirs}, and Hermes Chat couldn't confirm it is the ssh it started")))
        }
    }

    /// Every IPv4 TCP connection and listener, with the process that holds it.
    pub(super) fn tcp_table() -> std::io::Result<Vec<Row>> {
        let mut size = 0u32;
        let mut buf: Vec<u64> = Vec::new();
        loop {
            // SAFETY: `buf` holds `size` bytes, 8-aligned as the table needs; Windows writes at most that many.
            let r = unsafe { GetExtendedTcpTable(buf.as_mut_ptr().cast(), &mut size, 0, AF_INET.into(), TCP_TABLE_OWNER_PID_ALL, 0) };
            match r {
                NO_ERROR => break,
                ERROR_INSUFFICIENT_BUFFER => buf = vec![0; (size as usize).div_ceil(8) + 1],
                e => return Err(Error::from_raw_os_error(e as i32)),
            }
        }
        let table = buf.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();
        // SAFETY: Windows filled `buf` with a table of `dwNumEntries` rows, which starts at `table`'s `table` field.
        let rows = unsafe {
            let first = std::ptr::addr_of!((*table).table).cast::<MIB_TCPROW_OWNER_PID>();
            std::slice::from_raw_parts(first, (*table).dwNumEntries as usize)
        };
        Ok(rows.iter().map(|r| Row::new(r.dwLocalAddr, r.dwLocalPort, r.dwRemoteAddr, r.dwRemotePort, r.dwOwningPid)).collect())
    }

    /// Each running process's parent, by id.
    fn parents() -> std::io::Result<HashMap<u32, u32>> {
        // SAFETY: plain Win32 calls on a snapshot handle this function owns and closes.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(Error::last_os_error());
            }
            let mut parents = HashMap::new();
            let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut more = Process32FirstW(snapshot, &mut entry) != 0;
            while more {
                parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                more = Process32NextW(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
            Ok(parents)
        }
    }

    /// When process `pid` started.
    fn opened(pid: u32) -> std::io::Result<u64> {
        // SAFETY: the handle is closed before returning.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return Err(Error::last_os_error());
            }
            let at = started(handle);
            CloseHandle(handle);
            at
        }
    }

    fn started(handle: HANDLE) -> std::io::Result<u64> {
        let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        // SAFETY: `handle` is a live process handle with at least limited query access.
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
            return Err(Error::last_os_error());
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::net::Ipv4Addr;

    fn raw_addr(a: [u8; 4]) -> u32 {
        u32::from_ne_bytes(a)
    }

    fn raw_port(p: u16) -> u32 {
        let [hi, lo] = p.to_be_bytes();
        u32::from_ne_bytes([hi, lo, 0, 0])
    }

    fn end(port: u16) -> SocketAddrV4 {
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)
    }

    #[test]
    fn a_row_reads_addresses_and_ports_in_network_byte_order() {
        let row = Row::new(raw_addr([127, 0, 0, 1]), raw_port(51234), raw_addr([10, 1, 2, 3]), raw_port(22), 4321);
        assert_eq!(row, Row { local: end(51234), remote: SocketAddrV4::new(Ipv4Addr::new(10, 1, 2, 3), 22), pid: 4321 });
    }

    #[test]
    fn the_far_end_is_the_row_that_mirrors_ours() {
        let rows = [
            Row { local: end(8022), remote: SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0), pid: 30 },
            Row { local: end(50001), remote: end(8022), pid: 10 },
            Row { local: end(8022), remote: end(50001), pid: 20 },
            Row { local: end(8022), remote: end(50002), pid: 40 },
        ];
        assert_eq!(far_end(&rows, end(50001), end(8022)), Some(20));
        assert_eq!(far_end(&rows, end(50003), end(8022)), None, "no row, no owner: a listener's own row doesn't count");
    }

    const SSH: SshProcess = SshProcess { pid: 100, started: 1_000 };

    fn processes(list: &[(u32, u32, u64)]) -> impl Fn(u32) -> Option<Process> {
        let map: HashMap<u32, Process> = list.iter().map(|&(pid, parent, started)| (pid, Process { parent, started })).collect();
        move |pid| map.get(&pid).copied()
    }

    /// ssh's readiness check connects before ssh accepts, so the far end's row must already name the listener.
    #[cfg(windows)]
    #[test]
    fn a_connection_not_yet_accepted_is_held_by_the_listeners_process() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let theirs = listener.local_addr().unwrap();
        let stream = std::net::TcpStream::connect(theirs).unwrap();
        let (std::net::SocketAddr::V4(ours), std::net::SocketAddr::V4(theirs)) = (stream.local_addr().unwrap(), theirs) else { unreachable!() };
        assert_eq!(far_end(&win::tcp_table().unwrap(), ours, theirs), Some(std::process::id()));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn check_lets_through_only_a_connection_ssh_holds() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let stream = tokio::net::TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        check(&stream, SshProcess { pid: std::process::id(), started: 0 }).expect("this process holds the listener");
        let refused = check(&stream, SshProcess { pid: u32::MAX - 3, started: 0 }).expect_err("another process holds it");
        assert_eq!(refused.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(refused.to_string().contains(&format!("process {}", std::process::id())), "{refused}");
    }

    #[test]
    fn ssh_itself_is_ssh() {
        assert!(started_by(100, SSH, processes(&[])));
    }

    #[test]
    fn the_real_ssh_a_shim_started_counts() {
        assert!(started_by(200, SSH, processes(&[(200, 100, 1_001)])));
        assert!(started_by(300, SSH, processes(&[(300, 200, 1_002), (200, 100, 1_001)])), "a shim that runs another shim");
    }

    #[test]
    fn another_program_does_not_count() {
        assert!(!started_by(500, SSH, processes(&[(500, 4, 10), (4, 0, 1)])));
    }

    #[test]
    fn a_program_older_than_ssh_that_names_ssh_s_id_as_its_parent_does_not_count() {
        // Its parent exited and Windows gave that id to the ssh started later.
        assert!(!started_by(500, SSH, processes(&[(500, 100, 999)])));
        assert!(!started_by(600, SSH, processes(&[(600, 200, 1_000), (200, 100, 1_001)])), "and so on up the line");
    }

    #[test]
    fn a_process_windows_cant_name_does_not_count() {
        assert!(!started_by(500, SSH, processes(&[])));
        assert!(!started_by(500, SSH, processes(&[(500, 200, 1_002)])), "nor one whose parent it can't name");
    }

    #[test]
    fn a_loop_of_parents_ends() {
        assert!(!started_by(500, SSH, processes(&[(500, 501, 5), (501, 500, 5)])));
    }

    #[test]
    fn the_real_ssh_may_be_only_so_many_shims_deep() {
        let mut list: Vec<(u32, u32, u64)> = (0..=MAX_DEPTH as u32).map(|i| (201 + i, 200 + i, 1_001 + u64::from(i))).collect();
        list.push((200, 100, 1_000));
        let deepest = 199 + MAX_DEPTH as u32;
        assert!(started_by(deepest, SSH, processes(&list)), "{MAX_DEPTH} steps from ssh");
        assert!(!started_by(deepest + 1, SSH, processes(&list)));
    }
}
