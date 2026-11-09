// @vitest-environment jsdom
// Server files: the rail's Files button opens a read-only browser for the Hermes server's disk, against a fake Hermes
// whose `GET /api/files` and `GET /api/files/read` answer as the deployed `bf0203a` does.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { FakeTray } from "../hermes/fakeTray";

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

async function launch(s: FakeHermes, tray = new FakeTray({ closeToTray: true, tray: "shown" })) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} tray={tray} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { hermes, user: userEvent.setup() };
}

const names = () => [...document.querySelectorAll(".files-table tbody .files-label")].map((n) => n.textContent);
const trail = () => [...document.querySelectorAll(".files-crumbs li")].map((li) => li.textContent);
const row_ = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

/** Server files is the side panel's Files tab (ADR 0039, 0116); the rail has no button for it. */
async function openFiles(user: ReturnType<typeof userEvent.setup>) {
  if (document.querySelector("aside.side-panel:not([hidden])") === null) await user.click(screen.getByRole("button", { name: /^(Open|Show) the side panel$/ }));
  await user.click(screen.getByRole("tab", { name: "Files" }));
  await waitFor(() => expect(document.querySelector(".files-table")).not.toBeNull());
}

describe("Server files", () => {
  it("opens in the side panel on the server's starting folder, labelled with the server, read-only, dotfiles tucked away", async () => {
    const s = server();
    const { user } = await launch(s);
    await openFiles(user);
    expect(screen.getByRole("heading", { name: "Server files" })).toBeTruthy();
    expect(document.querySelector(".files-server")?.textContent).toContain("ssh://liam@hermes");
    expect(screen.queryByText("Read-only")).toBeNull();
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

  it("opens in the side panel beside the chat, and Settings covers it as it covers the chat", async () => {
    const { user } = await launch(server());
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    await waitFor(() => expect(document.querySelector("[aria-current='true']")).not.toBeNull());
    await openFiles(user);
    // The chat stays open beside it.
    expect(document.querySelector("[aria-current='true']")).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("button", { name: "Back to chat" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(document.querySelector("aside.side-panel")!.hasAttribute("hidden")).toBe(true));
    // Leaving Settings brings the panel back on Files, the same one.
    await user.click(screen.getByRole("button", { name: "Back to chat" }));
    await waitFor(() => expect(document.querySelector("aside.side-panel")!.hasAttribute("hidden")).toBe(false));
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelectorAll(".files")).toHaveLength(1);
    // The header's side panel button closes it again.
    await user.click(document.querySelector<HTMLElement>(".chat-head-actions [title='Close the side panel']")!);
    expect(document.querySelector("aside.side-panel")!.hasAttribute("hidden")).toBe(true);
  });

  it("stays beside a chat that opens, on the folder it was in", async () => {
    const { user } = await launch(server());
    await openFiles(user);
    await user.click(row_("projects"));
    await waitFor(() => expect(names()).toEqual(["app"]));
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    await waitFor(() => expect(document.querySelector(".chat-title span")?.textContent).toBe("Nightly backup"));
    expect(document.querySelector("aside.side-panel")!.hasAttribute("hidden")).toBe(false);
    expect(trail()).toEqual(["/", "home", "/liam", "/projects"]);
  });
});

describe("Server files: Download", () => {
  const transfer = () => within(screen.getByRole("region", { name: "Transfers" }));

  it("downloads a file too big to preview to where the owner picks, showing both paths, progress and Cancel", async () => {
    const s = server();
    let release!: () => void;
    s.managedFiles.transferGate = new Promise((r) => (release = r));
    const { user } = await launch(s);
    await openFiles(user);
    await user.click(row_("huge.log"));
    await screen.findByText(/Previews go up to/);
    await user.click(screen.getByRole("button", { name: /Download/ }));
    const progress = await screen.findByRole("progressbar", { name: "Downloading huge.log" });
    expect(progress.getAttribute("value")).toBe("50");
    expect(transfer().getByText("/home/liam/huge.log")).toBeTruthy();
    expect(transfer().getByText("/home/me/Downloads/huge.log")).toBeTruthy();
    expect(transfer().getByText("1.5 MB of 3.0 MB (50%)")).toBeTruthy();
    release();
    await waitFor(() => expect(transfer().getByText("Downloaded, 3.0 MB")).toBeTruthy());
    expect(s.managedFiles.local["/home/me/Downloads/huge.log"]).toHaveLength(3 * MiB);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await user.click(transfer().getByRole("button", { name: "Dismiss huge.log" }));
    expect(screen.queryByRole("region", { name: "Transfers" })).toBeNull();
  });

  it("stops a download on Cancel and leaves this computer's file as it was", async () => {
    const s = server();
    s.managedFiles.transferGate = new Promise(() => {});
    s.managedFiles.local["/home/me/Downloads/notes.md"] = new TextEncoder().encode("mine");
    const { user } = await launch(s);
    await openFiles(user);
    await user.click(row_("notes.md"));
    await user.click(await screen.findByRole("button", { name: /Download/ }));
    await screen.findByRole("progressbar");
    await user.click(transfer().getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(transfer().getByText(/^Stopped\. Nothing was saved/)).toBeTruthy());
    expect(new TextDecoder().decode(s.managedFiles.local["/home/me/Downloads/notes.md"])).toBe("mine");
  });

  it("does nothing when the owner closes the Save dialog", async () => {
    const s = server();
    s.managedFiles.saveDialog = () => undefined;
    const { user } = await launch(s);
    await openFiles(user);
    await user.click(row_("notes.md"));
    await user.click(await screen.findByRole("button", { name: /Download/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Transfers" })).toBeNull());
    expect(s.managedFiles.local).toEqual({});
  });

  it("offers no download of a file over Hermes's 100 MB, or of a folder", async () => {
    const s = server();
    s.managedFiles.nodes["/home/liam/disk.img"] = { size: 101 * MiB };
    const { user } = await launch(s);
    await openFiles(user);
    await user.click(row_("disk.img"));
    const button = (await screen.findByRole("button", { name: /Download/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("It's 101 MB. Hermes sends files up to 100 MB.")).toBeTruthy();
  });

  it("says why the server refused, and stops a download when the connection closes", async () => {
    const s = server();
    const { hermes, user } = await launch(s);
    await openFiles(user);
    await user.click(row_("notes.md"));
    await screen.findByText(/buy milk/);
    // Made unreadable after it was listed: the server's 403 shows as the browser words it.
    s.managedFiles.nodes["/home/liam/notes.md"] = { text: "x", unreadable: true };
    await user.click(screen.getByRole("button", { name: /Download/ }));
    await waitFor(() => expect(transfer().getByRole("alert").textContent).toBe("The Hermes server's user isn't allowed to read this file."));
    s.managedFiles.nodes["/home/liam/notes.md"] = { text: "# Notes\n" };
    s.managedFiles.transferGate = new Promise(() => {});
    await user.click(screen.getByRole("button", { name: /Download/ }));
    await screen.findByRole("progressbar");
    await act(async () => void (await hermes.close()));
    await waitFor(() => expect(transfer().getAllByText(/^Stopped\./)).toHaveLength(1));
    expect(s.managedFiles.local).toEqual({});
  });
});

describe("Server files: Upload", () => {
  const transfer = () => within(screen.getByRole("region", { name: "Transfers" }));
  const dialog = () => within(screen.getByRole("dialog", { name: "Upload to the server" }));

  it("shows where a picked file goes before sending it, then reads it back from the folder", async () => {
    const s = server();
    s.managedFiles.openDialog = () => ({ name: "report.pdf", bytes: "%PDF-1.7 synthetic" });
    const { user } = await launch(s);
    await openFiles(user);
    await user.click(screen.getByRole("button", { name: /Upload/ }));
    expect(dialog().getByText("/home/liam/report.pdf")).toBeTruthy();
    expect(dialog().queryByRole("radio")).toBeNull();
    expect(s.managedFiles.uploads).toEqual([]);
    await user.click(dialog().getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(transfer().getByText(/^Uploaded, and the server lists it at 18 B/)).toBeTruthy());
    expect(s.managedFiles.uploads).toEqual([{ path: "/home/liam/report.pdf", overwrite: false }]);
    expect(transfer().getByText("report.pdf", { selector: ".mono" })).toBeTruthy();
    await waitFor(() => expect(names()).toContain("report.pdf"));
  });

  it("keeps both by default when the name is taken, and replaces only when asked", async () => {
    const s = server();
    s.managedFiles.openDialog = () => ({ name: "notes.md", bytes: "# Mine\n" });
    const { user } = await launch(s);
    await openFiles(user);
    await user.click(screen.getByRole("button", { name: /Upload/ }));
    expect(dialog().getByText(/There's already a/)).toBeTruthy();
    expect((dialog().getByRole("radio", { name: /Keep both/ }) as HTMLInputElement).checked).toBe(true);
    expect(dialog().getByText("/home/liam/notes (2).md")).toBeTruthy();
    await user.click(dialog().getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(transfer().getByText(/^Uploaded/)).toBeTruthy());
    expect(s.managedFiles.nodes["/home/liam/notes.md"]).toEqual({ text: "# Notes\nbuy milk\n" });
    expect(s.managedFiles.uploads.at(-1)).toEqual({ path: "/home/liam/notes (2).md", overwrite: false });
    await user.click(screen.getByRole("button", { name: /Upload/ }));
    await user.click(dialog().getByRole("radio", { name: /Replace the server's/ }));
    expect(dialog().getByText(/permissions aren't kept/)).toBeTruthy();
    expect(dialog().getByText("/home/liam/notes.md")).toBeTruthy();
    await user.click(dialog().getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(transfer().getAllByText(/^Uploaded/)).toHaveLength(2));
    expect(s.managedFiles.uploads.at(-1)).toEqual({ path: "/home/liam/notes.md", overwrite: true });
  });

  it("cancels in the dialog without sending, and says when the name was taken meanwhile", async () => {
    const s = server();
    s.managedFiles.openDialog = () => ({ name: "new.txt", bytes: "x" });
    const { user } = await launch(s);
    await openFiles(user);
    await user.click(screen.getByRole("button", { name: /Upload/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(s.managedFiles.uploads).toEqual([]);
    await user.click(screen.getByRole("button", { name: /Upload/ }));
    // Someone else writes new.txt after the folder was listed: Hermes refuses, and nothing is replaced.
    s.managedFiles.nodes["/home/liam/new.txt"] = { text: "theirs" };
    await user.click(dialog().getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(transfer().getByRole("alert").textContent).toBe("A file with that name is on the server now. Nothing was replaced."));
    expect(s.managedFiles.nodes["/home/liam/new.txt"]).toEqual({ text: "theirs" });
  });

  it("refuses a credential file's name and a file over 100 MB up front", async () => {
    const s = server();
    let pick = { name: ".env", bytes: "SECRET=1" };
    s.managedFiles.openDialog = () => pick;
    const { user } = await launch(s);
    await openFiles(user);
    await user.click(screen.getByRole("button", { name: /Upload/ }));
    expect(dialog().getByRole("alert").textContent).toMatch(/credential files such as \.env/);
    expect(dialog().queryByRole("button", { name: "Upload" })).toBeNull();
    await user.click(dialog().getByRole("button", { name: "Close" }));
    pick = { name: "disk.img", bytes: "" };
    s.managedFiles.openDialog = () => ({ ...pick, bytes: { length: 101 * MiB } as unknown as string });
    await user.click(screen.getByRole("button", { name: /Upload/ }));
    expect(dialog().getByRole("alert").textContent).toBe("It's 101 MB. Hermes takes files up to 100 MB.");
    expect(s.managedFiles.uploads).toEqual([]);
  });

  it("refuses to replace a link to a credential file, which Hermes would write through", async () => {
    const s = server();
    s.managedFiles.nodes["/home/liam/report.txt"] = { link: "/home/liam/.env" };
    s.managedFiles.nodes["/home/liam/.env"] = { text: "SECRET=1\n" };
    s.managedFiles.openDialog = () => ({ name: "report.txt", bytes: "x" });
    const { user } = await launch(s);
    await openFiles(user);
    await user.click(screen.getByRole("button", { name: /Upload/ }));
    expect(dialog().getByRole("alert").textContent).toBe("report.txt here is a link to a credential file (/home/liam/.env), so Hermes Chat doesn't upload over it.");
    expect(dialog().queryByRole("button", { name: /Upload|Replace/ })).toBeNull();
  });

  it("keeps the keyboard in the dialog and gives focus back to Upload… when it closes", async () => {
    const s = server();
    s.managedFiles.openDialog = () => ({ name: "notes.md", bytes: "x" });
    const { user } = await launch(s);
    await openFiles(user);
    const upload = screen.getByRole("button", { name: /Upload/ });
    await user.click(upload);
    const box = screen.getByRole("dialog", { name: "Upload to the server" });
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(box.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(box.contains(document.activeElement)).toBe(true);
    // With Replace chosen, Keep both is no tab stop: Shift+Tab from the first stop goes round to the last.
    await user.click(within(box).getByRole("radio", { name: /Replace the server's/ }));
    for (let i = 0; i < 8; i++) {
      await user.tab({ shift: true });
      expect(box.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(upload);
    // The pick wasn't sent, and is let go.
    expect(s.managedFiles.openPicks).toBe(0);
  });

  it("stops an upload on Cancel, leaving the server's folder as it was", async () => {
    const s = server();
    s.managedFiles.transferGate = new Promise(() => {});
    s.managedFiles.openDialog = () => ({ name: "big.bin", bytes: "0123456789" });
    const { user } = await launch(s);
    await openFiles(user);
    await user.click(screen.getByRole("button", { name: /Upload/ }));
    await user.click(dialog().getByRole("button", { name: "Upload" }));
    expect((await screen.findByRole("progressbar", { name: "Uploading big.bin" })).getAttribute("value")).toBe("50");
    await user.click(transfer().getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(transfer().getByText(/^Stopped\. Hermes never keeps part/)).toBeTruthy());
    expect(s.managedFiles.nodes["/home/liam/big.bin"]).toBeUndefined();
  });
});

describe("Server files: editing text", () => {
  const editor = () => within(screen.getByRole("dialog", { name: /^Edit / }));
  const serverText = (s: FakeHermes, p: string) => {
    const n = s.managedFiles.nodes[p] as { text?: string; bytes?: string };
    return n.text ?? new TextDecoder().decode(Uint8Array.from(n.bytes!, (c) => c.charCodeAt(0)));
  };

  async function openEditor(user: ReturnType<typeof userEvent.setup>, name = "notes.md") {
    await openFiles(user);
    await user.click(row_(name));
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    return (await screen.findByRole("textbox", { name: `Text of ${name}` })) as HTMLTextAreaElement;
  }

  it("edits, reviews the diff, saves, and says so only once read back", async () => {
    const s = server();
    const { user } = await launch(s);
    const area = await openEditor(user);
    expect(area.value).toBe("# Notes\nbuy milk\n");
    expect((editor().getByRole("button", { name: "Review changes…" }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(area);
    await user.type(area, "# Notes\nbuy oat milk\n");
    await user.click(editor().getByRole("button", { name: "Review changes…" }));
    const diff = within(editor().getByRole("region", { name: "Your changes" }));
    expect(diff.getByText("1 added")).toBeTruthy();
    expect(diff.getByText("buy milk").closest(".files-diff-line")?.className).toContain("del");
    expect(diff.getByText("buy oat milk").closest(".files-diff-line")?.className).toContain("add");
    expect(s.managedFiles.saves).toEqual([]);
    await user.click(editor().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Saved notes\.md\. Hermes has your edit, read back/));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(serverText(s, "/home/liam/notes.md")).toBe("# Notes\nbuy oat milk\n");
    await waitFor(() => expect(screen.getByText(/buy oat milk/, { selector: ".files-text" })).toBeTruthy());
  });

  it("writes nothing over a remote change, shows it, and merges the two", async () => {
    const s = server();
    s.managedFiles.nodes["/home/liam/notes.md"] = { text: "one\ntwo\nthree\nfour\nfive\n" };
    const { user } = await launch(s);
    const area = await openEditor(user);
    await user.clear(area);
    await user.type(area, "one\nTWO\nthree\nfour\nfive\n");
    // Another client edits the last line meanwhile.
    s.managedFiles.nodes["/home/liam/notes.md"] = { text: "one\ntwo\nthree\nfour\nFIVE (theirs)\n" };
    await user.click(editor().getByRole("button", { name: "Review changes…" }));
    await user.click(editor().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(editor().getByRole("alert").textContent).toMatch(/changed on the server since you opened it, so nothing was written\. Your edit is kept here\./));
    expect(s.managedFiles.saves).toEqual([]);
    const theirs = within(editor().getByRole("region", { name: "Changes on the server since you opened it" }));
    expect(theirs.getByText("FIVE (theirs)")).toBeTruthy();
    await user.click(editor().getByRole("button", { name: "Merge" }));
    expect((editor().getByRole("textbox") as HTMLTextAreaElement).value).toBe("one\nTWO\nthree\nfour\nFIVE (theirs)\n");
    await user.click(editor().getByRole("button", { name: "Review changes…" }));
    await user.click(editor().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(serverText(s, "/home/liam/notes.md")).toBe("one\nTWO\nthree\nfour\nFIVE (theirs)\n");
  });

  it("marks where both changed the same line, and can reload theirs or keep both as a copy", async () => {
    const s = server();
    const { user } = await launch(s);
    const area = await openEditor(user);
    await user.clear(area);
    await user.type(area, "# Notes\nbuy bread\n");
    s.managedFiles.nodes["/home/liam/notes.md"] = { text: "# Notes\nbuy eggs\n" };
    await user.click(editor().getByRole("button", { name: "Review changes…" }));
    await user.click(editor().getByRole("button", { name: "Save" }));
    await editor().findByRole("button", { name: "Merge" });
    await user.click(editor().getByRole("button", { name: "Merge" }));
    expect((editor().getByRole("textbox") as HTMLTextAreaElement).value).toContain("<<<<<<< your edit\nbuy bread\n=======\nbuy eggs\n>>>>>>> on the server now");
    expect(editor().getByRole("status").textContent).toMatch(/1 place both changed is marked/);
    // Back to a conflict to try the other two ways out.
    s.managedFiles.nodes["/home/liam/notes.md"] = { text: "# Notes\nbuy jam\n" };
    await user.click(editor().getByRole("button", { name: "Review changes…" }));
    await user.click(editor().getByRole("button", { name: "Save" }));
    await user.click(await editor().findByRole("button", { name: "Save mine as a copy" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/saved as a copy, \/home\/liam\/notes \(2\)\.md/));
    expect(serverText(s, "/home/liam/notes.md")).toBe("# Notes\nbuy jam\n");
    expect(serverText(s, "/home/liam/notes (2).md")).toContain("buy bread");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.type(await screen.findByRole("textbox", { name: "Text of notes.md" }), "more\n");
    s.managedFiles.nodes["/home/liam/notes.md"] = { text: "server wins\n" };
    await user.click(editor().getByRole("button", { name: "Review changes…" }));
    await user.click(editor().getByRole("button", { name: "Save" }));
    await user.click(await editor().findByRole("button", { name: "Reload theirs" }));
    expect((editor().getByRole("textbox") as HTMLTextAreaElement).value).toBe("server wins\n");
  });

  it("keeps the app's shortcuts and the keyboard inside the editor, so nothing drops the edit unasked", async () => {
    const s = server();
    const { user } = await launch(s);
    const area = await openEditor(user);
    await user.type(area, "draft");
    await user.keyboard("{Control>}n{/Control}");
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: /^Edit / })).toBeTruthy();
    expect(document.querySelector(".files")).not.toBeNull();
    const box = screen.getByRole("dialog", { name: /^Edit / });
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(box.contains(document.activeElement)).toBe(true);
    }
    expect((editor().getByRole("textbox") as HTMLTextAreaElement).value).toContain("draft");
  });

  it("keeps the edit when the tray's New chat or Open Inbox is picked: the window only comes forward", async () => {
    const s = server();
    const tray = new FakeTray({ closeToTray: true, tray: "shown" });
    const { user } = await launch(s, tray);
    const area = await openEditor(user);
    await user.type(area, "draft");
    tray.pick("newChat");
    tray.pick("inbox");
    expect(screen.getByRole("dialog", { name: /^Edit / })).toBeTruthy();
    expect((editor().getByRole("textbox") as HTMLTextAreaElement).value).toContain("draft");
    expect(document.querySelector(".files")).not.toBeNull();
    expect(screen.queryByRole("dialog", { name: /Inbox/ })).toBeNull();
  });

  it("asks before dropping an unsaved edit, and won't edit what it can't round-trip", async () => {
    const s = server();
    s.managedFiles.nodes["/home/liam/latin1.txt"] = { bytes: "caf\xe9\n" };
    const { user } = await launch(s);
    const area = await openEditor(user);
    await user.type(area, "x");
    await user.click(editor().getByRole("button", { name: "Cancel" }));
    expect(editor().getByRole("alert").textContent).toMatch(/Discard your changes to notes\.md\?/);
    await user.click(editor().getByRole("button", { name: "Keep editing" }));
    expect((editor().getByRole("textbox") as HTMLTextAreaElement).value).toBe("# Notes\nbuy milk\nx");
    await user.click(editor().getByRole("button", { name: "Cancel" }));
    await user.click(editor().getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(serverText(s, "/home/liam/notes.md")).toBe("# Notes\nbuy milk\n");
    await user.click(row_("latin1.txt"));
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect((await editor().findByRole("alert")).textContent).toMatch(/isn't UTF-8 text/);
  });
});
