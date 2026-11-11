// Artifacts: Outputs opened to edit beside the chat (GLOSSARY.md "Artifact", ADR 0029). An artifact is one file on
// one machine: a `host` Output is on the dashboard's own machine and is read and saved through the managed-files
// routes, exactly as Server files edits a file (ADR 0024); any other Output is where its profile's tools run, read with
// `GET /api/fs/read-data-url` and saved with `POST /api/fs/write-text`, the routes that follow the profile's SSH
// workspace. Either way a save checks the revision first and reads the file back after (remoteFiles.ts
// `textEditing`). "Ask Hermes to edit" goes to legacy `llm.oneshot`, which has no tools and can't touch the file: its
// answer is a proposal the owner reviews and applies to the editor, never to the file.
//
// What the editor holds lives here, in memory, for as long as the app runs and the owner stays signed in: the draft,
// its undo history, the proposal under review and the versions kept after saves. Nothing is written to this computer.
import {
  EDIT_DEADLINES,
  RemoteFilesError,
  TimedOut,
  deadline,
  errorText,
  explain,
  newTransferId,
  protectedPath,
  textEditing,
  type EditBase,
  type EditIo,
  type RemoteGet,
  type SaveOutcome,
  SANDBOX_COPY_MISSING,
  SANDBOX_MISSING,
  SANDBOX_NOT_FOUND_PREFIX,
} from "./remoteFiles";
import { RestError, sessionNotFound } from "./pipe";
import { EDIT_MAX_BYTES, MINE_MARK, merge3 } from "./textEdit";
import {
  ASK_INSTRUCTIONS,
  ASK_MAX_SELECTION_CHARS,
  VERSIONS_MAX_CHARS,
  askInput,
  askMaxTokens,
  keep,
  proposed,
  replacementFrom,
  staleBecause,
  wholeChars,
  type KeptVersion,
  type Proposal,
  type Snapshot,
} from "./artifactEdit";
import { emptyHistory, record, redo, undo, type History } from "./editHistory";

/**
 * Which file an artifact is. `scope`: the connection and profile it was opened in (projects.ts `projectScope`), so
 * two sign-ins or profiles never share one. `host`: on the dashboard's own machine. `chatId`: the chat whose tool made
 * it, whose model "Ask Hermes" borrows while the chat is live in this app. `session`: the chat whose sandbox the path
 * is in (outputs.ts `sessionOf`, ADR 0062): every read and save names it, so Hermes looks in that chat's own
 * `/workspace`, and the same path from two chats is two files.
 */
export type ArtifactRef = { scope: string; profile: string; path: string; host: boolean; chatId?: string; session?: string };

export const artifactKey = (r: Pick<ArtifactRef, "scope" | "host" | "path" | "session">) =>
  `${r.scope}\n${r.host ? "host" : "tools"}\n${r.session ? `${r.session}\n` : ""}${r.path}`;
export const artifactName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

/** How an artifact reaches its file and Hermes: the editing calls of `textEditing`, and asking for an edit. */
export type ArtifactIo = {
  open(path: string, name: string): Promise<EditBase>;
  saveEdit(base: EditBase, text: string): Promise<SaveOutcome>;
  saveCopy(base: EditBase, text: string): Promise<string>;
};

/** Asks Hermes for an edit (transport.ts `askForEdit`). `lent`: the chat's own model answered. */
export type AskHermes = (o: { profile: string; chatId?: string; instructions: string; input: string; maxTokens: number }) => Promise<{ text: string; lent: boolean }>;

/** The read and write an artifact on the tools' machine uses (src-tauri `fs_save_text`). */
export type AgentFsPipe = {
  saveText(id: number, profile: string, path: string, text: string, session?: string): Promise<string>;
  cancel(id: number): Promise<void>;
};

