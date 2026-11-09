// The preview pane's Local files, through Rust: the Open dialog runs there, and only a file picked in it can be read
// again (src-tauri/src/lib.rs `preview_pick_local`, `preview_read_local`, `preview_read_local_image`). Its web pages'
// framing check and Open in your browser (src-tauri/src/web_page.rs, ADR 0011), its page view (page_view.rs, ADR
// 0081), and the dev servers its empty state lists (dev_servers.rs, ADR 0103).
import { Channel, invoke } from "@tauri-apps/api/core";
import { asError } from "../hermes/tauriPipe";
import { readLocalFile, type FileView, type Framing, type LocalText, type ViewUrl } from "../hermes/preview";

export type LocalFiles = {
  /** Opens the Open dialog; null when the owner cancels. */
  pick(): Promise<{ path: string; name: string } | null>;
  /** Reads a picked file. An image's `src` is an object URL, for the caller to revoke. */
  read(file: { path: string; name: string }): Promise<FileView>;
};

export const tauriLocalFiles: LocalFiles = {
  pick: () => invoke<{ path: string; name: string } | null>("preview_pick_local").catch(asError),
  read: (file) =>
    readLocalFile(file, {
      readText: (path) => invoke<LocalText>("preview_read_local", { path }).catch(asError),
      readImage: async (path) => {
        const bytes = await invoke<ArrayBuffer>("preview_read_local_image", { path }).catch(asError);
        return URL.createObjectURL(new Blob([bytes]));
      },
    }),
};

export type WebPages = {
  /** Whether the site refuses to be shown in the pane's frame, asked the way the frame asks. */
  check(url: string): Promise<Framing>;
  /** Opens the page in the owner's default browser, and gives the browser's name where it is known. Rejects with why it couldn't. */
  openInBrowser(url: string): Promise<string | null>;
  /** Where there is one (Linux), the Preview's own page view, which takes the frame's place (ADR 0081). */
  native?: NativePages;
  /** What listens on the Hermes server and on this computer, that a dev server could be on. */
  devServers(): Promise<DevServers>;
};

/** A port something listens on. `process`: its program's name, where it could be read. */
export type Listening = { port: number; process?: string };
/**
 * What listens on the Hermes server's loopback (through the sign-in's SSH target) and on this computer's. `server`
 * says why it has no list: a URL sign-in has no SSH target, the app isn't connected, or ssh or `ss` failed.
 */
export type DevServers = {
  server: { kind: "listed"; ports: Listening[] } | { kind: "noSshTarget" } | { kind: "notConnected" } | { kind: "failed"; message: string };
  local: Listening[];
};

/** A rectangle in the window's CSS pixels. */
export type Rect = { x: number; y: number; width: number; height: number };
/** Where a native page shows, and the parts of that the app's own layers cover, which the page leaves bare. */
export type Placement = { rect: Rect; holes: Rect[] };
/**
 * What the page view says. `at`: it shows `url` now, because a load committed or the page changed its own address.
 * `replace`: that address takes the current entry's place (where a `go` or `reload` landed, a redirect, replaceState);
 * otherwise the page moved by itself. `failed`: it couldn't load, or its process ended. `escaped`: the owner pressed
 * Escape in it and the page didn't use it, which gives the keyboard back to the app.
 */
export type PageEvent = { kind: "at"; url: ViewUrl; replace: boolean } | { kind: "failed"; message: string } | { kind: "escaped" };
/**
 * The page view while the Preview shows web pages one after another, so a link inside the page, Back and Forward
 * never make a new one. `go`: show `url`, by going back or forward in the view's own list when that is where it is
 * (the page comes back as a browser brings it back), else by loading it. `reload`: load the page again. Hidden until
 * placed; `close` ends the view and its page.
 */
export type NativePage = { go(url: ViewUrl): void; reload(): void; place(placement: Placement | null): void; close(): void };
/** Makes an empty, hidden view. Its events go to `onEvent` until `close`. */
export type NativePages = { open(onEvent: (e: PageEvent) => void): NativePage };

/**
 * The view's commands, each sent once the one before it has finished, so Rust gets them in the order the pane made
 * them: a close never comes before its open, nor an old page's open after a new one's.
 */
let viewCommands: Promise<unknown> = Promise.resolve();
const inOrder = <T>(command: () => Promise<T>): Promise<T> => {
  const sent = viewCommands.then(command);
  viewCommands = sent.catch(() => {});
  return sent;
};

export const tauriNativePages: NativePages = {
  open: (onEvent) => {
    // The view's name in Rust, so a view that went away can't move or close the next one.
    const key = crypto.randomUUID();
    const events = new Channel<PageEvent>();
    events.onmessage = onEvent;
    const failed = (e: unknown) => onEvent({ kind: "failed", message: String(e) });
    inOrder(() => invoke("preview_page_open", { key, onEvent: events })).catch(failed);
    return {
      go: (url) => void inOrder(() => invoke("preview_page_go", { key, url })).catch(failed),
      reload: () => void inOrder(() => invoke("preview_page_reload", { key })).catch(() => {}),
      place: (placement) => void inOrder(() => invoke("preview_page_place", { key, placement })).catch(() => {}),
      close: () => void inOrder(() => invoke("preview_page_close", { key })).catch(() => {}),
    };
  },
};

export const tauriWebPages: WebPages = {
  check: (url) => invoke<Framing>("preview_check_web", { url, userAgent: navigator.userAgent }).catch(asError),
  openInBrowser: (url) => invoke<string | null>("preview_open_in_browser", { url }).catch(asError),
  ...(/\bLinux\b/.test(navigator.userAgent) && { native: tauriNativePages }),
  devServers: () => invoke<DevServers>("preview_dev_servers").catch(asError),
};

/**
 * A page on the Hermes server's own loopback, opened through an SSH tunnel to the sign-in's SSH target
 * (src-tauri/src/server_page.rs, ADR 0052). `url`: where the frame loads it, on this computer's `127.0.0.1`.
 * `target`: the SSH target it goes through. `at`: where it is on the server, as `localhost:3000`.
 */
export type ServerPage = { id: string; url: string; target: string; at: string };

/**
 * Why a server page didn't open, as Rust says it. `kind` picks what the pane offers: `noSshTarget` and `notConnected`
 * offer this computer; `closed` means the app left the server while it connected; the rest offer Try again too.
 */
export class ServerPageError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

/** A server page being opened: `page` settles once its tunnel is open or failed; `close` ends it, at any point. */
export type OpeningPage = { page: Promise<ServerPage>; close(): void };

export type ServerPages = {
  /**
   * Opens a tunnel for `url`. `page` rejects with a `ServerPageError`. `onClosed` hears, once, if the tunnel ends
   * without `close`: ssh exited, or the app left the server.
   */
  open(url: string, onClosed: (message: string) => void): OpeningPage;
};

const asServerPageError = (e: unknown) =>
  Promise.reject(
    e && typeof e === "object" && "kind" in e && "message" in e ? new ServerPageError(String(e.kind), String(e.message)) : new ServerPageError("io", String(e)),
  );

export const tauriServerPages: ServerPages = {
  open: (url, onClosed) => {
    // The page's name in Rust from the start, so closing it while ssh connects ends that ssh too.
    const key = crypto.randomUUID();
    const onEvent = new Channel<{ kind: "closed"; message: string }>();
    onEvent.onmessage = (e) => onClosed(e.message);
    return {
      page: invoke<ServerPage>("preview_server_open", { url, key, onEvent }).catch(asServerPageError),
      close: () => void invoke("preview_server_close", { key }).catch(() => {}),
    };
  },
};
