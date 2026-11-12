// Keeps the app's version the same in every file that carries it (docs/releases.md, "Choosing the version").
//
//   node scripts/release/version.mjs bump <patch|minor|major|x.y.z[-pre]>
//   node scripts/release/version.mjs check [v<version> tag]
//
// `bump` reads the version from src-tauri/tauri.conf.json, works out the next one, and writes it into all five
// files below, changing only their version fields. `check` fails when the five disagree, or when a tag is given
// and names another version. HERMES_CHAT_ROOT points both at another checkout (the tests use a scratch copy).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// semver.org's grammar: no leading zeros in numbers, no empty prerelease identifiers.
const NUM = "(0|[1-9]\\d*)";
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(-${PRE_ID}(?:\\.${PRE_ID})*)?$`);

export const FILES = {
  tauri: "src-tauri/tauri.conf.json",
  npm: "package.json",
  npmLock: "package-lock.json",
  cargo: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
};

/** The version after `current` for a level, or `target` itself when it is a version. */
export function nextVersion(current, target) {
  const cur = SEMVER.exec(current);
  if (!cur) throw new Error(`the current version ${current} isn't semver`);
  const [major, minor, patch] = cur.slice(1, 4).map(Number);
  const pre = cur[4];
  switch (target) {
    // A prerelease's patch bump releases it (1.0.0-beta.1 → 1.0.0), as semver orders them.
    case "patch":
      return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
    case "minor":
      return pre && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
    case "major":
      return pre && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
  }
  if (!SEMVER.test(target)) throw new Error(`${target} isn't patch, minor, major or a semver version`);
  if (compare(target, current) <= 0) throw new Error(`${target} isn't newer than ${current}`);
  return target;
}

/** Semver precedence, enough for x.y.z with an optional dot-separated prerelease. */
export function compare(a, b) {
  const [pa, pb] = [SEMVER.exec(a), SEMVER.exec(b)];
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const [xa, xb] = [pa[4].slice(1).split("."), pb[4].slice(1).split(".")];
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const [na, nb] = [/^\d+$/.test(xa[i]), /^\d+$/.test(xb[i])];
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Math.sign(Number(xa[i]) - Number(xb[i]));
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

function read(root, file) {
  return readFileSync(join(root, file), "utf8");
}

/** The `[package]` table's own lines in Cargo.toml: from its header to the next table. */
function cargoPackage(text) {
  const start = text.search(/^\[package\]\s*$/m);
  if (start < 0) throw new Error(`${FILES.cargo} has no [package] table`);
  const rest = text.slice(start + 1);
  const next = rest.search(/^\[/m);
  return { start, end: next < 0 ? text.length : start + 1 + next };
}

// Line ends may be CRLF (a Windows checkout); the patterns keep whichever the file has.
const CARGO_VERSION = /^(version = ")([^"]*)(")/m;
const LOCK_ENTRY = /(\[\[package\]\]\r?\nname = "hermes-chat"\r?\nversion = ")([^"]*)(")/g;

/** Every version the five files carry, by where it was found. */
export function versions(root) {
  const tauri = JSON.parse(read(root, FILES.tauri));
  const npm = JSON.parse(read(root, FILES.npm));
  const lock = JSON.parse(read(root, FILES.npmLock));
  const cargo = read(root, FILES.cargo);
  const pkg = cargoPackage(cargo);
  const lockEntries = [...read(root, FILES.cargoLock).matchAll(LOCK_ENTRY)];
  if (lockEntries.length !== 1) throw new Error(`${FILES.cargoLock} has ${lockEntries.length} hermes-chat entries, not one`);
  return {
    [FILES.tauri]: tauri.version,
    [FILES.npm]: npm.version,
    [`${FILES.npmLock} (root)`]: lock.version,
    [`${FILES.npmLock} (packages[""])`]: lock.packages?.[""]?.version,
    [`${FILES.cargo} ([package])`]: CARGO_VERSION.exec(cargo.slice(pkg.start, pkg.end))?.[2],
    [FILES.cargoLock]: lockEntries[0][2],
  };
}

/** Throws, naming each file, unless every version agrees (and equals the tag's, when one is given). */
export function check(root, tag) {
  const found = versions(root);
  let want = found[FILES.tauri];
  if (!SEMVER.test(want ?? "")) throw new Error(`${FILES.tauri} says ${want ?? "no version"}, which isn't semver`);
  if (tag !== undefined) {
    const m = /^v(.+)$/.exec(tag);
    if (!m || !SEMVER.test(m[1])) throw new Error(`${tag} isn't a v<semver> tag`);
    want = m[1];
  }
  const wrong = Object.entries(found).filter(([, v]) => v !== want);
  if (wrong.length) {
    const lines = wrong.map(([where, v]) => `  ${where}: ${v ?? "(missing)"}`).join("\n");
    const fix = tag === undefined ? "run scripts/release/version.mjs bump" : `bump to ${want} before tagging ${tag}`;
    throw new Error(`these don't say ${want}:\n${lines}\nTo fix, ${fix}.`);
  }
  return want;
}

// The top-level "version" (two-space indent), and the one inside package-lock.json's `packages[""]`.
const JSON_ROOT = /^( {2}"version": ")[^"]*(")/m;
const LOCK_SELF = /^( {4}"": \{\r?\n(?: {6}[^\n]*\n)*? {6}"version": ")[^"]*(")/m;

/** Sets each field the patterns find, then checks the file parses to exactly `expected`. */
function setJson(text, patterns, to, expected, file) {
  let out = text;
  for (const pattern of patterns) {
    if (!pattern.test(out)) throw new Error(`couldn't find the version in ${file}`);
    out = out.replace(pattern, `$1${to}$2`);
  }
  if (!isDeepStrictEqual(JSON.parse(out), expected)) throw new Error(`couldn't set the version in ${file}`);
  return out;
}

/** Writes the next version into every file and returns it. Writes nothing unless the files agree first. */
export function bump(root, target) {
  const current = check(root);
  const next = nextVersion(current, target);

  const edits = {};
  for (const file of [FILES.tauri, FILES.npm]) {
    const text = read(root, file);
    edits[file] = setJson(text, [JSON_ROOT], next, { ...JSON.parse(text), version: next }, file);
  }
  const lockText = read(root, FILES.npmLock);
  const lock = JSON.parse(lockText);
  lock.version = next;
  lock.packages[""].version = next;
  edits[FILES.npmLock] = setJson(lockText, [JSON_ROOT, LOCK_SELF], next, lock, FILES.npmLock);

  const cargo = read(root, FILES.cargo);
  const pkg = cargoPackage(cargo);
  edits[FILES.cargo] =
    cargo.slice(0, pkg.start) + cargo.slice(pkg.start, pkg.end).replace(CARGO_VERSION, `$1${next}$3`) + cargo.slice(pkg.end);
  edits[FILES.cargoLock] = read(root, FILES.cargoLock).replace(LOCK_ENTRY, `$1${next}$3`);

  for (const [file, text] of Object.entries(edits)) writeFileSync(join(root, file), text);
  check(root);
  return { from: current, to: next };
}

/** @param {string[]} argv */
function main([command, arg]) {
  const root = process.env.HERMES_CHAT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (command === "bump" && arg) {
    const { from, to } = bump(root, arg);
    console.log(`${from} → ${to} in ${Object.values(FILES).join(", ")}`);
  } else if (command === "check") {
    console.log(`every version file says ${check(root, arg)}`);
  } else {
    throw new Error("usage: version.mjs bump <patch|minor|major|x.y.z> | version.mjs check [v<version>]");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
