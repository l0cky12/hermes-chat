// @vitest-environment jsdom
// The Import transcripts dialog against FakeHermes, with the Open dialog replaced: what it shows before anything is sent,
// that Cancel and a bad file send nothing, the duplicate warning on a second import, and the summary. Also that an
// imported chat has no composer.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chatMarkdown } from "../hermes/exportChat";
import { FakeHermes } from "../hermes/fakeHermes";
import { importLedger, type ImportFormat, type PickedTranscript } from "../hermes/importTranscripts";
import { memoryCache } from "../hermes/memoryCache";
import type { Chat } from "../hermes/model";
import { connect } from "../hermes/transport";
import { ChatPane } from "./ChatPane";
import { ScreenshotDesk, type ScreenshotApi } from "../hermes/screenshots";
import { ImportDialog, type ImportWiring } from "./ImportTranscripts";
import { RestError } from "../hermes/pipe";

const noScreenshots: ScreenshotApi = { capture: () => Promise.reject(new Error("no screenshots in this test")), discard: async () => {} };

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(cleanup);

const exportedChat: Chat = {
  id: "c",
  title: "Release checklist",
  source: "app",
  settled: false,
  updatedAt: 0,
  runtimeId: "rt",
  items: [
    { kind: "user", id: "u", text: "What's left?", attachments: ["plan.pdf"] },
    { kind: "assistant", id: "a", text: "Tag the build." },
  ],
};
const md = chatMarkdown(exportedChat, new Date(Date.UTC(2026, 10, 1, 8, 0)));

async function setUp(files: (PickedTranscript | null)[]) {
  const server = new FakeHermes();
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  await hermes.sync();
  const data = new Map<string, string>();
  const ledger = importLedger({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) });
  const picks: ImportFormat[] = [];
  const imported: { profile: string; ids: string[]; project?: string }[] = [];
  const onClose = vi.fn();
  const opened: string[] = [];
  const wiring = (profile = "default"): ImportWiring => ({
    imports: hermes.imports,
    profile,
    scope: "scope",
    projects: profile === "default" ? [{ id: "p1", name: "Launch", folders: [], archived: false }] : [],
    onImported: (p, chats, project) => imported.push({ profile: p, ids: chats.map((c) => c.id), project }),
    onOpen: (id) => opened.push(id),
    pick: async (format) => {
      picks.push(format);
      return files.shift() ?? null;
    },
    ledger,
  });
  const view = render(<ImportDialog wiring={wiring()} connected onClose={onClose} />, { wrapper: StrictMode });
  const rerender = (profile: string) => act(() => view.rerender(<ImportDialog wiring={wiring(profile)} connected onClose={onClose} />));
  const posts = () => server.restRequests.filter((r) => r.method === "POST");
  const again = () => {
    cleanup();
    render(<ImportDialog wiring={wiring()} connected onClose={onClose} />);
  };
  return { server, hermes, picks, imported, onClose, opened, posts, rerender, again };
}

const dialog = () => screen.getByRole("dialog", { name: "Import transcripts" });

