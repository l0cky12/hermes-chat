// A stand-in for the host frame in Vitest: it runs an extension's source in this realm with a fake `self` and a fake
// port pair whose messages arrive as microtasks. It tests the broker and the runtime, not the sandbox: the sandbox is
// tested in the real app (docs/research/extension-isolation/app-probe.js).
import type { Host, StartHost } from "./extensionHost";

type End = { onmessage: ((e: { data: unknown }) => void) | null; postMessage(d: unknown): void; closed: boolean };

function pair(): [End, End] {
  const a: End = { onmessage: null, closed: false, postMessage: (d) => void (!a.closed && !b.closed && queueMicrotask(() => b.onmessage?.({ data: d }))) };
  const b: End = { onmessage: null, closed: false, postMessage: (d) => void (!a.closed && !b.closed && queueMicrotask(() => a.onmessage?.({ data: d }))) };
  return [a, b];
}

export type FakeHosts = StartHost & { started: number; live: () => number; crash: (why: string) => void };

export function fakeHosts(): FakeHosts {
  const hosts: { removed: boolean; crash?: (why: string) => void }[] = [];
  const start = ((source: string): Host => {
    const [app, ext] = pair();
    const entry: { removed: boolean; crash?: (why: string) => void } = { removed: false };
    hosts.push(entry);
    const self: { onmessage: ((e: { ports: End[] }) => void) | null } = { onmessage: null };
    new Function("self", source)(self);
    queueMicrotask(() => self.onmessage?.({ ports: [ext] }));
    return {
      send: (text) => app.postMessage(text),
      onMessage: (cb) => void (app.onmessage = (e) => cb(e.data)),
      onCrash: (cb) => void (entry.crash = cb),
      remove: () => {
        entry.removed = true;
        app.closed = ext.closed = true;
      },
    };
  }) as FakeHosts;
  Object.defineProperty(start, "started", { get: () => hosts.length });
  start.live = () => hosts.filter((h) => !h.removed).length;
  start.crash = (why) => hosts.filter((h) => !h.removed).at(-1)?.crash?.(why);
  return start;
}
