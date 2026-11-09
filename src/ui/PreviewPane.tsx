// The preview pane beside the chat: a small browser only the owner drives (ADR 0103). It shows a web page, a Server
// file, a Local file or a tool call's output (GLOSSARY.md "Preview"), with Back, Forward and Reload over one history the
// app keeps (previewHistory.ts). Everything it shows is untrusted (ADR 0007): web pages load in a view of their own on
// Linux (ADR 0081) or a sandboxed frame elsewhere, neither of which can reach the app, HTML files render with scripts
// and network off, and Markdown renders without raw HTML, as replies do.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Copy,
  ExternalLink,
  FileQuestion,
  FileText,
  Globe,
  Laptop,
  MoreHorizontal,
  RotateCw,
  Server,
  Wrench,
} from "lucide-react";
import {
  addressOf,
  fenced,
  fromView,
  loopbackOf,
  pageOn,
  parseAddress,
  sandboxedHtml,
  tunnelNeeded,
  tunnelUrl,
  viewUrlOf,
  withoutBidi,
  type FileView,
  type Framing,
  type PageOn,
  type PreviewTarget,
  type Tunnel,
  type ViewUrl,
  type WebTarget,
} from "../hermes/preview";
import { Markdown } from "./Markdown";
import { Spinner, fmtSize } from "./bits";
import { Menu } from "./ChatMenu";
import { ServerPageError, type DevServers, type Listening, type LocalFiles, type NativePage, type NativePages, type ServerPages, type WebPages } from "./tauriPreview";
import { usePlacement } from "./pagePlacement";
import { canGoBack, canGoForward, type HistoryStep, type PreviewHistory } from "./previewHistory";
import type { ArtifactStore } from "../hermes/artifacts";
import { ArtifactEditor } from "./ArtifactEditor";

/** Text past this many characters shows without highlighting, which would hold up the window. */
const HIGHLIGHT_MAX_CHARS = 100_000;
/** When a web page that hasn't loaded gets a note that it may never show. */
const SLOW_PAGE_MS = 15_000;

/**
 * What a framed web page may use. It may run scripts, send forms and use its own storage under its own origin, which is
 * never the app's (preview.ts `checkWebUrl`). WebKitGTK keeps no third-party cookies for it. It may not navigate the app's
 * window, open windows, or download.
 */
const WEB_SANDBOX = "allow-scripts allow-forms allow-same-origin";
const WEB_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "display-capture",
  "clipboard-read",
  "clipboard-write",
  "usb",
  "serial",
  "hid",
  "bluetooth",
  "payment",
  "fullscreen",
  "publickey-credentials-get",
]
  .map((f) => `${f} 'none'`)
  .join("; ");

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The side panel's Preview tab (SidePanel.tsx). `history` lives in App.tsx, so it outlasts this pane, which is mounted
 * only while shown (ADR 0039); `onStep` is the only way anything here changes it. `serverLabel`: how the app reaches the
 * Hermes server, e.g. `liam@hermes`. `web`: the page view, the framing check, Open in your browser and the dev servers.
 * `serverPages`: tunnels to pages on the Hermes server's own loopback.
 */
