//! The steps of opening a connection, in the order they run (#270, ADR 0033). The webview records which step each
//! attempt reached and how long each took (src/hermes/attempts.ts `STEPS`, which a test holds to this list). Each step
//! runs through `Steps::run`, its time limit for one of several routes (`transport::StepLimits`, #269) inside it.
use std::future::Future;
use std::time::Instant;

use serde::{Deserialize, Serialize};

/// One step. `Resolve` is a URL route's DNS lookup and `Tunnel` an SSH route's tunnel; a route runs one or the other.
/// `Ready` is the wait for `gateway.ready`, which runs in the webview; Rust never reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    Keyring,
    Resolve,
    Tunnel,
    Status,
    SignIn,
    Ticket,
    #[serde(rename = "websocket")]
    WebSocket,
    Ready,
}

/// A step starting, `at` ms after the connection began opening. The webview's messages can arrive after the command's
/// answer, so each carries its own time: a late one still goes in its place, with the right durations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Started {
    pub step: Step,
    pub at: u64,
}

/// Told each step as it starts.
type Report = Box<dyn Fn(Started) + Send + Sync>;

/// Where a connection being opened says which step it starts. Setup's test and route checks report nowhere.
#[derive(Default)]
pub struct Steps(Option<(Instant, Report)>);

impl Steps {
    /// Reports to `to`, timing each step from now.
    pub fn reporting(to: impl Fn(Started) + Send + Sync + 'static) -> Self {
        Steps(Some((Instant::now(), Box::new(to))))
    }

    /// Runs one step: says it started, then runs it.
    pub async fn run<F: Future>(&self, step: Step, fut: F) -> F::Output {
        if let Some((began, report)) = &self.0 {
            report(Started { step, at: u64::try_from(began.elapsed().as_millis()).unwrap_or(u64::MAX) });
        }
        fut.await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock::Locked;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn run_reports_the_step_before_it_runs() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let steps = Steps::reporting(move |s| log.locked().push(format!("start {:?}", s.step)));
        let inner = seen.clone();
        let got = steps
            .run(Step::Status, async move {
                inner.locked().push("ran".into());
                7
            })
            .await;
        assert_eq!(got, 7);
        assert_eq!(*seen.locked(), ["start Status", "ran"]);
        assert_eq!(Steps::default().run(Step::Ticket, async { 1 }).await, 1);
    }

    #[test]
    fn names_are_the_webviews() {
        let names: Vec<String> = [Step::Keyring, Step::Resolve, Step::Tunnel, Step::Status, Step::SignIn, Step::Ticket, Step::WebSocket, Step::Ready]
            .iter()
            .map(|s| serde_json::to_value(s).unwrap().as_str().unwrap().to_owned())
            .collect();
        assert_eq!(names, ["keyring", "resolve", "tunnel", "status", "sign-in", "ticket", "websocket", "ready"]);
    }
}
