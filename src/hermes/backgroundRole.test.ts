// @vitest-environment jsdom
// A background connection (ADR 0125): it keeps its socket and the chats it holds, shows their Approvals and notifies
// about them, and changes nothing on the server. The rule is kept in the instance, not only in the UI.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { BackgroundRefused, connect, type Hermes } from "./transport";
import { localChatCache } from "./chatCache";
import { isWaiting } from "./model";

const nas = { mode: "ssh" as const, sshTarget: "liam@nas", url: "", username: "liam" };
const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

async function open(server = new FakeHermes()) {
  const notices: { title: string; body: string }[] = [];
  const hermes = await connect(server.openPipe, undefined, localChatCache(nas), async (n) => void notices.push(n));
  running.push(hermes);
  return { server, hermes, notices };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("A background connection", () => {
  it("refuses to send, start, branch or search, and drains no queue until it is the target again", async () => {
    const { server, hermes } = await open();
    const id = await hermes.newChat();
    await hermes.open(id);
    hermes.setRole("background");

    expect(await hermes.send(id, "Deploy it")).toEqual({ delivery: "unsent", reason: new BackgroundRefused().message });
    await expect(hermes.newChat()).rejects.toBeInstanceOf(BackgroundRefused);
    await expect(hermes.search("deploy")).rejects.toBeInstanceOf(BackgroundRefused);
    await expect(hermes.browse({ archived: "exclude" })).rejects.toBeInstanceOf(BackgroundRefused);
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
    expect(server.requests.filter((r) => r.method === "session.create")).toHaveLength(1);

    hermes.enqueue(id, "Then check the logs");
    await settle();
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toEqual([]);
    expect(hermes.getSnapshot().queues[id]?.items).toHaveLength(1);

    hermes.setRole("target");
    await settle();
    await settle();
    expect(server.requests.filter((r) => r.method === "prompt.submit").map((r) => r.params.text)).toEqual(["Then check the logs"]);
  });

  it("shows an Approval on a chat it holds, and notifies about it whether or not the window has focus", async () => {
    const { server, hermes, notices } = await open();
    const id = await hermes.newChat();
    await hermes.open(id);
    hermes.setFocused(true);
    hermes.setRole("background");
    server.askApproval(server.runtimeIdOf(id)!);
    await settle();
    const chat = hermes.getSnapshot().chats.find((c) => c.id === id)!;
    expect(chat.items.some((i) => i.kind === "approval" && isWaiting(i))).toBe(true);
    expect(notices).toHaveLength(1);
    // Nothing is on screen in the background, so Hermes isn't told the card was shown.
    expect(server.requests.filter((r) => r.method === "approval.received")).toEqual([]);
  });

  it("answers no request it doesn't show on a server that doesn't share chats, where the target refuses it", async () => {
    const server = new FakeHermes();
    server.declinesNotShown = false;
    const { hermes } = await open(server);
    const id = await hermes.newChat();
    await hermes.open(id);
    const sid = server.runtimeIdOf(id)!;

    server.ask(sid, "terminal.read", {});
    await settle();
    expect(server.responses.map((r) => r.error?.code)).toEqual([-32601]);

    hermes.setRole("background");
    server.ask(sid, "terminal.read", {});
    server.ask(sid, "tour", {});
    await settle();
    expect(server.responses).toHaveLength(1);
  });

  it("declines a window-owned request with 4404 only where the server counts that as one client declining", async () => {
    const { server, hermes } = await open();
    const id = await hermes.newChat();
    await hermes.open(id);
    hermes.setRole("background");
    server.ask(server.runtimeIdOf(id)!, "preview.read", {});
    server.ask(server.runtimeIdOf(id)!, "some.future.request", {});
    await settle();
    expect(server.responses.map((r) => r.error?.code)).toEqual([4404]);
  });
});
