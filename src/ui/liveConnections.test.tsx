// @vitest-environment jsdom
// Several live connections in the whole App (ADR 0125, issue #99). Three FakeHermes servers use the same profile name,
// the same chat id and the same Approval request id, so nothing can be told apart by those alone. The Rust side routes
// each command by the attempt that opened its connection, as `Slots` does, and refuses past the owner's limit.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import type { Pipe, PipeEvent } from "../hermes/pipe";
import { connectionRefs, formatChatLink } from "../hermes/chatLinks";
import { linkInbox } from "../hermes/tauriLinks";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
/** Rust's events by name, so the test can pick the tray's Open Inbox. */
const events = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, fn: (e: { payload: unknown }) => void) => (events.set(event, fn), () => {}),
}));

const ALPHA = "https://alpha.example.com";
const BRAVO = "https://bravo.example.com";
const CHARLIE = "https://charlie.example.com";
const servers: Record<string, FakeHermes> = { [ALPHA]: new FakeHermes(), [BRAVO]: new FakeHermes(), [CHARLIE]: new FakeHermes() };
const passwords: Record<string, string> = { [ALPHA]: "alpha-pass", [BRAVO]: "bravo-pass", [CHARLIE]: "charlie-pass" };
const keyring = new Map<string, string>();
/** Every sign-in Rust was asked for: where to, with which password, under which saved connection. */
const connects: { url: string; password: string; saved: string }[] = [];
/** The connections Rust holds, by the attempt that opened each. */
const held = new Map<string, { url: string; saved: string; pipe: Pipe }>();
const notices: { title: string; body: string; tag?: string; deny?: boolean }[] = [];
/** A sign-in that waits until the test lets it go, by URL. */
const held_back: Record<string, Promise<void>> = {};
/** What the tray was told needs the owner, in order. */
const trayCounts: number[] = [];

const holding = (attempt: unknown) => {
  const h = held.get(attempt as string);
  if (!h) throw "The connection is closed.";
  return h.pipe;
};

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (e: PipeEvent) => void;
  },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    const slot = `${cmd.split("_")[0]}:${(args.connection as string | null) ?? "legacy"}`;
    switch (cmd) {
      case "hermes_connect": {
        const url = (args.target as { url: string }).url;
        const saved = args.savedConnection as string;
        const { password } = args.credential as { password: string };
        await held_back[url];
        const limit = (args.liveLimit as number | null) ?? 1;
        // src-tauri live.rs `Slots::evict_for`.
        const others = [...held.entries()].filter(([, h]) => h.saved !== saved);
        if (limit > 1 && others.length >= limit) throw `Hermes Chat already has ${limit} connections open, the most it keeps open. Disconnect one first.`;
        for (const [a, h] of held) if (limit <= 1 || h.saved === saved) (held.delete(a), h.pipe.close());
        connects.push({ url, password, saved });
        if (passwords[url] !== password) throw "Wrong username or password.";
        const channel = args.onEvent as { onmessage: (e: PipeEvent) => void };
        const pipe = await servers[url].openPipe((e) => channel.onmessage(e), args.profile as string);
        held.set(args.attempt as string, { url, saved, pipe });
        return { kind: "url", url, addresses: [] };
      }
      case "hermes_probe": {
        const url = (args.target as { url: string }).url;
        if (passwords[url] !== (args.credential as { password: string }).password) throw { stage: "sign-in", message: "Wrong username or password." };
        return {
          route: { kind: "url", url, addresses: [] },
          status: '{"version":"0.22.5","auth_required":true,"auth_providers":["basic"]}',
          ready: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: servers[url].readyPayload } }),
        };
      }
      case "hermes_send":
        return holding(args.attempt).send(args.frame as string);
      case "hermes_request":
        return holding(args.attempt).request(args.method as "GET", args.path as string, args.body as string | undefined);
      case "hermes_disconnect": {
        const h = held.get(args.attempt as string);
        held.delete(args.attempt as string);
        return h?.pipe.close();
      }
      case "tray_inbox":
        return void trayCounts.push(args.count as number);
      case "notify_desktop":
        return void notices.push(args as (typeof notices)[number]);
      case "password_load":
      case "headers_load":
        return keyring.get(slot) ?? null;
      case "password_save":
        return void keyring.set(slot, args.password as string);
      case "headers_save":
        return void keyring.set(slot, args.headers as string);
      case "password_delete":
      case "headers_delete":
        return void keyring.delete(slot);
      default:
        return undefined;
    }
  },
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  localStorage.setItem("hermes-chat.sign-in", JSON.stringify({ mode: "url", sshTarget: "", url: ALPHA, username: "owner" }));
  keyring.set("password:legacy", "alpha-pass");
  // The same profile, the same chat id and title, on every server.
  for (const url of [ALPHA, BRAVO, CHARLIE]) {
    servers[url].sessions = [row("c1", 1, { pinned: true, title: "Deploy" })];
    servers[url].transcripts = { c1: [{ role: "user", text: `Deploy on ${new URL(url).host.split(".")[0]}` }] };
  }
});
afterEach(cleanup);