/** Hermes's refusals from `fs_write_text` and its SSH workspace backend that come before anything is written. */
function refusedBeforeWriting(e: unknown): boolean {
  if (!(e instanceof RestError)) return /^Hermes Chat doesn't relay|^Not connected|^it's .* MB, over the .* MB limit/i.test(errorText(e));
  const status = e.status;
  if (status === 401 || status === 422) return true;
  let detail: unknown;
  try {
    detail = (JSON.parse(e.body) as { detail?: unknown }).detail;
  } catch {
    return false;
  }
  if (typeof detail !== "string") return false;
  const before: Record<number, (d: string) => boolean> = {
    400: (d) => ["Path is required", "Invalid path", "Path points to a directory", "Only regular files can be written", "Parent directory does not exist", "Only regular files can be read"].includes(d),
    403: (d) => d === "File is not writable" || d === "File is not readable",
    404: (d) => d === "File not found",
    413: (d) => d === "Content too large" || d === "File too large",
    // The SSH workspace couldn't be reached at all.
    503: (d) => d === "SSH workspace is unavailable",
    // The chat's own copy of the file is gone, and Hermes won't save into another sandbox instead (ADR 0062).
    409: (d) => d === SANDBOX_COPY_MISSING,
    // The temp file couldn't be written or renamed into place: Hermes removed it, and the file is as it was.
    500: (d) => d.startsWith("Could not write file:"),
  };
  return before[status]?.(detail) ?? false;
}

