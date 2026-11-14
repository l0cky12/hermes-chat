// Runs before the app's own entry in each test's app frame (ADR 0163): every Rust command goes to the test's fake Rust
// side in the parent page.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const host = window.parent as Window & { e2eInvoke: (cmd: string, args: unknown) => Promise<unknown> };
mockWindows("main");
mockIPC((cmd, args) => host.e2eInvoke(cmd, args), { shouldMockEvents: true });
