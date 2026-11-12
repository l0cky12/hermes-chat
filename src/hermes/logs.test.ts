import { afterEach, describe, expect, it, vi } from "vitest";
import { LogBuffer, LogFollower, TAIL, bundleText, clean, levelOf, note, passes, since, visible, type Entry } from "./logs";
import { RestError } from "./pipe";

afterEach(() => vi.useRealTimers());

/** A Hermes log file as `GET /api/logs` reads it: the last `n` lines. */
class FakeLogFile {
  lines: string[] = [];
  fail?: Error;
  reads = 0;
  write(n: number, make = (i: number) => `2026-11-04 10:00:00,${String(i % 1000).padStart(3, "0")} INFO agent.run: line ${i}`) {
    const from = this.total;
    for (let i = 0; i < n; i++) this.lines.push(make(from + i) + "\n");
    this.total += n;
  }
  total = 0;
  rotate() {
    this.lines = [];
  }
  read = async (n: number) => {
    this.reads++;
    if (this.fail) throw this.fail;
    return { file: "agent", lines: this.lines.slice(-Math.min(n, 500)) };
  };
}

const lines = (b: LogBuffer) => b.getSnapshot().entries.filter((e): e is Extract<Entry, { kind: "line" }> => e.kind === "line").map((e) => e.text);
const marks = (b: LogBuffer) => b.getSnapshot().entries.filter((e) => e.kind === "mark").map((e) => e.text);

/** Runs one poll and lets its answer land. */
async function poll() {
  await vi.advanceTimersByTimeAsync(1000);
}

describe("visible", () => {
  it("writes out terminal escapes, other controls and bidi overrides, and keeps tabs and newlines", () => {
    expect(visible("\x1b[31mred\x1b[0m\x07\r\tok\nnext")).toBe("\\x1b[31mred\\x1b[0m\\x07\\x0d\tok\nnext");
    expect(visible("file‮txt.exe\u0085")).toBe("file\\u202etxt.exe\\x85");
    expect(visible("\x1b]8;;http://evil\x07link")).not.toMatch(/\x1b|\x07/);
  });

  it("goes with removing terminal color codes first, so a secret wrapped in colors still goes", () => {
    expect(clean("\x1b[1mBearer abcdefgh12345678\x1b[0m").text).toBe("Bearer [redacted]");
    expect(clean("\x1b]8;;http://evil\x07link\x1b[2J").text).toBe("\\x1b]8;;http://evil\\x07link");
  });
});

describe("levels and filters", () => {
  it("gives a traceback's lines the level of the record they continue", () => {
    let level = levelOf("2026-11-04 10:00:00,001 ERROR agent.run: boom");
    expect(level).toBe("ERROR");
    level = levelOf("Traceback (most recent call last):", level);
    expect(level).toBe("ERROR");
    expect(levelOf("2026-11-04 10:00:01,000 INFO agent.run: fine", level)).toBe("INFO");
  });

  it("filters by least level and text; notes and lines without a level always pass", () => {
    const line = (text: string, level?: Entry extends never ? never : "INFO" | "ERROR"): Entry => ({ seq: 1, kind: "line", text, level, at: 0 });
    expect(passes(line("a", "INFO"), { min: "WARNING" })).toBe(false);
    expect(passes(line("a", "ERROR"), { min: "WARNING" })).toBe(true);
    expect(passes(line("plain stderr"), { min: "ERROR" })).toBe(true);
    expect(passes(line("Gateway Started"), { text: "gateway" })).toBe(true);
    expect(passes(line("x"), { text: "gateway" })).toBe(false);
    expect(passes({ seq: 1, kind: "mark", text: "gap", at: 0 }, { min: "CRITICAL", text: "zzz" })).toBe(true);
  });
});

