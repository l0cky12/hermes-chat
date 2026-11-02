// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { persist, unsaved } from "./unsaved";
import { checkPackage, needsAttention, parseGitPkgver, releaseNotes, restoreDrafts, snapshotDrafts, updater, type Install, type Progress, type UpdateDeps } from "./updates";

const NOW = Date.UTC(2026, 10, 2, 12);
const pacman = (running: string, installed: string | null = running): Extract<Install, { kind: "pacman" }> => ({
  kind: "pacman",
  package: "hermes-chat-git",
  running,
  installed,
});
const commit = (sha: string, message: string, parents = 1) => ({ sha, commit: { message }, parents: Array(parents).fill({}) });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const fetchOnce = (res: Response | Error) => vi.fn<typeof fetch>(async () => (res instanceof Error ? Promise.reject(res) : res));

describe("parseGitPkgver", () => {
  it("reads the commit count and commit from a hermes-chat-git version", () => {
    expect(parseGitPkgver("r312.ef433a2-1")).toEqual({ count: 312, commit: "ef433a2" });
    expect(parseGitPkgver("r312.ef433a2")).toEqual({ count: 312, commit: "ef433a2" });
    expect(parseGitPkgver("2:r7.0123456789abcdef-3.1")).toEqual({ count: 7, commit: "0123456789abcdef" });
  });
  it("refuses anything else", () => {
    for (const v of ["0.1.0-1", "r312-1", "r312.xyz1234-1", "r312.abc12-1", "", "1.2.3.r4.gabc1234-1"]) expect(parseGitPkgver(v)).toBeNull();
  });
});

describe("releaseNotes", () => {
  it("lists merged pull requests by title, newest first, leaving out branch merges", () => {
    const notes = releaseNotes([
      commit("a", "Add a sticky model picker"),
      commit("b", "Merge pull request #36 from l0cky12/composer-model-picker\n\nAdd a sticky model picker and reasoning pill", 2),
      commit("c", "Merge remote-tracking branch 'origin/main' into appearance-themes", 2),
      commit("d", "Merge pull request #37 from l0cky12/appearance-themes\n\nAppearance themes", 2),
    ]);
    expect(notes).toEqual([{ text: "#37 Appearance themes" }, { text: "#36 Add a sticky model picker and reasoning pill" }]);
  });
  it("falls back to each commit's first line when nothing came through a pull request", () => {
    expect(releaseNotes([commit("a", "Fix one\n\nbody"), commit("b", "Merge branch 'x'", 2), commit("c", "Fix two")])).toEqual([{ text: "Fix two" }, { text: "Fix one" }]);
  });
});