export function PreviewPane({
  history,
  onStep,
  serverLabel,
  readServer,
  local,
  web,
  serverPages,
  artifacts,
  connected = true,
}: {
  history: PreviewHistory;
  onStep: (s: HistoryStep) => void;
  serverLabel: string;
  /** `host`: the file is on the dashboard's own machine (preview.ts `PreviewTarget`). */
  readServer: (path: string, host?: boolean, session?: string) => Promise<FileView>;
  local: LocalFiles;
  web: WebPages;
  serverPages: ServerPages;
  /** Where an artifact's draft lives (artifacts.ts): editing it in the pane, and away from it, share one store. */
  artifacts?: ArtifactStore;
  connected?: boolean;
}) {
  const here = history?.here;
  const [note, setNote] = useState<{ text: string; failed: boolean }>();
  // A Server page's tunnel while it is open: the only way the owner's browser can reach that page.
  const [tunnel, setTunnel] = useState<Tunnel>();
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const browserUrl = here?.kind === "web" ? viewUrlOf(here, tunnel) : undefined;

  const open = (target: PreviewTarget) => {
    setNote(undefined);
    onStep({ kind: "open", target });
  };
  const pick = async () => {
    setNote(undefined);
    setPicking(true);
    try {
      const file = await local.pick();
      if (file) open({ kind: "local", ...file });
    } catch (e) {
      setNote({ text: `Couldn't open the file picker: ${messageOf(e)}`, failed: true });
    } finally {
      setPicking(false);
    }
  };
  const openInBrowser = (url: string) => {
    setNote(undefined);
    web.openInBrowser(url).then(
      (browser) => setNote({ text: `Opened in ${browser ?? "your browser"}.`, failed: false }),
      (e) => setNote({ text: `Couldn't open it in your browser: ${messageOf(e)}`, failed: true }),
    );
  };
  const copy = (address: string) => {
    if (!navigator.clipboard?.writeText) return setNote({ text: "Couldn't copy the address.", failed: true });
    navigator.clipboard.writeText(address).then(
      () => setNote({ text: "Address copied.", failed: false }),
      (e) => setNote({ text: `Couldn't copy the address: ${messageOf(e)}`, failed: true }),
    );
  };

  return (
    <section className="preview-content" aria-label="Preview">
      <div className="preview-toolbar">
        <button className="icon-btn" title="Back" disabled={!canGoBack(history)} onClick={() => onStep({ kind: "back" })}>
          <ArrowLeft size={16} />
        </button>
        <button className="icon-btn" title="Forward" disabled={!canGoForward(history)} onClick={() => onStep({ kind: "forward" })}>
          <ArrowRight size={16} />
        </button>
        <button
          className={busy ? "icon-btn preview-busy" : "icon-btn"}
          title="Reload"
          disabled={!here || here.kind === "tool" || here.kind === "artifact"}
          onClick={() => onStep({ kind: "reload" })}
        >
          <RotateCw size={15} />
        </button>
        <AddressBox
          here={here}
          serverLabel={serverLabel}
          onOpen={open}
          onError={(text) => setNote(text === undefined ? undefined : { text, failed: true })}
          onSwitch={(on) => onStep({ kind: "switch", on })}
        />
        <button
          className="icon-btn"
          title={here?.kind === "web" && tunnelNeeded(here) ? "Open in your browser, through this page's SSH tunnel while it is open here" : "Open in your browser"}
          disabled={!browserUrl}
          onClick={() => browserUrl && openInBrowser(browserUrl)}
        >
          <ExternalLink size={15} />
        </button>
        <MoreMenu address={here && addressOf(here)} framed={!web.native} picking={picking} onCopy={copy} onPick={() => void pick()} />
      </div>
      {note && (
        <div className={note.failed ? "attach-note preview-opened failed" : "attach-note preview-opened"} role={note.failed ? "alert" : "status"}>
          {note.text}
        </div>
      )}
      <div className="preview-body">
        {!history || !here ? (
          <EmptyState web={web} connected={connected} picking={picking} onOpen={open} onPick={() => void pick()} />
        ) : here.kind === "web" ? (
          <BrowserView
            here={here}
            reloads={history.reloads}
            web={web}
            serverPages={serverPages}
            serverLabel={serverLabel}
            onStep={onStep}
            onTunnel={setTunnel}
            onBusy={setBusy}
            onOpenInBrowser={openInBrowser}
          />
        ) : here.kind === "tool" ? (
          <pre className="preview-pre">{here.text || "(empty)"}</pre>
        ) : here.kind === "artifact" ? (
          artifacts ? (
            <ArtifactEditor
              store={artifacts}
              artifact={here.ref}
              connected={connected}
              onDone={() => open({ kind: "server", path: here.ref.path, ...(here.ref.host && { host: true }), ...(here.ref.session && { session: here.ref.session }) })}
            />
          ) : null
        ) : here.kind === "server" ? (
          <FileBody
            key={`server:${here.host ? "host" : ""}:${here.session ?? ""}:${here.path}:${history.reloads}`}
            name={here.path}
            load={() => readServer(here.path, here.host, here.session)}
          />
        ) : (
          <FileBody key={`local:${here.path}:${history.reloads}`} name={here.name} load={() => local.read(here)} />
        )}
      </div>
    </section>
  );
}

