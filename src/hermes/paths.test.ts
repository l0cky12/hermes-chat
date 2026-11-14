// Paths in a reply (ADR 0163): which words link, what full path each names, and where opening one goes.
import { describe, expect, it, vi } from "vitest";
import { destinationOf, findPaths, folderOf, hrefPath, pathOpener, resolvePath, type PathKind, type PathOpen, type ServerPath } from "./paths";
import type { PreviewTarget } from "./preview";

/** The link words `findPaths` takes from `text`, and the path each names when that differs from the words. */
const linked = (text: string, where: "prose" | "code" = "prose") =>
  findPaths(text, where).map((s) => {
    const words = text.slice(s.start, s.end);
    return words === s.mention.written ? words : `${words} -> ${s.mention.written}`;
  });

const full = (written: string, base?: string) => resolvePath(written, base) as ServerPath;

describe("A path in running text", () => {
  it.each([
    ["Edited /usr/bin/env today", ["/usr/bin/env"]],
    ["see /tmp/ and /README.md", ["/tmp/", "/README.md"]],
    ["in ~/notes/todo.md, ~/ and ~/x", ["~/notes/todo.md", "~/", "~/x"]],
    ["run ./build.sh or ../up/one or ./", ["./build.sh", "../up/one", "./"]],
    ["src/ui/Markdown.tsx renders it", ["src/ui/Markdown.tsx"]],
    ["the docs/adr/ folder and src/", ["docs/adr/", "src/"]],
    ["docs/adr/0001-first.md", ["docs/adr/0001-first.md"]],
    [".github/workflows/ci.yml", [".github/workflows/ci.yml"]],
    ["app/[id]/page.tsx", ["app/[id]/page.tsx"]],
    ["/srv/caf\u00e9/\u65e5\u672c.txt", ["/srv/caf\u00e9/\u65e5\u672c.txt"]],
  ])("links %j", (text, paths) => expect(linked(text)).toEqual(paths));

  it.each([
    "and/or",
    "1/2 of it",
    "2024/01/02",
    "TCP/IP and I/O at 5 km/h",
    "origin/main",
    "application/json",
    "owner/repo",
    "w/ and w/o",
    "v1.2/3.4",
    "/help and /model and /tmp",
    "a / b",
    "github.com/owner/repo and example.com/a.html",
    "e.g./i.e",
    "https://example.com/a/b.ts",
    "@types/node and @scope/pkg/index.js",
    "//cdn.example.com/x.js",
    "src//ui/x.ts",
    "src/*.ts and src/{a,b}.ts",
    "<a/b.html> a|b/c.ts",
    "C:\\Users\\me\\x.txt and C:/Users/me/x.txt",
    "$HOME/notes/x.md",
    "liam@hermes:/srv/app/x.py",
    "--prefix=/usr/local/bin",
    "no slash here.md",
  ])("leaves %j as text", (text) => expect(linked(text)).toEqual([]));

  it("leaves the quotes, brackets and punctuation around a path out of the link", () => {
    expect(linked("(see /etc/hosts.conf)")).toEqual(["/etc/hosts.conf"]);
    expect(linked('"~/notes/a.md", then [src/a.ts].')).toEqual(["~/notes/a.md", "src/a.ts"]);
    expect(linked("Is it src/a.ts? Yes: src/b.ts; or src/c.ts\u2026")).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(linked("\u201c/var/log/app.log\u201d")).toEqual(["/var/log/app.log"]);
    expect(linked("(app/(shop)/page.tsx)")).toEqual(["app/(shop)/page.tsx"]);
  });

  it("keeps a line number in the link's words and out of the path", () => {
    expect(linked("at src/App.tsx:1455 and src/a.ts:12:3.")).toEqual(["src/App.tsx:1455 -> src/App.tsx", "src/a.ts:12:3 -> src/a.ts"]);
    expect(linked("src/a.ts#L12 and src/a.ts#L12-L20")).toEqual(["src/a.ts#L12 -> src/a.ts", "src/a.ts#L12-L20 -> src/a.ts"]);
  });

  it("says a path written with a slash at its end is a folder", () => {
    expect(findPaths("docs/adr/ and docs/adr/x.md", "prose").map((s) => s.mention.folder)).toEqual([true, false]);
  });

  it("takes no path from a word of more than 1,024 characters, and stays quick on a long run of them", () => {
    expect(linked(`/a/${"b".repeat(1024)}`)).toEqual([]);
    const t0 = performance.now();
    expect(linked(`${"/a/b ".repeat(20_000)}${")".repeat(1000)}/x/y${")".repeat(1000)}`)).toHaveLength(20_000);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("A path in a code span", () => {
  it.each([
    ["/tmp", ["/tmp"]],
    ["/etc", ["/etc"]],
    ["~/notes", ["~/notes"]],
    ["./run", ["./run"]],
    ["src/ui", ["src/ui"]],
    ["bin/hermes", ["bin/hermes"]],
    ["package.json", ["package.json"]],
    [".eslintrc.json", [".eslintrc.json"]],
    ["notes.txt", ["notes.txt"]],
    ["logo.png", ["logo.png"]],
    ["src/App.tsx:1455", ["src/App.tsx:1455 -> src/App.tsx"]],
    ["package.json:12", ["package.json:12 -> package.json"]],
    [" src/ui ", ["src/ui"]],
    ["/home/liam/My Documents/report.md", ["/home/liam/My Documents/report.md"]],
    ["~/My Projects/site/", ["~/My Projects/site/"]],
  ])("links the whole of %j", (code, paths) => expect(linked(code, "code")).toEqual(paths));

  it.each([
    ["cat /etc/hosts.conf", ["/etc/hosts.conf"]],
    ["rm -rf build/ && ls dist/", ["build/", "dist/"]],
    ['import x from "./foo"', ["./foo"]],
    ["a/b.txt", ["a/b.txt"]],
    ["/usr/bin/ls -la /srv/app", ["/usr/bin/ls", "/srv/app"]],
    ["/usr/bin/env python", ["/usr/bin/env"]],
  ])("links the paths inside %j as running text does", (code, paths) => expect(linked(code, "code")).toEqual(paths));

  it.each(["console.log", "os.path", "Makefile", "y/n", "1/2", "s/foo/bar/", "cd /tmp", "git checkout origin/main", "@types/node", "github.com/a/b", "--out/dir", "src/*.ts", "a//b", "~", "/"])(
    "leaves %j as text",
    (code) => expect(linked(code, "code")).toEqual([]),
  );
});

describe("A Markdown link's address as a path", () => {
  it.each([
    ["src/ui", "src/ui"],
    ["README.md", "README.md"],
    ["./a.ts#L3", "./a.ts"],
    ["/etc/hosts", "/etc/hosts"],
    ["~/notes/", "~/notes/"],
    ["file:///etc/hosts", "/etc/hosts"],
    ["file://localhost/etc/hosts", "/etc/hosts"],
    ["file:/etc/hosts", "/etc/hosts"],
    ["a%20b/caf%C3%A9.txt", "a b/caf\u00e9.txt"],
    ["src/a.ts:12", "src/a.ts"],
    ["docs/x.md?plain=1#intro", "docs/x.md"],
    ["100%/done.txt", "100%/done.txt"],
  ])("%j is the path %j", (href, written) => expect(hrefPath(href)?.written).toBe(written));

  it.each(["https://example.com/a.ts", "http://localhost:3000/", "mailto:a@b.co", "javascript:alert(1)", "#section", "?q=1", "", "//cdn.example.com/x.js", "example.com/a.html", "www.example.com", "file://fileserver/share/x.txt", "/a%1Bb"])(
    "%j stays a link",
    (href) => expect(hrefPath(href)).toBeUndefined(),
  );

  it("says an address with a slash at its end is a folder", () => {
    expect(hrefPath("docs/adr/")).toEqual({ written: "docs/adr/", folder: true });
    expect(hrefPath("docs/adr")).toEqual({ written: "docs/adr", folder: false });
  });
});

describe("A path's full path", () => {
  it("keeps a full path, folded, with no slash at its end", () => {
    expect(full("/etc/hosts")).toBe("/etc/hosts");
    expect(full("/srv//app/./docs/")).toBe("/srv/app/docs");
    expect(full("~/notes/./a.md")).toBe("~/notes/a.md");
    expect(full("/")).toBe("/");
    expect(full("~/")).toBe("~/");
  });

  it("joins a relative path to the folder it is relative to, and has none without one", () => {
    expect(full("src/ui/Markdown.tsx", "/srv/app")).toBe("/srv/app/src/ui/Markdown.tsx");
    expect(full("./", "/srv/app")).toBe("/srv/app");
    expect(full("notes/a.md", "~/work")).toBe("~/work/notes/a.md");
    expect(resolvePath("src/ui", undefined)).toBeUndefined();
    expect(resolvePath("src/ui", "relative/base")).toBeUndefined();
  });

  it("keeps `..`, which only the server can follow through a symbolic link", () => {
    expect(full("/bin/../share")).toBe("/bin/../share");
    expect(full("../shared/x.md", "/srv/app/")).toBe("/srv/app/../shared/x.md");
    expect(full("~/../other")).toBe("~/../other");
  });

  it("has none for a path with a control character in it, or one too long for the server", () => {
    expect(resolvePath("/a\u001b[31mb", undefined)).toBeUndefined();
    expect(resolvePath("/a\nb", undefined)).toBeUndefined();
    expect(resolvePath(`/${"a".repeat(4096)}`, undefined)).toBeUndefined();
  });

  it("names the folder a path is in", () => {
    expect(folderOf(full("/srv/app/x.py"))).toBe("/srv/app");
    expect(folderOf(full("/x.py"))).toBe("/");
    expect(folderOf(full("~/x.py"))).toBe("~/");
    expect(folderOf(full("~/a/b"))).toBe("~/a");
    expect(folderOf(full("/"))).toBe("/");
  });
});

describe("Where a path opens", () => {
  it.each<[PathKind, "click" | "terminal", string]>([
    ["folder", "click", "shell"],
    ["file", "click", "preview"],
    ["missing", "click", "preview"],
    ["unknown", "click", "preview"],
    ["folder", "terminal", "shell"],
    ["file", "terminal", "shellBeside"],
    ["missing", "terminal", "noFolder"],
    ["unknown", "terminal", "shell"],
  ])("a %s, on a %s: %s", (kind, asked, to) => expect(destinationOf(kind, asked)).toBe(to));

  function opener(kinds: Record<string, PathKind | Promise<PathKind>> = {}) {
    const did: string[] = [];
    const kindOf = vi.fn((path: ServerPath) => Promise.resolve(kinds[path] ?? "unknown"));
    const open = pathOpener({
      kindOf,
      preview: (t: PreviewTarget) => did.push(`preview ${JSON.stringify(t)}`),
      shell: (folder) => did.push(`shell ${folder}`),
      say: (text) => did.push(`say ${text}`),
    });
    const at = (written: string, rest: Partial<PathOpen> = {}) => open({ path: full(written), saysFolder: written.endsWith("/"), ...rest });
    return { did, kindOf, at };
  }

  it("opens a file in the Preview, naming the chat, and a folder in a shell", async () => {
    const { did, at } = opener({ "/srv/app/x.py": "file", "/srv/app/src": "folder" });
    await at("/srv/app/x.py", { session: "chat-1" });
    await at("/srv/app/src");
    expect(did).toEqual(['preview {"kind":"server","path":"/srv/app/x.py","session":"chat-1"}', "shell /srv/app/src"]);
  });

  it("opens a path the server finds nothing at, or can't speak for, in the Preview, which says why", async () => {
    const { did, at } = opener({ "/gone.txt": "missing" });
    await at("/gone.txt");
    await at("/who/knows");
    expect(did).toEqual(['preview {"kind":"server","path":"/gone.txt"}', 'preview {"kind":"server","path":"/who/knows"}']);
  });

  it("takes a path written as a folder for one without asking the server", async () => {
    const { did, kindOf, at } = opener();
    await at("/srv/app/docs/");
    expect(did).toEqual(["shell /srv/app/docs"]);
    expect(kindOf).not.toHaveBeenCalled();
  });

  it("opens the menu's Preview without asking, and the menu's Terminal in a file's own folder", async () => {
    const { did, kindOf, at } = opener({ "/srv/app/x.py": "file", "/srv/app/src": "folder", "/gone": "missing" });
    await at("/srv/app/src", { as: "preview" });
    expect(kindOf).not.toHaveBeenCalled();
    await at("/srv/app/x.py", { as: "terminal" });
    await at("/srv/app/src", { as: "terminal" });
    await at("/gone", { as: "terminal" });
    expect(did).toEqual(['preview {"kind":"server","path":"/srv/app/src"}', "shell /srv/app", "shell /srv/app/src", "say There's no folder at /gone on the Hermes server."]);
  });

  it("drops an answer that comes back after a later click", async () => {
    let answer!: (kind: PathKind) => void;
    const { did, at } = opener({ "/slow": new Promise<PathKind>((done) => (answer = done)), "/quick.txt": "file" });
    const slow = at("/slow");
    await at("/quick.txt");
    answer("folder");
    await slow;
    expect(did).toEqual(['preview {"kind":"server","path":"/quick.txt"}']);
  });
});
