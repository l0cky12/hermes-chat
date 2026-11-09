//! WebKitGTK 2.54.0 and 2.54.1 crash the app when the owner pastes and nothing owns the clipboard (#360, ADR 0103).
//! GTK answers a request for the clipboard's targets with no atoms and a count of -1 then, and those WebKit releases
//! read -1 as a list of `usize::MAX` atoms. This executable exports its own `gtk_clipboard_request_targets`, which the
//! dynamic linker gives WebKit in place of GTK's: it asks GTK and passes the answer on with a count of at least 0, as
//! WebKit 2.54.2 does itself (WebKit commit 75cdc5a66f). The build script exports the symbol.

use gtk::ffi::{GtkClipboard, GtkClipboardTargetsReceivedFunc};
use gtk::gdk::ffi::GdkAtom;
use gtk::glib::ffi::gpointer;
use std::ffi::c_int;
use std::sync::OnceLock;

type RequestTargets = unsafe extern "C" fn(*mut GtkClipboard, GtkClipboardTargetsReceivedFunc, gpointer);
type TargetsReceived = unsafe extern "C" fn(*mut GtkClipboard, *mut GdkAtom, c_int, gpointer);

struct Request {
    received: TargetsReceived,
    user_data: gpointer,
}

/// GTK's own `gtk_clipboard_request_targets`, the next definition after this executable's.
fn gtk_request_targets() -> RequestTargets {
    static GTK: OnceLock<RequestTargets> = OnceLock::new();
    *GTK.get_or_init(|| {
        // SAFETY: a NUL-terminated name; RTLD_NEXT searches the libraries loaded after this executable.
        let symbol = unsafe { libc::dlsym(libc::RTLD_NEXT, c"gtk_clipboard_request_targets".as_ptr()) };
        assert!(!symbol.is_null(), "GTK has no gtk_clipboard_request_targets");
        // SAFETY: GTK's function, of this type.
        unsafe { std::mem::transmute::<*mut libc::c_void, RequestTargets>(symbol) }
    })
}

/// # Safety
/// GTK's contract for `gtk_clipboard_request_targets`: a valid clipboard, and `user_data` as `callback` expects it.
#[no_mangle]
pub unsafe extern "C" fn gtk_clipboard_request_targets(clipboard: *mut GtkClipboard, callback: GtkClipboardTargetsReceivedFunc, user_data: gpointer) {
    let Some(received) = callback else {
        return gtk_request_targets()(clipboard, None, user_data);
    };
    let request = Box::into_raw(Box::new(Request { received, user_data }));
    gtk_request_targets()(clipboard, Some(targets_received), request.cast());
}

/// GTK calls this once per request, with `atoms` null and `count` -1 when the targets can't be read.
unsafe extern "C" fn targets_received(clipboard: *mut GtkClipboard, atoms: *mut GdkAtom, count: c_int, request: gpointer) {
    let Request { received, user_data } = *Box::from_raw(request.cast::<Request>());
    received(clipboard, atoms, count.max(0), user_data);
}