describe("Import transcripts", () => {
  it("previews a file without sending anything, imports it into the project picked, and sums up", async () => {
    const user = userEvent.setup();
    const t = await setUp([{ name: "Release checklist.md", path: "/home/me/Release checklist.md", text: md }]);
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(t.picks).toEqual(["markdown"]);
    await screen.findByRole("button", { name: "Import 1 chat" });
    const box = dialog();
    expect(box.textContent).toContain("/home/me/Release checklist.md");
    expect(box.textContent).toContain("1 chat, 2 messages, 0 tool calls, 1 attachment");
    expect(box.textContent).toContain("the default profile, Settled");
    expect(box.textContent).toMatch(/every message is dated when the file was exported, 2026-11-01 08:00 UTC/);
    expect(box.textContent).toMatch(/1 attachment is named in the file but not in it/);
    expect(box.textContent).toMatch(/Imported chats are read-only in Hermes Chat/);
    expect(t.posts()).toHaveLength(0);

    await user.selectOptions(screen.getByLabelText("Project"), "p1");
    await user.click(screen.getByRole("button", { name: "Import 1 chat" }));
    expect((await screen.findByRole("status")).textContent).toMatch("Imported 1 chat into default, in Launch.");
    expect(t.posts()).toHaveLength(1);
    const id = t.server.sessions[0].id;
    expect(t.server.sessions[0]).toMatchObject({ source: "import", title: `Release checklist (imported ${id})` });
    expect(t.imported).toEqual([{ profile: "default", ids: [id], project: "p1" }]);
    await user.click(within(screen.getByRole("list", { name: "Imported chats" })).getByRole("button", { name: "Open" }));
    expect(t.opened).toEqual([id]);
  });

  it("warns that the file was imported before, and has nothing new to send", async () => {
    const user = userEvent.setup();
    const file = { name: "r.md", path: "/r.md", text: md };
    const t = await setUp([file, file]);
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await user.click(await screen.findByRole("button", { name: "Import 1 chat" }));
    await screen.findByText(/Imported 1 chat/);
    t.again();
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    const warning = await screen.findByText(/You imported this file/);
    await waitFor(() => expect(warning.textContent).toMatch(/Hermes already has this chat, so there's nothing new to import\./));
    expect((screen.getByRole("button", { name: "Nothing new to import" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Already imported")).toBeTruthy();
    expect(t.posts()).toHaveLength(1);
  });

  it("refuses a corrupted file whole, saying where, and sends nothing", async () => {
    const user = userEvent.setup();
    const t = await setUp([{ name: "s.jsonl", path: "/s.jsonl", text: '{"id":"a","messages":[]}\n{"id":"b", "messa\n' }]);
    await user.click(screen.getByLabelText(/Hermes session export/));
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(t.picks).toEqual(["jsonl"]);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Nothing was imported\. Line 2 isn't valid JSON/);
    expect((screen.getByRole("button", { name: "Choose file…" }) as HTMLButtonElement).disabled).toBe(false);
    expect(t.posts()).toHaveLength(0);
    expect(t.server.restRequests.filter((r) => r.path.includes("mutation-snapshot"))).toHaveLength(0);
  });

  it("closes on Escape before importing, and a picker closed without a file changes nothing", async () => {
    const user = userEvent.setup();
    const t = await setUp([null, { name: "r.md", path: "/r.md", text: md }]);
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Choose file…" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByRole("button", { name: "Import 1 chat" });
    await user.keyboard("{Escape}");
    expect(t.onClose).toHaveBeenCalled();
    expect(t.posts()).toHaveLength(0);
  });

  it("drops a preview when the profile changes, so nothing goes to the wrong one, nor into its project", async () => {
    const user = userEvent.setup();
    const t = await setUp([{ name: "r.md", path: "/r.md", text: md }, { name: "r.md", path: "/r.md", text: md }]);
    t.server.otherProfiles.work = [];
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await user.selectOptions(await screen.findByLabelText("Project"), "p1");
    t.rerender("work");
    expect((await screen.findByRole("alert")).textContent).toMatch(/The profile changed to work, so nothing was imported/);
    expect(t.posts()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await user.click(await screen.findByRole("button", { name: "Import 1 chat" }));
    await screen.findByText(/Imported 1 chat into work\./);
    expect(t.imported).toEqual([{ profile: "work", ids: [t.server.otherProfiles.work[0].id], project: undefined }]);
  });

  it("doesn't pass on chats Hermes skipped, which keep their own source and title", async () => {
    const user = userEvent.setup();
    const file = { name: "s.jsonl", path: "/s.jsonl", text: '{"id":"cli_1","source":"cli","title":"Old","messages":[{"role":"user","content":"hi"}]}\n' };
    const t = await setUp([file]);
    // The check of what Hermes has fails, so the chat is sent, and Hermes skips it.
    t.hermes.imports.onServer = async () => {
      throw new RestError(503, "busy");
    };
    t.server.sessions.push({ ...t.server.sessions[0], id: "cli_1", source: "cli", title: "Old" } as never);
    await user.click(screen.getByLabelText(/Hermes session export/));
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await user.click(await screen.findByRole("button", { name: "Import 1 chat" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Nothing new was imported\. Hermes already had 1 chat, so it was skipped\./);
    expect(t.imported).toEqual([{ profile: "default", ids: [], project: undefined }]);
  });

  it("still imports when it can't check what Hermes has, and Hermes skips what it has", async () => {
    const user = userEvent.setup();
    const t = await setUp([{ name: "r.md", path: "/r.md", text: md }]);
    t.hermes.imports.onServer = async () => {
      throw new RestError(503, "busy");
    };
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect((await screen.findByText(/Couldn't check what Hermes already has/)).textContent).toMatch(/503/);
    await user.click(screen.getByRole("button", { name: "Import 1 chat" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Imported 1 chat/);
  });

  it("keeps the record of an earlier import when a later one is refused", async () => {
    const user = userEvent.setup();
    const file = { name: "r.md", path: "/r.md", text: md };
    const t = await setUp([file, file, file]);
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await user.click(await screen.findByRole("button", { name: "Import 1 chat" }));
    await screen.findByText(/Imported 1 chat/);
    // The chat goes from Hermes, so the file has something new; then Hermes refuses it.
    t.server.sessions = [];
    t.server.rest["POST /api/sessions/import"] = () => {
      throw new RestError(400, '{"detail":"invalid_params"}');
    };
    t.again();
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await user.click(await screen.findByRole("button", { name: "Import 1 chat" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/imported nothing/);
    await user.click(screen.getByRole("button", { name: "Back" }));
    t.again();
    t.server.sessions = [];
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(await screen.findByText(/You imported this file/)).toBeTruthy();
  });

  it("an imported chat has no composer, and says how to carry on", () => {
    const chat: Chat = { ...exportedChat, source: "import", settled: true };
    render(
      <ChatPane
        chat={chat}
        status="connected"
        draft="" draftKey="draft" screenshots={new ScreenshotDesk(noScreenshots)}
        onDraft={() => {}}
        onDraftStep={() => undefined}
        onRetry={() => {}}
        onEdit={() => {}}
        onDismiss={() => {}}
        onAttach={async () => ({ attachments: [], refused: [] })}
        onSend={() => {}}
        onStop={() => {}}
        onAnswer={() => {}}
        onQuestion={() => {}}
      />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("note").textContent).toMatch(/imported transcript, so it's read-only here.*Start a new chat to continue/);
    expect(document.body.textContent).toContain("Imported from a transcript file.");
  });
});