/** Why a read or write on the tools' machine failed, in the owner's words, with the status the save logic reads. */
function explainFs(e: unknown, what: "read" | "write"): RemoteFilesError {
  const message = errorText(e);
  if (/^Not connected to Hermes|^The chat connection is closed|^Can't reach the Hermes dashboard/.test(message))
    return new RemoteFilesError("Hermes isn't connected. Your edit stays here until it is.", undefined, true);
  if (/^it's .* MB now, over the .* MB limit/.test(message)) return new RemoteFilesError(`It's grown past what the editor opens (${EDIT_MAX_BYTES / 1024 / 1024} MB).`, 413);
  const known: Record<string, [number, string]> = {
    "Path points to a directory": [400, "That path is a folder now."],
    "Only regular files can be read": [400, "That isn't a regular file."],
    "Only regular files can be written": [400, "That isn't a regular file."],
    "Parent directory does not exist": [404, "Its folder isn't on the server any more."],
    "SSH workspace is unavailable": [503, "The profile's SSH workspace can't be reached, so the file can't be read or saved."],
    "File is not writable": [403, "The server's user isn't allowed to write this file."],
    "Content too large": [413, "Hermes takes text files up to 8 MB."],
  };
  if (e instanceof RestError) {
    let detail = e.body;
    try {
      const d = (JSON.parse(e.body) as { detail?: unknown }).detail;
      if (typeof d === "string") detail = d;
    } catch {
      // As it came.
    }
    if (detail in known) return new RemoteFilesError(known[detail][1], known[detail][0]);
    if (detail === SANDBOX_COPY_MISSING) return new RemoteFilesError("Its chat's copy of the file is gone, so Hermes won't save it into another sandbox.", 409);
    if (detail.startsWith(SANDBOX_NOT_FOUND_PREFIX)) return new RemoteFilesError(SANDBOX_MISSING, 404);
    if (detail === "File not found") return new RemoteFilesError("That file isn't on the server, or is gone now.", 404);
  }
  return explain(e, what);
}

/**
 * The editing calls for a file where `profile`'s tools run: exact bytes from `GET /api/fs/read-data-url`, saves
 * through `POST /api/fs/write-text` (ADR 0029), a copy's free name from `GET /api/fs/list`. Every request names the
 * profile. `session`: the chat whose sandbox the file is in (ADR 0062). Reads and saves name it as `session_id`, so a
 * container path such as `/workspace/…` is that chat's own. If Hermes no longer has the chat ("Session not found"),
 * reads ask without it from then on, as before, and saves follow the read, so a save lands where the read did.
 */
export function agentFsEditIo(get: RemoteGet, pipe: AgentFsPipe, profile: string, session?: string): EditIo {
  // A data URL of the whole file: about 4/3 of it, plus a little.
  const answerMax = Math.ceil(EDIT_MAX_BYTES / 3) * 4 + 64 * 1024;
  let chat = session;
  const read = (path: string) => get(`api/fs/read-data-url?${new URLSearchParams({ path, profile, ...(chat && { session_id: chat }) })}`, answerMax);
  return {
    async readBytes(path) {
      let body: string;
      try {
        body = await deadline(
          read(path).catch((e) => {
            if (!chat || !sessionNotFound(e)) throw e;
            chat = undefined;
            return read(path);
          }),
          EDIT_DEADLINES.readMs,
        );
      } catch (e) {
        throw e instanceof TimedOut ? new RemoteFilesError(e.message) : explainFs(e, "read");
      }
      let dataUrl: unknown;
      try {
        dataUrl = (JSON.parse(body) as { dataUrl?: unknown }).dataUrl;
      } catch {
        throw new RemoteFilesError("The server's answer isn't a file.");
      }
      const m = typeof dataUrl === "string" && /^data:[^,]*;base64,/.exec(dataUrl);
      if (typeof dataUrl !== "string" || !m) throw new RemoteFilesError("The server's answer isn't a file.");
      // `read-data-url` names no path; it reads the one asked for.
      return { path, bytes: Uint8Array.from(atob(dataUrl.slice(m[0].length)), (c) => c.charCodeAt(0)) };
    },
    async writeText(path, text) {
      // `write-text` has no "don't replace": a copy relies on the name it picked being free when listed (ADR 0029).
      const id = newTransferId();
      try {
        await deadline(pipe.saveText(id, profile, path, text, chat), EDIT_DEADLINES.writeMs);
      } catch (e) {
        if (e instanceof TimedOut) void pipe.cancel(id).catch(() => {});
        if (!(e instanceof TimedOut) && refusedBeforeWriting(e)) throw explainFs(e, "write");
        throw { lost: e instanceof TimedOut ? `Hermes didn't answer within ${EDIT_DEADLINES.writeMs / 1000} s.` : explainFs(e, "write").message };
      }
    },
    async listNames(folder) {
      let body: string;
      try {
        body = await deadline(get(`api/fs/list?${new URLSearchParams({ path: folder, profile })}`, 8 * 1024 * 1024), EDIT_DEADLINES.readMs);
      } catch (e) {
        throw e instanceof TimedOut ? new RemoteFilesError(e.message) : explainFs(e, "read");
      }
      const res = JSON.parse(body) as { entries?: { name?: unknown }[]; error?: unknown };
      if (typeof res.error === "string") throw new RemoteFilesError(`Its folder can't be listed (${res.error}).`);
      return { path: folder, names: new Set((res.entries ?? []).flatMap((e) => (typeof e?.name === "string" ? [e.name] : []))) };
    },
  };
}

/** The editing calls for an artifact: `host` files through Server files' own editing, the rest where tools run. */
export function artifactIo(o: { host: boolean; files: { openForEdit: (e: { name: string; path: string; kind: "file" }) => Promise<EditBase>; saveEdit: ArtifactIo["saveEdit"]; saveCopy: ArtifactIo["saveCopy"] }; fs: EditIo }): ArtifactIo {
  if (o.host) return { open: (path, name) => o.files.openForEdit({ name, path, kind: "file" }), saveEdit: o.files.saveEdit, saveCopy: o.files.saveCopy };
  const editing = textEditing(o.fs);
  return {
    open: (path, name) => (protectedPath(path) ? Promise.reject(new RemoteFilesError("Hermes Chat doesn't edit credential files.")) : editing.open(path, name)),
    saveEdit: editing.saveEdit,
    saveCopy: editing.saveCopy,
  };
}

