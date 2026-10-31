//! SSH local forward to the dashboard on the server's loopback, using the system `ssh` so the
//! owner's ~/.ssh/config, agent and keys apply (ADR 0003; research doc §9 "SSH mode").

use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};

const READY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error)]
pub enum TunnelError {
    #[error("Enter an SSH target such as liam@hermes or a host alias from ~/.ssh/config.")]
    BadTarget,
    #[error("Couldn't start ssh: {0}")]
    Spawn(String),
    #[error("SSH failed: {0}")]
    Ssh(String),
    #[error("SSH didn't open the tunnel within {}s.", READY_TIMEOUT.as_secs())]
    Timeout,
}

/// A running `ssh -N -L`. Dropping it kills ssh.
pub struct Tunnel {
    _child: Child,
    pub local_port: u16,
}

pub async fn open(target: &str, remote_port: u16) -> Result<Tunnel, TunnelError> {
    let target = target.trim();
    // A leading '-' would be read as an ssh option.
    if target.is_empty() || target.starts_with('-') || target.contains(char::is_whitespace) {
        return Err(TunnelError::BadTarget);
    }
    let local_port = free_port().await.map_err(|e| TunnelError::Spawn(e.to_string()))?;
    let mut child = Command::new("ssh")
        .args([
            "-N",
            "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=15",
            "-o", "StrictHostKeyChecking=accept-new",
            "-L", &format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
            "--", target,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| TunnelError::Spawn(e.to_string()))?;

    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(_status) = child.try_wait().map_err(|e| TunnelError::Spawn(e.to_string()))? {
            let mut err = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                let _ = stderr.read_to_string(&mut err).await;
            }
            return Err(TunnelError::Ssh(err.trim().to_owned()));
        }
        if TcpStream::connect(("127.0.0.1", local_port)).await.is_ok() {
            return Ok(Tunnel { _child: child, local_port });
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(TunnelError::Timeout);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0)).await?.local_addr()?.port())
}
