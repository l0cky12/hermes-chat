// The preview pane beside the chat: a web page, a Server file, a Local file or a tool call's output (GLOSSARY.md
// "Preview pane"). Everything it shows is untrusted (ADR 0007): web pages load in a sandboxed frame that can't reach the
// app, HTML files render with scripts and network off, and Markdown renders without raw HTML, as replies do.
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, ArrowLeft, Check, Copy, ExternalLink, FileQuestion, Globe, Laptop, Plus, RotateCw, Server, Wrench, X } from "lucide-react";
import { fenced, parseAddress, previewName, sandboxedHtml, type FileView, type Framing, type PreviewTarget } from "../hermes/preview";
import { Markdown } from "./Markdown";
import { Spinner, fmtSize } from "./bits";
import type { LocalFiles, WebPages } from "./tauriPreview";

/** The narrowest the pane gets, and the step the arrow keys resize it by. */
export const PANE_MIN_WIDTH = 300;
const KEY_STEP = 32;
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
 * `serverLabel`: how the app reaches the Hermes server, e.g. `liam@hermes`, so a Server file says where it is.
 * `web`: asks whether a site refuses to be shown in the frame, and opens a page in the owner's browser.
 * `overlay`: the window is too narrow for the pane beside the chat, so it covers the chat until `onHide`.
 * `onResize(width, done)`: the owner is dragging the pane's edge; `done` once they let go.
 */
