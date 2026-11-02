// Settings → Persona: the profile's SOUL.md on the Hermes server, read and written through dashboard REST.
//
// At the deployed `bf0203a` (and upstream `c419cf7`) `hermes_cli/web_routers/profiles.py` has the only API for it:
// - `GET /api/profiles/{name}/soul` → `{content, exists}`. `content` is `read_text(encoding="utf-8-sig")`, so a byte
//   order mark is dropped and CRLF or CR line ends come back as LF. A missing file is `{"content": "", "exists": false}`.
// - `PUT /api/profiles/{name}/soul` `{content}` → `{ok: true}`. `utils.atomic_write_text`: temp file, fsync, rename,
//   keeping the file's mode and owner. It creates a missing SOUL.md, and has no revision or If-Match: it always
//   replaces the whole file.
// - `{name}` must be a profile that exists (`_resolve_profile_dir`: 400 for a bad name, 404 for no such profile), and the
//   file is `<profile home>/SOUL.md`, the one `agent/prompt_builder.py` `load_soul_md` reads.
//
// Hermes has no conditional write, so a Save first reads SOUL.md again and writes only if it is still what the editor
// started from, then reads it back to check it holds what was sent (ADR 0014). The `tui_gateway` twin,
// `profiles.configure {soul}`, is not used: it writes with a bare `write_text` that can leave a truncated file.
import type { RestMethod } from "./pipe";

/** SOUL.md as Hermes has it. `exists` false: there is no file, and `content` is empty. */
export type Soul = { exists: boolean; content: string };

/**
 * Why SOUL.md can't be read or written:
 * - `disconnected`: no connection to Hermes, or it couldn't be reached.
 * - `signed-out`: the dashboard sign-in expired.
 * - `unsupported`: this Hermes server has no persona route (older than the dashboard's persona editor).
 * - `no-profile`: Hermes has no such profile now.
 * - `permission`: the server refused, or the file system denied Hermes access to the file.
 * - `error`: anything else.
 */
export type PersonaProblemKind = "disconnected" | "signed-out" | "unsupported" | "no-profile" | "permission" | "error";

export class PersonaError extends Error {
  constructor(
    readonly kind: PersonaProblemKind,
    message: string,
    /** The HTTP status Hermes answered with; undefined when it didn't answer. */
    readonly status?: number,
    /** The request never left this computer: there was no connection to send it on. */
    readonly unsent = false,
  ) {
    super(message);
  }
}

/**
 * How a Save ended:
 * - `saved`: Hermes has exactly what was sent, read back. `previous`: what it replaced.
 * - `conflict`: SOUL.md changed on the server since the editor read it; nothing was written. `server`: what it is now.
 * - `changed`: written, but reading it back found other text, so something else wrote it too. `server`: what it is now.
 * - `unverified`: Hermes said it saved, but reading it back failed (`problem`), so whether it still holds it is unknown.
 */
export type SaveResult =
  | { kind: "saved"; soul: Soul; previous: Soul }
  | { kind: "conflict"; server: Soul }
  | { kind: "changed"; server: Soul; previous: Soul }
  | { kind: "unverified"; previous: Soul; problem: PersonaError };

/** A profile's home folder on the server, and the profile distribution it was installed from. */
export type ProfileHome = { path?: string; distribution?: string };

/** Hermes's profile ids (`hermes_constants.PROFILE_ID_RE` at `bf0203a`), plus `default`. */
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The text as Hermes reads it back: no byte order mark, LF line ends (`read_text(encoding="utf-8-sig")`). */
export const asReadBack = (text: string) => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

/** Whether two reads of SOUL.md are the same file. */
export const sameSoul = (a: Soul, b: Soul) => a.exists === b.exists && asReadBack(a.content) === asReadBack(b.content);

/** `The dashboard answered 404: {"detail":"…"}` (src-tauri/src/transport.rs `TransportError::Unexpected`). */
function answered(message: string): { status: number; detail: string } | undefined {
  const m = /^The dashboard answered (\d{3}): ?([\s\S]*)$/.exec(message);
  if (!m) return undefined;
  let detail = m[2];
  try {
    const d = (JSON.parse(m[2]) as { detail?: unknown }).detail;
    if (typeof d === "string") detail = d;
  } catch {
    // Not JSON, e.g. a proxy's error page: keep the text.
  }
  return { status: Number(m[1]), detail: detail.trim() };
}

