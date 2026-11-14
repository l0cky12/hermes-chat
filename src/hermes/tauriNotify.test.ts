// What a desktop notification asks Rust to show, and what the owner's click or Deny on it does once Rust sends back its
// tag (src-tauri/src/notify.rs, ADR 0171). Rust is faked by stand-ins for `invoke` and `listen`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

type Acted = { tag: string; action: string };

/** A fresh copy of the module, with Rust's `notification-action` event as `act`. */
async function desktop() {
  vi.resetModules();
  let heard: ((e: { payload: Acted }) => void) | undefined;
  listen.mockImplementation(async (event: string, fn: typeof heard) => {
    expect(event).toBe("notification-action");
    heard = fn;
    return () => {};
  });
  const { desktopNotify } = await import("./tauriNotify");
  const act = (payload: Acted) => heard?.({ payload });
  const tags = () => invoke.mock.calls.map(([, args]) => (args as { tag?: string }).tag);
  return { desktopNotify, act, tags };
}

const APPROVAL = { title: "Hermes is asking for approval", body: "A command is waiting for your answer in Hermes Chat." };

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  listen.mockReset();
});

describe("Notification actions", () => {
  it("shows a plain notification untagged and listens for nothing", async () => {
    const { desktopNotify } = await desktop();
    await desktopNotify({ title: "Hermes finished a reply", body: "Open Hermes Chat to read it." });
    expect(invoke).toHaveBeenCalledWith("notify_desktop", { title: "Hermes finished a reply", body: "Open Hermes Chat to read it." });
    expect(listen).not.toHaveBeenCalled();
  });

  it("asks Rust for Deny only for a notification that can deny, and routes each action to its own notification", async () => {
    const { desktopNotify, act, tags } = await desktop();
    const first = { open: vi.fn(), deny: vi.fn() };
    const question = { open: vi.fn() };
    await desktopNotify(APPROVAL, first);
    await desktopNotify({ title: "Hermes has a question", body: "A question is waiting for your answer in Hermes Chat." }, question);
    expect(invoke.mock.calls[0]).toEqual(["notify_desktop", { ...APPROVAL, tag: tags()[0], deny: true }]);
    expect(invoke.mock.calls[1][1]).toMatchObject({ deny: false });
    expect(new Set(tags()).size).toBe(2);

    act({ tag: tags()[1]!, action: "open" });
    expect(question.open).toHaveBeenCalledTimes(1);
    expect(first.open).not.toHaveBeenCalled();

    act({ tag: tags()[0]!, action: "deny" });
    expect(first.deny).toHaveBeenCalledTimes(1);
    expect(first.open).not.toHaveBeenCalled();
  });

  it("acts once per notification, and ignores a tag it doesn't know and an action it doesn't offer", async () => {
    const { desktopNotify, act, tags } = await desktop();
    const actions = { open: vi.fn(), deny: vi.fn() };
    await desktopNotify(APPROVAL, actions);
    act({ tag: "not-ours", action: "deny" });
    act({ tag: tags()[0]!, action: "approve" });
    act({ tag: tags()[0]!, action: "deny" });
    act({ tag: tags()[0]!, action: "deny" });
    act({ tag: tags()[0]!, action: "open" });
    expect(actions.deny).not.toHaveBeenCalled();
    expect(actions.open).not.toHaveBeenCalled();
  });

  it("forgets a notification Rust couldn't show", async () => {
    const { desktopNotify, act, tags } = await desktop();
    invoke.mockRejectedValueOnce({ message: "No notification service" });
    const actions = { open: vi.fn(), deny: vi.fn() };
    await expect(desktopNotify(APPROVAL, actions)).rejects.toThrow("No notification service");
    act({ tag: tags()[0]!, action: "deny" });
    expect(actions.deny).not.toHaveBeenCalled();
  });

  it("keeps the newest 64 notifications' actions, as Rust does", async () => {
    const { desktopNotify, act, tags } = await desktop();
    const all = Array.from({ length: 65 }, () => ({ open: vi.fn() }));
    for (const a of all) await desktopNotify(APPROVAL, a);
    act({ tag: tags()[0]!, action: "open" });
    act({ tag: tags()[1]!, action: "open" });
    expect(all[0].open).not.toHaveBeenCalled();
    expect(all[1].open).toHaveBeenCalledTimes(1);
  });
});
