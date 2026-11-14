// Edit and Regenerate (issue #63, ADR 0035): each makes a branch through the owner's message, takes the branch's copy
// back with `session.undo` on the branch only, and sends the message again there. The chat they're asked from never
// changes. Run against the fake Hermes, whose `session.branch` and `session.undo` follow the live probe of 2026-11-03.
import { describe, expect, it } from "vitest";
import type { BranchLink } from "./branch";
import { referenceBlock } from "./chatReferences";
import { FakeHermes, row } from "./fakeHermes";
import { withContext } from "./projectContext";
import { memoryCache } from "./memoryCache";
import type { Item } from "./model";
import { cannotResend, replayTarget, splitRefs, turnAt, turnsOf, variantRoot, variantsIn, withRefs } from "./replay";
import { connect } from "./transport";

/** Chat "c1" as Hermes stores it: a hidden project instruction, a tool call, a message sent with files, and a last turn. */
async function chatWithHistory(more?: (s: FakeHermes) => void) {
  const server = new FakeHermes();
  server.sessions = [row("c1", 0.1, { title: "Disk check", pinned: true })];
  server.serverDirs.add("/srv/uploads");
  server.serverFiles["/srv/uploads/report.pdf"] = "%PDF";
  server.storeMessage("c1", { role: "user", text: 'Instructions for this chat from the project "Ops".', display_kind: "hidden" });
  server.storeMessage("c1", { role: "user", text: "How full is the NAS?" });
  server.storeMessage("c1", { role: "assistant", text: "Let me look.", tool_calls: [{ id: "call_1", type: "function", function: { name: "terminal", arguments: "{}" } }] });
  server.storeMessage("c1", { role: "tool", name: "terminal", tool_call_id: "call_1", context: "df -h", result: "81%" });
  server.storeMessage("c1", { role: "assistant", text: "It's 81% full." });
  server.storeMessage("c1", { role: "user", text: "@file:/srv/uploads/report.pdf\n\nCompare with this" });
  server.storeMessage("c1", { role: "assistant", text: "The report says 79% last week." });
  server.storeMessage("c1", { role: "user", text: "Clean up old snapshots" });
  server.storeMessage("c1", { role: "assistant", text: "Deleted 3 snapshots." });
  // The chat runs on another model than the profile's, which Hermes starts a branch on.
  server.sessionModel.set("c1", { model: "gpt-5.2", provider: "openai", reasoning_effort: "high", fast: false });
  more?.(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  await hermes.sync();
  await hermes.open("c1");
  const chat = (id = "c1") => hermes.getSnapshot().chats.find((c) => c.id === id)!;
  const itemWith = (text: string, id = "c1") => chat(id).items.find((i) => (i.kind === "user" || i.kind === "assistant") && i.text.includes(text))!.id;
  const submits = () => server.requests.filter((r) => r.method === "prompt.submit");
  return { server, hermes, chat, itemWith, submits };
}

const texts = (items: Item[]) => items.flatMap((i) => (i.kind === "user" || i.kind === "assistant" ? [`${i.kind}: ${i.text}`] : []));

describe("Edit and Regenerate: what they work out", () => {
  const items: Item[] = [
    { kind: "user", id: "u1", text: "one" },
    { kind: "assistant", id: "a1", text: "Looking." },
    { kind: "assistant", id: "a2", text: "Answer one." },
    { kind: "user", id: "u2", text: "two" },
    { kind: "assistant", id: "a3", text: "Answer two." },
    { kind: "user", id: "u3", text: "three", outgoing: { state: "failed" } },
  ];

  it("edits the owner's message, and regenerates a reply by the message it answers", () => {
    expect(replayTarget(items, "u2", "edit")).toEqual({ userId: "u2" });
    expect(replayTarget(items, "a2", "regenerate")).toEqual({ userId: "u1", replyId: "a2" });
    expect(replayTarget(items, "a3", "regenerate")).toEqual({ userId: "u2", replyId: "a3" });
    // A failed send keeps its own Edit, which puts its words back in the composer.
    expect(replayTarget(items, "u3", "edit")).toHaveProperty("error");
    expect(replayTarget([{ kind: "assistant", id: "a", text: "Hello" }], "a", "regenerate")).toHaveProperty("error");
  });

  it("numbers turns by the owner's shown messages, the same in a chat and its spine", () => {
    expect([...turnsOf(items)]).toEqual([
      ["u1", 0],
      ["u2", 1],
    ]);
    const spine = [
      { role: "user", hidden: true },
      { role: "user", hidden: false },
      { role: "assistant", hidden: false },
      { role: "user", hidden: false },
    ];
    expect(turnAt(spine, 1)).toBe(0);
    expect(turnAt(spine, 3)).toBe(1);
  });

  it("keeps the files an edited message was sent with, and refuses to send an image again", () => {
    const stored = "@file:/srv/a.csv @file:`/srv/b c.txt`\n\nCompare these";
    expect(splitRefs(stored)).toEqual({ refs: "@file:/srv/a.csv @file:`/srv/b c.txt`", words: "Compare these" });
    expect(withRefs("@file:/srv/a.csv", " Compare only this ")).toBe("@file:/srv/a.csv\n\nCompare only this");
    expect(splitRefs("No files here")).toEqual({ refs: "", words: "No files here" });
    expect(cannotResend("[image] What is this?", "regenerate")).toMatch(/sent with an image.*can't be regenerated/);
    expect(cannotResend("Plain words", "edit")).toBeUndefined();
  });

  it("groups each turn's versions under the chat they're versions of", () => {
    const link = (variant: BranchLink["variant"], at: number): BranchLink => ({ parentId: "x", parentTitle: "X", point: { role: "user", excerpt: "" }, at, variant });
    const links: Record<string, BranchLink> = {
      b1: link({ kind: "regenerate", rootId: "c1", turn: 1 }, 10),
      b2: link({ kind: "edit", rootId: "c1", turn: 1 }, 20),
      // A version of turn 3 of b1: its turn 1 is b1's.
      b3: link({ kind: "edit", rootId: "b1", turn: 3 }, 30),
      plain: { parentId: "c1", parentTitle: "X", point: { role: "user", excerpt: "" }, at: 5 },
    };
    expect(variantRoot(links, "b3", 1)).toBe("c1");
    expect(variantRoot(links, "b3", 3)).toBe("b1");
    expect(variantRoot(links, "b1", 2)).toBe("b1");
    expect(variantRoot(links, "plain", 1)).toBe("plain");
    const all = () => true;
    expect(variantsIn(links, "c1", all).get(1)?.map((v) => [v.chatId, v.kind])).toEqual([
      ["c1", "original"],
      ["b1", "regenerate"],
      ["b2", "edit"],
    ]);
    expect([...variantsIn(links, "b2", all).keys()]).toEqual([1]);
    expect(variantsIn(links, "b1", all).get(3)?.map((v) => v.chatId)).toEqual(["b1", "b3"]);
    // A deleted version is left out; a turn with one version left shows none.
    expect(variantsIn(links, "b1", (id) => id !== "b3").has(3)).toBe(false);
  });
});

describe("the fake Hermes's session.undo", () => {
  it("takes back the last turn of the owner's, a /steer row included, but not a marker or hidden row on its own", () => {
    const server = new FakeHermes();
    server.runtime.set("rt", "s1");
    server.transcripts.s1 = [
      { role: "user", text: "Original prompt" },
      { role: "assistant", text: "Original answer" },
      { role: "user", text: "Use shorter answers", display_kind: "steer" },
      { role: "user", text: "[System: The active model for this chat has changed to x.]", display_kind: "model_switch" },
    ];
    server.handlers["session.undo"]({ jsonrpc: "2.0", id: 1, method: "session.undo", params: { session_id: "rt" } });
    expect(server.transcripts.s1.map((m) => m.text)).toEqual(["Original prompt", "Original answer"]);
    server.transcripts.s1.push({ role: "user", text: "[System: The active model for this chat has changed to y.]", display_kind: "model_switch" });
    server.handlers["session.undo"]({ jsonrpc: "2.0", id: 2, method: "session.undo", params: { session_id: "rt" } });
    expect(server.transcripts.s1.map((m) => m.text)).toEqual([]);
  });
});

describe("Edit", () => {
  it("edits an early turn into a branch, and the original chat with its later messages stays as it was", async () => {
    const { server, hermes, chat, itemWith, submits } = await chatWithHistory();
    const before = JSON.stringify(server.transcripts.c1);
    const p = await hermes.previewReplay("c1", itemWith("How full"), "edit");
    expect(p).toMatchObject({ kind: "edit", words: "How full is the NAS?", refs: "", turn: 0, rootId: "c1", laterTools: 1 });
    // The hidden row and the message itself: the branch goes through the message, then takes it back.
    expect(p.branch.count).toBe(2);
    expect(p.later.map((m) => m.excerpt)).toEqual([
      "How full is the NAS?",
      "Let me look.",
      "It's 81% full.",
      "[1 file] Compare with this",
      "The report says 79% last week.",
      "Clean up old snapshots",
      "Deleted 3 snapshots.",
    ]);

    const { chatId, warnings } = await hermes.replay(p, "How full is the second NAS?");
    expect(warnings).toEqual([]);
    expect(JSON.stringify(server.transcripts.c1)).toBe(before);
    expect(server.undoCalls).toEqual([chatId]);
    const sent = submits().at(-1)!;
    expect(sent.params).toMatchObject({ session_id: chat(chatId).runtimeId, text: "How full is the second NAS?" });
    // The branch holds the hidden instruction, then the edited message: the original is in c1 only.
    expect(server.transcripts[chatId].map((m) => [m.role, m.text, m.display_kind])).toEqual([
      ["user", 'Instructions for this chat from the project "Ops".', "hidden"],
      ["user", "How full is the second NAS?", undefined],
    ]);
    expect(texts(chat(chatId).items)).toEqual(["user: How full is the second NAS?"]);
    expect(texts(chat("c1").items)).toHaveLength(7);
    expect(server.sessions.find((s) => s.id === chatId)?.parent_session_id).toBe("c1");
    const link = hermes.getSnapshot().branches.links[chatId];
    expect(link).toMatchObject({ parentId: "c1", point: { role: "user", excerpt: "How full is the NAS?" }, variant: { kind: "edit", rootId: "c1", turn: 0 } });
    expect(link.variant?.pending).toBeUndefined();
    expect(chat("c1").model).toMatchObject({ model: "gpt-5.2", provider: "openai", effort: "high" });
    expect(link.variant?.model).toEqual(chat("c1").model);
    expect(chat(chatId).model).toEqual(chat("c1").model);
  });

  it("edits past model-switch markers: one the chat had, and the one Hermes stores as the branch switches model", async () => {
    const { server, hermes, chat, itemWith, submits } = await chatWithHistory((s) => {
      // An earlier model switch in c1, between its first and second turns: a user row no client shows.
      const at = s.transcripts.c1.findIndex((m) => m.text === "It's 81% full.");
      s.transcripts.c1.splice(at + 1, 0, { role: "user", text: "[System: The active model for this chat has changed to gpt-5.2.]", display_kind: "model_switch", row_id: 900 });
      // And a later one, after the last turn's message: not a message the branch leaves out either.
      const last = s.transcripts.c1.findIndex((m) => m.text === "Clean up old snapshots");
      s.transcripts.c1.splice(last + 1, 0, { role: "user", text: "[System: The active model for this chat has changed to gpt-5.3.]", display_kind: "model_switch", row_id: 901 });
    });
    const early = await hermes.previewReplay("c1", itemWith("How full"), "edit");
    expect(early.turn).toBe(0);
    expect(early.later.map((m) => m.excerpt)).toEqual([
      "How full is the NAS?",
      "Let me look.",
      "It's 81% full.",
      "[1 file] Compare with this",
      "The report says 79% last week.",
      "Clean up old snapshots",
      "Deleted 3 snapshots.",
    ]);
    const p = await hermes.previewReplay("c1", itemWith("Clean up"), "edit");
    // The marker isn't a turn, and isn't listed as left out.
    expect(p.turn).toBe(2);
    expect(p.later.map((m) => m.excerpt)).toEqual(["Clean up old snapshots", "Deleted 3 snapshots."]);
    const { chatId, warnings } = await hermes.replay(p, "Clean up snapshots older than 90 days");
    expect(warnings).toEqual([]);
    expect(submits().at(-1)!.params).toMatchObject({ session_id: chat(chatId).runtimeId, text: "Clean up snapshots older than 90 days" });
    expect(hermes.getSnapshot().branches.links[chatId].variant?.pending).toBeUndefined();
    // Taken back with the copy: the marker the switch stored after it. The copied one was deactivated by the switch.
    const rows = server.transcripts[chatId];
    expect(rows.some((m) => m.display_kind === "model_switch")).toBe(false);
    expect(rows.filter((m) => m.role === "user" && !m.display_kind).map((m) => m.text)).toEqual([
      "How full is the NAS?",
      "@file:/srv/uploads/report.pdf\n\nCompare with this",
      "Clean up snapshots older than 90 days",
    ]);
    expect(texts(chat(chatId).items).at(-1)).toBe("user: Clean up snapshots older than 90 days");
  });

  it("edits a chat's very first message, which Hermes can't branch before, by taking the branch's copy back", async () => {
    const { server, hermes, itemWith, submits } = await chatWithHistory((s) => {
      s.sessions.push(row("c2", 0.2, { title: "Trip" }));
      s.storeMessage("c2", { role: "user", text: "Three days in Lisbon?" });
      s.storeMessage("c2", { role: "assistant", text: "Alfama, Belém, Sintra." });
    });
    await hermes.open("c2");
    const p = await hermes.previewReplay("c2", itemWith("Lisbon", "c2"), "edit");
    expect(p.branch.count).toBe(1);
    const { chatId } = await hermes.replay(p, "Four days in Porto?");
    expect(server.transcripts[chatId].map((m) => m.text)).toEqual(["Four days in Porto?"]);
    expect(submits().at(-1)!.params.text).toBe("Four days in Porto?");
    expect(server.transcripts.c2.map((m) => m.text)).toEqual(["Three days in Lisbon?", "Alfama, Belém, Sintra."]);
  });

  it("keeps the files a message was sent with when its words are edited", async () => {
    const { server, hermes, itemWith, submits } = await chatWithHistory();
    const p = await hermes.previewReplay("c1", itemWith("Compare with this"), "edit");
    expect(p).toMatchObject({ refs: "@file:/srv/uploads/report.pdf", words: "Compare with this", turn: 1 });
    expect(p.branch.files).toEqual([{ path: "/srv/uploads/report.pdf", state: "there" }]);
    const { chatId } = await hermes.replay(p, "Compare with this, by week");
    expect(submits().at(-1)!.params.text).toBe("@file:/srv/uploads/report.pdf\n\nCompare with this, by week");
    expect(server.transcripts[chatId].filter((m) => m.role === "user").map((m) => m.text)).toEqual([
      'Instructions for this chat from the project "Ops".',
      "How full is the NAS?",
      "@file:/srv/uploads/report.pdf\n\nCompare with this, by week",
    ]);
  });

  it("refuses an empty edit and sends nothing", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    const p = await hermes.previewReplay("c1", itemWith("Clean up"), "edit");
    await expect(hermes.replay(p, "   ")).rejects.toThrow("empty");
    expect(server.requests.some((r) => r.method === "session.branch")).toBe(false);
  });
});

describe("Regenerate", () => {
  it("regenerates twice: each answer is its own version, with the same source message and the chat's model", async () => {
    const { server, hermes, chat, itemWith, submits } = await chatWithHistory();
    const before = JSON.stringify(server.transcripts.c1);
    const made: string[] = [];
    for (let i = 0; i < 2; i++) {
      const p = await hermes.previewReplay("c1", itemWith("79% last week"), "regenerate");
      expect(p).toMatchObject({ kind: "regenerate", turn: 1, rootId: "c1", answer: "The report says 79% last week." });
      made.push((await hermes.replay(p)).chatId);
      // The message as Hermes stored it, its file ref included, goes again.
      expect(submits().at(-1)!.params).toMatchObject({ session_id: chat(made[i]).runtimeId, text: "@file:/srv/uploads/report.pdf\n\nCompare with this" });
    }
    expect(new Set(made).size).toBe(2);
    expect(JSON.stringify(server.transcripts.c1)).toBe(before);
    for (const id of made) {
      // What came before the message is copied; the message goes again; the old answer and later turns aren't there.
      expect(server.transcripts[id].map((m) => m.text)).toEqual([
        'Instructions for this chat from the project "Ops".',
        "How full is the NAS?",
        "Let me look.",
        "It's 81% full.",
        "@file:/srv/uploads/report.pdf\n\nCompare with this",
      ]);
    }
    const { links } = hermes.getSnapshot().branches;
    const versions = variantsIn(links, "c1", () => true).get(1)!;
    expect(versions.map((v) => [v.chatId, v.kind])).toEqual([
      ["c1", "original"],
      [made[0], "regenerate"],
      [made[1], "regenerate"],
    ]);
    for (const v of versions.slice(1)) expect(v.model).toEqual(chat("c1").model);
    // Each version sees the same versions of the turn.
    expect(variantsIn(links, made[1], () => true).get(1)!.map((v) => v.chatId)).toEqual(["c1", ...made]);
  });

  it("sends the message as typed, without the context footer Hermes stored below it", async () => {
    // As the live server stored a message with an `@file:` ref outside its workspace (2026-11-03).
    const stored =
      "@file:/srv/uploads/report.pdf\n\nCompare again\n\n--- Context Warnings ---\n- @file:/srv/uploads/report.pdf: path is outside the allowed workspace" +
      "\n\n--- Attached Context ---\n\n<file contents>";
    const { hermes, itemWith, submits } = await chatWithHistory((s) => {
      s.storeMessage("c1", { role: "user", text: stored });
      s.storeMessage("c1", { role: "assistant", text: "Same as before." });
    });
    const p = await hermes.previewReplay("c1", itemWith("Same as before."), "regenerate");
    expect(p.branch.files.map((f) => f.path)).toEqual(["/srv/uploads/report.pdf"]);
    expect(p.later[0].excerpt).toBe("[1 file] Compare again");
    const edit = await hermes.previewReplay("c1", itemWith("Compare again"), "edit");
    expect(edit).toMatchObject({ refs: "@file:/srv/uploads/report.pdf", words: "Compare again" });
    await hermes.replay(p);
    expect(submits().at(-1)!.params.text).toBe("@file:/srv/uploads/report.pdf\n\nCompare again");
  });

  it("sends the Referenced chats the message carried again, for Regenerate and Edit", async () => {
    const block = referenceBlock({ title: "Garage shelf", summary: "Four shelves on a 2x4 frame, 180 cm tall." });
    const { hermes, itemWith, submits } = await chatWithHistory((s) => {
      s.storeMessage("c1", { role: "user", text: withContext("What did we decide?", [block]) });
      s.storeMessage("c1", { role: "assistant", text: "Four shelves." });
    });
    await hermes.replay(await hermes.previewReplay("c1", itemWith("Four shelves."), "regenerate"));
    expect(submits().at(-1)!.params.text).toBe(withContext("What did we decide?", [block]));
    const edit = await hermes.previewReplay("c1", itemWith("What did we decide?"), "edit");
    expect(edit.words).toBe("What did we decide?");
    await hermes.replay(edit, "How tall is it?");
    expect(submits().at(-1)!.params.text).toBe(withContext("How tall is it?", [block]));
  });

  it("refuses a message sent with an image, which can't be sent again from the history", async () => {
    const { hermes, itemWith } = await chatWithHistory((s) => {
      s.storeMessage("c1", { role: "user", text: "[image] What is in this picture?" });
      s.storeMessage("c1", { role: "assistant", text: "A cat." });
    });
    await expect(hermes.previewReplay("c1", itemWith("A cat."), "regenerate")).rejects.toThrow(/sent with an image/);
  });
});

describe("Edit and Regenerate: when they can't be made", () => {
  it("is blocked while a reply or its tools run, until Hermes says the turn ended", async () => {
    const { server, hermes, chat, itemWith } = await chatWithHistory();
    const sid = chat().runtimeId!;
    server.event(sid, "message.start", {});
    await hermes.idle();
    await expect(hermes.previewReplay("c1", itemWith("81% full"), "regenerate")).rejects.toThrow("Stop the reply, or wait for it to end");
    await hermes.stop("c1").catch(() => {});
    await hermes.idle();
    if (chat().stopping) await expect(hermes.previewReplay("c1", itemWith("Clean up"), "edit")).rejects.toThrow("Hermes is stopping the reply");
    server.event(sid, "message.complete", { text: "done", status: "interrupted" });
    await hermes.idle();
    await expect(hermes.previewReplay("c1", itemWith("Clean up"), "edit")).resolves.toMatchObject({ kind: "edit" });
  });

  it("makes nothing when another client changed the chat after the preview was read", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    const p = await hermes.previewReplay("c1", itemWith("How full"), "edit");
    server.storeMessage("c1", { role: "user", text: "Sent from the phone" });
    await expect(hermes.replay(p, "Edited")).rejects.toThrow("This chat changed since this opened");
    expect(server.requests.some((r) => r.method === "session.branch")).toBe(false);
  });

  it("makes nothing when another client adds to the chat between the dialog's check and the branch's own last read", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    const p = await hermes.previewReplay("c1", itemWith("How full"), "edit");
    // The first read of c1 after Save is the dialog's check; the phone's message lands just after it.
    let reads = 0;
    server.rest["GET /api/sessions/c1/messages"] = (req) => {
      const out = (server as unknown as { storedMessages: (id: string, q: URLSearchParams) => unknown }).storedMessages("c1", req.query);
      if (++reads === 1) server.storeMessage("c1", { role: "user", text: "Sent from the phone" });
      return out;
    };
    await expect(hermes.replay(p, "Edited")).rejects.toThrow("This chat changed since this opened");
    expect(reads).toBeGreaterThan(1);
    expect(server.requests.some((r) => r.method === "session.branch")).toBe(false);
  });

  it("says a Hermes without session.branch can't do it, and makes nothing", async () => {
    const { server, hermes, itemWith } = await chatWithHistory();
    server.branchMethod = false;
    const p = await hermes.previewReplay("c1", itemWith("Clean up"), "edit");
    await expect(hermes.replay(p, "Edited")).rejects.toThrow("can't branch chats");
    expect(server.sessions.filter((s) => s.parent_session_id === "c1")).toHaveLength(0);
  });

  it("deletes the branch again on a Hermes without session.undo, and sends nothing", async () => {
    const { server, hermes, itemWith, submits } = await chatWithHistory();
    server.undoMethod = false;
    const sent = submits().length;
    const p = await hermes.previewReplay("c1", itemWith("Clean up"), "edit");
    const { chatId, warnings } = await hermes.replay(p, "Edited");
    expect(warnings.join(" ")).toMatch(/can't take a message back.*deleted the branch/);
    expect(server.sessions.some((s) => s.id === chatId)).toBe(false);
    expect(hermes.getSnapshot().branches.links[chatId]).toBeUndefined();
    expect(submits()).toHaveLength(sent);
  });

  it("keeps a branch whose message couldn't go yet, and Send it now finishes it once, without sending twice", async () => {
    const { server, hermes, itemWith, submits } = await chatWithHistory();
    server.undoBusy = true;
    const sent = submits().length;
    const p = await hermes.previewReplay("c1", itemWith("Clean up"), "edit");
    const { chatId, warnings } = await hermes.replay(p, "Clean up snapshots older than 90 days");
    expect(warnings.join(" ")).toMatch(/didn't take back.*session busy.*Nothing was sent/);
    expect(submits()).toHaveLength(sent);
    expect(hermes.getSnapshot().branches.links[chatId].variant?.pending?.text).toBe("Clean up snapshots older than 90 days");

    server.undoBusy = false;
    expect(await hermes.finishReplay(chatId)).toEqual([]);
    expect(submits().at(-1)!.params.text).toBe("Clean up snapshots older than 90 days");
    expect(server.transcripts[chatId].filter((m) => m.role === "user").at(-1)?.text).toBe("Clean up snapshots older than 90 days");
    expect(hermes.getSnapshot().branches.links[chatId].variant?.pending).toBeUndefined();
    // Asked again: nothing is pending, so nothing goes.
    expect(await hermes.finishReplay(chatId)).toEqual([]);
    expect(submits()).toHaveLength(sent + 1);
  });

  /** A branch whose message couldn't go yet: Hermes refused the undo, so it still holds its copy of the original. */
  /** The branch's copy of the owner's message: its last user row that isn't a model-switch marker. */
  const copyIn = (server: FakeHermes, chatId: string) => server.transcripts[chatId].filter((m) => m.role === "user" && !m.display_kind).at(-1)!;

  async function unfinished() {
    const t = await chatWithHistory();
    t.server.undoBusy = true;
    const p = await t.hermes.previewReplay("c1", t.itemWith("Clean up"), "edit");
    const { chatId } = await t.hermes.replay(p, "Clean up snapshots older than 90 days");
    t.server.undoBusy = false;
    return { ...t, chatId, sent: t.submits().length, undone: t.server.undoCalls.length };
  }

  it("finishes once when asked twice at the same time, as two panes can", async () => {
    const { server, hermes, chatId, submits, sent, undone } = await unfinished();
    await Promise.all([hermes.finishReplay(chatId), hermes.finishReplay(chatId)]);
    expect(server.undoCalls.length - undone).toBe(1);
    expect(submits()).toHaveLength(sent + 1);
    // The copied history before the message is all still there.
    expect(server.transcripts[chatId].filter((m) => m.role !== "user" || m.text !== "Clean up snapshots older than 90 days")).toHaveLength(6);
  });

  it("takes nothing back when another client changed the branch's last message meanwhile", async () => {
    const { server, hermes, chatId, submits, sent, undone } = await unfinished();
    copyIn(server, chatId).text = "Changed on the phone";
    await expect(hermes.finishReplay(chatId)).rejects.toThrow("isn't the one it was made with");
    expect(server.undoCalls).toHaveLength(undone);
    expect(submits()).toHaveLength(sent);
    expect(copyIn(server, chatId).text).toBe("Changed on the phone");
  });

  it("shows the branch right when an earlier try took the copy back but its answer was lost", async () => {
    const { server, hermes, chat, chatId, submits, sent } = await unfinished();
    // Hermes took it back, with the model-switch marker after it, and the answer never arrived.
    const copy = server.transcripts[chatId].indexOf(copyIn(server, chatId));
    expect(server.transcripts[chatId].slice(copy + 1).map((m) => m.display_kind)).toEqual(["model_switch"]);
    server.transcripts[chatId] = server.transcripts[chatId].slice(0, copy);
    expect(texts(chat(chatId).items).at(-1)).toBe("user: Clean up old snapshots");
    expect(await hermes.finishReplay(chatId)).toEqual([]);
    expect(submits()).toHaveLength(sent + 1);
    expect(texts(chat(chatId).items).filter((t) => t.startsWith("user:"))).toEqual([
      "user: How full is the NAS?",
      "user: @file:/srv/uploads/report.pdf\n\nCompare with this",
      "user: Clean up snapshots older than 90 days",
    ]);
  });

  it("keeps the words pending when the owner switches profile while it finishes, and sends nothing", async () => {
    const t = await chatWithHistory((s) => (s.otherProfiles.work = [row("w1", 0.2, { title: "Work chat" })]));
    t.server.undoBusy = true;
    const p = await t.hermes.previewReplay("c1", t.itemWith("Clean up"), "edit");
    const { chatId } = await t.hermes.replay(p, "Clean up snapshots older than 90 days");
    t.server.undoBusy = false;
    const sent = t.submits().length;
    const finishing = t.hermes.finishReplay(chatId);
    const switching = t.hermes.switchProfile("work");
    await expect(finishing).rejects.toThrow("The profile changed meanwhile");
    await switching;
    expect(t.submits()).toHaveLength(sent);
    await t.hermes.switchProfile("default");
    await t.hermes.idle();
    expect(t.hermes.getSnapshot().branches.links[chatId].variant?.pending?.text).toBe("Clean up snapshots older than 90 days");
  });

  it("finishes Send it now when the connection goes to the background meanwhile, and refuses to start one there", async () => {
    const { hermes, chatId, submits, sent } = await unfinished();
    const finishing = hermes.finishReplay(chatId);
    // Another connection became the composer target while the copy was being taken back (ADR 0125).
    hermes.setRole("background");
    expect(await finishing).toEqual([]);
    expect(submits().slice(sent).map((r) => r.params.text)).toEqual(["Clean up snapshots older than 90 days"]);
    expect(hermes.getSnapshot().branches.links[chatId].variant?.pending).toBeUndefined();
    await expect(hermes.finishReplay(chatId)).rejects.toThrow("background");
  });

  it("finishes an Edit started on the target when the connection goes to the background while it branches", async () => {
    const { hermes, itemWith, submits } = await chatWithHistory();
    const sent = submits().length;
    const p = await hermes.previewReplay("c1", itemWith("Clean up"), "edit");
    const editing = hermes.replay(p, "Clean up snapshots older than 90 days");
    hermes.setRole("background");
    const { chatId } = await editing;
    expect(submits().slice(sent).map((r) => r.params.text)).toEqual(["Clean up snapshots older than 90 days"]);
    expect(hermes.getSnapshot().branches.links[chatId].variant?.pending).toBeUndefined();
    await expect(hermes.replay(p, "Again")).rejects.toThrow("background");
  });

  it("stops, and drops nothing from the branch, when another message goes to it while it finishes", async () => {
    const { server, hermes, chat, chatId, submits, sent, undone } = await unfinished();
    const finishing = hermes.finishReplay(chatId);
    const other = hermes.send(chatId, "A message typed meanwhile");
    await expect(finishing).rejects.toThrow(/on its way|still replying|isn.t confirmed/);
    await other;
    expect(server.undoCalls).toHaveLength(undone);
    expect(submits().slice(sent).map((r) => r.params.text)).toEqual(["A message typed meanwhile"]);
    expect(texts(chat(chatId).items)).toContain("user: A message typed meanwhile");
  });

  it("leaves no Saved copy of a first message taken back, so it can't come back after a restart", async () => {
    const cache = memoryCache();
    const server = new FakeHermes();
    server.sessions = [row("c2", 0.2, { title: "Trip" })];
    server.storeMessage("c2", { role: "user", text: "Three days in Lisbon?" });
    server.storeMessage("c2", { role: "assistant", text: "Alfama, Belém, Sintra." });
    const hermes = await connect(server.openPipe, undefined, cache);
    await hermes.sync();
    await hermes.open("c2");
    const user = hermes.getSnapshot().chats.find((c) => c.id === "c2")!.items.find((i) => i.kind === "user")!.id;
    server.undoBusy = true;
    const { chatId } = await hermes.replay(await hermes.previewReplay("c2", user, "edit"), "Four days in Porto?");
    server.undoBusy = false;
    cache.saveTranscript("default", chatId, [{ kind: "user", id: "h-0", text: "Three days in Lisbon?" }]);
    server.rejectPrompt = { code: 5032, message: "no AI provider" };
    await hermes.finishReplay(chatId);
    expect(server.transcripts[chatId]).toEqual([]);
    expect(cache.loadTranscript("default", chatId)).toBeUndefined();
  });

  it("sends nothing when Hermes took back a different part of the branch than asked", async () => {
    const { server, hermes, itemWith, submits } = await chatWithHistory();
    server.undoShort = true;
    const sent = submits().length;
    const p = await hermes.previewReplay("c1", itemWith("Clean up"), "edit");
    const { warnings } = await hermes.replay(p, "Edited");
    expect(warnings.join(" ")).toMatch(/took back a different part/);
    expect(submits()).toHaveLength(sent);
  });
});
