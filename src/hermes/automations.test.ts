// Automations: the preview checked against Hermes's own webhook code (webhookGolden.json, from tools/webhook-golden.py
// at the deployed `bf0203a`), and the API against a fake of Hermes's `/api/webhooks*` routes, stock and `webhooks/1`.
import { describe, expect, it } from "vitest";
import golden from "./webhookGolden.json";
import {
  AutomationError,
  type AutomationFields,
  AutomationsApi,
  type RestFn,
  NAME_RE,
  coalesceGroup,
  decodeChatId,
  filterMatches,
  filterRow,
  parseFilterValue,
  preview,
  pyJson,
  renderPrompt,
  sanitizeEvent,
  stockGaps,
  typedFilterValue,
} from "./automations";
import { FakeWebhooks, type SessionRow } from "./fakeHermes";
import { RestError } from "./pipe";

describe("the preview matches Hermes's webhook adapter", () => {
  it(`renders every golden template as Hermes ${golden.hermes} does`, () => {
    for (const c of golden.renders) {
      const payload = golden.payloads[c.payload as keyof typeof golden.payloads];
      expect(renderPrompt(c.template, payload, c.event, c.route), `${c.payload}: ${JSON.stringify(c.template)}`).toBe(c.out);
    }
    expect(golden.renders.length).toBeGreaterThan(40);
  });

  it("evaluates every golden filter as Hermes does", () => {
    for (const c of golden.filters) {
      const payload = golden.payloads[c.payload as keyof typeof golden.payloads];
      expect(filterMatches(c.spec, payload, c.event, c.headers), `${c.payload}: ${JSON.stringify(c.spec)}`).toBe(c.out);
    }
  });

  it("groups events for coalescing as Hermes does, and runs at once when the key doesn't resolve", () => {
    for (const c of golden.keys) {
      const payload = golden.payloads[c.payload as keyof typeof golden.payloads];
      expect(coalesceGroup(c.key, payload, c.event, c.route) ?? null, `${c.payload}: ${c.key}`).toBe(c.out);
    }
  });

  it("writes JSON the way Python's json.dumps does", () => {
    expect(pyJson({ a: [1, { b: "é" }], c: {} }, 2)).toBe('{\n  "a": [\n    1,\n    {\n      "b": "\\u00e9"\n    }\n  ],\n  "c": {}\n}');
    expect(pyJson({ b: 1, a: [true, null] }, undefined, true)).toBe('{"a": [true, null], "b": 1}');
  });

  it("says whether an example event would start a task, and with what prompt", () => {
    const f = { name: "triage", events: ["issues"], prompt: "#{issue.number} {issue.title} {issue.nope}", filters: [{ field: "action", equals: "opened" }], coalesce: undefined };
    const payload = { action: "opened", issue: { number: 3, title: "<script>x</script>" } };
    const p = preview(f, payload, "issues");
    expect(p).toMatchObject({ eventTaken: true, starts: true, prompt: "#3 <script>x</script> {issue.nope}", missing: ["issue.nope"] });
    expect(preview(f, payload, "push")).toMatchObject({ eventTaken: false, starts: false });
    expect(preview({ ...f, filters: [{ field: "action", equals: "closed" }] }, payload, "issues").starts).toBe(false);
    expect(preview({ ...f, coalesce: { key: "pull_request.number", windowSeconds: 30, maxWaitSeconds: 300 } }, payload, "issues")).toMatchObject({ ungrouped: true, group: undefined });
  });

  it("creates names of at most 64 characters, by Hermes's rule", () => {
    expect(NAME_RE.test("a".repeat(64))).toBe(true);
    expect(NAME_RE.test("a".repeat(65))).toBe(false);
    expect(NAME_RE.test("-x")).toBe(false);
  });

  it("edits only filters it can write back exactly, keeping every other one as it is", () => {
    expect(filterRow({ field: "action", exists: false })).toBeUndefined();
    expect(filterRow({ field: "issue.labels", contains: { name: "bug" } })).toBeUndefined();
    expect(filterRow({ field: "x", in: ["foo,bar"] })).toBeUndefined();
    expect(filterRow({ field: "action", regex: "(?P<verb>opened)" })).toBeUndefined();
    expect(filterRow({ field: "action", regex: "^open" })).toMatchObject({ op: "regex" });
    expect(filterRow({ field: "action", exists: true })).toMatchObject({ op: "exists" });
    expect(filterRow({ field: "n", equals: "42" })).toMatchObject({ op: "equals", value: "42" });
  });

  it("reads typed filter values the way Hermes compares them", () => {
    expect(parseFilterValue("equals", "42")).toBe(42);
    expect(parseFilterValue("equals", '"42"')).toBe("42");
    expect(parseFilterValue("equals", "true")).toBe(true);
    expect(parseFilterValue("in", "bug, 3, \"7\"")).toEqual(["bug", 3, "7"]);
    expect(parseFilterValue("contains", "42")).toBe("42");
    expect(parseFilterValue("exists", "")).toBe(true);
    expect(typedFilterValue("equals", "42")).toBe('"42"');
    expect(typedFilterValue("in", ["bug", 3])).toBe("bug, 3");
  });
});

