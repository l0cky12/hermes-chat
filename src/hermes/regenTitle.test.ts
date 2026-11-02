import { describe, expect, it } from "vitest";
import { editFlags, FakeHermes, row } from "./fakeHermes";
import { cleanTitle, connect, TitleModelUnavailable, titleModelUnavailable } from "./transport";

type Stored = { id: number; role: string; content: unknown };

/** Stored rows, oldest first: the first two messages fall outside the last five a title is made from. */
const talk: Stored[] = [
  { id: 1, role: "user", content: "Plan my trip to Lisbon" },
  { id: 2, role: "assistant", content: "Here is a Lisbon plan" },
  { id: 3, role: "user", content: [{ type: "text", text: "Actually, let's fix the backup job" }, { type: "image_url", image_url: { url: "x" } }] },
  { id: 4, role: "assistant", content: "" },
  { id: 5, role: "tool", content: "systemctl status backup: inactive" },
  { id: 6, role: "assistant", content: "The backup timer is disabled" },
  { id: 7, role: "user", content: "Enable it and run it nightly" },
  { id: 8, role: "assistant", content: "Done, it runs at 02:00" },
  { id: 9, role: "user", content: "Thanks" },
];

async function listed(rows: Stored[] = talk) {
  const server = new FakeHermes();
  server.sessions = [row("a", 1, { title: "Lisbon trip" })];
  // `order=latest` pages back from the newest row and returns each page oldest first (`get_messages` at `bf0203a`).
  server.rest["GET /api/sessions/a/messages"] = ({ query }) => {
    const limit = Number(query.get("limit")), offset = Number(query.get("offset") ?? 0);
    const end = Math.max(0, rows.length - offset);
    return { session_id: "a", profile: "default", messages: rows.slice(Math.max(0, end - limit), end), pagination: {} };
  };
  const hermes = await connect(server.openPipe);
  await hermes.sync();
  const title = () => hermes.getSnapshot().chats.find((c) => c.id === "a")!.title;
  const asks = () => server.requests.filter((r) => r.method === "llm.oneshot");
  const patches = () => server.restRequests.filter((r) => r.method === "PATCH");
  return { server, hermes, title, asks, patches };
}

describe("Regenerating a chat's title", () => {
  it("asks Hermes's title model about the last five messages, and saves its answer as the title", async () => {
    const { server, hermes, title, asks, patches } = await listed();
    server.oneshotAnswer = 'Title: "Nightly backup job fix."';

    expect(await hermes.regenerateTitle("a")).toBe("Nightly backup job fix");

    const read = server.restRequests.find((r) => r.path === "/api/sessions/a/messages")!;
    expect(Object.fromEntries(read.query)).toMatchObject({ profile: "default", order: "latest" });
    const [ask] = asks();
    expect(ask.params.profile).toBe("default");
    expect(ask.params.input).toBe(
      [
        "USER: Actually, let's fix the backup job",
        "ASSISTANT: The backup timer is disabled",
        "USER: Enable it and run it nightly",
        "ASSISTANT: Done, it runs at 02:00",
        "USER: Thanks",
      ].join("\n\n"),
    );
    // Nothing goes into the chat itself.
    expect(server.requests.some((r) => r.method === "prompt.submit" || r.method === "session.resume")).toBe(false);
    expect(editFlags(patches()[0].body)).toEqual({ title: "Nightly backup job fix", profile: "default" });
    expect(title()).toBe("Nightly backup job fix");
  });

  it("reads older pages until it has the last five messages, past a long run of tool rows", async () => {
    const tools = Array.from({ length: 150 }, (_, i) => ({ id: 100 + i, role: "tool", content: `step ${i}` }));
    const { server, hermes, asks } = await listed([...talk, ...tools]);

    await hermes.regenerateTitle("a");

    const reads = server.restRequests.filter((r) => r.path === "/api/sessions/a/messages").map((r) => r.query.get("offset"));
    expect(reads).toEqual(["0", "100"]);
    expect(String(asks()[0].params.input).split("\n\n")).toHaveLength(5);
    expect(asks()[0].params.input).toContain("USER: Thanks");
  });

  it("keeps the old title and says why when the model call fails", async () => {
    const { server, hermes, title, patches } = await listed();
    server.oneshotFailure = "no title model configured";

    await expect(hermes.regenerateTitle("a")).rejects.toThrow("no title model configured");
    expect(patches()).toEqual([]);
    expect(title()).toBe("Lisbon trip");
  });

  // Issue #54: the profile's Text generation model was pinned to Nous Portal, and Hermes wasn't signed in to it.
  const NOUS_MISSING = "Nous Portal runtime credentials unavailable: Hermes is not logged into Nous Portal. (code: nous_auth_missing)";

  it("says how to fix it when Hermes isn't signed in to the Text generation model's provider, and keeps the old title", async () => {
    const { server, hermes, title, asks, patches } = await listed();
    server.oneshotFailure = NOUS_MISSING;

    const failed = await hermes.regenerateTitle("a").then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(failed).toBeInstanceOf(TitleModelUnavailable);
    const e = failed as TitleModelUnavailable;
    expect(e.provider).toBe("nous");
    expect(e.detail).toBe(NOUS_MISSING);
    expect(e.message).toBe(
      "Text generation runs on Nous Portal, and Hermes on the server isn't signed in to Nous Portal. Sign it in there with " +
        "`hermes auth add nous`, or pick another Text generation model in Settings → Model.",
    );
    // One ask, on the profile's own Text generation model: no other provider is tried behind the owner's back.
    expect(asks()).toHaveLength(1);
    expect(Object.keys(asks()[0].params).sort()).toEqual(["input", "instructions", "max_tokens", "profile"]);
    expect(patches()).toEqual([]);
    expect(title()).toBe("Lisbon trip");
  });

  it("names any other provider Hermes has no key for", async () => {
    const { server, hermes, title } = await listed();
    server.oneshotFailure =
      "Provider 'openrouter' is set in config.yaml but no API key was found. Set the OPENROUTER_API_KEY environment variable, or switch to a different provider with `hermes model`.";

    await expect(hermes.regenerateTitle("a")).rejects.toMatchObject({
      provider: "openrouter",
      message: "Text generation runs on openrouter, and Hermes on the server has no API key or sign-in for it. Add one there, or pick another Text generation model in Settings → Model.",
    });
    expect(title()).toBe("Lisbon trip");
  });

  it("keeps the old title when Hermes answers with nothing", async () => {
    const { server, hermes, title, patches } = await listed();
    server.oneshotAnswer = '  ""  ';

    await expect(hermes.regenerateTitle("a")).rejects.toThrow("Hermes didn't answer with a title.");
    expect(patches()).toEqual([]);
    expect(title()).toBe("Lisbon trip");
  });

  it("asks nothing for a chat without messages", async () => {
    const { hermes, asks } = await listed([{ id: 1, role: "tool", content: "ok" }]);

    await expect(hermes.regenerateTitle("a")).rejects.toThrow("no messages");
    expect(asks()).toEqual([]);
  });
});