export function PreviewPane({
  target,
  serverLabel,
  readServer,
  local,
  web,
  overlay,
  width,
  maxWidth,
  onResize,
  onOpen,
  onHide,
  onClose,
}: {
  target: PreviewTarget;
  serverLabel: string;
  readServer: (path: string) => Promise<FileView>;
  local: LocalFiles;
  web: WebPages;
  overlay: boolean;
  width: number;
  maxWidth: number;
  onResize: (width: number, done: boolean) => void;
  onOpen: (t: PreviewTarget) => void;
  onHide: () => void;
  onClose: () => void;
}) {
  // Reload bumps this; each target starts again from 0 because the pane is keyed by it.
  const [reloads, setReloads] = useState(0);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [openError, setOpenError] = useState<string>();
  const titleId = useId();
  const root = useRef<HTMLElement>(null);
  // Covering the chat makes it inert, focus included, so focus moves into the pane unless something in it has it.
  useEffect(() => {
    if (overlay && !root.current?.contains(document.activeElement)) root.current?.focus();
  }, [overlay]);
  const address = target.kind === "server" || target.kind === "local" ? target.path : target.kind === "web" ? target.url : undefined;

  const openInBrowser = (url: string) => {
    setOpenError(undefined);
    web.openInBrowser(url).catch((e) => setOpenError(`Couldn't open it in your browser: ${messageOf(e)}`));
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    if (overlay) onHide();
    else onClose();
  };

  return (
    <aside
      ref={root}
      tabIndex={-1}
      className={`preview ${overlay ? "overlay" : ""} ${dragging ? "dragging" : ""}`}
      style={overlay ? undefined : { width }}
      aria-labelledby={titleId}
      onKeyDown={onKey}
    >
      {!overlay && <ResizeHandle width={width} maxWidth={maxWidth} onResize={onResize} onDragging={setDragging} />}
      <header className="preview-head">
        {overlay && (
          <button className="icon-btn" title="Back to the chat" onClick={onHide}>
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="preview-title">
          <div className="preview-name">
            <Where target={target} serverLabel={serverLabel} />
            <span id={titleId}>{previewName(target)}</span>
          </div>
          {address && (
            <div className="preview-address" title={address}>
              <bdi>{address}</bdi>
            </div>
          )}
        </div>
        <div className="preview-actions">
          {address && (
            <button
              className="icon-btn"
              title={target.kind === "web" ? "Copy the address" : "Copy the path"}
              onClick={() => {
                void navigator.clipboard?.writeText(address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          )}
          {target.kind === "web" && (
            <button className="icon-btn" title="Open in your browser" onClick={() => openInBrowser(target.url)}>
              <ExternalLink size={15} />
            </button>
          )}
          {target.kind !== "start" && target.kind !== "tool" && (
            <button className="icon-btn" title="Reload" onClick={() => setReloads((n) => n + 1)}>
              <RotateCw size={15} />
            </button>
          )}
          {target.kind !== "start" && (
            <button className="icon-btn" title="Open something else" onClick={() => onOpen({ kind: "start" })}>
              <Plus size={16} />
            </button>
          )}
          <button className="icon-btn" title="Close the preview" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>
      {openError && (
        <div className="attach-note preview-open-error" role="alert">
          {openError}
        </div>
      )}
      <div className="preview-body">
        {target.kind === "start" ? (
          <StartView serverLabel={serverLabel} local={local} onOpen={onOpen} />
        ) : target.kind === "web" ? (
          <WebView key={reloads} url={target.url} check={web.check} onOpenInBrowser={() => openInBrowser(target.url)} />
        ) : target.kind === "tool" ? (
          <pre className="preview-pre">{target.text || "(empty)"}</pre>
        ) : target.kind === "server" ? (
          <FileBody key={reloads} name={target.path} load={() => readServer(target.path)} />
        ) : (
          <FileBody key={reloads} name={target.name} load={() => local.read(target)} />
        )}
      </div>
    </aside>
  );
}

/** Where what's shown lives: on the Hermes server, on this computer, on the web, or in a tool call. */
function Where({ target, serverLabel }: { target: PreviewTarget; serverLabel: string }) {
  switch (target.kind) {
    case "server":
      return (
        <span className="where where-server" title={`A file on the Hermes server (${serverLabel}), read through the dashboard`}>
          <Server size={12} /> Server · {serverLabel}
        </span>
      );
    case "local":
      return (
        <span className="where where-local" title="A file on this computer, read by Hermes Chat. It isn't sent to Hermes.">
          <Laptop size={12} /> This computer
        </span>
      );
    case "web":
      return (
        <span className="where where-web" title="A web page, loaded by this computer in an isolated frame">
          <Globe size={12} /> Web
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

/** The pane's left edge: drag it, or focus it and use the arrow keys, to make the pane wider or narrower. */
function ResizeHandle({
  width,
  maxWidth,
  onResize,
  onDragging,
}: {
  width: number;
  maxWidth: number;
  onResize: (width: number, done: boolean) => void;
  onDragging: (on: boolean) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, PANE_MIN_WIDTH), Math.max(PANE_MIN_WIDTH, maxWidth)));
  const move = (e: ReactPointerEvent, done: boolean) => {
    if (!start.current) return;
    // The pane is on the right, so dragging its edge left makes it wider.
    onResize(clamp(start.current.width + start.current.x - e.clientX), done);
    if (done) {
      start.current = null;
      onDragging(false);
    }
  };
  return (
    <div
      className="preview-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the preview"
      aria-valuemin={PANE_MIN_WIDTH}
      aria-valuemax={Math.max(PANE_MIN_WIDTH, maxWidth)}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = { x: e.clientX, width };
        onDragging(true);
      }}
      onPointerMove={(e) => move(e, false)}
      onPointerUp={(e) => move(e, true)}
      onPointerCancel={(e) => move(e, true)}
      onKeyDown={(e) => {
        const next =
          e.key === "ArrowLeft"
            ? width + KEY_STEP
            : e.key === "ArrowRight"
              ? width - KEY_STEP
              : e.key === "Home"
                ? maxWidth
                : e.key === "End"
                  ? PANE_MIN_WIDTH
                  : undefined;
        if (next === undefined) return;
        e.preventDefault();
        onResize(clamp(next), true);
      }}
    />
  );
}

/** The empty pane: type a web address or a server path, or pick a file on this computer. */
function StartView({ serverLabel, local, onOpen }: { serverLabel: string; local: LocalFiles; onOpen: (t: PreviewTarget) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const got = parseAddress(text, location.origin);
    if ("error" in got) setError(got.error);
    else onOpen(got.target);
  };
  const pick = async () => {
    setError(undefined);
    setPicking(true);
    try {
      const file = await local.pick();
      if (file) onOpen({ kind: "local", ...file });
    } catch (e) {
      setError(`Couldn't open the file picker: ${messageOf(e)}`);
    } finally {
      setPicking(false);
    }
  };
  return (
    <div className="preview-start">
      <form className="preview-open" onSubmit={submit}>
        <input
          autoFocus
          aria-label="Web address or path on the Hermes server"
          placeholder="https://… or /path/on/the/server"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(undefined);
          }}
        />
        <button className="btn primary" type="submit" disabled={!text.trim()}>
          Open
        </button>
      </form>
      {error && (
        <div className="attach-note" role="alert">
          {error}
        </div>
      )}
      <p className="preview-hint">
        <Server size={13} /> A path like <code>/home/you/notes.md</code> or <code>~/notes.md</code> is read on the Hermes server, <b>{serverLabel}</b>.
      </p>
      <button className="btn preview-local-btn" onClick={() => void pick()} disabled={picking}>
        <Laptop size={14} /> Open a file on this computer…
      </button>
      <p className="preview-hint">
        Links in replies open here too, and so do the files, pages and output of a tool call: open the call and pick one under Preview.
      </p>
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
function WebView({ url, check, onOpenInBrowser }: { url: string; check: (url: string) => Promise<Framing>; onOpenInBrowser: () => void }) {
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
    checkRef.current(url).then(
      (f) => live && setFraming(f),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [url]);
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
      <div className="preview-web-note">
        Runs on its own, with no access to Hermes Chat or your sign-in. Some sites don't allow being shown inside other apps; if this one stays
        blank,{" "}
        <button className="link-btn" onClick={onOpenInBrowser}>
          open it in your browser
        </button>
        .
      </div>
      <div className="preview-web-frame">
        <iframe
          ref={frame}
          className="preview-frame"
          title={`Web page: ${url}`}
          src={url}
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

/** The host a web address names, for messages about it. */
function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
