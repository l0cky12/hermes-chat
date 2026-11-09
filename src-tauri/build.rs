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
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri-build failed");
}
