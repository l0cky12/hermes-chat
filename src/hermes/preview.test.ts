// What the preview pane opens and how it reads Server and Local files. Server files go through the real transport to a
// FakeHermes whose `/api/fs/*` routes answer as the deployed `bf0203a` did when probed (research doc "Preview pane").
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect } from "./transport";
import {
  addressOf,
  checkWebUrl,
  fenced,
  fromView,
  linkTarget,
  loopbackOf,
  pageOn,
  parseAddress,
  readLocalFile,
  sandboxedHtml,
  toolTargets,
  tunnelUrl,
  viewUrlOf,
  withoutBidi,
  type LinkTarget,
  type LocalText,
  type ViewUrl,
} from "./preview";
import type { Item } from "./model";

const APP = "tauri://localhost";
type ToolItem = Extract<Item, { kind: "tool" }>;
const tool = (name: string, args: Record<string, unknown>, result?: string): ToolItem => ({ kind: "tool", id: "t1", name, args, status: "done", result });

describe("Opening a web page", () => {
  it("takes http and https addresses", () => {
    expect(checkWebUrl("https://example.com/docs?q=1", APP)).toEqual({ url: "https://example.com/docs?q=1" });
    expect(checkWebUrl(" http://hermes:3000 ", APP)).toEqual({ url: "http://hermes:3000/" });
  });

  it("refuses other schemes, credentials in the address, and the app's own origin", () => {
    for (const raw of ["javascript:alert(1)", "file:///etc/passwd", "tauri://localhost/", "ipc://localhost/cmd", "data:text/html,<b>x</b>", "ftp://x"])
      expect(checkWebUrl(raw, APP), raw).toHaveProperty("error");
    expect(checkWebUrl("https://liam:hunter2@example.com", APP)).toEqual({
      error: "Web addresses with a username or password in them don't open in the preview.",
    });
    // In `npm run app` the app itself is served over http.
    expect(checkWebUrl("http://localhost:1420/", "http://localhost:1420")).toEqual({ error: "Hermes Chat's own pages don't open in the preview." });
    expect(checkWebUrl("http://localhost:5173/", "http://localhost:1420")).toEqual({ url: "http://localhost:5173/" });
  });
});

describe("The pane's address box", () => {
  it("opens a full path on the server, or a web page", () => {
    expect(parseAddress("/home/liam/notes.md", APP)).toEqual({ target: { kind: "server", path: "/home/liam/notes.md" } });
    expect(parseAddress("~/project/README.md", APP)).toEqual({ target: { kind: "server", path: "~/project/README.md" } });
    expect(parseAddress("https://example.com", APP)).toEqual({ target: { kind: "web", url: "https://example.com/" } });
  });

  it("explains a relative path, a file:// address, and an empty box", () => {
    expect(parseAddress("docs/notes.md", APP)).toHaveProperty("error", expect.stringContaining("starting with / or ~/"));
    expect(parseAddress("file:///home/liam/notes.md", APP)).toEqual({ error: "To preview a file on this computer, use Open a file on this computer." });
    expect(parseAddress("   ", APP)).toHaveProperty("error");
  });
});