/**
 * Where what's shown is, as a badge in the address box: on the Hermes server, on this computer, on the web, or in a
 * tool call. For a page on a loopback address it is a button that opens the same page from the other side.
 */
function Badge({ here, serverLabel, onSwitch }: { here: PreviewTarget | undefined; serverLabel: string; onSwitch: (on: PageOn) => void }) {
  if (!here)
    return (
      <span className="preview-address-icon">
        <Globe size={14} />
      </span>
    );
  const on = here.kind === "web" ? pageOn(here) : undefined;
  if (here.kind === "web" && on) {
    const at = loopbackOf(here.url)?.at;
    return on === "server" ? (
      <button
        type="button"
        className="where where-server"
        title={`${at} on the Hermes server, through SSH to ${serverLabel}. Click to open ${at} on this computer instead.`}
        onClick={() => onSwitch("local")}
      >
        <Server size={12} /> Server
      </button>
    ) : (
      <button type="button" className="where where-local" title={`${at} on this computer. Click to open ${at} on the Hermes server instead.`} onClick={() => onSwitch("server")}>
        <Laptop size={12} /> This computer
      </button>
    );
  }
  switch (here.kind) {
    case "web":
      return (
        <span className="where where-web" title="A web page, loaded by this computer and kept apart from Hermes Chat">
          <Globe size={12} /> Web
        </span>
      );
    case "server":
    case "artifact":
      return (
        <span className="where where-server" title={`A file on the Hermes server (${serverLabel}), read through the dashboard`}>
          <Server size={12} /> Server
        </span>
      );
    case "local":
      return (
        <span className="where where-local" title="A file on this computer, read by Hermes Chat. It isn't sent to Hermes.">
          <Laptop size={12} /> This computer
        </span>
      );
    case "tool":
      return (
        <span className="where where-tool" title="What the tool call returned, as Hermes sent it">
          <Wrench size={12} /> Tool output
        </span>
      );
    default:
      return null;
  }
}

/**
 * The address of what's shown, always there to edit. Enter opens what it holds (a web address, `localhost:3000`, a
 * port, a path on the server); the same address again reloads it. A move made elsewhere (a link in the page, Back)
 * replaces it, unless the owner is typing in it; Escape puts it back.
 */
function AddressBox({
  here,
  serverLabel,
  onOpen,
  onError,
  onSwitch,
}: {
  here: PreviewTarget | undefined;
  serverLabel: string;
  onOpen: (t: PreviewTarget) => void;
  onError: (message: string | undefined) => void;
  onSwitch: (on: PageOn) => void;
}) {
  const shown = here ? withoutBidi(addressOf(here)) : "";
  const [draft, setDraft] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== input.current) setDraft(undefined);
  }, [shown]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft === undefined && here) return onOpen(here);
    const got = parseAddress(draft ?? "", location.origin);
    if ("error" in got) return onError(got.error);
    setDraft(undefined);
    input.current?.blur();
    onOpen(sameSide(got.target, here));
  };
  return (
    <form className="preview-address" onSubmit={submit}>
      <Badge here={here} serverLabel={serverLabel} onSwitch={onSwitch} />
      <input
        ref={input}
        aria-label="Address"
        placeholder="Address, port, or /path on the server"
        spellCheck={false}
        title={shown}
        value={draft ?? shown}
        onChange={(e) => {
          setDraft(e.target.value);
          onError(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || draft === undefined) return;
          e.preventDefault();
          setDraft(undefined);
          onError(undefined);
        }}
      />
    </form>
  );
}

/** A typed loopback page on the origin shown stays on the side it is shown from, as a browser stays on its host. */
function sameSide(typed: PreviewTarget, here: PreviewTarget | undefined): PreviewTarget {
  if (typed.kind !== "web" || here?.kind !== "web" || !here.on || !loopbackOf(typed.url)) return typed;
  return new URL(typed.url).origin === new URL(here.url).origin ? { ...typed, on: here.on } : typed;
}

