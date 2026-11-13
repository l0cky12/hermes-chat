// @vitest-environment jsdom
// Logs (Logs.tsx, ADR 0033, 0087): following and pausing a Hermes log, filters, an unreadable source, the support
// bundle, and opening it in Settings → Diagnostics against a fake Hermes whose `GET /api/logs` answers as `bf0203a` does.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { LogBuffer, note, type RemoteLog } from "../hermes/logs";
import { AttemptLog, type Attempt } from "../hermes/attempts";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { LogsPanel, type LogsWiring } from "./Logs";
import { SettingsScreen } from "./Settings";
import { appearanceStore } from "./appearance";
import type { CapabilityId, CapabilityStore } from "../hermes/capabilities";
import { useState } from "react";
import { RestError } from "../hermes/pipe";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

/** The profile's log files, as Hermes would read their tails. */
function logs() {
  const files: Record<string, string[]> = { agent: [], errors: [], gateway: [], mcp: [] };
  const write = (file: string, ...lines: string[]) => files[file].push(...lines.map((l) => l + "\n"));
  const read = vi.fn(async (file: RemoteLog, lines: number) => ({ file, lines: files[file].slice(-Math.min(lines, 500)) }));
  return { files, write, read };
}

function screenWith(l = logs(), more: Partial<Parameters<typeof LogsPanel>[0]> = {}) {
  const save = vi.fn(async (_text: string, _name: string) => "/home/me/hermes-logs.txt" as string | null);
  const app = new LogBuffer(100);
  const props = { profile: "default", connected: true, connection: "SSH tunnel", read: l.read, save, app, pollMs: 30, ...more };
  const r = render(<LogsPanel {...props} />);
  return { ...l, save, app, props, ...r };
}

const rows = () => [...screen.getByRole("log").querySelectorAll(".log-text")].map((e) => e.textContent);

