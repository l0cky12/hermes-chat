// The Rust commands for a project's context files (src-tauri `context_*`, ADR 0135), over a fake Hermes's disks.
import type { FakeFile, FakeWorktree } from "./fakeHermes";
import type { FakeServerFiles } from "./fakeServerFiles";
import type { LocalFile as PickedFile } from "./pipe";
import { MAX_FILE_BYTES, SSH_MAX_BYTES, SSH_REFUSED, nameProblem } from "./projectContext";
import type { ContextPipe, GitExclude } from "./projectContextFiles";

const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const toBytes = (text: string) => Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join("");
const fromBytes = (bytes: string) => new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));

export type FakeContextDisks = {
  /** The dashboard machine's disk. */
  managed: FakeServerFiles;
  /** This computer's disk, by path: a string is a file's bytes, one char per byte. */
  local(): Record<string, FakeFile>;
  /** The disk `/api/fs/*` reads: the SSH machine's for an SSH profile, the dashboard's otherwise. */
  agentFiles(): Record<string, string | { dir: true }>;
  agentDirs(): Set<string>;
  repos(): FakeWorktree[][];
};

export class FakeProjectContext {
  /** The native Open dialog: the local paths the owner picks; none when they close it. */
  dialog: () => string[] = () => [];
  /** The text Rust extracts from a PDF or a Word document, by server path. One without an entry has none. */
  extracted: Record<string, string> = {};
  /** Set: Hermes answers a write, but the file lands this many bytes short. */
  shortBy?: number;
  /** Every file written, in order: where, and whether it replaced one. */
  readonly writes: { path: string; overwrite: boolean; ssh?: string }[] = [];
  readonly reads: string[] = [];
  readonly removed: string[] = [];
  readonly made: string[] = [];
  /** The main folders whose repository has `context/` in its `info/exclude`. */
  readonly excluded = new Set<string>();
  private stamp = 1_793_300_000;

  constructor(private disks: FakeContextDisks) {}

  private stat(path: string): PickedFile {
    const f = this.disks.local()[path];
    if (f === undefined || (typeof f === "object" && "dir" in f)) return { path, name: basename(path), error: "it isn't a file the app was given" };
    return { path, name: basename(path), size: typeof f === "string" ? f.length : f.size };
  }

  private target(path: string) {
    if (basename(dirname(path)) !== "context") throw new Error(`${path} isn't in a project's context folder.`);
    const bad = nameProblem(basename(path));
    if (bad) throw new Error(`${basename(path)} can't be a context file: ${bad}.`);
  }

  private write(path: string, bytes: string, overwrite: boolean, ssh?: string) {
    this.target(path);
    if (ssh !== undefined) {
      let text: string;
      try {
        text = fromBytes(bytes);
      } catch {
        throw new Error(SSH_REFUSED);
      }
      if (text.includes("\0") || bytes.length > SSH_MAX_BYTES) throw new Error(SSH_REFUSED);
      const dir = dirname(path);
      const there = this.disks.agentDirs().has(dir) || Object.keys(this.disks.agentFiles()).some((p) => p.startsWith(`${dir}/`));
      if (!there) throw new Error(`The dashboard answered 400: {"detail":"Parent directory does not exist"}`);
      this.disks.agentFiles()[path] = text;
    } else {
      const { nodes } = this.disks.managed;
      if (nodes[path] && !overwrite) throw new Error("exists");
      nodes[path] = { bytes: bytes.slice(0, bytes.length - (this.shortBy ?? 0)), mtime: ++this.stamp };
    }
    this.writes.push({ path, overwrite, ...(ssh !== undefined && { ssh }) });
  }

  pipe(): ContextPipe {
    return {
      pick: async () => this.dialog().map((p) => this.stat(p)),
      localFiles: async (paths) => paths.map((p) => this.stat(p)),
      upload: async (_id, local, serverPath, overwrite, ssh) => {
        const file = this.stat(local);
        if (file.size === undefined) throw new Error(`${file.name} can't be sent: ${file.error}.`);
        if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is over the 30 MB a context file can be.`);
        const bytes = this.disks.local()[local];
        this.write(serverPath, typeof bytes === "string" ? bytes : "x".repeat(file.size), overwrite, ssh);
      },
      writeText: async (serverPath, text, overwrite, ssh) => this.write(serverPath, toBytes(text), overwrite, ssh),
      mkdir: async (path) => {
        if (basename(path) !== "context") throw new Error(`${path} isn't a project's context folder.`);
        this.disks.managed.nodes[path] ??= { dir: true };
        this.disks.agentDirs().add(path).add(dirname(path));
        this.made.push(path);
        return path;
      },
      remove: async (serverPath) => {
        this.target(serverPath);
        if (!this.disks.managed.nodes[serverPath]) throw new Error(`The dashboard answered 404: {"detail":"Path not found"}`);
        delete this.disks.managed.nodes[serverPath];
        this.removed.push(serverPath);
      },
      readText: async (serverPath, _size, ssh) => {
        this.reads.push(serverPath);
        if (serverPath in this.extracted) return this.extracted[serverPath];
        if (/\.(pdf|docx)$/i.test(serverPath)) return undefined;
        if (ssh !== undefined) {
          const f = this.disks.agentFiles()[serverPath];
          return typeof f === "string" && !f.includes("\0") ? f : undefined;
        }
        const node = this.disks.managed.nodes[serverPath];
        if (!node || "dir" in node || "link" in node || "size" in node) return undefined;
        if ("text" in node) return node.text;
        try {
          const text = fromBytes(node.bytes);
          return text.slice(0, 4096).includes("\0") ? undefined : text;
        } catch {
          return undefined;
        }
      },
      gitExclude: async (mainFolder): Promise<GitExclude> => {
        const inRepo = this.disks.repos().some((trees) => trees.some((t) => mainFolder === t.path || mainFolder.startsWith(`${t.path}/`)));
        if (!inRepo) return "none";
        if (this.excluded.has(mainFolder)) return "already";
        this.excluded.add(mainFolder);
        return "added";
      },
    };
  }
}
