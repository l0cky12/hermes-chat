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
import type { FileView, Framing } from "../hermes/preview";
import type { LocalFiles, WebPages } from "./tauriPreview";
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
  const el = document.querySelector<HTMLElement>("aside.preview");
  if (!el) throw new Error("The preview pane isn't open");
  return el;
};
const paneOpen = () => !!document.querySelector("aside.preview");
const fsReads = (s: FakeHermes) => s.restRequests.filter((r) => r.path.startsWith("/api/fs/"));

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

/**
 * The web as Rust's framing check sees it (src-tauri/src/web_page.rs): each address answers as `answers` says, and any
 * other answers that nothing refused. `checked` and `opened` record what the pane asked for.
 */
function theWeb(answers: Record<string, Framing | Error | Promise<Framing>> = {}, openFails?: string) {
  const web: WebPages & { checked: string[]; opened: string[] } = {
    checked: [],
    opened: [],
    check: async (url) => {
      web.checked.push(url);
      const a = answers[url] ?? { kind: "notRefused" };
      if (a instanceof Error) throw a;
      return a;
    },
    openInBrowser: async (url) => {
      if (openFails) throw new Error(openFails);
      web.opened.push(url);
    },
  };
  return web;
}

/**
 * Signed in, with the chat "Fix the app" open: a reply with a link, then a read_file call on a server file, a
 * browser_navigate call and a terminal call.
 */
async function signedIn({ local = localDisk({}), web = theWeb() } = {}) {
  const server = new FakeHermes();
  server.sessions = [row("fix", 1, { pinned: true, title: "Fix the app" }), row("other", 2, { pinned: true, title: "Another chat" })];
  server.transcripts = {
    fix: [
      { role: "user", text: "Why does the app crash?" },
      { role: "tool", name: "read_file", context: "main.py", args: { path: "/home/liam/app/main.py" } },
      { role: "tool", name: "browser_navigate", context: "docs", args: { url: "https://docs.example.com/crash" } },
      { role: "tool", name: "patch", context: "main.py", args: { path: "/home/liam/app/main.py" }, content: '{"success": true, "diff": "-a\\n+b"}' },
      { role: "assistant", text: "It reads a missing file. See [the docs](https://docs.example.com/crash) and [a mail](mailto:x@example.com)." },
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
    <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} localFiles={local} webPages={web} onSignOut={async () => {}} />,
  );
  await user.click(await screen.findByRole("button", { name: /Fix the app/ }));
  await screen.findByText(/It reads a missing file/);
  await settle(hermes);
  return { server, hermes, user, local, web };
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
    expect(within(pane()).getByText("Server · liam@hermes")).toBeTruthy();
    expect(within(pane()).getByText("/home/liam/app/main.py")).toBeTruthy();
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

  it("opens from the chat header, where the owner types a server path or web address", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the preview" }));
    const box = within(pane()).getByRole("textbox", { name: "Web address or path on the Hermes server" });
    expect(within(pane()).getByText("liam@hermes")).toBeTruthy();

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
    await s.user.click(screen.getByRole("button", { name: "Open the preview" }));
    await s.user.type(within(pane()).getByRole("textbox"), `${path}{Enter}`);
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
      await user.click(within(pane()).getByRole("button", { name: "Open something else" }));
      await user.type(within(pane()).getByRole("textbox"), `${path}{Enter}`);
      expect((await within(pane()).findByRole("alert")).textContent).toBe(`Couldn't open this file${why}`);
    }
  });

  it("opens a file from this computer, labelled as local, and never asks Hermes for it", async () => {
    const local = localDisk({
      "/home/me/todo.txt": { kind: "text", text: "buy milk", language: "", format: "code", size: 8, truncated: false },
      "/home/me/locked.txt": new Error("Permission denied (os error 13)"),
    });
    const { server, user } = await signedIn({ local });
    await user.click(screen.getByRole("button", { name: "Open the preview" }));

    local.next = null;
    await user.click(within(pane()).getByRole("button", { name: "Open a file on this computer…" }));
    expect(within(pane()).getByRole("textbox")).toBeTruthy();

    local.next = { path: "/home/me/todo.txt", name: "todo.txt" };
    await user.click(within(pane()).getByRole("button", { name: "Open a file on this computer…" }));
    expect(await within(pane()).findByText("buy milk")).toBeTruthy();
    expect(within(pane()).getByText("This computer")).toBeTruthy();
    expect(within(pane()).queryByText(/Server ·/)).toBeNull();
    expect(fsReads(server)).toEqual([]);

    await user.click(within(pane()).getByRole("button", { name: "Open something else" }));
    local.next = { path: "/home/me/locked.txt", name: "locked.txt" };
    await user.click(within(pane()).getByRole("button", { name: "Open a file on this computer…" }));
    expect((await within(pane()).findByRole("alert")).textContent).toContain("Permission denied (os error 13)");
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
    await s.user.click(screen.getByRole("button", { name: "Open the preview" }));
    await s.user.type(within(pane()).getByRole("textbox"), `${url}{Enter}`);
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
    expect(within(pane()).getByText(GOOGLE)).toBeTruthy();

    await user.click(within(note).getByRole("button", { name: "Open in your browser" }));
    expect(web.opened).toEqual([GOOGLE]);

    // The owner may still try, in the same sandboxed frame.
    await user.click(within(note).getByRole("button", { name: "Try showing it here anyway" }));
    const again = within(pane()).getByTitle(`Web page: ${GOOGLE}`);
    expect(again.getAttribute("sandbox")!.split(" ").sort()).toEqual(["allow-forms", "allow-same-origin", "allow-scripts"]);
    expect(within(pane()).getByRole("status").textContent).toContain("Loading page");
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

    await user.click(within(pane()).getByRole("button", { name: "open it in your browser" }));
    await user.click(within(pane()).getByRole("button", { name: "Open in your browser" }));
    expect(web.opened).toEqual(["https://example.com/", "https://example.com/"]);

    // Reload asks again.
    await user.click(within(pane()).getByRole("button", { name: "Reload" }));
    expect(web.checked).toEqual(["https://example.com/", "https://example.com/"]);
  });

  it("says a site can't be reached rather than loading forever, until the frame loads after all", async () => {
    const url = "http://127.0.0.1:4599/";
    const web = theWeb({ [url]: { kind: "unreachable", message: "Connection refused (os error 111)" } });
    await openWeb(url, web);
    const alert = await within(pane()).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't reach 127.0.0.1:4599");
    expect(alert.textContent).toContain("Connection refused (os error 111)");
    // The frame stays: this computer's browser engine may reach what Rust couldn't.
    loadCrossOrigin(within(pane()).getByTitle(`Web page: ${url}`));
    expect(within(pane()).queryByRole("alert")).toBeNull();
  });

  it("leaves the frame alone when the check itself fails, and says why the browser didn't open", async () => {
    const web = theWeb({ [GOOGLE]: new Error("not running in Tauri") }, "Couldn't find xdg-open, which opens pages in your browser.");
    const { user } = await openWeb(GOOGLE, web);
    await act(async () => {});
    expect(within(pane()).getByTitle(`Web page: ${GOOGLE}`)).toBeTruthy();
    expect(within(pane()).queryByRole("alert")).toBeNull();

    await user.click(within(pane()).getByRole("button", { name: "Open in your browser" }));
    expect((await within(pane()).findByRole("alert")).textContent).toBe(
      "Couldn't open it in your browser: Couldn't find xdg-open, which opens pages in your browser.",
    );
  });
});

