//! The still of a page in the Preview on Windows (ADR 0094). The page is a sandboxed frame in the app's own webview
//! (ADR 0007), so WebView2 captures the whole webview and the frame's box is cut from it (`annotate::frame_still`).

use crate::annotate::{self, AnnotateError, Rect, Still, Viewport};
use crate::screenshot::Captures;
use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use webview2_com::CapturePreviewCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Controller, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG};
use windows::Win32::Foundation::E_OUTOFMEMORY;
use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
use windows::Win32::UI::Shell::SHCreateMemStream;

/// How long the capture may take.
const STILL_WITHIN: Duration = Duration::from_secs(3);

type Sent = tokio::sync::oneshot::Sender<Result<Vec<u8>, AnnotateError>>;

pub async fn take(app: &tauri::AppHandle, url: String, rect: Rect, viewport: Viewport, captures: Arc<Captures>) -> Result<Still, AnnotateError> {
    crate::web_page::web_url(&url).map_err(AnnotateError::Failed)?;
    let window = app.get_webview_window("main").ok_or(AnnotateError::NoPage)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.with_webview(move |webview| capture(&webview.controller(), tx)).map_err(|e| AnnotateError::Failed(e.to_string()))?;
    let png = match tokio::time::timeout(STILL_WITHIN, rx).await {
        Ok(Ok(png)) => png?,
        _ => return Err(AnnotateError::NoAnswer),
    };
    let taken_at_ms = annotate::now_ms();
    tokio::task::spawn_blocking(move || annotate::frame_still(&captures, &png, url, rect, viewport, taken_at_ms))
        .await
        .map_err(|e| AnnotateError::Failed(e.to_string()))?
}

fn failed(e: &windows::core::Error) -> AnnotateError {
    AnnotateError::Failed(format!("Couldn't take a still of the page: {}", e.message()))
}

/// Starts WebView2's capture of the webview into a memory stream. Runs on the main thread, where the completion
/// handler also runs.
fn capture(controller: &ICoreWebView2Controller, tx: Sent) {
    let tx = Rc::new(Cell::new(Some(tx)));
    let send = |tx: &Cell<Option<Sent>>, png: Result<Vec<u8>, AnnotateError>| {
        if let Some(tx) = tx.take() {
            let _ = tx.send(png);
        }
    };
    let started = (|| -> windows::core::Result<()> {
        let webview = unsafe { controller.CoreWebView2()? };
        // It gives no stream only when memory runs out, and sets no last error.
        let stream = unsafe { SHCreateMemStream(None) }.ok_or_else(|| windows::core::Error::from_hresult(E_OUTOFMEMORY))?;
        let (into, done) = (stream.clone(), tx.clone());
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            send(&done, result.and_then(|()| unsafe { read_all(&into) }).map_err(|e| failed(&e)));
            Ok(())
        }));
        unsafe { webview.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler) }
    })();
    if let Err(e) = started {
        send(&tx, Err(failed(&e)));
    }
}

unsafe fn read_all(stream: &IStream) -> windows::core::Result<Vec<u8>> {
    stream.Seek(0, STREAM_SEEK_SET, None)?;
    let mut bytes = Vec::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let mut read = 0u32;
        stream.Read(buffer.as_mut_ptr().cast(), buffer.len() as u32, Some(&mut read)).ok()?;
        if read == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buffer[..read as usize]);
    }
}
