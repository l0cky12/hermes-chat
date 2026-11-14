import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch git checkout holding `files` (path → text), all committed. */
function checkout(files) {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-shots-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "shots"], { cwd: root });
  return root;
}

function run(root, ...args) {
  const r = spawnSync(process.execPath, ["scripts/screenshot-refs.mjs", ...args], { encoding: "utf8", env: { ...process.env, HERMES_CHAT_ROOT: root } });
  expect(r.stderr).toBe("");
  return r.stdout;
}

const tracked = (root) => execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n");

it("keeps what docs name, by repo path, relative path, folder or file name, and deletes the rest", () => {
  const root = checkout({
    "README.md": "![chat](docs/screenshots/readme/chat.png)\nSee [the record](docs/screenshots/voice/README.md).",
    "docs/adr/0001-x.md": "Shots in ../screenshots/worktrees/ and `only-name.png`.",
    "docs/screenshots/readme/chat.png": "png",
    "docs/screenshots/readme/old.png": "png",
    "docs/screenshots/voice/README.md": "| Image | What |\n| 1 | Listening |\nStand-in: `../shared/bridge.ts`.",
    "docs/screenshots/voice/1-listening.png": "png",
    "docs/screenshots/shared/bridge.ts": "// docs/screenshots/shared/bridge.ts serves FakeHermes",
    "docs/screenshots/shared/9-unrelated.png": "png",
    "docs/screenshots/worktrees/a.png": "png",
    "docs/screenshots/misc/only-name.png": "png",
    "docs/screenshots/stale/before-x.png": "png",
    "docs/screenshots/stale/notes.md": "![x](before-x.png)",
    "docs/screenshots/improvement-report/D/x-before.png": "png",
  });
  const out = run(root, "--offline", "--delete");
  expect(out).toContain("removed 4 files");
  expect(tracked(root).filter((f) => f.startsWith("docs/screenshots/"))).toEqual([
    "docs/screenshots/improvement-report/D/x-before.png",
    "docs/screenshots/misc/only-name.png",
    "docs/screenshots/readme/chat.png",
    "docs/screenshots/shared/bridge.ts",
    "docs/screenshots/voice/1-listening.png",
    "docs/screenshots/voice/README.md",
    "docs/screenshots/worktrees/a.png",
  ]);
  expect(run(root, "--offline")).toContain("unreferenced: 0 files");
});

it("keeps an image a PR links through a branch name, not one pinned to a commit", () => {
  const root = checkout({
    "README.md": "nothing here",
    "docs/screenshots/a/branch.png": "png",
    "docs/screenshots/a/pinned.png": "png",
  });
  const prs = join(root, "prs.json");
  writeFileSync(
    prs,
    JSON.stringify([
      { number: 7, body: "![b](https://github.com/l0cky12/hermes-chat/blob/feat/x-1/docs/screenshots/a/branch.png?raw=true)", comments: [] },
      { number: 8, body: "", comments: [{ body: "![p](https://raw.githubusercontent.com/l0cky12/hermes-chat/0123abcd/docs/screenshots/a/pinned.png)" }] },
    ]),
  );
  const out = run(root, "--github", prs, "--all");
  expect(out).toContain("docs/screenshots/a/branch.png\n    <- GitHub #7 (feat/x-1)");
  expect(out).toMatch(/unreferenced images:\n {2}docs\/screenshots\/a\/pinned\.png/);
});
