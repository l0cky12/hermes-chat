// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_PREFS_KEY, UI_PREFS_VERSION, getUIPrefs } from "../hermes/uiPrefs";
import { InboxSettings } from "./InboxSettings";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const field = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Days of inactivity before auto-dismiss" });
const store = (days: number | null) => localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: UI_PREFS_VERSION, inboxAutoDismissDays: days }));
const stored = () => JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? "{}").inboxAutoDismissDays;

describe("Rail inbox settings", () => {
  it("is empty, meaning Off, when nothing is saved", () => {
    render(<InboxSettings />);
    expect(field().value).toBe("");
    expect(field().placeholder).toBe("Off");
    expect(getUIPrefs().inboxAutoDismissDays).toBeNull();
  });

  it("shows a value saved earlier, even one the old buttons didn't offer", () => {
    store(14);
    render(<InboxSettings />);
    expect(field().value).toBe("14");
  });

  it("saves a typed number when the field is left, and not before", async () => {
    const user = userEvent.setup();
    store(7);
    render(<InboxSettings />);
    await user.clear(field());
    await user.type(field(), "3");
    expect(stored()).toBe(7);
    await user.tab();
    expect(stored()).toBe(3);
    expect(getUIPrefs().inboxAutoDismissDays).toBe(3);
  });

  it("saves on Enter", async () => {
    const user = userEvent.setup();
    render(<InboxSettings />);
    await user.type(field(), "5{Enter}");
    expect(getUIPrefs().inboxAutoDismissDays).toBe(5);
    expect(stored()).toBe(5);
  });

  it("does not save the digits passed on the way to a longer number", async () => {
    const user = userEvent.setup();
    store(7);
    render(<InboxSettings />);
    await user.clear(field());
    await user.type(field(), "14");
    expect(stored()).toBe(7);
    await user.tab();
    expect(stored()).toBe(14);
  });

  it("turns Off when the field is cleared or set to 0", async () => {
    const user = userEvent.setup();
    store(14);
    render(<InboxSettings />);
    await user.clear(field());
    await user.tab();
    expect(getUIPrefs().inboxAutoDismissDays).toBeNull();
    await user.type(field(), "9{Enter}");
    expect(getUIPrefs().inboxAutoDismissDays).toBe(9);
    await user.clear(field());
    await user.type(field(), "0{Enter}");
    expect(getUIPrefs().inboxAutoDismissDays).toBeNull();
    expect(field().value).toBe("");
  });

  it("writes a typed 007 back as 7", async () => {
    const user = userEvent.setup();
    render(<InboxSettings />);
    await user.type(field(), "007{Enter}");
    expect(field().value).toBe("7");
  });

  it.each(["366", "1.5", "-2", "abc"])("rejects %s, keeps what was saved and says so", async (typed) => {
    const user = userEvent.setup();
    store(14);
    render(<InboxSettings />);
    await user.clear(field());
    await user.type(field(), typed);
    await user.tab();
    expect(getUIPrefs().inboxAutoDismissDays).toBe(14);
    expect(stored()).toBe(14);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().value).toBe(typed);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Not saved: enter whole days from 1 to 365, or leave it empty for Off. Still 14 days.");
    expect(field().getAttribute("aria-describedby")).toContain(alert.id);
  });

  it("says Still off when a rejected value follows nothing saved", async () => {
    const user = userEvent.setup();
    render(<InboxSettings />);
    await user.type(field(), "400{Enter}");
    expect(screen.getByRole("alert").textContent).toMatch(/Still off\.$/);
  });

  it("clears the problem once a good value is saved", async () => {
    const user = userEvent.setup();
    render(<InboxSettings />);
    await user.type(field(), "400{Enter}");
    await user.clear(field());
    await user.type(field(), "30{Enter}");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(getUIPrefs().inboxAutoDismissDays).toBe(30);
  });

  it("saves a pending number when Settings closes without leaving the field", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<InboxSettings />);
    await user.type(field(), "21");
    expect(stored()).toBeUndefined();
    unmount();
    expect(getUIPrefs().inboxAutoDismissDays).toBe(21);
  });
});