type Conflict = Extract<SaveOutcome, { kind: "conflict" }>;

/**
 * One open artifact. `base`: the version of the file the draft is based on, as last read or saved. `draft`: the
 * editor's text, never written anywhere until Save. `busy`: a read, save, copy or ask under way. `conflict`: a save
 * found another version on the server and wrote nothing (or found a third one after); the draft is kept. `proposal`:
 * an edit Hermes proposed, under review; `rejected` says why it can't be applied any more. `versions`: kept in memory.
 */
export type ArtifactSession = {
  key: string;
  ref: ArtifactRef;
  name: string;
  state: "loading" | "refused" | "ready";
  why?: string;
  base?: EditBase;
  draft: string;
  sel: { start: number; end: number };
  history: History<Snapshot>;
  busy?: "saving" | "copying" | "asking";
  error?: string;
  note?: string;
  conflict?: Conflict;
  proposal?: Proposal;
  rejected?: string;
  versions: KeptVersion[];
  savedAt?: number;
};

export const isDirty = (s: ArtifactSession | undefined) => !!s?.base && s.draft !== s.base.text;

let nextId = 1;

/**
 * The open artifacts, by `artifactKey`. Each async call checks, when it answers, that its session is still the one it
 * started for (`gen`), so an answer for a file closed or reopened since is dropped.
 */
export class ArtifactStore {
  private sessions = new Map<string, ArtifactSession>();
  private gens = new Map<string, number>();
  /**
   * Each artifact's editing calls, made once: they remember a copy whose outcome wasn't known (remoteFiles.ts
   * `textEditing`), so trying again checks it first instead of making a second copy.
   */
  private ios = new Map<string, ArtifactIo>();
  private snapshot: ReadonlyMap<string, ArtifactSession> = new Map();
  private listeners = new Set<() => void>();

