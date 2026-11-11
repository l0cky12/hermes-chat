// Importing transcripts against a REAL Hermes dashboard: skipped unless HERMES_LIVE_DASHBOARD is set, and refused
// unless every profile on that server lives under /tmp, so it only ever writes to a throwaway HERMES_HOME. It imports
// the real export files it is given, imports them again, and sends a corrupted copy. Set up a server as ADR 0031
// describes, export a chat from Hermes Chat (Markdown) and with `hermes sessions export` (JSONL), then:
//
//   HERMES_LIVE_DASHBOARD=http://127.0.0.2:9339 HERMES_LIVE_USER=fixture HERMES_LIVE_PASSWORD=… \
//   HERMES_LIVE_MD=/tmp/x/chat.md HERMES_LIVE_JSONL=/tmp/x/sessions.jsonl [HERMES_LIVE_PROFILE=default] \
//   npx vitest run src/hermes/importTranscripts.live.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { ImportFileError, ImportRefusedError, planImport, readBack, sendImport, type ImportFormat, type ImportRest } from "./importTranscripts";
import { RestError } from "./pipe";

// This app's tsconfig has no Node types; vitest runs the file in Node.
declare const process: { env: Record<string, string | undefined> };
const readText = async (path: string): Promise<string> =>
  ((await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(p: string, e: string): string }).readFileSync(path, "utf8");

const BASE = process.env.HERMES_LIVE_DASHBOARD;
/** The profile imported into; every profile on the server must still be under /tmp. */
const PROFILE = process.env.HERMES_LIVE_PROFILE ?? "default";

/** Dashboard REST with the sign-in cookies, failing in the Rust relay's words. */
function dashboard(): ImportRest {
  let cookie = "";
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, BASE), { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) cookie = [...cookie.split("; ").filter((p) => p && !p.startsWith(c.split("=")[0] + "=")), c.split(";")[0]].join("; ");
    return res;
  };
  return async (method, path, body) => {
    if (!cookie) await send("POST", "auth/password-login", { provider: "basic", username: process.env.HERMES_LIVE_USER, password: process.env.HERMES_LIVE_PASSWORD });
    const res = await send(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new RestError(res.status, text.slice(0, 600));
    return JSON.parse(text);
  };
}

const files: [ImportFormat, string | undefined][] = [
  ["markdown", process.env.HERMES_LIVE_MD],
  ["jsonl", process.env.HERMES_LIVE_JSONL],
];

describe.skipIf(!BASE)("against a throwaway Hermes", () => {
  const rest = dashboard();

  beforeAll(async () => {
    const { profiles } = (await rest("GET", "api/profiles")) as { profiles: { name: string; path: string }[] };
    const real = profiles.filter((p) => !p.path.startsWith("/tmp/"));
    if (!profiles.length || real.length) throw new Error(`Refusing to run: ${real.map((p) => p.path).join(", ") || "no profiles"} isn't a throwaway home under /tmp.`);
  });

  for (const [format, path] of files)
    it.skipIf(!path)(`imports a real ${format} export once, then skips it, keeping its words, roles and times`, async () => {
      const plan = await planImport(format, path!, await readText(path!));
      console.log(`${format}: ${plan.chats.length} chats, ids ${plan.chats.map((c) => c.id).join(", ")}\n  warnings: ${plan.warnings.join("\n    ")}`);
      const before = await readBack(rest, PROFILE, plan.chats.map((c) => c.id));
      const first = await sendImport(rest, PROFILE, plan.chats);
      console.log(`${format} first:`, JSON.stringify(first));
      expect(first.unconfirmed).toEqual([]);
      expect([...first.imported, ...first.skipped].sort()).toEqual(plan.chats.map((c) => c.id).sort());
      expect(first.imported).toEqual(plan.chats.map((c) => c.id).filter((id) => before.get(id) === null));
      for (const chat of plan.chats) {
        const stored = (await rest("GET", `api/sessions/${encodeURIComponent(chat.id)}/messages?profile=${PROFILE}&limit=500`)) as {
          messages: { role: string; content: unknown; timestamp: number; tool_calls: unknown; tool_name: string | null }[];
        };
        const sent = chat.session.messages as { role: string; content: unknown; timestamp?: number; tool_name?: string }[];
        if (before.get(chat.id) !== null) continue;
        expect(stored.messages.map((m) => [m.role, m.content, m.timestamp, m.tool_name ?? undefined])).toEqual(
          sent.map((m) => [m.role, m.content, m.timestamp, m.tool_name]),
        );
        const row = (await rest("GET", `api/sessions/${encodeURIComponent(chat.id)}?profile=${PROFILE}`)) as Record<string, unknown>;
        expect(row).toMatchObject({ source: "import", title: chat.title, started_at: chat.startedAt, ...(chat.model && { model: chat.model }) });
      }
      const again = await sendImport(rest, PROFILE, plan.chats);
      console.log(`${format} again:`, JSON.stringify(again));
      expect(again).toEqual({ imported: [], skipped: plan.chats.map((c) => c.id), unconfirmed: [] });
    });

  it.skipIf(!files[1][1])("refuses a corrupted export whole, before and at Hermes, writing nothing", async () => {
    const text = await readText(files[1][1]!);
    const cut = text.slice(0, Math.floor(text.length / 2));
    await expect(planImport("jsonl", "cut.jsonl", cut)).rejects.toThrow(ImportFileError);
    // Past the app's own checks, Hermes checks every session before writing any.
    const plan = await planImport("jsonl", "x.jsonl", text);
    const fresh = { ...plan.chats[0], id: "20260101_000000_feedfacecafe" };
    const bad = [
      { ...fresh, session: { ...fresh.session, id: fresh.id } },
      { ...fresh, id: "20260101_000000_badbadbadbad", session: { ...fresh.session, id: "20260101_000000_badbadbadbad", messages: [{ content: "no role" }] } },
    ];
    const refused = await sendImport(rest, PROFILE, bad).catch((e: Error) => e);
    console.log("corrupted:", refused instanceof Error ? refused.message : refused);
    expect(refused).toBeInstanceOf(ImportRefusedError);
    expect(await readBack(rest, PROFILE, bad.map((c) => c.id))).toEqual(new Map(bad.map((c) => [c.id, null])));
  });
});
