// @vitest-environment jsdom
// The preview pane beside the chat, driven the way the owner would drive it in the signed-in app, against a fake
// Hermes whose `/api/fs/*` routes answer as the deployed server did. Each test checks what the owner sees and what went
// to Hermes; the frames' sandboxes are checked as rendered, since that is what keeps their content away from the app.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { getUIPrefs } from "../hermes/uiPrefs";
import type { FileView, Framing, ViewUrl } from "../hermes/preview";
import {
  ServerPageError,
  type DevServers,
  type LocalFiles,
  type NativePage,
  type NativePages,
  type PageEvent,
  type Placement,
  type ServerPage,
  type ServerPages,
  type WebPages,
} from "./tauriPreview";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));
const pane = () => {
  const el = document.querySelector<HTMLElement>("aside.preview:not([hidden])");
  if (!el) throw new Error("The preview pane isn't open");
  return el;
};
const paneOpen = () => !!document.querySelector("aside.preview:not([hidden])");
const address = () => within(pane()).getByRole<HTMLInputElement>("textbox", { name: "Address" });
const button = (name: string) => within(pane()).getByRole<HTMLButtonElement>("button", { name });
/** The preview's file reads. The Outputs capability probe's `GET /api/fs/list` at sign-in may land at any time. */
const fsReads = (s: FakeHermes) => s.restRequests.filter((r) => r.path.startsWith("/api/fs/") && r.path !== "/api/fs/list");

/** A local disk the Open dialog picks from: `pick` is what the owner picks next (null cancels). */
function localDisk(files: Record<string, FileView | Error>) {
  const local: LocalFiles & { next: { path: string; name: string } | null } = {
    next: null,
    pick: async () => local.next,
    read: async (f) => {
      const v = files[f.path];
      if (!v) throw new Error("No such file or directory (os error 2)");
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return local;
}

function theWeb(answers: Record<string, Framing | Error | Promise<Framing>> = {}, openFails?: string) {
  const web: WebPages & { checked: string[]; opened: string[]; devs: DevServers | Error; looked: number } = {
    checked: [],
    opened: [],
    devs: { server: { kind: "listed", ports: [] }, local: [] },
    looked: 0,
    devServers: async () => {
      web.looked++;
      if (web.devs instanceof Error) throw web.devs;
      return web.devs;
    },
    check: async (url) => {
      web.checked.push(url);
      const a = answers[url] ?? { kind: "notRefused" };
      if (a instanceof Error) throw a;
      return a;
    },
    openInBrowser: async (url) => {
      if (openFails) throw new Error(openFails);
      web.opened.push(url);
      return "Helium Browser";
    },
  };
  return web;
}

function theView() {
  const view: NativePages & {
    made: number;
    asked: [number, string][];
    placed: Map<number, Placement | null>;
    closed: number[];
    say(n: number, e: PageEvent): void;
    land(n: number): void;
  } = {
    made: 0,
    asked: [],
    placed: new Map(),
    closed: [],
    say: () => {},
    land: (n) => {
      const went = view.asked.filter(([m, a]) => m === n && a.startsWith("go ")).at(-1);
      view.say(n, at(went![1].slice(3), true));
    },
    open: (onEvent) => {
      const n = ++view.made;
      const said = view.say;
      view.say = (m, e) => (m === n ? onEvent(e) : said(m, e));
      const page: NativePage = {
        go: (url) => void view.asked.push([n, `go ${url}`]),
        reload: () => void view.asked.push([n, "reload"]),
        place: (p) => void view.placed.set(n, p),
        close: () => void view.closed.push(n),
      };
      return page;
    },
  };
  return view;
}
const at = (url: string, replace = false): PageEvent => ({ kind: "at", url: url as ViewUrl, replace });

/**
 * The Hermes server's loopback as Rust's SSH tunnels reach it (src-tauri/src/server_page.rs). Each `open` gets the
 * next of `answers` (a page opens when there is none left), and the tunnel's end on this computer is
 * `http://127.0.0.1:4100<n>`. `opened`, `closed` and `live` record what the pane did, by key "1", "2"…; `drop(key,
 * why)` ends a tunnel as ssh exiting would, even one still connecting.
 */
function theServer(...answers: (ServerPageError | Promise<void> | { url: string })[]) {
  const pages: ServerPages & { opened: string[]; closed: string[]; live: Map<string, (why: string) => void>; drop(key: string, why: string): void } = {
    opened: [],
    closed: [],
    live: new Map(),
    open: (url, onClosed) => {
      pages.opened.push(url);
      const id = String(pages.opened.length);
      pages.live.set(id, onClosed);
      const a = answers.shift();
      const page = (async (): Promise<ServerPage> => {
        if (a instanceof Error) {
          pages.live.delete(id);
          throw a;
        }
        if (a instanceof Promise) await a;
        const u = new URL(url);
        return { id, url: a && "url" in a ? a.url : `${u.protocol}//127.0.0.1:4100${id}${u.pathname}${u.search}`, target: "liam@hermes", at: `${u.hostname}:${u.port}` };
      })();
      return {
        page,
        close: () => {
          pages.closed.push(id);
          pages.live.delete(id);
        },
      };
    },
    drop: (key, why) => {
      const onClosed = pages.live.get(key);
      pages.live.delete(key);
      onClosed?.(why);
    },
  };
  return pages;
}

/**
 * Signed in, with the chat "Fix the app" open: a reply with a link, then a read_file call on a server file, a
 * browser_navigate call and a terminal call.
 */
async function signedIn({ local = localDisk({}), web = theWeb(), pages = theServer() } = {}) {
  const server = new FakeHermes();
  server.sessions = [row("fix", 1, { pinned: true, title: "Fix the app" }), row("other", 2, { pinned: true, title: "Another chat" })];
  server.transcripts = {
    fix: [
      { role: "user", text: "Why does the app crash?" },
      { role: "tool", name: "read_file", context: "main.py", args: { path: "/home/liam/app/main.py" } },
      { role: "tool", name: "browser_navigate", context: "docs", args: { url: "https://docs.example.com/crash" } },
      { role: "tool", name: "patch", context: "main.py", args: { path: "/home/liam/app/main.py" }, content: '{"success": true, "diff": "-a\\n+b"}' },
      {
        role: "assistant",
        text: "It reads a missing file. See [the docs](https://docs.example.com/crash) and [a mail](mailto:x@example.com). The fix runs at [the dev server](http://localhost:5173/app?v=2).",
      },
    ],
  };
  server.serverFiles = {
    "/home/liam/app/main.py": 'open("missing.txt")\n',
    "/home/liam/app/README.md": "# App\n\nRead [the guide](https://guide.example.com/).\n\n<script>alert(1)</script>\n",
    "/home/liam/app/index.html": '<h1>Hi</h1><script>parent.__TAURI_INTERNALS__.invoke("password_load")</script>',
    "/home/liam/app/logo.png": "\x89PNG\r\n\x1a\nimage",
    "/home/liam/app/app.bin": "\x7fELF\0\0\0\0",
    "/home/liam/app/.env": "SECRET=1",
  };
  const hermes = await connect(server.openPipe);
  const user = userEvent.setup();
  render(
    <Main
      hermes={hermes}
      connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }}
      localFiles={local}
      webPages={web}
      serverPages={pages}
      onSignOut={async () => {}}
    />,
  );
  await user.click(await screen.findByRole("button", { name: /Fix the app/ }));
  await screen.findByText(/It reads a missing file/);
  await settle(hermes);
  return { server, hermes, user, local, web, pages };
}

