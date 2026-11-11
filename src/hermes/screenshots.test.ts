// The screenshot desk: a capture goes to the composer on screen (or waits for one), failures turn into the notes the
// owner reads, each chat keeps its staged files, and every capture is deleted once nothing needs it.
import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "./model";
import { ScreenshotDesk, captureName, failureText, type Captured, type ScreenshotApi, type ScreenshotSink } from "./screenshots";
import { stagedFiles } from "./unsaved";

/** A Rust side whose captures land when the test says. */
function fakeApi() {
  const discarded: string[] = [];
  const names: string[] = [];
  let pending: { resolve: (c: Captured) => void; reject: (e: unknown) => void } | undefined;
  const api: ScreenshotApi = {
    capture: (name) => {
      names.push(name);
      return new Promise((resolve, reject) => (pending = { resolve, reject }));
    },
    discard: async (path) => void discarded.push(path),
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    api,
    discarded,
    names,
    land: async (c: Captured) => (pending!.resolve(c), await flush()),
    fail: async (e: unknown) => (pending!.reject(e), await flush()),
  };
}

const file = (path: string): Attachment => ({ path, name: path.split("/").pop()!, size: 10, kind: "image" });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A composer on the chat whose Draft key is `key`. `attached`: the files it was asked to check. */
function sink(keep: (paths: string[]) => string[] = (p) => p, key = "chat-a") {
  const attached: string[][] = [];
  const notes: string[] = [];
  const s: ScreenshotSink = { key, check: async (paths) => (attached.push(paths), keep(paths).map(file)), note: (t) => void notes.push(t) };
  return { s, attached, notes };
}

