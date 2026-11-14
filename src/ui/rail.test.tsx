// @vitest-environment jsdom
// The rail's layout and its tips (ADR 0050, 0116): the daily tools first, then the Server group, and a tip that
// shows at once, with the button's name and shortcut, on hover or keyboard focus.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rail } from "./Sidebar";

afterEach(cleanup);

const noop = () => {};

function rail(over: Partial<Parameters<typeof Rail>[0]> = {}) {
  const props: Parameters<typeof Rail>[0] = {
    status: "connected",
    unsecure: false,
    onReconnect: noop,
    onToggleList: noop,
    onNew: vi.fn(),
    onSearch: noop,
    onSettings: noop,
    onJobs: noop,
    onAutomations: noop,
    onUsage: noop,
    onRepo: noop,
    ...over,
  };
  return { ...render(<Rail {...props} />), props, user: userEvent.setup() };
}

const names = (el: HTMLElement) => within(el).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
const tip = () => screen.queryByRole("tooltip", { hidden: true });

describe("the rail", () => {
  it("puts New chat and Search first, then the Server group, with Settings at the foot", () => {
    const { container } = rail();
    const top = container.querySelector(".rail-top") as HTMLElement;
    expect(names(top)).toEqual(["Hide or show chats", "New chat (Ctrl+N)", "Search all chats (Ctrl+K)"]);
    expect(screen.queryByRole("button", { name: /^Inbox/ })).toBeNull();
    expect(names(screen.getByRole("group", { name: "Server" }))).toEqual(["Repository", "Scheduled jobs", "Automations", "Usage"]);
    // Server files and the Terminal are the side panel's tabs, not rail buttons.
    expect(screen.queryByRole("group", { name: "Work" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Server files" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Terminal/ })).toBeNull();
    const bottom = container.querySelector(".rail-bottom") as HTMLElement;
    expect(names(bottom)).toEqual(["Connected", "Settings"]);
    // Import lives in Settings, not on the rail.
    expect(screen.queryByRole("button", { name: /Import/ })).toBeNull();
  });

  it("leaves out a group with none of its tools", () => {
    rail({ onRepo: undefined, onJobs: undefined, onAutomations: undefined, onUsage: undefined });
    expect(screen.queryByRole("group", { name: "Server" })).toBeNull();
  });

  it("names the shortcuts for screen readers", () => {
    rail();
    expect(screen.getByRole("button", { name: "New chat (Ctrl+N)" }).getAttribute("aria-keyshortcuts")).toBe("Control+N");
    expect(screen.getByRole("button", { name: "Search all chats (Ctrl+K)" }).getAttribute("aria-keyshortcuts")).toBe("Control+K");
    expect(screen.getByRole("button", { name: "Hide or show chats" }).getAttribute("aria-keyshortcuts")).toBe("Control+B");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-keyshortcuts")).toBe("Control+,");
  });

  it("shows a tip at once on hover, with the name and shortcut, and hides it on leaving", async () => {
    const { user } = rail();
    const btn = screen.getByRole("button", { name: "New chat (Ctrl+N)" });
    expect(tip()).toBeNull();
    await user.hover(btn);
    expect(tip()?.textContent).toBe("New chatCtrl+N");
    expect(tip()?.querySelector("kbd")?.textContent).toBe("Ctrl+N");
    await user.unhover(btn);
    expect(tip()).toBeNull();
  });

  it("keeps the tip while the pointer moves onto it, and hides it once the pointer leaves both", async () => {
    // user-event leaves `relatedTarget` unset, so the moves are dispatched as a browser does, with where the pointer went.
    const { user } = rail();
    const btn = screen.getByRole("button", { name: "Usage" });
    await user.hover(btn);
    const shownTip = tip() as HTMLElement;
    fireEvent.mouseOut(btn, { relatedTarget: shownTip });
    expect(tip()?.textContent).toContain("Usage");
    fireEvent.mouseOut(shownTip, { relatedTarget: btn });
    expect(tip()?.textContent).toContain("Usage");
    fireEvent.mouseOut(btn, { relatedTarget: shownTip });
    fireEvent.mouseOut(shownTip, { relatedTarget: document.body });
    expect(tip()).toBeNull();
  });

  it("hides the tip when the pointer leaves the button for anywhere else", async () => {
    const { user } = rail();
    const btn = screen.getByRole("button", { name: "Usage" });
    await user.hover(btn);
    fireEvent.mouseOut(btn, { relatedTarget: document.body });
    expect(tip()).toBeNull();
  });

  it("puts the tip on the page itself, outside the rail, so a screen over the rail can't cover it", async () => {
    const { user, container } = rail();
    await user.hover(screen.getByRole("button", { name: "Usage" }));
    expect(tip()?.parentElement).toBe(document.body);
    expect(container.querySelector(".rail-tip")).toBeNull();
  });

  it("gives each button its tip's line as its description", () => {
    rail({ updateWaiting: true });
    expect(screen.getByRole("button", { name: "Automations", description: "Tasks started by GitHub events" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Repository", description: "Git changes on the server" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings: an update is ready", description: "An update is ready" })).toBeTruthy();
    // A line the name already says isn't said twice.
    expect(screen.getByRole("button", { name: /^Connected/, description: "" })).toBeTruthy();
  });

  it("describes Settings as where Import lives", () => {
    rail();
    expect(screen.getByRole("button", { name: "Settings", description: "Import, backup and more" })).toBeTruthy();
  });

  it("puts the tip just past its button's edge, whatever the button's size", async () => {
    const { user } = rail();
    const btn = screen.getByRole("button", { name: "Usage" });
    btn.getBoundingClientRect = () => ({ top: 400, bottom: 428, left: 14, right: 42, height: 28, width: 28, x: 14, y: 400, toJSON() {} });
    await user.hover(btn);
    expect((tip() as HTMLElement).style.left).toBe("52px");
    expect((tip() as HTMLElement).style.top).toBe("414px");
  });

  it("hides the tip on Escape even when the focused element keeps its keys to itself", async () => {
    const { user } = rail();
    const box = document.createElement("textarea");
    box.addEventListener("keydown", (e) => e.stopPropagation());
    document.body.append(box);
    try {
      box.focus();
      await user.hover(screen.getByRole("button", { name: "Usage" }));
      expect(tip()).not.toBeNull();
      await user.keyboard("{Escape}");
      expect(tip()).toBeNull();
    } finally {
      box.remove();
    }
  });

  it("shows a line about a tool without a shortcut", async () => {
    const { user } = rail();
    await user.hover(screen.getByRole("button", { name: "Automations" }));
    expect(tip()?.textContent).toBe("AutomationsTasks started by GitHub events");
    expect(tip()?.querySelector("kbd")).toBeNull();
  });

  it("shows the tip on keyboard focus, and Escape hides it", async () => {
    const { user } = rail();
    await user.tab();
    expect(tip()?.textContent).toContain("Hide or show chats");
    await user.tab();
    expect(tip()?.textContent).toContain("New chat");
    await user.keyboard("{Escape}");
    expect(tip()).toBeNull();
  });

  it("keeps a tip that stays up in step with the button", async () => {
    const { user, rerender, props } = rail({ updateWaiting: false });
    await user.hover(screen.getByRole("button", { name: "Settings" }));
    expect(tip()?.textContent).toBe("SettingsCtrl+,Import, backup and more");
    rerender(<Rail {...props} updateWaiting />);
    expect(screen.getByRole("button", { name: "Settings: an update is ready" })).toBeTruthy();
    expect(tip()?.textContent).toBe("SettingsCtrl+,An update is ready");
  });

  it("puts the connection's full wording in its tip", async () => {
    const { user } = rail({ status: "offline", closedReason: "Server went away" });
    const conn = screen.getByRole("button", { name: /^Offline/ });
    await user.hover(conn);
    expect(tip()?.textContent).toContain("Server went away · Click to reconnect");
  });

  it("offers no reconnect while the first try at launch is connecting (ADR 0089)", async () => {
    const { user } = rail({ status: "connecting" });
    const conn = screen.getByRole("button", { name: /^Connecting…/ });
    await user.hover(conn);
    expect(tip()?.textContent).not.toContain("Click to reconnect");
  });

  it("drops the native title, so no second, slower tooltip shows", () => {
    const { container } = rail();
    expect(container.querySelectorAll(".rail [title]")).toHaveLength(0);
  });
});
