// @vitest-environment jsdom
// Paths in a reply, in the signed-in app against a fake Hermes (ADR 0163): a file's path opens the file in the
// Preview, a folder's opens a shell started in it in the Terminal, and nothing is ever typed into a shell. Rust's
// terminal commands and xterm.js are stood in for; what they were asked for is what the tests read.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import type { TerminalEvent } from "../hermes/terminal";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const fakes = vi.hoisted(() => {
  /** Rust's terminal commands, recording what was opened and what was typed. */
  const terminals = () => ({
    opened: [] as { target: string; folder?: string }[],
    written: [] as string[],
    open(target: string, _cols: number, _rows: number, _emit: (e: TerminalEvent) => void, folder?: string) {
      this.opened.push({ target, folder });
      return Promise.resolve(this.opened.length);
    },
    write(_id: number, data: string) {
      this.written.push(data);
      return Promise.resolve();
    },
    resize: () => Promise.resolve(),
    close() {},
  });
  class XTerm {
    cols = 100;
    rows = 30;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    focus() {}
    dispose() {}
  }
  return { server: terminals(), local: terminals(), XTerm };
});
vi.mock("./tauriTerminal", () => ({ tauriTerminal: fakes.server, tauriLocalTerminal: fakes.local }));
vi.mock("@xterm/xterm", () => ({ Terminal: fakes.XTerm }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
  vi.unstubAllGlobals();
  for (const t of [fakes.server, fakes.local]) {
    t.opened.length = 0;
    t.written.length = 0;
  }
});

const REPLY =
  "I edited src/main.py and `README.md`. The tests are in tests/ and the guide in `./docs`. " +
  "There is a report at /workspace/report.md, nothing yet at /home/liam/app/build/out.txt, and no `gone/nowhere`.";

/** The app on a chat that works in `/home/liam/app`, with a reply that names paths in it. */
async function launch() {
  const server = new FakeHermes();
  server.sessions = [row("fix", 1, { pinned: true, title: "Fix the app", cwd: "/home/liam/app" })];
  server.transcripts = { fix: [{ role: "user", text: "Fix it" }, { role: "assistant", text: REPLY }] };
  server.serverFiles = {
    "/home/liam/app/src/main.py": 'print("fixed")\n',
    "/home/liam/app/README.md": "# App\n\nStart with docs/guide.md.\n",
    "/home/liam/app/docs": { dir: true },
    "/home/liam/app/docs/guide.md": "# Guide\n\nRun the app.\n",
    "/home/liam/app/tests/test_main.py": "def test(): pass\n",
    "/srv/sandboxes/fix/report.md": "# Report\n\nAll green.\n",
  };
  // Each chat's `/workspace` is its own folder on the host; a listing, which names no chat, sees the profile's.
  server.sandbox = { profile: "/srv/sandboxes/profile", chats: { fix: "/srv/sandboxes/fix" } };
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await user.click(await screen.findByRole("button", { name: /Fix the app/ }));
  await screen.findByText(/I edited/);
  await act(async () => void (await hermes.idle()));
  return { server, hermes, user };
}

const path = (words: string, within_: ParentNode = document) => {
  const link = [...within_.querySelectorAll<HTMLElement>("a.path-link")].find((a) => a.textContent === words);
  if (!link) throw new Error(`No path link reads ${words}`);
  return link;
};
const pane = () => {
  const el = document.querySelector<HTMLElement>("aside.preview:not([hidden])");
  if (!el) throw new Error("The preview pane isn't open");
  return el;
};
const address = () => within(pane()).getByRole<HTMLInputElement>("textbox", { name: "Address" }).value;
const terminalShown = () => screen.findByRole("group", { name: "Which computer" });
/** What the app asked the server about `at`: its listings, and its reads with the chat each named. */
const asked = (server: FakeHermes, at: string) =>
  server.restRequests.filter((r) => r.path.startsWith("/api/fs/") && r.query.get("path") === at).map((r) => `${r.path.slice("/api/fs/".length)} ${r.query.get("session_id") ?? "-"}`);

