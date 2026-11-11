// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { ApprovalMode } from "../hermes/model";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.getElementById("narrow")?.remove();
});

const connection = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
const pill = () => screen.queryByRole("button", { name: /^Approval mode:/ }) as HTMLButtonElement | null;
const face = () => pill()!.getAttribute("aria-label");
const menu = () => screen.getByRole("menu", { name: "Approval mode" });
const option = (name: string) => within(menu()).getByRole("menuitemradio", { name });
const warning = () => screen.queryByRole("dialog", { name: "Turn on YOLO for this chat?" });
const writes = (server: FakeHermes) => server.requests.filter((r) => r.method === "config.set").map((r) => [r.params.key, r.params.value]);
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

async function signedIn(mode: ApprovalMode = "smart", tweak: (s: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.approvalModes = { default: mode };
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  tweak(server);
  const hermes = await connect(server.openPipe);
  const user = userEvent.setup();
  render(<Main hermes={hermes} connection={connection} onSignOut={async () => {}} />);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await settle(hermes);
  const open = async (title: string, stored: string, reported = true) => {
    await user.click(screen.getByRole("button", { name: new RegExp(title) }));
    await settle(hermes);
    if (reported) act(() => server.reportApprovals(server.runtimeIdOf(stored)!));
    await settle(hermes);
  };
  const pick = async (name: string) => {
    await user.click(pill()!);
    await user.click(option(name));
    if (name === "YOLO" && warning()) await user.click(within(warning()!).getByRole("button", { name: "Turn on YOLO" }));
    await settle(hermes);
  };
  return { server, hermes, user, open, pick };
}

describe("The approval mode pill", () => {
  it("reads unknown, disabled with the reason, until Hermes reports, then shows the mode", async () => {
    const { open } = await signedIn();
    await open("Nightly backup", "backup", false);
    expect(face()).toBe("Approval mode: unknown");
    expect(pill()!.textContent).toBe("Approvals");
    expect(pill()!.disabled).toBe(true);
    expect(pill()!.getAttribute("aria-description")).toBe("Hermes hasn't reported this chat's approval mode yet.");

    await open("Nightly backup", "backup");
    expect(face()).toBe("Approval mode: Smart");
    expect(pill()!.textContent).toBe("Smart");
    expect(pill()!.disabled).toBe(false);
  });

  it("sets the profile's mode with Manual, which every open chat on the profile then shows", async () => {
    const { server, open, user } = await signedIn();
    await open("NAS disks", "nas");
    await open("Nightly backup", "backup");
    await user.click(pill()!);
    expect(option("Smart").getAttribute("aria-checked")).toBe("true");
    expect(menu().textContent).toContain("Smart and Manual change every chat on the default profile, including CLI and Telegram ones.");
    await user.click(option("Manual"));
    await act(async () => {});

    expect(writes(server)).toEqual([["approvals.mode", "manual"]]);
    expect(server.last("config.set")!.params).toEqual({ session_id: server.runtimeIdOf("backup"), profile: "default", key: "approvals.mode", value: "manual" });
    expect(face()).toBe("Approval mode: Manual");
    expect(screen.queryByRole("menu")).toBeNull();

    await open("NAS disks", "nas", false);
    expect(face()).toBe("Approval mode: Manual");
  });

  it("warns before YOLO, sends nothing on Cancel, and turns it on for this chat alone", async () => {
    const { server, open, user } = await signedIn();
    await open("NAS disks", "nas");
    await open("Nightly backup", "backup");
    await user.click(pill()!);
    await user.click(option("YOLO"));
    expect(warning()!.textContent).toContain("Writes to AGENTS.md, CLAUDE.md and SOUL.md still ask.");
    expect(warning()!.textContent).toContain("Commands on Hermes's blocklist are still blocked.");
    expect(document.activeElement!.textContent).toBe("Cancel");
    await user.click(within(warning()!).getByRole("button", { name: "Cancel" }));
    expect(warning()).toBeNull();
    expect(writes(server)).toEqual([]);
    expect(face()).toBe("Approval mode: Smart");

    await user.click(pill()!);
    await user.click(option("YOLO"));
    await user.click(within(warning()!).getByRole("button", { name: "Turn on YOLO" }));
    await act(async () => {});
    expect(writes(server)).toEqual([["yolo", "on"]]);
    expect(face()).toBe("Approval mode: YOLO, this chat");
    expect(pill()!.textContent).toBe("YOLO · this chat");
    expect(warning()).toBeNull();

    await open("NAS disks", "nas", false);
    expect(face()).toBe("Approval mode: Smart");
  });

  it("turns the chat's YOLO off before setting the mode, when Smart or Manual is picked", async () => {
    const { server, open, pick } = await signedIn("manual");
    await open("Nightly backup", "backup");
    await pick("YOLO");
    await pick("Smart");
    expect(writes(server)).toEqual([["yolo", "on"], ["yolo", "off"], ["approvals.mode", "smart"]]);
    expect(face()).toBe("Approval mode: Smart");
  });

  it("warns every time YOLO is turned on, and picking YOLO again while it is on sends nothing", async () => {
    const { server, open, pick, user } = await signedIn();
    await open("Nightly backup", "backup");
    await pick("YOLO");
    await user.click(pill()!);
    await user.click(option("YOLO"));
    expect(warning()).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();

    await pick("Smart");
    await user.click(pill()!);
    await user.click(option("YOLO"));
    expect(warning()).toBeTruthy();
    expect(writes(server)).toEqual([["yolo", "on"], ["yolo", "off"], ["approvals.mode", "smart"]]);
  });

  it("shows YOLO for all chats when the profile's mode is off, and Smart puts it back", async () => {
    const { server, open, pick, user } = await signedIn("off");
    await open("Nightly backup", "backup");
    expect(face()).toBe("Approval mode: YOLO, all chats");
    expect(pill()!.textContent).toBe("YOLO · all chats");
    await user.click(pill()!);
    expect(within(menu()).getAllByRole("menuitemradio").map((o) => o.getAttribute("aria-label"))).toEqual(["Smart", "Manual", "YOLO"]);
    await user.click(option("YOLO"));
    expect(warning()).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(writes(server)).toEqual([]);

    await pick("Smart");
    expect(writes(server)).toEqual([["yolo", "off"], ["approvals.mode", "smart"]]);
    expect(face()).toBe("Approval mode: Smart");
  });

  it("keeps the menu until Hermes answers, so nothing dismisses it or starts another pick meanwhile", async () => {
    let answer: (() => void) | undefined;
    const { server, hermes, open, user } = await signedIn("smart", (s) => {
      const real = s.handlers["config.set"];
      s.handlers["config.set"] = (r) => void (answer = () => real(r));
    });
    await open("Nightly backup", "backup");
    await user.click(pill()!);
    await user.click(option("Manual"));
    await user.keyboard("{Escape}");
    await user.click(document.body);
    await user.click(pill()!);
    expect(menu().getAttribute("aria-busy")).toBe("true");
    expect((option("Smart") as HTMLButtonElement).disabled).toBe(true);
    expect(writes(server)).toEqual([["approvals.mode", "manual"]]);

    act(() => answer!());
    await settle(hermes);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(face()).toBe("Approval mode: Manual");
  });

  it("shows Hermes's refusal in the menu and leaves the mode as Hermes reports it", async () => {
    const { server, open, user } = await signedIn("smart", (s) => s.managedKeys.add("approvals.mode"));
    await open("Nightly backup", "backup");
    await user.click(pill()!);
    await user.click(option("Manual"));
    await act(async () => {});
    expect(within(menu()).getByRole("alert").textContent).toBe("approvals.mode is managed by your administrator");
    expect(face()).toBe("Approval mode: Smart");
    expect(writes(server)).toEqual([["approvals.mode", "manual"]]);
  });

  it("ends at the mode Hermes answered when Hermes sends a stale session.info around each write", async () => {
    const { open, pick } = await signedIn("manual", (s) => (s.staleInfoOnWrite = true));
    await open("Nightly backup", "backup");
    await pick("YOLO");
    expect(face()).toBe("Approval mode: YOLO, this chat");
    await pick("Smart");
    expect(face()).toBe("Approval mode: Smart");
    await pick("Manual");
    expect(face()).toBe("Approval mode: Manual");
  });

  it("is disabled with the reason while disconnected, and the New chat pane has none", async () => {
    const { server, hermes, open } = await signedIn();
    expect(pill()).toBeNull();
    await open("Nightly backup", "backup");
    act(() => server.drop());
    await settle(hermes);
    expect(pill()!.disabled).toBe(true);
    expect(pill()!.getAttribute("aria-description")).toBe("Connect to Hermes to change the approval mode.");
  });

  it("keeps the full mode in its name when the composer is too narrow for the label", async () => {
    const { open, pick } = await signedIn();
    await open("Nightly backup", "backup");
    await pick("YOLO");
    const narrow = document.createElement("style");
    narrow.id = "narrow";
    narrow.textContent = ".approvals-label { display: none; }";
    document.head.append(narrow);
    expect(screen.getByRole("button", { name: "Approval mode: YOLO, this chat" })).toBeTruthy();
  });
});
