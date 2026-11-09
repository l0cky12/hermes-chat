// @vitest-environment jsdom
// Setup's Routes list and the sign-in screen's view of it (ADR 0056).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Onboarding } from "./Onboarding";
import { SignIn } from "./SignIn";
import type { Probe, Probed, ProbeFailure } from "../hermes/setup";
import type { Reached, SignInDetails } from "../hermes/tauriPipe";
import { withRoutes } from "../hermes/routes";

afterEach(cleanup);

const BLANK: SignInDetails = { mode: "ssh", sshTarget: "", url: "", username: "", password: "", headers: [] };
const READY = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } });
const STATUS = '{"version":"0.22.5","auth_required":true,"auth_providers":["basic"]}';
const at = (d: SignInDetails) => (d.mode === "ssh" ? d.sshTarget : d.url);

/** How each address behaves: reached (as which server), or failing as Rust says. */
type Behaviour = { server: string } | ProbeFailure;
function backend(routes: Record<string, Behaviour>, password = "hunter2") {
  const probed: SignInDetails[] = [];
  const reached: { at: string; expect?: string }[] = [];
  const answer = (d: SignInDetails): { server: string } => {
    const b = routes[at(d)] ?? { stage: "address", message: "Can't reach the Hermes dashboard: couldn't look up nowhere" };
    if ("stage" in b) throw b;
    if (d.server && d.server !== b.server)
      throw { stage: "reach", message: "Wrong server: a different Hermes server answered at this address than the one this connection signed in to before. Hermes Chat didn't send it the password." };
    return b;
  };
  const routeOf = (d: SignInDetails, server: string) =>
    d.mode === "ssh" ? { kind: "ssh" as const, target: d.sshTarget, server } : { kind: "url" as const, url: d.url, addresses: [], server };
  const probe: Probe = {
    run: async (d) => {
      probed.push(d);
      const { server } = answer(d);
      if (d.password !== password) throw { stage: "sign-in", message: "Wrong username or password.", status: STATUS };
      return { route: routeOf(d, server), status: STATUS, ready: READY } satisfies Probed;
    },
    cancel: () => {},
  };
  const reach = async (d: SignInDetails, expect?: string): Promise<Reached> => {
    reached.push({ at: at(d), expect });
    const { server } = answer({ ...d, server: expect });
    return { route: routeOf(d, server), status: STATUS };
  };
  return { probe, reach, probed, reached };
}

const route = (n: number) => within(screen.getAllByRole("listitem").filter((li) => li.classList.contains("route-row"))[n - 1]);

