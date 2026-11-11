//! What the owner sent that is still waiting to be written, for the queues that can't drop or reorder it: a terminal's
//! input (terminal.rs) and the Screen's (display.rs). A program or server that stops reading would otherwise let it
//! grow without end, so past a budget a send is refused, and the caller says so.

use std::sync::atomic::{AtomicUsize, Ordering};

/// The input of one terminal or screen that hasn't been written yet, in bytes.
pub struct Backlog {
    waiting: AtomicUsize,
    budget: usize,
}

impl Backlog {
    pub const fn new(budget: usize) -> Self {
        Backlog { waiting: AtomicUsize::new(0), budget }
    }

    /// Counts `len` more bytes as waiting, unless that would take what waits past the budget. One send larger than the
    /// budget is still taken when nothing waits, so a single big paste goes. False: refused, and nothing counted.
    pub fn take(&self, len: usize) -> bool {
        let more = |waiting: usize| (waiting == 0 || waiting.saturating_add(len) <= self.budget).then(|| waiting.saturating_add(len));
        self.waiting.fetch_update(Ordering::SeqCst, Ordering::SeqCst, more).is_ok()
    }

    /// `len` bytes counted by `take` have been written.
    pub fn written(&self, len: usize) {
        self.waiting.fetch_sub(len, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_up_to_the_budget_and_one_bigger_send_only_when_nothing_waits() {
        let b = Backlog::new(10);
        assert!(b.take(6));
        assert!(b.take(4), "exactly the budget");
        assert!(!b.take(1), "past the budget");
        b.written(10);
        assert!(b.take(25), "one send bigger than the budget, with nothing waiting");
        assert!(!b.take(1), "nothing more while it waits");
        b.written(25);
        assert!(b.take(1));
    }
}
