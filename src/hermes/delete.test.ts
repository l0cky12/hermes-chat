// @vitest-environment jsdom
// Deleting a chat: what reaches Hermes, and the chat menu's Delete chat… and the question it asks first.
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMenu } from "../ui/ChatMenu";
import { DeleteChatDialog } from "../ui/DeleteChat";
import { FakeHermes, row, type RestRequest } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { connect } from "./transport";

async function listed(...rows: ReturnType<typeof row>[]) {
  const server = new FakeHermes();
  server.sessions = rows;
  const cache = memoryCache();
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  const ids = () => hermes.getSnapshot().chats.map((c) => c.id);
  return { server, hermes, cache, ids };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Each delete's session and profile; the identity it names is checked on its own. */
const deletes = (server: FakeHermes) =>
  server.restRequests.filter((r) => r.method === "DELETE").map((r) => `${r.path}?profile=${new URLSearchParams(r.query).get("profile")}`);

/** Holds back the server's answers to `METHOD /path` until the returned function is called. */
function hold(server: FakeHermes, key: string, answer: (req: RestRequest) => unknown = () => ({ ok: true })) {
  const held: (() => void)[] = [];
  server.rest[key] = (req) => new Promise((resolve) => held.push(() => resolve(answer(req))));
  return () => {
    delete server.rest[key];
    held.splice(0).forEach((go) => go());
  };
}

describe("Deleting a chat", () => {
  it("deletes the chat's session on the server, for the chat's profile", async () => {
    const { server, hermes, ids } = await listed(row("a", 1, { pinned: true }), row("b", 2));
    expect(await hermes.delete("a")).toBe(true);
    expect(deletes(server)).toEqual(["/api/sessions/a?profile=default"]);
    expect(server.sessions.map((s) => s.id)).toEqual(["b"]);
    expect(ids()).toEqual(["b"]);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("names a new request id, the session's revision and its generation, which Hermes refuses a delete without", async () => {
    const { server, hermes, ids } = await listed(row("a", 1), row("b", 2));
    // An edit elsewhere moved the revision on; the delete names the one Hermes has now.
    Object.assign(server.sessions.find((s) => s.id === "a")!, { runtime_revision: 3, runtime_generation: 2 });
    expect(await hermes.delete("a")).toBe(true);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
    const sent = server.restRequests.filter((r) => r.method === "DELETE").map((r) => new URLSearchParams(r.query));
    expect(sent).toHaveLength(1);
    expect(sent[0].get("request_id")).toMatch(/^[0-9a-f-]{36}$/);
    expect([sent[0].get("profile"), sent[0].get("expected_revision"), sent[0].get("expected_generation")]).toEqual(["default", "3", "2"]);
    expect(ids()).toEqual(["b"]);
  });

  /** Answers the chat's next `count` revision reads with what it was before, as if it moved on just after each read. */
  const readStale = (server: FakeHermes, id: string, count: number) => {
    const key = `GET /api/sessions/${id}/mutation-snapshot`;
    let left = count;
    server.rest[key] = () => {
      if (--left <= 0) delete server.rest[key];
      const s = server.sessions.find((r) => r.id === id)!;
      return { session_id: id, exists: true, runtime_revision: (s.runtime_revision ?? 0) - 1, runtime_generation: s.runtime_generation ?? 0 };
    };
  };

  it("reads the session again and deletes it when it moved on between the read and the delete", async () => {
    const { server, hermes, ids } = await listed(row("a", 1), row("b", 2));
    server.sessions.find((s) => s.id === "a")!.runtime_revision = 1;
    readStale(server, "a", 1);
    expect(await hermes.delete("a")).toBe(true);
    expect(deletes(server)).toEqual(["/api/sessions/a?profile=default", "/api/sessions/a?profile=default"]);
    expect(ids()).toEqual(["b"]);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("tries again only once, then puts the chat back and says why", async () => {
    const { server, hermes, ids } = await listed(row("a", 1, { title: "Nightly backup" }), row("b", 2));
    server.sessions.find((s) => s.id === "a")!.runtime_revision = 1;
    readStale(server, "a", 2);
    expect(await hermes.delete("a")).toBe(false);
    expect(deletes(server)).toHaveLength(2);
    expect(ids().sort()).toEqual(["a", "b"]);
    expect(hermes.getSnapshot().syncError).toBe('Couldn\'t delete "Nightly backup": The dashboard answered 409: {"detail":"revision_conflict"}');
  });

  it("takes the chat off the list at once, before the server has answered", async () => {
    const { server, hermes, ids } = await listed(row("a", 1), row("b", 2));
    const answer = hold(server, "DELETE /api/sessions/a", () => {
      server.sessions = server.sessions.filter((s) => s.id !== "a");
      return { ok: true };
    });
    const deleting = hermes.delete("a");
    expect(ids()).toEqual(["b"]);
    answer();
    await deleting;
    expect(ids()).toEqual(["b"]);
  });

  it("doesn't bring the chat back when a list read before the delete arrives after it", async () => {
    const { server, hermes, ids } = await listed(row("a", 1), row("b", 2));
    const list = server.rest["GET /api/sessions"];
    let answer!: () => void;
    server.rest["GET /api/sessions"] = (req) => {
      const stale = structuredClone(list(req));
      return new Promise((resolve) => (answer = () => resolve(stale)));
    };
    const syncing = hermes.sync();
    await tick();
    await hermes.delete("a");
    answer();
    await syncing;
    expect(ids()).toEqual(["b"]);
  });

  it("leaves the chat out of the list kept for the next start", async () => {
    const { hermes, cache } = await listed(row("a", 1), row("b", 2));
    await hermes.delete("a");
    expect(cache.saved.default.map((c) => c.id)).toEqual(["b"]);
  });

  it("puts the chat back and says why when the server refuses", async () => {
    const { server, hermes, ids, cache } = await listed(row("a", 1, { title: "Nightly backup" }), row("b", 2));
    server.rest["DELETE /api/sessions/a"] = () => {
      throw new Error("The dashboard answered 409: session_busy");
    };
    expect(await hermes.delete("a")).toBe(false);
    expect(ids().sort()).toEqual(["a", "b"]);
    expect(cache.saved.default.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(hermes.getSnapshot().syncError).toBe('Couldn\'t delete "Nightly backup": The dashboard answered 409: session_busy');
  });

  it("deletes a new chat Hermes hasn't stored yet", async () => {
    const { server, hermes, ids } = await listed();
    const id = await hermes.newChat();
    await hermes.delete(id);
    expect(deletes(server)).toEqual([`/api/sessions/${id}?profile=default`]);
    expect(ids()).toEqual([]);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("doesn't delete a chat while its reply is running", async () => {
    const { server, hermes, ids } = await listed();
    const id = await hermes.newChat();
    await hermes.send(id, "Clean up the logs");
    server.event(server.runtimeIdOf(id)!, "message.start");
    expect(await hermes.delete(id)).toBe(false);
    expect(deletes(server)).toEqual([]);
    expect(ids()).toEqual([id]);
  });

  it("waits for a settle still under way, so it doesn't report the settle failing", async () => {
    const { server, hermes, ids } = await listed(row("a", 1, { pinned: true }));
    const answer = hold(server, "PATCH /api/sessions/a");
    const settling = hermes.settle("a");
    await tick();
    const deleting = hermes.delete("a");
    await tick();
    expect(deletes(server)).toEqual([]);
    answer();
    await Promise.all([settling, deleting]);
    expect(deletes(server)).toEqual(["/api/sessions/a?profile=default"]);
    expect(ids()).toEqual([]);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("waits for an archive still under way, so it doesn't report the chat deleted elsewhere", async () => {
    const { server, hermes } = await listed(row("a", 1), row("b", 2));
    const answer = hold(server, "PATCH /api/sessions/a");
    const archiving = hermes.archive("a");
    await tick();
    const deleting = hermes.delete("a");
    await tick();
    expect(deletes(server)).toEqual([]);
    answer();
    expect(await deleting).toBe(true);
    await archiving;
    expect(deletes(server)).toEqual(["/api/sessions/a?profile=default"]);
    expect(hermes.getSnapshot().syncError).toBeUndefined();
  });

  it("deletes from the chat's own profile when the owner switches away meanwhile", async () => {
    const { server, hermes } = await listed(row("a", 1), row("b", 2));
    server.otherProfiles = { work: [row("w", 1)] };
    const answer = hold(server, "DELETE /api/sessions/a");
    const deleting = hermes.delete("a");
    await hermes.switchProfile("work");
    answer();
    await deleting;
    expect(deletes(server)).toEqual(["/api/sessions/a?profile=default"]);
    expect(hermes.getSnapshot().chats.map((c) => c.id)).toEqual(["w"]);
  });
});

afterEach(cleanup);

describe("Delete chat… in the chat menu", () => {
  const chat = { id: "a", title: "Nightly backup" } as Parameters<typeof ChatMenu>[0]["chat"];
  const menu = (onDelete?: () => void, onClose = vi.fn()) =>
    render(createElement(ChatMenu, { chat, x: 0, y: 0, onRename: vi.fn(), onRegenTitle: vi.fn(), onDelete, onClose }));

  it("is offered when the chat can be deleted, and closes the menu before asking", async () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    menu(onDelete, onClose);
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
    expect(onClose).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("isn't offered without a way to delete, as while a reply runs", () => {
    menu();
    expect(screen.getByRole("menuitem", { name: "Rename…" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete chat…" })).toBeNull();
  });
});

describe("The Delete question", () => {
  const ask = () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(createElement(DeleteChatDialog, { title: "Nightly backup", onDelete, onClose }));
    return { onDelete, onClose, dialog: screen.getByRole("alertdialog", { name: "Delete “Nightly backup”?" }) };
  };

  it("says it deletes the chat everywhere for good, with Cancel focused", () => {
    const { dialog } = ask();
    expect(dialog.textContent).toContain("This deletes the chat in every Hermes client, on every computer. It can't be undone.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("keeps the chat on Cancel, Escape, or a click outside", async () => {
    const { onDelete, onClose, dialog } = ask();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.pointer({ keys: "[MouseLeft]", target: dialog.parentElement! });
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("deletes on Delete chat", async () => {
    const { onDelete, onClose } = ask();
    await userEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("A copied profile, whose chats keep the ids they had", () => {
  it("lists its own copy of a chat deleted, or being archived, in the profile it was copied from, and gets none of that one's pins", async () => {
    const { server, hermes } = await listed(row("a", 1), row("b", 2), row("c", 3, { pinned: true }));
    server.otherProfiles = { work: [row("a", 1), row("b", 2), row("c", 3, { pinned: true })] };
    const shown = () => hermes.getSnapshot().chats.filter((c) => !c.archived).map((c) => c.id).sort();
    expect(await hermes.delete("a")).toBe(true);
    const answer = hold(server, "PATCH /api/sessions/b");
    const archiving = hermes.archive("b");
    // A Settle whose write fails stays wanted, to be written again.
    server.rest["PATCH /api/sessions/c"] = () => Promise.reject(new Error("The dashboard answered 503"));
    await hermes.settle("c");
    delete server.rest["PATCH /api/sessions/c"];
    expect(shown()).toEqual(["c"]);

    await hermes.switchProfile("work");
    await hermes.sync();
    expect(shown()).toEqual(["a", "b", "c"]);
    expect(hermes.getSnapshot().chats.find((c) => c.id === "c")).toMatchObject({ settled: false });
    expect(server.restRequests.filter((r) => r.method === "PATCH" && new URLSearchParams(r.query).get("profile") === "work")).toEqual([]);
    answer();
    await archiving;
  });
});
