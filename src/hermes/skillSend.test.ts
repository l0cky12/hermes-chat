// A message that runs a skill, sent through the real transport against FakeHermes: Hermes builds the skill's text for
// the chat's session, the chat shows the invocation instead, a send whose fate is unknown is settled from the history
// like any other (ADR 0006), and a retry runs the skill again. The skill's text is never kept on this computer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSignIn } from "./account";
import { localChatCache } from "./chatCache";
import { FakeHermes, row } from "./fakeHermes";
import { isOutgoing } from "./model";
import { type Hermes, connect } from "./transport";

const nas: SavedSignIn = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" };
const SKILLS = "/home/liam/.hermes/skills";
const BODY = "Reproduce the failure first.\nThen bisect.";
const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const CALL = { name: "debugging", arg: "/writing fix the build\n  using $debugging" };
const SHOWN = "/debugging /writing fix the build using $debugging";

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
});
afterEach(() => vi.unstubAllGlobals());

const launch = async (server: FakeHermes) => {
  const hermes = await connect(server.openPipe, undefined, localChatCache(nas));
  await hermes.sync();
  return hermes;
};

async function ready() {
  const server = new FakeHermes();
  server.sessions = [row("c1", 0)];
  server.transcripts.c1 = [{ role: "user", text: "How full is the NAS?", row_id: 1 }];
  server.skills.add("default", { dir: `${SKILLS}/debugging`, source: "agent" }, skill("debugging", "Find the cause first.", BODY));
  server.skills.add("default", { dir: `${SKILLS}/writing`, source: "bundled" }, skill("writing", "Write plainly.", "Short sentences."));
  let hermes = await launch(server);
  await hermes.open("c1");
  const chat = () => hermes.getSnapshot().chats.find((c) => c.id === "c1")!;
  return {
    server,
    hermes: () => hermes,
    chat,
    relaunch: async () => {
      await hermes.close();
      hermes = await launch(server);
      return hermes;
    },
    dispatches: () => server.requests.filter((r) => r.method === "command.dispatch").map((r) => r.params),
    submits: () => server.requests.filter((r) => r.method === "prompt.submit").map((r) => String(r.params.text)),
    kept: () => JSON.stringify(localChatCache(nas).loadOutbox("default").c1 ?? []),
  };
}

describe("A message that runs skills", () => {
  it("goes as the text Hermes builds for the chat's session, and shows as its invocation", async () => {
    const { hermes, chat, dispatches, submits } = await ready();
    expect(await hermes().send("c1", "fix the build using $debugging", [], CALL)).toEqual({ delivery: "accepted" });
    expect(dispatches()).toEqual([{ ...CALL, session_id: chat().runtimeId }]);
    expect(submits()).toHaveLength(1);
    expect(submits()[0]).toMatch(/^\[IMPORTANT: The user has invoked the "\/debugging \/writing" stacked skill bundle/);
    expect(submits()[0]).toContain(BODY);
    const shown = chat().items.filter((i) => i.kind === "user").map((i) => i.text);
    expect(shown).toEqual(["How full is the NAS?", SHOWN]);
  });

  it("is settled from the history when the connection drops after Hermes stored it, and isn't sent again", async () => {
    const { server, hermes, chat, submits } = await ready();
    server.dropOnPrompt = "stored";
    expect(await hermes().send("c1", "x", [], CALL)).toMatchObject({ delivery: "unknown" });
    await hermes().reconnect();
    await hermes().idle();
    expect(chat().items.some(isOutgoing)).toBe(false);
    expect(chat().items.filter((i) => i.kind === "user").map((i) => i.text)).toEqual(["How full is the NAS?", SHOWN]);
    expect(submits()).toHaveLength(1);
  });

  it("is settled by the stored rows too, in a chat not open since a restart", async () => {
    const { server, hermes, chat, relaunch, kept } = await ready();
    server.dropOnPrompt = "stored";
    await hermes().send("c1", "x", [], CALL);
    // What's kept is the call and what the chat shows, never the skill's own text.
    expect(kept()).toContain(SHOWN);
    expect(kept()).not.toContain("Reproduce the failure");
    const after = await relaunch();
    await after.idle();
    expect(chat().items.some(isOutgoing)).toBe(false);
    expect(kept()).toBe("[]");
  });

  it("is marked failed when it never arrived, and Retry runs the skill again", async () => {
    const { server, hermes, chat, dispatches, submits } = await ready();
    server.dropOnPrompt = "lost";
    await hermes().send("c1", "x", [], CALL);
    await hermes().reconnect();
    await hermes().idle();
    const failed = chat().items.find(isOutgoing)!;
    expect(failed).toMatchObject({ text: SHOWN, outgoing: { state: "failed", skill: CALL } });
    expect(await hermes().retry("c1", failed.id)).toEqual({ delivery: "accepted" });
    expect(dispatches()).toHaveLength(2);
    expect(submits()).toHaveLength(2);
    expect(submits()[1]).toContain(BODY);
  });

  it("sends nothing when Hermes has no such skill now, and says why", async () => {
    const { server, hermes, chat, submits } = await ready();
    server.skills.disabled.default = new Set(["debugging"]);
    expect(await hermes().send("c1", "x", [], CALL)).toMatchObject({ delivery: "unsent", reason: expect.stringMatching(/no debugging skill.*turned off or removed/) });
    expect(chat().items.find(isOutgoing)).toMatchObject({ text: SHOWN, outgoing: { state: "failed" } });
    expect(submits()).toEqual([]);
  });
});

describe("The skills the composer offers", () => {
  it("are the catalog's that are on for the profile and this app's chats, read again after a change in Settings → Skills", async () => {
    const { server, hermes } = await ready();
    server.skills.add("default", { dir: `${SKILLS}/notes`, source: "agent" }, skill("notes", "Take notes.", "Write it down."));
    server.skills.platformDisabled.default = { tui: ["notes"] };
    expect((await hermes().skillCommands())?.offered.map((s) => s.key)).toEqual(["debugging", "writing"]);
    await hermes().skills.setEnabled("default", "writing", false);
    expect((await hermes().skillCommands())?.offered.map((s) => s.key)).toEqual(["debugging"]);
  });

  it("come from the one catalog read the server commands take, which a change in Settings → Skills reads again", async () => {
    const { server, hermes } = await ready();
    const catalogs = () => server.requests.filter((r) => r.method === "commands.catalog").length;
    const [list, skills] = await Promise.all([hermes().serverCommands(), hermes().skillCommands()]);
    expect(list.listed.size).toBeGreaterThan(0);
    expect(skills?.offered.map((s) => s.key)).toEqual(["debugging", "writing"]);
    expect(catalogs()).toBe(1);
    await hermes().skills.setEnabled("default", "writing", false);
    await hermes().skillCommands();
    await hermes().serverCommands();
    expect(catalogs()).toBe(2);
  });

  it("are none when Hermes's catalog lists no skills", async () => {
    const { server, hermes } = await ready();
    server.catalogSkills = false;
    await hermes().reconnect();
    expect(await hermes().skillCommands()).toBeUndefined();
  });
});