describe("checkPackage", () => {
  it("is up to date when main is the installed commit", async () => {
    const get = fetchOnce(json({ status: "identical", ahead_by: 0, behind_by: 0, commits: [] }));
    expect(await checkPackage(pacman("r312.ef433a2-1"), get, NOW)).toEqual({ state: "upToDate", version: "r312.ef433a2-1", note: undefined, checkedAt: NOW });
    expect(get).toHaveBeenCalledWith("https://api.github.com/repos/l0cky12/hermes-chat/compare/ef433a2...main", expect.anything());
  });

  it("is up to date, with a note, when the build is ahead of main", async () => {
    const s = await checkPackage(pacman("r312.ef433a2-1"), fetchOnce(json({ status: "behind", ahead_by: 0, behind_by: 2, commits: [] })), NOW);
    expect(s).toMatchObject({ state: "upToDate", note: expect.stringContaining("main doesn't have") });
  });

  it("offers main's pkgver, the notes and the package step when main is ahead", async () => {
    const commits = [commit("1111111aaa", "Fix"), commit("2222222bbb", "Merge pull request #38 from l0cky12/status-bar\n\nStatus bar", 2)];
    const s = await checkPackage(
      pacman("r312.ef433a2-1"),
      fetchOnce(json({ status: "ahead", ahead_by: 2, behind_by: 0, commits, html_url: "https://github.com/l0cky12/hermes-chat/compare/ef433a2...main" })),
      NOW,
    );
    expect(s).toEqual({
      state: "available",
      checkedAt: NOW,
      found: {
        from: "r312.ef433a2-1",
        to: "r314.2222222",
        notes: [{ text: "#38 Status bar" }],
        more: 0,
        via: "pacman",
        allUrl: "https://github.com/l0cky12/hermes-chat/compare/ef433a2...main",
        warning: undefined,
        command: "git pull && cd packaging/aur && makepkg -si",
      },
    });
  });

  it("names no commit, and counts the rest, when GitHub cut the list short", async () => {
    const commits = Array.from({ length: 250 }, (_, i) => commit(`${i}`.padStart(7, "0"), `Change ${i}`));
    const s = await checkPackage(pacman("r10.ef433a2-1"), fetchOnce(json({ status: "ahead", ahead_by: 300, behind_by: 0, commits })), NOW);
    expect(s).toMatchObject({ state: "available", found: { to: "r310", more: 280 } });
    if (s.state === "available") expect(s.found.notes).toHaveLength(20);
  });

  it("warns that branch commits go when the build has diverged from main", async () => {
    const s = await checkPackage(pacman("r312.ef433a2-1"), fetchOnce(json({ status: "diverged", ahead_by: 1, behind_by: 3, commits: [commit("3333333ccc", "Fix")] })), NOW);
    expect(s).toMatchObject({ state: "available", found: { to: "main (3333333)", warning: expect.stringContaining("aren't on main") } });
  });

  it("doesn't compare a package that isn't a build from main", async () => {
    const get = vi.fn<typeof fetch>();
    const s = await checkPackage({ ...pacman("0.2.0-1"), package: "hermes-chat" }, get, NOW);
    expect(s).toMatchObject({ state: "unsupported", reason: expect.stringContaining("package manager") });
    expect(get).not.toHaveBeenCalled();
  });

  it("says when GitHub doesn't know the commit", async () => {
    const s = await checkPackage(pacman("r312.ef433a2-1"), fetchOnce(json({ message: "Not Found" }, 404)), NOW);
    expect(s).toEqual({ state: "error", message: expect.stringContaining("doesn't know commit ef433a2") });
  });

  it("says when to try again after GitHub's rate limit", async () => {
    const reset = String(Math.floor(NOW / 1000) + 600);
    const s = await checkPackage(pacman("r312.ef433a2-1"), fetchOnce(json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset })), NOW);
    expect(s).toEqual({ state: "error", message: expect.stringMatching(/too many update checks.*Try again after/) });
  });

  it("reports other refusals, an unreachable GitHub and a garbled answer", async () => {
    expect(await checkPackage(pacman("r1.ef433a2"), fetchOnce(new Response("down", { status: 502 })), NOW)).toEqual({
      state: "error",
      message: "GitHub answered 502 to the update check: down",
    });
    expect(await checkPackage(pacman("r1.ef433a2"), fetchOnce(new TypeError("Load failed")), NOW)).toEqual({
      state: "error",
      message: "Couldn't reach GitHub to check for updates: Load failed",
    });
    expect(await checkPackage(pacman("r1.ef433a2"), fetchOnce(new Response("<html>", { status: 200 })), NOW)).toMatchObject({
      state: "error",
      message: expect.stringContaining("didn't make sense"),
    });
    expect(await checkPackage(pacman("r1.ef433a2"), fetchOnce(json({ status: "ahead" })), NOW)).toMatchObject({ state: "error" });
  });
});