describe("Pages on a loopback address (issue #171)", () => {
  it("finds localhost, 127.0.0.1, [::1] and 0.0.0.0 pages, with their port", () => {
    expect(loopbackOf("http://localhost:3000/app")).toEqual({ at: "localhost:3000" });
    expect(loopbackOf("http://LOCALHOST:5173")).toEqual({ at: "localhost:5173" });
    expect(loopbackOf("http://127.0.0.1:8000/")).toEqual({ at: "127.0.0.1:8000" });
    expect(loopbackOf("http://127.1:8000/")).toEqual({ at: "127.0.0.1:8000" });
    expect(loopbackOf("http://[::1]:8080/")).toEqual({ at: "[::1]:8080" });
    expect(loopbackOf("http://0.0.0.0:8000/")).toEqual({ at: "0.0.0.0:8000" });
    expect(loopbackOf("http://localhost/")).toEqual({ at: "localhost:80" });
    expect(loopbackOf("https://localhost/")).toEqual({ at: "localhost:443" });
  });

  it("leaves other hosts and schemes alone, as Rust does", () => {
    for (const raw of ["https://example.com/", "http://10.0.0.5:3000/", "http://127.0.0.2/", "http://app.localhost:3000/", "ftp://localhost/", "not a url"])
      expect(loopbackOf(raw), raw).toBeUndefined();
  });

  it("opens them on the server unless the owner picked this computer", () => {
    expect(pageOn({ kind: "web", url: "http://localhost:3000/" })).toBe("server");
    expect(pageOn({ kind: "web", url: "http://localhost:3000/", on: "local" })).toBe("local");
    expect(pageOn({ kind: "web", url: "https://example.com/", on: "local" })).toBeUndefined();
  });

  it("loads only a tunnel address on this computer's loopback", () => {
    expect(tunnelUrl("http://127.0.0.1:41234/a?b#c", APP)).toBe("http://127.0.0.1:41234/a?b#c");
    expect(tunnelUrl("http://p0123456789abcdef.localhost:41234/a", APP)).toBe("http://p0123456789abcdef.localhost:41234/a");
    for (const raw of [
      "http://localhost:41234/",
      "https://evil.example/",
      "http://127.0.0.1/",
      "javascript:alert(1)",
      "http://u:p@127.0.0.1:4/",
      "http://p0123456789abcdef.localhost/",
      "http://tauri.localhost:41234/",
      "http://p0123456789abcde.localhost:41234/",
      "http://x.p0123456789abcdef.localhost:41234/",
      "http://p0123456789abcdef.localhost.evil.example:41234/",
    ])
      expect(tunnelUrl(raw, APP), raw).toBeUndefined();
    expect(tunnelUrl("http://127.0.0.1:1420/", "http://127.0.0.1:1420")).toBeUndefined();
  });

  it("sorts a link into a page, a server page, or one that can only be copied", () => {
    const cases: [string | undefined, LinkTarget | undefined][] = [
      ["https://docs.example.com/crash", { kind: "page", url: "https://docs.example.com/crash" }],
      ["https://Bücher.example", { kind: "page", url: "https://xn--bcher-kva.example/" }],
      ["http://localhost:5173/app?v=2", { kind: "serverPage", url: "http://localhost:5173/app?v=2" }],
      ["http://127.0.0.1:8000", { kind: "serverPage", url: "http://127.0.0.1:8000/" }],
      ["mailto:x@example.com", { kind: "elsewhere", href: "mailto:x@example.com" }],
      ["docs/a.md", { kind: "elsewhere", href: "docs/a.md" }],
      ["file:///etc/passwd", { kind: "elsewhere", href: "file:///etc/passwd" }],
      ["https://u:p@example.com/", { kind: "elsewhere", href: "https://u:p@example.com/" }],
      ["#user-content-fn-1", undefined],
      ["  ", undefined],
      [undefined, undefined],
    ];
    for (const [href, want] of cases) expect(linkTarget(href, APP), href).toEqual(want);
    expect(linkTarget("http://127.0.0.1:1420/", "http://127.0.0.1:1420")).toEqual({ kind: "elsewhere", href: "http://127.0.0.1:1420/" });
  });

  it("takes a typed localhost:port without its scheme, and names a scheme it refuses", () => {
    expect(parseAddress("localhost:3000", APP)).toEqual({ target: { kind: "web", url: "http://localhost:3000/" } });
    expect(parseAddress("127.0.0.1:8000/docs", APP)).toEqual({ target: { kind: "web", url: "http://127.0.0.1:8000/docs" } });
    expect(parseAddress("[::1]:8080", APP)).toEqual({ target: { kind: "web", url: "http://[::1]:8080/" } });
    expect(parseAddress("localhost:99999", APP)).toEqual({ error: "That isn't a web address." });
    expect(parseAddress("postgres://localhost:5432/db", APP)).toEqual({ error: "Only http:// and https:// pages open in the preview, and postgres: isn't a web address." });
    expect(parseAddress("localhostfoo:3000", APP)).toHaveProperty("error", expect.stringContaining("http://"));
  });

  it("tries a bare domain over https first, with http to fall back to (issue #441)", () => {
    const upgraded = (typed: string, https: string) =>
      expect(parseAddress(typed, APP), typed).toEqual({ target: { kind: "web", url: https, fallback: new URL(https.replace(/^https:/, "http:")).href } });
    upgraded("example.com", "https://example.com/");
    upgraded("docs.github.com/en", "https://docs.github.com/en");
    upgraded("example.com/a?b#c", "https://example.com/a?b#c");
    upgraded("sub.example.co.uk:8443", "https://sub.example.co.uk:8443/");
    upgraded("notes.md", "https://notes.md/");
    // A port typed with a bare domain is kept, the http default included, though `URL` drops it from the fallback.
    upgraded("example.com:80/a", "https://example.com:80/a");
    // A typed http:// domain too, as Chrome's HTTPS-Upgrades does, unless it names a port of its own.
    upgraded("http://example.com/x", "https://example.com/x");
    expect(parseAddress("http://example.com:8080/", APP)).toEqual({ target: { kind: "web", url: "http://example.com:8080/" } });
    expect(parseAddress("http://example.com:80/", APP)).toEqual({ target: { kind: "web", url: "http://example.com/" } });
    expect(parseAddress("https://example.com", APP)).toEqual({ target: { kind: "web", url: "https://example.com/" } });
  });

  it("keeps loopback, IP and single-word addresses on http, and refuses what isn't a host", () => {
    expect(parseAddress("localhost:3000", APP)).toEqual({ target: { kind: "web", url: "http://localhost:3000/" } });
    expect(parseAddress("0.0.0.0:8000", APP)).toEqual({ target: { kind: "web", url: "http://0.0.0.0:8000/" } });
    expect(parseAddress("192.168.1.5:8080/app", APP)).toEqual({ target: { kind: "web", url: "http://192.168.1.5:8080/app" } });
    expect(parseAddress("http://intranet/", APP)).toEqual({ target: { kind: "web", url: "http://intranet/" } });
    expect(parseAddress("http://[2001:db8::1]/", APP)).toEqual({ target: { kind: "web", url: "http://[2001:db8::1]/" } });
    for (const raw of ["hello world", "example .com", "intranet", "-bad.example", "example.com:99999", "a@example.com"])
      expect(parseAddress(raw, APP), raw).toHaveProperty("error", expect.stringMatching(/web address|example\.com/));
    expect(parseAddress("hello world", APP)).toEqual({
      error: "Enter a web address such as example.com or http://…, a port, or a full path on the Hermes server starting with / or ~/.",
    });
  });

  it("takes a dev server's bare port as that port on localhost", () => {
    expect(parseAddress(" 5173 ", APP)).toEqual({ target: { kind: "web", url: "http://localhost:5173/" } });
    expect(parseAddress("65535", APP)).toEqual({ target: { kind: "web", url: "http://localhost:65535/" } });
    for (const raw of ["0", "65536", "123456"]) expect(parseAddress(raw, APP), raw).toHaveProperty("error");
  });
});

