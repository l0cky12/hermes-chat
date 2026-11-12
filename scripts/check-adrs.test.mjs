import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the check on a scratch checkout whose docs/adr holds `files`. */
function check(files) {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-adrs-"));
  dirs.push(root);
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  for (const f of files) writeFileSync(join(root, "docs/adr", f), "# ADR\n");
  const run = spawnSync(process.execPath, ["scripts/check-adrs.mjs"], { encoding: "utf8", env: { ...process.env, HERMES_CHAT_ROOT: root } });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

it("passes when every ADR has a number of its own, and prints the highest", () => {
  const { code, out } = check(["0001-first.md", "0010-tenth.md", "0002-second.md", "README.md"]);
  expect(code).toBe(0);
  expect(out).toContain("Highest ADR number in use: 0010");
});

it("fails on two ADRs with one number, and names both", () => {
  const { code, out, err } = check(["0001-first.md", "0002-one.md", "0002-other.md", "0003-third.md"]);
  expect(code).toBe(1);
  expect(err).toContain("ADR 0002 is taken by 2 files:\n  0002-one.md\n  0002-other.md");
  expect(err).not.toContain("ADR 0001");
  expect(out).toContain("Highest ADR number in use: 0003");
});