describe("example events", () => {
  it("replaces secret-looking values, e-mail addresses and passwords in links before showing a pasted event", () => {
    const { payload, notes } = sanitizeEvent({
      hook: { config: { secret: "s3cr3t", url: "https://user:pa55@example.com/x" } },
      sender: { email: "octo@example.com", login: "octo" },
      token: 12,
      body: "y".repeat(2500),
    });
    expect(payload).toMatchObject({ hook: { config: { secret: "[redacted]", url: "https://[redacted]@example.com/x" } }, sender: { email: "[email]", login: "octo" }, token: "[redacted]" });
    expect(((payload as { body: string }).body).length).toBe(2001);
    expect(notes).toHaveLength(4);
  });

  it("reads the route and delivery id Hermes encodes in a webhook chat's id", () => {
    expect(decodeChatId("webhook:v2:WyJkZWZhdWx0IiwiZ2gtaXNzdWVzIiwiN2IxYzBhMTAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIl0")).toEqual({
      profile: "default",
      route: "gh-issues",
      deliveryId: "7b1c0a10-0000-4000-8000-000000000001",
    });
    expect(decodeChatId("webhook:old-route:d-1")).toEqual({ profile: "default", route: "old-route", deliveryId: "d-1" });
    expect(decodeChatId("telegram:123")).toBeUndefined();
  });
});

function harness(contract = true, sessions: SessionRow[] = []) {
  const fake = new FakeWebhooks();
  fake.contract = contract;
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const rest: RestFn = async (method, pathAndQuery, body) => {
    const url = new URL(pathAndQuery, "http://dashboard/");
    calls.push({ method, path: url.pathname + url.search, body });
    if (url.pathname === "/api/sessions") return { sessions: sessions.filter((s) => s.source === url.searchParams.get("source")) };
    if (url.pathname === "/api/cron/delivery-targets") return { targets: [{ id: "local", name: "Local" }, { id: "telegram", name: "Telegram", home_target_set: true }] };
    const h = fake.route({ method, path: url.pathname, query: url.searchParams, body: body as Record<string, unknown> | undefined });
    if (!h) throw new RestError(404, '{"detail":"Not Found"}');
    return JSON.parse(JSON.stringify(await h()));
  };
  return { fake, api: new AutomationsApi(rest), calls };
}

const fields = (over: Partial<AutomationFields> = {}): AutomationFields => ({
  name: "triage",
  provider: "github",
  events: ["issues"],
  prompt: "Issue {issue.number}",
  filters: [],
  secretEnv: "",
  deliver: "log",
  deliverChatId: "",
  ...over,
});