describe("A path in a reply", () => {
  it("links every path the reply names, relative to the folder the chat works in", async () => {
    await launch();
    const links = [...document.querySelectorAll<HTMLElement>(".msg.assistant a.path-link")];
    expect(links.map((a) => a.textContent)).toEqual(["src/main.py", "README.md", "tests/", "./docs", "/workspace/report.md", "/home/liam/app/build/out.txt", "gone/nowhere"]);
    expect(path("src/main.py").title.split("\n")[0]).toBe("/home/liam/app/src/main.py");
    expect(links.every((a) => !a.hasAttribute("href"))).toBe(true);
  });

  it("opens a file in the Preview, read as the chat's", async () => {
    const { server, user } = await launch();
    await user.click(path("src/main.py"));
    expect(await within(pane()).findByText(/fixed/)).toBeTruthy();
    expect(address()).toBe("/home/liam/app/src/main.py");
    expect(asked(server, "/home/liam/app/src/main.py")).toEqual(["list -", "read-text fix"]);
    expect(fakes.server.opened).toEqual([]);
  });

  it("opens a folder as a shell started in it, in the Terminal, and types nothing", async () => {
    const { user } = await launch();
    await user.click(path("./docs"));
    await terminalShown();
    expect(screen.getByRole("tab", { name: /Terminal/ }).getAttribute("aria-selected")).toBe("true");
    expect(fakes.server.opened).toEqual([{ target: "liam@hermes", folder: "/home/liam/app/docs" }]);
    expect(screen.getByRole("button", { name: /^docs/ }).getAttribute("aria-pressed")).toBe("true");
    expect(fakes.server.written).toEqual([]);
    expect(fakes.local.opened).toEqual([]);
  });

  it("takes a path written with a slash at its end for a folder, without asking the server", async () => {
    const { server, user } = await launch();
    await user.click(path("tests/"));
    await terminalShown();
    expect(fakes.server.opened).toEqual([{ target: "liam@hermes", folder: "/home/liam/app/tests" }]);
    expect(asked(server, "/home/liam/app/tests")).toEqual([]);
  });

  it("shows the shell a folder already has when its path is clicked again", async () => {
    const { user } = await launch();
    await user.click(path("tests/"));
    await terminalShown();
    await user.click(path("./docs"));
    await waitFor(() => expect(fakes.server.opened).toHaveLength(2));
    await user.click(path("tests/"));
    await waitFor(() => expect(screen.getByRole("button", { name: /^tests/ }).getAttribute("aria-pressed")).toBe("true"));
    expect(fakes.server.opened.map((o) => o.folder)).toEqual(["/home/liam/app/tests", "/home/liam/app/docs"]);
    expect(fakes.server.written).toEqual([]);
  });

  it("opens a path the server finds nothing at in the Preview, which says so", async () => {
    const { user } = await launch();
    await user.click(path("/home/liam/app/build/out.txt"));
    expect(await within(pane()).findByText("There's no file at this path on the Hermes server.")).toBeTruthy();
    expect(fakes.server.opened).toEqual([]);
  });

  it("previews a file in the chat's sandbox, which a listing can't see", async () => {
    const { server, user } = await launch();
    await user.click(path("/workspace/report.md"));
    expect(await within(pane()).findByText("All green.")).toBeTruthy();
    expect(asked(server, "/workspace/report.md")).toEqual(["list -", "read-text fix"]);
  });

  it("opens on Enter, from the keyboard", async () => {
    const { user } = await launch();
    path("src/main.py").focus();
    await user.keyboard("{Enter}");
    expect(await within(pane()).findByText(/fixed/)).toBeTruthy();
  });

  it("offers the Terminal for a file, which opens a shell in the folder the file is in", async () => {
    const { user } = await launch();
    fireEvent.contextMenu(path("src/main.py"));
    await user.click(screen.getByRole("menuitem", { name: "Open in the Terminal" }));
    await terminalShown();
    expect(fakes.server.opened).toEqual([{ target: "liam@hermes", folder: "/home/liam/app/src" }]);
  });

  it("offers the Preview for a folder, and says there's no folder when the Terminal is asked for a path that isn't there", async () => {
    const { user } = await launch();
    fireEvent.contextMenu(path("./docs"));
    await user.click(screen.getByRole("menuitem", { name: "Open in the Preview" }));
    expect(await within(pane()).findByText("This path is a folder on the Hermes server, not a file.")).toBeTruthy();
    fireEvent.contextMenu(path("gone/nowhere"));
    await user.click(screen.getByRole("menuitem", { name: "Open in the Terminal" }));
    expect((await screen.findByText("There's no folder at /home/liam/app/gone/nowhere on the Hermes server.")).closest(".toast")).toBeTruthy();
    expect(fakes.server.opened).toEqual([]);
  });

  it("copies the full path", async () => {
    await launch();
    // After the launch: user-event's own clipboard takes the navigator's place when it is set up.
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    fireEvent.contextMenu(path("README.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith("/home/liam/app/README.md");
    expect(await screen.findByText("Path copied.")).toBeTruthy();
  });

  it("in a previewed Server file is relative to that file's folder", async () => {
    const { user } = await launch();
    await user.click(path("README.md"));
    await within(pane()).findByText(/Start with/);
    await user.click(path("docs/guide.md", pane()));
    expect(await within(pane()).findByText("Run the app.")).toBeTruthy();
    expect(address()).toBe("/home/liam/app/docs/guide.md");
  });
});