const DENIED = /permission denied|errno 13\b|errno 1\b|operation not permitted|read-only file system|errno 30\b/i;

/** Sorts an error from a read or write of `profile`'s SOUL.md. */
export function personaError(e: unknown, profile: string, writing: boolean): PersonaError {
  if (e instanceof PersonaError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const verb = writing ? "save" : "read";
  if (/^Not connected to Hermes|^The chat connection is closed/.test(message))
    return new PersonaError("disconnected", "Not connected to Hermes.", undefined, true);
  if (/^Can't reach the Hermes dashboard/.test(message)) return new PersonaError("disconnected", message);
  if (/^The dashboard sign-in has expired/.test(message)) return new PersonaError("signed-out", message);
  if (/^Hermes Chat doesn't relay/.test(message)) return new PersonaError("unsupported", message);
  const a = answered(message);
  if (!a) return new PersonaError("error", `Couldn't ${verb} SOUL.md: ${message}`);
  const said = a.detail ? ` Hermes said: ${a.detail}` : "";
  // A route the server doesn't have: `bf0203a` answers `404 No such API endpoint: <path>` (checked live), plain FastAPI
  // `404 Not Found`, and 405 for a method a path doesn't take.
  if ((a.status === 404 && /^(not found$|no such api endpoint\b)/i.test(a.detail)) || a.status === 405)
    return new PersonaError(
      "unsupported",
      `This Hermes server can't ${verb} personas: it has no ${writing ? "PUT" : "GET"} /api/profiles/{name}/soul route. Updating Hermes adds it.`,
      a.status,
    );
  if (a.status === 404) return new PersonaError("no-profile", `Hermes has no profile named ${profile}.${said}`, a.status);
  if (a.status === 403 || a.status === 401 || DENIED.test(a.detail))
    return new PersonaError("permission", `Hermes isn't allowed to ${verb} SOUL.md for the ${profile} profile.${said}`, a.status);
  return new PersonaError("error", `Couldn't ${verb} SOUL.md (Hermes answered ${a.status}).${said}`, a.status);
}

/**
 * Whether a failed write certainly left SOUL.md as it was: it never went out, or Hermes answered with a refusal of its own. A 4xx is
 * refused before the write, and Hermes's 500 `Could not write SOUL.md` comes from the atomic write, which leaves the
 * file untouched. Any other failure (no answer, or a proxy's 502/504) may have come after Hermes wrote it.
 */
const certainlyUnwritten = (e: PersonaError) =>
  e.unsent ||
  (e.status !== undefined && ((e.status >= 400 && e.status < 500) || (e.status === 500 && /Could not write SOUL\.md/.test(e.message))));

/** How long a read or a write of SOUL.md may go unanswered. The relay has no deadline of its own. */
export const PERSONA_TIMEOUTS = { readMs: 30_000, writeMs: 60_000 };

/** `p`, or a rejection once `ms` pass without an answer. The request itself may still be answered later. */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Hermes didn't answer ${what} within ${Math.round(ms / 1000)} seconds.`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Reads and writes SOUL.md for a named profile. Every call names its profile; nothing here follows the profile shown. */
export class PersonaApi {
  constructor(
    private rest: (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>,
    private timeouts = PERSONA_TIMEOUTS,
  ) {}

  private path(profile: string): string {
    if (profile !== "default" && !PROFILE_ID.test(profile)) throw new PersonaError("error", `"${profile}" isn't a Hermes profile name.`);
    return `api/profiles/${encodeURIComponent(profile)}/soul`;
  }

  /**
   * Where `profile` lives on the server, from dashboard REST `GET /api/profiles` (`_profile_to_dict`): its home folder,
   * which holds SOUL.md, and the profile distribution it was installed from, if any. Undefined when it isn't listed.
   */
  async home(profile: string): Promise<ProfileHome | undefined> {
    const res = (await deadline(this.rest("GET", "api/profiles"), this.timeouts.readMs, "listing profiles")) as { profiles?: { name?: unknown; path?: unknown; distribution_name?: unknown }[] } | null;
    const row = res?.profiles?.find((p) => p.name === profile);
    if (!row) return undefined;
    return {
      path: typeof row.path === "string" && row.path ? row.path : undefined,
      distribution: typeof row.distribution_name === "string" && row.distribution_name ? row.distribution_name : undefined,
    };
  }

  /** SOUL.md of `profile` as Hermes has it now. */
  async read(profile: string): Promise<Soul> {
    let res: unknown;
    try {
      res = await deadline(this.rest("GET", this.path(profile)), this.timeouts.readMs, "reading SOUL.md");
    } catch (e) {
      throw personaError(e, profile, false);
    }
    const r = res as { content?: unknown; exists?: unknown } | null;
    if (!r || typeof r.content !== "string" || typeof r.exists !== "boolean")
      throw new PersonaError("unsupported", "This Hermes server answered the persona route in a way Hermes Chat doesn't understand.");
    return { exists: r.exists, content: r.exists ? r.content : "" };
  }

  /**
   * Saves `content` as `profile`'s SOUL.md, if Hermes still has `base`, the SOUL.md the edit started from. Writing
   * when `base` doesn't exist creates the file, so callers pass that only when the owner asked to create it. Rejects
   * with a PersonaError when nothing was written, or when it can't be told whether it was.
   */
  async save(profile: string, base: Soul, content: string): Promise<SaveResult> {
    const before = await this.read(profile);
    if (!sameSoul(before, base)) return { kind: "conflict", server: before };
    const sent: Soul = { exists: true, content: asReadBack(content) };
    try {
      const res = (await deadline(this.rest("PUT", this.path(profile), { content }), this.timeouts.writeMs, "the save")) as { ok?: unknown } | null;
      if (res?.ok !== true) throw new PersonaError("error", "Hermes didn't say it saved SOUL.md.");
    } catch (e) {
      const err = personaError(e, profile, true);
      if (certainlyUnwritten(err)) throw err;
      // It may have been written: read it back to tell.
      let now: Soul;
      try {
        now = await this.read(profile);
      } catch (again) {
        throw new PersonaError(
          "error",
          `Couldn't tell whether SOUL.md was saved: ${err.message} Reading it back also failed: ${personaError(again, profile, false).message} Your changes are still here; reload to see what Hermes has.`,
          err.status,
        );
      }
      if (sameSoul(now, sent)) return { kind: "saved", soul: now, previous: before };
      if (sameSoul(now, before)) throw err;
      return { kind: "changed", server: now, previous: before };
    }
    let after: Soul;
    try {
      after = await this.read(profile);
    } catch (e) {
      return { kind: "unverified", previous: before, problem: personaError(e, profile, false) };
    }
    if (sameSoul(after, sent)) return { kind: "saved", soul: after, previous: before };
    return { kind: "changed", server: after, previous: before };
  }
}

// What Hermes does with SOUL.md (`agent/prompt_builder.py` `load_soul_md`, `_truncate_content` at `bf0203a`).

/** Hermes includes at least this many characters of SOUL.md; more for a model whose context window is known and large. */
export const SOUL_INCLUDED_CHARS = 20_000;

/** What Hermes will do with this text when it next reads it, as notes for the owner. */
export function soulNotes(content: string): string[] {
  const notes: string[] = [];
  if (!content.trim()) notes.push("It's empty, so Hermes uses its built-in identity, as if there were no SOUL.md.");
  if (content.length > SOUL_INCLUDED_CHARS)
    notes.push(
      `It's ${content.length.toLocaleString("en-US")} characters. Hermes includes up to ${SOUL_INCLUDED_CHARS.toLocaleString("en-US")} characters of it, or more for a model with a large context window or a larger context_file_max_chars setting. Past its limit, Hermes keeps the beginning and the end and leaves out the middle.`,
    );
  return notes;
}
