// Thumbnails for the images staged in the composer. Rust reads the bytes (image files only, up to 25 MB), and each
// becomes a blob: URL that lives only while its image is staged. Nothing is copied to disk.
import { useState } from "react";
import { Paperclip, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { Attachment } from "../hermes/model";
import { asError } from "../hermes/tauriPipe";
import { fmtSize } from "./bits";
import { errorText } from "../hermes/values";

/** A staged image's thumbnail once read, or why it couldn't be read. */
export type Preview = { url: string } | { error: string };

export const readPreview = (path: string): Promise<Blob> =>
  invoke<ArrayBuffer>("hermes_read_preview", { path })
    .catch(asError)
    .then((bytes) => new Blob([bytes]));

/**
 * The composer's thumbnails. `sync` reads newly staged images and releases the URLs of ones no longer staged (removed,
 * sent, or swapped for a new list); `dispose` releases them all. `onChange` fires when a thumbnail is ready or fails.
 */
export class Previews {
  private readonly ready = new Map<string, Preview>();
  /** The read in flight for each path; a read whose path was unstaged meanwhile is thrown away when it lands. */
  private readonly reading = new Map<string, object>();
  private disposed = false;

  constructor(
    private readonly read: (path: string) => Promise<Blob>,
    private readonly onChange: () => void,
    private readonly urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
  ) {}

  get(path: string): Preview | undefined {
    return this.ready.get(path);
  }

  sync(attachments: Attachment[]) {
    const staged = new Set(attachments.filter((a) => a.kind === "image").map((a) => a.path));
    for (const [path, p] of this.ready)
      if (!staged.has(path)) {
        this.release(p);
        this.ready.delete(path);
      }
    for (const path of this.reading.keys()) if (!staged.has(path)) this.reading.delete(path);
    for (const path of staged) if (!this.ready.has(path) && !this.reading.has(path)) void this.load(path);
  }

  dispose() {
    this.disposed = true;
    this.sync([]);
  }

  private async load(path: string) {
    const token = {};
    this.reading.set(path, token);
    let p: Preview;
    try {
      p = { url: this.urls.createObjectURL(await this.read(path)) };
    } catch (e) {
      p = { error: errorText(e) };
    }
    if (this.disposed || this.reading.get(path) !== token) return this.release(p);
    this.reading.delete(path);
    this.ready.set(path, p);
    this.onChange();
  }

  private release(p: Preview) {
    if ("url" in p) this.urls.revokeObjectURL(p.url);
  }
}

/** A staged attachment: its thumbnail if it is an image that could be read, else a paperclip. */
export function AttachmentChip({ file, preview, onRemove }: { file: Attachment; preview?: Preview; onRemove: () => void }) {
  // The bytes looked like an image but the webview couldn't draw them.
  const [broken, setBroken] = useState(false);
  const url = preview && "url" in preview && !broken ? preview.url : undefined;
  const why = broken ? "the image couldn't be shown" : preview && "error" in preview ? preview.error : undefined;
  return (
    <span className="chip" title={why ? `${file.path}\nNo preview: ${why}` : file.path}>
      {url ? <img className="chip-thumb" src={url} alt="" onError={() => setBroken(true)} /> : <Paperclip size={12} />}
      <span className="chip-name">{file.name}</span>
      <span className="chip-size">{fmtSize(file.size)}</span>
      <button title="Remove" onClick={onRemove}>
        <X size={12} />
      </button>
    </span>
  );
}