describe("A page's address in the view (issue #376)", () => {
  const tunnel = { remote: "http://localhost:5173", local: "http://127.0.0.1:41234" };
  const view = (url: string) => url as ViewUrl;

  it("loads a Server page through its tunnel, and nothing until that tunnel is open", () => {
    const page = { kind: "web", url: "http://localhost:5173/notes?tag=a#top" } as const;
    expect(viewUrlOf(page, tunnel)).toBe("http://127.0.0.1:41234/notes?tag=a#top");
    expect(viewUrlOf(page, undefined)).toBeUndefined();
    expect(viewUrlOf({ kind: "web", url: "http://localhost:8000/" }, tunnel)).toBeUndefined();
    expect(viewUrlOf({ ...page, on: "local" }, tunnel)).toBe(page.url);
    expect(viewUrlOf({ kind: "web", url: "https://example.com/" }, tunnel)).toBe("https://example.com/");
  });

  it("maps what the view reports back to the owner's address, exactly", () => {
    for (const url of ["http://127.0.0.1:41234/", "http://127.0.0.1:41234/a/b?c=1&d#e", "http://127.0.0.1:41234/%E2%9C%93"]) {
      const target = fromView(view(url), tunnel);
      expect(target.on).toBe("server");
      expect(viewUrlOf(target, tunnel)).toBe(url);
    }
    expect(fromView(view("http://127.0.0.1:41234/a"), tunnel)).toEqual({ kind: "web", url: "http://localhost:5173/a", on: "server" });
  });

  it("says a page that left the tunnel for another loopback address is on this computer, and anything else is the web", () => {
    expect(fromView(view("http://localhost:5173/a"), tunnel)).toEqual({ kind: "web", url: "http://localhost:5173/a", on: "local" });
    expect(fromView(view("http://127.0.0.1:41235/"), tunnel)).toEqual({ kind: "web", url: "http://127.0.0.1:41235/", on: "local" });
    expect(fromView(view("https://github.com/"), tunnel)).toEqual({ kind: "web", url: "https://github.com/" });
    expect(fromView(view("http://localhost:3000/"), undefined)).toEqual({ kind: "web", url: "http://localhost:3000/", on: "local" });
  });

  it("keeps an https Server page's scheme on both sides", () => {
    const https = { remote: "https://localhost:8443", local: "https://127.0.0.1:41234" };
    expect(viewUrlOf({ kind: "web", url: "https://localhost:8443/x" }, https)).toBe("https://127.0.0.1:41234/x");
    expect(fromView(view("https://127.0.0.1:41234/x"), https)).toEqual({ kind: "web", url: "https://localhost:8443/x", on: "server" });
  });

  it("shows a loopback page the way a dev server prints it, and anything else as it is", () => {
    expect(addressOf({ kind: "web", url: "http://localhost:5173/" })).toBe("localhost:5173");
    expect(addressOf({ kind: "web", url: "http://localhost:5173/a?b" })).toBe("localhost:5173/a?b");
    expect(addressOf({ kind: "web", url: "https://localhost:8443/" })).toBe("https://localhost:8443/");
    expect(addressOf({ kind: "web", url: "https://example.com/" })).toBe("https://example.com/");
    expect(addressOf({ kind: "server", path: "/srv/a.md" })).toBe("/srv/a.md");
    expect(addressOf({ kind: "tool", name: "terminal", text: "" })).toBe("terminal output");
    for (const raw of ["localhost:5173", "localhost:5173/a?b"]) expect(parseAddress(raw, APP)).toHaveProperty("target.url", `http://${raw}${raw.includes("/") ? "" : "/"}`);
  });
});