describe("Hermes with webhooks/1", () => {
  it("creates an automation paused with its filters, coalescing and provider, and hands the new secret back once", async () => {
    const { api, fake, calls } = harness();
    const saved = await api.create("default", fields({ filters: [{ field: "action", equals: "opened" }], coalesce: { key: "issue.number", windowSeconds: 10, maxWaitSeconds: 60 } }), true);
    expect(saved.secret).toMatch(/^fixture-secret-/);
    expect(saved.automation).toMatchObject({ name: "triage", enabled: false, provider: "github", filters: [{ field: "action", equals: "opened" }], coalesce: { key: "issue.number", windowSeconds: 10, maxWaitSeconds: 60 } });
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ enabled: false, create_only: true, provider: "github" });
    expect(fake.routes.default.triage.enabled).toBe(false);
  });

  it("keeps a secret reference on the server: no secret comes back", async () => {
    const { api, fake } = harness();
    const saved = await api.create("default", fields({ secretEnv: "GITHUB_WEBHOOK_SECRET" }), false);
    expect(saved.secret).toBeUndefined();
    expect(saved.automation.secretRef).toBe("env:GITHUB_WEBHOOK_SECRET");
    expect(fake.routes.default.triage.secret).toBeUndefined();
  });

  it("edits in place keeping the secret, and refuses an edit over another client's change", async () => {
    const { api, fake } = harness();
    const { automation } = await api.create("default", fields(), false);
    const secret = fake.routes.default.triage.secret;
    const edited = await api.update("default", automation, fields({ prompt: "New {issue.title}" }));
    expect(edited.secret).toBeUndefined();
    expect(fake.routes.default.triage).toMatchObject({ prompt: "New {issue.title}", secret });
    // Another client changes it: the old revision is refused, with the route as it is now.
    fake.routes.default.triage.prompt = "Theirs";
    const err = await api.update("default", automation, fields({ prompt: "Mine" })).catch((e) => e);
    expect(err).toBeInstanceOf(AutomationError);
    expect(err).toMatchObject({ kind: "conflict", current: { prompt: "Theirs" } });
    expect(fake.routes.default.triage.prompt).toBe("Theirs");
  });

  it("makes a new secret without touching anything else, a route's sender scheme included", async () => {
    const { api, fake, calls } = harness();
    fake.add("default", "svix-route", { events: [], prompt: "p" });
    const a = (await api.list("default")).automations.find((x) => x.name === "svix-route")!;
    const saved = await api.rotateSecret("default", a);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ revision: a.revision, rotate_secret: true });
    expect(saved.secret).toBe(fake.routes.default["svix-route"].secret);
    expect(fake.routes.default["svix-route"].provider).toBeUndefined();
    // An in-place edit leaves the sender scheme as Hermes has it too.
    await api.update("default", saved.automation, fields({ name: "svix-route", prompt: "q" }));
    expect(fake.routes.default["svix-route"]).toMatchObject({ prompt: "q" });
    expect(fake.routes.default["svix-route"].provider).toBeUndefined();
  });

  it("still hands over a new secret when reading the automation back fails", async () => {
    const { api, fake } = harness();
    const { automation } = await api.create("default", fields(), false);
    const list = api.list.bind(api);
    // Rotation writes, then reads back once: that read fails.
    api.list = async () => Promise.reject(new Error("Not connected to Hermes."));
    const err = await api.rotateSecret("default", automation).catch((e) => e);
    expect(err).toBeInstanceOf(AutomationError);
    expect(err.kind).toBe("offline");
    expect(err.secret).toBe(fake.routes.default.triage.secret);
    // Create checks the name first (that read works), writes, then reads back (that one fails).
    let reads = 0;
    api.list = async (p) => (reads++ === 0 ? list(p) : Promise.reject(new Error("Not connected to Hermes.")));
    const lost = await api.create("default", fields({ name: "second" }), false).catch((e) => e);
    expect(lost.secret).toBe(fake.routes.default.second.secret);
  });

  it("refuses a name that's taken instead of replacing that automation", async () => {
    const { api, fake } = harness();
    fake.add("default", "triage", { prompt: "keep me" });
    await expect(api.create("default", fields(), false)).rejects.toMatchObject({ kind: "refused" });
    expect(fake.routes.default.triage.prompt).toBe("keep me");
  });

  it("reads the delivery ledger and retries a failed delivery once, asking first when the attempt had started", async () => {
    const { api, fake } = harness();
    fake.add("default", "triage");
    fake.addDelivery("default", "triage", { delivery_id: "d-1", state: "failed", outcome: "failed", session_id: "s-1", retryable: true, retry_needs_confirmation: true });
    const [a] = (await api.list("default")).automations;
    const history = await api.history("default", a, true);
    expect(history.source).toBe("ledger");
    const d = history.source === "ledger" ? history.deliveries[0] : undefined;
    expect(d).toMatchObject({ deliveryId: "d-1", state: "failed", sessionId: "s-1", retryNeedsConfirmation: true });
    await expect(api.retry("default", a, d!, false)).rejects.toMatchObject({ kind: "confirm" });
    expect(fake.retries).toEqual([]);
    expect(await api.retry("default", a, d!, true)).toMatchObject({ status: "accepted" });
    expect(fake.retries).toHaveLength(1);
  });

  it("sends a retry whose answer was lost with the same key, so Hermes doesn't start it twice", async () => {
    const { api, fake } = harness();
    fake.add("default", "triage");
    fake.addDelivery("default", "triage", { delivery_id: "d-2", state: "failed", reason: "admission_unavailable", retryable: true });
    const [a] = (await api.list("default")).automations;
    const h = await api.history("default", a, true);
    const d = h.source === "ledger" ? h.deliveries[0] : undefined;
    fake.failNext = { match: /retry/, when: "after" };
    await expect(api.retry("default", a, d!, false)).rejects.toMatchObject({ kind: "unknown" });
    expect(await api.retry("default", a, d!, false)).toMatchObject({ status: "already_sent" });
    expect(fake.retries).toHaveLength(1);
  });

  it("pauses and resumes by reading the automation back", async () => {
    const { api, fake } = harness();
    fake.add("default", "triage");
    const [a] = (await api.list("default")).automations;
    expect((await api.setPaused("default", a, true)).enabled).toBe(false);
    expect(fake.routes.default.triage.enabled).toBe(false);
    expect((await api.setPaused("default", { ...a, enabled: false }, false)).enabled).toBe(true);
  });
});

