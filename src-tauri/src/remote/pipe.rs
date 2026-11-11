//! A named pipe carries requests on Windows. The first Hermes Chat creates the pipe with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE`, which Windows grants to exactly one creator, so of two launches at once only one
//! opens a window. Each request is one JSON line (remote.rs `encode`); the answer is `ok` or `error: why`.
//!
//! The pipe's default security lets only its creator's account (and the system and administrators) write to it, and
//! remote clients are refused, so another user can't send this app anything.
//!
//! The name is no secret, though, so another account's program can make the pipe first and be handed every launch's
//! request, a chat link among them, while Hermes Chat never starts (#492). So a launch that finds the name taken asks
//! Windows which process made the pipe, before it writes anything, and hands its request over only if that process
//! runs as this account. Otherwise it sends nothing and starts.

use super::{decode, encode, pipe_name, Inbox, Request, WIRE_MAX};
use crate::loopback_peer::runs_as_this_account;
use std::io;
use std::os::windows::io::AsRawHandle;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;

const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_PIPE_BUSY: i32 = 231;
const ANSWER_WITHIN: Duration = Duration::from_secs(5);
/// How often a queued Hermes Chat looks whether the one before it has exited.
const QUEUE_POLL: Duration = Duration::from_secs(1);

fn name() -> String {
    let var = |v: &str| std::env::var(v).unwrap_or_default();
    pipe_name(&var("USERDOMAIN"), &var("USERNAME"), &var("SESSIONNAME"))
}

fn listener(name: &str, first: bool) -> io::Result<NamedPipeServer> {
    ServerOptions::new().first_pipe_instance(first).reject_remote_clients(true).max_instances(8).create(name)
}

/// The pipe is another program's: a Hermes Chat's, as a rule (or, with an open one gone, briefly no one's).
fn taken(e: &io::Error) -> bool {
    e.raw_os_error() == Some(ERROR_ACCESS_DENIED)
}

pub(super) fn hand_over(request: Option<Request>, inbox: &'static Inbox) -> bool {
    let name = name();
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("hermes-chat: no runtime for the request pipe, so shortcuts won't reach this window: {e}");
            return false;
        }
    };
    let claimed = {
        let _in = runtime.enter();
        listener(&name, true)
    };
    match claimed {
        Ok(server) => {
            std::thread::spawn(move || runtime.block_on(serve(server, name, inbox)));
        }
        Err(e) if taken(&e) => {
            if let Some(request) = request {
                match runtime.block_on(send(&name, &request, runs_as_this_account)) {
                    Ok(()) => return true,
                    Err(e) => eprintln!("hermes-chat: the request wasn't handed over on {name} ({e}), so this one starts too"),
                }
            }
            std::thread::spawn(move || runtime.block_on(queue(name, inbox)));
        }
        Err(e) => eprintln!("hermes-chat: couldn't open {name}, so shortcuts and links won't reach this window: {e}"),
    }
    false
}

/// Waits for the pipe's holder to exit, as the Hermes Chat before this one does after an update's restart, then
/// answers requests itself. It only ever tries to make the pipe, so a holder that isn't this account's is sent nothing,
/// and this window gets the name once that program is gone.
async fn queue(name: String, inbox: &'static Inbox) {
    eprintln!("hermes-chat: {name} is taken; shortcuts and links reach this window once its holder closes");
    loop {
        match listener(&name, true) {
            Ok(server) => return serve(server, name, inbox).await,
            Err(e) if taken(&e) => tokio::time::sleep(QUEUE_POLL).await,
            Err(e) => return eprintln!("hermes-chat: couldn't open {name}: {e}"),
        }
    }
}

/// Answers each caller in turn. A new instance of the pipe is made before the connected one is answered, so there is
/// always one waiting and no second app can claim the name in between.
async fn serve(mut server: NamedPipeServer, name: String, inbox: &'static Inbox) {
    loop {
        let connected = server.connect().await;
        let next = match listener(&name, false) {
            Ok(next) => next,
            Err(e) => return eprintln!("hermes-chat: shortcuts and links stopped reaching this window: {e}"),
        };
        let caller = std::mem::replace(&mut server, next);
        match connected {
            Ok(()) => drop(tokio::spawn(answer(caller, inbox))),
            Err(e) => eprintln!("hermes-chat: a request on the pipe failed: {e}"),
        }
    }
}