describe("Screenshot desk", () => {
  it("deletes a pasted file once it is sent, held while its message is in the outbox, and at once after signing out", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    const pasted = "/home/liam/.cache/hermes-chat/captures/1/0/clipboard.png";
    desk.own([pasted]);
    desk.hold([pasted]);
    desk.release([pasted]);
    desk.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(rust.discarded).toEqual([]);
    desk.sent("chat-a", [{ path: pasted, name: "clipboard.png", size: 1, kind: "image" }], true);
    desk.own(["/home/liam/.cache/hermes-chat/captures/1/1/late.png"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(rust.discarded).toEqual([pasted, "/home/liam/.cache/hermes-chat/captures/1/1/late.png"]);
  });

  it("stages a capture in the chat on screen, and deletes it once the owner removes it", async () => {
    const rust = fakeApi();
    const onAttached = vi.fn();
    const desk = new ScreenshotDesk(rust.api, onAttached);
    const composer = sink();
    desk.attachTo(composer.s);

    const taking = desk.capture();
    expect(desk.getSnapshot()).toEqual({ capturing: true });
    expect(rust.names[0]).toMatch(/^screenshot-\d{4}-\d\d-\d\d-\d{6}$/);
    await rust.land({ path: "/run/user/1000/hermes-chat/captures/1/0/shot.png" });
    await taking;

    expect(composer.attached).toEqual([["/run/user/1000/hermes-chat/captures/1/0/shot.png"]]);
    expect(desk.stagedIn("chat-a").map((a) => a.path)).toEqual(["/run/user/1000/hermes-chat/captures/1/0/shot.png"]);
    expect(onAttached).toHaveBeenCalledWith(false);
    expect(desk.getSnapshot()).toEqual({ capturing: false });
    expect(rust.discarded).toEqual([]);

    // Anything that isn't a capture is never deleted, and a capture is deleted once.
    desk.change({ kind: "removed", key: "chat-a", paths: ["/home/liam/Pictures/rack.png", "/run/user/1000/hermes-chat/captures/1/0/shot.png"] });
    desk.change({ kind: "removed", key: "chat-a", paths: ["/run/user/1000/hermes-chat/captures/1/0/shot.png"] });
    await tick();
    expect(desk.stagedIn("chat-a")).toEqual([]);
    expect(rust.discarded).toEqual(["/run/user/1000/hermes-chat/captures/1/0/shot.png"]);
  });

  it("takes one capture at a time", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    void desk.capture();
    void desk.capture();
    expect(rust.names).toHaveLength(1);
  });

  it("holds a capture until a composer is on screen, with any note about it", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    const taking = desk.capture({ remote: true });
    await rust.land({ path: "/c/1/0/a.png", note: "Your desktop also saved its own copy at /home/liam/Pictures/a.png." });
    await taking;

    const composer = sink();
    desk.attachTo(composer.s);
    await new Promise((r) => setTimeout(r, 0));
    expect(composer.attached).toEqual([["/c/1/0/a.png"]]);
    expect(composer.notes).toEqual(["Your desktop also saved its own copy at /home/liam/Pictures/a.png."]);
  });

  it("deletes a capture the composer refused, such as one too large for Hermes", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    desk.attachTo(sink(() => []).s);
    const taking = desk.capture();
    await rust.land({ path: "/c/1/0/huge.png" });
    await taking;
    expect(rust.discarded).toEqual(["/c/1/0/huge.png"]);
  });

  it("says nothing when the owner cancels, and says why otherwise", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    const composer = sink();
    desk.attachTo(composer.s);
    for (const failure of [
      { kind: "cancelled" },
      { kind: "denied", message: "Your desktop didn't allow Hermes Chat to take a screenshot." },
      { kind: "unsupported", message: "No screenshot portal is running." },
      { kind: "failed", message: "grim failed: out of memory" },
      "Command screenshot_capture not found",
    ]) {
      const taking = desk.capture();
      await rust.fail(failure);
      await taking;
    }
    expect(composer.notes).toEqual([
      "Your desktop didn't allow Hermes Chat to take a screenshot.",
      "Screenshots don't work on this desktop yet. No screenshot portal is running.",
      "Couldn't take a screenshot: grim failed: out of memory",
      "Couldn't take a screenshot: Command screenshot_capture not found",
    ]);
    expect(composer.attached).toEqual([]);
  });

  it("deletes every capture when the window signs out, including one still being taken", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    desk.attachTo(sink().s);
    let taking = desk.capture();
    await rust.land({ path: "/c/1/0/staged.png" });
    await taking;

    taking = desk.capture();
    desk.dispose();
    await rust.land({ path: "/c/1/1/late.png" });
    await taking;
    expect(rust.discarded.sort()).toEqual(["/c/1/0/staged.png", "/c/1/1/late.png"]);
    // And nothing more is taken.
    void desk.capture();
    expect(rust.names).toHaveLength(2);
  });

  it("hands a capture to the composer now on screen when the one checking it goes meanwhile", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    // The first composer's check is still running when it goes (another chat opened).
    let check!: (kept: Attachment[]) => void;
    const first: ScreenshotSink = { key: "chat-a", check: () => new Promise((r) => (check = r)), note: () => {} };
    const stop = desk.attachTo(first);
    const taking = desk.capture();
    await rust.land({ path: "/c/1/0/a.png" });
    stop();
    const second = sink(undefined, "chat-b");
    desk.attachTo(second.s);
    check([file("/c/1/0/a.png")]);
    await taking;
    expect(second.attached).toEqual([["/c/1/0/a.png"]]);
    expect(desk.stagedIn("chat-a")).toEqual([]);
    expect(desk.stagedIn("chat-b").map((a) => a.path)).toEqual(["/c/1/0/a.png"]);
    expect(rust.discarded).toEqual([]);
  });

  it("puts captures back in the chat they were sent from when Hermes didn't confirm the message, and deletes them once it did", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    const composer = sink();
    desk.attachTo(composer.s);
    const taking = desk.capture();
    await rust.land({ path: "/c/1/0/a.png" });
    await taking;
    const sending = [file("/c/1/0/a.png"), file("/home/liam/rack.png")];
    desk.hold(["/c/1/0/a.png"]);
    desk.change({ kind: "sent", key: "chat-a", paths: ["/c/1/0/a.png"] });
    expect(desk.stagedIn("chat-a")).toEqual([]);

    desk.sent("chat-a", sending, false);
    await tick();
    expect(desk.stagedIn("chat-a").map((a) => a.path)).toEqual(["/c/1/0/a.png"]);
    expect(composer.notes).toEqual(["Hermes didn't confirm it got your message, so its files are back here. Send them again, or remove them."]);
    expect(rust.discarded).toEqual([]);

    desk.hold(["/c/1/0/a.png"]);
    desk.change({ kind: "sent", key: "chat-a", paths: ["/c/1/0/a.png"] });
    desk.sent("chat-a", [file("/c/1/0/a.png")], true);
    await new Promise((r) => setTimeout(r, 0));
    expect(rust.discarded).toEqual(["/c/1/0/a.png"]);
  });

  it("stops handing captures to a composer that has gone", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    const first = sink();
    const stop = desk.attachTo(first.s);
    stop();
    const taking = desk.capture();
    await rust.land({ path: "/c/1/0/a.png" });
    await taking;
    expect(first.attached).toEqual([]);
    const second = sink();
    desk.attachTo(second.s);
    await new Promise((r) => setTimeout(r, 0));
    expect(second.attached).toEqual([["/c/1/0/a.png"]]);
  });
});