describe("Logs screen", () => {
  it("follows the agent log, keeps the reading place while paused, and follows new lines again", async () => {
    const t = screenWith();
    t.write("agent", "2026-11-04 10:00:00,000 INFO agent: one", "2026-11-04 10:00:00,001 INFO agent: two");
    await waitFor(() => expect(rows()).toEqual(["2026-11-04 10:00:00,000 INFO agent: one", "2026-11-04 10:00:00,001 INFO agent: two"]));
    expect(t.read).toHaveBeenCalledWith("agent", 500);

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    t.write("agent", "2026-11-04 10:00:01,000 WARNING agent: three");
    await waitFor(() => expect(screen.getByRole("button", { name: "Follow (1 new)" })).toBeTruthy());
    expect(rows()).toHaveLength(2);
    expect(screen.getByText(/Paused: the lines stay where they are/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Follow (1 new)" }));
    expect(rows().at(-1)).toBe("2026-11-04 10:00:01,000 WARNING agent: three");
  });

  it("pauses when the owner scrolls up or clicks in the list", async () => {
    const t = screenWith();
    t.write("agent", "2026-11-04 10:00:00,000 INFO agent: one");
    await waitFor(() => expect(rows()).toHaveLength(1));
    const list = screen.getByRole("log");
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Follow" })).toBeTruthy());
  });

  it("filters by level and text, and shows lines as plain text", async () => {
    const t = screenWith();
    t.write(
      "agent",
      "2026-11-04 10:00:00,000 INFO agent: started <img src=x onerror=alert(1)>",
      "2026-11-04 10:00:01,000 ERROR tools.web: request failed",
      "Traceback (most recent call last):",
      "2026-11-04 10:00:02,000 WARNING gateway: slow",
    );
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(screen.getByRole("log").querySelector("img")).toBeNull();
    expect(rows()[0]).toContain("<img src=x onerror=alert(1)>");

    await userEvent.selectOptions(screen.getByLabelText("Level"), "ERROR");
    expect(rows()).toEqual(["2026-11-04 10:00:01,000 ERROR tools.web: request failed", "Traceback (most recent call last):"]);
    await userEvent.selectOptions(screen.getByLabelText("Level"), "");
    await userEvent.type(screen.getByLabelText("Containing"), "GATEWAY");
    await waitFor(() => expect(rows()).toEqual(["2026-11-04 10:00:02,000 WARNING gateway: slow"]));
    expect(screen.getByText(/4 lines kept, 1 shown/)).toBeTruthy();
  });

  it("says when this Hermes can't give a log, and stops asking", async () => {
    const l = logs();
    l.read.mockRejectedValue(new RestError(404, `{"detail":"Not Found"}`));
    screenWith(l);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/This Hermes has no \/api\/logs route/));
    const calls = l.read.mock.calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(l.read.mock.calls.length).toBe(calls);
  });

  it("says why a read failed, and notes the gap once reading works again", async () => {
    const l = logs();
    l.write("agent", "2026-11-04 10:00:00,000 INFO agent: before");
    const t = screenWith(l);
    await waitFor(() => expect(rows()).toHaveLength(1));
    t.rerender(<LogsPanel {...t.props} connected={false} />);
    expect(screen.getByText(/Not connected to Hermes\. Reading starts again/)).toBeTruthy();
    l.write("agent", "2026-11-04 10:00:05,000 INFO agent: during");
    t.rerender(<LogsPanel {...t.props} connected />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows()[1]).toMatch(/^Not read from .*: the connection to Hermes was lost$/);
    expect(rows()[2]).toBe("2026-11-04 10:00:05,000 INFO agent: during");

    l.read.mockRejectedValue(new RestError(500, `{"detail":"[Errno 13] Permission denied: 'agent.log'"}`));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Couldn't read the Hermes agent log: \[Errno 13\] Permission denied/));
  });

  it("shows this app's diagnostics, and a support bundle that says what it holds and what was redacted", async () => {
    const l = logs();
    l.write("agent", "2026-11-04 10:00:00,000 INFO agent: key sk-proj-AbCdEfGhIjKlMnOpQrStUv loaded");
    const t = screenWith(l);
    note("WARNING", "Connection to ssh://me@box: Offline (Cookie: session=abc123)", t.app);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "app");
    await waitFor(() => expect(rows()).toEqual(["Connection to ssh://me@box: Offline (Cookie: [redacted]"]));

    await userEvent.click(screen.getByRole("button", { name: /Support bundle/ }));
    const dialog = screen.getByRole("dialog", { name: "Support bundle" });
    expect(within(dialog).getByLabelText(/This app: 1 line/)).toBeTruthy();
    expect(within(dialog).getByLabelText(/Hermes agent \(agent\.log\): 1 line/)).toBeTruthy();
    expect(dialog.textContent).toMatch(/Redacted: 1 cookie, 1 provider key\./);
    expect(dialog.textContent).toMatch(/can still be there: read the file before sharing it/);
    const preview = within(dialog).getByLabelText("The file's text").textContent!;
    expect(preview).not.toMatch(/abc123|AbCdEfGhIjKlMnOpQrStUv/);

    await userEvent.click(within(dialog).getByLabelText(/This app/));
    expect(within(dialog).getByLabelText("The file's text").textContent).not.toContain("===== This app =====");
    await userEvent.click(within(dialog).getByRole("button", { name: /Save/ }));
    expect(t.save).toHaveBeenCalledTimes(1);
    const [text, name] = t.save.mock.calls[0];
    expect(name).toMatch(/^hermes-chat-support-\d{8}-\d{6}\.txt$/);
    expect(text).toContain("===== Hermes agent (agent.log) =====");
    expect(text).toContain("key [redacted key] loaded");
    expect(text).not.toContain("AbCdEfGhIjKlMnOpQrStUv");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows the connection attempts kept on disk, read when Logs opens, and puts them in the bundle when ticked", async () => {
    // What an earlier launch left: an attempt the app was closed during, then one that failed at sign-in.
    const run = "00000000-0000-4000-8000-0000000000aa";
    const file: Attempt[] = [
      { v: 1, id: "00000000-0000-4000-8000-000000000001", run, at: 1, outcome: "unfinished", routes: [{ id: "k3x9q2ab", kind: "lan", steps: [{ step: "keyring", ms: 3 }, { step: "resolve", ms: 11 }, { step: "status" }] }] },
      { v: 1, id: "00000000-0000-4000-8000-000000000002", run, at: 2, ms: 900, outcome: "failed", routes: [{ id: "main", kind: "ssh", steps: [{ step: "keyring", ms: 2 }, { step: "tunnel", ms: 300 }, { step: "status", ms: 90 }, { step: "sign-in", ms: 500 }], error: "Wrong username or password." }] },
    ];
    const read = vi.fn(async () => ({ attempts: file, unreadable: 0 }));
    const attempts = new AttemptLog({ read, put: async () => {} });
    screenWith(logs(), { attempts, connected: false });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "attempts");
    await waitFor(() =>
      expect(rows()).toEqual([
        "Didn't finish: Hermes Chat was closed while it was connecting, at status. LAN route k3x9q2ab: keyring 3 ms, resolve 11 ms, status.",
        "Failed after 900 ms. SSH route main: keyring 2 ms, tunnel 300 ms, status 90 ms, sign-in 500 ms; stopped at sign-in: Wrong username or password.",
      ]),
    );
    expect(screen.getByText(/kept on this computer between launches/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Support bundle/ }));
    const dialog = screen.getByRole("dialog", { name: "Support bundle" });
    const box = within(dialog).getByLabelText(/Connection attempts: 2 lines/);
    expect(within(dialog).getByLabelText("The file's text").textContent).toContain("===== Connection attempts =====");
    await userEvent.click(box);
    expect(within(dialog).getByLabelText("The file's text").textContent).not.toContain("===== Connection attempts =====");
    await userEvent.click(box);
    await userEvent.click(within(dialog).getByRole("button", { name: /Save/ }));
  });

  it("keeps the bundle to the moment it opened, while lines keep coming", async () => {
    const t = screenWith();
    t.write("agent", "2026-11-04 10:00:00,000 INFO agent: one");
    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: /Support bundle/ }));
    const dialog = screen.getByRole("dialog", { name: "Support bundle" });
    t.write("agent", "2026-11-04 10:00:01,000 INFO agent: two api_key=k2");
    await waitFor(() => expect(t.read.mock.calls.length).toBeGreaterThan(3));
    await new Promise((r) => setTimeout(r, 150));
    expect(within(dialog).getByLabelText(/Hermes agent \(agent\.log\): 1 line/)).toBeTruthy();
    expect(dialog.textContent).toMatch(/Redacted: nothing recognized as a secret\./);
    await userEvent.click(within(dialog).getByRole("button", { name: /Save/ }));
    const [text] = t.save.mock.calls[0];
    expect(text).toContain("agent: one");
    expect(text).not.toContain("agent: two");
    expect(text).toContain(within(dialog).getByLabelText("The file's text").textContent!.split("\n")[6]);
  });

  it("exports what's shown", async () => {
    const t = screenWith();
    t.write("agent", "2026-11-04 10:00:00,000 INFO agent: a", "2026-11-04 10:00:00,000 ERROR agent: b");
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.selectOptions(screen.getByLabelText("Level"), "ERROR");
    await userEvent.click(screen.getByRole("button", { name: /Export shown/ }));
    const [text, name] = t.save.mock.calls[0];
    expect(name).toMatch(/^hermes-agent-log-/);
    expect(text).toMatch(/Shown: ERROR and above\./);
    expect(text).toMatch(/\] 2026-11-04 10:00:00,000 ERROR agent: b\n$/);
    expect(text).not.toContain("INFO agent: a");
    expect(screen.getByText("Saved to /home/me/hermes-logs.txt.")).toBeTruthy();
  });
});