describe("What a tool call can preview", () => {
  it("finds the server file a file tool used", () => {
    expect(toolTargets(tool("read_file", { path: "/home/liam/app/main.py", offset: 1 }), APP)).toEqual([{ kind: "server", path: "/home/liam/app/main.py" }]);
    expect(toolTargets(tool("write_file", { path: "~/notes.md", content: "x" }), APP)).toEqual([{ kind: "server", path: "~/notes.md" }]);
  });

  it("finds the pages a browser or web tool used", () => {
    expect(toolTargets(tool("browser_navigate", { url: "https://example.com" }), APP)).toEqual([{ kind: "web", url: "https://example.com/" }]);
    expect(toolTargets(tool("web_extract", { urls: ["https://a.example/", "https://b.example/", 7, "javascript:alert(1)"] }), APP)).toEqual([
      { kind: "web", url: "https://a.example/" },
      { kind: "web", url: "https://b.example/" },
    ]);
  });

  it("finds MEDIA: files in the result, each once, and skips relative paths", () => {
    const t = tool("image_generate", { path: "out.png" }, "Saved MEDIA:/home/liam/.hermes/images/cat.png and MEDIA:/home/liam/.hermes/images/cat.png.");
    expect(toolTargets(t, APP)).toEqual([{ kind: "server", path: "/home/liam/.hermes/images/cat.png" }]);
  });

  it("finds nothing in a tool call that names no file or page", () => {
    expect(toolTargets(tool("terminal", { command: "ls /etc" }, "passwd\nhosts"), APP)).toEqual([]);
  });
});