const composer = () => screen.getAllByRole("textbox").find((e) => e.closest(".composer")) as HTMLTextAreaElement;
const openRail = async () => userEvent.click(await screen.findByRole("button", { name: /Switch connection/ }));
const sent = (url: string, method: string) => servers[url].requests.filter((r) => r.method === method);
const liveIds = () => JSON.parse(localStorage.getItem("hermes-chat.connections")!).live as string[];
const heldUrls = () => [...held.values()].map((h) => h.url).sort();

async function addServer(name: string, url: string) {
  await openRail();
  await userEvent.click(screen.getByRole("button", { name: "Add connection" }));
  await userEvent.type(screen.getByLabelText("Name"), name);
  await userEvent.selectOptions(screen.getByLabelText("Connect through"), "web");
  await userEvent.type(screen.getByLabelText(/^Dashboard URL/), url);
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.type(await screen.findByLabelText("Dashboard username"), "owner");
  await userEvent.type(screen.getByLabelText(/^Dashboard password/), passwords[url]);
  await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await userEvent.click(await screen.findByRole("button", { name: "Save and connect" }));
  await userEvent.click(await screen.findByRole("button", { name: "Skip" }));
}

describe("Live connections", () => {
  it("keeps two servers with colliding ids live and apart, answers each on its own socket, and disconnects one without touching the other", async () => {
    const { default: App } = await import("../App");
    render(<App />);
    expect(await screen.findByText("Deploy", {}, { timeout: 15_000 })).toBeTruthy();
    // Alpha holds its chat, so its Approvals reach it once it is in the background.
    await userEvent.click(screen.getByText("Deploy"));
    await waitFor(() => expect(servers[ALPHA].runtimeIdOf("c1")).toBeTruthy());
    await userEvent.type(composer(), "draft for alpha");

    // Adding Home makes it the target. Alpha stays live in the background: nothing closed it.
    await addServer("Home", BRAVO);
    await waitFor(() => expect(heldUrls()).toEqual([ALPHA, BRAVO]));
    expect(connects.map((c) => [c.url, c.password])).toEqual([
      [ALPHA, "alpha-pass"],
      [BRAVO, "bravo-pass"],
    ]);
    // Every chat names its server and profile now that two are live.
    await userEvent.click(await screen.findByText("Deploy"));
    await waitFor(() => expect(servers[BRAVO].runtimeIdOf("c1")).toBeTruthy());
    expect(await screen.findByText("Home · default")).toBeTruthy();

    // An Approval on alpha's chat, with the same chat id and request id bravo would use. It lands in alpha only.
    act(() => void servers[ALPHA].askApproval(servers[ALPHA].runtimeIdOf("c1")!));
    await waitFor(() => expect(notices.some((n) => n.title.startsWith("alpha.example.com: "))).toBe(true));
    expect(screen.queryByText(/rm -rf/)).toBeNull();
    // Bravo, the target, streams meanwhile: its send reaches bravo and nothing of it reaches alpha.
    await userEvent.type(composer(), "hello bravo{Enter}");
    await waitFor(() => expect(sent(BRAVO, "prompt.submit").length).toBe(1));
    expect(sent(ALPHA, "prompt.submit")).toEqual([]);

    // The inbox lists alpha's Approval with its server. Opening it makes alpha the target without signing in again.
    const rail = screen.getByRole("button", { name: /Switch connection/ });
    expect(rail.getAttribute("aria-label")).toMatch(/1 more live, 1 waiting for you/);
    await waitFor(() => expect(trayCounts.at(-1)).toBe(1));
    act(() => events.get("tray-open-inbox")?.({ payload: null }));
    const entry = await screen.findByRole("button", { name: /Deploy, in default on alpha\.example\.com/ });
    await userEvent.click(entry);
    expect(await screen.findByText(/rm -rf/)).toBeTruthy();
    expect(connects.length).toBe(2);
    await waitFor(() => expect(composer().value).toBe("draft for alpha"));

    // The answer goes on alpha's socket. Bravo, with the same ids, hears nothing of it.
    await userEvent.click(await screen.findByRole("button", { name: "Approve once" }));
    await waitFor(() => expect(servers[ALPHA].approvalAnswers).toHaveLength(1));
    expect(servers[BRAVO].approvalAnswers).toEqual([]);
    expect(heldUrls()).toEqual([ALPHA, BRAVO]);

    // Each server only ever got its own password.
    for (const c of connects) expect(c.password).toBe(passwords[c.url]);

    // An Approval on Home, now in the background, comes as a notification. Clicking it makes Home the target and shows
    // its card, answering nothing (ADR 0173).
    let homeCard = "";
    act(() => void (homeCard = servers[BRAVO].askApproval(servers[BRAVO].runtimeIdOf("c1")!, { command: "rm -rf /srv/home-cache" }).id!));
    await waitFor(() => expect(notices.some((n) => n.title === "Home: Hermes is asking for approval")).toBe(true));
    const homeNotice = notices.find((n) => n.title === "Home: Hermes is asking for approval")!;
    expect(homeNotice).toMatchObject({ deny: true, tag: expect.any(String) });
    act(() => events.get("notification-action")?.({ payload: { tag: homeNotice.tag, action: "open" } }));
    expect(await screen.findByText("Home · default")).toBeTruthy();
    expect(await screen.findByText("rm -rf /srv/home-cache")).toBeTruthy();
    // Focus is on the card itself, as the entry's own click puts it, not in the composer.
    await waitFor(() => expect(document.activeElement?.getAttribute("data-item")).toBe(homeCard));
    expect(document.activeElement?.classList.contains("approval")).toBe(true);
    expect(connects.length).toBe(2);
    expect(servers[BRAVO].approvalAnswers).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(servers[BRAVO].approvalAnswers.map((a) => a.choice)).toEqual(["deny"]));
    await openRail();
    await userEvent.click(within(screen.getByRole("dialog", { name: "Switch connection" })).getByText("alpha.example.com"));
    expect(await screen.findByText("alpha.example.com · default")).toBeTruthy();

    // Bravo is the background one now. Disconnecting it from Settings closes it alone: alpha's chat and draft stay.
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect Home" }));
    // Bravo's reply is still running, so Disconnect asks first, and Stay keeps it open.
    const ask = await screen.findByRole("alertdialog", { name: "Disconnect Home?" });
    expect(within(ask).getByText("A reply is running.")).toBeTruthy();
    await userEvent.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(heldUrls()).toEqual([ALPHA, BRAVO]);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect Home" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Disconnect Home?" })).getByRole("button", { name: "Disconnect anyway" }));
    await waitFor(() => expect(heldUrls()).toEqual([ALPHA]));
    await userEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    await waitFor(() => expect(composer().value).toBe("draft for alpha"));
    expect(screen.queryByText("Home · default")).toBeNull();

    // Connect brings it back in the background, with its saved password; alpha is still the target.
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Connect to Home" }));
    await waitFor(() => expect(heldUrls()).toEqual([ALPHA, BRAVO]));
    expect(connects.at(-1)).toMatchObject({ url: BRAVO, password: "bravo-pass" });
    expect(await screen.findByRole("button", { name: "Use Home" })).toBeTruthy();

    // At a limit of 2, a third is refused before it opens, and nothing closes.
    await userEvent.selectOptions(screen.getByLabelText("Live at once"), "2");
    await userEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    await openRail();
    await userEvent.click(screen.getByRole("button", { name: "Add connection" }));
    await userEvent.type(screen.getByLabelText("Name"), "Lab");
    await userEvent.selectOptions(screen.getByLabelText("Connect through"), "web");
    await userEvent.type(screen.getByLabelText(/^Dashboard URL/), CHARLIE);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(await screen.findByLabelText("Dashboard username"), "owner");
    await userEvent.type(screen.getByLabelText(/^Dashboard password/), "charlie-pass");
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and connect" }));
    expect(await screen.findByText(/already has 2 connections open/)).toBeTruthy();
    expect(connects.some((c) => c.url === CHARLIE)).toBe(false);
    expect(heldUrls()).toEqual([ALPHA, BRAVO]);
    await userEvent.click(screen.getByRole("button", { name: "Cancel setup" }));

    // What launch opens again: the target first, then the background one.
    const ids = liveIds();
    expect(ids.length).toBe(2);
    expect(JSON.parse(localStorage.getItem("hermes-chat.connections")!).current).toBe(ids[0]);
  }, 90_000);

  it("opens the live set again after a restart: the target first, the background one with its saved password", async () => {
    vi.resetModules();
    for (const [a, h] of held) (held.delete(a), h.pipe.close());
    connects.length = 0;
    // A chat link for Home arrives with the launch, while Home is still opening again in the background.
    const doc = JSON.parse(localStorage.getItem("hermes-chat.connections")!);
    const home = doc.connections.find((c: { url: string }) => c.url === BRAVO);
    let letHomeIn!: () => void;
    held_back[BRAVO] = new Promise((r) => (letHomeIn = r));
    const links = linkInbox(async (arrive) => arrive(formatChatLink({ connection: connectionRefs(localStorage).refFor(home), profile: "default", chatId: "c1" })));
    const { default: App } = await import("../App");
    render(<App links={links} />);
    await waitFor(() => expect(heldUrls()).toEqual([ALPHA]), { timeout: 15_000 });
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    // The target doesn't turn the link away meanwhile: it waits for Home.
    expect(screen.queryByText(/This link is for/)).toBeNull();
    act(() => letHomeIn());
    await waitFor(() => expect(heldUrls()).toEqual([ALPHA, BRAVO]));
    expect(connects.map((c) => c.url)).toEqual([ALPHA, BRAVO]);
    expect(await screen.findByText("Home · default")).toBeTruthy();
    expect(await screen.findByText("Deploy on bravo")).toBeTruthy();

    // Back to alpha from the rail: a pointer change, nothing signs in again.
    await openRail();
    await userEvent.click(within(screen.getByRole("dialog", { name: "Switch connection" })).getByText("alpha.example.com"));
    expect(await screen.findByText("alpha.example.com · default")).toBeTruthy();
    expect(connects.length).toBe(2);

    // Lowered to 1 with two live, a connect is refused before anything closes: neither the target nor the background
    // one is replaced to make room.
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.selectOptions(await screen.findByLabelText("Live at once"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    await openRail();
    await userEvent.click(screen.getByRole("button", { name: "Add connection" }));
    await userEvent.type(screen.getByLabelText("Name"), "Lab");
    await userEvent.selectOptions(screen.getByLabelText("Connect through"), "web");
    await userEvent.type(screen.getByLabelText(/^Dashboard URL/), CHARLIE);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(await screen.findByLabelText("Dashboard username"), "owner");
    await userEvent.type(screen.getByLabelText(/^Dashboard password/), "charlie-pass");
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and connect" }));
    expect(await screen.findByText(/already has 1 connection open/)).toBeTruthy();
    expect(connects.map((c) => c.url)).toEqual([ALPHA, BRAVO]);
    expect(heldUrls()).toEqual([ALPHA, BRAVO]);
    await userEvent.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(await screen.findByText("alpha.example.com · default")).toBeTruthy();

    // Signing in to the background one again at that limit replaces only it: alpha, the target, stays open.
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit Home" }));
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    await userEvent.type(await screen.findByLabelText(/^Dashboard password/), "bravo-pass");
    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and connect" }));
    await userEvent.click(await screen.findByRole("button", { name: "Skip" }));
    await waitFor(() => expect(connects.at(-1)?.url).toBe(BRAVO));
    expect(heldUrls()).toEqual([ALPHA, BRAVO]);
    await openRail();
    await userEvent.click(within(screen.getByRole("dialog", { name: "Switch connection" })).getByText("alpha.example.com"));
    expect(await screen.findByText("alpha.example.com · default")).toBeTruthy();

    // Signing in to the target again at that limit replaces only it: Home stays open.
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit alpha.example.com" }));
    await userEvent.click(await screen.findByRole("button", { name: "Change connection" }));
    await userEvent.click(await screen.findByRole("button", { name: "Next" }));
    await userEvent.type(await screen.findByLabelText(/^Dashboard password/), "alpha-pass");
    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and connect" }));
    await userEvent.click(await screen.findByRole("button", { name: "Skip" }));
    await waitFor(() => expect(connects.at(-1)?.url).toBe(ALPHA));
    expect(heldUrls()).toEqual([ALPHA, BRAVO]);
    expect(liveIds().length).toBe(2);

    // Removing the background connection closes it alone, then forgets it.
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove Home" }));
    const ask = await screen.findByRole("alertdialog", { name: "Remove Home?" });
    await userEvent.click(within(ask).getByRole("button", { name: /Remove connection/ }));
    await waitFor(() => expect(heldUrls()).toEqual([ALPHA]));
    expect(liveIds().length).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    await waitFor(() => expect(composer()).toBeTruthy());
  }, 60_000);
});
