// The terminal session's lifecycle against a fake of Rust's terminal commands: output goes to the screen, typing
// and resizing reach ssh only while it runs, and every way it can end is reported once, the owner's end as theirs.
import { describe, expect, it } from "vitest";
import {
  MAX_FOLDER_SHELLS,
  TerminalSession,
  closeShell,
  endedText,
  moveShell,
  openShellIn,
  shellsAt,
  showShell,
  sshTargetFromUrl,
  terminalTarget,
  terminalTargetGuessed,
  type Shells,
  type TerminalApi,
  type TerminalEvent,
  type TerminalState,
} from "./terminal";
import { resolvePath, type ServerPath } from "./paths";

class FakeTerminals implements TerminalApi {
  opened: { target: string; cols: number; rows: number; emit: (e: TerminalEvent) => void; folder?: string }[] = [];
  written: [number, string][] = [];
  resized: [number, number, number][] = [];
  closed: number[] = [];
  refuse?: string;
  /** Why `write` is refused, while set. */
  refuseWrite?: string;
  /** Holds `open`'s answer until `answer()`. */
  hold = false;
  private pending: (() => void)[] = [];
  open(target: string, cols: number, rows: number, emit: (e: TerminalEvent) => void, folder?: string) {
    if (this.refuse) return Promise.reject(new Error(this.refuse));
    this.opened.push({ target, cols, rows, emit, folder });
    const id = this.opened.length;
    if (!this.hold) return Promise.resolve(id);
    return new Promise<number>((done) => this.pending.push(() => done(id)));
  }
  answer() {
    this.pending.splice(0).forEach((f) => f());
  }
  write(id: number, data: string) {
    if (this.refuseWrite) return Promise.reject(new Error(this.refuseWrite));
    this.written.push([id, data]);
    return Promise.resolve();
  }
  resize(id: number, cols: number, rows: number) {
    this.resized.push([id, cols, rows]);
    return Promise.resolve();
  }
  close(id: number) {
    this.closed.push(id);
  }
}

const bytes = (s: string) => new TextEncoder().encode(s);

function setup() {
  const api = new FakeTerminals();
  const out: string[] = [];
  const states: TerminalState[] = [];
  const s = new TerminalSession(api, (d) => out.push(new TextDecoder().decode(d)), (st) => states.push(st));
  return { api, out, states, s };
}