  constructor(
    private readonly ioFor: (ref: ArtifactRef) => ArtifactIo,
    private readonly ask: AskHermes,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getSnapshot = () => this.snapshot;

  get(key: string): ArtifactSession | undefined {
    return this.sessions.get(key);
  }

  /** Artifacts with an edit not saved to Hermes, in `scope` or everywhere. */
  unsaved(scope?: string): ArtifactSession[] {
    return [...this.sessions.values()].filter((s) => isDirty(s) && (scope === undefined || s.ref.scope === scope));
  }

  private set(key: string, patch: Partial<ArtifactSession>) {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.set(key, { ...s, ...patch });
    this.publish();
  }

  private publish() {
    this.snapshot = new Map(this.sessions);
    for (const l of this.listeners) l();
  }

  private io(key: string, ref: ArtifactRef): ArtifactIo {
    let io = this.ios.get(key);
    if (!io) this.ios.set(key, (io = this.ioFor(ref)));
    return io;
  }

  /** Whether the session `key` is still the one numbered `gen`. */
  private live(key: string, gen: number) {
    return this.gens.get(key) === gen && this.sessions.has(key);
  }

  private keepVersion(key: string, v: Omit<KeptVersion, "id" | "at">) {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.set(key, { ...s, versions: keep(s.versions, { ...v, id: nextId++, at: this.now() }) });
    // Every file's versions together stay within the cap: the oldest version of whichever file has the most goes.
    let total = [...this.sessions.values()].reduce((n, x) => n + x.versions.reduce((m, v) => m + v.text.length, 0), 0);
    while (total > VERSIONS_MAX_CHARS) {
      const most = [...this.sessions.values()].filter((x) => x.versions.length > 1).sort((a, b) => b.versions.length - a.versions.length)[0];
      if (!most) break;
      total -= most.versions[0].text.length;
      this.sessions.set(most.key, { ...most, versions: most.versions.slice(1) });
    }
  }

  /** Opens `ref` to edit, or does nothing when it is open: its draft, history and versions stay as they were. */
  open(ref: ArtifactRef): string {
    const key = artifactKey(ref);
    const had = this.sessions.get(key);
    if (had && had.state !== "refused") return key;
    this.load(key, ref, had?.versions ?? []);
    return key;
  }

  /** Reads the file again, for a session that couldn't open it. */
  retry(key: string) {
    const s = this.sessions.get(key);
    if (s && s.state === "refused") this.load(key, s.ref, s.versions);
  }

  private load(key: string, ref: ArtifactRef, versions: KeptVersion[]) {
    const gen = nextId++;
    this.gens.set(key, gen);
    const name = artifactName(ref.path);
    this.sessions.set(key, { key, ref, name, state: "loading", draft: "", sel: { start: 0, end: 0 }, history: emptyHistory(), versions });
    this.publish();
    this.io(key, ref)
      .open(ref.path, name)
      .then(
        (base) => {
          if (!this.live(key, gen)) return;
          this.set(key, { state: "ready", base, draft: base.text, why: undefined });
          this.keepVersion(key, { kind: "opened", text: base.text, revision: base.revision });
          this.publish();
        },
        (e) => this.live(key, gen) && this.set(key, { state: "refused", why: errorText(e) }),
      );
  }

  /** Forgets `key`: its draft, history and versions. */
  close(key: string) {
    this.gens.delete(key);
    this.ios.delete(key);
    if (this.sessions.delete(key)) this.publish();
  }

  /** Forgets every artifact, on signing out: nothing is kept for another sign-in. */
  clear() {
    this.gens.clear();
    this.ios.clear();
    this.sessions.clear();
    this.publish();
  }

  /** The owner typed: `text` is the editor's new text, `sel` where the cursor is now. */
  type(key: string, text: string, sel: { start: number; end: number }) {
    const s = this.sessions.get(key);
    if (!s || s.state !== "ready" || s.busy === "saving" || s.busy === "copying" || text === s.draft) return;
    // A note about what happened before ("Saved.", "Merged.") no longer describes the text once it's typed over.
    this.set(key, { draft: text, sel, history: record(s.history, { text: s.draft, ...s.sel }, "typing", this.now()), error: undefined, note: undefined });
  }

  select(key: string, start: number, end: number) {
    const s = this.sessions.get(key);
    // The editor says how much is selected, which is what "Ask Hermes to edit" would change.
    if (s && (s.sel.start !== start || s.sel.end !== end)) this.set(key, { sel: { start, end } });
  }

  /** A change that isn't typing: its own undo step. */
  private change(key: string, text: string, sel: { start: number; end: number }, extra: Partial<ArtifactSession> = {}) {
    const s = this.sessions.get(key);
    if (!s) return;
    this.set(key, { draft: text, sel, history: record(s.history, { text: s.draft, ...s.sel }, "change", this.now()), ...extra });
  }

  undo(key: string) {
    const s = this.sessions.get(key);
    if (!s || s.busy === "saving" || s.busy === "copying") return;
    const step = undo(s.history, { text: s.draft, ...s.sel });
    if (step) this.set(key, { draft: step.state.text, sel: { start: step.state.start, end: step.state.end }, history: step.history });
  }

  redo(key: string) {
    const s = this.sessions.get(key);
    if (!s || s.busy === "saving" || s.busy === "copying") return;
    const step = redo(s.history, { text: s.draft, ...s.sel });
    if (step) this.set(key, { draft: step.state.text, sel: { start: step.state.start, end: step.state.end }, history: step.history });
  }

  /** Cancel: the draft goes back to the file as last read or saved. Kept versions stay. */
  discard(key: string) {
    const s = this.sessions.get(key);
    if (!s?.base || s.busy === "saving" || s.busy === "copying") return;
    this.set(key, { draft: s.base.text, sel: { start: 0, end: 0 }, history: emptyHistory(), proposal: undefined, rejected: undefined, conflict: undefined, error: undefined, note: undefined });
  }

  /** Puts a kept version's text into the editor, as an undoable change. Nothing is written until Save. */
  restore(key: string, versionId: number) {
    const s = this.sessions.get(key);
    const v = s?.versions.find((x) => x.id === versionId);
    if (!s || !v || s.state !== "ready" || s.busy === "saving" || s.busy === "copying") return;
    this.change(key, v.text, { start: 0, end: 0 }, { note: "The kept version is in the editor. Save to write it to the file." });
  }

  async save(key: string) {
    const s = this.sessions.get(key);
    const gen = this.gens.get(key);
    if (!s?.base || s.busy || gen === undefined) return;
    const { base, draft } = s;
    this.set(key, { busy: "saving", error: undefined, note: undefined });
    let got: SaveOutcome;
    try {
      got = await this.io(key, s.ref).saveEdit(base, draft);
    } catch (e) {
      if (this.live(key, gen)) this.set(key, { busy: undefined, error: errorText(e) });
      return;
    }
    if (!this.live(key, gen)) return;
    const now = this.sessions.get(key)!;
    if (got.kind === "saved") {
      // The version the save replaced stays recoverable, and so does the one it wrote.
      this.keepVersion(key, { kind: "prior", text: base.text, revision: base.revision });
      this.keepVersion(key, { kind: "saved", text: got.base.text, revision: got.base.revision });
      // Typing while it saved stays in the editor, over the saved version.
      this.set(key, { busy: undefined, base: got.base, conflict: undefined, savedAt: this.now(), draft: now.draft === draft ? got.base.text : now.draft, note: `Saved. Hermes has your edit, read back from the server.` });
      return;
    }
    if ("bytes" in got.theirs) this.keepVersion(key, { kind: "server", text: got.theirs.text, revision: got.theirs.revision });
    this.set(key, { busy: undefined, conflict: got });
  }

  /** After a conflict: combines the edit and the server's version, both from `base`; the server's becomes the base. */
  merge(key: string) {
    const s = this.sessions.get(key);
    const theirs = s?.conflict?.theirs;
    if (!s?.base || !theirs || !("bytes" in theirs)) return;
    const merged = merge3(s.base.text, s.draft, theirs.text);
    this.change(key, merged.text, { start: 0, end: 0 }, {
      base: theirs,
      conflict: undefined,
      note: merged.conflicts
        ? `Merged with the server's version. ${merged.conflicts} ${merged.conflicts === 1 ? "place" : "places"} both changed ${merged.conflicts === 1 ? "is" : "are"} marked with “${MINE_MARK}”: keep what you want there, remove the markers, then save.`
        : "Merged with the server's version: your changes are on top of it. Review, then save.",
    });
  }

  /** After a conflict: drops the edit for the server's version. The edit stays one Undo away. */
  reload(key: string) {
    const s = this.sessions.get(key);
    const theirs = s?.conflict?.theirs;
    if (!s || !theirs || !("bytes" in theirs)) return;
    this.change(key, theirs.text, { start: 0, end: 0 }, { base: theirs, conflict: undefined, note: "Reloaded the server's version. Undo brings your edit back." });
  }

  async saveCopy(key: string) {
    const s = this.sessions.get(key);
    const gen = this.gens.get(key);
    if (!s?.base || s.busy || gen === undefined) return;
    this.set(key, { busy: "copying", error: undefined });
    try {
      const path = await this.io(key, s.ref).saveCopy(s.base, s.draft);
      if (this.live(key, gen)) this.set(key, { busy: undefined, conflict: undefined, note: `Your edit was saved as a copy, ${path}. ${s.name} on the server is as Hermes has it; your edit is still here.` });
    } catch (e) {
      if (this.live(key, gen)) this.set(key, { busy: undefined, error: errorText(e) });
    }
  }

  /**
   * Asks Hermes to edit the selection (the whole text when nothing is selected) as `instruction` says. Hermes's answer
   * becomes a proposal for review; nothing changes in the editor until the owner applies it.
   */
  async askEdit(key: string, instruction: string) {
    const s = this.sessions.get(key);
    const gen = this.gens.get(key);
    if (!s?.base || s.busy || gen === undefined || !instruction.trim()) return;
    const sel = s.sel.start === s.sel.end ? { start: 0, end: s.draft.length } : wholeChars(s.draft, s.sel.start, s.sel.end);
    if (sel.end - sel.start > ASK_MAX_SELECTION_CHARS) {
      this.set(key, { error: `Select at most ${ASK_MAX_SELECTION_CHARS.toLocaleString("en-US")} characters for Hermes to edit at once.` });
      return;
    }
    const before = s.draft;
    const baseRevision = s.base.revision;
    this.set(key, { busy: "asking", error: undefined, proposal: undefined, rejected: undefined });
    try {
      const got = await deadline(
        this.ask({
          profile: s.ref.profile,
          chatId: s.ref.chatId,
          instructions: ASK_INSTRUCTIONS,
          input: askInput({ path: s.ref.path, revision: baseRevision, text: before, ...sel, instruction }),
          maxTokens: askMaxTokens(sel.end - sel.start),
        }),
        ASK_DEADLINE_MS,
      );
      if (!this.live(key, gen)) return;
      const proposal: Proposal = { id: nextId++, instruction: instruction.trim(), before, baseRevision, ...sel, replacement: replacementFrom(got.text), lent: got.lent, at: this.now() };
      this.set(key, { busy: undefined, proposal });
    } catch (e) {
      if (this.live(key, gen)) this.set(key, { busy: undefined, error: `Hermes couldn't propose an edit: ${errorText(e)}` });
    }
  }

  /**
   * Asks again for a proposal Hermes made against older text: the same request, for the same passage where it still
   * is (at the same place, or the only place that has it now). A passage that changed, or now appears more than once,
   * isn't guessed at: the owner selects it again.
   */
  async askAgain(key: string) {
    const s = this.sessions.get(key);
    const p = s?.proposal;
    if (!s || !p || s.busy) return;
    const passage = p.before.slice(p.start, p.end);
    let range: { start: number; end: number } | undefined;
    if (p.start === 0 && p.end === p.before.length) range = { start: 0, end: s.draft.length };
    else if (s.draft.slice(p.start, p.end) === passage) range = { start: p.start, end: p.end };
    else {
      const at = s.draft.indexOf(passage);
      if (at >= 0 && s.draft.indexOf(passage, at + 1) < 0) range = { start: at, end: at + passage.length };
    }
    if (!range) {
      this.set(key, { proposal: undefined, rejected: undefined, error: "The text Hermes was asked to edit has changed. Select it again, then ask." });
      return;
    }
    this.set(key, { sel: range });
    await this.askEdit(key, p.instruction);
  }

  /** Applies the proposal under review to the editor, only if the text and its base are exactly what it was made for. */
  apply(key: string): boolean {
    const s = this.sessions.get(key);
    const p = s?.proposal;
    if (!s || !p || s.busy === "saving" || s.busy === "copying") return false;
    const why = staleBecause(p, s.draft, s.base?.revision);
    if (why) {
      this.set(key, { rejected: why });
      return false;
    }
    this.change(key, proposed(p), { start: p.start, end: p.start + p.replacement.length }, { proposal: undefined, rejected: undefined, note: "Hermes's edit is in the editor, not yet saved. Undo takes it out." });
    return true;
  }

  dismissProposal(key: string) {
    this.set(key, { proposal: undefined, rejected: undefined });
  }

  clearMessages(key: string) {
    this.set(key, { error: undefined, note: undefined });
  }
}

/** How long to wait for Hermes's proposal: `llm.oneshot` itself gives up after 60 s (`agent/oneshot.py`). */
export const ASK_DEADLINE_MS = 90_000;

