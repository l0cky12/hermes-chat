// Only the owner drives the Preview (ADR 0103). Hermes reaches this app only through the transport, which answers its
// `preview.read` and `preview.act` with "method not found" (previewPane.test.tsx shows that end to end). These fail the
// build when a path from the transport to the Preview's page appears, or when anything but the one Tauri adapter names
// the page view's commands, so a handler for those requests can't be wired in without one of them failing.
import { describe, expect, it } from "vitest";

const sources = new Map(
  Object.entries(import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true })).map(
    ([path, text]) => [path.replace(/^\/src\//, ""), text] as const,
  ),
);

const IMPORTS = [/(?:import|export)\s+(?!type\s)[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g, /import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g, /import\s+["'](\.{1,2}\/[^"']+)["']/g];

/** `spec` imported from `importer`, as the module it names, or undefined for one outside `src`. */
function resolve(importer: string, spec: string): string | undefined {
  const parts = importer.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  const base = parts.join("/");
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((p) => sources.has(p));
}

/** Every module `from` reaches by a static or dynamic import, transitively. Imports of types only are left out. */
function reached(from: string): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  for (let path = queue.pop(); path; path = queue.pop()) {
    for (const pattern of IMPORTS)
      for (const [, spec] of sources.get(path)!.matchAll(pattern)) {
        const next = resolve(path, spec);
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
  }
  return seen;
}

describe("Hermes can't reach the Preview's page", () => {
  it("has no import path from the transport to the Preview, its page view or its tunnels", () => {
    const fromHermes = reached("hermes/transport.ts");
    expect(fromHermes.size).toBeGreaterThan(5);
    expect([...fromHermes].filter((p) => p.startsWith("ui/"))).toEqual([]);
  });

  it("names the page view's, tunnels' and dev servers' commands only in their Tauri adapter", () => {
    const naming = [...sources].filter(([, text]) => /["']preview_(page|server|dev)_[a-z_]+["']/.test(text)).map(([p]) => p);
    expect(naming).toEqual(["ui/tauriPreview.ts"]);
  });

  it("hands the real page view and tunnels only to the app, which gives them to the Preview", () => {
    const users = [...sources].filter(([p, text]) => p !== "ui/tauriPreview.ts" && /\btauri(Native|Server|Web)Pages\b/.test(text)).map(([p]) => p);
    expect(users).toEqual(["App.tsx"]);
  });
});