/** Opens the chat's tool calls, then the one named `name`. */
async function openTool(user: ReturnType<typeof userEvent.setup>, name: string) {
  const group = screen.queryByRole("button", { name: /3 tool calls/ });
  if (group?.getAttribute("aria-expanded") === "false") await user.click(group);
  await user.click(screen.getAllByRole("button", { name: new RegExp(`^${name}`) })[0]);
}

describe("Opening the preview pane", () => {
  it("opens a link from a reply in the pane, in a frame that can't reach the app, and leaves the chat as it was", async () => {
    const { user, server, hermes } = await signedIn();
    const link = screen.getByRole("link", { name: "the docs" });
    // A plain click would have replaced the app's own window with the page.
    expect(fireEvent.click(link)).toBe(false);

    const frame = await within(pane()).findByTitle("Web page: https://docs.example.com/crash");
    expect(frame.getAttribute("src")).toBe("https://docs.example.com/crash");
    const sandbox = frame.getAttribute("sandbox")!.split(" ");
    expect(sandbox.sort()).toEqual(["allow-forms", "allow-same-origin", "allow-scripts"]);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(within(pane()).getByText("Web")).toBeTruthy();
    expect(within(pane()).getByRole("status").textContent).toContain("Loading page");

    // The chat is still there and still sends.
    await user.type(screen.getByPlaceholderText("Message Hermes"), "Thanks{Enter}");
    await settle(hermes);
    expect(server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text)).toEqual(["Thanks"]);
    expect((screen.getByPlaceholderText("Message Hermes") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText(/It reads a missing file/)).toBeTruthy();
  });

  it("doesn't follow a link that isn't a web page", async () => {
    await signedIn();
    expect(fireEvent.click(screen.getByRole("link", { name: "a mail" }))).toBe(false);
    expect(paneOpen()).toBe(false);
  });

  it("opens the server file a tool call read, saying it is on the server", async () => {
    const { server, user } = await signedIn();
    // Hermes takes its time answering, so the pane shows it is loading.
    let answer = () => {};
    const readText = server.rest["GET /api/fs/read-text"];
    server.rest["GET /api/fs/read-text"] = (req) => new Promise((resolve) => (answer = () => resolve(readText(req))));
    await openTool(user, "read_file");
    await user.click(screen.getByRole("button", { name: "main.py" }));

    expect((await within(pane()).findByRole("status")).textContent).toContain("Loading main.py");
    act(() => answer());
    expect(await within(pane()).findByText(/missing\.txt/)).toBeTruthy();
    server.rest["GET /api/fs/read-text"] = readText;
    expect(within(pane()).getByText("Server").title).toContain("(liam@hermes)");
    expect(address().value).toBe("/home/liam/app/main.py");
    expect(fsReads(server).map((r) => [r.path, r.query.get("path"), r.query.get("profile")])).toEqual([
      ["/api/fs/read-text", "/home/liam/app/main.py", "default"],
    ]);

    await user.click(within(pane()).getByRole("button", { name: "Reload" }));
    await within(pane()).findByText(/missing\.txt/);
    expect(fsReads(server)).toHaveLength(2);
  });

  it("opens the page a browser tool visited, and a tool call's output", async () => {
    const { user } = await signedIn();
    await openTool(user, "browser_navigate");
    await user.click(screen.getByRole("button", { name: "crash" }));
    expect(await within(pane()).findByTitle("Web page: https://docs.example.com/crash")).toBeTruthy();

    await openTool(user, "patch");
    await user.click(screen.getByRole("button", { name: "Output" }));
    expect(within(pane()).getByText("Tool output")).toBeTruthy();
    expect(within(pane()).getByText(/"success": true/)).toBeTruthy();
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();
  });

  it("opens empty from the chat header, where the owner types a server path or web address", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    expect(within(pane()).getByRole("heading", { name: "Nothing open" })).toBeTruthy();
    expect([button("Back").disabled, button("Forward").disabled, button("Reload").disabled]).toEqual([true, true, true]);
    const box = address();

    await user.type(box, "notes.md{Enter}");
    expect(within(pane()).getByRole("alert").textContent).toContain("starting with / or ~/");
    await user.clear(box);
    await user.type(box, "file:///home/liam/notes.md{Enter}");
    expect(within(pane()).getByRole("alert").textContent).toBe("To preview a file on this computer, use Open a file on this computer.");
    await user.clear(box);
    await user.type(box, `${location.origin}/{Enter}`);
    expect(within(pane()).getByRole("alert").textContent).toBe("Hermes Chat's own pages don't open in the preview.");

    await user.clear(box);
    await user.type(box, "/home/liam/app/README.md{Enter}");
    expect(await within(pane()).findByRole("heading", { name: "App" })).toBeTruthy();
  });
});

