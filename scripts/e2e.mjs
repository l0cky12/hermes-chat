import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { startVitest } from "vitest/node";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const featuresDir = join(root, "e2e/features");
const out = join(root, "e2e/out");
const features = readdirSync(featuresDir).filter((f) => f.endsWith(".e2e.tsx")).map((f) => f.slice(0, -".e2e.tsx".length)).sort();

const help = `Usage: npm run e2e -- [--feature <name>]... [-t <pattern>] [--list]

  --feature, -f <name>  Run only this feature: a file stem in e2e/features. Repeat it or give a comma list.
  --grep, -t <pattern>  Run only the tests whose name matches the pattern.
  --list                Print the feature names.
  --help, -h            Print this.

Exit code: 0 every test passed, 1 a test failed or none ran, 2 a bad argument.

Features: ${features.join(", ")}`;

let args;
try {
  args = parseArgs({
    options: { feature: { type: "string", short: "f", multiple: true }, grep: { type: "string", short: "t" }, list: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  }).values;
} catch (e) {
  console.error(`${e.message}\n\n${help}`);
  process.exit(2);
}
if (args.help) {
  console.log(help);
  process.exit(0);
}
if (args.list) {
  console.log(features.join("\n"));
  process.exit(0);
}
const picked = (args.feature ?? []).flatMap((f) => f.split(",")).map((f) => f.trim()).filter(Boolean);
const unknown = picked.filter((f) => !features.includes(f));
if (unknown.length) {
  console.error(`Unknown feature: ${unknown.join(", ")}. Features: ${features.join(", ")}`);
  process.exit(2);
}

const LABEL = { passed: "PASS", failed: "FAIL" };
const rel = (path) => relative(root, path);
const text = (e) => stripVTControlCharacters(e.message ?? String(e));
let summary;

/** @type {import("vitest/node").Reporter} */
const reporter = {
  onTestRunEnd(modules, unhandledErrors) {
    const unhandledCommands = new Set();
    const rows = modules.map((m) => {
      const name = m.moduleId.split("/").at(-1).slice(0, -".e2e.tsx".length);
      const tests = [...m.children.allTests()].map((t) => {
        const result = t.result();
        const notes = t.annotations();
        for (const a of notes) if (a.type === "unhandled-command") unhandledCommands.add(a.message);
        const failure = t.artifacts().filter((a) => a.type === "internal:failureScreenshot").map((a) => rel(a.attachments[0].originalPath));
        return {
          name: t.fullName,
          status: result.state === "pending" ? "skipped" : result.state,
          durationMs: Math.round(t.diagnostic()?.duration ?? 0),
          errors: (result.errors ?? []).map(text),
          screenshots: [...notes.filter((a) => a.type === "screenshot").map((a) => a.message), ...failure],
        };
      });
      const errors = [...m.errors(), ...[...m.children.allSuites()].flatMap((s) => s.errors())].map(text);
      return { name, file: rel(m.moduleId), ok: m.state() !== "failed" && !errors.length && tests.every((t) => t.status !== "failed"), errors, tests };
    });
    const all = rows.flatMap((f) => f.tests);
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const t of all) counts[t.status]++;
    summary = {
      ok: counts.passed > 0 && !unhandledErrors.length && rows.every((f) => f.ok),
      durationMs: Math.round(performance.now() - started),
      counts,
      features: rows,
      unhandledErrors: unhandledErrors.map(text),
      unhandledCommands: [...unhandledCommands].sort(),
    };
  },
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const started = performance.now();
const vitest = await startVitest(
  picked.map((f) => `e2e/features/${f}.e2e.tsx`),
  { config: join(root, "e2e/vitest.config.ts"), root, run: true, watch: false, reporters: [reporter], testNamePattern: args.grep, passWithNoTests: true },
);
await vitest.close();
if (!summary) {
  console.error("Vitest stopped before it reported a result.");
  process.exit(1);
}

for (const f of summary.features) {
  for (const e of f.errors) console.log(`FAIL ${f.name} (outside a test: the file didn't load or a hook failed)\n${indent(e)}`);
  for (const t of f.tests.filter((t) => t.status !== "skipped")) {
    console.log(`${LABEL[t.status]} ${f.name} › ${t.name} (${t.durationMs} ms)`);
    if (t.status === "failed") for (const line of [...t.errors, ...t.screenshots.filter((s) => s.includes("failure-screenshots"))]) console.log(indent(line));
  }
}
for (const e of summary.unhandledErrors) console.log(`ERROR outside a test\n${indent(e)}`);
const { passed, failed, skipped } = summary.counts;
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped in ${(summary.durationMs / 1000).toFixed(1)} s`);
if (!passed && !failed) console.log(args.grep ? `No test matched -t ${JSON.stringify(args.grep)}.` : "No test ran.");
if (summary.unhandledCommands.length) console.log(`Commands no handler answered: ${summary.unhandledCommands.join(", ")}`);
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`Summary: ${rel(join(out, "summary.json"))}\nScreenshots: ${rel(join(out, "screenshots"))}/`);
process.exit(summary.ok ? 0 : 1);

function indent(s) {
  return s.replace(/^/gm, "    ");
}
