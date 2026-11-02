// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Found, Updater, UpdateState } from "../hermes/updates";
import { getUIPrefs } from "../hermes/uiPrefs";
import { UpdateSettings } from "./UpdateSettings";

afterEach(cleanup);

const fake = (s: UpdateState): Updater => ({
  getSnapshot: () => s,
  subscribe: () => () => {},
  check: vi.fn(async () => {}),
  install: vi.fn(async () => {}),
  restart: vi.fn(async () => {}),
  restoreAfterRestart: vi.fn(async () => {}),
});
const pkg: Found = {
  from: "r312.ef433a2-1",
  to: "r314.2222222",
  notes: [{ text: "#38 Status bar" }],
  more: 3,
  via: "pacman",
  allUrl: "https://github.com/l0cky12/hermes-chat/compare/ef433a2...main",
  command: "git pull && cd packaging/aur && makepkg -si",
};

describe("UpdateSettings", () => {
  it("shows a package update's notes and the command to run, with no install button", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const u = fake({ state: "available", found: pkg, checkedAt: 0 });
    render(<UpdateSettings updates={u} />);
    expect(screen.getByText("r314.2222222")).toBeTruthy();
    expect(screen.getByText("#38 Status bar")).toBeTruthy();
    expect(screen.getByText("and 3 more")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith(pkg.command);
    expect(screen.getByRole("button", { name: /copied/i })).toBeTruthy();
  });

  it("installs a standalone update when asked", async () => {
    const u = fake({ state: "available", found: { ...pkg, via: "updater", command: undefined, from: "0.1.0", to: "0.2.0" }, checkedAt: 0 });
    render(<UpdateSettings updates={u} />);
    await userEvent.click(screen.getByRole("button", { name: /download and install/i }));
    expect(u.install).toHaveBeenCalled();
  });

  it("shows download progress", () => {
    render(<UpdateSettings updates={fake({ state: "installing", found: { ...pkg, via: "updater" }, downloaded: 1024 * 1024, total: 4 * 1024 * 1024 })} />);
    const bar = screen.getByRole("progressbar", { name: "Update download" }) as HTMLProgressElement;
    expect(bar.value).toBe(1024 * 1024);
    expect(bar.max).toBe(4 * 1024 * 1024);
  });

  it("restarts only when the owner asks, saying drafts and unsent messages are kept", async () => {
    const u = fake({ state: "restart", from: "r312.ef433a2-1", to: "r314.2222222-1" });
    render(<UpdateSettings updates={u} />);
    expect(screen.getByText(/drafts and unsent messages are kept/)).toBeTruthy();
    expect(u.restart).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /restart now/i }));
    expect(u.restart).toHaveBeenCalled();
  });

  it("shows a failure and tries the failed step again", async () => {
    let u = fake({ state: "error", message: "Couldn't reach GitHub to check for updates: offline" });
    render(<UpdateSettings updates={u} />);
    expect(screen.getByRole("alert").textContent).toContain("offline");
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(u.check).toHaveBeenCalled();
    cleanup();
    u = fake({ state: "error", message: "Couldn't install 0.2.0", found: { ...pkg, via: "updater" } });
    render(<UpdateSettings updates={u} />);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(u.install).toHaveBeenCalled();
  });

  it("turns the launch check off", async () => {
    render(<UpdateSettings updates={fake({ state: "idle" })} />);
    const sw = screen.getByRole("switch", { name: /check for updates on launch/i });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sw);
    expect(getUIPrefs().checkUpdatesOnLaunch).toBe(false);
  });
});
