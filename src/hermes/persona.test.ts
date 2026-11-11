// Settings → Persona's reads and writes of a profile's SOUL.md, against the fake dashboard (which mirrors
// `GET`/`PUT /api/profiles/{name}/soul` at the deployed `bf0203a`): read-back, conflicts, failed and lost writes, servers
// without the routes, and that every call stays on the profile it names.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { asReadBack, PersonaApi, PersonaError, personaError, sameSoul, soulNotes } from "./persona";
import { connect, type Hermes } from "./transport";
import { RestError, type RestMethod } from "./pipe";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const SOUL = "# Persona\n\nYou are **terse**.\n\n- Use `code` spans\n\t- and tabs\n\nTrailing spaces  \n";

async function signedIn(souls: Record<string, string> = { default: SOUL }) {
  const server = new FakeHermes();
  server.otherProfiles = { work: [] };
  server.souls = { ...souls };
  const hermes = await connect(server.openPipe, "default");
  running.push(hermes);
  return { server, hermes, api: hermes.persona };
}

const soulCalls = (server: FakeHermes) => server.restRequests.filter((r) => r.path.endsWith("/soul")).map((r) => `${r.method} ${r.path}`);
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as PersonaError);

describe("reading SOUL.md", () => {
  it("reads the named profile's file, as Hermes has it", async () => {
    const { server, api } = await signedIn({ default: SOUL, work: "# Work\n" });
    expect(await api.read("default")).toEqual({ exists: true, content: SOUL });
    expect(await api.read("work")).toEqual({ exists: true, content: "# Work\n" });
    expect(soulCalls(server)).toEqual(["GET /api/profiles/default/soul", "GET /api/profiles/work/soul"]);
  });

  it("tells a missing file from an empty one", async () => {
    const { api } = await signedIn({ default: "" });
    expect(await api.read("default")).toEqual({ exists: true, content: "" });
    expect(await api.read("work")).toEqual({ exists: false, content: "" });
  });

  it("names the profile's folder and distribution from the profile list", async () => {
    const { server, api } = await signedIn();
    server.distributions = { work: "acme-agents" };
    expect(await api.home("default")).toEqual({ path: "/home/liam/.hermes", distribution: undefined });
    expect(await api.home("work")).toEqual({ path: "/home/liam/.hermes/profiles/work", distribution: "acme-agents" });
    expect(await api.home("nope")).toBeUndefined();
  });

  it("lists every profile in Hermes's order, leaving out names it couldn't edit", async () => {
    const { server, api } = await signedIn();
    server.distributions = { work: "acme-agents" };
    expect(await api.profiles()).toEqual([
      { name: "default", path: "/home/liam/.hermes", distribution: undefined },
      { name: "work", path: "/home/liam/.hermes/profiles/work", distribution: "acme-agents" },
    ]);
    server.rest["GET /api/profiles"] = () => ({ profiles: [{ name: "default" }, { name: "Bad Name" }, { name: 7 }, { name: "work", path: "" }, { name: "work" }, null] });
    expect(await api.profiles()).toEqual([
      { name: "default", path: undefined, distribution: undefined },
      { name: "work", path: undefined, distribution: undefined },
    ]);
    server.rest["GET /api/profiles"] = () => ({});
    expect(await api.profiles()).toEqual([]);
  });

  it("says when the server has no persona route, the profile is gone, or the file can't be read", async () => {
    const { server, api } = await signedIn();
    server.soulRoutes = false;
    expect(await rejection(api.read("default"))).toMatchObject({ kind: "unsupported", message: expect.stringContaining("GET /api/profiles/{name}/soul") });
    expect(personaError(new RestError(404, `{"detail":"Not Found"}`), "default", false).kind).toBe("unsupported");
    server.soulRoutes = true;
    delete server.otherProfiles.work;
    expect(await rejection(api.read("work"))).toMatchObject({ kind: "no-profile", status: 404 });
    server.soulReadError = new RestError(500, `{"detail":"Could not read SOUL.md: [Errno 13] Permission denied: '/home/liam/.hermes/SOUL.md'"}`);
    expect(await rejection(api.read("default"))).toMatchObject({ kind: "permission", message: expect.stringContaining("Permission denied") });
    server.soulReadError = new RestError(403, `{"detail":"Forbidden"}`);
    expect(await rejection(api.read("default"))).toMatchObject({ kind: "permission" });
    server.soulReadError = new RestError(401, "", "The dashboard sign-in has expired. Sign in again.");
    expect(await rejection(api.read("default"))).toMatchObject({ kind: "signed-out" });
    server.soulReadError = "Can't reach the Hermes dashboard: connection refused";
    expect(await rejection(api.read("default"))).toMatchObject({ kind: "disconnected" });
    server.soulReadError = new RestError(500, `Internal Server Error`);
    expect(await rejection(api.read("default"))).toMatchObject({ kind: "error", message: expect.stringContaining("500") });
  });

  it("refuses an answer that isn't a SOUL.md", async () => {
    const { server, api } = await signedIn();
    server.rest["GET /api/profiles/default/soul"] = () => ({ soul: "x" });
    expect(await rejection(api.read("default"))).toMatchObject({ kind: "unsupported" });
  });

  it("never sends a request for a name that isn't a profile id", async () => {
    const { server, api } = await signedIn();
    for (const name of ["../default", "Work", "a/b", "", "-x"]) expect(await rejection(api.read(name))).toMatchObject({ kind: "error" });
    expect(soulCalls(server)).toEqual([]);
  });

  it("is disconnected once the Rust side has closed the connection", async () => {
    const { server, api } = await signedIn();
    // `TransportError::Closed`, what `hermes_request` answers once there is no connection.
    server.soulReadError = "The chat connection is closed.";
    expect(await rejection(api.read("default"))).toMatchObject({ kind: "disconnected", message: "Not connected to Hermes." });
  });
});

