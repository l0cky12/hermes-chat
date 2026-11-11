//! How every `std::sync::Mutex` here is taken (#491). A panic while one is held poisons it, and `lock().unwrap()`
//! would then panic in every later caller, so one bug in one command would break every command that shares the lock.
//! What these locks guard (handles, maps of open sockets and terminals, settings read back from disk) is left whole by
//! a panic between statements, so the next caller takes it as it was left, the way a task's panic in tokio fails only
//! that task. `clippy.toml` refuses `Mutex::lock` anywhere else.

use std::sync::{Mutex, MutexGuard, PoisonError};

pub trait Locked<T: ?Sized> {
    /// The guard, whether or not an earlier holder panicked.
    fn locked(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> Locked<T> for Mutex<T> {
    #[allow(clippy::disallowed_methods)]
    fn locked(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lock_whose_holder_panicked_is_taken_as_it_was_left() {
        let m = std::sync::Arc::new(Mutex::new(vec![1]));
        let held = m.clone();
        let panicked = std::thread::spawn(move || {
            let mut v = held.locked();
            v.push(2);
            panic!("a bug while holding the lock");
        })
        .join();
        assert!(panicked.is_err());
        assert!(m.is_poisoned());
        assert_eq!(*m.locked(), vec![1, 2]);
        m.locked().push(3);
        assert_eq!(*m.locked(), vec![1, 2, 3]);
    }
}