describe("titleModelUnavailable", () => {
  it.each([
    "one-shot generation failed: Nous Portal runtime credentials unavailable: No access token found for Nous Portal login. (code: nous_auth_missing_access_token)",
    "Provider 'anthropic' is set in config.yaml but no credentials were found. Run `hermes auth add anthropic` to sign in, or switch to a different provider with `hermes model`.",
  ])("is a sign-in problem: %j", (why) => expect(titleModelUnavailable(why, "default")).toBeInstanceOf(TitleModelUnavailable));

  it("names a profile other than the default in the sign-in command, as Hermes's own guidance does", () => {
    const why = "one-shot generation failed: Nous Portal runtime credentials unavailable: Hermes is not logged into Nous Portal. (code: nous_auth_missing)";
    expect(titleModelUnavailable(why, "work")?.message).toContain("`hermes -p work auth add nous`");
    expect(titleModelUnavailable(why, "default")?.message).toContain("`hermes auth add nous`");
  });

  it.each([
    "no title model configured",
    "Request timed out.",
    "Nous Portal runtime credentials unavailable: Nous Portal is rate limited; retry in 30s. (code: rate_limited)",
    "Provider 'openrouter' is out of usable credentials: its only credential is exhausted (last error 402). Add credits or update billing with that provider, then retry, or switch to a different provider with `hermes model`.",
    "No LLM provider configured for task=title_generation provider=auto. Run: hermes setup",
  ])("isn't a sign-in problem: %j", (why) => expect(titleModelUnavailable(why, "default")).toBeUndefined());
});

describe("cleanTitle", () => {
  it.each([
    ["Backup fix", "Backup fix"],
    ["**Title:** Backup fix.", "Backup fix"],
    ["“Backup fix”\n\nThis names the chat.", "Backup fix"],
    ["# Title: `Backup fix`", "Backup fix"],
    ["", ""],
  ])("%j -> %j", (answer, title) => expect(cleanTitle(answer)).toBe(title));

  it("cuts a long answer at a word", () => {
    expect(cleanTitle("Investigate why the nightly backup job stopped running after the last system upgrade")).toBe(
      "Investigate why the nightly backup job stopped running after",
    );
    expect(cleanTitle("Investigate why the nightly backup job stopped running afterwards")).toBe(
      "Investigate why the nightly backup job stopped running",
    );
  });

  it("cuts an answer with no space to cut at at the limit", () => {
    expect(cleanTitle("x".repeat(80))).toBe("x".repeat(60));
    expect(cleanTitle("夜".repeat(70))).toBe("夜".repeat(60));
    // Never half of a character written as two UTF-16 units.
    expect(cleanTitle(`${"x".repeat(59)}😀more`)).toBe("x".repeat(59));
  });
});
