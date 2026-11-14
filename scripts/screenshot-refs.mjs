// Lists every tracked file under docs/screenshots and what references it, so stale screenshots can be removed.
//
//   node scripts/screenshot-refs.mjs             totals, each folder, and each unreferenced image
//   node scripts/screenshot-refs.mjs --all       also each referenced image and what references it
//   node scripts/screenshot-refs.mjs --delete    git rm every file nothing references
//   --offline                                    skip PR and issue text from GitHub
//   --github <file>                              read PR and issue text from a saved
//                                                `gh pr list --json number,body,comments` dump (an array; several
//                                                --github flags add up) instead of asking gh
//
// A file under docs/screenshots is referenced when a tracked text file outside it names the file: by repo path, by a
// path relative to the naming file, in a link, or (an image) by its bare file name. Naming a folder names everything in
// it. A referenced text file there (a verification record, a stand-in script) counts as naming what it names in turn,
// and a referenced Markdown note keeps its whole folder, since records cite their images by number ("Image 3").
// A PR or issue that links a file through a branch name (`.../blob/main/docs/screenshots/...`) references it, since
// deleting it would break that link; a link pinned to a commit keeps working. docs/screenshots/improvement-report/ is
// always kept. Whatever is left unreferenced is named only by other unreferenced files, so deleting it breaks no link.
//
// HERMES_CHAT_ROOT points it at another checkout (the tests use a scratch one).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.HERMES_CHAT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const SHOTS = "docs/screenshots/";
const PROTECTED = `${SHOTS}improvement-report/`;
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|bmp|woff2?|ttf|otf|zip|gz|tar|wasm|pdf|mp3|mp4|webm|ogg|wav)$/i;
const REPO_LINK =
  /(?:github\.com\/l0cky12\/hermes-chat\/(?:blob|raw|tree)\/|raw\.githubusercontent\.com\/l0cky12\/hermes-chat\/)(\S+?)\/(docs\/screenshots\/[^\s)"'<>\]?#]*)/g;

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
const shots = tracked.filter((f) => f.startsWith(SHOTS));
const shotSet = new Set(shots);
const byName = Map.groupBy(
  shots.filter((f) => IMAGE.test(f)),
  (f) => posix.basename(f),
);
const sizes = new Map(
  git("ls-files", "-s", "-z", "--", SHOTS)
    .split("\0")
    .filter(Boolean)
    .map((line) => [line.split("\t")[1], line.split(" ")[1]]),
);
const blobBytes = new Map(
  execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objectsize)"], { cwd: root, encoding: "utf8", input: [...sizes.values()].join("\n") })
    .trim()
    .split("\n")
    .map((line) => line.split(" ")),
);
const mb = (files) => (files.reduce((n, f) => n + Number(blobBytes.get(sizes.get(f))), 0) / 1e6).toFixed(1);

/** @type {Map<string, Set<string>>} each referenced file under docs/screenshots, with what references it */
const reasons = new Map();
/** @type {string[]} referenced text files under docs/screenshots not scanned yet */
const queue = [];
function reach(file, why) {
  if (!reasons.has(file)) {
    reasons.set(file, new Set());
    if (!BINARY.test(file)) queue.push(file);
  }
  reasons.get(file).add(why);
}
/** Reaches what `path` (a repo path, maybe a folder) names, or returns false when it names nothing tracked. */
function reachPath(path, why) {
  const p = posix.normalize(path).replace(/\/$/, "");
  if (!p.startsWith(SHOTS)) return false;
  if (shotSet.has(p)) return (reach(p, why), true);
  const inside = shots.filter((f) => f.startsWith(`${p}/`));
  for (const f of inside) reach(f, why);
  return inside.length > 0;
}

function scanText(file) {
  const text = readFileSync(resolve(root, file), "utf8");
  for (const token of text.match(/[\w.~/+-]+/g) ?? []) {
    const at = token.indexOf(SHOTS);
    if (at >= 0 && (at === 0 || token[at - 1] === "/") && reachPath(token.slice(at), file)) continue;
    const relative = posix.join(posix.dirname(file), token).replace(/\/$/, "");
    if (!`${file}/`.startsWith(`${relative}/`) && reachPath(relative, file)) continue;
    for (const f of byName.get(posix.basename(token)) ?? []) reach(f, `${file} (file name)`);
  }
}

function githubTexts() {
  const saved = args.flatMap((a, i) => (args[i - 1] === "--github" ? [a] : []));
  const lists = saved.length
    ? saved.map((f) => JSON.parse(readFileSync(f, "utf8")))
    : ["pr", "issue"].map((kind) =>
        JSON.parse(execFileSync("gh", [kind, "list", "--state", "all", "--limit", "5000", "--json", "number,body,comments"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })),
      );
  return lists.flat().flatMap((x) => [x.body ?? "", ...(x.comments ?? []).map((c) => c.body ?? "")].map((text) => ({ number: x.number, text })));
}

for (const f of shots) if (f.startsWith(PROTECTED)) reach(f, "always kept");
for (const f of tracked) if (!f.startsWith(SHOTS) && !BINARY.test(f)) scanText(f);
if (!args.includes("--offline"))
  for (const { number, text } of githubTexts())
    for (const [, ref, path] of text.matchAll(REPO_LINK)) if (!/^[0-9a-f]{7,40}$/.test(ref)) reachPath(path, `GitHub #${number} (${ref})`);
while (queue.length) {
  const file = /** @type {string} */ (queue.pop());
  if (file.endsWith(".md")) reachPath(posix.dirname(file), `${file} (its folder)`);
  scanText(file);
}

const folderOf = (f) => f.slice(0, f.indexOf("/", SHOTS.length) + 1) || f;
const kept = shots.filter((f) => reasons.has(f));
const dropped = shots.filter((f) => !reasons.has(f));
const images = (files) => files.filter((f) => IMAGE.test(f));

console.log(`docs/screenshots: ${shots.length} files (${images(shots).length} images), ${mb(shots)} MB`);
console.log(`referenced: ${kept.length} files (${images(kept).length} images), ${mb(kept)} MB`);
console.log(`unreferenced: ${dropped.length} files (${images(dropped).length} images), ${mb(dropped)} MB\n`);
console.log("folder: referenced images / images (referenced files / files)");
for (const [folder, files] of Map.groupBy(shots, folderOf)) {
  const k = files.filter((f) => reasons.has(f));
  console.log(`  ${folder}: ${images(k).length} / ${images(files).length} (${k.length} / ${files.length})`);
}
if (args.includes("--all")) {
  console.log("\nreferenced images:");
  for (const f of images(kept)) console.log(`  ${f}\n    <- ${[...(reasons.get(f) ?? [])].join("; ")}`);
}
console.log("\nunreferenced images:");
for (const f of images(dropped)) console.log(`  ${f}`);

if (args.includes("--delete") && dropped.length) {
  for (let i = 0; i < dropped.length; i += 500) git("rm", "-q", "--", ...dropped.slice(i, i + 500));
  console.log(`\nremoved ${dropped.length} files`);
}