describe("Logs in Settings → Diagnostics", () => {
  it("is a group of Diagnostics, not a rail button, and reads the shown profile's agent log only while it's shown", { timeout: 15_000 }, async () => {
    const s = new FakeHermes();
    s.rest["GET /api/logs"] = (req) => ({ file: req.query.get("file"), lines: [`2026-11-04 10:00:00,000 INFO agent: hello from ${req.query.get("profile")}\n`] });
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    await act(async () => void (await hermes.idle()));
    expect(screen.queryByRole("button", { name: "Logs" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: /Diagnostics/ }));
    // Server and Logs are Diagnostics' sections, under it in the sidebar's tree (ADR 0160).
    const groups = screen.getByRole("group", { name: "Diagnostics: sections" });
    // Server comes first, as Diagnostics opened before Logs moved here; Hermes's logs aren't read until Logs is picked.
    expect(within(groups).getAllByRole("button").map((b) => b.textContent)).toEqual(["Server", "Logs"]);
    expect(within(groups).getByRole("button", { name: "Server" }).getAttribute("aria-current")).toBe("page");
    expect(s.restRequests.some((r) => r.path === "/api/logs")).toBe(false);

    await user.click(within(groups).getByRole("button", { name: "Logs" }));
    expect(screen.getByRole("region", { name: "Logs" })).toBeTruthy();
    await waitFor(() => expect(rows()).toEqual(["2026-11-04 10:00:00,000 INFO agent: hello from default"]));
    const asked = s.restRequests.find((r) => r.path === "/api/logs")!;
    expect(Object.fromEntries(asked.query)).toEqual({ file: "agent", lines: "500", profile: "default" });

    await user.click(within(groups).getByRole("button", { name: "Server" }));
    expect(screen.queryByRole("region", { name: "Logs" })).toBeNull();
    await user.click(within(screen.getByRole("group", { name: "Diagnostics: sections" })).getByRole("button", { name: "Logs" }));
    expect(screen.getByRole("region", { name: "Logs" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    expect(screen.queryByRole("region", { name: "Logs" })).toBeNull();
  });

  it("is named by a search for its words, which opens Diagnostics", { timeout: 20_000 }, async () => {
    const s = new FakeHermes();
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
    await waitFor(() => expect(hermes.hasListed()).toBe(true));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("searchbox", { name: "Search settings" }));
    await user.paste("support bundle");
    await user.click(await screen.findByRole("button", { name: "Open Diagnostics" }));
    expect(screen.getByRole("tab", { name: /Diagnostics/, selected: true })).toBeTruthy();
  });
});

/** Settings alone, as App shows it, with Logs reading `read` every 30 ms; Back to chat closes it. */
function SettingsWith({
  hermes,
  profile = "default",
  logs,
  capabilities = hermes.capabilities,
  showDiagnostics,
}: {
  hermes: Hermes;
  profile?: string;
  logs?: LogsWiring;
  capabilities?: CapabilityStore | null;
  showDiagnostics?: { id?: CapabilityId };
}) {
  const [appearance] = useState(() => appearanceStore({ getItem: () => null, setItem: () => {} }, document.createElement("html")));
  const [open, setOpen] = useState(true);
  if (!open) return <p>chat</p>;
  return (
    <SettingsScreen
      status="connected"
      route={{ kind: "ssh", target: "liam@hermes" }}
      unsecure={false}
      username="liam"
      passwordSaved
      profile={profile}
      olderPulled={false}
      cacheBytes={() => 0}
      appearance={appearance}
      listFonts={async () => ({ all: [], mono: [] })}
      modelSettings={hermes.modelSettings}
      capabilities={capabilities ?? undefined}
      showDiagnostics={showDiagnostics}
      logs={logs}
      onClearCache={() => {}}
      onPullOlder={async () => []}
      onSignOut={async () => {}}
      onClose={() => setOpen(false)}
    />
  );
}

describe("Settings → Diagnostics, Server and Logs", () => {
  async function hermesFor() {
    const hermes = await connect(new FakeHermes().openPipe, "default");
    running.push(hermes);
    return hermes;
  }
  const wiring = (read: LogsWiring["read"]): LogsWiring => ({ connection: "SSH tunnel", read, save: async () => null, pollMs: 30 });
  const answering = (profile: string) => vi.fn(async (file: RemoteLog) => ({ file, lines: [`2026-11-04 10:00:00,000 INFO agent: from ${profile}\n`] }));
  const groups = () => screen.getByRole("group", { name: "Diagnostics: sections" });
  /** The section shown, as the tree marks it; the page header's title names it too. */
  const current = () => {
    const name = within(groups()).getAllByRole("button").find((b) => b.getAttribute("aria-current") === "page")?.textContent;
    expect(document.querySelector("header.page-head .page-title")!.textContent).toBe(name);
    return name;
  };
  /** No read starts in a few poll intervals. */
  const stillAt = async (read: ReturnType<typeof vi.fn>) => {
    const n = read.mock.calls.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(read.mock.calls.length).toBe(n);
  };

  it("reads Hermes only while Logs is shown: leaving the group, the tab or Settings stops it", { timeout: 20_000 }, async () => {
    const hermes = await hermesFor();
    const read = answering("default");
    render(<SettingsWith hermes={hermes} logs={wiring(read)} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Diagnostics/ }));
    expect(current()).toBe("Server");
    await stillAt(read);
    expect(read).not.toHaveBeenCalled();

    await user.click(within(groups()).getByRole("button", { name: "Logs" }));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1));
    await user.click(within(groups()).getByRole("button", { name: "Server" }));
    await stillAt(read);

    await user.click(within(groups()).getByRole("button", { name: "Logs" }));
    const before = read.mock.calls.length;
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before + 1));
    await user.click(screen.getByRole("tab", { name: /General/ }));
    await stillAt(read);

    // The tab keeps the group shown last.
    await user.click(screen.getByRole("tab", { name: /Diagnostics/ }));
    expect(current()).toBe("Logs");
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    expect(screen.getByText("chat")).toBeTruthy();
    await stillAt(read);
  });

  it("opens at Server from General's Connection diagnostics and from a capability note, whatever group was shown", { timeout: 20_000 }, async () => {
    const hermes = await hermesFor();
    const logs = wiring(answering("default"));
    const { rerender } = render(<SettingsWith hermes={hermes} logs={logs} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Diagnostics/ }));
    await user.click(within(groups()).getByRole("button", { name: "Logs" }));
    await user.click(screen.getByRole("tab", { name: /General/ }));
    await user.click(screen.getByRole("button", { name: "Connection diagnostics" }));
    expect(screen.getByRole("tab", { name: /Diagnostics/, selected: true })).toBeTruthy();
    expect(current()).toBe("Server");
    expect(screen.queryByRole("region", { name: "Logs" })).toBeNull();

    await user.click(within(groups()).getByRole("button", { name: "Logs" }));
    rerender(<SettingsWith hermes={hermes} logs={logs} showDiagnostics={{ id: "memory" }} />);
    await waitFor(() => expect(current()).toBe("Server"));
    expect(screen.queryByRole("region", { name: "Logs" })).toBeNull();
  });

  it("starts afresh for another profile, and drops an answer the old profile's read was still waiting for", { timeout: 20_000 }, async () => {
    const hermes = await hermesFor();
    let late: (v: unknown) => void = () => {};
    let first = true;
    const fromDefault = vi.fn(async (file: RemoteLog) => {
      if (first) return (first = false), { file, lines: ["2026-11-04 10:00:00,000 INFO agent: from default\n"] };
      return new Promise((r) => (late = r));
    });
    const { rerender } = render(<SettingsWith hermes={hermes} logs={wiring(fromDefault)} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Diagnostics/ }));
    await user.click(within(groups()).getByRole("button", { name: "Logs" }));
    await waitFor(() => expect(rows()).toEqual(["2026-11-04 10:00:00,000 INFO agent: from default"]));
    await waitFor(() => expect(fromDefault).toHaveBeenCalledTimes(2));

    const fromWork = answering("work");
    rerender(<SettingsWith hermes={hermes} profile="work" logs={wiring(fromWork)} />);
    await waitFor(() => expect(rows()).toEqual(["2026-11-04 10:00:00,000 INFO agent: from work"]));
    act(() => late({ file: "agent", lines: ["2026-11-04 10:00:00,000 INFO agent: from default\n", "2026-11-04 10:00:01,000 INFO agent: late from default\n"] }));
    await stillAt(fromDefault);
    expect(rows()).toEqual(["2026-11-04 10:00:00,000 INFO agent: from work"]);
  });

  it("has no sections in the tree with only one group, and no Diagnostics tab with neither", async () => {
    const hermes = await hermesFor();
    const { rerender } = render(<SettingsWith hermes={hermes} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Diagnostics/ }));
    expect(screen.queryByRole("group", { name: "Diagnostics: sections" })).toBeNull();
    expect(screen.getByRole("region", { name: "Server" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Logs" })).toBeNull();

    rerender(<SettingsWith hermes={hermes} capabilities={null} logs={wiring(answering("default"))} />);
    expect(screen.queryByRole("group", { name: "Diagnostics: sections" })).toBeNull();
    expect(screen.getByRole("region", { name: "Logs" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Server" })).toBeNull();

    rerender(<SettingsWith hermes={hermes} capabilities={null} />);
    expect(screen.queryByRole("tab", { name: /Diagnostics/ })).toBeNull();
  });
});
