import { afterEach, describe, expect, it, vi } from "vitest";
import { editFlags, FakeHermes, row } from "./fakeHermes";
import { connect, NOTICES, type NoticeActions, type NoticeCard, type Notify } from "./transport";

/** A new chat with a reply under way, out of focus unless `focused`; `shown` collects the notifications. */
async function replying(opts: { focused?: boolean; notify?: Notify } = {}) {
  const server = new FakeHermes();
  const shown: { title: string; body: string }[] = [];
  const notify: Notify = opts.notify ?? (async (n) => void shown.push(n));
  const hermes = await connect(server.openPipe, undefined, undefined, notify);
  const id = await hermes.newChat();
  await hermes.send(id, "Clean up the logs in /var/secret");
  const runtime = server.runtimeIdOf(id)!;
  server.event(runtime, "message.start");
  hermes.setFocused(!!opts.focused);
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  return { server, hermes, id, runtime, shown, chat };
}

const finish = (server: FakeHermes, runtime: string) =>
  server.event(runtime, "message.complete", { text: "Deleted 3 files from /var/secret", status: "complete" });

const readWrites = (server: FakeHermes) =>
  server.restRequests.filter((r) => r.method === "PATCH" && "unread" in (r.body ?? {})).map((r) => editFlags(r.body));

