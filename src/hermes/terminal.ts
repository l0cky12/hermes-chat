import { errorText } from "./values";
import type { ServerPath } from "./paths";
// A terminal on the server: the owner's own `ssh` run in a pseudo-terminal by Rust (src-tauri/src/terminal.rs,
// ADR 0022). This is the session's lifecycle, apart from the screen that draws it (src/ui/Terminal.tsx).

/** Where a terminal's shell runs: on the Hermes server through ssh, or on this computer (ADR 0039). */
export type TerminalKind = "server" | "local";

/** What the terminal sends back: bytes ssh printed, then, once, how it ended. */
export type TerminalEvent = { kind: "output"; data: Uint8Array } | { kind: "exit"; code: number | null };

/**
 * Rust's terminal commands. `open` resolves to the terminal's id; its events may start before it resolves. `folder`:
 * the folder its shell starts in, in place of the home folder (ADR 0163). `write` carries only what the owner typed.
 */
export type TerminalApi = {
  open(target: string, cols: number, rows: number, onEvent: (e: TerminalEvent) => void, folder?: string): Promise<number>;
  write(id: number, data: string): Promise<void>;
  resize(id: number, cols: number, rows: number): Promise<void>;
  close(id: number): void;
};

/**
 * One of the Terminal tab's shells. `server` and `local` are the two it always has. A folder shell's id names its
 * computer and its folder, so opening the same folder again finds the shell already there (ADR 0163).
 */
export type ShellId = TerminalKind | `in:${TerminalKind}:${string}`;

/** A shell started in `folder`. `asked`: how often it has been asked for, so one that ended starts again when it is asked for again. */
export type FolderShell = { id: ShellId; kind: TerminalKind; folder: ServerPath; asked: number };

/** The Terminal tab's shells: the one on screen, and the folder shells in the order they were opened. */
export type Shells = { shown: ShellId; folders: FolderShell[] };

/** Each folder shell is an ssh of its own until it is closed, so the tab holds only this many. */
export const MAX_FOLDER_SHELLS = 8;

const isBase = (id: ShellId): id is TerminalKind => id === "server" || id === "local";

/** The tab as it opens: on `kind`'s shell, with no folder shells. */
export const shellsAt = (kind: TerminalKind): Shells => ({ shown: kind, folders: [] });

/** Puts shell `id` on screen. One the tab doesn't hold changes nothing. */
export const showShell = (s: Shells, id: ShellId): Shells => (isBase(id) || s.folders.some((f) => f.id === id) ? { ...s, shown: id } : s);

/**
 * Shows the shell in `folder` on `kind`, adding it if the tab has none there. Nothing running is ever closed to make
 * room: with `MAX_FOLDER_SHELLS` open already, a new one is "full".
 */
export function openShellIn(s: Shells, kind: TerminalKind, folder: ServerPath): Shells | "full" {
  const id: ShellId = `in:${kind}:${folder}`;
  if (s.folders.some((f) => f.id === id)) return { shown: id, folders: s.folders.map((f) => (f.id === id ? { ...f, asked: f.asked + 1 } : f)) };
  if (s.folders.length >= MAX_FOLDER_SHELLS) return "full";
  return { shown: id, folders: [...s.folders, { id, kind, folder, asked: 1 }] };
}

/** Drops folder shell `id`, and shows its computer's own shell if it was on screen. The two base shells can't be closed. */
export function closeShell(s: Shells, id: ShellId): Shells {
  const closed = s.folders.find((f) => f.id === id);
  if (!closed) return s;
  return { shown: s.shown === id ? closed.kind : s.shown, folders: s.folders.filter((f) => f !== closed) };
}

/** Folder shell `id` on `kind` instead: closed where it was, and opened in the same folder there. */
export function moveShell(s: Shells, id: ShellId, kind: TerminalKind): Shells {
  const from = s.folders.find((f) => f.id === id);
  const moved = from && openShellIn(closeShell(s, id), kind, from.folder);
  return moved && moved !== "full" ? moved : s;
}

export type TerminalState =
  | { kind: "idle" }
  | { kind: "connecting"; target: string }
  | { kind: "open"; target: string }
  /** `byOwner`: ended from this app. `code`: ssh's exit status, null when a signal ended it. */
  | { kind: "ended"; target: string; code: number | null; byOwner: boolean }
  /** ssh couldn't be started at all. */
  | { kind: "failed"; target: string; message: string };

/** Where the terminal goes: the target typed for it last, else the sign-in's own SSH target. */
export const TERMINAL_TARGET_KEY = "hermes-chat.terminal-target";

/**
 * Where a connection keeps the target typed for its terminal, so one typed for one server is never used for another.
 * The connection migrated from the single sign-in kept before keeps the key it had.
 */
export const terminalTargetKey = (c: { id?: string; legacy?: unknown }) => (c.legacy || !c.id ? TERMINAL_TARGET_KEY : `${TERMINAL_TARGET_KEY}.${c.id}`);

/** What a sign-in says about reaching the Hermes server over ssh. `url` is read only for a web-address sign-in. */
export type SignInAddress = { mode: "ssh" | "url"; sshTarget: string; url?: string };

// Hosts as `URL` normalises them: IPv4 in dotted decimal, IPv6 compressed, and IPv4-mapped IPv6 in hex
// (`[::ffff:127.0.0.1]` reads `::ffff:7f00:1`), so 127.0.0.0/8 there is `::ffff:7fXX:XXXX`.
const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|::1?|::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}|::ffff:0:0)$/i;