describe("terminal session", () => {
  it("connects, shows what ssh prints, and sends typing and size only while it runs", async () => {
    const { api, out, states, s } = setup();
    s.input("early");
    await s.start(" liam@hermes ", 120, 40);
    expect(api.opened[0]).toMatchObject({ target: "liam@hermes", cols: 120, rows: 40 });
    expect(states.at(-1)).toEqual({ kind: "connecting", target: "liam@hermes" });
    s.input("not yet");
    api.opened[0].emit({ kind: "output", data: bytes("liam@hermes:~$ ") });
    expect(states.at(-1)).toEqual({ kind: "open", target: "liam@hermes" });
    expect(out).toEqual(["liam@hermes:~$ "]);
    s.input("ls\r");
    s.resize(100, 30);
    expect(api.written).toEqual([[1, "ls\r"]]);
    expect(api.resized).toEqual([[1, 100, 30]]);

    api.opened[0].emit({ kind: "exit", code: 0 });
    expect(states.at(-1)).toEqual({ kind: "ended", target: "liam@hermes", code: 0, byOwner: false });
    expect(api.closed).toEqual([1]);
    s.input("after");
    expect(api.written).toHaveLength(1);
  });

  it("marks an end the owner asked for as theirs", async () => {
    const { api, states, s } = setup();
    await s.start("hermes", 80, 24);
    api.opened[0].emit({ kind: "output", data: bytes("$ ") });
    s.end();
    expect(api.closed).toEqual([1]);
    api.opened[0].emit({ kind: "exit", code: null });
    const ended = states.at(-1) as Extract<TerminalState, { kind: "ended" }>;
    expect(ended).toMatchObject({ kind: "ended", byOwner: true });
    expect(endedText(ended)).toBe("You ended the session.");
  });

  it("ends ssh that is still starting once it answers", async () => {
    const { api, states, s } = setup();
    api.hold = true;
    const starting = s.start("hermes", 80, 24);
    s.end();
    expect(api.closed).toEqual([]);
    api.answer();
    await starting;
    expect(api.closed).toEqual([1]);
    api.opened[0].emit({ kind: "exit", code: null });
    expect(states.at(-1)).toMatchObject({ kind: "ended", byOwner: true });
  });

  it("says why ssh couldn't start, and can start again keeping nothing of the old one", async () => {
    const { api, states, s } = setup();
    api.refuse = "Couldn't start ssh: No such file or directory";
    await s.start("hermes", 80, 24);
    expect(states.at(-1)).toEqual({ kind: "failed", target: "hermes", message: "Couldn't start ssh: No such file or directory" });
    api.refuse = undefined;
    await s.start("liam@hermes", 80, 24);
    expect(states.at(-1)).toEqual({ kind: "connecting", target: "liam@hermes" });
  });

  it("ignores a late event from an earlier ssh and closes everything when the screen goes", async () => {
    const { api, out, states, s } = setup();
    await s.start("a", 80, 24);
    api.opened[0].emit({ kind: "exit", code: 255 });
    await s.start("b", 80, 24);
    api.opened[0].emit({ kind: "output", data: bytes("stale") });
    api.opened[0].emit({ kind: "exit", code: 1 });
    expect(out).toEqual([]);
    expect(states.at(-1)).toEqual({ kind: "connecting", target: "b" });
    s.dispose();
    expect(api.closed).toEqual([1, 2]);
    api.opened[1].emit({ kind: "output", data: bytes("gone") });
    expect(out).toEqual([]);
  });

  it("sends a size the screen took while ssh was starting once it answers", async () => {
    const { api, s } = setup();
    api.hold = true;
    const starting = s.start("hermes", 111, 39);
    // The connect form goes away as it starts, so the terminal grows before Rust has given its id.
    s.resize(111, 45);
    expect(api.resized).toEqual([]);
    api.answer();
    await starting;
    expect(api.resized).toEqual([[1, 111, 45]]);
  });

  it("doesn't start a second ssh while one runs", async () => {
    const { api, s } = setup();
    await s.start("a", 80, 24);
    await s.start("b", 80, 24);
    expect(api.opened).toHaveLength(1);
  });

  it("says once why typing wasn't sent while the program isn't taking input, and again after it took some", async () => {
    const { api, out, s } = setup();
    await s.start("hermes", 80, 24);
    api.opened[0].emit({ kind: "output", data: bytes("$ ") });
    api.refuseWrite = "The program in this terminal isn't taking input.";
    s.input("a");
    s.input("b");
    await new Promise((r) => setTimeout(r));
    expect(out).toEqual(["$ ", "\r\n\x1b[2m── The program in this terminal isn't taking input. ──\x1b[0m\r\n"]);
    api.refuseWrite = undefined;
    s.input("c");
    await new Promise((r) => setTimeout(r));
    api.refuseWrite = "Still not.";
    s.input("d");
    await new Promise((r) => setTimeout(r));
    expect(out.slice(2)).toEqual(["\r\n\x1b[2m── Still not. ──\x1b[0m\r\n"]);
  });

  it("explains each kind of end", () => {
    const t = { kind: "ended" as const, target: "h", byOwner: false };
    expect(endedText({ ...t, code: 0 })).toBe("The session ended.");
    expect(endedText({ ...t, code: 255 })).toMatch(/ssh couldn't connect/);
    expect(endedText({ ...t, code: null })).toMatch(/signal/);
    expect(endedText({ ...t, code: 2 })).toBe("The session ended with exit status 2.");
  });
});

describe("terminal target", () => {
  it("is the one typed for the terminal, else the sign-in's SSH target, else nothing", () => {
    expect(terminalTarget({ mode: "ssh", sshTarget: "liam@hermes" }, null)).toBe("liam@hermes");
    expect(terminalTarget({ mode: "ssh", sshTarget: "liam@hermes" }, " root@hermes ")).toBe("root@hermes");
    expect(terminalTarget({ mode: "url", sshTarget: "old" }, null)).toBe("");
    expect(terminalTarget({ mode: "url", sshTarget: "" }, "hermes")).toBe("hermes");
  });

  it("is the web address's host for a web-address sign-in with nothing typed", () => {
    expect(terminalTarget({ mode: "url", sshTarget: "old", url: "http://hermes:9119" }, null)).toBe("hermes");
    expect(terminalTarget({ mode: "url", sshTarget: "", url: "https://hermes.tail36fb9.ts.net/" }, null)).toBe("hermes.tail36fb9.ts.net");
    // One typed for the terminal still wins.
    expect(terminalTarget({ mode: "url", sshTarget: "", url: "http://hermes:9119" }, "root@hermes")).toBe("root@hermes");
    // An SSH sign-in keeps its own, whatever the url field holds.
    expect(terminalTarget({ mode: "ssh", sshTarget: "liam@box", url: "http://hermes:9119" }, null)).toBe("liam@box");
  });

  it("says when it was worked out from the web address", () => {
    expect(terminalTargetGuessed({ mode: "url", sshTarget: "", url: "http://hermes:9119" }, null)).toBe(true);
    expect(terminalTargetGuessed({ mode: "url", sshTarget: "", url: "http://hermes:9119" }, "liam@hermes")).toBe(false);
    expect(terminalTargetGuessed({ mode: "url", sshTarget: "", url: "http://localhost:9119" }, null)).toBe(false);
    expect(terminalTargetGuessed({ mode: "ssh", sshTarget: "liam@hermes" }, null)).toBe(false);
  });
});

describe("a terminal in a folder (ADR 0167)", () => {
  it("starts in its folder each time it starts, and a terminal with none starts where ssh puts it", async () => {
    const api = new FakeTerminals();
    const inFolder = new TerminalSession(api, () => {}, () => {}, "/srv/app/docs");
    await inFolder.start("liam@hermes", 80, 24);
    api.opened[0].emit({ kind: "exit", code: 0 });
    await inFolder.start("liam@hermes", 80, 24);
    expect(api.opened.map((o) => o.folder)).toEqual(["/srv/app/docs", "/srv/app/docs"]);
    const plain = setup();
    await plain.s.start("liam@hermes", 80, 24);
    expect(plain.api.opened[0].folder).toBeUndefined();
  });
});

describe("the Terminal tab's shells (ADR 0167)", () => {
  const at = (folder: string) => resolvePath(folder, undefined) as ServerPath;
  const opened = (s: Shells, folder: string, kind: "server" | "local" = "server") => {
    const next = openShellIn(s, kind, at(folder));
    if (next === "full") throw new Error("full");
    return next;
  };
  const ids = (s: Shells) => s.folders.map((f) => f.id);

  it("open on one computer's shell, with no folder shells", () => {
    expect(shellsAt("local")).toEqual({ shown: "local", folders: [] });
  });

  it("add a shell for a folder and show it, in the order folders were opened", () => {
    const s = opened(opened(shellsAt("server"), "/srv/app"), "~/notes");
    expect(ids(s)).toEqual(["in:server:/srv/app", "in:server:~/notes"]);
    expect(s.shown).toBe("in:server:~/notes");
  });

  it("show the shell a folder already has when it is opened again, and count the asking", () => {
    const first = opened(opened(shellsAt("server"), "/srv/app"), "~/notes");
    const again = opened(first, "/srv/app");
    expect(ids(again)).toEqual(ids(first));
    expect(again.shown).toBe("in:server:/srv/app");
    expect(again.folders.map((f) => f.asked)).toEqual([2, 1]);
  });

  it("keep the same folder on the server and on this computer as two shells", () => {
    expect(ids(opened(opened(shellsAt("server"), "/srv/app"), "/srv/app", "local"))).toEqual(["in:server:/srv/app", "in:local:/srv/app"]);
  });

  it("are full at eight folder shells, and still show one of the eight again", () => {
    let s = shellsAt("server");
    for (let i = 0; i < MAX_FOLDER_SHELLS; i++) s = opened(s, `/srv/${i}`);
    expect(openShellIn(s, "server", at("/srv/one-more"))).toBe("full");
    expect(opened(s, "/srv/3").shown).toBe("in:server:/srv/3");
  });

  it("show one of their shells, and ignore one they don't hold", () => {
    const s = opened(shellsAt("server"), "/srv/app");
    expect(showShell(s, "local").shown).toBe("local");
    expect(showShell(showShell(s, "local"), "in:server:/srv/app").shown).toBe("in:server:/srv/app");
    expect(showShell(s, "in:server:/gone")).toBe(s);
  });

  it("close a folder shell, showing its computer's own shell if it was on screen", () => {
    const s = opened(opened(shellsAt("local"), "/srv/app"), "~/notes");
    expect(closeShell(s, "in:server:~/notes")).toEqual({ shown: "server", folders: [s.folders[0]] });
    expect(closeShell(s, "in:server:/srv/app")).toEqual({ shown: "in:server:~/notes", folders: [s.folders[1]] });
  });

  it("never close the server's own shell or this computer's", () => {
    const s = opened(shellsAt("server"), "/srv/app");
    expect(closeShell(s, "server")).toBe(s);
    expect(closeShell(s, "local")).toBe(s);
  });

  it("move a folder shell to the other computer, in the same folder", () => {
    const moved = moveShell(opened(shellsAt("server"), "/srv/app"), "in:server:/srv/app", "local");
    expect(moved).toEqual({ shown: "in:local:/srv/app", folders: [{ id: "in:local:/srv/app", kind: "local", folder: "/srv/app", asked: 1 }] });
  });
});

describe("ssh target from a web address", () => {
  it("is the host, with no user or port", () => {
    expect(sshTargetFromUrl("http://hermes:9119")).toBe("hermes");
    expect(sshTargetFromUrl(" https://user:pw@Hermes.example.org./dash ")).toBe("hermes.example.org");
    expect(sshTargetFromUrl("http://100.100.64.121:9119")).toBe("100.100.64.121");
    expect(sshTargetFromUrl("http://[fd7a:115c::1]:9119")).toBe("fd7a:115c::1");
    // An IPv4-mapped address off this computer is still the server's.
    expect(sshTargetFromUrl("http://[::ffff:100.100.64.121]:9119")).toBe("::ffff:6464:4079");
  });

  it("is nothing for this computer, a bad address, or another scheme", () => {
    for (const u of ["http://localhost:9119", "http://LOCALHOST", "http://app.localhost", "http://127.0.0.1:9119", "http://127.1.2.3", "http://0.0.0.0:9119", "http://[::1]:9119", "http://[::]:9119", "http://[::ffff:127.0.0.1]:9119", "http://[::ffff:7f12:3456]", "http://[::ffff:0.0.0.0]", "ftp://hermes", "hermes:9119", "", undefined])
      expect(sshTargetFromUrl(u), String(u)).toBe("");
  });
});
