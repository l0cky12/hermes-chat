// @vitest-environment jsdom
// Outputs in the running app, against a fake Hermes whose stored rows and `/api/fs/*` answer as the deployed `bf0203a`
// does: the files Hermes's tools wrote, for a chat, a project or the profile, and where each came from.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// Vitest empties a CSS import, ?raw included.
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, SANDBOX_NOT_FOUND, row, type TranscriptMessage } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { OutputsScreen } from "./Outputs";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
// Paging works the same at any page size, and 200 rows rendered twice cost seconds of CPU, which a busy machine
// stretches past the test timeout (#394).
vi.mock("./outputPage", () => ({ OUTPUT_PAGE: 20 }));

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

const written = (path: string, bytes: number) => JSON.stringify({ bytes_written: bytes, dirs_created: false, resolved_path: path, files_modified: [path] });

/** A tool call and its stored result, as Hermes stores and `session.resume` projects them. */
function call(id: string, name: string, args: Record<string, unknown>, result: string, rowId: number): TranscriptMessage[] {
  return [
    { role: "assistant", text: "", row_id: rowId, timestamp: 1_790_000_000 + rowId, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", name, tool_call_id: id, args, context: String(args.path ?? ""), row_id: rowId + 1, timestamp: 1_790_000_000 + rowId, result },
  ];
}

const HOSTILE = "/srv/out/<img src=x onerror=alert(1)>‮gnp.html";

function server() {
  const s = new FakeHermes();
  s.sessions = [row("report", 1, { pinned: true, title: "Quarterly report" }), row("cats", 2, { pinned: true, title: "Cat pictures" })];
  s.otherProfiles = { work: [row("deploy", 1, { pinned: true, title: "Deploy plan" })] };
  s.transcripts.report = [
    { role: "user", text: "Write the report", row_id: 1, timestamp: 1_790_000_000 },
    ...call("w1", "write_file", { path: "/srv/out/report.md" }, written("/srv/out/report.md", 2048), 2),
    ...call("w2", "write_file", { path: "/srv/out/report.md" }, written("/srv/out/report.md", 4096), 4),
    ...call("t1", "terminal", { command: "touch /srv/out/made-by-shell.csv" }, JSON.stringify({ output: "", exit_code: 0 }), 6),
    ...call("w3", "write_file", { path: HOSTILE }, written(HOSTILE, 10), 8),
    { role: "assistant", text: "Done. Also see /srv/out/mentioned.pdf.", row_id: 10, timestamp: 1_790_000_010 },
  ];
  s.transcripts.cats = [
    { role: "user", text: "Draw a cat", row_id: 1, timestamp: 1_790_000_100 },
    ...call("i1", "image_generate", { prompt: "cat" }, JSON.stringify({ success: true, image: "/srv/img/cat.png" }), 2),
  ];
  s.serverFiles["/srv/out/report.md"] = "# Report\nv2";
  // Hermes saves generated images on the dashboard's own machine, which the managed files routes read.
  s.managedFiles.nodes = { "/srv/img/cat.png": { bytes: "\x89PNG\r\n\x1a\n" } };
  return s;
}

let launches = 0;
async function launch(s = server()) {
  const hermes = await connect(s.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { server: s, hermes, user: userEvent.setup() };
}

const shown = () => [...document.querySelectorAll(".out-table tbody tr")].map((tr) => tr.querySelector(".files-label")!.textContent);

async function openChat(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByText(title));
}

async function openOutputs(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Outputs" }));
  await screen.findByRole("heading", { name: "Outputs" });
  await waitFor(() => expect(document.querySelector('.files-list[aria-busy="true"]')).toBeNull());
}

describe("Outputs", () => {
  it("lists the open chat's files from tool results only, with versions, sizes and where each came from", async () => {
    const { user } = await launch();
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    expect(screen.getByRole("radio", { name: "This chat" }).getAttribute("aria-checked")).toBe("true");
    // The shell's file and the reply's mentioned path aren't Outputs.
    expect(shown()).toEqual(["<img src=x onerror=alert(1)>�gnp.html", "report.md", "report.md"]);
    expect(document.querySelector(".out-table img")).toBeNull();
    const rows = [...document.querySelectorAll(".out-table tbody tr")];
    expect(rows[1].textContent).toContain("Version 2 of 2");
    expect(rows[1].textContent).toContain("4.0 KB");
    expect(rows[2].textContent).toContain("Version 1 of 2");
    expect(rows[1].textContent).toContain("Quarterly report");
    expect(rows[1].textContent).toContain("Written by write_file");
    expect(rows[1].textContent).toContain("Available");
  });

  it("widens to every chat in the profile, searches and filters by type, and says when nothing matches", async () => {
    const { user } = await launch();
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    await user.click(screen.getByRole("radio", { name: "All chats in default" }));
    await waitFor(() => expect(shown()).toContain("cat.png"));
    expect(shown()).toHaveLength(4);
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "image");
    expect(shown()).toEqual(["cat.png"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "all");
    await user.type(screen.getByRole("textbox", { name: /Search outputs/ }), "quarterly");
    expect(shown()).toHaveLength(3);
    await user.clear(screen.getByRole("textbox", { name: /Search outputs/ }));
    await user.type(screen.getByRole("textbox", { name: /Search outputs/ }), "nothing-like-this");
    expect(screen.getByText("No outputs match.")).toBeTruthy();
  });

  it("checks again on Refresh which files are still there, and marks a deleted one missing with why", async () => {
    const { user } = await launch();
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(document.querySelectorAll(".out-avail").length).toBe(3));
    const rows = [...document.querySelectorAll(".out-table tbody tr")];
    expect(rows[0].querySelector(".out-avail")!.textContent).toMatch(/^Missing.*deleted, moved or renamed/);
    expect(rows[1].querySelector(".out-avail")!.textContent).toBe("Available");
    // A missing file can't be previewed, and says why.
    const preview = within(rows[0] as HTMLElement).getByRole("button", { name: /^Preview/ }) as HTMLButtonElement;
    expect(preview.disabled).toBe(true);
    // Read again naming its chat, as Preview and Edit read it, before it is called missing (ADR 0062).
    expect(preview.title).toBe("It isn't at this path where its chat's tools ran: it was deleted, moved or renamed. Check again, or look in its folder.");
  });

  it("marks a file the chat deleted itself Missing on opening, before Edit or Preview is clicked (#223)", async () => {
    // As on the real Hermes: write_file made the script, then the agent's own terminal call ran and deleted it.
    const s = server();
    const gone = "/srv/out/hermes-verify-install.sh";
    s.transcripts.report.push(
      ...call("w9", "write_file", { path: gone }, written(gone, 2109), 20),
      ...call("t9", "terminal", { command: `bash ${gone}; rm -f ${gone}` }, JSON.stringify({ output: "PASS", exit_code: 0 }), 22),
    );
    const { user } = await launch(s);
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    const row = [...document.querySelectorAll(".out-table tbody tr")].find((tr) => tr.querySelector(".files-label")!.textContent === "hermes-verify-install.sh") as HTMLElement;
    await waitFor(() => expect(row.querySelector(".out-avail")?.textContent).toMatch(/^Missing/));
    for (const name of [/^Edit hermes-verify-install/, /^Preview hermes-verify-install/]) {
      const button = within(row).getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toMatch(/Check again, or look in its folder\.$/);
    }
    // Its folder can still be opened to look for it.
    expect(within(row).getByRole("button", { name: /^Show hermes-verify-install\.sh's folder/ })).toBeTruthy();
  });

  it("keeps Edit and Preview off while opening still checks a file, on a slow connection (#223)", async () => {
    const s = server();
    let release!: () => void;
    const listed = new Promise<void>((r) => (release = r));
    const list = s.rest["GET /api/fs/list"];
    const { user } = await launch(s);
    s.rest["GET /api/fs/list"] = async (req) => (await listed, list(req));
    await openChat(user, "Quarterly report");
    await user.click(screen.getByRole("button", { name: "Outputs" }));
    const row = () => [...document.querySelectorAll(".out-table tbody tr")].find((tr) => tr.querySelector(".out-path")!.textContent === "/srv/out/report.md") as HTMLElement;
    await waitFor(() => expect(row()?.querySelectorAll("td")[3].textContent).toBe("Checking…"));
    for (const name of [/^Edit report\.md/, /^Preview report\.md/]) {
      const button = within(row()).getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("Checking whether it's still there…");
    }
    release();
    await waitFor(() => expect(row().querySelector(".out-avail")?.textContent).toBe("Available"));
    expect((within(row()).getByRole("button", { name: /^Edit report\.md/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens a file in the preview pane beside Outputs", async () => {
    const { user } = await launch();
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    const rows = [...document.querySelectorAll(".out-table tbody tr")];
    await user.click(within(rows[1] as HTMLElement).getByRole("button", { name: "Preview report.md" }));
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Address" }).value).toMatch(/\/report\.md$/));
    expect(screen.getByRole("heading", { name: "Outputs" })).toBeTruthy();
  });

  it("goes to the tool call that made a file, opening it", async () => {
    const { user } = await launch();
    await openChat(user, "Cat pictures");
    await openOutputs(user);
    await user.click(screen.getByRole("button", { name: "Go to the message that made cat.png" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Outputs" })).toBeNull());
    const tool = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-call="i1"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(document.activeElement).toBe(tool));
    expect(tool.classList.contains("jumped")).toBe(true);
    expect(within(tool).getByRole("button", { name: /image_generate/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("adds a Server file to the chat by its path, and takes it out again", async () => {
    const s = server();
    s.serverFiles["/srv/out/made-by-shell.csv"] = "a,b";
    const { user } = await launch(s);
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    const box = screen.getByRole("textbox", { name: /Add a server file/ });
    await user.type(box, "/srv/out/nope.csv{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't add it/);
    await user.clear(box);
    await user.type(box, "/srv/out/made-by-shell.csv{Enter}");
    await waitFor(() => expect(shown()).toContain("made-by-shell.csv"));
    expect(screen.getByText(/Added by you/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Take made-by-shell.csv out of Outputs" }));
    expect(shown()).not.toContain("made-by-shell.csv");
  });

  it("drops what a profile's read finds once the owner switched to another profile meanwhile", async () => {
    const s = server();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.rest["GET /api/sessions/report/messages"] = async () => {
      await gate;
      return { messages: [{ id: 9, role: "tool", tool_name: "write_file", tool_call_id: "late", content: written("/srv/out/late.md", 1) }] };
    };
    const { hermes, user } = await launch(s);
    await openChat(user, "Quarterly report");
    await user.click(screen.getByRole("button", { name: "Outputs" }));
    await waitFor(() => expect(document.querySelector('.files-list[aria-busy="true"]')).not.toBeNull());
    await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await user.click(await screen.findByRole("option", { name: /work/ }));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" }));
    await act(async () => {
      release();
      await hermes.idle();
    });
    // Outputs stays open, now for the work profile, which has no outputs.
    expect(screen.getByRole("heading", { name: "Outputs" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "All chats in work" }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(document.querySelector('.files-list[aria-busy="true"]')).toBeNull());
    expect(document.body.textContent).not.toContain("late.md");
    expect(localStorage.getItem("hermes-chat.outputs") ?? "").not.toContain("late.md");
  });

  it("shows many outputs a page at a time", async () => {
    const s = server();
    s.transcripts.report = Array.from({ length: 25 }, (_, i) => call(`w${i}`, "write_file", { path: `/srv/many/f${i}.txt` }, written(`/srv/many/f${i}.txt`, i), i * 2 + 1)).flat();
    const { user } = await launch(s);
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    expect(shown()).toHaveLength(20);
    expect(screen.getByText(/Showing 20 of 25/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(shown()).toHaveLength(25);
    await user.type(screen.getByRole("textbox", { name: /Search outputs/ }), "f24.");
    expect(shown()).toEqual(["f24.txt"]);
  });

  it("says discovery is partial in a chat whose file tools didn't say what they wrote, though none was found", async () => {
    const s = server();
    s.transcripts.cats = call("s1", "text_to_speech", { text: "hi" }, "Audio saved (result cut short", 1);
    const { user } = await launch(s);
    await openChat(user, "Cat pictures");
    await openOutputs(user);
    expect(screen.getByText(/No files from Hermes's tools in this chat yet/)).toBeTruthy();
    expect(screen.getByText(/Discovery is partial in 1 chat/)).toBeTruthy();
  });

  it("previews an image Hermes saved on the dashboard's machine through the managed files routes", async () => {
    const { server, user } = await launch();
    await openChat(user, "Cat pictures");
    await openOutputs(user);
    expect(screen.getByText("On the dashboard's machine")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Preview cat.png" }));
    await waitFor(() => expect(server.restRequests.some((r) => r.path === "/api/files/read" && r.query.get("path") === "/srv/img/cat.png")).toBe(true));
    expect(server.restRequests.some((r) => r.path.startsWith("/api/fs/read"))).toBe(false);
  });

  it("goes to a tool call whose file name hides a direction override, and shows the override instead of obeying it", async () => {
    const { user } = await launch();
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    await user.click(screen.getByRole("button", { name: /^Go to the message that made <img/ }));
    const tool = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-calls~="w3"], [data-call="w3"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(tool.textContent).toContain("gnp.html"));
    expect(tool.textContent).not.toContain("\u202E");
    expect(tool.textContent).toContain("\uFFFDgnp.html");
  });

  it("forgets a chat deleted elsewhere, whatever Outputs shows and whether or not it is open", async () => {
    const { hermes, user } = await launch();
    await openChat(user, "Quarterly report");
    await openOutputs(user);
    await user.click(screen.getByRole("radio", { name: "All chats in default" }));
    await waitFor(() => expect(shown()).toContain("cat.png"));
    await user.click(screen.getByRole("radio", { name: "This chat" }));
    expect(localStorage.getItem("hermes-chat.outputs")).toContain("/srv/img/cat.png");
    await act(async () => {
      await hermes.delete("cats");
      await hermes.idle();
    });
    await waitFor(() => expect(localStorage.getItem("hermes-chat.outputs")).not.toContain("/srv/img/cat.png"));
    expect(localStorage.getItem("hermes-chat.outputs")).toContain("/srv/out/report.md");
  });
});

// Issue #223: a Docker terminal backend that mounts each chat's folder at `/workspace`, as probed live at `f0d94882`.
// `write_file` reports the container path; only a read naming the chat finds it.
describe("A file in its chat's sandbox (#223)", () => {
  const SCRIPT = "/workspace/hermes-verify-install.sh";
  function sandboxed() {
    const s = new FakeHermes();
    s.sessions = [row("verify", 1, { pinned: true, title: "Verify the install" })];
    s.transcripts.verify = [
      { role: "user", text: "Check the install", row_id: 1, timestamp: 1_790_000_000 },
      ...call("w1", "write_file", { path: SCRIPT }, written(SCRIPT, 26), 2),
      ...call("w2", "write_file", { path: "/workspace/gone.md" }, written("/workspace/gone.md", 5), 4),
    ];
    // The chat's folder holds the script; the profile's own `/workspace` doesn't.
    s.sandbox = { profile: "/home/liam/hermes", chats: { verify: "/home/liam/work2" } };
    s.serverDirs.add("/home/liam/hermes");
    s.serverFiles["/home/liam/work2/hermes-verify-install.sh"] = "#!/bin/sh\necho hermes ok\n";
    return s;
  }
  const reads = (s: FakeHermes) =>
    s.restRequests.filter((r) => /^\/api\/fs\/read-/.test(r.path)).map((r) => [r.path, r.query.get("path"), r.query.get("session_id")]);
  const rowOf = (name: string) => [...document.querySelectorAll(".out-table tbody tr")].find((tr) => tr.querySelector(".files-label")!.textContent === name) as HTMLElement;

  it("opens in Preview and Edit and saves where it was read, though a read without its chat is Hermes's 404", async () => {
    const { server, user } = await launch(sandboxed());
    // What Hermes Chat asked before: no chat, so Hermes looks in the profile's own `/workspace`.
    expect(() => server.rest["GET /api/fs/read-data-url"]({ path: "/api/fs/read-data-url", query: new URLSearchParams({ path: SCRIPT, profile: "default" }) } as never)).toThrow(
      `The dashboard answered 404: {"detail":"${SANDBOX_NOT_FOUND}"}`,
    );
    await openChat(user, "Verify the install");
    await openOutputs(user);
    // Checked on opening: the folder listing misses it, the read naming the chat finds it.
    await waitFor(() => expect(rowOf("hermes-verify-install.sh").querySelector(".out-avail")!.textContent).toBe("Available"));

    await user.click(within(rowOf("hermes-verify-install.sh")).getByRole("button", { name: "Preview hermes-verify-install.sh" }));
    await waitFor(() => expect(document.querySelector(".preview-pane, aside.preview")?.textContent).toContain("echo hermes ok"));

    await user.click(within(rowOf("hermes-verify-install.sh")).getByRole("button", { name: "Edit hermes-verify-install.sh" }));
    const text = (await screen.findByRole("textbox", { name: "Text of hermes-verify-install.sh" })) as HTMLTextAreaElement;
    expect(screen.queryByText(/can't be edited here/)).toBeNull();
    expect(text.value).toBe("#!/bin/sh\necho hermes ok\n");
    await user.click(text);
    await user.paste("# checked\n");
    await user.click(screen.getByRole("button", { name: "Review changes…" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved\. Hermes has your edit, read back from the server\./);
    expect(server.fsWrites.map((w) => [w.path, w.session])).toEqual([[SCRIPT, "verify"]]);
    expect(server.serverFiles["/home/liam/work2/hermes-verify-install.sh"]).toContain("# checked");
    expect(server.serverFiles["/home/liam/hermes/hermes-verify-install.sh"]).toBeUndefined();
    // Every read of it named its chat.
    expect(reads(server).filter(([, path]) => path === SCRIPT).every(([, , chat]) => chat === "verify")).toBe(true);
  });

  it("says Missing before it is opened when the chat's copy is really gone, with Edit and Preview off and a way to look again", async () => {
    const { server, user } = await launch(sandboxed());
    await openChat(user, "Verify the install");
    await openOutputs(user);
    const gone = () => rowOf("gone.md");
    await waitFor(() => expect(gone().querySelector(".out-avail")!.textContent).toMatch(/^Missing.*can't find it in its chat's sandbox/));
    const preview = within(gone()).getByRole("button", { name: "Preview gone.md" }) as HTMLButtonElement;
    const edit = within(gone()).getByRole("button", { name: "Edit gone.md" }) as HTMLButtonElement;
    expect(preview.disabled && edit.disabled).toBe(true);
    expect(edit.title).toMatch(/^Hermes can't find it in its chat's sandbox\..*Check again, or look in its folder\.$/);
    expect(within(gone()).getByRole("button", { name: "Show gone.md's folder in Server files" })).toBeTruthy();

    // Put back in the chat's folder, Check again finds it.
    server.serverFiles["/home/liam/work2/gone.md"] = "back";
    await user.click(within(gone()).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(gone().querySelector(".out-avail")!.textContent).toBe("Available"));
    expect((within(gone()).getByRole("button", { name: "Edit gone.md" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("The Outputs status banners", () => {
  it("keep the spinner a small circle, with the text beside it taking the rest of the row (#286)", () => {
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync("src/styles.css", "utf8") as string;
    document.head.append(sheet);
    try {
      const none = () => {};
      render(
        <OutputsScreen
          snapshot={{ chats: {}, added: [], waiting: 0, indexing: { done: 1, total: 4 }, checking: true }}
          outputs={[]}
          scope="profile"
          scopes={{ profile: "default" }}
          unindexed={0}
          partialChats={0}
          chatTitle={() => undefined}
          status="connected"
          canAdd={false}
          onScope={none}
          onRefresh={none}
          onIndexMore={none}
          onAdd={async () => {}}
          onRemove={none}
          onPreview={none}
          onJump={none}
          onShowFolder={none}
          onClose={none}
        />,
      );
      for (const text of ["Reading chats for outputs: 1 of 4…", "Checking whether the files are still there…"]) {
        const label = screen.getByText(text);
        const spinner = label.closest(".files-banner")!.querySelector(".spinner")!;
        expect([getComputedStyle(spinner).flexGrow, getComputedStyle(spinner).width, getComputedStyle(label).flexGrow]).toEqual(["0", "11px", "1"]);
      }
    } finally {
      sheet.remove();
    }
  });
});