/**
 * The SSH target a web-address sign-in points at: the address's host, with no user, so ssh's own defaults pick the
 * rest (a `Host` entry in ~/.ssh/config, else your user name here). `http://hermes:9119` gives `hermes`, and
 * `https://hermes.tail36fb9.ts.net` gives that name. Empty for a host on this computer (ssh there would open a shell
 * here, not on the server), a host ssh would read as an option, or an address that isn't http(s).
 */
export function sshTargetFromUrl(url: string | undefined): string {
  let u: URL;
  try {
    u = new URL((url ?? "").trim());
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host.startsWith("-") || LOOPBACK.test(host)) return "";
  return host;
}

/** The server's SSH target from the sign-in alone: an SSH sign-in's own, else the web address's host. */
export function signInSshTarget(signIn: SignInAddress): string {
  return signIn.mode === "ssh" ? signIn.sshTarget.trim() : sshTargetFromUrl(signIn.url);
}

/** Where the terminal goes: the target typed for it last, else the sign-in's (ADR 0055). */
export function terminalTarget(signIn: SignInAddress, saved: string | null): string {
  if (saved?.trim()) return saved.trim();
  return signInSshTarget(signIn);
}

/** True when the terminal's target was worked out from a web address, not typed or signed in with. */
export const terminalTargetGuessed = (signIn: SignInAddress, saved: string | null) => !saved?.trim() && signIn.mode === "url" && !!sshTargetFromUrl(signIn.url);

/** How a session's end reads under the terminal. */
export function endedText(s: Extract<TerminalState, { kind: "ended" }>, kind: TerminalKind = "server"): string {
  if (s.byOwner) return "You ended the session.";
  if (s.code === 0) return "The session ended.";
  // ssh's own failures (it couldn't connect, or the key was refused) are 255; ssh has printed why above.
  if (s.code === 255 && kind === "server") return "ssh couldn't connect or lost the connection. What it said is above.";
  if (s.code === null) return "The session was ended by a signal.";
  return `The session ended with exit status ${s.code}.`;
}

/**
 * One terminal at a time. `output` gets every byte ssh prints; `onState` hears each change. Starting again keeps
 * what was printed before, so the screen keeps its scrollback. `folder`: where its shell starts, each time it starts.
 */
export class TerminalSession {
  state: TerminalState = { kind: "idle" };
  private id: number | undefined;
  /** Bumped by each start, so a late event from an earlier ssh can't touch the new one. */
  private run = 0;
  private endedByOwner = false;
  /** The size the screen last asked for; one asked for while ssh starts is sent once it has an id. */
  private size = { cols: 0, rows: 0 };
  private refusalShown = false;

  constructor(
    private api: TerminalApi,
    private output: (data: Uint8Array) => void,
    private onState: (s: TerminalState) => void,
    private folder?: string,
  ) {}

  private set(s: TerminalState) {
    this.state = s;
    this.onState(s);
  }

  get running() {
    return this.state.kind === "connecting" || this.state.kind === "open";
  }

  async start(target: string, cols: number, rows: number) {
    if (this.running) return;
    const run = ++this.run;
    this.id = undefined;
    this.endedByOwner = false;
    this.refusalShown = false;
    target = target.trim();
    this.size = { cols, rows };
    this.set({ kind: "connecting", target });
    const onEvent = (e: TerminalEvent) => {
      if (run !== this.run) return;
      if (e.kind === "output") {
        this.output(e.data);
        if (this.state.kind === "connecting") this.set({ kind: "open", target });
      } else {
        // Rust keeps the terminal until it is closed.
        if (this.id !== undefined) this.api.close(this.id);
        this.id = undefined;
        this.set({ kind: "ended", target, code: e.code, byOwner: this.endedByOwner });
      }
    };
    try {
      const id = await this.api.open(target, cols, rows, onEvent, this.folder);
      if (run !== this.run || this.state.kind === "ended") {
        // Ended before `open` answered: it has nothing left to keep.
        this.api.close(id);
        return;
      }
      this.id = id;
      if (this.endedByOwner) this.api.close(id);
      else if (this.size.cols !== cols || this.size.rows !== rows) void this.api.resize(id, this.size.cols, this.size.rows).catch(() => {});
    } catch (e) {
      if (run === this.run) this.set({ kind: "failed", target, message: errorText(e) });
    }
  }

  /**
   * What the owner typed or pasted. Dropped while no ssh is running. Rust refuses it while the program has a backlog
   * it isn't reading (terminal.rs); why is printed once, then again only after some input has gone through.
   */
  input(data: string) {
    const id = this.id;
    if (id === undefined || this.state.kind !== "open") return;
    this.api.write(id, data).then(
      () => (this.refusalShown = false),
      (e: unknown) => {
        if (this.refusalShown || id !== this.id || this.state.kind !== "open") return;
        this.refusalShown = true;
        this.output(new TextEncoder().encode(`\r\n\x1b[2m── ${e instanceof Error ? e.message : String(e)} ──\x1b[0m\r\n`));
      },
    );
  }

  resize(cols: number, rows: number) {
    this.size = { cols, rows };
    if (this.id !== undefined && this.running) void this.api.resize(this.id, cols, rows).catch(() => {});
  }

  /** Ends the running ssh; its end still arrives as `ended`, marked the owner's. */
  end() {
    if (!this.running) return;
    this.endedByOwner = true;
    if (this.id !== undefined) this.api.close(this.id);
  }

  /** Ends ssh and ignores anything it still sends: the screen is going away. */
  dispose() {
    this.run++;
    if (this.id !== undefined) this.api.close(this.id);
    this.id = undefined;
  }
}
