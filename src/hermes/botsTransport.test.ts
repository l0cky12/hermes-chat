// Bot Mode through the real transport (transport.ts) against FakeHermes as the deployed f0d94882 (ADR 0066): the
// roster, opening a bot's Bot Chat by title, creating it once, keeping it out of the chat list and search, and what a
// Hermes without Bot Mode shows. The resolution rules themselves are in bots.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { BOT_CHAT_TITLE, BotModeUnsupportedError } from "./bots";
import { connect, type Hermes } from "./transport";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

/** Signed in to a server with the default profile and Scribe, whose Bot Chat holds one exchange. */
async function signedIn(server = new FakeHermes(), setup: (server: FakeHermes) => void = () => {}) {
  server.sessions = [row("side", 1, { title: "Disk usage" })];
  server.otherProfiles = { scribe: [row("scribe-bot", 2, { title: BOT_CHAT_TITLE, hidden: true }), row("scribe-side", 3, { title: "Changelog wording" })] };
  server.transcripts = {
    side: [{ role: "user", text: "How full is the release disk?" }],
    "scribe-bot": [
      { role: "user", text: "Draft the release notes for 0.9" },
      { role: "assistant", text: "Release notes drafted: three fixes." },
    ],
    "scribe-side": [{ role: "user", text: "Which release wording reads better?" }],
  };
  server.profileMeta = { scribe: { description: "Writes release notes", ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77" } } } };
  server.botAvatars = { scribe: "data:image/png;base64,iVBORw0KGgo=" };
  setup(server);
  const hermes = await connect(server.openPipe);
  running.push(hermes);
  await hermes.sync();
  return { server, hermes };
}

const rpc = (server: FakeHermes, method: string) => server.requests.filter((r) => r.method === method);
const shownIds = (hermes: Hermes) => hermes.getSnapshot().chats.filter((c) => !c.bot).map((c) => c.id);

describe("the roster", () => {
  it("lists every profile as a bot, with its Bot Chat's preview found by title on the server", async () => {
    const { hermes } = await signedIn();
    const bots = await hermes.bots();
    expect(bots.map((b) => ({ profile: b.profile, name: b.name, description: b.description, chat: b.botChat?.id ?? null, preview: b.botChat?.preview ?? "" }))).toEqual([
      { profile: "default", name: "Hermes", description: "", chat: null, preview: "" },
      { profile: "scribe", name: "Scribe", description: "Writes release notes", chat: "scribe-bot", preview: "Release notes drafted: three fixes." },
    ]);
    expect(await hermes.botAvatar("scribe")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(await hermes.botAvatar("default")).toBeUndefined();
  });

  it("calls Bot Mode unsupported when profiles.list doesn't report Bot Chats, and diagnostics says so", async () => {
    const server = new FakeHermes();
    server.botMode = "no-canonical";
    const { hermes } = await signedIn(server);
    await expect(hermes.bots()).rejects.toBeInstanceOf(BotModeUnsupportedError);
    expect(hermes.capabilities.get("botMode")).toMatchObject({ state: "unsupported", why: expect.stringContaining("doesn't report their Bot Chats") });
  });

  it("calls Bot Mode unsupported on a Hermes without profiles.list", async () => {
    const server = new FakeHermes();
    server.botMode = "none";
    const { hermes } = await signedIn(server);
    await expect(hermes.bots()).rejects.toBeInstanceOf(BotModeUnsupportedError);
    expect(hermes.capabilities.get("botMode").state).toBe("unsupported");
  });
});

describe("the roster kept for the Bots view", () => {
  it("is read with the pictures after connecting, kept across a reconnect, and asks each picture once per connection", async () => {
    const { server, hermes } = await signedIn();
    await hermes.idle();
    expect(hermes.getSnapshot().bots?.roster.map((b) => b.name)).toEqual(["Hermes", "Scribe"]);
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,iVBORw0KGgo=" });
    await hermes.bots();
    await hermes.idle();
    expect(rpc(server, "profiles.get_asset")).toHaveLength(1);

    server.drop();
    expect(hermes.getSnapshot().bots?.roster).toHaveLength(2);
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,iVBORw0KGgo=" });
    await hermes.reconnect();
    await vi.waitFor(() => expect(rpc(server, "profiles.get_asset")).toHaveLength(2));
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,iVBORw0KGgo=" });
  });

  it("drops a picture removed on the server, and shows one put back on the same connection", async () => {
    const { server, hermes } = await signedIn();
    await hermes.idle();
    delete server.botAvatars.scribe;
    await hermes.bots();
    await hermes.idle();
    expect(hermes.getSnapshot().botPictures).toEqual({});
    server.botAvatars.scribe = "data:image/png;base64,iVBORw0KGgoAAAA=";
    await hermes.bots();
    await hermes.idle();
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,iVBORw0KGgoAAAA=" });
  });

  it("keeps the newer picture when an older ask for it answers late", async () => {
    const { server, hermes } = await signedIn();
    await hermes.idle();
    const asset = server.handlers["profiles.get_asset"];
    // Each held ask answers with the picture the server had when it was asked.
    const held: (() => void)[] = [];
    server.handlers["profiles.get_asset"] = (r) => {
      const then = { ...server.botAvatars };
      held.push(() => {
        const now = server.botAvatars;
        server.botAvatars = then;
        asset(r);
        server.botAvatars = now;
      });
    };
    delete server.botAvatars.scribe;
    await hermes.bots();
    server.botAvatars.scribe = "data:image/png;base64,QUFBQQ==";
    await hermes.bots();
    delete server.botAvatars.scribe;
    await hermes.bots();
    server.botAvatars.scribe = "data:image/png;base64,QkJCQg==";
    await hermes.bots();
    expect(held).toHaveLength(2);
    held[1]();
    held[0]();
    server.handlers["profiles.get_asset"] = asset;
    await hermes.idle();
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,QkJCQg==" });
  });

  it("asks again for the picture of a bot that left the roster and came back", async () => {
    const { server, hermes } = await signedIn();
    await hermes.idle();
    const scribe = server.otherProfiles.scribe;
    delete server.otherProfiles.scribe;
    await hermes.bots();
    expect(hermes.getSnapshot().botPictures).toEqual({});
    server.otherProfiles.scribe = scribe;
    server.botAvatars.scribe = "data:image/png;base64,QkJCQg==";
    await hermes.bots();
    await hermes.idle();
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,QkJCQg==" });
  });

  it("keeps the newer roster when an older read answers late", async () => {
    const { server, hermes } = await signedIn();
    await hermes.idle();
    const list = server.handlers["profiles.list"];
    const held: (() => void)[] = [];
    server.handlers["profiles.list"] = (r) => void held.push(() => list(r));
    const older = hermes.bots();
    const newer = hermes.bots();
    server.profileMeta.scribe = { ...server.profileMeta.scribe, ui_meta: { "hermes-bots": { title: "Quill" } } };
    held[1]();
    await newer;
    server.profileMeta.scribe = { ...server.profileMeta.scribe, ui_meta: { "hermes-bots": { title: "Scribe" } } };
    held[0]();
    await older;
    server.handlers["profiles.list"] = list;
    expect(hermes.getSnapshot().bots?.roster.map((b) => b.name)).toEqual(["Hermes", "Quill"]);
  });

  it("keeps the roster and pictures shown across a profile switch", async () => {
    const { hermes } = await signedIn();
    await hermes.idle();
    await hermes.switchProfile("scribe");
    expect(hermes.getSnapshot().bots?.roster.map((b) => b.name)).toEqual(["Hermes", "Scribe"]);
    expect(hermes.getSnapshot().botPictures).toEqual({ scribe: "data:image/png;base64,iVBORw0KGgo=" });
  });

  it("finds a Hermes without Bot Mode on connecting, from one profiles.list, and doesn't ask again on a reconnect", async () => {
    const { server, hermes } = await signedIn(undefined, (s) => (s.botMode = "none"));
    await hermes.idle();
    expect(hermes.capabilities.get("botMode").state).toBe("unsupported");
    expect(hermes.getSnapshot().bots).toBeUndefined();
    server.drop();
    await hermes.reconnect();
    await hermes.sync();
    await hermes.idle();
    expect(rpc(server, "profiles.list")).toHaveLength(1);
  });
});

describe("opening a bot's Bot Chat", () => {
  it("opens the one the title lookup finds, out of the chat list, and creates nothing", async () => {
    const { server, hermes } = await signedIn();
    await hermes.switchProfile("scribe");
    await hermes.sync();
    expect(shownIds(hermes)).toEqual(["scribe-side"]);
    const scribe = (await hermes.bots()).find((b) => b.profile === "scribe")!;

    const id = await hermes.openBotChat(scribe);
    expect(id).toBe("scribe-bot");
    expect(rpc(server, "session.list").map((r) => r.params)).toEqual([{ profile: "scribe", title: BOT_CHAT_TITLE, include_hidden: true, limit: 200 }]);
    expect(rpc(server, "session.create")).toEqual([]);
    await hermes.open(id);
    const chat = hermes.getSnapshot().chats.find((c) => c.id === id)!;
    expect(chat).toMatchObject({ title: BOT_CHAT_TITLE, bot: true });
    expect(chat.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    // It stays out of the list through a refresh.
    await hermes.sync();
    expect(shownIds(hermes)).toEqual(["scribe-side"]);
    expect(hermes.getSnapshot().chats.find((c) => c.id === id)?.bot).toBe(true);
  });

  it("creates a hidden Bot Chat once for a bot without one, and the next open finds it by title", async () => {
    const { server, hermes } = await signedIn();
    const me = (await hermes.bots()).find((b) => b.profile === "default")!;
    const [a, b] = await Promise.all([hermes.openBotChat(me), hermes.openBotChat(me)]);
    expect(a).toBe(b);
    expect(rpc(server, "session.create").map((r) => r.params)).toEqual([{ profile: "default", title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true, source: "gui" }]);
    expect(rpc(server, "session.title").map((r) => r.params)).toEqual([{ session_id: "rt-1", title: BOT_CHAT_TITLE }]);
    expect(server.sessions.find((s) => s.id === a)).toMatchObject({ title: BOT_CHAT_TITLE, hidden: true });
    expect(rpc(server, "prompt.submit")).toEqual([]);
    await hermes.sync();
    expect(shownIds(hermes)).toEqual(["side"]);

    // The roster now names it, and opening again looks it up rather than remembering it.
    const again = (await hermes.bots()).find((x) => x.profile === "default")!;
    expect(again.botChat?.id).toBe(a);
    expect(await hermes.openBotChat(again)).toBe(a);
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(rpc(server, "session.list")).toHaveLength(2);

    // Its first message doesn't rename it here, as a new chat's does: its title is what Hermes finds it by.
    await hermes.open(a);
    await hermes.send(a, "Watch the release disk tonight");
    expect(hermes.getSnapshot().chats.find((c) => c.id === a)?.title).toBe(BOT_CHAT_TITLE);
  });

  it("opens the chat another client made between the lookup and the title, instead of a second one", async () => {
    const { server, hermes } = await signedIn();
    const me = (await hermes.bots()).find((b) => b.profile === "default")!;
    // The first lookup finds none, and another client's Bot Chat lands just after it answers, as in a race.
    const lookup = server.handlers["session.list"];
    let first = true;
    server.handlers["session.list"] = (r) => {
      if (!first) return lookup(r);
      first = false;
      server.respond(r.id, { sessions: [] });
      server.sessions.push(row("theirs", 0, { title: BOT_CHAT_TITLE, hidden: true }));
    };
    expect(await hermes.openBotChat(me)).toBe("theirs");
    expect(rpc(server, "session.create")).toHaveLength(1);
    expect(server.sessions.filter((s) => s.title === BOT_CHAT_TITLE).map((s) => s.id)).toEqual(["theirs"]);
  });

  it("starts nothing when the lookup fails", async () => {
    const { server, hermes } = await signedIn();
    const me = (await hermes.bots()).find((b) => b.profile === "default")!;
    server.titleLookupError = { code: 5000, message: "database is locked" };
    await expect(hermes.openBotChat(me)).rejects.toThrow("Couldn't look up Hermes's Bot Chat, so no new one was started: database is locked");
    expect(rpc(server, "session.create")).toEqual([]);
  });
});

describe("keeping Bot Chats out of the list and search", () => {
  it("leaves them out of search, which Hermes doesn't filter", async () => {
    const { hermes } = await signedIn();
    await hermes.switchProfile("scribe");
    await hermes.sync();
    await hermes.bots();
    const found = await hermes.search("release");
    expect(found.map((f) => f.chatId)).toEqual(["scribe-side"]);
  });

  it("leaves out a compressed Bot Chat, by its lineage, before the Bots view has ever opened", async () => {
    const { hermes } = await signedIn(new FakeHermes(), (server) => {
      // A compressed Bot Chat whose newest segment is titled otherwise (Hermes carries the title over; this one didn't).
      server.sessions.push(
        row("bot-root", 2, { title: BOT_CHAT_TITLE, hidden: true, listedAs: { id: "bot-tip", title: "Draft notes" } }),
        row("bot-tip", 1, { unlisted: true, hidden: true }),
      );
      server.transcripts["bot-root"] = [{ role: "user", text: "release checklist for the bot" }];
      server.transcripts["bot-tip"] = [{ role: "assistant", text: "Tip: the release is ready." }];
    });
    // Search reports the hit at the tip, under the tip's title; only the roster's ids say it's the Bot Chat.
    const found = await hermes.search("release");
    expect(found.map((f) => f.chatId)).toEqual(["side"]);
    // The roster reports the tip, and previews its newest message.
    const me = (await hermes.bots()).find((b) => b.profile === "default")!;
    expect(me.botChat).toMatchObject({ id: "bot-root", resolvedId: "bot-tip", preview: "Tip: the release is ready." });
    expect(await hermes.openBotChat(me)).toBe("bot-tip");
  });

  it("refuses to rename a chat to the Bot Chat's title, which would make it a bot's one chat", async () => {
    const { server, hermes } = await signedIn();
    await expect(hermes.rename("side", " Bot Chat ", "Disk usage")).rejects.toThrow("“Bot Chat” is the name Hermes gives each bot's one chat. Pick another name.");
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
    // Nor is a Bot Chat renamed, or its title made again.
    const me = (await hermes.bots()).find((b) => b.profile === "default")!;
    const id = await hermes.openBotChat(me);
    await expect(hermes.rename(id, "Ops notes", BOT_CHAT_TITLE)).rejects.toThrow("A Bot Chat's name is how Hermes finds it, so it can't be renamed.");
    await expect(hermes.regenerateTitle(id)).rejects.toThrow("can't be renamed");
    expect(server.restRequests.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  it("marks an open chat renamed to the title in another client as a Bot Chat, and keeps it out of the list", async () => {
    const { server, hermes } = await signedIn();
    await hermes.open("side");
    expect(hermes.getSnapshot().chats.find((c) => c.id === "side")?.runtimeId).toBeTruthy();
    server.sessions.find((s) => s.id === "side")!.title = BOT_CHAT_TITLE;
    await hermes.sync();
    expect(hermes.getSnapshot().chats.find((c) => c.id === "side")).toMatchObject({ bot: true, title: BOT_CHAT_TITLE });
    expect(shownIds(hermes)).toEqual([]);
  });

  it("leaves out one born visible elsewhere, by its title", async () => {
    const server = new FakeHermes();
    const { hermes } = await signedIn(server);
    server.sessions.push(row("visible-bot", 0, { title: BOT_CHAT_TITLE }));
    await hermes.sync();
    expect(shownIds(hermes)).toEqual(["side"]);
  });

  it("leaves them out of the archived view, which lists hidden rows", async () => {
    const server = new FakeHermes();
    const { hermes } = await signedIn(server);
    server.sessions.push(row("old-bot", 5, { title: BOT_CHAT_TITLE, hidden: true, archived: true }), row("old-side", 5, { title: "Old", archived: true }));
    const { found } = await hermes.browse({ archived: "only" });
    expect(found.map((f) => f.chatId)).toEqual(["old-side"]);
  });
});
