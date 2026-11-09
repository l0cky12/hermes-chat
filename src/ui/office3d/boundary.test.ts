// three.js costs nothing until the office opens (ADR 0122) only while it is reached through one dynamic import. These
// fail the build when a file elsewhere imports three, or imports the scene other than with import() or for its types.
import { describe, expect, it } from "vitest";

const sources = Object.entries(import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true })).map(
  ([path, text]) => ({ path: path.replace(/^\/src\//, ""), text }),
);

describe("The office's three.js boundary", () => {
  it("has three.js imported only by the scene's own files", () => {
    const importers = sources.filter((s) => /from\s+["']three(\/[^"']*)?["']/.test(s.text)).map((s) => s.path);
    expect(importers).toContain("ui/office3d/scene.ts");
    expect(importers.filter((p) => !p.startsWith("ui/office3d/"))).toEqual([]);
    expect(importers).not.toContain("ui/office3d/pacer.ts");
  });

  it("has the scene reached only with import(), or for its types", () => {
    const outside = sources.filter((s) => !s.path.startsWith("ui/office3d/"));
    const statics = outside.filter((s) => /^import\s+(?!type\s)[^;]*from\s+["'][^"']*office3d\/(scene|building|figures)["']/m.test(s.text)).map((s) => s.path);
    expect(statics).toEqual([]);
    expect(outside.some((s) => s.text.includes('import("./office3d/scene")'))).toBe(true);
  });
});
