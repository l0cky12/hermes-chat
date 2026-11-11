// A message whose send fails, or whose fate can't be known, stays in its chat with its words, and is sent again only
// when the owner asks. Whether one Hermes may have got did arrive is settled by reading the chat's history back (ADR
// 0006). These run the real transport against FakeHermes, and the real chat cache over a localStorage that outlives
// a restart, the way App wires them together.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSignIn } from "./account";
import { localChatCache } from "./chatCache";
import { FakeHermes, row } from "./fakeHermes";
import { type Item, isOutgoing } from "./model";
import { type Hermes, connect, readSaved } from "./transport";

const nas: SavedSignIn = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" };
/** Sent as the owner typed it, inner spaces, line break and all. */
const TEXT = "Rotate the nginx logs,\n  then restart it ✓";
const ROTATE = "/home/liam/rotate.sh";

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The outbox kept on this computer for `c1`. */
const kept = () => localChatCache(nas).loadOutbox("default").c1 ?? [];
/** The Saved copy of `c1`. */
const savedCopy = () => localChatCache(nas).loadTranscript("default", "c1")?.items ?? [];
const plain = (items: Item[]) => items.filter((i) => i.kind === "user" && !i.outgoing && i.text === TEXT);

/** Launches the app on `server`, signed in, with its list synced. */
async function launch(server: FakeHermes) {
  const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
  await hermes.sync();
  return hermes;
}

function helpers(server: FakeHermes, hermes: () => Hermes) {
  const chat = () => hermes().getSnapshot().chats.find((c) => c.id === "c1")!;
  return {
    chat,
    /** The message sent from here, as the chat shows it. */
    sent: () => chat().items.find((i) => i.kind === "user" && i.text === TEXT),
    submits: () => server.requests.filter((r) => r.method === "prompt.submit"),
    /** The owner's messages Hermes has stored for `c1`, with this text. */
    stored: () => (server.transcripts.c1 ?? []).filter((m) => m.role === "user" && m.text === TEXT),
  };
}

/** The chat `c1` with two stored rows, open in the app. */
async function ready() {
  const server = new FakeHermes();
  server.sessions = [row("c1", 0)];
  server.transcripts.c1 = [
    { role: "user", text: "How full is the NAS?", row_id: 1 },
    { role: "assistant", text: "82% used.", row_id: 2 },
  ];
  let hermes = await launch(server);
  await hermes.open("c1");
  /** Closes the app and launches it again on the same computer: `online` on the server, else while it can't be reached. */
  const relaunch = async (online = true) => {
    await hermes.close();
    if (online) hermes = await launch(server);
    else {
      server.refuse = "Can't reach the Hermes dashboard: network is unreachable";
      hermes = readSaved(server.openPipe, server.refuse, localChatCache(nas))!;
    }
    return hermes;
  };
  return { server, hermes: () => hermes, relaunch, ...helpers(server, () => hermes) };
}

