// An extension's manifest.json: parsed once into a `Manifest`, checked for compatibility, and compared with the
// installed version on update (ADR 0126, sections 2, 3 and 7). Pure: nothing here reads a file or runs extension code.
import { CAPABILITIES, type CapabilityId } from "./capabilities";
import { isPermission, PERMISSIONS, type Permission } from "./extensionPermissions";

/** The major version of the extension contract this app runs. Raising it is a MAJOR app release (ADR 0126). */
export const EXTENSION_API = 1;
/** The manifest formats this app reads. A new key adds a format, and every older one stays readable. */
export const MANIFEST_FORMATS = [1] as const;

export const LIMITS = {
  bytes: 16_384,
  id: 64,
  name: 64,
  version: 64,
  main: 128,
  mainParts: 8,
  commandName: 32,
  description: 200,
  viewId: 32,
  title: 64,
  commands: 20,
  views: 5,
} as const;

export type ExtensionId = string & { readonly __extensionId: unique symbol };
export type Version = string & { readonly __version: unique symbol };
export type PackagePath = string & { readonly __packagePath: unique symbol };

export type Command = { name: string; description: string };
export type View = { id: string; title: string };

export type Manifest = {
  manifest: 1;
  id: ExtensionId;
  name: string;
  version: Version;
  api: number;
  main: PackagePath;
  commands: readonly Command[];
  views: readonly View[];
  permissions: readonly Permission[];
  needs: readonly CapabilityId[];
};

export type ManifestProblem =
  | { kind: "tooLarge"; bytes: number; max: number }
  | { kind: "notJson" }
  | { kind: "unknownFormat"; found: unknown; reads: readonly number[] }
  | { kind: "unknownKey" | "missing"; at: string }
  | { kind: "wrongType"; at: string; want: "object" | "string" | "array" | "positive integer" }
  | { kind: "tooLong" | "tooMany"; at: string; max: number }
  | { kind: "badText"; at: string }
  | { kind: "badId"; why: "shape" | "deviceName" }
  | { kind: "badVersion"; why: "notSemver" | "buildMetadata" | "upperCase" }
  | { kind: "badMain"; why: "shape" | "traversal" | "deviceName" }
  | { kind: "badName"; at: string }
  | { kind: "duplicate"; at: string; value: string }
  | { kind: "unknownPermission" | "unknownNeed"; value: string };

export type Parsed = { ok: true; manifest: Manifest } | { ok: false; problem: ManifestProblem };

export type InstallStatus =
  | { kind: "usable" }
  | { kind: "incompatible"; needsApi: number; runsApi: number }
  | { kind: "disabled"; why: "owner" | "failures" };

export type UpdatePlan =
  | { kind: "apply"; drops: readonly Permission[]; wipesStorage: boolean }
  | { kind: "pending"; asks: readonly Permission[]; drops: readonly Permission[]; wipesStorage: boolean }
  | {
      kind: "confirmDowngrade";
      from: Version;
      to: Version;
      asks: readonly Permission[];
      drops: readonly Permission[];
      wipesStorage: boolean;
    }
  | { kind: "refuse"; why: "otherId" | "sameVersion" }
  | { kind: "refuse"; why: "incompatible"; needsApi: number; runsApi: number };

const MANIFEST_KEYS = {
  manifest: true,
  id: true,
  name: true,
  version: true,
  api: true,
  main: true,
  commands: true,
  views: true,
  permissions: true,
  needs: true,
} as const satisfies Record<keyof Manifest, true>;
const COMMAND_KEYS = { name: true, description: true } as const satisfies Record<keyof Command, true>;
const VIEW_KEYS = { id: true, title: true } as const satisfies Record<keyof View, true>;