describe("Desktop notifications", () => {
  afterEach(() => void vi.useRealTimers());

  it("tells the owner a reply finished while the window is out of focus, without quoting the chat", async () => {
    const { server, hermes, runtime, shown } = await replying();
    finish(server, runtime);
    await hermes.idle();
    expect(shown).toEqual([NOTICES.finished]);
    expect(JSON.stringify(shown)).not.toMatch(/secret|logs|Deleted/);
  });

  it("tells the owner Hermes is asking for an Approval, without the command", async () => {
    const { server, hermes, runtime, shown } = await replying();
    server.askApproval(runtime, { command: "rm -rf /var/secret", description: "recursive delete" });
    await hermes.idle();
    expect(shown).toEqual([NOTICES.approval]);
    expect(JSON.stringify(shown)).not.toMatch(/secret|rm -rf|recursive/);
  });

  it("stays quiet while the window has focus", async () => {
    const { server, hermes, runtime, shown } = await replying({ focused: true });
    server.askApproval(runtime);
    finish(server, runtime);
    await hermes.idle();
    expect(shown).toEqual([]);
  });

  it("tells the owner once when Hermes repeats the end of a turn", async () => {
    const { server, hermes, runtime, shown } = await replying();
    finish(server, runtime);
    finish(server, runtime);
    server.event(runtime, "error", { message: "late" });
    await hermes.idle();
    expect(shown).toEqual([NOTICES.finished]);
  });

  it("tells the owner once about an Approval Hermes lists again after a reconnect", async () => {
    vi.useFakeTimers();
    const { server, hermes, runtime, shown, chat } = await replying();
    server.askApproval(runtime);
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(chat().items.filter((i) => i.kind === "approval")).toHaveLength(1);
    expect(shown).toEqual([NOTICES.approval]);
  });

  it("doesn't notify an Approval that arrived in focus when Hermes lists it again out of focus", async () => {
    vi.useFakeTimers();
    const { server, hermes, runtime, shown } = await replying({ focused: true });
    server.askApproval(runtime);
    hermes.setFocused(false);
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes.idle();
    expect(shown).toEqual([]);
  });

  for (const [how, notify] of [
    ["refuses", () => Promise.reject(new Error("org.freedesktop.DBus.Error.AccessDenied"))],
    ["is missing", () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown"); }],
  ] as [string, Notify][])
    it(`leaves the chat working when the notification service ${how}`, async () => {
      const { server, hermes, id, runtime, chat } = await replying({ notify });
      server.askApproval(runtime);
      finish(server, runtime);
      await hermes.idle();
      expect(chat().running).toBe(false);
      expect(chat().items.filter((i) => i.kind === "error")).toEqual([]);
      expect(hermes.getSnapshot().syncError).toBeUndefined();
      await hermes.send(id, "again");
      expect(chat().items.at(-1)).toMatchObject({ kind: "user", text: "again" });
    });
});

describe("Acting on a notification about a waiting card (ADR 0173)", () => {
  /** A reply under way out of focus, with what each notification offers kept beside it. */
  async function offering() {
    const offered: (NoticeActions | undefined)[] = [];
    const r = await replying({ notify: async (_, actions) => void offered.push(actions) });
    const opened: NoticeCard[] = [];
    r.hermes.onNoticeOpen((card) => opened.push(card));
    return { ...r, offered, opened };
  }

  it("opens the Approval's card on a click, and answers nothing", async () => {
    const { server, hermes, id, runtime, chat, offered, opened } = await offering();
    const { id: card } = server.askApproval(runtime);
    await hermes.idle();
    expect(offered).toHaveLength(1);
    offered[0]!.open();
    expect(opened).toEqual([{ profile: "default", chatId: id, title: chat().title, itemId: card }]);
    await hermes.idle();
    expect(server.approvalAnswers).toEqual([]);
    expect(chat().items.find((i) => i.id === card)).not.toHaveProperty("answer");
  });

  it("denies the Approval it is about the way the card's Deny button does, and offers nothing that approves", async () => {
    const { server, hermes, runtime, chat, offered } = await offering();
    const { id: card } = server.askApproval(runtime);
    await hermes.idle();
    expect(Object.keys(offered[0]!).sort()).toEqual(["deny", "open"]);
    offered[0]!.deny!();
    await hermes.idle();
    expect(server.approvalAnswers).toEqual([{ id: card, choice: "deny", via: expect.any(String) }]);
    expect(chat().items.find((i) => i.id === card)).toMatchObject({ answer: "deny" });
    // Clicked again, or once Hermes stopped waiting: nothing more goes.
    offered[0]!.deny!();
    await hermes.idle();
    expect(server.approvalAnswers).toHaveLength(1);
  });

  it("leaves an Approval answered in the chat meanwhile as the chat answered it", async () => {
    const { server, hermes, id, runtime, offered } = await offering();
    const { id: card } = server.askApproval(runtime);
    await hermes.idle();
    await hermes.answerApproval(id, card!, "once");
    await hermes.idle();
    offered[0]!.deny!();
    await hermes.idle();
    expect(server.approvalAnswers.map((a) => a.choice)).toEqual(["once"]);
  });

  it("denies nothing once the owner switched to another profile, and says it wasn't denied, with a click that opens the card", async () => {
    const offered: { n: { title: string; body: string }; actions?: NoticeActions }[] = [];
    const { server, hermes, id, runtime, chat } = await replying({ notify: async (n, actions) => void offered.push({ n, actions }) });
    const opened: NoticeCard[] = [];
    hermes.onNoticeOpen((card) => opened.push(card));
    const { id: card } = server.askApproval(runtime);
    await hermes.idle();
    const title = chat().title;
    await hermes.switchProfile("work");
    await hermes.idle();
    offered[0]!.actions!.deny!();
    await hermes.idle();
    expect(server.approvalAnswers).toEqual([]);
    expect(offered.map((o) => o.n)).toEqual([NOTICES.approval, NOTICES.notDenied]);
    expect(Object.keys(offered[1]!.actions!)).toEqual(["open"]);
    offered[1]!.actions!.open();
    expect(opened).toEqual([{ profile: "default", chatId: id, title, itemId: card }]);
  });

  it("says an Approval approved in the chat meanwhile wasn't denied", async () => {
    const offered: { title: string; body: string }[] = [];
    const notices: NoticeActions[] = [];
    const { server, hermes, id, runtime } = await replying({ notify: async (n, actions) => void (offered.push(n), actions && notices.push(actions)) });
    const { id: card } = server.askApproval(runtime);
    await hermes.idle();
    await hermes.answerApproval(id, card!, "once");
    notices[0]!.deny!();
    await hermes.idle();
    expect(server.approvalAnswers.map((a) => a.choice)).toEqual(["once"]);
    expect(offered).toEqual([NOTICES.approval, NOTICES.notDenied]);
  });

  it("offers a question's card to open, with no Deny, and a finished reply nothing", async () => {
    const { server, hermes, runtime, offered } = await offering();
    server.askSudo(runtime);
    await hermes.idle();
    finish(server, runtime);
    await hermes.idle();
    expect(offered).toHaveLength(2);
    expect(Object.keys(offered[0]!)).toEqual(["open"]);
    expect(offered[1]).toBeUndefined();
  });
});

describe("The chat on screen, out of focus", () => {
  it("isn't marked read when a reply in it finishes, until the window is back in focus", async () => {
    const { server, hermes, id, runtime } = await replying({ focused: true });
    await hermes.open(id);
    await hermes.idle();
    const opened = readWrites(server).length;

    hermes.setFocused(false);
    finish(server, runtime);
    await hermes.idle();
    expect(readWrites(server).slice(opened)).toEqual([]);

    hermes.setFocused(true);
    await hermes.idle();
    expect(readWrites(server).slice(opened)).toEqual([{ unread: false, profile: "default" }]);
  });

  it("isn't marked read when opened again by a reconnect", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1, { last_read_at: 0 })];
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    hermes.setFocused(false);
    await hermes.open("a");
    await hermes.idle();
    expect(readWrites(server)).toEqual([]);

    hermes.setFocused(true);
    await hermes.idle();
    expect(readWrites(server)).toEqual([{ unread: false, profile: "default" }]);
  });

  it("isn't marked read on coming back if the owner left it meanwhile", async () => {
    const { server, hermes, id, runtime } = await replying({ focused: true });
    await hermes.open(id);
    await hermes.idle();
    const opened = readWrites(server).length;
    hermes.setFocused(false);
    finish(server, runtime);
    hermes.leave(id);
    hermes.setFocused(true);
    await hermes.idle();
    expect(readWrites(server).slice(opened)).toEqual([]);
  });
});
