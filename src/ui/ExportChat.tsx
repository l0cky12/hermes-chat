// The Export dialog: the owner picks the format, the messages, whether tool calls and attachment names go in, and what is
// redacted, and sees the file exactly as Save writes it (exportChat.ts `exportPreview`, ADR 0076). It works on the chat
// as it was when the dialog opened, so a reply that arrives meanwhile doesn't change a file already read.
// Share snapshot opens it in share mode (ADR 0123): the HTML page only, with Publish… in place of Save…. Publish… opens a
// confirm step in the same dialog, and only that step's Publish uploads, with exactly the bytes its frame shows.
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowLeft, Copy, Download, FileDown, Settings2, Share2, Upload } from "lucide-react";
import type { Chat, Item } from "../hermes/model";
import {
  EXPORT_FORMATS,
  FIRST_DRAFT,
  exportPreview,
  isMessage,
  saveExport,
  saveImage,
  type ExportDraft,
  type ExportFormat,
  type SaveFile,
  type SaveImage,
} from "../hermes/exportChat";
import { chatImage, type ImagePage } from "../hermes/exportImage";
import { REDACTED } from "../hermes/secrets";
import {
  DEFAULT_EXPIRY,
  EXPIRIES,
  clipboardText,
  endpointHost,
  snapshotTime,
  tauriSnapshots,
  type Expiry,
  type Published,
  type SnapshotApi,
  type SnapshotHost,
} from "../hermes/snapshots";
import { composing } from "./bits";
import { useModal } from "./modal";
import { errorText } from "../hermes/values";

const WHO: Record<string, string> = { user: "You", assistant: "Hermes", thinking: "Hermes, thinking" };

/** A message's first words, on one line. */
function gist(i: Item): string {
  const text = "text" in i ? i.text.replace(/\s+/g, " ").trim() : "";
  return text ? (text.length > 90 ? `${text.slice(0, 90)}…` : text) : "(no text)";
}

/** A secret or picked text, short enough to tell apart in a list without filling it. */
function short(text: string): string {
  const one = text.replace(/\s+/g, " ");
  return one.length > 32 ? `${one.slice(0, 18)}…${one.slice(-8)}` : one;
}

const places = (n: number) => (n === 1 ? "1 place" : `${n} places`);

const ABOUT: Record<ExportFormat, string> = {
  markdown: "A Markdown file of the chat, to read.",
  json: "A JSON file of the chat in Hermes's own session format, with each message's time. Import transcripts reads it back.",
  image: "A PNG picture of the chosen messages, to share. Tool calls show their command and output.",
  html: "A web page of the chat, the page a snapshot would publish. It runs no script, loads nothing, links only to web and mail addresses, and shows images as their address.",
};

/** The picture drawn for one preview, so a draw that finishes after the owner changed something is never shown or saved. */
type Drawn = { of: string; png?: string; problem?: string };

/** The saved Snapshot host, as share mode reads it when the dialog opens. */
type HostRead = { kind: "reading" } | { kind: "none" } | { kind: "saved"; host: SnapshotHost } | { kind: "failed"; message: string };

/** What Publish has done so far. `refused`: the command rejected, so nothing was sent. */
type Sent = { kind: "sending" } | { kind: "refused"; message: string } | { kind: "done"; published: Published };

/** The confirm step: the page as it was when Publish… was pressed, which is what the frame shows and Publish uploads. */
type Confirm = { html: string; title: string; host: SnapshotHost; expiry: Expiry; sent?: Sent };

export type ExportMode = "export" | "share";

/**
 * Escape, Cancel or a click outside closes it without saving; in the confirm step, Escape and Back go back to the
 * picks. `onSaved` gets the notice to show once a file is saved. `onSnapshotSettings` opens Settings → Snapshots.
 */
