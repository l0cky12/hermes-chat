use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Listening {
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ServerSide {
    Listed { ports: Vec<Listening> },
    NoSshTarget,
    NotConnected,
    Failed { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DevServers {
    pub server: ServerSide,
    pub local: Vec<Listening>,
}

const NOT_WEB: &[u16] = &[5432, 3306, 6379, 11211, 27017, 5672, 9092, 2181];
const NOT_DEV: &[&str] = &["ssh", "sshd"];
/// Where Linux hands out a port to a program that asks for any free one (`ip_local_port_range`): a listener from here
/// up is a tool's, such as a test driver or a tunnel's end, not a dev server someone started on its port.
const ANY_FREE_PORT: u16 = 32768;

pub fn plausible(l: &Listening, skip: &[u16]) -> bool {
    (1024..ANY_FREE_PORT).contains(&l.port)
        && !NOT_WEB.contains(&l.port)
        && !skip.contains(&l.port)
        && !l.process.as_deref().is_some_and(|p| NOT_DEV.contains(&p))
}

fn one_per_port(mut found: Vec<Listening>) -> Vec<Listening> {
    found.sort_by_key(|l| (l.port, l.process.is_none()));
    found.dedup_by_key(|l| l.port);
    found
}

pub fn parse_ss(out: &str) -> Vec<Listening> {
    let found = out
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            if fields.next()? != "LISTEN" {
                return None;
            }
            let local = fields.nth(2)?;
            let (host, port) = local.rsplit_once(':')?;
            let host = host.split('%').next()?.trim_start_matches('[').trim_end_matches(']');
            let reachable = matches!(host, "*" | "0.0.0.0" | "::" | "::1" | "::ffff:127.0.0.1") || host.starts_with("127.");
            let port = port.parse().ok().filter(|_| reachable)?;
            let process = line.split_once("users:((\"").and_then(|(_, rest)| rest.split_once('"')).map(|(name, _)| name.to_owned());
            Some(Listening { port, process })
        })
        .collect();
    one_per_port(found)
}

pub fn parse_proc_net_tcp(text: &str) -> Vec<(u16, u64)> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (address, port) = fields.get(1)?.split_once(':')?;
            if *fields.get(3)? != "0A" || !reachable_hex(address) {
                return None;
            }
            Some((u16::from_str_radix(port, 16).ok()?, fields.get(9)?.parse().ok()?))
        })
        .collect()
}

fn reachable_hex(address: &str) -> bool {
    let words: Option<Vec<[u8; 4]>> = (0..address.len() / 8).map(|i| u32::from_str_radix(&address[i * 8..i * 8 + 8], 16).ok().map(u32::to_le_bytes)).collect();
    match words.as_deref() {
        Some([v4]) => v4[0] == 127 || *v4 == [0; 4],
        Some([a, b, c, d]) => {
            let ip = std::net::Ipv6Addr::from(<[u8; 16]>::try_from([*a, *b, *c, *d].concat()).unwrap_or_default());
            ip.is_loopback() || ip.is_unspecified() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
        _ => false,
    }
}

#[cfg(target_os = "linux")]
pub fn local() -> Vec<Listening> {
    use std::collections::HashMap;
    let listeners: Vec<(u16, u64)> =
        ["/proc/net/tcp", "/proc/net/tcp6"].iter().filter_map(|p| std::fs::read_to_string(p).ok()).flat_map(|t| parse_proc_net_tcp(&t)).collect();
    let socket_inodes = |fd_dir: &std::path::Path| -> Vec<u64> {
        std::fs::read_dir(fd_dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|fd| std::fs::read_link(fd.path()).ok())
            .filter_map(|link| link.to_str()?.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok())
            .collect()
    };
    let own = socket_inodes(std::path::Path::new("/proc/self/fd"));
    let me = std::process::id().to_string();
    let mut owners: HashMap<u64, String> = HashMap::new();
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let pid = entry.file_name();
        if !pid.to_str().is_some_and(|p| p != me && p.bytes().all(|b| b.is_ascii_digit())) {
            continue;
        }
        let Ok(name) = std::fs::read_to_string(entry.path().join("comm")) else { continue };
        for inode in socket_inodes(&entry.path().join("fd")) {
            owners.entry(inode).or_insert_with(|| name.trim().to_owned());
        }
    }
    one_per_port(
        listeners.into_iter().filter(|(_, inode)| !own.contains(inode)).map(|(port, inode)| Listening { port, process: owners.get(&inode).cloned() }).collect(),
    )
}