/** Signed in to a FakeHermes with `files` on the server's disk. */
async function server(files: FakeHermes["serverFiles"]) {
  const s = new FakeHermes();
  s.serverFiles = files;
  const hermes = await connect(s.openPipe);
  return { s, hermes };
}

describe("Reading a Server file", () => {
  it("reads text through dashboard REST, for the profile shown", async () => {
    const { s, hermes } = await server({ "/home/liam/app/main.py": 'print("hi")\n' });
    expect(await hermes.readServerFile("/home/liam/app/main.py")).toEqual({
      kind: "text",
      text: 'print("hi")\n',
      language: "python",
      format: "code",
      size: 12,
      truncated: false,
    });
    const req = s.restRequests.at(-1)!;
    expect([req.method, req.path, req.query.get("path"), req.query.get("profile")]).toEqual(["GET", "/api/fs/read-text", "/home/liam/app/main.py", "default"]);
  });

  it("says when only the first 512 KB is shown", async () => {
    const { hermes } = await server({ "/var/log/big.log": "x".repeat(600_000) });
    const v = await hermes.readServerFile("/var/log/big.log");
    expect(v).toMatchObject({ kind: "text", truncated: true, size: 600_000 });
    expect(v.kind === "text" && v.text.length).toBe(512 * 1024);
  });

  it("marks Markdown and HTML for their rendered view", async () => {
    const { hermes } = await server({ "/srv/README.md": "# Hi", "/srv/site/index.html": "<h1>Hi</h1>" });
    expect(await hermes.readServerFile("/srv/README.md")).toMatchObject({ format: "markdown", language: "markdown" });
    expect(await hermes.readServerFile("/srv/site/index.html")).toMatchObject({ format: "html", language: "xml" });
  });

  it("reads an image as a data URL", async () => {
    const { s, hermes } = await server({ "/home/liam/cat.png": "\x89PNG\r\n\x1a\nbytes" });
    const v = await hermes.readServerFile("/home/liam/cat.png");
    expect(v).toEqual({ kind: "image", src: `data:image/png;base64,${btoa("\x89PNG\r\n\x1a\nbytes")}`, size: 13 });
    expect(s.restRequests.at(-1)!.path).toBe("/api/fs/read-data-url");
  });

  it("won't show a binary file that isn't an image", async () => {
    const { hermes } = await server({ "/home/liam/report.pdf": "%PDF-1.7\0\0\0binary", "/usr/bin/tool": "\x7fELF\0\0\0" });
    expect(await hermes.readServerFile("/home/liam/report.pdf")).toEqual({ kind: "unsupported", reason: "The preview can't show PDF files.", size: 17 });
    expect(await hermes.readServerFile("/usr/bin/tool")).toEqual({ kind: "unsupported", reason: "The preview can't show binary files.", size: 7 });
  });

  it("explains a missing file, a folder, and a credentials file Hermes refuses", async () => {
    const { hermes } = await server({ "/home/liam/app": { dir: true }, "/home/liam/app/.env": "SECRET=1" });
    await expect(hermes.readServerFile("/home/liam/gone.txt")).rejects.toThrow("There's no file at this path on the Hermes server.");
    await expect(hermes.readServerFile("/home/liam/app")).rejects.toThrow("This path is a folder on the Hermes server, not a file.");
    await expect(hermes.readServerFile("/home/liam/app/.env")).rejects.toThrow("Hermes doesn't show this file, since it may hold credentials.");
  });

  it("says when the server can't read files at all", async () => {
    const { s, hermes } = await server({});
    delete s.rest["GET /api/fs/read-text"];
    await expect(hermes.readServerFile("/etc/hosts")).rejects.toThrow("This Hermes server can't read files for the preview.");
  });

  it("refuses a relative path before asking Hermes", async () => {
    const { s, hermes } = await server({});
    await expect(hermes.readServerFile("notes.md")).rejects.toThrow("starting with / or ~/");
    expect(s.restRequests.filter((r) => r.path.startsWith("/api/fs"))).toEqual([]);
  });

  it("doesn't show a data URL that isn't an image", async () => {
    const { s, hermes } = await server({ "/home/liam/fake.svg": "x" });
    s.rest["GET /api/fs/read-data-url"] = () => ({ dataUrl: "data:text/html;base64,PHNjcmlwdD4=" });
    expect(await hermes.readServerFile("/home/liam/fake.svg")).toMatchObject({ kind: "unsupported", reason: "The preview can't show text/html files." });
  });
});

