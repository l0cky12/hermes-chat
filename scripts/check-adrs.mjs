// Fails when two ADRs in docs/adr share a number, and prints the highest number in use (a new ADR takes the next).
//
//   node scripts/check-adrs.mjs
//
// HERMES_CHAT_ROOT points it at another checkout (the tests use a scratch one).

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.HERMES_CHAT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "docs/adr");
const byNumber = Map.groupBy(
  readdirSync(dir).sort().filter((f) => /^\d{4}-.*\.md$/.test(f)),
  (f) => f.slice(0, 4),
);
const taken = [...byNumber].filter(([, files]) => files.length > 1);
for (const [number, files] of taken) console.error(`ADR ${number} is taken by ${files.length} files:\n  ${files.join("\n  ")}`);
console.log(`Highest ADR number in use: ${[...byNumber.keys()].sort().at(-1)}`);
if (taken.length) {
  console.error("Renumber the later-merged file(s) to the next free numbers and update every reference to them.");
  process.exit(1);
}
