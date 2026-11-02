// @vitest-environment jsdom
// Server files: the rail's Files button opens a read-only browser for the Hermes server's disk, against a fake Hermes
// whose `GET /api/files` and `GET /api/files/read` answer as the deployed `bf0203a` does.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const MiB = 1024 * 1024;

function server() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  s.managedFiles.nodes = {
    "/home/liam/notes.md": { text: "# Notes\nbuy milk\n" },
    "/home/liam/.bashrc": { text: "export PATH\n" },
    "/home/liam/projects/app/main.rs": { text: "fn main() {}\n" },
    "/home/liam/projects/app/Cargo.toml": { text: "[package]\n" },
    "/home/liam/latest": { link: "/home/liam/projects/app" },
    "/home/liam/dangling": { link: "/home/liam/gone" },
    "/home/liam/photo.png": { bytes: "\x89PNG\r\n\x1a\n" },
    "/home/liam/huge.log": { size: 3 * MiB },
    "/home/liam/run": { text: "#!/bin/sh\necho hi\n" },
    "/home/liam/private": { dir: true, unreadable: true },
    "/home/liam/private/x": { text: "x" },
  };
  return s;
}

async function launch(s: FakeHermes) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { hermes, user: userEvent.setup() };
}

const names = () => [...document.querySelectorAll(".files-table tbody .files-label")].map((n) => n.textContent);
const trail = () => [...document.querySelectorAll(".files-crumbs li")].map((li) => li.textContent);
const row_ = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

async function openFiles(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Server files (read-only)" }));
  await waitFor(() => expect(document.querySelector(".files-table")).not.toBeNull());
}