describe("Reading a Local file", () => {
  const io = (t: Partial<LocalText>) => ({
    readText: async () => ({ size: 5, truncated: false, binary: false, text: "hello", ...t }),
    readImage: async (path: string) => `blob:${path}`,
  });

  it("reads an image as an object URL, and text as text", async () => {
    expect(await readLocalFile({ path: "/home/liam/cat.png", name: "cat.png" }, io({}))).toEqual({ kind: "image", src: "blob:/home/liam/cat.png" });
    expect(await readLocalFile({ path: "/home/liam/notes.md", name: "notes.md" }, io({}))).toEqual({
      kind: "text",
      text: "hello",
      language: "markdown",
      format: "markdown",
      size: 5,
      truncated: false,
    });
  });

  it("won't show a binary file", async () => {
    expect(await readLocalFile({ path: "/home/liam/disk.img", name: "disk.img" }, io({ binary: true, size: 4096 }))).toEqual({
      kind: "unsupported",
      reason: "The preview can't show binary files.",
      size: 4096,
    });
  });
});

describe("Rendering untrusted file text", () => {
  it("fences code so the file can't close the fence", () => {
    expect(fenced("a ``` b ```` c", "python")).toBe("`````python\na ``` b ```` c\n`````");
    expect(fenced("plain", "")).toBe("```\nplain\n```");
  });

  it("names only a plain language on the fence, so the server's language can't end it", () => {
    expect(fenced("x", "c++")).toBe("```c++\nx\n```");
    expect(fenced("x", "objective-c")).toBe("```objective-c\nx\n```");
    expect(fenced("x", "js\n```\n<img src=x>")).toBe("```\nx\n```");
    expect(fenced("x", "py {.class}")).toBe("```\nx\n```");
  });

  it("puts a no-network policy ahead of an HTML file", () => {
    const doc = sandboxedHtml("<img src=https://tracker.example/p.gif><script>alert(1)</script>");
    expect(doc.startsWith('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:;')).toBe(true);
    expect(doc).toContain("<script>alert(1)</script>");
  });
});

describe("withoutBidi", () => {
  it("shows the controls that reverse a name, and keeps right-to-left text and emoji as they are", () => {
    expect(withoutBidi("/srv/invoice\u202Efdp.exe")).toBe("/srv/invoice\uFFFDfdp.exe");
    expect(withoutBidi("a\u2066b\u2069c\u202Ad")).toBe("a\uFFFDb\uFFFDc\uFFFDd");
    const kept = "\u05E9\u05DC\u05D5\u05DD \u200F report-\u{1F468}\u200D\u{1F4BB}.md";
    expect(withoutBidi(kept)).toBe(kept);
  });
});