#[cfg(not(target_os = "linux"))]
pub fn local() -> Vec<Listening> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(port: u16, process: Option<&str>) -> Listening {
        Listening { port, process: process.map(str::to_owned) }
    }

    #[test]
    fn reads_ss_on_loopback_and_every_address() {
        // iproute2 6.x, `ss -ltnpH` as a user: other users' sockets have no users field.
        let out = "\
LISTEN 0      511        127.0.0.1:5173       0.0.0.0:*    users:((\"node\",pid=4242,fd=20))
LISTEN 0      4096         0.0.0.0:8000       0.0.0.0:*    users:((\"uvicorn\",pid=77,fd=3),(\"uvicorn\",pid=78,fd=3))
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*
LISTEN 0      511            [::1]:5173          [::]:*    users:((\"node\",pid=4242,fd=21))
LISTEN 0      511             [::]:3000          [::]:*
LISTEN 0      511                *:9000             *:*
LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*
LISTEN 0      511      192.168.1.5:4000       0.0.0.0:*    users:((\"node\",pid=9,fd=1))
LISTEN 0      511 [fe80::1%eth0]:4001          [::]:*
";
        assert_eq!(parse_ss(out), vec![at(22, None), at(53, None), at(3000, None), at(5173, Some("node")), at(8000, Some("uvicorn")), at(9000, None)]);
        assert_eq!(parse_ss(""), vec![]);
    }

    #[test]
    fn reads_proc_net_tcp_listeners_on_loopback_and_every_address() {
        let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 101 1 0000000000000000 100 0 0 10 0
   1: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 102 1 0000000000000000 100 0 0 10 0
   2: 0501A8C0:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 103 1 0000000000000000 100 0 0 10 0
   3: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 104 1 0000000000000000 20 4 30 10 -1
";
        assert_eq!(parse_proc_net_tcp(tcp), vec![(5173, 101), (8000, 102)]);
        let tcp6 = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 201 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 202 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:0FA1 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 203 1 0000000000000000 100 0 0 10 0
   3: 000080FE00000000FF0F02A0EFBE0000:0FA2 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 204 1 0000000000000000 100 0 0 10 0
";
        assert_eq!(parse_proc_net_tcp(tcp6), vec![(3000, 201), (9000, 202), (4001, 203)]);
    }

    #[test]
    fn lists_only_what_could_be_a_dev_server() {
        let dashboard = [9119];
        assert!(plausible(&at(5173, Some("node")), &dashboard));
        assert!(plausible(&at(8000, None), &dashboard));
        assert!(plausible(&at(32767, Some("node")), &dashboard));
        for no in [
            at(22, None),
            at(80, Some("nginx")),
            at(5432, Some("postgres")),
            at(6379, None),
            at(9119, None),
            at(2222, Some("sshd")),
            at(32768, Some("node")),
            at(56817, Some("WebKitWebDriver")),
        ] {
            assert!(!plausible(&no, &dashboard), "{no:?}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn finds_another_programs_server_here_but_not_its_own() {
        let own = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let own_port = own.local_addr().unwrap().port();
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut server = std::process::Command::new("python3")
            .args(["-c", &format!("import socket,time; s=socket.socket(); s.bind(('127.0.0.1',{free})); s.listen(); print(flush=True); time.sleep(30)")])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("python3");
        let mut ready = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(server.stdout.as_mut().unwrap()), &mut ready).unwrap();
        let found = local();
        let _ = server.kill();
        let _ = server.wait();
        assert!(!found.iter().any(|l| l.port == own_port), "this process's own socket is left out: {found:?}");
        assert!(found.contains(&at(free, Some("python3"))), "the other program's server is named: {found:?}");
    }
}