describe("Server files", () => {
  it("opens from the rail on the server's starting folder, labelled with the server, read-only, dotfiles tucked away", async () => {
    const s = server();
    const { user } = await launch(s);
    await openFiles(user);
    expect(screen.getByRole("heading", { name: "Server files" })).toBeTruthy();
    expect(document.querySelector(".files-server")?.textContent).toContain("ssh://liam@hermes");
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(trail()).toEqual(["/", "home", "/liam"]);
    expect(within(screen.getByRole("navigation", { name: "Current folder" })).getByText("liam").getAttribute("aria-current")).toBe("page");
    expect(names()).toEqual(["latest", "private", "projects", "dangling", "huge.log", "notes.md", "photo.png", "run"]);
    await user.click(screen.getByRole("checkbox", { name: /Hidden files/ }));
    expect(names()).toContain(".bashrc");
    // A symbolic link shows where it leads; a broken one can't be opened.
    expect(row_("latest").textContent).toContain("/home/liam/projects/app");
    expect((row_("dangling") as HTMLButtonElement).disabled).toBe(true);
    // Only GETs, only the file routes: nothing on the server is changed.
    expect(s.restRequests.filter((r) => r.path.startsWith("/api/files")).every((r) => r.method === "GET")).toBe(true);
  });

  it("goes into folders, follows links to their target, and back up by the trail and the Up button", async () => {
    const { user } = await launch(server());
    await openFiles(user);
    await user.click(row_("projects"));
    await waitFor(() => expect(trail()).toEqual(["/", "home", "/liam", "/projects"]));
    expect(names()).toEqual(["app"]);
    await user.click(screen.getByRole("button", { name: "Up one folder" }));
    await waitFor(() => expect(names()).toContain("notes.md"));
    await user.click(row_("latest"));
    await waitFor(() => expect(trail()).toEqual(["/", "home", "/liam", "/projects", "/app"]));
    expect(names()).toEqual(["Cargo.toml", "main.rs"]);
    await user.click(screen.getByRole("button", { name: "home" }));
    await waitFor(() => expect(names()).toEqual(["liam"]));
    await user.type(screen.getByRole("textbox", { name: "Go to a folder on the server" }), "~/projects/app{Enter}");
    await waitFor(() => expect(names()).toEqual(["Cargo.toml", "main.rs"]));
  });

  it("previews text and images with their details, and says why others don't", async () => {
    const s = server();
    const { user } = await launch(s);
    await openFiles(user);
    await user.click(row_("notes.md"));
    const pane = await screen.findByRole("complementary", { name: "Preview of notes.md" });
    await waitFor(() => expect(pane.querySelector("pre")?.textContent).toBe("# Notes\nbuy milk\n"));
    expect(pane.textContent).toContain("/home/liam/notes.md");
    expect(pane.textContent).toContain("17 B (17 bytes)");
    expect(pane.textContent).toContain("text/markdown");

    await user.click(row_("photo.png"));
    const img = await screen.findByRole("img", { name: "photo.png" });
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

    await user.click(row_("huge.log"));
    expect((await screen.findByRole("alert")).textContent).toBe("It's 3.0 MB. Previews go up to 1.0 MB.");
    expect(s.managedFiles.reads).not.toContain("/home/liam/huge.log");

    // An unknown type is read only when asked.
    await user.click(row_("run"));
    expect(s.managedFiles.reads).not.toContain("/home/liam/run");
    await user.click(await screen.findByRole("button", { name: "Open as text" }));
    await waitFor(() => expect(document.querySelector(".files-text")?.textContent).toBe("#!/bin/sh\necho hi\n"));

    await user.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("complementary", { name: /Preview of/ })).toBeNull();
  });

  it("keeps the folder on screen when another can't be opened, and says why", async () => {
    const { user } = await launch(server());
    await openFiles(user);
    await user.click(row_("private"));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't open /home/liam/private: The Hermes server's user isn't allowed to open this folder.");
    expect(names()).toContain("notes.md");
    expect(trail()).toEqual(["/", "home", "/liam"]);
  });

  it("shows a big folder a page at a time, and finds entries in all of it by name", async () => {
    const s = new FakeHermes();
    for (let i = 0; i < 1200; i++) s.managedFiles.nodes[`/home/liam/f${String(i).padStart(4, "0")}.txt`] = { text: "x" };
    const { user } = await launch(s);
    await openFiles(user);
    expect(names()).toHaveLength(500);
    expect(screen.getByText("1200 items")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show 500 more" }));
    expect(names()).toHaveLength(1000);
    expect(screen.getByRole("button", { name: "Show 200 more" })).toBeTruthy();
    await user.click(screen.getByRole("textbox", { name: "Filter this folder" }));
    await user.paste("f1199");
    expect(names()).toEqual(["f1199.txt"]);
    expect(screen.getByText("1 of 1200 items")).toBeTruthy();
    // A thousand rows render slowly in jsdom.
  }, 20_000);

  it("goes stale while Hermes is away, and lists the folder again once it's back", async () => {
    const s = server();
    const { hermes, user } = await launch(s);
    await openFiles(user);
    await user.click(row_("projects"));
    await waitFor(() => expect(names()).toEqual(["app"]));
    act(() => s.drop());
    expect((await screen.findByRole("status")).textContent).toMatch(/Server files can't be read until Hermes is connected again\. This list is from/);
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(true);
    expect((row_("app") as HTMLButtonElement).disabled).toBe(true);
    expect(names()).toEqual(["app"]);
    s.managedFiles.nodes["/home/liam/projects/web/index.html"] = { text: "<p>" };
    await act(async () => void (await hermes.reconnect()));
    await waitFor(() => expect(names()).toEqual(["app", "web"]));
    expect(screen.queryByText(/can't be read until Hermes is connected/)).toBeNull();
  });

  it("shows only the folder asked for last, when answers come back out of order", async () => {
    const s = server();
    const { user } = await launch(s);
    await openFiles(user);
    const list = s.rest["GET /api/files"];
    let release!: () => void;
    s.rest["GET /api/files"] = (req) => (req.query.get("path") === "/home/liam/projects" ? new Promise((r) => (release = () => r(list(req)))) : list(req));
    await user.click(row_("projects"));
    await user.click(row_("latest"));
    await waitFor(() => expect(names()).toEqual(["Cargo.toml", "main.rs"]));
    await act(async () => release());
    expect(names()).toEqual(["Cargo.toml", "main.rs"]);
  });

  it("drops a preview's late answer once the preview is closed, the folder changes, or its file is gone", async () => {
    const s = server();
    const { user } = await launch(s);
    await openFiles(user);
    const read = s.rest["GET /api/files/read"];
    const held: (() => void)[] = [];
    // The answer is read when asked for, and held back until released.
    s.rest["GET /api/files/read"] = (req) => {
      const answer = Promise.resolve().then(() => read(req));
      return new Promise((r) => held.push(() => r(answer)));
    };
    const pane = () => screen.queryByRole("complementary", { name: /Preview of/ });
    const releaseAll = () => act(async () => void held.splice(0).forEach((release) => release()));

    // Closed while the read is on its way.
    await user.click(row_("notes.md"));
    await waitFor(() => expect(held).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Close preview" }));
    await releaseAll();
    expect(pane()).toBeNull();

    // Left for another folder.
    await user.click(row_("notes.md"));
    await waitFor(() => expect(held).toHaveLength(1));
    await user.click(row_("projects"));
    await waitFor(() => expect(names()).toEqual(["app"]));
    await releaseAll();
    expect(pane()).toBeNull();

    // Deleted, and refreshed away.
    await user.click(screen.getByRole("button", { name: "Up one folder" }));
    await waitFor(() => expect(names()).toContain("notes.md"));
    await user.click(row_("notes.md"));
    await waitFor(() => expect(held).toHaveLength(1));
    delete s.managedFiles.nodes["/home/liam/notes.md"];
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(names()).not.toContain("notes.md"));
    await releaseAll();
    expect(pane()).toBeNull();

    // Deleted, and the refresh and the late read land together.
    await user.click(row_("run"));
    await user.click(await screen.findByRole("button", { name: "Open as text" }));
    await waitFor(() => expect(held).toHaveLength(1));
    const list = s.rest["GET /api/files"];
    s.rest["GET /api/files"] = (req) => new Promise((r) => held.push(() => r(Promise.resolve().then(() => list(req)))));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(held).toHaveLength(2));
    // The read was answered before the file went; only the listing sees it gone.
    const [readRun, listAgain] = held.splice(0);
    delete s.managedFiles.nodes["/home/liam/run"];
    await act(async () => {
      listAgain();
      readRun();
    });
    await waitFor(() => expect(names()).not.toContain("run"));
    expect(pane()).toBeNull();
  });

  it("starts at a locked root and says so", async () => {
    const s = server();
    s.managedFiles.root = "/home/liam/projects";
    const { user } = await launch(s);
    await openFiles(user);
    expect(screen.getByText("Limited to /home/liam/projects")).toBeTruthy();
    expect(trail()).toEqual(["/home/liam/projects"]);
    expect((screen.getByRole("button", { name: "Up one folder" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("takes turns with Settings over the chat, and leaves no chat marked open meanwhile", async () => {
    const { user } = await launch(server());
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    await waitFor(() => expect(document.querySelector("[aria-current='true']")).not.toBeNull());
    await openFiles(user);
    const filesButton = screen.getByRole("button", { name: "Server files (read-only)" });
    expect(filesButton.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[aria-current='true']")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(document.querySelector(".files")).toBeNull());
    expect(filesButton.getAttribute("aria-pressed")).toBe("false");
    await openFiles(user);
    expect(screen.queryByRole("button", { name: "Back to chat" })).toBeTruthy();
    expect(document.querySelectorAll(".files")).toHaveLength(1);
  });

  it("gives way to a chat, and opens again where it was", async () => {
    const { user } = await launch(server());
    await openFiles(user);
    await user.click(row_("projects"));
    await waitFor(() => expect(names()).toEqual(["app"]));
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    await waitFor(() => expect(document.querySelector(".files")).toBeNull());
    expect(document.querySelector(".chat-title span")?.textContent).toBe("Nightly backup");
    await openFiles(user);
    expect(trail()).toEqual(["/", "home", "/liam", "/projects"]);
    await user.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(document.querySelector(".files")).toBeNull();
  });
});