describe("LogBuffer", () => {
  it("keeps at most its capacity under sustained volume, counting what it dropped", () => {
    const b = new LogBuffer(1000);
    for (let i = 0; i < 100_000; i++) note("INFO", `line ${i}`, b, i);
    const s = b.getSnapshot();
    expect(s.entries).toHaveLength(1000);
    expect(s.lines).toBe(1000);
    expect(s.dropped).toBe(99_000);
    expect(s.entries[0]).toMatchObject({ text: "line 99000" });
    expect(s.entries.at(-1)).toMatchObject({ text: "line 99999" });
  });

  it("tells listeners once for a burst", async () => {
    vi.useFakeTimers();
    const b = new LogBuffer(10);
    const heard = vi.fn();
    b.subscribe(heard);
    for (let i = 0; i < 50; i++) note("INFO", `x${i}`, b);
    const before = b.getSnapshot();
    expect(b.getSnapshot()).toBe(before);
    await vi.advanceTimersByTimeAsync(200);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("redacts and cuts what the app notes", () => {
    const b = new LogBuffer(10);
    note("ERROR", `failed with Authorization: Bearer abcdefgh12345678\n${"x".repeat(9000)}`, b);
    const [e] = b.getSnapshot().entries as Extract<Entry, { kind: "line" }>[];
    expect(e.text).not.toContain("abcdefgh12345678");
    expect(e.text).toMatch(/more characters\)$/);
    expect(e.redacted).toEqual(["authorization header"]);
  });
});

describe("since", () => {
  it("finds the lines after the overlap", () => {
    expect(since(["a", "b", "c"], ["b", "c", "d", "e"], 4)).toEqual({ start: 2 });
    expect(since(["a", "b"], ["a", "b", "c"], 500)).toEqual({ start: 2 });
    expect(since(["a", "b"], ["a", "b"], 500)).toEqual({ start: 2 });
  });
  it("calls a short file without the overlap rotated, and a full one missed", () => {
    expect(since(["a", "b"], ["x"], 500)).toEqual({ start: 0, gap: "rotated" });
    expect(since(["a", "b"], [], 500)).toEqual({ start: 0, gap: "rotated" });
    expect(since(["a", "b"], ["x", "y"], 2)).toEqual({ start: 0, gap: "missed" });
  });
});

describe("LogFollower", () => {
  const follow = (file: FakeLogFile, capacity = 5000) => new LogFollower(file.read, "agent", { pollMs: 1000, capacity });

  it("follows sustained high volume, saying where more came between reads than Hermes gives", async () => {
    vi.useFakeTimers();
    const file = new FakeLogFile();
    file.write(100);
    const f = follow(file, 2000);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(lines(f.buffer)).toHaveLength(100);
    // 300 lines a second: each read finds them all, overlapping the last.
    for (let s = 0; s < 5; s++) {
      file.write(300);
      await poll();
    }
    expect(lines(f.buffer)).toHaveLength(1600);
    expect(lines(f.buffer).at(-1)).toMatch(/line 1599$/);
    expect(marks(f.buffer)).toEqual([]);
    // 2000 lines between reads: only the last 500 come back, and the gap is noted.
    file.write(2000);
    await poll();
    expect(marks(f.buffer)).toEqual([`More than ${TAIL} lines were written between two reads, so some were missed here.`]);
    expect(lines(f.buffer).at(-1)).toMatch(/line 3599$/);
    // Bounded: the buffer never holds more than its capacity.
    for (let s = 0; s < 20; s++) {
      file.write(400);
      await poll();
    }
    const snap = f.buffer.getSnapshot();
    expect(snap.entries.length).toBeLessThanOrEqual(2000);
    expect(snap.dropped).toBeGreaterThan(0);
    expect(snap.lines + snap.dropped).toBe(100 + 1500 + 500 + 8000);
    f.stop("done");
  });

  it("notes a rotation, and reads the new file from its start", async () => {
    vi.useFakeTimers();
    const file = new FakeLogFile();
    file.write(50);
    const f = follow(file);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    file.rotate();
    file.write(3, (i) => `2026-11-04 10:00:05,000 INFO new file ${i}`);
    await poll();
    expect(marks(f.buffer)).toEqual(["The log file was rotated or emptied since the last read. Lines written just before that may be missing."]);
    expect(lines(f.buffer).slice(-3)).toEqual(["2026-11-04 10:00:05,000 INFO new file 50", "2026-11-04 10:00:05,000 INFO new file 51", "2026-11-04 10:00:05,000 INFO new file 52"]);
    f.stop("done");
  });

  it("notes a stop and a failed read where reading picks up, without losing what overlapped", async () => {
    vi.useFakeTimers();
    const file = new FakeLogFile();
    file.write(10);
    const f = follow(file);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    f.stop("the connection to Hermes was lost");
    file.write(5);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(marks(f.buffer)).toHaveLength(1);
    expect(marks(f.buffer)[0]).toMatch(/^Not read from .* to .*: the connection to Hermes was lost$/);
    expect(lines(f.buffer)).toHaveLength(15);

    file.fail = new Error("Couldn't reach the dashboard: connection refused");
    await poll();
    expect(f.getState()).toMatchObject({ kind: "failed", reason: "Couldn't reach the dashboard: connection refused" });
    await poll();
    file.fail = undefined;
    file.write(2);
    await poll();
    expect(f.getState().kind).toBe("ok");
    expect(marks(f.buffer)[1]).toMatch(/connection refused$/);
    expect(lines(f.buffer)).toHaveLength(17);
    f.stop("done");
  });

  it("drops an answer that comes after a stop", async () => {
    vi.useFakeTimers();
    let answer!: (v: unknown) => void;
    const f = new LogFollower(() => new Promise((r) => (answer = r)), "agent", { pollMs: 1000 });
    f.start();
    f.stop("switched profile");
    answer({ lines: ["late line\n"] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.buffer.getSnapshot().entries).toEqual([]);
  });

  it("stops for a Hermes without the route or the file, and keeps trying after a permission error", async () => {
    vi.useFakeTimers();
    const run = async (err: Error) => {
      const file = new FakeLogFile();
      file.fail = err;
      const f = follow(file);
      f.start();
      await vi.advanceTimersByTimeAsync(0);
      await poll();
      return { state: f.getState(), reads: file.reads };
    };
    expect(await run(new RestError(404, `{"detail":"Not Found"}`))).toMatchObject({ state: { kind: "unsupported" }, reads: 1 });
    expect(await run(new RestError(400, `{"detail":"Unknown log file: mcp"}`))).toMatchObject({
      state: { kind: "unsupported", reason: "This Hermes doesn't have the agent log (Unknown log file: mcp)." },
      reads: 1,
    });
    expect(await run(new RestError(403, `{"detail":"Forbidden"}`))).toMatchObject({ state: { kind: "failed", reason: "Permission denied: Forbidden" }, reads: 2 });
    expect(await run(new RestError(500, `{"detail":"[Errno 13] Permission denied: '/root/.hermes/logs/agent.log'"}`))).toMatchObject({
      state: { kind: "failed", reason: "[Errno 13] Permission denied: '/root/.hermes/logs/agent.log'" },
    });
    const html = new LogFollower(async () => "<html>", "agent");
    html.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(html.getState().kind).toBe("unsupported");
  });

  it("redacts and escapes what Hermes sends before keeping it, and keeps multiline records together", async () => {
    vi.useFakeTimers();
    const file = new FakeLogFile();
    file.lines = [
      "2026-11-04 10:00:00,000 ERROR tools.web: request failed Authorization: Bearer abcdefgh12345678\n",
      "Traceback (most recent call last):\n",
      '  File "x.py", line 1, in <module>\n',
      "2026-11-04 10:00:01,000 INFO agent: \x1b[2J\x1b[Hcleared \x1b]0;title\x07\u202Eevil <script>alert(1)</script>\n",
    ];
    const f = follow(file);
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    const kept = f.buffer.getSnapshot().entries as Extract<Entry, { kind: "line" }>[];
    expect(kept.map((e) => e.level)).toEqual(["ERROR", "ERROR", "ERROR", "INFO"]);
    expect(kept[0].text).not.toContain("abcdefgh12345678");
    expect(kept[3].text).toBe("2026-11-04 10:00:01,000 INFO agent: cleared \\x1b]0;title\\x07\\u202eevil <script>alert(1)</script>");
    f.stop("done");
  });
});

describe("LogFollower redaction across lines and reads", () => {
  it("redacts a multiline private key, even split between two reads, and exports none of it", async () => {
    vi.useFakeTimers();
    const file = new FakeLogFile();
    const body = ["MIIEowIBAAKCAQEAs3cr3tKeyB0dyL1neOne", "s3cr3tKeyB0dyL1neTwoXXXXXXXXXXXXXXXX", "s3cr3tKeyB0dyL1neThree=="];
    file.lines = ["2026-11-04 10:00:00,000 INFO tools.x: wrote key\n", "-----BEGIN RSA PRIVATE KEY-----\n", body[0] + "\n"];
    const f = new LogFollower(file.read, "agent", { pollMs: 1000 });
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    file.lines.push(body[1] + "\n", body[2] + "\n", "-----END RSA PRIVATE KEY-----\n", "2026-11-04 10:00:01,000 INFO tools.x: after\n");
    await poll();
    const text = bundleText([{ title: "agent", detail: "", snapshot: f.buffer.getSnapshot() }], { connection: "x", now: 0 });
    for (const b of body) expect(text).not.toContain(b);
    expect(lines(f.buffer).at(-1)).toBe("2026-11-04 10:00:01,000 INFO tools.x: after");
    // BEGIN, three body lines, END.
    expect(lines(f.buffer).filter((l) => l === "[redacted private key]")).toHaveLength(5);
    f.stop("done");
  });

  it("follows a key whose delimiters are colored, across reads", async () => {
    vi.useFakeTimers();
    const file = new FakeLogFile();
    file.lines = ["-----BEGIN \x1b[31mPRIVATE KEY-----\x1b[0m\n", "shortRow1\n"];
    const f = new LogFollower(file.read, "agent", { pollMs: 1000 });
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    file.lines.push("shortRow2==\n", "-----END \x1b[31mPRIVATE KEY-----\n", "after\n");
    await poll();
    expect(lines(f.buffer)).toEqual([...Array(4).fill("[redacted private key]"), "after"]);
    f.stop("done");
  });

  it("redacts a key whose BEGIN line wasn't in the tail: full, OpenSSH and short padded rows", async () => {
    vi.useFakeTimers();
    const file = new FakeLogFile();
    const rsa = "MIIEowIBAAKCAQEAs3cr3tKeyB0dyL1neOneXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const openssh = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
    const last = "q8Lh3vX2sK1y==";
    expect(rsa).toHaveLength(64);
    expect(openssh).toHaveLength(70);
    file.lines = [rsa, openssh, last, "-----END OPENSSH PRIVATE KEY-----", "2026-11-04 10:00:00,000 INFO x: after"].map((l) => l + "\n");
    const f = new LogFollower(file.read, "agent", { pollMs: 1000 });
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    const text = bundleText([{ title: "agent", detail: "", snapshot: f.buffer.getSnapshot() }], { connection: "x", now: 0 });
    for (const secret of [rsa, openssh, last]) expect(text).not.toContain(secret);
    expect(lines(f.buffer).at(-1)).toBe("2026-11-04 10:00:00,000 INFO x: after");
    f.stop("done");
  });

  it("tells apart lines that redact to the same text", async () => {
    vi.useFakeTimers();
    const file = new FakeLogFile();
    file.lines = ["2026-11-04 10:00:00,000 INFO x: api_key=first-key\n"];
    const f = new LogFollower(file.read, "agent", { pollMs: 1000 });
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    // Rotated to a file whose only line looks the same once redacted.
    file.lines = ["2026-11-04 10:00:00,000 INFO x: api_key=second-key\n"];
    await poll();
    expect(lines(f.buffer)).toEqual(["2026-11-04 10:00:00,000 INFO x: api_key=[redacted]", "2026-11-04 10:00:00,000 INFO x: api_key=[redacted]"]);
    expect(marks(f.buffer)).toEqual(["The log file was rotated or emptied since the last read. Lines written just before that may be missing."]);
    f.stop("done");
  });

  it("redacts a failed read's reason on screen, and in the note and bundle after it recovers", async () => {
    vi.useFakeTimers();
    const file = new FakeLogFile();
    file.write(2);
    const f = new LogFollower(file.read, "agent", { pollMs: 1000 });
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    file.fail = new RestError(502, `{"detail":"upstream refused token=rawSecret123"}`);
    await poll();
    expect(f.getState()).toMatchObject({ kind: "failed", reason: "upstream refused token=[redacted]" });
    file.fail = undefined;
    await poll();
    const text = bundleText([{ title: "agent", detail: "", snapshot: f.buffer.getSnapshot() }], { connection: "x", now: 0 });
    expect(marks(f.buffer)[0]).toMatch(/upstream refused token=\[redacted\]$/);
    expect(text).not.toContain("rawSecret123");
    f.stop("done");
  });
});

describe("bundleText", () => {
  it("says what's in it and what was redacted, and holds no secret", () => {
    const app = new LogBuffer(10);
    note("WARNING", "Connection lost: Cookie: session=abcdef123", app, Date.UTC(2026, 10, 4, 10));
    note("INFO", "OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv", app, Date.UTC(2026, 10, 4, 10, 1));
    const text = bundleText([{ title: "This app", detail: "this computer", snapshot: app.getSnapshot() }], {
      profile: "default",
      connection: "SSH tunnel",
      now: Date.UTC(2026, 10, 4, 11),
    });
    expect(text).toContain("Made: 2026-11-04T11:00:00.000Z");
    expect(text).toContain("  - This app: 2 lines (this computer)");
    expect(text).toMatch(/Redacted: 1 cookie, 1 (provider key|secret value)/);
    expect(text).toContain("can still be there: read the file before sharing it.");
    expect(text).toContain("[2026-11-04T10:00:00.000Z] Connection lost: Cookie: [redacted]");
    expect(text).not.toMatch(/abcdef123|AbCdEfGhIjKlMnOpQrStUv/);
  });
});