describe("What the pane shows", () => {
  async function openPath(path: string) {
    const s = await signedIn();
    await s.user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await s.user.type(address(), `${path}{Enter}`);
    return s;
  }

  it("renders a Markdown file without its raw HTML, and its links open in the pane", async () => {
    const { user } = await openPath("/home/liam/app/README.md");
    await within(pane()).findByRole("heading", { name: "App" });
    expect(pane().querySelector("script")).toBeNull();
    expect(within(pane()).getByText("<script>alert(1)</script>")).toBeTruthy();

    await user.click(within(pane()).getByRole("button", { name: "Source" }));
    expect(within(pane()).getByText(/# App/)).toBeTruthy();

    await user.click(within(pane()).getByRole("button", { name: "Rendered" }));
    await user.click(within(pane()).getByRole("link", { name: "the guide" }));
    expect(await within(pane()).findByTitle("Web page: https://guide.example.com/")).toBeTruthy();
  });

  it("renders an HTML file with scripts, forms and the network off", async () => {
    await openPath("/home/liam/app/index.html");
    const frame = await within(pane()).findByTitle("Rendered /home/liam/app/index.html");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toMatch(/^<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
    expect(frame.getAttribute("src")).toBeNull();
  });

  it("shows an image", async () => {
    await openPath("/home/liam/app/logo.png");
    const img = await within(pane()).findByRole("img", { name: "logo.png" });
    expect(img.getAttribute("src")).toBe(`data:image/png;base64,${btoa("\x89PNG\r\n\x1a\nimage")}`);
  });

  it("says why it can't show a binary file, a missing one, or one with credentials", async () => {
    const { user } = await openPath("/home/liam/app/app.bin");
    expect((await within(pane()).findByRole("note")).textContent).toBe("No preview for this fileThe preview can't show binary files. It's 8 B.");

    for (const [path, why] of [
      ["/home/liam/app/gone.py", "There's no file at this path on the Hermes server."],
      ["/home/liam/app/.env", "Hermes doesn't show this file, since it may hold credentials."],
    ]) {
      await user.clear(address());
      await user.type(address(), `${path}{Enter}`);
      expect((await within(pane()).findByRole("alert")).textContent).toBe(`Couldn't open this file${why}`);
    }
  });

  it("opens a file from this computer, labelled as local, and never asks Hermes for it", async () => {
    const local = localDisk({
      "/home/me/todo.txt": { kind: "text", text: "buy milk", language: "", format: "code", size: 8, truncated: false },
      "/home/me/locked.txt": new Error("Permission denied (os error 13)"),
    });
    const { server, user } = await signedIn({ local });
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));

    local.next = null;
    await user.click(button("Open a file on this computer…"));
    expect(within(pane()).getByRole("heading", { name: "Nothing open" })).toBeTruthy();

    local.next = { path: "/home/me/todo.txt", name: "todo.txt" };
    await user.click(button("Open a file on this computer…"));
    expect(await within(pane()).findByText("buy milk")).toBeTruthy();
    expect(within(pane()).getByText("This computer")).toBeTruthy();
    expect(within(pane()).queryByText("Server")).toBeNull();
    expect(address().value).toBe("/home/me/todo.txt");
    expect(fsReads(server)).toEqual([]);

    local.next = { path: "/home/me/locked.txt", name: "locked.txt" };
    await user.click(button("More"));
    await user.click(within(pane()).getByRole("menuitem", { name: "Open a file on this computer…" }));
    expect((await within(pane()).findByRole("alert")).textContent).toContain("Permission denied (os error 13)");
    expect(button("Back").disabled).toBe(false);
  });
});

describe("Web pages a site won't let the pane show (issue #55)", () => {
  const GOOGLE = "https://www.google.com/";
  /**
   * What WebKitGTK 2.54 did for both www.google.com and example.com: the frame's `load` fired within a few hundred
   * milliseconds, and its location then threw a SecurityError, whether the page showed or was refused.
   */
  const loadCrossOrigin = (frame: HTMLElement) => {
    Object.defineProperty(frame, "contentWindow", {
      get: () => ({
        get location() {
          throw new DOMException("Blocked a frame from accessing a cross-origin frame.", "SecurityError");
        },
      }),
    });
    fireEvent.load(frame);
  };
  async function openWeb(url: string, web: ReturnType<typeof theWeb>) {
    const s = await signedIn({ web });
    await s.user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await s.user.type(address(), `${url}{Enter}`);
    return s;
  }

  it("says a site refuses to be shown, instead of a blank frame, and opens it in the browser", async () => {
    // What www.google.com answers: WebKitGTK fires the frame's load at once and leaves it white.
    let answer = (_: Framing) => {};
    const web = theWeb({ [GOOGLE]: new Promise<Framing>((resolve) => (answer = resolve)) });
    const { user } = await openWeb(GOOGLE, web);
    loadCrossOrigin(within(pane()).getByTitle(`Web page: ${GOOGLE}`));
    expect(within(pane()).queryByRole("status")).toBeNull();
    expect(web.checked).toEqual([GOOGLE]);

    await act(async () => answer({ kind: "refused", by: "X-Frame-Options: SAMEORIGIN" }));
    const note = within(pane()).getByRole("alert");
    expect(note.textContent).toContain("www.google.com doesn't allow being shown inside other apps");
    expect(note.textContent).toContain("X-Frame-Options: SAMEORIGIN");
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();
    // The address is still there to copy.
    expect(address().value).toBe(GOOGLE);

    await user.click(within(note).getByRole("button", { name: "Open in your browser" }));
    expect(web.opened).toEqual([GOOGLE]);
    expect((await within(pane()).findByText("Opened in Helium Browser.")).getAttribute("role")).toBe("status");

    // The owner may still try, in the same sandboxed frame.
    await user.click(within(note).getByRole("button", { name: "Try showing it here anyway" }));
    const again = within(pane()).getByTitle(`Web page: ${GOOGLE}`);
    expect(again.getAttribute("sandbox")!.split(" ").sort()).toEqual(["allow-forms", "allow-same-origin", "allow-scripts"]);
    expect(within(pane()).getAllByRole("status").some((e) => e.textContent?.includes("Loading page"))).toBe(true);
  });

  it("keeps showing a page that allows framing, with a way to open it in the browser", async () => {
    const web = theWeb();
    const { user } = await openWeb("https://example.com/", web);
    const frame = within(pane()).getByTitle("Web page: https://example.com/");
    await act(async () => {});
    loadCrossOrigin(frame);
    expect(web.checked).toEqual(["https://example.com/"]);
    expect(within(pane()).queryByRole("alert")).toBeNull();
    expect(within(pane()).queryByRole("status")).toBeNull();
    expect(frame.isConnected).toBe(true);

    await user.click(button("Open in your browser"));
    expect(web.opened).toEqual(["https://example.com/"]);

    // Reload asks again.
    await user.click(within(pane()).getByRole("button", { name: "Reload" }));
    expect(web.checked).toEqual(["https://example.com/", "https://example.com/"]);
  });

  it("says a site can't be reached rather than loading forever, until the frame loads after all", async () => {
    const url = "http://127.0.0.1:4599/";
    const web = theWeb({ [url]: { kind: "unreachable", message: "Connection refused (os error 111)" } });
    const { user } = await openWeb(url, web);
    // On this computer's own loopback, not the server's.
    await user.click(await within(pane()).findByRole("button", { name: "Server" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't reach 127.0.0.1:4599");
    expect(alert.textContent).toContain("Connection refused (os error 111)");
    // The frame stays: this computer's browser engine may reach what Rust couldn't.
    loadCrossOrigin(within(pane()).getByTitle(`Web page: ${url}`));
    expect(within(pane()).queryByRole("alert")).toBeNull();
  });

  it("leaves the frame alone when the check itself fails, and says why the browser didn't open", async () => {
    const web = theWeb({ [GOOGLE]: new Error("not running in Tauri") }, "No default browser is set.");
    const { user } = await openWeb(GOOGLE, web);
    await act(async () => {});
    expect(within(pane()).getByTitle(`Web page: ${GOOGLE}`)).toBeTruthy();
    expect(within(pane()).queryByRole("alert")).toBeNull();

    await user.click(within(pane()).getByRole("button", { name: "Open in your browser" }));
    expect((await within(pane()).findByRole("alert")).textContent).toBe(
      "Couldn't open it in your browser: No default browser is set.",
    );
  });
});

const BOX = { x: 800, y: 137, width: 480, height: 683 };
const stubLayout = () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("preview-web-frame") ? ({ ...BOX, top: BOX.y, left: BOX.x, right: 1280, bottom: 820 } as DOMRect) : rect.call(this);
  });
};
async function withView(over: Parameters<typeof signedIn>[0] = {}) {
  stubLayout();
  const view = theView();
  const web = Object.assign(over.web ?? theWeb(), { native: view });
  return { ...(await signedIn({ ...over, web })), view, web };
}

describe("Web pages in the Preview's own view, on Linux (issue #254)", () => {
  const GOOGLE = "https://www.google.com/";
  afterEach(() => vi.restoreAllMocks());
  async function openWeb(url: string) {
    const s = await withView();
    await s.user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await s.user.type(address(), `${url}{Enter}`);
    return s;
  }

  it("shows a site that refuses framing, such as www.google.com, in its view and never in a frame", async () => {
    const { view, web, user } = await openWeb(GOOGLE);
    expect(view.asked).toEqual([[1, `go ${GOOGLE}`]]);
    expect(document.querySelector("iframe")).toBeNull();
    // Nothing asks whether the site refuses framing: the view is no frame.
    expect(web.checked).toEqual([]);
    expect(view.placed.get(1)).toBeUndefined();
    expect(within(pane()).getByRole("status").textContent).toContain("Loading page");

    await act(async () => view.land(1));
    expect(view.placed.get(1)).toEqual({ rect: BOX, holes: [] });
    expect(within(pane()).queryByRole("status")).toBeNull();
    expect(within(pane()).queryByRole("alert")).toBeNull();

    await user.click(button("Open in your browser"));
    expect(web.opened).toEqual([GOOGLE]);
  });

  it("says why a page couldn't load, and hides it", async () => {
    const { view } = await openWeb(GOOGLE);
    await act(async () => view.land(1));
    await act(async () => view.say(1, { kind: "failed", message: "Error resolving “www.google.com”: Name or service not known" }));
    expect(view.placed.get(1)).toBeNull();
    const alert = within(pane()).getByRole("alert");
    expect(alert.textContent).toContain("Couldn't load www.google.com");
    expect(alert.textContent).toContain("Name or service not known");
  });

  it("reloads the page in the same view, keeping it shown, and ends the view when the Preview goes out of sight", async () => {
    const { view, user } = await openWeb(GOOGLE);
    await act(async () => view.land(1));
    await user.click(button("Reload"));
    expect(view.asked).toEqual([
      [1, `go ${GOOGLE}`],
      [1, "reload"],
    ]);
    expect(view.made).toBe(1);
    expect(view.placed.get(1)).toEqual({ rect: BOX, holes: [] });
    expect(button("Reload").className).toContain("preview-busy");
    await act(async () => view.say(1, at(GOOGLE, true)));
    expect(button("Reload").className).not.toContain("preview-busy");

    await user.click(within(pane()).getByRole("tab", { name: /Files/ }));
    expect(view.placed.get(1)).toBeNull();
    expect(view.closed).toEqual([1]);
  });

  it("takes the keyboard back when the owner presses Escape in the page, so the next Escape closes the Preview", async () => {
    const { view, user } = await openWeb(GOOGLE);
    await act(async () => view.land(1));
    // The owner clicked into the page: the app's webview has no focus.
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => view.say(1, { kind: "escaped" }));
    expect(pane().contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(paneOpen()).toBe(false);
    expect(view.closed).toEqual([1]);
  });

  it("loads a page on the Hermes server through its SSH tunnel, and closes both with the Preview", async () => {
    const { view, user, pages } = await withView();
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    await waitFor(() => expect(view.asked).toEqual([[1, "go http://127.0.0.1:41001/app?v=2"]]));
    expect(pages.opened).toEqual(["http://localhost:5173/"]);
    expect(address().value).toBe("localhost:5173/app?v=2");

    await user.click(button("Close the side panel"));
    expect(view.closed).toEqual([1]);
    expect(pages.closed).toEqual(["1"]);
  });
});

describe("Back, Forward and Reload (issue #376)", () => {
  const TUNNEL = "http://127.0.0.1:41001";
  afterEach(() => vi.restoreAllMocks());
  async function devServer() {
    const s = await withView();
    await s.user.click(screen.getByRole("link", { name: "the dev server" }));
    await waitFor(() => expect(s.view.asked).toHaveLength(1));
    await act(async () => s.view.land(1));
    return s;
  }

  it("follows a link clicked in the page, then goes back and forward in the same view", async () => {
    const { user, view, pages } = await devServer();
    expect(button("Back").disabled).toBe(true);
    await act(async () => view.say(1, at(`${TUNNEL}/notes`)));
    expect(address().value).toBe("localhost:5173/notes");
    expect(button("Back").disabled).toBe(false);
    expect(view.asked, "a link the page followed asks nothing of the view").toHaveLength(1);

    await user.click(button("Back"));
    expect(view.asked.at(-1)).toEqual([1, `go ${TUNNEL}/app?v=2`]);
    expect(address().value).toBe("localhost:5173/app?v=2");
    await act(async () => view.land(1));
    expect([button("Back").disabled, button("Forward").disabled]).toEqual([true, false]);

    await user.click(button("Forward"));
    expect(view.asked.at(-1)).toEqual([1, `go ${TUNNEL}/notes`]);
    await act(async () => view.land(1));
    expect(address().value).toBe("localhost:5173/notes");
    expect([button("Back").disabled, button("Forward").disabled]).toEqual([false, true]);

    await user.click(button("Reload"));
    expect(view.asked.at(-1)).toEqual([1, "reload"]);
    expect(view.made).toBe(1);
    expect(pages.opened).toHaveLength(1);
  });

  it("follows the page's own moves: pushState, replaceState and its own history.back()", async () => {
    const { view } = await devServer();
    await act(async () => view.say(1, at(`${TUNNEL}/a`)));
    await act(async () => view.say(1, at(`${TUNNEL}/b`, true)));
    expect(address().value).toBe("localhost:5173/b");
    expect(button("Back").disabled).toBe(false);
    await act(async () => view.say(1, at(`${TUNNEL}/app?v=2`)));
    expect(address().value).toBe("localhost:5173/app?v=2");
    expect([button("Back").disabled, button("Forward").disabled]).toEqual([true, false]);
    expect(view.asked).toHaveLength(1);
  });

  it("goes back from a reply link to the dev server in the same view, through the same tunnel", async () => {
    const { user, view, pages } = await devServer();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(view.asked.at(-1)).toEqual([1, "go https://docs.example.com/crash"]);
    await act(async () => view.land(1));
    expect(within(pane()).getByText("Web")).toBeTruthy();
    expect(address().value).toBe("https://docs.example.com/crash");

    await user.click(button("Back"));
    expect(view.asked.at(-1)).toEqual([1, `go ${TUNNEL}/app?v=2`]);
    expect(view.made).toBe(1);
    expect(pages.opened).toHaveLength(1);
    expect(pages.closed).toEqual([]);
  });

  it("goes back from a server file to the page, which loads again in a new view through a new tunnel", async () => {
    const { user, view, pages } = await devServer();
    await user.clear(address());
    await user.type(address(), "/home/liam/app/main.py{Enter}");
    await within(pane()).findByText(/missing\.txt/);
    expect(view.closed).toEqual([1]);
    expect(pages.closed).toEqual(["1"]);

    await user.click(button("Back"));
    await waitFor(() => expect(view.asked.at(-1)).toEqual([2, "go http://127.0.0.1:41002/app?v=2"]));
    expect(button("Forward").disabled).toBe(false);
    await user.click(button("Forward"));
    expect(await within(pane()).findByText(/missing\.txt/)).toBeTruthy();
  });

  it("keeps a page on the server when it moves after its tunnel closed, and Try again reopens it there", async () => {
    const { user, view, pages } = await devServer();
    act(() => pages.drop("1", "ssh ended: Connection to hermes closed by remote host."));
    expect((await within(pane()).findByRole("alert")).textContent).toContain("The SSH tunnel to this page closed");
    await act(async () => view.say(1, at(`${TUNNEL}/app?v=3`, true)));
    expect(address().value).toBe("localhost:5173/app?v=3");
    await act(async () => view.say(1, at(`${TUNNEL}/other`)));
    expect(address().value).toBe("localhost:5173/other");
    expect(within(pane()).queryByRole("button", { name: "This computer" })).toBeNull();
    expect(button("Server")).toBeTruthy();

    await user.click(button("Try again"));
    await waitFor(() => expect(view.asked.at(-1)).toEqual([1, "go http://127.0.0.1:41002/other"]));
    expect(pages.opened).toHaveLength(2);
    await user.click(button("Back"));
    expect(address().value).toBe("localhost:5173/app?v=3");
  });

  it("shows the page again when Back returns to it after a typed address failed to load", async () => {
    const GOOGLE = "https://www.google.com/";
    const { view, user } = await withView();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await user.type(address(), `${GOOGLE}{Enter}`);
    await act(async () => view.land(1));
    await user.clear(address());
    await user.type(address(), "https://down.example/{Enter}");
    await act(async () => view.say(1, { kind: "failed", message: "Could not connect: Connection refused" }));
    expect(within(pane()).getByRole("alert").textContent).toContain("Couldn't load down.example");
    expect(view.placed.get(1)).toBeNull();

    await user.click(button("Back"));
    expect(address().value).toBe(GOOGLE);
    expect(within(pane()).queryByRole("alert")).toBeNull();
    expect(view.placed.get(1), "the view still holds www.google.com").toEqual({ rect: BOX, holes: [] });

    await user.click(button("Forward"));
    expect(view.asked.at(-1)).toEqual([1, "go https://down.example/"]);
    await act(async () => view.say(1, { kind: "failed", message: "Could not connect: Connection refused" }));
    await user.click(button("Back"));
    expect(within(pane()).queryByRole("alert")).toBeNull();
    expect(view.placed.get(1)).toEqual({ rect: BOX, holes: [] });
  });

  it("goes back, forward and reloads in the frame where there is no view (Windows)", async () => {
    const { user } = await signedIn();
    const frame = (url: string) => within(pane()).findByTitle(`Web page: ${url}`);
    await user.click(screen.getByRole("link", { name: "the docs" }));
    await frame("https://docs.example.com/crash");
    await user.clear(address());
    await user.type(address(), "https://other.example/{Enter}");
    expect((await frame("https://other.example/")).getAttribute("src")).toBe("https://other.example/");

    await user.click(button("Back"));
    expect((await frame("https://docs.example.com/crash")).getAttribute("src")).toBe("https://docs.example.com/crash");
    expect(address().value).toBe("https://docs.example.com/crash");
    await user.click(button("Forward"));
    const before = await frame("https://other.example/");
    expect(address().value).toBe("https://other.example/");

    await user.click(button("Reload"));
    const after = await frame("https://other.example/");
    expect(after, "Reload loads the page again in a new frame").not.toBe(before);
    expect(after.getAttribute("src")).toBe("https://other.example/");
  });

  it("shows where the owner left it after another tab, with Back still there", async () => {
    const { user, view } = await devServer();
    await act(async () => view.say(1, at(`${TUNNEL}/notes`)));
    await user.click(within(pane()).getByRole("tab", { name: /Files/ }));
    expect(view.closed).toEqual([1]);
    await user.click(within(pane()).getByRole("tab", { name: /Preview/ }));
    expect(address().value).toBe("localhost:5173/notes");
    expect(button("Back").disabled).toBe(false);
    await waitFor(() => expect(view.asked.at(-1)).toEqual([2, "go http://127.0.0.1:41002/notes"]));
  });

  it("keeps what the owner is typing while the page moves, and puts the address back on Escape", async () => {
    const { user, view } = await devServer();
    await user.clear(address());
    await user.type(address(), "localhost:3000");
    await act(async () => view.say(1, at(`${TUNNEL}/notes`)));
    expect(address().value).toBe("localhost:3000");
    await user.keyboard("{Escape}");
    expect(address().value).toBe("localhost:5173/notes");
    expect(paneOpen()).toBe(true);
  });

  it("switches a page between the server and this computer from its badge, keeping the tunnel for Back", async () => {
    const { user, view, pages } = await devServer();
    await user.click(button("Server"));
    expect(view.asked.at(-1)).toEqual([1, "go http://localhost:5173/app?v=2"]);
    await act(async () => view.land(1));
    expect(button("This computer")).toBeTruthy();
    expect(button("Back").disabled, "switching sides isn't a move").toBe(true);
    await user.clear(address());
    await user.type(address(), "localhost:5173/other{Enter}");
    expect(view.asked.at(-1), "a path typed on the same origin stays on this computer").toEqual([1, "go http://localhost:5173/other"]);
    await user.click(button("This computer"));
    expect(view.asked.at(-1)).toEqual([1, `go ${TUNNEL}/other`]);
    expect(pages.opened).toHaveLength(1);
  });
});

describe("Pages on the Hermes server's own loopback (issue #171)", () => {
  const APP_URL = "http://localhost:5173/app?v=2";
  const TUNNEL = "http://127.0.0.1:41001/app?v=2";
  const frameSrc = async () => (await within(pane()).findByTitle(`Web page: ${APP_URL}`)).getAttribute("src");

  it("opens a localhost link from a reply on the server through SSH, says so, and closes the tunnel with the preview", async () => {
    const { user, web, pages } = await signedIn();
    expect(screen.getByRole("link", { name: "the dev server" }).title).toBe(`${APP_URL}\nOpens in the preview, from the Hermes server`);
    await user.click(screen.getByRole("link", { name: "the dev server" }));

    // The frame loads the tunnel's end on this computer; the owner still sees the page's own address.
    expect(await frameSrc()).toBe(TUNNEL);
    expect(pages.opened).toEqual(["http://localhost:5173/"]);
    expect(address().value).toBe("localhost:5173/app?v=2");
    expect(button("Server").title).toBe(
      "localhost:5173 on the Hermes server, through SSH to liam@hermes. Click to open localhost:5173 on this computer instead.",
    );
    // The same sandbox as any web page.
    const frame = within(pane()).getByTitle(`Web page: ${APP_URL}`);
    expect(frame.getAttribute("sandbox")!.split(" ").sort()).toEqual(["allow-forms", "allow-same-origin", "allow-scripts"]);
    // The framing check asks the page through the tunnel too.
    expect(web.checked).toEqual([TUNNEL]);

    // The owner's browser reaches it only through the tunnel.
    await user.click(within(pane()).getByTitle(/^Open in your browser, through this page's SSH tunnel/));
    expect(web.opened).toEqual([TUNNEL]);

    expect(pages.closed).toEqual([]);
    await user.click(within(pane()).getByRole("button", { name: "Close the side panel" }));
    expect(pages.closed).toEqual(["1"]);
    expect(pages.live.size).toBe(0);
  });

  it("switches to this computer from the badge and back to the server, through the tunnel it kept", async () => {
    const { user, pages, web } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    expect(await frameSrc()).toBe(TUNNEL);

    await user.click(button("Server"));
    expect(await frameSrc()).toBe(APP_URL);
    expect(pane().querySelector(".where")!.textContent).toBe(" This computer");
    // Opening it in the browser is this computer's own address now.
    await user.click(button("Open in your browser"));
    expect(web.opened).toEqual([APP_URL]);

    await user.click(button("This computer"));
    expect(await frameSrc()).toBe(TUNNEL);
    expect(pages.opened).toEqual(["http://localhost:5173/"]);
    expect(pages.closed).toEqual([]);

    await user.click(button("Reload"));
    expect(await frameSrc()).toBe(TUNNEL);
    expect([...pages.live.keys()], "Reload keeps the tunnel").toEqual(["1"]);
  });

  it("says when the sign-in has no SSH target, and offers this computer instead", async () => {
    const pages = theServer(
      new ServerPageError("noSshTarget", "This sign-in uses a dashboard URL, so Hermes Chat has no SSH target to reach the server's own pages."),
    );
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("No SSH target for this server");
    expect(alert.textContent).toContain("This sign-in uses a dashboard URL");
    expect(alert.textContent).toContain("Sign in through SSH to reach pages on the server");
    // Trying again can't help.
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();

    await user.click(within(alert).getByRole("button", { name: "Open on this computer instead" }));
    expect(await frameSrc()).toBe(APP_URL);
    expect(pages.opened).toHaveLength(1);
    await user.click(button("This computer"));
    expect((await within(pane()).findByRole("alert")).textContent).toContain("No SSH target for this server");
    await user.click(button("Reload"));
    expect(pages.opened, "Reload tries a failed tunnel again").toHaveLength(2);
  });

  it("says when nothing answers at the port on the server, and tries again", async () => {
    const pages = theServer(new ServerPageError("portClosed", "Nothing on the Hermes server answered at localhost:5173. ssh said: channel 2: open failed: connect failed: Connection refused"));
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("Nothing answers at localhost:5173 on the server");
    expect(alert.textContent).toContain("Connection refused");
    expect(alert.textContent).toContain("try again in a moment");

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await frameSrc()).toBe("http://127.0.0.1:41002/app?v=2");
  });

  it("says when ssh fails, with what ssh said", async () => {
    const pages = theServer(new ServerPageError("ssh", "SSH failed: liam@hermes: Permission denied (publickey)."));
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't open an SSH tunnel to the server");
    expect(alert.textContent).toContain("Permission denied (publickey)");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Open on this computer instead" })).toBeTruthy();
  });

  it("says when the tunnel closes under the page, and opens a new one on Try again", async () => {
    const { user, pages } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    expect(await frameSrc()).toBe(TUNNEL);
    act(() => pages.drop("1", "ssh ended: Connection to hermes closed by remote host."));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("The SSH tunnel to this page closed");
    expect(alert.textContent).toContain("Connection to hermes closed by remote host.");
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();
    // Nothing to open in the browser without a tunnel.
    expect((within(pane()).getByTitle(/^Open in your browser/) as HTMLButtonElement).disabled).toBe(true);

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await frameSrc()).toBe("http://127.0.0.1:41002/app?v=2");
  });

  it("ends a tunnel still connecting when its page goes, without waiting for it", async () => {
    let ready = () => {};
    const pages = theServer(new Promise<void>((resolve) => (ready = resolve)));
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    expect(within(pane()).getByRole("status").textContent).toBe(" Opening localhost:5173 on the Hermes server, through SSH to liam@hermes…");
    await user.click(within(pane()).getByRole("button", { name: "Close the side panel" }));
    expect(pages.closed).toEqual(["1"]);
    expect(pages.live.size).toBe(0);
    // Its result, if it ever comes, changes nothing.
    await act(async () => ready());
    expect(pages.closed).toEqual(["1"]);
  });

  it("stays closed when the tunnel closes before its open result arrives", async () => {
    let ready = () => {};
    const pages = theServer(new Promise<void>((resolve) => (ready = resolve)));
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    act(() => pages.drop("1", "ssh ended: Connection reset by peer"));
    await act(async () => ready());
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("The SSH tunnel to this page closed");
    expect(alert.textContent).toContain("Connection reset by peer");
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();
    expect((within(pane()).getByTitle(/^Open in your browser/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says the tunnel closed when the app left the server while it connected", async () => {
    const pages = theServer(new ServerPageError("closed", "Hermes Chat left the Hermes server, so the tunnel to it closed."));
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("The SSH tunnel to this page closed");
    expect(alert.textContent).toContain("Hermes Chat left the Hermes server");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("loads nothing but the tunnel's own address on this computer", async () => {
    const pages = theServer({ url: "https://evil.example/" });
    const { user } = await signedIn({ pages });
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("The tunnel gave an address the preview doesn't load.");
    expect(within(pane()).queryByTitle(/^Web page/)).toBeNull();
    expect(pages.closed).toEqual(["1"]);
  });

  it("opens a typed localhost address on the server, and refuses what isn't a web address, saying why", async () => {
    const { user, pages } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    const box = address();
    await user.type(box, "ftp://localhost:21/{Enter}");
    expect(within(pane()).getByRole("alert").textContent).toBe("Only http:// and https:// pages open in the preview, and ftp: isn't a web address.");
    await user.clear(box);
    await user.type(box, "ssh://liam@hermes{Enter}");
    expect(within(pane()).getByRole("alert").textContent).toBe("Only http:// and https:// pages open in the preview, and ssh: isn't a web address.");
    expect(pages.opened).toEqual([]);

    await user.clear(box);
    await user.type(box, "localhost:5173{Enter}");
    expect((await within(pane()).findByTitle("Web page: http://localhost:5173/")).getAttribute("src")).toBe("http://127.0.0.1:41001/");
    expect(pages.opened).toEqual(["http://localhost:5173/"]);
  });

  it("leaves pages on other hosts on this computer, with no switch", async () => {
    const { user, pages } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(within(pane()).getByText("Web")).toBeTruthy();
    expect(within(pane()).queryByRole("button", { name: "Web" })).toBeNull();
    expect(pages.opened).toEqual([]);
  });
});

describe("The empty Preview (issue #376)", () => {
  const devServers = () => within(pane()).getByRole("region", { name: "Dev servers" });

  it("lists the dev servers on the server and on this computer, and opens one where it runs", async () => {
    const web = theWeb();
    web.devs = { server: { kind: "listed", ports: [{ port: 5173, process: "node" }, { port: 8000 }] }, local: [{ port: 3000, process: "next-server" }] };
    const { user, pages } = await signedIn({ web });
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await within(devServers()).findByRole("button", { name: /localhost:5173/ });
    expect(within(devServers()).getAllByRole("button", { name: /^localhost:/ }).map((b) => b.textContent)).toEqual([
      "localhost:5173Servernode",
      "localhost:8000Server",
      "localhost:3000This computernext-server",
    ]);

    await user.click(within(devServers()).getByRole("button", { name: /localhost:3000/ }));
    expect((await within(pane()).findByTitle("Web page: http://localhost:3000/")).getAttribute("src")).toBe("http://localhost:3000/");
    expect(button("This computer")).toBeTruthy();
    expect(pages.opened).toEqual([]);
  });

  it("opens a dev server on the Hermes server through SSH", async () => {
    const web = theWeb();
    web.devs = { server: { kind: "listed", ports: [{ port: 5173, process: "node" }] }, local: [] };
    const { user, pages } = await signedIn({ web });
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await user.click(await within(devServers()).findByRole("button", { name: /localhost:5173/ }));
    expect((await within(pane()).findByTitle("Web page: http://localhost:5173/")).getAttribute("src")).toBe("http://127.0.0.1:41001/");
    expect(pages.opened).toEqual(["http://localhost:5173/"]);
    expect(button("Server")).toBeTruthy();
  });

  it("says why the server's side has none, and looks again on its button and when the connection comes back", async () => {
    const web = theWeb();
    web.devs = { server: { kind: "noSshTarget" }, local: [] };
    const { user, server } = await signedIn({ web });
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    expect(await within(devServers()).findByText("Sign in through SSH to see the Hermes server's dev servers.")).toBeTruthy();

    web.devs = { server: { kind: "failed", message: "bash: line 1: ss: command not found" }, local: [] };
    await user.click(within(devServers()).getByRole("button", { name: "Look for dev servers again" }));
    expect(await within(devServers()).findByText("Couldn't list the Hermes server's: bash: line 1: ss: command not found")).toBeTruthy();

    web.devs = new Error("not running in Tauri");
    await user.click(within(devServers()).getByRole("button", { name: "Look for dev servers again" }));
    expect(await within(devServers()).findByText("Couldn't look for dev servers: not running in Tauri")).toBeTruthy();

    web.devs = { server: { kind: "listed", ports: [] }, local: [] };
    const looked = web.looked;
    await act(async () => server.drop());
    await waitFor(() => expect(web.looked).toBeGreaterThan(looked));
    expect(await within(devServers()).findByText("None found. Start one, or type its port above.")).toBeTruthy();
  });

  it("takes a dev server's bare port in the address box, as a page on the server", async () => {
    const { user, pages } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await user.type(address(), "5173{Enter}");
    expect((await within(pane()).findByTitle("Web page: http://localhost:5173/")).getAttribute("src")).toBe("http://127.0.0.1:41001/");
    expect(pages.opened).toEqual(["http://localhost:5173/"]);
    expect(address().value).toBe("localhost:5173");
  });

  it("keeps the note about what a page can reach, and copying the address, in the ⋯ menu", async () => {
    const { user } = await signedIn();
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
    await user.click(screen.getByRole("link", { name: "the docs" }));
    await user.click(button("More"));
    const menu = within(pane()).getByRole("menu", { name: "More" });
    expect(menu.textContent).toContain("Pages here run on their own, with no access to Hermes Chat or your sign-in, and only you can use them.");
    expect(menu.textContent, "a frame can't report a link followed inside it").toContain("Links you follow inside a page don't change the address here.");
    await user.click(within(menu).getByRole("menuitem", { name: "Copy address" }));
    expect(writes).toEqual(["https://docs.example.com/crash"]);
    expect(await within(pane()).findByText("Address copied.")).toBeTruthy();
  });
});

describe("Hermes can't drive the Preview (issue #376)", () => {
  afterEach(() => vi.restoreAllMocks());
  const ACTIONS = ["elements", "click", "hover", "type", "scroll", "press", "strobe", "back", "forward", "reload", "pin", "hold", "unpin"];

  it("turns down every preview request, and nothing reaches the page, its tunnel or the history", async () => {
    const { user, view, pages, server, hermes } = await withView();
    await user.click(screen.getByRole("link", { name: "the dev server" }));
    await waitFor(() => expect(view.asked).toHaveLength(1));
    await act(async () => view.land(1));
    await act(async () => view.say(1, at("http://127.0.0.1:41001/notes")));
    const asked = [...view.asked];
    const placed = view.placed.get(1);

    const runtime = server.runtimeIdOf("fix")!;
    const asks: [string, Record<string, unknown>][] = [
      ["preview.read", { start: 0, count: 50 }],
      ...ACTIONS.map((action): [string, Record<string, unknown>] => ["preview.act", { action, ref: "e1", selector: "a", text: "x", key: "Enter", url: "https://evil.example/" }]),
    ];
    for (const [method, params] of asks) {
      const id = server.ask(runtime, method, params);
      expect(id, method).toBeDefined();
      await settle(hermes);
      expect(server.responses.find((r) => r.id === id), `${method} ${params.action ?? ""}`).toMatchObject({ error: { code: -32601 } });
    }

    expect(view.asked).toEqual(asked);
    expect(view.made).toBe(1);
    expect(view.placed.get(1)).toEqual(placed);
    expect(view.closed).toEqual([]);
    expect(pages.opened).toEqual(["http://localhost:5173/"]);
    expect(address().value).toBe("localhost:5173/notes");
    expect([button("Back").disabled, button("Forward").disabled]).toEqual([false, true]);
  });
});

describe("Closing and resizing", () => {
  it("closes with its button, the header toggle, or Escape", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    await user.click(within(pane()).getByRole("button", { name: "Close the side panel" }));
    expect(paneOpen()).toBe(false);

    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    expect(screen.getByRole("button", { name: "Close the side panel", pressed: true })).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Close the side panel" })[0]);
    expect(paneOpen()).toBe(false);

    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await user.keyboard("{Escape}");
    expect(paneOpen()).toBe(false);
  });

  it("stops a page once it is out of sight, so a closed or covered preview plays and loads nothing", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(document.querySelector("iframe[title^='Web page']")).not.toBeNull();
    await user.click(within(pane()).getByRole("button", { name: "Close the side panel" }));
    expect(document.querySelector("iframe[title^='Web page']")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    expect(within(pane()).getByTitle("Web page: https://docs.example.com/crash")).toBeTruthy();
    await user.click(within(pane()).getByRole("tab", { name: /Files/ }));
    expect(document.querySelector("iframe[title^='Web page']")).toBeNull();
  });

  it("resizes from its edge with the keyboard, and keeps the width", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    const edge = screen.getByRole("separator", { name: "Resize the side panel" });
    expect(edge.getAttribute("aria-valuenow")).toBe("480");
    edge.focus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(edge.getAttribute("aria-valuenow")).toBe("544");
    expect(pane().style.width).toBe("544px");
    expect(getUIPrefs().previewWidth).toBe(544);
    await user.keyboard("{End}");
    expect(edge.getAttribute("aria-valuenow")).toBe("300");
  });

  it("resizes by dragging its edge", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    const edge = screen.getByRole("separator");
    fireEvent.pointerDown(edge, { button: 0, clientX: 800, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 700, pointerId: 1 });
    expect(pane().style.width).toBe("580px");
    expect(getUIPrefs().previewWidth).toBeNull();
    fireEvent.pointerUp(edge, { clientX: 650, pointerId: 1 });
    expect(pane().style.width).toBe("630px");
    expect(getUIPrefs().previewWidth).toBe(630);
  });

  it("covers the chat in a window too narrow for both, and goes back to the chat without closing", async () => {
    // The main area is 600 px wide: less than the chat's 440 beside the pane's 300.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe() {
          this.cb([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
      },
    );
    const { user } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(pane().className).toContain("overlay");
    expect(screen.queryByRole("separator")).toBeNull();
    expect(pane().contains(document.activeElement)).toBe(true);
    // The chat underneath can't be reached while the pane covers it.
    expect(document.querySelector(".main-chat")!.hasAttribute("inert")).toBe(true);

    await user.click(within(pane()).getByRole("button", { name: "Back to the chat" }));
    expect(paneOpen()).toBe(false);
    expect(document.querySelector(".main-chat")!.hasAttribute("inert")).toBe(false);
    await user.type(screen.getByPlaceholderText("Message Hermes"), "still here");

    await user.click(screen.getByRole("button", { name: "Show the side panel" }));
    expect(within(pane()).getByTitle("Web page: https://docs.example.com/crash")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(paneOpen()).toBe(false);
    expect(screen.getByRole("button", { name: "Show the side panel" })).toBeTruthy();
  });

  it("keeps Alt+arrows from switching the chat hidden under a covering preview", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe() {
          this.cb([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
      },
    );
    const { user, server, hermes } = await signedIn();
    const resumes = () => server.requests.filter((r) => r.method === "session.resume").length;
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(pane().className).toContain("overlay");
    const before = resumes();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await settle(hermes);
    expect(paneOpen()).toBe(true);
    expect(resumes()).toBe(before);
  });

  it.each(["chat", "new", "search", "split"])("shows the destination after %s navigation while the preview covers the chat", async (destination) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe() {
          this.cb([{ contentRect: { width: 700 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
      },
    );
    const { user, hermes } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(pane().className).toContain("overlay");
    if (destination === "new") {
      await user.click(screen.getByRole("button", { name: "New chat (Ctrl+N)" }));
    } else if (destination === "chat") {
      await user.click(screen.getByRole("button", { name: /Another chat/ }));
    } else if (destination === "split") {
      await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /Another chat/ }) });
      await user.click(screen.getByRole("menuitem", { name: "Open in a second pane" }));
    } else {
      await user.click(screen.getByRole("button", { name: "Search all chats (Ctrl+K)" }));
      await user.type(screen.getByPlaceholderText("Search all chats, including Settled"), "Another");
      await user.click(await within(screen.getByRole("dialog", { name: "Search chats" })).findByRole("button", { name: /Another chat/ }));
    }
    await settle(hermes);
    expect(paneOpen()).toBe(false);
    expect(document.querySelector(".main-chat")!.hasAttribute("inert")).toBe(false);
    const destinationPane = document.querySelector<HTMLElement>(destination === "split" ? ".pane.active" : ".pane")!;
    expect(within(destinationPane).getByPlaceholderText("Message Hermes")).toBeTruthy();
    if (destination !== "new") expect(destinationPane.querySelector(".chat-head")!.textContent).toContain("Another chat");
    if (destination === "split") {
      expect(document.querySelectorAll(".pane")).toHaveLength(2);
      expect(document.querySelector(".panes.covered")).toBeNull();
    }
    await user.click(within(destinationPane).getByRole("button", { name: "Show the side panel" }));
    expect(within(pane()).getByTitle("Web page: https://docs.example.com/crash")).toBeTruthy();
  });

  it("closes when the owner switches profile, and a Server file is then read for the new profile", async () => {
    const { server, user, hermes } = await signedIn();
    server.otherProfiles = { work: [] };
    await user.click(screen.getByRole("link", { name: "the docs" }));
    expect(paneOpen()).toBe(true);

    await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await user.click(await screen.findByRole("option", { name: /work/ }));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" }));
    expect(paneOpen()).toBe(false);

    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    expect(within(pane()).getByRole("heading", { name: "Nothing open" })).toBeTruthy();
    expect(button("Back").disabled).toBe(true);
    await user.type(address(), "/home/liam/app/main.py{Enter}");
    await within(pane()).findByText(/missing\.txt/);
    expect(fsReads(server).at(-1)!.query.get("profile")).toBe("work");
  });
});

describe("The link menu (issue #240)", () => {
  const DOCS = "https://docs.example.com/crash";
  const menuItems = () => screen.getAllByRole("menuitem").map((b) => b.textContent);
  const item = (name: string) => screen.getByRole("menuitem", { name });
  const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 40, clientY: 50 });
  /** The clipboard: `writes` records what was copied; `fails` makes writing reject with it; `missing` has no writeText. */
  function clipboard({ fails, missing }: { fails?: Error; missing?: boolean } = {}) {
    const writes: string[] = [];
    const writeText = async (t: string) => {
      if (fails) throw fails;
      writes.push(t);
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: missing ? {} : { writeText } });
    return writes;
  }

  it("offers the Preview, the browser and copying on a web link in a reply, instead of WebKit's own menu", async () => {
    const { user, web } = await signedIn();
    const link = screen.getByRole("link", { name: "the docs" });
    expect(rightClick(link)).toBe(false);
    expect(menuItems()).toEqual(["Open in the Preview", "Open in your browser", "Copy link"]);

    await user.click(item("Open in your browser"));
    expect(web.opened).toEqual([DOCS]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(paneOpen()).toBe(false);
    expect(await screen.findByText("Opened in Helium Browser.")).toBeTruthy();

    rightClick(link);
    await user.click(item("Open in the Preview"));
    expect(await within(pane()).findByTitle(`Web page: ${DOCS}`)).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(web.opened).toEqual([DOCS]);
  });

  it("says why the browser didn't open", async () => {
    const { user } = await signedIn({ web: theWeb({}, "Helium Browser stopped with exit code 1: cannot open display: wayland-1") });
    rightClick(screen.getByRole("link", { name: "the docs" }));
    await user.click(item("Open in your browser"));
    expect(await screen.findByText("Couldn't open it in your browser: Helium Browser stopped with exit code 1: cannot open display: wayland-1")).toBeTruthy();
    expect(screen.queryByText(/^Opened in/)).toBeNull();
  });

  it("copies the link and says so, or says why it couldn't", async () => {
    const { user } = await signedIn();
    const link = screen.getByRole("link", { name: "the docs" });
    const writes = clipboard();
    rightClick(link);
    await user.click(item("Copy link"));
    expect(await screen.findByText("Link copied.")).toBeTruthy();
    expect(writes).toEqual([DOCS]);

    clipboard({ fails: new Error("Write permission denied.") });
    rightClick(link);
    await user.click(item("Copy link"));
    expect(await screen.findByText("Couldn't copy the link: Write permission denied.")).toBeTruthy();

    clipboard({ missing: true });
    rightClick(link);
    await user.click(item("Copy link"));
    expect(await screen.findByText("Couldn't copy the link.")).toBeTruthy();
  });

  it("keeps a server page out of this computer's browser, and opens it in the Preview through SSH", async () => {
    const { user, web, pages } = await signedIn();
    const writes = clipboard();
    rightClick(screen.getByRole("link", { name: "the dev server" }));
    expect(menuItems()).toEqual(["Open in the Preview", "Open in your browser", "Copy link"]);
    const browser = item("Open in your browser");
    expect(browser.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("A server page opens in your browser only through the Preview.").id).toBe(browser.getAttribute("aria-describedby"));

    await user.click(browser);
    expect(web.opened).toEqual([]);
    expect(pages.opened).toEqual([]);

    await user.click(item("Copy link"));
    expect(writes).toEqual(["http://localhost:5173/app?v=2"]);

    rightClick(screen.getByRole("link", { name: "the dev server" }));
    await user.click(item("Open in the Preview"));
    await waitFor(() => expect(pages.opened).toEqual(["http://localhost:5173/"]));
    expect(web.opened).toEqual([]);
  });

  it("lets a mail link only be copied, as written", async () => {
    const { user } = await signedIn();
    const writes = clipboard();
    expect(rightClick(screen.getByRole("link", { name: "a mail" }))).toBe(false);
    expect(menuItems()).toEqual(["Copy link"]);
    await user.click(item("Copy link"));
    expect(writes).toEqual(["mailto:x@example.com"]);
  });

  it("leaves a same-page link's own menu alone, blocks it on an emptied file: link, and gives a web link in a previewed Markdown file the link menu", async () => {
    const { server, user } = await signedIn();
    server.serverFiles["/home/liam/app/GUIDE.md"] = "# Guide\n\nSee [Usage](#usage), [the site](https://guide.example.com/) and [the hosts file](file:///etc/hosts).\n\n## Usage\n\nRun it.\n";
    await user.click(screen.getByRole("button", { name: "Open the side panel" }));
    await user.click(within(pane()).getByRole("textbox"));
    await user.paste("/home/liam/app/GUIDE.md");
    await user.keyboard("{Enter}");
    await within(pane()).findByRole("heading", { name: "Guide" });

    expect(rightClick(within(pane()).getByRole("link", { name: "Usage" }))).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();

    // react-markdown empties a file: address, so there is nothing to copy, and WebKit's Open Link would load this page.
    const hosts = within(pane()).getByText("the hosts file");
    expect(hosts.getAttribute("href")).toBe("");
    expect(rightClick(hosts)).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();

    expect(rightClick(within(pane()).getByRole("link", { name: "the site" }))).toBe(false);
    expect(menuItems()).toEqual(["Open in the Preview", "Open in your browser", "Copy link"]);
  });

  it("opens from the keyboard on the focused link, and gives focus back on Escape", async () => {
    const { user } = await signedIn();
    const link = screen.getByRole("link", { name: "the docs" });
    link.focus();
    // The Menu key and Shift+F10 send a contextmenu with no pointer position.
    expect(fireEvent.contextMenu(link, { clientX: 0, clientY: 0 })).toBe(false);
    expect(document.activeElement).toBe(item("Open in the Preview"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("Open in your browser"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(link);
  });

  it("is on a tool call's web page chip too, and not on its file or Output chips", async () => {
    const { user, web } = await signedIn();
    await openTool(user, "browser_navigate");
    expect(rightClick(screen.getByRole("button", { name: "crash" }))).toBe(false);
    expect(menuItems()).toEqual(["Open in the Preview", "Open in your browser", "Copy link"]);
    await user.click(item("Open in your browser"));
    expect(web.opened).toEqual([DOCS]);

    await openTool(user, "read_file");
    expect(rightClick(screen.getByRole("button", { name: "main.py" }))).toBe(true);
    await openTool(user, "patch");
    expect(rightClick(screen.getByRole("button", { name: "Output" }))).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
