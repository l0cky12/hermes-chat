//! Reading the text selected or copied in another app, through GTK's real clipboards on an X display (ADR 0172). The
//! selections are owned by this process here; GTK reads them the same way as another app's.
#![cfg(target_os = "linux")]

use hermes_chat::selection::{text_of, PASSWORD_HINT};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

/// What `text_of` gives for `selection`, once GTK answers.
fn read(selection: &gtk::gdk::Atom) -> Option<String> {
    let answer: Rc<RefCell<Option<Option<String>>>> = Rc::default();
    let into = answer.clone();
    text_of(&gtk::Clipboard::get(selection), move |t| *into.borrow_mut() = Some(t));
    let end = Instant::now() + Duration::from_secs(10);
    while answer.borrow().is_none() {
        assert!(Instant::now() < end, "timed out waiting for the selection");
        gtk::main_iteration_do(false);
        std::thread::sleep(Duration::from_millis(5));
    }
    answer.take().unwrap()
}

#[test]
#[ignore = "takes the selections of the X display it runs on: xvfb-run -a cargo test --test selection -- --ignored"]
fn reads_selected_and_copied_text_but_never_a_password_or_blank() {
    gtk::gdk::set_allowed_backends("x11");
    gtk::init().expect("an X display");
    let primary = gtk::Clipboard::get(&gtk::gdk::SELECTION_PRIMARY);
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);

    primary.set_text("error: disk full\n  at /var/log");
    clipboard.set_text("https://ci.example/run/42");
    assert_eq!(read(&gtk::gdk::SELECTION_PRIMARY).as_deref(), Some("error: disk full\n  at /var/log"));
    assert_eq!(read(&gtk::gdk::SELECTION_CLIPBOARD).as_deref(), Some("https://ci.example/run/42"));

    // A password manager's copy: text, marked with the hint KeePassXC and Klipper use.
    let targets = [gtk::TargetEntry::new("UTF8_STRING", gtk::TargetFlags::empty(), 0), gtk::TargetEntry::new(PASSWORD_HINT, gtk::TargetFlags::empty(), 1)];
    assert!(clipboard.set_with_data(&targets, |_, data, info| {
        if info == 0 {
            data.set_text("hunter2");
        } else {
            data.set(&gtk::gdk::Atom::intern(PASSWORD_HINT), 8, b"secret");
        }
    }));
    assert_eq!(read(&gtk::gdk::SELECTION_CLIPBOARD), None, "a copied password is never read as a selection");

    primary.set_text("   \n ");
    assert_eq!(read(&gtk::gdk::SELECTION_PRIMARY), None, "blank text is no selection");
    primary.clear();
    clipboard.clear();
    assert_eq!(read(&gtk::gdk::SELECTION_PRIMARY), None, "nothing owns it");
    assert_eq!(read(&gtk::gdk::SELECTION_CLIPBOARD), None);
}
