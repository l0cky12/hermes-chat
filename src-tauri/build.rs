fn main() {
    let mut windows = tauri_build::WindowsAttributes::new();
    // tauri-build links its manifest into the app's exe only. Test exes need Common Controls v6 too, or Windows
    // refuses to start them (STATUS_ENTRYPOINT_NOT_FOUND) once a test builds a Tauri app, so the linker embeds the
    // same manifest (tauri-build's default) into every exe of this package.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    // gtk_clipboard.rs: WebKitGTK's call to gtk_clipboard_request_targets reaches the executable's own definition only
    // if the executable links and exports it. Nothing in the app calls it, so the linker has to be told to keep it.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,--undefined=gtk_clipboard_request_targets");
        println!("cargo:rustc-link-arg=-Wl,--export-dynamic-symbol=gtk_clipboard_request_targets");
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri-build failed");
}