export function ExportChatDialog({
  chat,
  mode = "export",
  save,
  saveAsImage,
  draw = chatImage,
  snapshots = tauriSnapshots,
  copyText = clipboardText,
  returnTo,
  onSaved,
  onSnapshotSettings,
  onClose,
}: {
  chat: Chat;
  mode?: ExportMode;
  save?: SaveFile;
  saveAsImage?: SaveImage;
  draw?: (page: ImagePage) => Promise<string>;
  snapshots?: SnapshotApi;
  copyText?: (text: string) => Promise<void>;
  returnTo?: RefObject<HTMLElement | null>;
  onSaved: (notice: string) => void;
  onSnapshotSettings?: () => void;
  onClose: () => void;
}) {
  const sharing = mode === "share";
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const secretsId = useId();
  const pickId = useId();
  const pickHelpId = useId();
  const formatName = useId();
  const [shot] = useState(() => chat);
  const [at] = useState(() => new Date());
  const [format, setFormat] = useState<ExportFormat>(sharing ? "html" : "markdown");
  // A shared page starts without Hermes's thinking, as every export starts without tool calls and attachment names.
  const [draft, setDraft] = useState<ExportDraft>(() =>
    sharing ? { ...FIRST_DRAFT, leftOut: new Set(shot.items.filter((i) => i.kind === "thinking").map((i) => i.id)) } : FIRST_DRAFT,
  );
  const [host, setHost] = useState<HostRead>({ kind: "reading" });
  const [confirm, setConfirm] = useState<Confirm>();
  const publishButton = useRef<HTMLButtonElement>(null);
  const confirmHead = useRef<HTMLHeadingElement>(null);
  const confirming = !!confirm;
  const wasConfirming = useRef(false);
  const [toRedact, setToRedact] = useState("");
  const [note, setNote] = useState<string>();
  const [saving, setSaving] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const preview = useMemo(() => exportPreview(shot, draft, at, format), [shot, draft, at, format]);
  const messages = shot.items.filter(isMessage);
  const tools = shot.items.filter((i) => i.kind === "tool" || i.kind === "approval").length;
  const attached = shot.items.reduce((n, i) => n + (i.kind === "user" ? (i.attachments?.length ?? 0) : 0), 0);
  const chosen = messages.length - messages.filter((m) => draft.leftOut.has(m.id)).length;
  const empty = !chosen && !(draft.toolCalls && tools);
  const kind = EXPORT_FORMATS[format].kind;
  const isImage = kind === "image";
  const [drawn, setDrawn] = useState<Drawn>();
  const picture = isImage && drawn?.of === preview.text ? drawn : undefined;

  useEffect(() => {
    if (!sharing) return;
    let live = true;
    snapshots.host().then(
      (h) => live && setHost(h ? { kind: "saved", host: h } : { kind: "none" }),
      (e: unknown) => live && setHost({ kind: "failed", message: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [sharing, snapshots]);

  // Into the confirm step, focus goes to its heading; back out of it, to Publish…, with every pick as it was.
  useEffect(() => {
    if (confirming === wasConfirming.current) return;
    wasConfirming.current = confirming;
    (confirming ? confirmHead.current : publishButton.current)?.focus();
  }, [confirming]);

  useEffect(() => {
    if (!isImage) return;
    let live = true;
    const of = preview.text;
    draw(JSON.parse(of) as ImagePage).then(
      (png) => live && setDrawn({ of, png }),
      (e: unknown) => live && setDrawn({ of, problem: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [isImage, preview.text, draw]);

  // Text selected in the preview goes in Text to redact, which can also be typed or pasted into from the keyboard.
  useEffect(() => {
    const read = () => {
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed && pre.current?.contains(sel.anchorNode) && pre.current.contains(sel.focusNode)) setToRedact(sel.toString());
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, []);

  const change = (d: Partial<ExportDraft>) => setDraft({ ...draft, ...d });
  const toggle = <T,>(set: ReadonlySet<T>, value: T, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };
  const picking = toRedact.trim();
  // A redaction is the text as the chat has it, so one can't depend on another being kept.
  const overlaps = picking.includes(REDACTED);
  const pick = () => {
    if (!picking || overlaps) return;
    if (!draft.picked.includes(picking)) change({ picked: [...draft.picked, picking] });
    document.getSelection()?.removeAllRanges();
    setToRedact("");
  };

  const doSave = async () => {
    setSaving(true);
    setNote(undefined);
    try {
      const notice = isImage
        ? picture?.png && (await saveImage(picture.png, preview.fileName, saveAsImage))
        : await saveExport(preview.text, preview.fileName, format, save);
      if (notice) {
        onSaved(notice);
        onClose();
      }
    } catch (e) {
      setNote(`Couldn't save: ${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const sending = confirm?.sent?.kind === "sending";
  const busy = saving || sending;
  const canWrite = !empty && preview.problem === undefined;
  const published = confirm?.sent?.kind === "done" && confirm.sent.published.outcome === "live";
  const back = () => setConfirm(undefined);
  const openPublish = () => {
    if (host.kind === "saved" && canWrite) setConfirm({ html: preview.text, title: preview.title, host: host.host, expiry: DEFAULT_EXPIRY });
  };
  const publish = async () => {
    if (!confirm) return;
    setConfirm({ ...confirm, sent: { kind: "sending" } });
    let sent: Sent;
    try {
      sent = { kind: "done", published: await snapshots.publish(confirm.host, confirm.html, confirm.title, confirm.expiry) };
    } catch (e) {
      sent = { kind: "refused", message: errorText(e) };
    }
    setConfirm((c) => c && { ...c, sent });
  };
  const toSettings = () => {
    onClose();
    onSnapshotSettings?.();
  };

  const parts = preview.text.split(REDACTED);
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={box}
        className="leave-dialog export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !busy && !composing(e)) {
            e.preventDefault();
            if (confirm && !published) back();
            else onClose();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          {sharing ? (
            <>
              <Share2 size={14} aria-hidden /> Share snapshot “{shot.title}”
            </>
          ) : (
            <>
              <FileDown size={14} aria-hidden /> Export “{shot.title}”
            </>
          )}
        </h2>
        {confirm ? (
          <PublishStep
            confirm={confirm}
            head={confirmHead}
            copyText={copyText}
            onExpiry={(expiry) => setConfirm({ ...confirm, expiry })}
            onPublish={() => void publish()}
            onBack={back}
            onSettings={onSnapshotSettings && toSettings}
            onClose={onClose}
          />
        ) : (
          <>
            {!sharing && (
              <fieldset className="export-format">
                <legend>Format</legend>
                {(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((f) => (
                  <label key={f}>
                    <input type="radio" name={formatName} checked={format === f} onChange={() => setFormat(f)} />
                    <span>{EXPORT_FORMATS[f].label}</span>
                  </label>
                ))}
              </fieldset>
            )}
            {sharing ? (
              <p>
                A web page of the chat, for anyone you give its link. It runs no script, loads nothing, links only to web and mail addresses, and shows images
                as their address. It has the chat as it was when you opened this; later messages aren't added. Nothing is uploaded until you press Publish on
                the next step.
              </p>
            ) : (
              <p>
                {ABOUT[format]} It has the chat as it was when you opened this; later messages aren't added. Nothing is uploaded: you choose where to save it.
              </p>
            )}
            {sharing && host.kind !== "saved" && (
              <div className={`export-host export-host-${host.kind}`} role={host.kind === "failed" ? "alert" : host.kind === "none" ? "note" : "status"}>
                <p className={host.kind === "reading" ? "muted small" : "small"}>
                  {host.kind === "reading"
                    ? "Reading the snapshot host…"
                    : host.kind === "none"
                      ? "No snapshot host is set up, so this page can't be published yet. Set one up in Settings → Snapshots, or save the page as a file."
                      : `Couldn't read the snapshot host, so this page can't be published now: ${host.message}`}
                </p>
                {host.kind !== "reading" && onSnapshotSettings && (
                  <button className="btn small" onClick={toSettings}>
                    <Settings2 size={13} aria-hidden /> Open Settings → Snapshots
                  </button>
                )}
              </div>
            )}
            <fieldset className="export-messages">
              <legend>
                Messages: {chosen} of {messages.length}
              </legend>
              <div className="export-bulk">
                <button className="btn small" onClick={() => change({ leftOut: new Set() })} disabled={chosen === messages.length}>
                  All
                </button>
                <button className="btn small" onClick={() => change({ leftOut: new Set(messages.map((m) => m.id)) })} disabled={!chosen}>
                  None
                </button>
              </div>
              <ul>
                {messages.map((m, n) => (
                  <li key={m.id}>
                    <label>
                      <input
                        type="checkbox"
                        autoFocus={n === 0 && !wasConfirming.current}
                        checked={!draft.leftOut.has(m.id)}
                        onChange={(e) => change({ leftOut: toggle(draft.leftOut, m.id, !e.target.checked) })}
                      />
                      <span>
                        <b>{WHO[m.kind]}:</b> <span className="muted">{gist(m)}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <fieldset className="export-include">
              <legend>Also include</legend>
              <label>
                <input type="checkbox" checked={draft.toolCalls} disabled={!tools} onChange={(e) => change({ toolCalls: e.target.checked })} />
                <span>
                  Tool calls and Approvals, with their commands and output <span className="muted">({tools})</span>
                </span>
              </label>
              <label>
                <input type="checkbox" checked={draft.attachments} disabled={!attached} onChange={(e) => change({ attachments: e.target.checked })} />
                <span>
                  Names of attached files <span className="muted">({attached}; their contents are never included)</span>
                </span>
              </label>
            </fieldset>
            <section className="export-secrets" aria-labelledby={secretsId}>
              <h3 id={secretsId}>Likely secrets</h3>
              <p className="muted small">
                Hermes Chat looks for API keys, bearer and sign-in tokens, private keys, and passwords in links or named as a password. It can't find every
                secret: one written another way, such as a password in a sentence, stays in unless you redact it. Read the file below before you save it.
              </p>
              {preview.secrets.length ? (
                <ul>
                  {preview.secrets.map((s) => (
                    <li key={s.text}>
                      <label>
                        <input type="checkbox" checked={s.redacted} onChange={(e) => change({ kept: toggle(draft.kept, s.text, !e.target.checked) })} />
                        <span>
                          Redact {s.kind} <code>{short(s.text)}</code>
                          {s.times > 1 && <span className="muted"> ({places(s.times)})</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small">None found in what you've chosen.</p>
              )}
            </section>
            <form
              className="export-pick"
              onSubmit={(e) => {
                e.preventDefault();
                pick();
              }}
            >
              <label htmlFor={pickId}>Text to redact</label>
              <input
                id={pickId}
                // With no message to tick, focus starts here, so the keyboard is in the dialog from the start.
                autoFocus={!messages.length && !wasConfirming.current}
                value={toRedact}
                onChange={(e) => setToRedact(e.target.value)}
                aria-describedby={pickHelpId}
                spellCheck={false}
              />
              <button className="btn" type="submit" disabled={!picking || overlaps}>
                Redact
              </button>
              <span id={pickHelpId} className={overlaps ? "small export-pick-problem" : "muted small"}>
                {overlaps
                  ? `Leave ${REDACTED} out: pick text the chat has, on one side of it or the other.`
                  : kind !== "text"
                    ? `Type or paste text to replace it everywhere it appears in the ${isImage ? "picture" : "page"}.`
                    : "Select text in the file below, or type it, to replace it everywhere it appears."}
              </span>
            </form>
            {preview.picked.length > 0 && (
              <ul className="export-picked" aria-label="Text you redacted">
                {preview.picked.map((p) => (
                  <li key={p.text}>
                    <code>{short(p.text)}</code> <span className="muted">{p.times ? places(p.times) : "not in the file now"}</span>
                    <button
                      className="btn small"
                      aria-label={`Keep ${short(p.text)} in the file`}
                      onClick={() => change({ picked: draft.picked.filter((t) => t !== p.text) })}
                    >
                      Keep
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {isImage ? (
              <div className="export-preview export-image" tabIndex={0} aria-label="The picture, exactly as it will be saved" aria-busy={!picture}>
                {picture?.png ? (
                  <img src={`data:image/png;base64,${picture.png}`} alt={`The chat “${shot.title}” as a picture`} />
                ) : picture?.problem ? (
                  <p role="alert" className="logs-problem">
                    {picture.problem}
                  </p>
                ) : (
                  <p className="muted small">Drawing the picture…</p>
                )}
              </div>
            ) : kind === "page" ? (
              preview.problem ? (
                <div className="export-preview export-page">
                  <p role="alert" className="logs-problem">
                    {preview.problem}
                  </p>
                </div>
              ) : (
                <iframe
                  className="export-preview export-page"
                  title={sharing ? "The page, as it stands" : "The page, exactly as it will be saved"}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={preview.text}
                />
              )
            ) : (
              <pre ref={pre} className="export-preview" tabIndex={0} aria-label="The file, exactly as it will be saved">
                {parts.map((t, n) => (
                  <span key={n}>
                    {n > 0 && <mark>{REDACTED}</mark>}
                    {t}
                  </span>
                ))}
              </pre>
            )}
            {note && (
              <p role="alert" className="logs-problem">
                {note}
              </p>
            )}
            <div className="confirm-actions">
              <button className="btn" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              {sharing ? (
                <>
                  <button className="btn" onClick={() => void doSave()} disabled={saving || !canWrite}>
                    <Download size={14} /> Save as a file…
                  </button>
                  <button ref={publishButton} className="btn primary" onClick={openPublish} disabled={saving || !canWrite || host.kind !== "saved"}>
                    <Upload size={14} /> Publish…
                  </button>
                </>
              ) : (
                <button className="btn primary" onClick={() => void doSave()} disabled={saving || empty || (isImage && !picture?.png) || preview.problem !== undefined}>
                  <Download size={14} /> Save…
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Publish's confirm step: where the page goes, how long its link lasts, the page itself in ADR 0007's frame, and what
 * can't be taken back. Publish uploads `confirm.html`, the frame's `srcdoc`; what came of it shows in its place.
 */
function PublishStep({
  confirm,
  head,
  copyText,
  onExpiry,
  onPublish,
  onBack,
  onSettings,
  onClose,
}: {
  confirm: Confirm;
  head: RefObject<HTMLHeadingElement | null>;
  copyText: (text: string) => Promise<void>;
  onExpiry: (expiry: Expiry) => void;
  onPublish: () => void;
  onBack: () => void;
  onSettings?: () => void;
  onClose: () => void;
}) {
  const ids = useId();
  const [copied, setCopied] = useState<{ ok: true } | { ok: false; message: string }>();
  const { host, sent } = confirm;
  const sending = sent?.kind === "sending";
  const result = sent?.kind === "done" ? sent.published : undefined;
  const settled = result?.outcome === "live" || result?.outcome === "maybeSent";
  const copy = (url: string) =>
    copyText(url).then(
      () => setCopied({ ok: true }),
      (e: unknown) => setCopied({ ok: false, message: errorText(e) }),
    );
  return (
    <section className="export-confirm" aria-labelledby={`${ids}-head`}>
      <h3 id={`${ids}-head`} ref={head} tabIndex={-1}>
        {result?.outcome === "live" ? "Published" : "Publish this page?"}
      </h3>
      <dl className="export-destination">
        <dt>Host</dt>
        <dd className="mono">{endpointHost(host.endpoint)}</dd>
        <dt>Bucket</dt>
        <dd className="mono">{host.bucket}</dd>
        <dt>Prefix</dt>
        <dd className="mono">{host.prefix || "none"}</dd>
      </dl>
      <fieldset className="export-format" disabled={sending || settled}>
        <legend>The link works for</legend>
        {EXPIRIES.map((x) => (
          <label key={x.id}>
            <input type="radio" name={`${ids}-expiry`} checked={confirm.expiry === x.id} onChange={() => onExpiry(x.id)} />
            <span>{x.label}</span>
          </label>
        ))}
      </fieldset>
      <iframe
        className="export-preview export-page"
        title="The page, exactly as it will be published"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={confirm.html}
      />
      <ul className="export-warnings">
        <li>Hermes Chat can miss a secret written another way, such as a password in a sentence. Read the page above before you publish it.</li>
        <li>Anyone with the link can read the page until it ends. A copy someone saves can't be recalled, even after you revoke the snapshot.</li>
      </ul>
      {result?.outcome === "live" ? (
        <div className="export-published" role="status">
          <p>
            Published. Anyone with this link can read the page until {snapshotTime(result.snapshot.expires)}. Settings → Snapshots lists it, with Revoke.
          </p>
          <div className="export-link">
            <input readOnly value={result.snapshot.url} aria-label="Link to the snapshot" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn" onClick={() => void copy(result.snapshot.url)}>
              <Copy size={14} aria-hidden /> {copied?.ok ? "Copied" : "Copy"}
            </button>
          </div>
          {copied && !copied.ok && (
            <p role="alert" className="logs-problem">
              Couldn't copy the link: {copied.message}
            </p>
          )}
        </div>
      ) : result?.outcome === "notPublished" ? (
        <p role="alert" className="logs-problem">
          Not published: {result.reason} Nothing was left in the bucket, so you can try again.
        </p>
      ) : result?.outcome === "maybeSent" ? (
        <p role="alert" className="logs-problem">
          The page may have been sent: {result.reason} Check Settings → Snapshots before you publish it again: it lists every snapshot in the bucket.
        </p>
      ) : sent?.kind === "refused" ? (
        <p role="alert" className="logs-problem">
          Couldn't publish: {sent.message}
        </p>
      ) : null}
      <div className="confirm-actions">
        {result?.outcome === "live" ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" onClick={onBack} disabled={sending}>
              <ArrowLeft size={14} aria-hidden /> Back
            </button>
            {result?.outcome === "maybeSent" ? (
              onSettings && (
                <button className="btn primary" onClick={onSettings}>
                  <Settings2 size={14} aria-hidden /> Open Settings → Snapshots
                </button>
              )
            ) : (
              <button className="btn primary" onClick={onPublish} disabled={sending}>
                <Upload size={14} aria-hidden /> {sending ? "Publishing…" : result?.outcome === "notPublished" ? "Try again" : "Publish"}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