describe("stock Hermes (the deployed bf0203a)", () => {
  it("refuses what it can't keep, rather than dropping it", async () => {
    const { api, calls } = harness(false);
    await expect(api.create("default", fields({ filters: [{ field: "action", equals: "opened" }] }), false)).rejects.toMatchObject({ kind: "unsupported" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(stockGaps(fields({ coalesce: { key: "k", windowSeconds: 1, maxWaitSeconds: 2 }, secretEnv: "X" }))).toEqual(["coalescing", "a secret reference"]);
  });

  it("creates then pauses straight after, since it can't create a paused route", async () => {
    const { api, fake, calls } = harness(false);
    const saved = await api.create("default", fields(), true);
    expect(saved.automation.enabled).toBe(false);
    expect(fake.routes.default.triage.enabled).toBe(false);
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/webhooks?profile=default", "PUT /api/webhooks/triage/enabled?profile=default"]);
    expect(calls.find((c) => c.method === "POST")?.body).not.toHaveProperty("filters");
  });

  it("an edit replaces the route, which makes a new secret, and is refused if another client changed it first", async () => {
    const { api, fake } = harness(false);
    const first = fake.add("default", "triage", { events: ["issues"], prompt: "Old", enabled: false });
    const [a] = (await api.list("default")).automations;
    const saved = await api.update("default", a, fields({ prompt: "New" }));
    expect(saved.secret).not.toBe(first);
    expect(saved.note).toMatch(/new secret/);
    expect(fake.routes.default.triage).toMatchObject({ prompt: "New", enabled: false });
    fake.routes.default.triage.prompt = "Theirs";
    await expect(api.update("default", saved.automation, fields({ prompt: "Mine" }))).rejects.toMatchObject({ kind: "conflict" });
    expect(fake.routes.default.triage.prompt).toBe("Theirs");
  });

  it("lists the tasks a route started from its webhook sessions, other routes' left out", async () => {
    const enc = (route: string, id: string) => `webhook:v2:${btoa(JSON.stringify(["default", route, id])).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
    const rows = [
      { id: "s-1", source: "webhook", chat_id: enc("triage", "d-1"), user_id: "webhook:triage", started_at: 1793721516, ended_at: 1793721523, message_count: 1, is_active: false },
      { id: "s-2", source: "webhook", chat_id: enc("other", "d-2"), user_id: "webhook:other", started_at: 1793721600, ended_at: null, message_count: 1 },
      { id: "s-3", source: "webhook", chat_id: enc("triage", "d-3"), user_id: "webhook:triage", started_at: 1793721700, ended_at: null, message_count: 2, is_active: true },
    ] as unknown as SessionRow[];
    const { api, fake } = harness(false, rows);
    fake.add("default", "triage");
    const [a] = (await api.list("default")).automations;
    const h = await api.history("default", a, false);
    expect(h).toMatchObject({ source: "sessions", runs: [{ sessionId: "s-1", deliveryId: "d-1", endedAt: 1793721523000 }, { sessionId: "s-3", deliveryId: "d-3", active: true }] });
  });

  it("says when the webhook platform is off for the profile", async () => {
    const { api, fake } = harness(false);
    fake.platformEnabled = false;
    await expect(api.create("default", fields(), false)).rejects.toMatchObject({ kind: "disabled" });
  });
});