describe("Closing and resizing", () => {
  it("closes with its button, the header toggle, or Escape", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("link", { name: "the docs" }));
    await user.click(within(pane()).getByRole("button", { name: "Close the preview" }));
    expect(paneOpen()).toBe(false);

    await user.click(screen.getByRole("button", { name: "Open the preview" }));
    expect(screen.getByRole("button", { name: "Close the preview", pressed: true })).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Close the preview" })[0]);
    expect(paneOpen()).toBe(false);

    await user.click(screen.getByRole("button", { name: "Open the preview" }));
    await user.keyboard("{Escape}");
    expect(paneOpen()).toBe(false);
  });

  it("resizes from its edge with the keyboard, and keeps the width", async () => {
    const { user } = await signedIn();
    await user.click(screen.getByRole("button", { name: "Open the preview" }));
    const edge = screen.getByRole("separator", { name: "Resize the preview" });
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
    await user.click(screen.getByRole("button", { name: "Open the preview" }));
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

    await user.click(screen.getByRole("button", { name: "Show the preview" }));
    expect(within(pane()).getByTitle("Web page: https://docs.example.com/crash")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(paneOpen()).toBe(false);
    expect(screen.getByRole("button", { name: "Show the preview" })).toBeTruthy();
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
    await user.click(within(destinationPane).getByRole("button", { name: "Show the preview" }));
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

    await user.click(screen.getByRole("button", { name: "Open the preview" }));
    await user.type(within(pane()).getByRole("textbox"), "/home/liam/app/main.py{Enter}");
    await within(pane()).findByText(/missing\.txt/);
    expect(fsReads(server).at(-1)!.query.get("profile")).toBe("work");
  });
});
