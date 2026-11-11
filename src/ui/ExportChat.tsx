// The Export dialog: the owner picks the format, the messages, whether tool calls and attachment names go in, and what is
// redacted, and sees the file exactly as Save writes it (exportChat.ts `exportPreview`, ADR 0076). It works on the chat
// as it was when the dialog opened, so a reply that arrives meanwhile doesn't change a file already read.
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Download, FileDown } from "lucide-react";
import type { Chat, Item } from "../hermes/model";
import {
  EXPORT_FORMATS,
  FIRST_DRAFT,
  REDACTED,
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
};

/** The picture drawn for one preview, so a draw that finishes after the owner changed something is never shown or saved. */
type Drawn = { of: string; png?: string; problem?: string };

/** Escape, Cancel or a click outside closes it without saving. `onSaved` gets the notice to show once a file is saved. */
export function ExportChatDialog({
  chat,
  save,
  saveAsImage,
  draw = chatImage,
  returnTo,
  onSaved,
  onClose,
}: {
  chat: Chat;
  save?: SaveFile;
  saveAsImage?: SaveImage;
  draw?: (page: ImagePage) => Promise<string>;
  returnTo?: RefObject<HTMLElement | null>;
  onSaved: (notice: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const secretsId = useId();
  const pickId = useId();
  const pickHelpId = useId();
  const formatName = useId();
  const [shot] = useState(() => chat);
  const [at] = useState(() => new Date());
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [draft, setDraft] = useState<ExportDraft>(FIRST_DRAFT);
  const [toRedact, setToRedact] = useState("");
  const [note, setNote] = useState<string>();
  const [saving, setSaving] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  const preview = useMemo(() => exportPreview(shot, draft, at, format), [draft, format]);
  const messages = shot.items.filter(isMessage);
  const tools = shot.items.filter((i) => i.kind === "tool" || i.kind === "approval").length;
  const attached = shot.items.reduce((n, i) => n + (i.kind === "user" ? (i.attachments?.length ?? 0) : 0), 0);
  const chosen = messages.length - messages.filter((m) => draft.leftOut.has(m.id)).length;
  const empty = !chosen && !(draft.toolCalls && tools);
  const isImage = EXPORT_FORMATS[format].kind === "image";
  const [drawn, setDrawn] = useState<Drawn>();
  const picture = isImage && drawn?.of === preview.text ? drawn : undefined;

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [isImage, preview.text]);

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

  const parts = preview.text.split(REDACTED);
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div
        ref={box}
        className="leave-dialog export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !saving && !composing(e)) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <FileDown size={14} aria-hidden /> Export “{shot.title}”
        </h2>
        <fieldset className="export-format">
          <legend>Format</legend>
          {(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((f) => (
            <label key={f}>
              <input type="radio" name={formatName} checked={format === f} onChange={() => setFormat(f)} />
              <span>{EXPORT_FORMATS[f].label}</span>
            </label>
          ))}
        </fieldset>
        <p>
          {ABOUT[format]} It has the chat as it was when you opened this; later messages aren't added. Nothing is uploaded: you choose where to save it.
        </p>
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
                    autoFocus={n === 0}
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
            autoFocus={!messages.length}
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
              : isImage
                ? "Type or paste text to replace it everywhere it appears in the picture."
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
          <button className="btn primary" onClick={() => void doSave()} disabled={saving || empty || (isImage && !picture?.png)}>
            <Download size={14} /> Save…
          </button>
        </div>
      </div>
    </div>
  );
}