/** ⋯: copy the address, open a file on this computer, and what a page here can and can't do. */
function MoreMenu({
  address,
  framed,
  picking,
  onCopy,
  onPick,
}: {
  address: string | undefined;
  framed: boolean;
  picking: boolean;
  onCopy: (address: string) => void;
  onPick: () => void;
}) {
  const [at, setAt] = useState<{ x: number; y: number }>();
  const close = useCallback(() => setAt(undefined), []);
  const item = (label: string, icon: ReactNode, act: () => void, disabled = false) => (
    <button
      className="menu-item"
      role="menuitem"
      aria-disabled={disabled}
      onClick={() => {
        if (disabled) return;
        close();
        act();
      }}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{label}</span>
    </button>
  );
  return (
    <>
      <button
        className="icon-btn"
        title="More"
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? undefined : { x: r.right, y: r.bottom + 4 });
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {at && (
        <Menu label="More" x={at.x} y={at.y} onClose={close}>
          {item("Copy address", <Copy size={14} />, () => address && onCopy(address), !address)}
          {item("Open a file on this computer…", <Laptop size={14} />, onPick, picking)}
          <div className="menu-sep" />
          <div className="preview-menu-note">
            Pages here run on their own, with no access to Hermes Chat or your sign-in, and only you can use them.
            {framed && " Links you follow inside a page don't change the address here."}
          </div>
        </Menu>
      )}
    </>
  );
}

/** Why the list has no Hermes server side, or none at all. */
function devServersNote(found: DevServers | { error: string }): string | undefined {
  if (!("server" in found)) return `Couldn't look for dev servers: ${found.error}`;
  switch (found.server.kind) {
    case "noSshTarget":
      return "Sign in through SSH to see the Hermes server's dev servers.";
    case "notConnected":
      return "Not connected to the Hermes server, so only this computer's are listed.";
    case "failed":
      return `Couldn't list the Hermes server's: ${found.server.message}`;
    case "listed":
      return undefined;
  }
}

/**
 * Nothing open: what to do, the dev servers found on the Hermes server and on this computer, and Open a file on this
 * computer. The list is asked for when this shows, when the connection comes or goes, and on its refresh button; it
 * isn't polled.
 */
function EmptyState({
  web,
  connected,
  picking,
  onOpen,
  onPick,
}: {
  web: WebPages;
  connected: boolean;
  picking: boolean;
  onOpen: (t: PreviewTarget) => void;
  onPick: () => void;
}) {
  const [found, setFound] = useState<DevServers | { error: string }>();
  const [asks, setAsks] = useState(0);
  useEffect(() => {
    let live = true;
    setFound(undefined);
    web.devServers().then(
      (d) => live && setFound(d),
      (e) => live && setFound({ error: messageOf(e) }),
    );
    return () => {
      live = false;
    };
  }, [web, connected, asks]);
  const rows: (Listening & { on: PageOn })[] =
    found && "server" in found
      ? [...(found.server.kind === "listed" ? found.server.ports : []).map((l) => ({ ...l, on: "server" as const })), ...found.local.map((l) => ({ ...l, on: "local" as const }))]
      : [];
  const why = found && devServersNote(found);
  return (
    <div className="preview-empty">
      <div className="preview-empty-icon">
        <Globe size={20} />
      </div>
      <h2>Nothing open</h2>
      <p>
        Type an address, a port like <kbd>5173</kbd>, or a path on the server above. Links in replies open here too.
      </p>
      <section className="preview-devs" aria-label="Dev servers">
        <div className="preview-devs-head">
          <span>Dev servers</span>
          <button className="icon-btn" title="Look for dev servers again" disabled={!found} onClick={() => setAsks((n) => n + 1)}>
            <RotateCw size={13} />
          </button>
        </div>
        {!found ? (
          <div className="preview-devs-note" role="status">
            <Spinner /> Looking for dev servers…
          </div>
        ) : (
          <>
            {rows.map((d) => (
              <button key={`${d.on}:${d.port}`} className="preview-dev" onClick={() => onOpen({ kind: "web", url: `http://localhost:${d.port}/`, on: d.on })}>
                <span className="preview-dev-dot" />
                <b>localhost:{d.port}</b>
                <span className={`preview-dev-on ${d.on}`}>{d.on === "server" ? "Server" : "This computer"}</span>
                {d.process && <span className="preview-dev-what">{d.process}</span>}
              </button>
            ))}
            {!rows.length && !why && <div className="preview-devs-note">None found. Start one, or type its port above.</div>}
            {why && <div className="preview-devs-note">{why}</div>}
          </>
        )}
      </section>
      <button className="link-btn preview-local" disabled={picking} onClick={onPick}>
        <FileText size={13} /> Open a file on this computer…
      </button>
    </div>
  );
}