const ID = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const WORD = /^[a-z0-9-]+$/;
const PATH_PART = /^[A-Za-z0-9_-]([A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
// Control characters and the bidi controls, since these strings show in the install dialog and the "/" menu.
const BAD_TEXT = /[\p{Cc}‎‏‪-‮⁦-⁩]/u;

// semver.org's grammar, as scripts/release/version.mjs has it. That script runs in plain Node, outside tsconfig's
// include, so the two can't share it.
const NUM = "(0|[1-9]\\d*)";
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(-${PRE_ID}(?:\\.${PRE_ID})*)?$`);

/** Windows reserves these names, with or without an extension, and the app ships for Windows (ADR 0069). */
const isDeviceName = (part: string) => DEVICE_NAME.test(part.split(".")[0].toLowerCase());

/** Semver precedence. Build metadata can't occur in a `Version`. */
export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  const [pa, pb] = [SEMVER.exec(a), SEMVER.exec(b)];
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const [xa, xb] = [pa[4].slice(1).split("."), pb[4].slice(1).split(".")];
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const [na, nb] = [/^\d+$/.test(xa[i]), /^\d+$/.test(xb[i])];
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) < Number(xb[i]) ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

class Refusal {
  constructor(readonly problem: ManifestProblem) {}
}
function refuse(problem: ManifestProblem): never {
  throw new Refusal(problem);
}

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

function object(v: unknown, at: string): Raw {
  return isObject(v) ? v : refuse({ kind: "wrongType", at, want: "object" });
}

function noUnknownKeys(o: Raw, allowed: Record<string, true>, prefix: string) {
  for (const key of Object.keys(o)) if (!Object.hasOwn(allowed, key)) refuse({ kind: "unknownKey", at: prefix + key });
}

function required(o: Raw, key: string, prefix: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : refuse({ kind: "missing", at: prefix + key });
}

function string(v: unknown, at: string, max: number): string {
  if (typeof v !== "string") return refuse({ kind: "wrongType", at, want: "string" });
  if (v.length > max) refuse({ kind: "tooLong", at, max });
  return v;
}

function text(v: unknown, at: string, max: number): string {
  const s = string(v, at, max);
  if (s.trim() === "" || BAD_TEXT.test(s)) refuse({ kind: "badText", at });
  return s;
}

function word(v: unknown, at: string, max: number): string {
  const s = string(v, at, max);
  if (!WORD.test(s)) refuse({ kind: "badName", at });
  return s;
}

function list(v: unknown, at: string, max: number): unknown[] {
  if (!Array.isArray(v)) return refuse({ kind: "wrongType", at, want: "array" });
  if (v.length > max) refuse({ kind: "tooMany", at, max });
  return v;
}

function optionalList(o: Raw, key: string, max: number): unknown[] {
  return Object.hasOwn(o, key) ? list(o[key], key, max) : [];
}

function noDuplicates<T extends { [k in K]: string }, K extends string>(items: T[], key: K, at: string) {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item[key])) refuse({ kind: "duplicate", at: `${at}[${i}].${key}`, value: item[key] });
    seen.add(item[key]);
  });
}

function parseId(v: unknown): ExtensionId {
  const s = string(v, "id", Number.MAX_SAFE_INTEGER);
  if (s.length > LIMITS.id || !ID.test(s)) refuse({ kind: "badId", why: "shape" });
  if (s.split(".").some(isDeviceName)) refuse({ kind: "badId", why: "deviceName" });
  return s as ExtensionId;
}

function parseVersion(v: unknown): Version {
  const s = string(v, "version", LIMITS.version);
  if (s.includes("+")) refuse({ kind: "badVersion", why: "buildMetadata" });
  if (!SEMVER.test(s)) refuse({ kind: "badVersion", why: "notSemver" });
  if (/[A-Z]/.test(s)) refuse({ kind: "badVersion", why: "upperCase" });
  return s as Version;
}

function parseApi(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0
    ? v
    : refuse({ kind: "wrongType", at: "api", want: "positive integer" });
}

function parseMain(v: unknown): PackagePath {
  const s = string(v, "main", LIMITS.main);
  const parts = s.split("/");
  if (s === "") refuse({ kind: "badMain", why: "shape" });
  if (parts.some((p) => p === "" || p === "..")) refuse({ kind: "badMain", why: "traversal" });
  if (parts.length > LIMITS.mainParts) refuse({ kind: "tooMany", at: "main", max: LIMITS.mainParts });
  if (!parts.every((p) => PATH_PART.test(p))) refuse({ kind: "badMain", why: "shape" });
  if (parts.some(isDeviceName)) refuse({ kind: "badMain", why: "deviceName" });
  return s as PackagePath;
}

function parseCommands(o: Raw): Command[] {
  const commands = optionalList(o, "commands", LIMITS.commands).map((raw, i): Command => {
    const at = `commands[${i}]`;
    const c = object(raw, at);
    noUnknownKeys(c, COMMAND_KEYS, `${at}.`);
    return {
      name: word(required(c, "name", `${at}.`), `${at}.name`, LIMITS.commandName),
      description: text(required(c, "description", `${at}.`), `${at}.description`, LIMITS.description),
    };
  });
  noDuplicates(commands, "name", "commands");
  return commands;
}

function parseViews(o: Raw): View[] {
  const views = optionalList(o, "views", LIMITS.views).map((raw, i): View => {
    const at = `views[${i}]`;
    const v = object(raw, at);
    noUnknownKeys(v, VIEW_KEYS, `${at}.`);
    return {
      id: word(required(v, "id", `${at}.`), `${at}.id`, LIMITS.viewId),
      title: text(required(v, "title", `${at}.`), `${at}.title`, LIMITS.title),
    };
  });
  noDuplicates(views, "id", "views");
  return views;
}

function parseNames<T extends string>(o: Raw, key: string, known: (v: string) => v is T, unknown: "unknownPermission" | "unknownNeed"): T[] {
  const out: T[] = [];
  optionalList(o, key, Number.MAX_SAFE_INTEGER).forEach((raw, i) => {
    const v = string(raw, `${key}[${i}]`, Number.MAX_SAFE_INTEGER);
    if (!known(v)) refuse({ kind: unknown, value: v });
    if (out.includes(v)) refuse({ kind: "duplicate", at: `${key}[${i}]`, value: v });
    out.push(v);
  });
  return out;
}

const CAPABILITY_IDS: readonly string[] = CAPABILITIES.map((c) => c.id);
const isCapabilityId = (v: string): v is CapabilityId => CAPABILITY_IDS.includes(v);

function check(text_: string): Manifest {
  const bytes = new TextEncoder().encode(text_).length;
  if (bytes > LIMITS.bytes) refuse({ kind: "tooLarge", bytes, max: LIMITS.bytes });
  let json: unknown;
  try {
    json = JSON.parse(text_);
  } catch {
    return refuse({ kind: "notJson" });
  }
  const o = object(json, "");
  const format = o.manifest;
  if (!MANIFEST_FORMATS.some((f) => f === format)) refuse({ kind: "unknownFormat", found: format, reads: MANIFEST_FORMATS });
  noUnknownKeys(o, MANIFEST_KEYS, "");
  return {
    manifest: 1,
    id: parseId(required(o, "id", "")),
    name: text(required(o, "name", ""), "name", LIMITS.name),
    version: parseVersion(required(o, "version", "")),
    api: parseApi(required(o, "api", "")),
    main: parseMain(required(o, "main", "")),
    commands: parseCommands(o),
    views: parseViews(o),
    permissions: parseNames(o, "permissions", isPermission, "unknownPermission"),
    needs: parseNames(o, "needs", isCapabilityId, "unknownNeed"),
  };
}

/** Parses a manifest's text, and returns the first problem it finds. */
export function parseManifest(text_: string): Parsed {
  try {
    return { ok: true, manifest: check(text_) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, problem: e.problem };
    throw e;
  }
}

/** Whether the app can run this manifest. An `api` the app doesn't run wins over a disabling. */
export function installStatus(m: Manifest, disabled?: "owner" | "failures"): InstallStatus {
  if (m.api !== EXTENSION_API) return { kind: "incompatible", needsApi: m.api, runsApi: EXTENSION_API };
  return disabled ? { kind: "disabled", why: disabled } : { kind: "usable" };
}

/** What happens when the owner picks `candidate` over the installed version, given the grants the owner holds now. */
export function planUpdate(installed: { manifest: Manifest; grants: readonly Permission[] }, candidate: Manifest): UpdatePlan {
  if (candidate.id !== installed.manifest.id) return { kind: "refuse", why: "otherId" };
  if (candidate.api !== EXTENSION_API) {
    return { kind: "refuse", why: "incompatible", needsApi: candidate.api, runsApi: EXTENSION_API };
  }
  const order = compareVersions(candidate.version, installed.manifest.version);
  if (order === 0) return { kind: "refuse", why: "sameVersion" };
  const asks = candidate.permissions.filter((p) => !installed.grants.includes(p));
  const drops = installed.grants.filter((p) => !candidate.permissions.includes(p));
  const wipesStorage = drops.some((p) => PERMISSIONS[p].wipesStorage);
  if (order < 0) {
    return { kind: "confirmDowngrade", from: installed.manifest.version, to: candidate.version, asks, drops, wipesStorage };
  }
  return asks.length > 0 ? { kind: "pending", asks, drops, wipesStorage } : { kind: "apply", drops, wipesStorage };
}