describe("saving SOUL.md", () => {
  it("checks Hermes still has what the edit started from, writes, and reads it back", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default");
    const edited = `${SOUL}\n## New section\n\n> quoted — ünïcode ✓\n`;
    server.restRequests.length = 0;
    expect(await api.save("default", base, edited)).toEqual({ kind: "saved", soul: { exists: true, content: edited }, previous: base });
    expect(server.souls.default).toBe(edited);
    expect(soulCalls(server)).toEqual(["GET /api/profiles/default/soul", "PUT /api/profiles/default/soul", "GET /api/profiles/default/soul"]);
    expect(server.restRequests.find((r) => r.method === "PUT")?.body).toEqual({ content: edited });
  });

  it("writes nothing when SOUL.md changed on the server since the edit started", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default");
    server.souls.default = "# Changed in another client\n";
    expect(await api.save("default", base, "# Mine\n")).toEqual({ kind: "conflict", server: { exists: true, content: "# Changed in another client\n" } });
    expect(server.souls.default).toBe("# Changed in another client\n");
    expect(server.restRequests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("counts a file created or deleted elsewhere as a change", async () => {
    const { server, api } = await signedIn({});
    const missing = await api.read("default");
    server.souls.default = "# Created elsewhere\n";
    expect((await api.save("default", missing, "# Mine\n")).kind).toBe("conflict");
    const there = await api.read("default");
    delete server.souls.default;
    expect((await api.save("default", there, "# Mine\n")).kind).toBe("conflict");
    expect(server.souls.default).toBeUndefined();
  });

  it("creates a missing SOUL.md only when asked to save one", async () => {
    const { server, api } = await signedIn({});
    const missing = await api.read("default");
    expect(server.souls.default).toBeUndefined();
    const r = await api.save("default", missing, "# New persona\n");
    expect(r).toEqual({ kind: "saved", soul: { exists: true, content: "# New persona\n" }, previous: { exists: false, content: "" } });
    expect(server.souls.default).toBe("# New persona\n");
  });

  it("says when the read-back finds other text: another client wrote right after", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default");
    server.afterSoulWrite = () => (server.souls.default = "# Theirs\n");
    expect(await api.save("default", base, "# Mine\n")).toEqual({ kind: "changed", server: { exists: true, content: "# Theirs\n" }, previous: base });
  });

  it("keeps the edit and says why when Hermes refuses the write", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default");
    server.soulWriteError = new RestError(500, `{"detail":"Could not write SOUL.md: [Errno 30] Read-only file system: '/home/liam/.hermes/SOUL.md'"}`);
    const e = await rejection(api.save("default", base, "# Mine\n"));
    expect(e).toMatchObject({ kind: "permission", status: 500, message: expect.stringContaining("Read-only file system") });
    expect(server.souls.default).toBe(SOUL);
    // A refusal Hermes answered with leaves the file as it was, so there is no read-back to make.
    expect(soulCalls(server).filter((c) => c.startsWith("GET")).length).toBe(2);
  });

  it("reads back to tell whether a write whose answer was lost went through", async () => {
    const { server, api } = await signedIn();
    let base = await api.read("default");
    server.soulWriteLost = "Can't reach the Hermes dashboard: connection reset";
    expect(await api.save("default", base, "# Landed\n")).toMatchObject({ kind: "saved", soul: { exists: true, content: "# Landed\n" } });

    server.soulWriteLost = undefined;
    server.soulWriteError = "Can't reach the Hermes dashboard: connection reset";
    base = await api.read("default");
    expect(await rejection(api.save("default", base, "# Never landed\n"))).toMatchObject({ kind: "disconnected" });
    expect(server.souls.default).toBe("# Landed\n");
  });

  it("can't tell, and says so, when the write's answer and the read-back both fail", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default");
    server.soulWriteLost = new RestError(502, `Bad Gateway`);
    server.afterSoulWrite = () => (server.soulReadError = "Can't reach the Hermes dashboard: connection refused");
    const e = await rejection(api.save("default", base, "# Mine\n"));
    expect(e?.message).toMatch(/^Couldn't tell whether SOUL\.md was saved/);
  });

  it("reports a save it couldn't read back as unverified, not saved", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default");
    server.afterSoulWrite = () => (server.soulReadError = new RestError(500, `Internal Server Error`));
    expect(await api.save("default", base, "# Mine\n")).toMatchObject({ kind: "unverified", previous: base, problem: { kind: "error" } });
  });

  it("says an older server can't save personas", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default");
    server.rest["PUT /api/profiles/default/soul"] = () => {
      throw new RestError(405, `{"detail":"Method Not Allowed"}`);
    };
    expect(await rejection(api.save("default", base, "# Mine\n"))).toMatchObject({ kind: "unsupported", message: expect.stringContaining("PUT") });
    expect(server.souls.default).toBe(SOUL);
  });

  it("writes only the profile it names", async () => {
    const { server, api } = await signedIn({ default: SOUL, work: "# Work\n" });
    const work = await api.read("work");
    await api.save("work", work, "# Work, edited\n");
    expect(server.souls).toEqual({ default: SOUL, work: "# Work, edited\n" });
    expect(new Set(soulCalls(server).map((c) => c.split(" ")[1]))).toEqual(new Set(["/api/profiles/work/soul"]));
  });

  it("matches what Hermes reads back: no byte order mark, LF line ends", async () => {
    const { server, api } = await signedIn({ default: "﻿# Persona\r\nline\r\n" });
    const base = await api.read("default");
    expect(base.content).toBe("# Persona\nline\n");
    server.restRequests.length = 0;
    expect((await api.save("default", base, "# Persona\r\nline two\r\n")).kind).toBe("saved");
    expect(asReadBack("﻿a\r\nb\rc")).toBe("a\nb\nc");
    expect(sameSoul({ exists: true, content: "a\r\n" }, { exists: true, content: "a\n" })).toBe(true);
    expect(sameSoul({ exists: false, content: "" }, { exists: true, content: "" })).toBe(false);
  });
});