describe("Each chat's staged attachments", () => {
  it("keeps each chat's files apart, lists them all for Settings, and deletes a chat's own once it goes", async () => {
    const rust = fakeApi();
    // Desks of the tests above that never signed out still list theirs.
    const others = stagedFiles.getSnapshot();
    const desk = new ScreenshotDesk(rust.api);
    desk.own(["/c/1/0/a.png", "/c/1/1/b.png"]);
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/1/0/a.png"), file("/home/liam/notes.txt")] });
    desk.change({ kind: "added", key: "chat-b", attachments: [file("/c/1/1/b.png")] });
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/1/0/a.png")] });
    expect(desk.stagedIn("chat-a").map((a) => a.name)).toEqual(["a.png", "notes.txt"]);
    expect(desk.stagedIn("chat-b").map((a) => a.name)).toEqual(["b.png"]);
    expect(stagedFiles.getSnapshot()).toEqual([...others, "a.png", "notes.txt", "b.png"]);

    desk.change({ kind: "gone", key: "chat-a" });
    await tick();
    expect(desk.stagedIn("chat-a")).toEqual([]);
    expect(rust.discarded).toEqual(["/c/1/0/a.png"]);
    expect(stagedFiles.getSnapshot()).toEqual([...others, "b.png"]);

    desk.dispose();
    await tick();
    expect(rust.discarded).toEqual(["/c/1/0/a.png", "/c/1/1/b.png"]);
    expect(stagedFiles.getSnapshot()).toEqual(others);
  });

  it("stages a file it owns in one chat at a time, and one the owner picked from their folders in any", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    desk.own(["/c/1/0/a.png"]);
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/1/0/a.png"), file("/home/liam/notes.txt")] });
    desk.change({ kind: "added", key: "chat-b", attachments: [file("/c/1/0/a.png"), file("/home/liam/notes.txt")] });
    expect(desk.stagedIn("chat-a").map((a) => a.path)).toEqual(["/home/liam/notes.txt"]);
    expect(desk.stagedIn("chat-b").map((a) => a.path)).toEqual(["/c/1/0/a.png", "/home/liam/notes.txt"]);
    desk.change({ kind: "removed", key: "chat-b", paths: ["/c/1/0/a.png"] });
    await tick();
    expect(rust.discarded).toEqual(["/c/1/0/a.png"]);
  });

  it("deletes a file staged after signing out", async () => {
    const rust = fakeApi();
    const desk = new ScreenshotDesk(rust.api);
    desk.own(["/c/1/0/a.png"]);
    desk.dispose();
    await tick();
    expect(rust.discarded).toEqual(["/c/1/0/a.png"]);
    desk.change({ kind: "added", key: "chat-a", attachments: [file("/c/1/0/late.png")] });
    expect(desk.stagedIn("chat-a")).toEqual([]);
  });
});

describe("Screenshot names and notes", () => {
  it("names a capture by local time", () => {
    const at = new Date(2026, 10, 2, 15, 34, 17);
    expect(captureName(at)).toBe("screenshot-2026-11-02-153417");
  });

  it("has nothing to say about a second press while picking", () => {
    expect(failureText({ kind: "busy" })).toBeUndefined();
    expect(failureText({ kind: "cancelled" })).toBeUndefined();
    expect(failureText({ kind: "denied" })).toBe("Your desktop didn't allow the screenshot.");
  });
});

it("keeps an in-flight capture when its composer unmounts, then releases it after outbox reconciliation", async () => {
  const rust = fakeApi();
  const desk = new ScreenshotDesk(rust.api);
  desk.attachTo(sink().s);
  const taking = desk.capture();
  await rust.land({ path: "/c/1/0/a.png" });
  await taking;
  desk.hold(["/c/1/0/a.png"]);
  desk.release(["/c/1/0/a.png"]);
  desk.dispose();
  expect(rust.discarded).toEqual([]);
  desk.finish(["/c/1/0/a.png"]);
  expect(rust.discarded).toEqual(["/c/1/0/a.png"]);
});
