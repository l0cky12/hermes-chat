//! Pasting when nothing owns the clipboard (#360). WebKitGTK 2.54.0 and 2.54.1 read GTK's "no targets" answer
//! (`NULL`, -1) as a huge list and crashed the app on Ctrl+V; `gtk_clipboard.rs` hands WebKit a count of 0 instead.
#![cfg(target_os = "linux")]

// Linked for its `gtk_clipboard_request_targets`, which nothing here names.
extern crate hermes_chat;

use gtk::ffi::{GtkClipboard, GtkClipboardTargetsReceivedFunc};
use gtk::glib::ffi::gpointer;
use gtk::prelude::*;
use std::cell::Cell;
use std::time::{Duration, Instant};
use webkit2gtk::WebViewExt;

fn spin_until(what: &str, deadline: Duration, mut done: impl FnMut() -> bool) {
    let end = Instant::now() + deadline;
    while !done() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        gtk::main_iteration_do(false);
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// The targets of `selection` as WebKit gets them: through `gtk_clipboard_request_targets` as the dynamic linker
/// resolves it for a shared library, not as this crate links it.
fn targets_as_webkit_reads_them(selection: &str) -> (bool, i32) {
    type Request = unsafe extern "C" fn(*mut GtkClipboard, GtkClipboardTargetsReceivedFunc, gpointer);
    unsafe extern "C" fn received(_: *mut GtkClipboard, atoms: *mut gtk::gdk::ffi::GdkAtom, count: i32, answer: gpointer) {
        (*(answer as *const Cell<Option<(bool, i32)>>)).set(Some((atoms.is_null(), count)));
    }
    // SAFETY: the symbol is GTK's function of this type, or this crate's stand-in with the same signature.
    let request: Request = unsafe {
        let symbol = libc::dlsym(libc::RTLD_DEFAULT, c"gtk_clipboard_request_targets".as_ptr());
        assert!(!symbol.is_null(), "gtk_clipboard_request_targets isn't loaded");
        std::mem::transmute::<*mut libc::c_void, Request>(symbol)
    };
    let clipboard = gtk::Clipboard::get(&gtk::gdk::Atom::intern(selection));
    let answer = Cell::new(None);
    // SAFETY: `answer` outlives the request, which is answered before `spin_until` returns.
    unsafe { request(clipboard.as_ptr(), Some(received), &answer as *const _ as gpointer) };
    spin_until("the targets", Duration::from_secs(10), || answer.get().is_some());
    answer.get().unwrap()
}

#[test]
#[ignore = "empties the clipboard of the X display it runs on: xvfb-run -a cargo test --test clipboard -- --ignored"]
fn pasting_with_no_clipboard_owner_pastes_nothing_and_keeps_running() {
    gtk::gdk::set_allowed_backends("x11");
    gtk::init().expect("an X display");

    let (no_atoms, count) = targets_as_webkit_reads_them(&format!("HERMES_CHAT_TEST_UNOWNED_{}", std::process::id()));
    assert!(no_atoms, "nothing owns the selection, so there are no targets");
    assert_eq!(count, 0, "a request for the targets of an unowned selection answers with a count of 0, never -1");

    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    clipboard.set_text("taken so it can be let go");
    clipboard.clear();
    assert_eq!(targets_as_webkit_reads_them("CLIPBOARD"), (true, 0), "the clipboard has no owner");

    let view = webkit2gtk::WebView::new();
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.add(&view);
    window.show_all();
    view.load_html(r#"<textarea autofocus>before</textarea>"#, None);
    let loaded = std::rc::Rc::new(Cell::new(false));
    view.connect_load_changed({
        let loaded = loaded.clone();
        move |_, event| loaded.set(loaded.get() || event == webkit2gtk::LoadEvent::Finished)
    });
    spin_until("the page", Duration::from_secs(30), || loaded.get());

    // The page's answer comes back as its title.
    let asked = Cell::new(0);
    let ask = |script: &str| {
        asked.set(asked.get() + 1);
        let tag = format!("{}:", asked.get());
        view.evaluate_javascript(&format!("document.title = '{tag}' + ({script})"), None, None, gtk::gio::Cancellable::NONE, |_| {});
        spin_until(script, Duration::from_secs(10), || view.title().is_some_and(|t| t.starts_with(&tag)));
        view.title().unwrap()[tag.len()..].to_string()
    };
    assert_eq!(ask("(document.querySelector('textarea').focus(), document.activeElement.tagName)"), "TEXTAREA");
    let paste = || {
        view.execute_editing_command("Paste");
        let settle = Instant::now() + Duration::from_secs(2);
        spin_until("the paste to settle", Duration::from_secs(5), || Instant::now() >= settle);
        ask("document.querySelector('textarea').value")
    };
    assert_eq!(paste(), "before", "an empty clipboard pastes nothing");

    clipboard.set_text("pasted, ");
    assert_eq!(paste(), "pasted, before", "the same paste with text on the clipboard pastes it");
}