describe("requests that never end, and a closed connection", () => {
  it("gives up on a read Hermes doesn't answer", async () => {
    const { server, hermes } = await signedIn();
    server.rest["GET /api/profiles/default/soul"] = () => new Promise(() => {});
    const api = new PersonaApi((m, p, b) => (hermes as unknown as { rest: PersonaRest }).rest(m, p, b), { readMs: 20, writeMs: 20 });
    expect(await rejection(api.read("default"))).toMatchObject({ kind: "error", message: expect.stringContaining("didn't answer reading SOUL.md") });
  });

  it("settles a save Hermes doesn't answer by reading back, so the save always ends", async () => {
    const { server, hermes } = await signedIn();
    const api = new PersonaApi((m, p, b) => (hermes as unknown as { rest: PersonaRest }).rest(m, p, b), { readMs: 1000, writeMs: 20 });
    const base = await api.read("default");
    server.rest["PUT /api/profiles/default/soul"] = () => new Promise(() => {});
    // The write never landed: Hermes still has the old text, so the timeout is what it says.
    expect(await rejection(api.save("default", base, "# Mine\n"))).toMatchObject({ message: expect.stringContaining("didn't answer the save") });
    // It landed but the answer never came: the read-back shows it saved.
    server.rest["PUT /api/profiles/default/soul"] = ({ body }) => {
      server.souls.default = body!.content as string;
      return new Promise(() => {});
    };
    expect(await api.save("default", base, "# Mine\n")).toMatchObject({ kind: "saved" });
  });

  it("sends nothing once signed out, even for a save that started before", async () => {
    const { server, hermes, api } = await signedIn();
    const base = await api.read("default");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.rest["GET /api/profiles/default/soul"] = async () => {
      await gate;
      return { content: SOUL, exists: true };
    };
    const saving = rejection(api.save("default", base, "# Mine\n"));
    await hermes.close();
    release();
    expect(await saving).toMatchObject({ kind: "disconnected" });
    expect(server.restRequests.some((r) => r.method === "PUT")).toBe(false);
    expect(server.souls.default).toBe(SOUL);
  });
});

type PersonaRest = (method: RestMethod, path: string, body?: unknown) => Promise<unknown>;

describe("what Hermes does with it", () => {
  it("notes an empty persona and one longer than Hermes includes in full", () => {
    expect(soulNotes("# Fine\n")).toEqual([]);
    expect(soulNotes("  \n")[0]).toMatch(/built-in identity/);
    expect(soulNotes("x".repeat(20_001))[0]).toMatch(/20,001 characters.*up to 20,000/);
  });
});
