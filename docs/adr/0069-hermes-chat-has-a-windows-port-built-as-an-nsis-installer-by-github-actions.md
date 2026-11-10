# Hermes Chat has a Windows port, built as an NSIS installer by GitHub Actions

Hermes Chat began as a Linux-only app (D-Bus, GTK, X11, WebKitGTK, `std::os::unix`). The owner asked for a full Windows port with an NSIS installer, built on a `windows-latest` runner because a Linux box cannot properly build Tauri for Windows.

## Decisions

- **Linux-only dependencies sit under `cfg(target_os = "linux")` in `Cargo.toml`.** `keyring` uses `windows-native` on Windows. New Windows-only dependencies: `portable-pty` (ConPTY), `windows-sys`, and `windows` (toasts).
- **Each platform difference lives in one small seam per module**, not in scattered `cfg` blocks. Pure logic stays ungated and is tested on both platforms.
- **One instance and `--show`, `--toggle` and chat links**: on Windows the first copy owns a per-user named pipe that later launches send one JSON line to. On Linux it is still the session bus (`remote/bus.rs`, `remote/pipe.rs`).
- **Tray, notifications**: Tauri's tray shows directly on Windows. Notifications are WinRT toasts under the app id `net.l0cky12.hermes-chat`.
- **ssh**: Windows OpenSSH has no Unix sockets, so there is no ControlMaster, and the Server page tunnel listens on a loopback port. The Repository helper (ADR 0110) goes on ssh's stdin as one base64 line ahead of the request, because Windows caps a command line at 32,767 characters.
- **Terminal**: ConPTY through `portable-pty`. The local shell is Windows PowerShell, else `%ComSpec%`.
- **Screenshots**: a small picker run by Windows PowerShell with Windows Forms. Private folders rely on the default user-profile ACL.
- **Credentials**: Credential Manager holds at most 2560 bytes, so a long secret is split over `<account>`, `<account>#2`, and so on.
- **Updates**: a Windows copy is updated by running a newer installer. It reports `unmanaged` with `installer: "nsis"`.
- **Chat links**: the NSIS installer registers `hermes-chat:` under the current user's registry classes (`src-tauri/windows/installer-hooks.nsh`).
- **The build**: `.github/workflows/windows.yml` runs `cargo test --lib` and `tauri build --bundles nsis` on `windows-latest` and uploads the `.exe` as an artifact. `tauri.windows.conf.json` turns bundling on only for Windows.

## Known limits

The installer is unsigned, so Windows SmartScreen warns on first run. Windows code was compile-checked from Linux. The Windows job runs the Rust unit tests and the build; `windows-smoke.yml` (`workflow_dispatch`) drives a real sign-in and send through the built app's WebView2 against the stand-in dashboard, with screenshots and the page's errors as artifacts (#308).