type Loaded = { view: FileView } | { error: string } | { loading: true };

/** A Server or Local file: loading, then its view, or why it can't be shown. */
function FileBody({ name, load }: { name: string; load: () => Promise<FileView> }) {
  const [state, setState] = useState<Loaded>({ loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    let made: string | undefined;
    loadRef.current().then(
      (view) => {
        const blob = view.kind === "image" && view.src.startsWith("blob:") ? view.src : undefined;
        if (!live) return blob && URL.revokeObjectURL(blob);
        made = blob;
        setState({ view });
      },
      (e) => live && setState({ error: messageOf(e) }),
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, []);

  if ("loading" in state)
    return (
      <div className="preview-state" role="status">
        <Spinner /> Loading {name.split("/").pop()}…
      </div>
    );
  if ("error" in state)
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">Couldn't open this file</div>
          <div>{state.error}</div>
        </div>
      </div>
    );
  const v = state.view;
  if (v.kind === "unsupported")
    return (
      <div className="preview-state" role="note">
        <FileQuestion size={18} />
        <div>
          <div className="preview-state-title">No preview for this file</div>
          <div>
            {v.reason}
            {v.size !== undefined && ` It's ${fmtSize(v.size)}.`}
          </div>
        </div>
      </div>
    );
  if (v.kind === "image") return <ImageView src={v.src} name={name} size={v.size} />;
  return <TextView view={v} name={name} />;
}

function ImageView({ src, name, size }: { src: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (broken)
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">Couldn't show this image</div>
          <div>Its bytes didn't make an image this computer can draw.</div>
        </div>
      </div>
    );
  return (
    <div className="preview-image">
      <img src={src} alt={name.split("/").pop()} onError={() => setBroken(true)} />
      {size !== undefined && <div className="preview-foot">{fmtSize(size)}</div>}
    </div>
  );
}

function TextView({ view, name }: { view: Extract<FileView, { kind: "text" }>; name: string }) {
  const renders = view.format !== "code";
  const [source, setSource] = useState(!renders);
  return (
    <div className="preview-text">
      {(renders || view.truncated) && (
        <div className="preview-bar">
          {renders && (
            <div className="segmented" role="group" aria-label="View">
              <button aria-pressed={!source} onClick={() => setSource(false)}>
                Rendered
              </button>
              <button aria-pressed={source} onClick={() => setSource(true)}>
                Source
              </button>
            </div>
          )}
          {view.truncated && (
            <span className="preview-truncated">
              Showing the first {fmtSize(view.text.length)} of {fmtSize(view.size)}.
            </span>
          )}
        </div>
      )}
      {!source && view.format === "markdown" ? (
        <div className="preview-doc">
          <Markdown text={view.text} />
        </div>
      ) : !source && view.format === "html" ? (
        <iframe className="preview-frame doc" title={`Rendered ${name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={sandboxedHtml(view.text)} />
      ) : view.language && view.text.length <= HIGHLIGHT_MAX_CHARS ? (
        <div className="preview-code">
          <Markdown text={fenced(view.text, view.language)} />
        </div>
      ) : (
        <pre className="preview-pre">{view.text}</pre>
      )}
    </div>
  );
}

/**
 * A web page in a frame. WebKitGTK gives the frame no sign that a site refused to be framed: it fires `load` at once
 * and stays blank. So Rust asks the site the way the frame does (`check`, ADR 0011): a refusal replaces the frame with
 * a note and Open in your browser, and a site this computer can't reach says so instead of loading forever. Anything
 * else (a script that blanks the page, say) still can't be told apart, so a page slow to load says it may not show.
 */
function FramedWebView({ url, src, check, onOpenInBrowser }: { url: string; src: string; check: (url: string) => Promise<Framing>; onOpenInBrowser: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [closed, setClosed] = useState(false);
  const [framing, setFraming] = useState<Framing>();
  const [showAnyway, setShowAnyway] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_PAGE_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    let live = true;
    // A check that fails says nothing either way: the frame is left to show what it can.
    checkRef.current(src).then(
      (f) => live && setFraming(f),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [src]);
  const onLoad = () => {
    // A page that redirected the frame onto the app's own origin could reach the app; such a frame is emptied at once.
    // The frame-src policy (index.html) and Tauri's invoke key are the main guards; this is the last one (ADR 0007).
    try {
      const href = frame.current?.contentWindow?.location.href;
      if (href !== undefined && href !== "about:blank") {
        frame.current!.src = "about:blank";
        setClosed(true);
        return;
      }
    } catch {
      // Cross-origin, as it should be.
    }
    setLoaded(true);
  };
  const host = hostOf(url);
  if (closed)
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">This page was closed</div>
          <div>It tried to load Hermes Chat's own pages inside the preview.</div>
        </div>
      </div>
    );
  if (framing?.kind === "refused" && !showAnyway)
    return (
      <div className="preview-state preview-error" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">{host} doesn't allow being shown inside other apps</div>
          <div>
            The site's answer says so (<code className="preview-refused-by">{framing.by}</code>), so here it would stay blank. Open it in your
            browser instead.
          </div>
          <div className="preview-state-actions">
            <button className="btn primary" onClick={onOpenInBrowser}>
              <ExternalLink size={14} /> Open in your browser
            </button>
            <button
              className="link-btn"
              onClick={() => {
                setLoaded(false);
                setShowAnyway(true);
              }}
            >
              Try showing it here anyway
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div className="preview-web">
      <div className="preview-web-frame">
        <iframe
          ref={frame}
          className="preview-frame"
          title={`Web page: ${url}`}
          src={src}
          sandbox={WEB_SANDBOX}
          allow={WEB_PERMISSIONS}
          referrerPolicy="no-referrer"
          onLoad={onLoad}
        />
        {!loaded &&
          (framing?.kind === "unreachable" ? (
            <div className="preview-state preview-error preview-loading" role="alert">
              <AlertTriangle size={18} />
              <div>
                <div className="preview-state-title">Couldn't reach {host}</div>
                <div>{framing.message}</div>
                <div>Check the address, or Reload to try again.</div>
              </div>
            </div>
          ) : (
            <div className="preview-state preview-loading" role="status">
              <Spinner /> {slow ? "Still loading. If the page stays blank, the site may not allow being shown here." : "Loading page…"}
            </div>
          ))}
      </div>
    </div>
  );
}


type TunnelState =
  | { kind: "none" }
  | { kind: "opening"; remote: string }
  | { kind: "open"; tunnel: Tunnel }
  | { kind: "failed"; remote: string; error: ServerPageError }
  | { kind: "closed"; remote: string; message: string };

/**
 * The tunnel the entries shown need: to `need`, a page's origin on the Hermes server. `need` undefined (a web page
 * elsewhere, or this computer's loopback) keeps the tunnel there is, so Back to the server's page goes back in the same
 * view through the same port. A different `need` closes it and opens that one; unmounting closes it. `retry` opens a
 * closed or failed one again.
 */
function useStickyTunnel(need: string | undefined, pages: ServerPages): [TunnelState, () => void] {
  const [kept, setKept] = useState(need);
  if (need !== undefined && need !== kept) setKept(need);
  const remote = need ?? kept;
  const [state, setState] = useState<TunnelState>({ kind: "none" });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!remote) return;
    let live = true;
    // Latched: a tunnel that closed before its open result arrived stays closed.
    let ended = false;
    const opening = pages.open(`${remote}/`, (message) => {
      ended = true;
      if (live) setState({ kind: "closed", remote, message });
    });
    setState({ kind: "opening", remote });
    opening.page.then(
      (page) => {
        if (!live || ended) return;
        const local = tunnelUrl(page.url, location.origin);
        if (!local) {
          opening.close();
          return setState({ kind: "failed", remote, error: new ServerPageError("io", "The tunnel gave an address the preview doesn't load.") });
        }
        setState({ kind: "open", tunnel: { remote, local: new URL(local).origin } });
      },
      (e) => {
        if (!live || ended) return;
        const error = e instanceof ServerPageError ? e : new ServerPageError("io", messageOf(e));
        setState(error.kind === "closed" ? { kind: "closed", remote, message: error.message } : { kind: "failed", remote, error });
      },
    );
    return () => {
      live = false;
      // Ends the tunnel whether it opened or is still connecting.
      opening.close();
    };
  }, [remote, tries, pages]);
  return [state, useCallback(() => setTries((n) => n + 1), [])];
}

/**
 * Every web entry, for as long as the Preview shows web entries one after another: one page view and at most one
 * tunnel. Moving between entries (a link inside the page, Back, Forward, a reply link) asks the same view to `go`, and
 * a move the page makes itself comes back as `arrived`; nothing is torn down unless the next entry needs another
 * tunnel. Without a page view (Windows), the frame shows the entry and reloads with it.
 */
function BrowserView({
  here,
  reloads,
  web,
  serverPages,
  serverLabel,
  onStep,
  onTunnel,
  onBusy,
  onOpenInBrowser,
}: {
  here: WebTarget;
  reloads: number;
  web: WebPages;
  serverPages: ServerPages;
  serverLabel: string;
  onStep: (s: HistoryStep) => void;
  onTunnel: (t: Tunnel | undefined) => void;
  onBusy: (busy: boolean) => void;
  onOpenInBrowser: (url: string) => void;
}) {
  const need = tunnelNeeded(here);
  const [tunnel, retry] = useStickyTunnel(need, serverPages);
  const open = tunnel.kind === "open" ? tunnel.tunnel : undefined;
  const src = viewUrlOf(here, open);
  useEffect(() => {
    onTunnel(open);
    return () => onTunnel(undefined);
  }, [open, onTunnel]);

  const tunnelState = need && tunnel.kind !== "open" && (
    <TunnelNote state={tunnel} at={loopbackOf(here.url)?.at ?? here.url} serverLabel={serverLabel} onRetry={retry} onLocal={() => onStep({ kind: "switch", on: "local" })} />
  );
  const reloadsSeen = useRef(reloads);
  useEffect(() => {
    if (reloads === reloadsSeen.current) return;
    reloadsSeen.current = reloads;
    if (need && tunnel.kind !== "open" && tunnel.kind !== "opening") retry();
  }, [reloads, need, tunnel.kind, retry]);

  if (!web.native)
    return tunnelState || (src ? <FramedWebView key={`${src}:${reloads}`} url={here.url} src={src} check={web.check} onOpenInBrowser={() => onOpenInBrowser(src)} /> : null);
  return <PageView here={here} src={src} tunnel={open} reloads={reloads} cover={tunnelState} native={web.native} onStep={onStep} onBusy={onBusy} />;
}

/**
 * The page view itself (ADR 0081), which Rust lays over this box. It shows once the first page commits and stays over
 * later loads, as a browser keeps the page it is leaving; the box says what the view can't: that the first page is
 * loading, why one failed, or the tunnel's state in `cover`.
 */
function PageView({
  here,
  src,
  tunnel,
  reloads,
  cover,
  native,
  onStep,
  onBusy,
}: {
  here: WebTarget;
  src: ViewUrl | undefined;
  tunnel: Tunnel | undefined;
  reloads: number;
  cover: ReactNode;
  native: NativePages;
  onStep: (s: HistoryStep) => void;
  onBusy: (busy: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<NativePage>();
  const [state, setState] = useState<"loading" | "shown" | { message: string }>("loading");
  const [slow, setSlow] = useState(false);
  // Where the view last said it is: an entry the page reached by itself is there already, so it isn't asked for again.
  const viewAt = useRef<ViewUrl>(undefined);
  const latest = useRef({ tunnel, onStep });
  latest.current = { tunnel, onStep };

  useEffect(() => {
    let live = true;
    const made = native.open((e) => {
      if (!live) return;
      if (e.kind === "at") {
        viewAt.current = e.url;
        setState("shown");
        latest.current.onStep({ kind: "arrived", target: fromView(e.url, latest.current.tunnel), replace: e.replace });
      } else if (e.kind === "failed") setState({ message: e.message });
      // Escape in the page gave the keyboard back to the app: it lands here, inside the Preview, for the next key.
      else box.current?.focus();
    });
    setPage(made);
    return () => {
      live = false;
      made.close();
    };
  }, [native]);

  useEffect(() => {
    if (!page || !src || src === viewAt.current) return;
    setState("loading");
    page.go(src);
  }, [page, src]);

  const reloadsSeen = useRef(reloads);
  useEffect(() => {
    if (reloads === reloadsSeen.current) return;
    reloadsSeen.current = reloads;
    if (!page || !src) return;
    setState("loading");
    if (src === viewAt.current) page.reload();
    else page.go(src);
  }, [reloads, page, src]);

  useEffect(() => {
    if (viewAt.current || state !== "loading") return setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_PAGE_MS);
    return () => clearTimeout(timer);
  }, [state]);
  const loading = state === "loading" && !!src;
  useEffect(() => onBusy(loading), [loading, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);

  const showing = !cover && !!src && (state === "shown" || (state === "loading" && !!viewAt.current));
  usePlacement(box, showing ? page : undefined);
  return (
    <div className="preview-web">
      <div ref={box} className="preview-web-frame" tabIndex={-1}>
        {cover ||
          (typeof state === "object" ? (
            <div className="preview-state preview-error preview-loading" role="alert">
              <AlertTriangle size={18} />
              <div>
                <div className="preview-state-title">Couldn't load {hostOf(here.url)}</div>
                <div>{state.message}</div>
                <div>Check the address, or Reload to try again.</div>
              </div>
            </div>
          ) : (
            !showing && (
              <div className="preview-state preview-loading" role="status">
                <Spinner /> {slow ? "Still loading the page…" : "Loading page…"}
              </div>
            )
          ))}
      </div>
    </div>
  );
}

/** What a server page that didn't open is called, by why. */
const FAILED_TITLE: Record<string, string> = {
  noSshTarget: "No SSH target for this server",
  notConnected: "Not connected to the Hermes server",
  portClosed: "Nothing answers there on the server",
  notWeb: "This isn't a web page",
  notLoopback: "This page isn't on the server's own loopback",
  tooMany: "Too many server pages open",
  timeout: "SSH didn't connect",
};

/**
 * A Server page whose tunnel isn't open: opening, failed (with what can be done), or closed under the page. Try again
 * opens a new tunnel; Open on this computer instead switches the page to this computer's loopback.
 */
function TunnelNote({ state, at, serverLabel, onRetry, onLocal }: { state: TunnelState; at: string; serverLabel: string; onRetry: () => void; onLocal: () => void }) {
  const again = (
    <button className="btn primary" onClick={onRetry}>
      <RotateCw size={14} /> Try again
    </button>
  );
  const local = (
    <button className="link-btn" onClick={onLocal}>
      Open on this computer instead
    </button>
  );
  if (state.kind === "failed") {
    const { kind, message } = state.error;
    const title = kind === "portClosed" ? `Nothing answers at ${at} on the server` : (FAILED_TITLE[kind] ?? "Couldn't open an SSH tunnel to the server");
    return (
      <div className="preview-state preview-error preview-loading" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">{title}</div>
          <div>{message}</div>
          {kind === "portClosed" && <div>If Hermes is still starting it, try again in a moment.</div>}
          {kind === "noSshTarget" && <div>Sign in through SSH to reach pages on the server, or open this one on this computer.</div>}
          <div className="preview-state-actions">
            {kind !== "noSshTarget" && kind !== "notWeb" && kind !== "notLoopback" && again}
            {kind !== "notWeb" && local}
          </div>
        </div>
      </div>
    );
  }
  if (state.kind === "closed")
    return (
      <div className="preview-state preview-error preview-loading" role="alert">
        <AlertTriangle size={18} />
        <div>
          <div className="preview-state-title">The SSH tunnel to this page closed</div>
          <div>{state.message}</div>
          <div className="preview-state-actions">
            {again}
            {local}
          </div>
        </div>
      </div>
    );
  return (
    <div className="preview-state preview-loading" role="status">
      <Spinner /> Opening {at} on the Hermes server, through SSH to {serverLabel}…
    </div>
  );
}

/** The host a web address names, for messages about it. */
function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
