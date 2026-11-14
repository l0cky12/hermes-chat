import { describe, expect, it } from "vitest";
import { shownName, shownPath, splitPath } from "./serverPaths";

describe("server paths", () => {
  it("makes invisible and direction-changing characters in a name visible", () => {
    expect(shownName("/srv/out/invoice‮fdp.exe")).toBe("invoice�fdp.exe");
    expect(shownName("/srv/out/a\nb.txt")).toBe("a�b.txt");
    expect(shownName("/srv/<img src=x onerror=alert(1)>.html")).toBe("<img src=x onerror=alert(1)>.html");
    expect(shownPath("/srv/a‮b/c.txt")).toBe("/srv/a�b/c.txt");
  });

  it("splits a path into its folder and name", () => {
    expect(splitPath("/srv/out/report.md")).toEqual({ dir: "/srv/out", name: "report.md" });
    expect(splitPath("/report.md")).toEqual({ dir: "/", name: "report.md" });
    expect(splitPath("/srv/out/")).toEqual({ dir: "/srv", name: "out" });
  });
});
