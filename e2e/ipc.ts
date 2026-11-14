import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const host = window.parent as Window & { e2eInvoke: (cmd: string, args: unknown) => Promise<unknown> };
mockWindows("main");
mockIPC((cmd, args) => host.e2eInvoke(cmd, args), { shouldMockEvents: true });