describe("Case 1: the send fails before Hermes accepts it", () => {
  it("Hermes refuses it: the message stays in the chat marked failed, word for word, with Hermes's reason", async () => {
    const { server, hermes, chat, sent, stored } = await ready();
    server.rejectPrompt = { code: 4009, message: "session busy" };

    expect(await hermes().send("c1", TEXT)).toEqual({ delivery: "unsent", reason: "session busy" });
    expect(sent()).toMatchObject({ text: TEXT, outgoing: { state: "failed", reason: "session busy" } });
    expect(chat()).toMatchObject({ running: false });
    // The message says it; there's no separate error line.
    expect(chat().items.filter((i) => i.kind === "error")).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it("the connection can't take the frame: failed, and nothing reached Hermes", async () => {
    const { server, hermes, sent, submits } = await ready();
    server.failSend = "The connection to Hermes is closed.";
    expect(await hermes().send("c1", TEXT)).toMatchObject({ delivery: "unsent" });
    expect(sent()).toMatchObject({ outgoing: { state: "failed", reason: "The connection to Hermes is closed." } });
    expect(submits()).toHaveLength(0);
  });

  it("the connection is down already: failed without going out", async () => {
    const { server, hermes, sent, submits } = await ready();
    server.refuse = "connection refused";
    server.drop();
    expect(await hermes().send("c1", TEXT)).toEqual({ delivery: "unsent", reason: "Not connected to Hermes." });
    expect(sent()).toMatchObject({ outgoing: { state: "failed", reason: "Not connected to Hermes." } });
    expect(submits()).toHaveLength(0);
  });

  it("a failed message is never saved as if Hermes had it, even when the chat is saved again later", async () => {
    const { server, hermes, chat } = await ready();
    server.rejectPrompt = { code: 4009, message: "session busy" };
    await hermes().send("c1", TEXT);
    server.rejectPrompt = undefined;
    await hermes().send("c1", "Something else");
    server.event(chat().runtimeId!, "message.complete", { text: "On it.", status: "complete" });

    expect(plain(savedCopy())).toEqual([]);
    expect(savedCopy().map((i) => (i.kind === "user" || i.kind === "assistant" ? i.text : i.kind))).toEqual([
      "How full is the NAS?",
      "82% used.",
      "Something else",
      "On it.",
    ]);
  });

  it("after failed messages are dismissed, the next reply still gets an id no other item in the chat has", async () => {
    const { server, hermes, chat } = await ready();
    server.rejectPrompt = { code: 4009, message: "session busy" };
    await hermes().send("c1", "First try");
    await hermes().send("c1", "Second try");
    server.rejectPrompt = undefined;
    await hermes().send("c1", "Something else");
    server.event(chat().runtimeId!, "message.complete", { text: "On it.", status: "complete" });
    for (const failed of chat().items.filter(isOutgoing)) hermes().dismiss("c1", failed.id);

    await hermes().send("c1", "And then?");
    server.event(chat().runtimeId!, "message.delta", { text: "Done." });
    server.event(chat().runtimeId!, "message.complete", { status: "complete" });

    const ids = chat().items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(chat().items.map((i) => (i.kind === "user" || i.kind === "assistant" ? i.text : i.kind))).toEqual([
      "How full is the NAS?",
      "82% used.",
      "Something else",
      "On it.",
      "And then?",
      "Done.",
    ]);
  });
});

describe("Case 2: Stop mid-stream", () => {
  it("labels the reply stopped, not failed: the message stays sent, nothing is pending, and the Saved copy holds the turn", async () => {
    const { server, hermes, chat, sent } = await ready();
    await hermes().send("c1", TEXT);
    const runtime = chat().runtimeId!;
    server.event(runtime, "message.start");
    server.event(runtime, "message.delta", { text: "Rotating" });
    await hermes().stop("c1");
    // What the wire sends for a stopped turn (research doc §8): `message.complete` with status "interrupted".
    server.event(runtime, "message.complete", { text: "Rotating", status: "interrupted", partial: true });

    expect(chat()).toMatchObject({ running: false, stopping: false });
    expect(sent()).toEqual({ kind: "user", id: expect.any(String), text: TEXT });
    expect(chat().items.at(-1)).toMatchObject({ kind: "assistant", text: "Rotating", interrupted: true });
    expect(chat().items.some((i) => isOutgoing(i) || i.kind === "error")).toBe(false);
    expect(kept()).toEqual([]);
    expect(savedCopy().slice(-2)).toEqual([
      { kind: "user", id: expect.any(String), text: TEXT },
      { kind: "assistant", id: expect.any(String), text: "Rotating", interrupted: true },
    ]);
  });

  it("after a restart the stopped turn reads back from the Saved copy as it was, with nothing pending", async () => {
    const { server, hermes, chat, relaunch } = await ready();
    await hermes().send("c1", TEXT);
    const runtime = chat().runtimeId!;
    server.event(runtime, "message.delta", { text: "Rotating" });
    await hermes().stop("c1");
    server.event(runtime, "message.complete", { text: "Rotating", status: "interrupted" });

    const after = await relaunch(false);
    await after.open("c1");
    expect(chat().items.slice(-2)).toMatchObject([
      { kind: "user", text: TEXT },
      { kind: "assistant", text: "Rotating", interrupted: true },
    ]);
    expect(chat().items.some(isOutgoing)).toBe(false);
    expect(chat().running).toBeFalsy();
  });

  it("Stop while the message is still going out, then Hermes refuses it: failed, never stopped, and not left running", async () => {
    const { server, hermes, chat, sent } = await ready();
    const submit = server.handlers["prompt.submit"];
    let answer = () => {};
    server.handlers["prompt.submit"] = (r) => void (answer = () => server.fail(r.id, 4009, "session busy"));

    const sending = hermes().send("c1", TEXT);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toMatchObject({ outgoing: { state: "sending" } });
    const stopping = hermes().stop("c1");
    answer();
    await Promise.all([sending, stopping]);
    server.handlers["prompt.submit"] = submit;

    expect(server.requests.map((r) => r.method)).not.toContain("session.interrupt");
    expect(chat().running).toBe(false);
    expect(chat().stopping).toBeFalsy();
    expect(sent()).toMatchObject({ outgoing: { state: "failed", reason: "session busy" } });
    expect(chat().items.some((i) => i.kind === "assistant" && i.interrupted)).toBe(false);
  });
});

describe("Case 3: the connection drops mid-send", () => {
  it("is marked as maybe sent, with why, until Hermes is back", async () => {
    const { server, hermes, sent, submits } = await ready();
    server.dropOnPrompt = "lost";
    const delivery = await hermes().send("c1", TEXT);
    expect(delivery).toEqual({ delivery: "unknown", reason: expect.stringContaining("closed by the server") });
    expect(sent()).toMatchObject({ outgoing: { state: "unknown", reason: expect.stringContaining("dropped before Hermes confirmed it") } });
    expect(submits()).toHaveLength(1);
    expect(kept()).toMatchObject([{ text: TEXT, outgoing: { state: "unknown" } }]);
  });

  it("on reconnect, a message Hermes stored shows from its history, and nothing is sent again", async () => {
    const { server, hermes, chat, submits, stored } = await ready();
    server.dropOnPrompt = "stored";
    expect(await hermes().send("c1", TEXT)).toMatchObject({ delivery: "unknown" });

    await hermes().reconnect();
    await hermes().idle();
    expect(chat().items.some(isOutgoing)).toBe(false);
    expect(plain(chat().items)).toHaveLength(1);
    expect(stored()).toHaveLength(1);
    expect(submits()).toHaveLength(1);
    expect(kept()).toEqual([]);
  });

  it("on reconnect, the optimistic message goes when the history says it never arrived, and only a failed one with Retry stays", async () => {
    const { server, hermes, chat, sent, submits } = await ready();
    server.dropOnPrompt = "lost";
    await hermes().send("c1", TEXT);

    await hermes().reconnect();
    await hermes().idle();
    expect(plain(chat().items)).toEqual([]);
    expect(sent()).toMatchObject({ outgoing: { state: "failed", reason: expect.stringContaining("never arrived") } });
    expect(plain(savedCopy())).toEqual([]);
    expect(submits()).toHaveLength(1);
  });

  it("the same words sent earlier don't count as this message arriving", async () => {
    const { server, chat, relaunch } = await ready();
    server.transcripts.c1.push({ role: "user", text: TEXT, row_id: 3 }, { role: "assistant", text: "Done.", row_id: 4 });
    const hermes = await relaunch();
    await hermes.open("c1");
    server.dropOnPrompt = "lost";
    await hermes.send("c1", TEXT);

    await hermes.reconnect();
    await hermes.idle();
    const mine = chat().items.filter((i) => i.kind === "user" && i.text === TEXT);
    expect(mine).toEqual([{ kind: "user", id: "h-2", text: TEXT, rowId: 3 }, expect.objectContaining({ outgoing: expect.objectContaining({ state: "failed" }) })]);
  });

  it("Retry after reconnect lands normally: the same words, once, as a new message", async () => {
    const { server, hermes, chat, sent, submits, stored } = await ready();
    server.dropOnPrompt = "lost";
    await hermes().send("c1", TEXT);
    await hermes().reconnect();
    await hermes().idle();
    const failed = sent()!;

    expect(await hermes().retry("c1", failed.id)).toEqual({ delivery: "accepted" });
    expect(submits()).toHaveLength(2);
    expect(submits()[1].params.text).toBe(TEXT);
    expect(chat().items.some(isOutgoing)).toBe(false);
    expect(plain(chat().items)).toHaveLength(1);
    expect(stored()).toHaveLength(1);
    expect(kept()).toEqual([]);
  });

  it("a retry that can't go out leaves a message Hermes may have as it was", async () => {
    const { server, hermes, sent, submits } = await ready();
    server.refuse = "connection refused";
    server.dropOnPrompt = "lost";
    await hermes().send("c1", TEXT);
    const first = sent()!;

    expect(await hermes().retry("c1", first.id)).toMatchObject({ delivery: "unsent" });
    expect(submits()).toHaveLength(1);
    expect(sent()).toEqual(first);
  });

  it("can be dismissed, for good", async () => {
    const { server, hermes, sent, chat } = await ready();
    server.dropOnPrompt = "lost";
    await hermes().send("c1", TEXT);
    hermes().dismiss("c1", sent()!.id);
    expect(chat().items.some(isOutgoing)).toBe(false);
    expect(kept()).toEqual([]);
  });
});

describe("Case 4: the app restarts mid-flight", () => {
  /** Sends `TEXT`, and closes the app while Hermes hasn't answered; `storing`: Hermes got it and stored it. */
  async function closedMidSend(storing: boolean) {
    const ctx = await ready();
    ctx.server.handlers["prompt.submit"] = (r) => {
      if (storing) ctx.server.storeMessage(ctx.server.runtime.get(String(r.params.session_id))!, { role: "user", text: String(r.params.text) });
    };
    void ctx.hermes().send("c1", TEXT);
    await vi.advanceTimersByTimeAsync(0);
    expect(kept()).toMatchObject([{ outgoing: { state: "sending", sent: { prompt: TEXT, after: 2 } } }]);
    ctx.server.handlers["prompt.submit"] = new FakeHermes().handlers["prompt.submit"].bind(ctx.server);
    return ctx;
  }

  it("nothing is still sending after relaunch, and the first refresh shows a message Hermes stored from its history", async () => {
    const { server, chat, relaunch, submits } = await closedMidSend(true);
    await relaunch(false);
    expect(chat().items).toMatchObject([{ text: TEXT, outgoing: { state: "unknown", reason: "The app closed before Hermes confirmed it." } }]);

    server.refuse = undefined;
    const after = await relaunch();
    await after.idle();
    expect(chat().items.some(isOutgoing)).toBe(false);
    expect(kept()).toEqual([]);
    await after.open("c1");
    expect(plain(chat().items)).toHaveLength(1);
    expect(submits()).toHaveLength(1);
  });

  it("the first refresh marks failed a message Hermes never got", async () => {
    const { chat, relaunch, submits } = await closedMidSend(false);
    const after = await relaunch();
    await after.idle();
    expect(chat().items).toMatchObject([{ text: TEXT, outgoing: { state: "failed", reason: expect.stringContaining("never arrived") } }]);
    expect(submits()).toHaveLength(1);
  });

  it("a message the app closed on before it went out comes back failed, with nothing to check", async () => {
    const { server, chat, relaunch } = await ready();
    server.sessions.push(row("c2", 0));
    server.handlers["session.resume"] = () => {};
    const before = await relaunch();
    void before.send("c2", TEXT);
    await vi.advanceTimersByTimeAsync(0);
    server.handlers["session.resume"] = new FakeHermes().handlers["session.resume"].bind(server);

    const after = await relaunch();
    const c2 = after.getSnapshot().chats.find((c) => c.id === "c2")!;
    expect(c2.items).toMatchObject([{ text: TEXT, outgoing: { state: "failed", reason: "The app closed before it went out." } }]);
    expect(chat().items.some(isOutgoing)).toBe(false);
  });
});

describe("A new chat whose first message failed (#468)", () => {
  /** A chat started here, whose first message Hermes refused, so Hermes has no row for it. */
  async function failedFirst() {
    const server = new FakeHermes();
    server.sessions = [row("c1", 0)];
    let hermes = await launch(server);
    const id = await hermes.newChat();
    server.rejectPrompt = { code: 4009, message: "session busy" };
    await hermes.send(id, TEXT);
    server.rejectPrompt = undefined;
    const chat = () => hermes.getSnapshot().chats.find((c) => c.id === id);
    expect(chat()?.items).toMatchObject([{ text: TEXT, outgoing: { state: "failed", reason: "session busy" } }]);
    expect(server.sessions.some((s) => s.id === id)).toBe(false);
    const relaunch = async () => {
      await hermes.close();
      hermes = await launch(server);
      return hermes;
    };
    return { server, hermes: () => hermes, id, chat, relaunch };
  }

  it("stays in the list, with its Failed message, after the connection drops and the list is read again", async () => {
    const { server, hermes, chat } = await failedFirst();
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hermes().getSnapshot().status).toBe("connected");
    await hermes().idle();
    expect(server.restRequests.filter((r) => r.path === "/api/sessions").length).toBeGreaterThan(1);
    expect(chat()?.items).toMatchObject([{ text: TEXT, outgoing: { state: "failed", reason: "session busy" } }]);
  });

  it("stays after a restart, and Retry sends it in that chat", async () => {
    const { server, hermes, id, chat, relaunch } = await failedFirst();
    await relaunch();
    await hermes().idle();
    const failed = chat()?.items.at(-1);
    expect(failed).toMatchObject({ text: TEXT, outgoing: { state: "failed" } });

    expect(await hermes().retry(id, failed!.id)).toEqual({ delivery: "accepted" });
    expect(chat()?.items).toMatchObject([{ kind: "user", text: TEXT }]);
    expect(chat()?.items.some(isOutgoing)).toBe(false);
    expect((server.transcripts[id] ?? []).filter((m) => m.role === "user" && m.text === TEXT)).toHaveLength(1);
  });

  it("goes once the owner dismisses its message, at the next list read", async () => {
    const { server, hermes, id, chat } = await failedFirst();
    server.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    await hermes().idle();
    hermes().dismiss(id, chat()!.items[0].id);
    await hermes().sync();
    expect(chat()).toBeUndefined();
  });
});

describe("The outbox on this computer", () => {
  it("a failed message survives a cache save/reload cycle, attachments and all, and stays out of the Saved copy", async () => {
    const { server, hermes, chat, relaunch } = await ready();
    server.files[ROTATE] = "#!/bin/sh\nlogrotate -f /etc/logrotate.conf";
    const { attachments } = await hermes().checkAttachments([ROTATE]);
    server.rejectPrompt = { code: 4009, message: "session busy" };
    await hermes().send("c1", TEXT, attachments);
    const failed = chat().items.at(-1);

    const after = await relaunch(false);
    await after.open("c1");
    expect(chat().items.at(-1)).toEqual(failed);
    expect(chat().items.at(-1)).toMatchObject({ text: TEXT, attachments: ["rotate.sh"], outgoing: { state: "failed", reason: "session busy", attachments } });
    expect(plain(savedCopy())).toEqual([]);

    // Clear local cache deletes the lists and Saved copies; the owner's unsent words stay, as drafts do.
    after.clearCache();
    expect(kept()).toMatchObject([{ text: TEXT }]);
  });

  it("Retry sends the same words and files again, as a new message", async () => {
    const { server, hermes, chat } = await ready();
    server.files[ROTATE] = "#!/bin/sh\nlogrotate -f /etc/logrotate.conf";
    const { attachments } = await hermes().checkAttachments([ROTATE]);
    server.rejectPrompt = { code: 4009, message: "session busy" };
    await hermes().send("c1", TEXT, attachments);
    const failed = chat().items.at(-1)!;
    server.rejectPrompt = undefined;

    expect(await hermes().retry("c1", failed.id)).toEqual({ delivery: "accepted" });
    expect(server.requests.filter((r) => r.method === "file.attach")).toHaveLength(2);
    expect(server.last("prompt.submit")!.params.text).toBe(`@file:attachments/rotate.sh\n\n${TEXT}`);
    expect(chat().items.filter((i) => i.kind === "user" && i.text === TEXT)).toEqual([{ kind: "user", id: expect.any(String), text: TEXT, attachments: ["rotate.sh"] }]);
  });

  it("brings in the messages the drafts store used to hold beside the composer", async () => {
    const legacy = "hermes-chat.undelivered." + JSON.stringify(["ssh", "liam@hermes", "liam", "default", "c1"]);
    store.set(legacy, JSON.stringify([{ id: "h1", text: TEXT, delivery: "unknown", reason: "closed", at: 1 }]));
    const server = new FakeHermes();
    server.sessions = [row("c1", 0)];
    const hermes = await launch(server);
    await hermes.idle();
    // Its history doesn't have it, so reading back marks it failed.
    expect(hermes.getSnapshot().chats[0].items).toMatchObject([{ text: TEXT, outgoing: { state: "failed" } }]);
    expect(store.has(legacy)).toBe(false);
  });
});