/** An updater on scripted commands. `answers` maps a command to its result, or a function of its args. */
function setup(answers: Record<string, unknown>, opts: { fetch?: typeof fetch; storage?: Storage } = {}) {
  const channels: ((p: Progress) => void)[] = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const a = answers[cmd];
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a(args) : a;
  });
  const deps: UpdateDeps = {
    invoke: invoke as UpdateDeps["invoke"],
    channel: (fn) => (channels.push(fn), `channel-${channels.length}`),
    fetch: opts.fetch ?? vi.fn<typeof fetch>(),
    storage: opts.storage ?? localStorage,
    now: () => NOW,
  };
  return { u: updater(deps), invoke, channels };
}

describe("updater", () => {
  it("asks to restart, without asking GitHub, when pacman installed a newer version meanwhile", async () => {
    const get = vi.fn<typeof fetch>();
    const { u } = setup({ update_install_kind: pacman("r312.ef433a2-1", "r320.0ea12a7-1") }, { fetch: get });
    await u.check();
    expect(u.getSnapshot()).toEqual({ state: "restart", from: "r312.ef433a2-1", to: "r320.0ea12a7-1" });
    expect(get).not.toHaveBeenCalled();
  });

  it("checks GitHub for a pacman install, and never installs it itself", async () => {
    const { u, invoke } = setup(
      { update_install_kind: pacman("r312.ef433a2-1") },
      { fetch: fetchOnce(json({ status: "ahead", ahead_by: 1, behind_by: 0, commits: [commit("4444444", "Fix")] })) },
    );
    await u.check();
    expect(u.getSnapshot()).toMatchObject({ state: "available", found: { via: "pacman", to: "r313.4444444" } });
    await u.install();
    expect(invoke).not.toHaveBeenCalledWith("update_download_and_install", expect.anything());
    expect(u.getSnapshot().state).toBe("available");
  });

  it("only looks for pacman's install on a quiet re-check, keeping the update shown", async () => {
    let installed = "r312.ef433a2-1";
    const get = fetchOnce(json({ status: "ahead", ahead_by: 1, behind_by: 0, commits: [commit("4444444", "Fix")] }));
    const { u } = setup({ update_install_kind: () => pacman("r312.ef433a2-1", installed) }, { fetch: get });
    await u.check({ installedOnly: true });
    expect(u.getSnapshot().state).toBe("idle");
    await u.check();
    await u.check({ installedOnly: true });
    expect(u.getSnapshot().state).toBe("available");
    installed = "r313.4444444-1";
    await u.check({ installedOnly: true });
    expect(u.getSnapshot()).toEqual({ state: "restart", from: "r312.ef433a2-1", to: "r313.4444444-1" });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("notices pacman's install on a quiet re-check from any settled state", async () => {
    for (const first of [{ status: "identical", ahead_by: 0, behind_by: 0, commits: [] }, null]) {
      let installed = "r312.ef433a2-1";
      const get = first ? fetchOnce(json(first)) : vi.fn<typeof fetch>(async () => Promise.reject(new Error("offline")));
      const { u } = setup({ update_install_kind: () => pacman("r312.ef433a2-1", installed) }, { fetch: get });
      await u.check();
      expect(u.getSnapshot().state).toBe(first ? "upToDate" : "error");
      installed = "r313.4444444-1";
      await u.check({ installedOnly: true });
      expect(u.getSnapshot()).toEqual({ state: "restart", from: "r312.ef433a2-1", to: "r313.4444444-1" });
    }
  });

  it("doesn't let a slower check replace the restart a quicker one found", async () => {
    // Each update_install_kind call answers in turn: the first full check, the quiet re-check (pacman has installed
    // the update), then the overlapping full check (from before pacman did).
    const kinds = [pacman("r312.ef433a2-1"), pacman("r312.ef433a2-1", "r313.4444444-1"), pacman("r312.ef433a2-1")];
    const ahead = () => json({ status: "ahead", ahead_by: 1, behind_by: 0, commits: [commit("4444444", "Fix")] });
    const get = vi.fn<typeof fetch>(async () => ahead());
    const { u } = setup({ update_install_kind: () => kinds.shift() }, { fetch: get });
    await u.check();
    const quiet = u.check({ installedOnly: true });
    const full = u.check();
    await Promise.all([quiet, full]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(u.getSnapshot()).toEqual({ state: "restart", from: "r312.ef433a2-1", to: "r313.4444444-1" });
  });

  it("doesn't let a slower check replace a failed restart, so it can be tried again", async () => {
    const kinds = [pacman("r312.ef433a2-1"), pacman("r312.ef433a2-1", "r313.4444444-1"), pacman("r312.ef433a2-1")];
    let answer!: (r: Response) => void;
    const get = vi.fn<typeof fetch>(async () => json({ status: "ahead", ahead_by: 1, behind_by: 0, commits: [commit("4444444", "Fix")] }));
    const { u } = setup({ update_install_kind: () => kinds.shift(), app_restart: new Error("disk full") }, { fetch: get });
    await u.check();
    get.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const quiet = u.check({ installedOnly: true });
    const full = u.check();
    await quiet;
    await u.restart();
    expect(u.getSnapshot()).toMatchObject({ state: "error", restart: { to: "r313.4444444-1" } });
    answer(json({ status: "ahead", ahead_by: 1, behind_by: 0, commits: [commit("4444444", "Fix")] }));
    await full;
    expect(u.getSnapshot()).toMatchObject({ state: "error", restart: { to: "r313.4444444-1" } });
  });

  it("says why a copy isn't updated here", async () => {
    let { u } = setup({ update_install_kind: { kind: "unmanaged", version: "0.1.0" } });
    await u.check();
    expect(u.getSnapshot()).toMatchObject({ state: "unsupported", reason: expect.stringContaining("built it from source") });
    ({ u } = setup({ update_install_kind: { kind: "appImage", version: "0.1.0", updater: false } }));
    await u.check();
    expect(u.getSnapshot()).toMatchObject({ state: "unsupported", reason: expect.stringContaining("without an update key") });
    ({ u } = setup({ update_install_kind: pacman("r312.ef433a2-1", null) }));
    await u.check();
    expect(u.getSnapshot()).toMatchObject({ state: "unsupported", reason: expect.stringContaining("no longer lists") });
  });

  it("runs one check at a time", async () => {
    const { u, invoke } = setup({ update_install_kind: { kind: "unmanaged", version: "0.1.0" } });
    await Promise.all([u.check(), u.check()]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("reports a failed check, and tries again", async () => {
    const answers: Record<string, unknown> = { update_install_kind: new Error("boom") };
    const { u } = setup(answers);
    await u.check();
    expect(u.getSnapshot()).toEqual({ state: "error", message: "Couldn't check for updates: boom" });
    answers.update_install_kind = { kind: "unmanaged", version: "0.1.0" };
    await u.check();
    expect(u.getSnapshot().state).toBe("unsupported");
  });

  describe("an AppImage with an update key", () => {
    const appImage = { kind: "appImage", version: "0.1.0", updater: true };

    it("is up to date when the update server has nothing newer", async () => {
      const { u } = setup({ update_install_kind: appImage, update_check: null });
      await u.check();
      expect(u.getSnapshot()).toEqual({ state: "upToDate", version: "0.1.0", checkedAt: NOW });
    });

    it("downloads with progress, then asks to restart", async () => {
      const { u, channels } = setup({
        update_install_kind: appImage,
        update_check: { version: "0.2.0", current: "0.1.0", notes: "- Updates\n- Fixes\n" },
        update_download_and_install: (args: { onProgress: string }) => {
          expect(args.onProgress).toBe("channel-1");
          channels[0]({ event: "downloading", downloaded: 512, total: 1024 });
          expect(u.getSnapshot()).toMatchObject({ state: "installing", downloaded: 512, total: 1024 });
          channels[0]({ event: "installing" });
          expect(u.getSnapshot()).toMatchObject({ state: "installing", verifying: true });
        },
      });
      await u.check();
      expect(u.getSnapshot()).toMatchObject({ state: "available", found: { via: "updater", from: "0.1.0", to: "0.2.0", notes: [{ text: "Updates" }, { text: "Fixes" }] } });
      await u.install();
      expect(u.getSnapshot()).toMatchObject({ state: "restart", from: "0.1.0", to: "0.2.0" });
    });

    it("keeps the update to try again when the download or signature check fails", async () => {
      const answers: Record<string, unknown> = {
        update_install_kind: appImage,
        update_check: { version: "0.2.0", current: "0.1.0" },
        update_download_and_install: new Error("the signature could not be verified"),
      };
      const { u } = setup(answers);
      await u.check();
      await u.install();
      expect(u.getSnapshot()).toMatchObject({
        state: "error",
        message: "Couldn't install 0.2.0: the signature could not be verified. The version you have is unchanged.",
        found: { to: "0.2.0" },
      });
      answers.update_download_and_install = undefined;
      await u.install();
      expect(u.getSnapshot().state).toBe("restart");
    });
  });

  it("restarts with every draft and outbox, and stays put if saving them fails", async () => {
    localStorage.clear();
    localStorage.setItem("hermes-chat.draft.a", "half a thought");
    localStorage.setItem("hermes-chat.outbox.a", "[]");
    localStorage.setItem("hermes-ui-prefs", "{}");
    const answers: Record<string, unknown> = {
      update_install_kind: pacman("r1.ef433a2-1", "r2.4444444-1"),
      app_restart: new Error("Couldn't save your drafts before restarting, so the app didn't restart: disk full"),
    };
    const { u, invoke } = setup(answers);
    await u.check();
    await u.restart();
    expect(invoke).toHaveBeenCalledWith("app_restart", { drafts: JSON.stringify({ "hermes-chat.draft.a": "half a thought", "hermes-chat.outbox.a": "[]" }) });
    expect(u.getSnapshot()).toMatchObject({ state: "error", message: expect.stringContaining("disk full"), restart: { from: "r1.ef433a2-1", to: "r2.4444444-1" } });
    answers.app_restart = undefined;
    await u.restart();
    expect(u.getSnapshot().state).toBe("restarting");
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

describe("drafts storage refused", () => {
  it("still go into the restart snapshot", () => {
    localStorage.clear();
    localStorage.setItem("hermes-chat.draft.a", "old");
    localStorage.setItem("hermes-chat.draft.gone", "sent");
    const full = { setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => { throw new Error("QuotaExceededError"); } };
    persist(() => full, "hermes-chat.draft.a", "newer than storage");
    persist(() => full, "hermes-chat.outbox.b", "[1]");
    persist(() => full, "hermes-chat.draft.gone", null);
    expect(JSON.parse(snapshotDrafts(localStorage))).toEqual({ "hermes-chat.draft.a": "newer than storage", "hermes-chat.outbox.b": "[1]" });
    persist(() => localStorage, "hermes-chat.draft.a", "saved at last");
    expect(unsaved.has("hermes-chat.draft.a")).toBe(false);
    unsaved.clear();
  });
});

describe("restoreAfterRestart", () => {
  const snapshot = JSON.stringify({ "hermes-chat.draft.a": "half a thought" });
  /** localStorage that refuses every write until `room` is made. */
  const fullUntil = (room: { made: boolean }): UpdateDeps["storage"] => ({
    length: 0,
    key: () => null,
    getItem: () => null,
    removeItem: () => {},
    setItem: (k, v) => {
      if (!room.made) throw new Error("QuotaExceededError");
      localStorage.setItem(k, v);
    },
  });

  it("does nothing after a launch that wasn't a restart", async () => {
    const { u, invoke } = setup({ restart_drafts_read: null });
    await u.restoreAfterRestart();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("puts the drafts back, then deletes the saved copy", async () => {
    localStorage.clear();
    const { u, invoke } = setup({ restart_drafts_read: snapshot });
    await u.restoreAfterRestart();
    expect(localStorage.getItem("hermes-chat.draft.a")).toBe("half a thought");
    expect(invoke).toHaveBeenLastCalledWith("restart_drafts_clear");
  });

  it("reports a saved copy it couldn't delete, for the app not to open over it", async () => {
    localStorage.clear();
    const { u } = setup({ restart_drafts_read: snapshot, restart_drafts_clear: new Error("/data/restart-drafts.json: Permission denied") });
    await expect(u.restoreAfterRestart()).rejects.toThrow("Permission denied");
    expect(localStorage.getItem("hermes-chat.draft.a")).toBe("half a thought");
  });

  it("drops the chat cache to make room for the drafts", async () => {
    localStorage.clear();
    const room = { made: false };
    const clearCache = vi.fn(() => void (room.made = true));
    const u = updater({ invoke: (async (cmd: string) => (cmd === "restart_drafts_read" ? snapshot : undefined)) as UpdateDeps["invoke"], channel: () => 0, fetch: vi.fn<typeof fetch>(), storage: fullUntil(room), clearCache });
    await u.restoreAfterRestart();
    expect(clearCache).toHaveBeenCalled();
    expect(localStorage.getItem("hermes-chat.draft.a")).toBe("half a thought");
    expect(u.getSnapshot().state).toBe("idle");
  });

  it("sets the saved copy aside, never to be put back over newer drafts, and says where it is", async () => {
    const calls: string[] = [];
    const invoke = (async (cmd: string) => {
      calls.push(cmd);
      return cmd === "restart_drafts_read" ? snapshot : cmd === "restart_drafts_set_aside" ? "/home/me/.local/share/hermes-chat/restart-drafts-1.json" : pacman("r1.ef433a2-1", "r2.4444444-1");
    }) as UpdateDeps["invoke"];
    const u = updater({ invoke, channel: () => 0, fetch: vi.fn<typeof fetch>(), storage: fullUntil({ made: false }), clearCache: () => {} });
    await u.restoreAfterRestart();
    expect(calls).toEqual(["restart_drafts_read", "restart_drafts_set_aside"]);
    const s = u.getSnapshot();
    expect(s).toMatchObject({ state: "error", setAside: "/home/me/.local/share/hermes-chat/restart-drafts-1.json" });
    expect(needsAttention(s)).toBe(true);
    await u.check({ installedOnly: true });
    expect(u.getSnapshot()).toBe(s);
  });
});

describe("restoreDrafts", () => {
  it("puts back the drafts saved at restart, dropping ones emptied before it, and leaves other keys alone", () => {
    localStorage.clear();
    localStorage.setItem("hermes-chat.draft.a", "half");
    localStorage.setItem("hermes-chat.draft.sent", "sent before the restart");
    localStorage.setItem("hermes-ui-prefs", "{}");
    expect(restoreDrafts(localStorage, JSON.stringify({ "hermes-chat.draft.a": "half a thought", "hermes-chat.undelivered.b": "[]", "hermes-ui-prefs": "x" }))).toBe(true);
    expect(snapshotDrafts(localStorage)).toBe(JSON.stringify({ "hermes-chat.draft.a": "half a thought", "hermes-chat.undelivered.b": "[]" }));
    expect(localStorage.getItem("hermes-ui-prefs")).toBe("{}");
  });

  it("leaves drafts as they are with no snapshot or a garbled one", () => {
    localStorage.clear();
    localStorage.setItem("hermes-chat.draft.a", "kept");
    for (const s of [null, "", "{", "[]", "null", '"x"']) expect(restoreDrafts(localStorage, s)).toBe(true);
    expect(localStorage.getItem("hermes-chat.draft.a")).toBe("kept");
  });

  it("says to keep the snapshot when storage refuses it", () => {
    localStorage.clear();
    const store = { length: 0, key: () => null, removeItem: () => {}, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(restoreDrafts(store, JSON.stringify({ "hermes-chat.draft.a": "x" }))).toBe(false);
  });
});