async fn answer(pipe: NamedPipeServer, inbox: &'static Inbox) {
    let mut reader = BufReader::new(pipe);
    let mut line = String::new();
    let read = tokio::time::timeout(ANSWER_WITHIN, (&mut reader).take(WIRE_MAX as u64 + 1).read_line(&mut line)).await;
    let reply = match read {
        Ok(Ok(_)) => match decode(&line) {
            Ok(request) => {
                inbox.dispatch(request);
                "ok\n".to_owned()
            }
            Err(why) => format!("error: {why}\n"),
        },
        _ => return,
    };
    let mut pipe = reader.into_inner();
    if pipe.write_all(reply.as_bytes()).await.is_err() || pipe.flush().await.is_err() {
        return;
    }
    // Closing at once could drop the reply before the caller reads it; the caller closes once it has.
    let mut rest = [0u8; 64];
    let _ = tokio::time::timeout(ANSWER_WITHIN, pipe.read(&mut rest)).await;
}

/// The process that made the pipe `pipe` is connected to.
fn holder(pipe: &NamedPipeClient) -> io::Result<u32> {
    let mut pid = 0u32;
    // SAFETY: `pipe` keeps the handle open for the call, which writes only to `pid`.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(pid)
}

/// Asks the running app, if `ours` says the process holding the pipe is this account's. An error when it isn't, or
/// can't be told, with nothing written; and when none answers.
async fn send(name: &str, request: &Request, ours: impl Fn(u32) -> bool) -> io::Result<()> {
    let deadline = Instant::now() + ANSWER_WITHIN;
    let pipe = loop {
        match ClientOptions::new().open(name) {
            Ok(pipe) => break pipe,
            // Every instance is busy, or the old one was just answered and its next isn't up yet.
            Err(e) if matches!(e.raw_os_error(), Some(ERROR_PIPE_BUSY | ERROR_FILE_NOT_FOUND)) && Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Err(e) => return Err(e),
        }
    };
    let holder = holder(&pipe).map_err(|e| io::Error::new(io::ErrorKind::PermissionDenied, format!("couldn't tell which program holds the pipe: {e}")))?;
    if !ours(holder) {
        let why = format!("process {holder} holds the pipe, and it isn't this account's or couldn't be checked");
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, why));
    }
    let exchange = async {
        let mut reader = BufReader::new(pipe);
        reader.get_mut().write_all(format!("{}\n", encode(request)).as_bytes()).await?;
        reader.get_mut().flush().await?;
        let mut reply = String::new();
        (&mut reader).take(4096).read_line(&mut reply).await?;
        Ok::<_, io::Error>(reply)
    };
    let reply = tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), exchange)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "no answer in time"))??;
    match reply.trim_end().strip_prefix("error: ") {
        None if reply.trim_end() == "ok" => Ok(()),
        None => Err(io::Error::other(format!("an answer that isn't one: {reply:?}"))),
        Some(why) => Err(io::Error::other(why.to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn unique(test: &str) -> String {
        format!(r"\\.\pipe\net.l0cky12.HermesChat-test-{test}-{}", std::process::id())
    }

    /// A Hermes Chat answering on `name`, and the requests it is handed.
    fn running(name: &str) -> mpsc::Receiver<Request> {
        let inbox: &'static Inbox = Box::leak(Box::default());
        let (tx, rx) = mpsc::channel();
        inbox.set_handler(move |request| {
            let _ = tx.send(request);
        });
        tokio::spawn(serve(listener(name, true).unwrap(), name.to_owned(), inbox));
        rx
    }

    #[test]
    fn this_process_runs_as_this_account_and_the_system_process_doesnt() {
        assert!(runs_as_this_account(std::process::id()));
        // Process 4 is System, which runs as LocalSystem.
        assert!(!runs_as_this_account(4));
    }

    #[tokio::test]
    async fn a_request_is_handed_to_the_hermes_chat_this_account_runs() {
        let name = unique("ours");
        let got = running(&name);
        let request = Request::OpenLink { link: "hermes-chat://chat?v=1&connection=abcdefghijklmnopqrst&profile=default&id=c1".into(), token: None };
        send(&name, &request, runs_as_this_account).await.unwrap();
        assert_eq!(got.try_recv(), Ok(request));
    }

    #[tokio::test]
    async fn nothing_is_written_to_a_pipe_another_account_holds() {
        let name = unique("theirs");
        let squatter = listener(&name, true).unwrap();
        let read = tokio::spawn(async move {
            // The launch has come and gone without a word by now, so connecting and reading may each fail: either way
            // nothing was read.
            let _ = squatter.connect().await;
            let mut line = String::new();
            let _ = tokio::time::timeout(ANSWER_WITHIN, BufReader::new(squatter).read_line(&mut line)).await;
            line
        });
        let err = send(&name, &Request::Screenshot, |_| false).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "{err}");
        assert_eq!(read.await.unwrap(), "");
    }
}