describe("Setup's Routes list", () => {
  it("adds, reorders, turns off and tests routes, then saves them in order with each one's headers", async () => {
    const user = userEvent.setup();
    const b = backend({
      "http://192.168.1.10:9119": { stage: "reach", message: "The dashboard didn't answer within 5s." },
      "http://100.101.102.103:9119": { server: "home" },
      "https://hermes.example.com": { stage: "reach", message: "Can't reach the Hermes dashboard: error sending request: Connection refused (os error 111)" },
      "liam@hermes": { server: "home" },
    });
    const onConnect = vi.fn(async (_d: SignInDetails, _name: string, _signal: AbortSignal) => ({}));
    render(<Onboarding mode="add" initial={BLANK} probe={b.probe} reach={b.reach} onConnect={onConnect} onCancel={() => {}} onDone={() => {}} />);

    // One route to start with, labelled as before routes.
    await user.type(screen.getByLabelText("SSH target"), "liam@hermes");
    await user.click(screen.getByRole("button", { name: "Add a route" }));
    await user.type(screen.getByLabelText("Route 2: Dashboard URL"), "100.101.102.103");
    await user.tab();
    // The address gets its scheme and the dashboard's port.
    expect((screen.getByLabelText("Route 2: Dashboard URL") as HTMLInputElement).value).toBe("http://100.101.102.103:9119");
    expect((screen.getByLabelText("Route 2 kind") as HTMLSelectElement).value).toBe("tailscale");

    await user.click(screen.getByRole("button", { name: "Add a route" }));
    await user.selectOptions(screen.getByLabelText("Route 3 kind"), "lan");
    await user.type(screen.getByLabelText("Route 3: Dashboard URL"), "192.168.1.10:9119");
    await user.click(screen.getByRole("button", { name: "Add a route" }));
    await user.selectOptions(screen.getByLabelText("Route 4 kind"), "web");
    await user.type(screen.getByLabelText("Route 4: Dashboard URL"), "https://hermes.example.com");
    await user.click(route(4).getByText(/Extra request headers/, { selector: "summary" }));
    await user.click(route(4).getByRole("button", { name: "Add header" }));
    await user.type(screen.getByLabelText("Header 1 name, route 4"), "CF-Access-Client-Secret");
    await user.type(screen.getByLabelText("Header 1 value, route 4"), "s3cret");

    // LAN, then Tailscale, then SSH. The web address is kept but turned off.
    await user.click(screen.getByRole("button", { name: "Move route 3 up" }));
    await user.click(screen.getByRole("button", { name: "Move route 2 up" }));
    await user.click(screen.getByRole("button", { name: "Move route 2 down" }));
    expect((screen.getByLabelText("Route 1 kind") as HTMLSelectElement).value).toBe("lan");
    await user.click(screen.getByRole("checkbox", { name: "Use route 4" }));
    expect(route(4).getByRole("checkbox").closest("li")?.className).toContain("off");

    // Each route's Test reaches it without the password, and says what happened.
    await user.click(screen.getByRole("button", { name: "Test route 1" }));
    expect((await route(1).findByRole("alert")).textContent?.trim()).toMatch(/^Timed out\./);
    await user.click(screen.getByRole("button", { name: "Test route 3" }));
    expect((await route(3).findByRole("status")).textContent).toContain("Reached Hermes 0.22.5.");
    await user.click(screen.getByRole("button", { name: "Test route 4" }));
    expect((await route(4).findByRole("alert")).textContent?.trim()).toMatch(/^Refused\./);
    expect(b.reached.map((r) => r.at)).toEqual(["http://192.168.1.10:9119", "liam@hermes", "https://hermes.example.com"]);
    expect(b.probed).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Over LAN, Tailscale, SSH and web address \(off\), tried in that order\./)).toBeTruthy();
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const result = await screen.findByText(/At least one route works/);
    const checks = result.closest(".setup-result")!.querySelectorAll(".route-checks li");
    expect([...checks].map((li) => li.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringMatching(/^LAN http:\/\/192.168.1.10:9119 · timed out/),
      expect.stringMatching(/^Tailscale http:\/\/100.101.102.103:9119 · reached Hermes 0.22.5/),
      expect.stringMatching(/^SSH ssh:\/\/liam@hermes · reached Hermes 0.22.5$/),
    ]);
    // A route turned off isn't tested.
    expect(b.probed.map(at)).toEqual(["http://192.168.1.10:9119", "http://100.101.102.103:9119", "liam@hermes"]);

    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    const [d] = onConnect.mock.calls[0];
    expect(d.routes?.map((r) => [r.kind, r.target, !!r.off])).toEqual([
      ["lan", "http://192.168.1.10:9119", false],
      ["tailscale", "http://100.101.102.103:9119", false],
      ["ssh", "liam@hermes", false],
      ["web", "https://hermes.example.com", true],
    ]);
    expect(d.routes?.[3].headers).toEqual([{ name: "CF-Access-Client-Secret", value: "s3cret" }]);
    expect([d.mode, d.url, d.password]).toEqual(["url", "http://192.168.1.10:9119", "hunter2"]);
  });

  it("says when a route reaches a different server, and trusts the new one only when the owner says so", async () => {
    const user = userEvent.setup();
    const b = backend({ "liam@hermes": { server: "reinstalled" } });
    const initial = { ...withRoutes(BLANK, [{ id: "s", kind: "ssh", target: "liam@hermes" }, { id: "l", kind: "lan", target: "http://192.168.1.10:9119" }]), username: "liam", server: "home" };
    const onConnect = vi.fn(async () => ({}));
    render(<Onboarding mode="edit" initial={initial} initialName="Home" probe={b.probe} reach={b.reach} onConnect={onConnect} onCancel={() => {}} onDone={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Test route 1" }));
    const wrong = await route(1).findByRole("alert");
    expect(wrong.textContent?.trim()).toMatch(/^Wrong server\. A different Hermes server answered at hermes, not the one this connection signed in to before\. It wasn't sent the password\./);
    expect(b.reached).toEqual([{ at: "liam@hermes", expect: "home" }]);

    await user.click(within(wrong).getByRole("button", { name: "Trust this server" }));
    await user.click(screen.getByRole("button", { name: "Test route 1" }));
    expect((await route(1).findByRole("status")).textContent).toContain("Reached Hermes");
    expect(b.reached[1]).toEqual({ at: "liam@hermes", expect: undefined });

    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/At least one route works/);
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    expect((onConnect.mock.calls[0] as unknown[])[0]).toMatchObject({ server: undefined });
  });

  it("keeps one route that its address alone says as a connection without a list, as before routes", async () => {
    const user = userEvent.setup();
    const b = backend({ "liam@hermes": { server: "home" } });
    const onConnect = vi.fn(async () => ({}));
    render(<Onboarding mode="add" initial={BLANK} probe={b.probe} reach={b.reach} onConnect={onConnect} onCancel={() => {}} onDone={() => {}} />);
    await user.type(screen.getByLabelText("SSH target"), "liam@hermes");
    // One route can't be turned off, moved or removed.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove route/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Dashboard username"), "liam");
    await user.type(screen.getByLabelText("Dashboard password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    // The test as it always was: the checklist of stages.
    expect((await screen.findByRole("status")).textContent).toContain("Connected to Hermes 0.22.5 at ssh://liam@hermes.");
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    const d = (onConnect.mock.calls[0] as unknown[])[0] as SignInDetails;
    expect(d.routes).toBeUndefined();
    expect([d.mode, d.sshTarget]).toEqual(["ssh", "liam@hermes"]);
  });

  it("refuses an address with a token in it, and says why", async () => {
    const user = userEvent.setup();
    const b = backend({});
    render(<Onboarding mode="add" initial={BLANK} probe={b.probe} reach={b.reach} onConnect={vi.fn()} onCancel={() => {}} onDone={() => {}} />);
    await user.selectOptions(screen.getByLabelText("Connect through"), "web");
    await user.type(screen.getByLabelText("Dashboard URL"), "https://token@hermes.example.com/");
    expect(screen.getByLabelText("Dashboard URL").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/can't hold a user name, password or token/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears a route's saved header values once its address changes", async () => {
    const user = userEvent.setup();
    const b = backend({});
    const web = { id: "w", kind: "web" as const, target: "https://hermes.example.com", headers: [{ name: "CF-Access-Client-Secret", value: "s3cret" }] };
    const initial = { ...withRoutes(BLANK, [{ id: "s", kind: "ssh", target: "liam@hermes" }, web]), username: "liam" };
    render(<Onboarding mode="edit" initial={initial} probe={b.probe} reach={b.reach} onConnect={async () => ({})} onCancel={() => {}} onDone={() => {}} />);
    expect((screen.getByLabelText("Header 1 value, route 2") as HTMLInputElement).value).toBe("s3cret");
    await user.type(screen.getByLabelText("Route 2: Dashboard URL"), "/other");
    expect((screen.getByLabelText("Header 1 value, route 2") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Header 1 name, route 2") as HTMLInputElement).value).toBe("CF-Access-Client-Secret");
    expect(screen.getByText(/The address changed, so the saved header values were cleared/)).toBeTruthy();
  });
});

describe("The sign-in screen", () => {
  it("shows a connection's routes in order, and sends the typed password to all of them", async () => {
    const user = userEvent.setup();
    const routes = [
      { id: "l", kind: "lan" as const, target: "http://192.168.1.10:9119" },
      { id: "t", kind: "tailscale" as const, target: "http://100.101.102.103:9119", locked: true },
      { id: "s", kind: "ssh" as const, target: "liam@hermes", off: true },
    ];
    const initial = { ...withRoutes(BLANK, routes), username: "liam" };
    const connection = { id: "0d6f3c8e-1111-4a8a-9d2b-1f0e7c9a5b3d", name: "Home server", addedAt: 0, ...initial, routes };
    const onSignIn = vi.fn(async () => {});
    render(<SignIn initial={initial} connection={connection} connections={[connection]} onSignIn={onSignIn} />);
    expect(screen.getByText(/Sign in to the dashboard over LAN, Tailscale and SSH \(off\)\./)).toBeTruthy();
    const listed = screen.getByText("Routes, tried in order").parentElement!.querySelectorAll("li");
    expect([...listed].map((li) => li.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "LAN http://192.168.1.10:9119",
      "Tailscale http://100.101.102.103:9119",
      "SSH ssh://liam@hermesoff",
    ]);
    expect(screen.queryByLabelText("SSH target")).toBeNull();
    await user.type(screen.getByLabelText(/^Dashboard password/), "hunter2");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    const d = (onSignIn.mock.calls[0] as unknown[])[0] as SignInDetails;
    expect(d.routes?.map((r) => [r.id, !!r.locked, !!r.off])).toEqual([
      ["l", false, false],
      ["t", false, false],
      ["s", false, true],
    ]);
  });
});
