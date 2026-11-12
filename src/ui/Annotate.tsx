// Annotation mode in the Preview (ADR 0094): the still covers the page, the owner points at an element or drags a
// region on it, then reviews everything that would be staged. Every mark and card is the app's own, drawn over the
// still; the live page is hidden behind it and gets no input. Nothing here sends anything: Add stages the marked image
// and its words in the composer, and Cancel deletes the still.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { MousePointerClick, X } from "lucide-react";
import {
  REGION_WHY,
  annotationWords,
  dragBox,
  failureText,
  pickLines,
  shareableAddress,
  type Answer,
  type PageWhere,
  type Pick,
  type Rect,
  type Still,
} from "../hermes/annotations";
import type { Annotator } from "./tauriPreview";
import { Spinner } from "./bits";
import { errorText } from "../hermes/values";

/** How often the page is asked what is under the pointer. */
const QUERY_MS = 100;
/** How far the pointer moves before a press becomes a drag. */
const DRAG_PX = 4;
const MAX_UP = 16;
const NOTE_MAX = 1000;

/** Where an annotation goes: the composer on screen, and the words and image it takes. */
export type AnnotationDesk = {
  target(): { chat?: string; key: string } | undefined;
  nextAnnotation(): number;
  annotate(path: string, words: string, from: { url: string; takenAtMs: number }, to: { key: string; live: () => boolean }): Promise<boolean>;
};

type Point = { x: number; y: number };

export function AnnotationOverlay({
  still,
  viewKey,
  page,
  api,
  desk,
  onDone,
}: {
  still: Still;
  /** The view element queries ask, when the still has them. */
  viewKey?: string;
  /** The page as the owner opened it (a Server page's tunnel set back to the server), and where it is. */
  page: { url: string; where: PageWhere };
  api: Annotator;
  desk: AnnotationDesk;
  /** `staged`: Rust staged the still, so it is gone; otherwise the caller deletes it. */
  onDone: (staged: boolean) => void;
}) {
  const [image, setImage] = useState<string>();
  const [imageFailed, setImageFailed] = useState<string>();
  const [hover, setHover] = useState<Answer>();
  const [up, setUp] = useState(0);
  const [drag, setDrag] = useState<{ from: Point; to: Point }>();
  const [pick, setPick] = useState<Pick>();
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const stage = useRef<HTMLDivElement>(null);
  const pressed = useRef<Point>(undefined);
  const lastPoint = useRef<Point>(undefined);
  const asked = useRef(0);
  const queryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const live = useRef(true);
  const elements = still.elements && !!viewKey;

  useEffect(() => {
    live.current = true;
    let url: string | undefined;
    api.read(still.path).then(
      (blob) => {
        if (!live.current) return;
        url = URL.createObjectURL(blob);
        setImage(url);
      },
      (e) => live.current && setImageFailed(failureText(e)),
    );
    return () => {
      live.current = false;
      clearTimeout(queryTimer.current);
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, still.path]);

  // Back to picking, the still takes the keyboard again, so Escape and the arrows reach the overlay rather than the app.
  useEffect(() => {
    if (!pick) stage.current?.focus();
  }, [image, pick]);

  /** A pointer position in the still's CSS pixels, even off the still, as a drag past its edge goes. */
  const placeOf = (e: { clientX: number; clientY: number }): Point | undefined => {
    const r = stage.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return undefined;
    return { x: ((e.clientX - r.left) * still.width) / r.width, y: ((e.clientY - r.top) * still.height) / r.height };
  };
  /** A pointer position on the still, or nothing when it is off it. */
  const pointOf = (e: { clientX: number; clientY: number }): Point | undefined => {
    const at = placeOf(e);
    return at && at.x >= 0 && at.y >= 0 && at.x < still.width && at.y < still.height ? at : undefined;
  };

  const ask = (at: Point, climb: number) => {
    if (!elements || !viewKey) return;
    const n = ++asked.current;
    api.query(viewKey, still.id, at.x, at.y, climb).then(
      (answer) => live.current && n === asked.current && setHover(answer ?? undefined),
      () => live.current && n === asked.current && setHover(undefined),
    );
  };
  const askSoon = (at: Point, climb: number) => {
    lastPoint.current = at;
    clearTimeout(queryTimer.current);
    queryTimer.current = setTimeout(() => ask(at, climb), QUERY_MS);
  };

  const choose = async (at: Point) => {
    if (!elements || !viewKey) {
      setError("Drag to mark a region.");
      return;
    }
    setPicking(true);
    setError(undefined);
    try {
      const got = await api.pick(viewKey, still.id, at.x, at.y, up);
      if (live.current) setPick(got);
    } catch (e) {
      if (!live.current) return;
      const failure = e as { kind?: string };
      if (failure?.kind === "noAnswer" && hover) setPick({ kind: "region", rect: hover.rect, why: { kind: "noAnswer" } });
      else if (failure?.kind === "noAnswer") setError("Nothing there answered. Drag to mark a region instead.");
      else setError(failureText(e));
    } finally {
      if (live.current) setPicking(false);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || picking) return;
    const at = pointOf(e);
    if (!at) return;
    pressed.current = at;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const at = pointOf(e);
    const from = pressed.current;
    if (from) {
      const to = placeOf(e) ?? from;
      if (drag || Math.hypot(to.x - from.x, to.y - from.y) * (stageScale() || 1) >= DRAG_PX) setDrag({ from, to });
      return;
    }
    if (at) askSoon(at, up);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const from = pressed.current;
    pressed.current = undefined;
    if (!from) return;
    if (drag) {
      const rect = dragBox(drag.from, placeOf(e) ?? drag.to, still);
      setDrag(undefined);
      if (rect.width >= 2 && rect.height >= 2) {
        setError(undefined);
        setPick({ kind: "region", rect, why: { kind: still.elements ? "drawn" : "framed" } });
      }
      return;
    }
    void choose(pointOf(e) ?? from);
  };
  /** CSS pixels on screen per CSS pixel of the still. */
  const stageScale = () => {
    const r = stage.current?.getBoundingClientRect();
    return r?.width ? r.width / still.width : 1;
  };

  const onStageKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = lastPoint.current;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(0, Math.min(MAX_UP, up + (e.key === "ArrowUp" ? 1 : -1)));
      setUp(next);
      if (at) ask(at, next);
    } else if (e.key === "Enter" && at) {
      e.preventDefault();
      void choose(at);
    }
  };

  const add = async () => {
    if (!pick || adding) return;
    // The chat the card names now is the only one it may go to, whatever opens while Rust marks the still.
    const to = desk.target();
    if (!to) return setError("No chat is open to add it to. Open a chat, then press Add again.");
    setAdding(true);
    setError(undefined);
    const n = desk.nextAnnotation();
    const words = annotationWords({ n, url: page.url, where: page.where, takenAtMs: still.takenAtMs, still, pick, note });
    try {
      const path = await api.stage(still.path, n, pick.rect, still.scale);
      // Cancelled while Rust marked it (the page moved, the Preview or profile changed): the image is never staged.
      if (!live.current) return void api.discard(path).catch(() => {});
      // Live until Add is done, and for good after: one waiting for its composer to show still arrives.
      let added = false;
      await desk.annotate(path, words, { url: page.url, takenAtMs: still.takenAtMs }, { key: to.key, live: () => added || live.current });
      added = true;
      // Cancelled meanwhile, this overlay is gone and has nothing to end; a newer one may be open.
      if (live.current) onDone(true);
    } catch (e) {
      if (!live.current) return;
      setAdding(false);
      setError(`Couldn't add the annotation: ${errorText(e)}`);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    if (pick && !adding) setPick(undefined);
    else if (!adding) onDone(false);
  };

  const mark = (r: Rect, className: string) => (
    <div
      className={className}
      style={{
        left: `${(r.x / still.width) * 100}%`,
        top: `${(r.y / still.height) * 100}%`,
        width: `${(r.width / still.width) * 100}%`,
        height: `${(r.height / still.height) * 100}%`,
      }}
    />
  );
  const shown = drag ? dragBox(drag.from, drag.to, still) : (pick?.rect ?? hover?.rect);
  const target = desk.target();

  return (
    <div className={pick ? "annotate reviewing" : "annotate picking"} role="dialog" aria-label="Annotate the page" onKeyDown={onKeyDown}>
      <div className="annotate-notes">
        <div className="annotate-bar">
          <MousePointerClick size={14} aria-hidden />
          <span className="annotate-hint">
            {pick
              ? "Review what will be added to your message."
              : elements
                ? "Point at an element and click it, or drag a region. Up and Down arrows pick its parent or go back. Esc cancels."
                : "Drag to mark a region. Esc cancels."}
          </span>
          <button className="icon-btn" title="Cancel the annotation" aria-label="Cancel the annotation" disabled={adding} onClick={() => onDone(false)}>
            <X size={15} />
          </button>
        </div>
        {!still.elements && !pick && <div className="attach-note annotate-why">{REGION_WHY.framed({ kind: "framed" })}</div>}
        {error && (
          <div className="attach-note failed" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="annotate-body">
        <div className="annotate-frame">
          {imageFailed ? (
            <div className="preview-state preview-error" role="alert">
              {imageFailed}
            </div>
          ) : !image ? (
            <div className="preview-state preview-loading" role="status">
              <Spinner /> Taking a still of the page…
            </div>
          ) : (
            <div
              ref={stage}
              className={pick ? "annotate-stage" : "annotate-stage picking"}
              style={{
                aspectRatio: `${still.width} / ${still.height}`,
                // Picking, the still sits where the page was, at its size; reviewing, it fits in 40% of the window's height.
                width: pick ? `min(100%, ${(40 * still.width) / still.height}vh)` : `min(100%, ${still.width}px)`,
              }}
              tabIndex={pick ? -1 : 0}
              aria-label={pick ? "The still, with your mark" : "The still of the page: point at what to annotate"}
              aria-busy={picking}
              onPointerDown={pick ? undefined : onPointerDown}
              onPointerMove={pick ? undefined : onPointerMove}
              onPointerUp={pick ? undefined : onPointerUp}
              onPointerLeave={() => !pressed.current && !pick && setHover(undefined)}
              onKeyDown={pick ? undefined : onStageKey}
            >
              <img src={image} alt="" draggable={false} />
              {shown && mark(shown, drag ? "annotate-mark dragging" : pick ? "annotate-mark picked" : "annotate-mark")}
              {hover && !pick && !drag && <HoverTag answer={hover} still={still} />}
            </div>
          )}
        </div>
        {pick && (
          <ReviewCard
            still={still}
            page={page}
            pick={pick}
            note={note}
            onNote={setNote}
            chat={target?.chat}
            hasTarget={!!target}
            adding={adding}
            onAdd={() => void add()}
            onBack={() => {
              setPick(undefined);
              setError(undefined);
            }}
            onCancel={() => onDone(false)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * What the pointer is over, named just above its outline (below it at the still's top), from the outline's edge nearer
 * the still's middle, so it stays on the still.
 */
function HoverTag({ answer, still }: { answer: Answer; still: Still }) {
  const t = answer.target;
  const text = t.kind === "otherSite" ? `frame from ${t.host}` : t.kind === "field" ? `${t.tag} (${t.field.kind === "other" ? t.field.type : t.field.kind} field)` : t.selector;
  const { x, y, width, height } = answer.rect;
  const above = y > 28;
  const fromRight = x + width / 2 > still.width / 2;
  return (
    <div
      className="annotate-tag"
      aria-live="polite"
      style={{
        ...(fromRight ? { right: `${(1 - (x + width) / still.width) * 100}%` } : { left: `${(x / still.width) * 100}%` }),
        top: `${((above ? y : y + height) / still.height) * 100}%`,
        transform: above ? "translateY(calc(-100% - 3px))" : "translateY(3px)",
      }}
    >
      {text}
    </div>
  );
}

function ReviewCard({
  still,
  page,
  pick,
  note,
  onNote,
  chat,
  hasTarget,
  adding,
  onAdd,
  onBack,
  onCancel,
}: {
  still: Still;
  page: { url: string; where: PageWhere };
  pick: Pick;
  note: string;
  onNote: (note: string) => void;
  chat?: string;
  hasTarget: boolean;
  adding: boolean;
  onAdd: () => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => noteRef.current?.focus(), []);
  const taken = new Date(still.takenAtMs).toLocaleTimeString([], { hour12: false });
  return (
    <section className="annotate-card" aria-label="Review the annotation">
      <div className="annotate-card-title">What will be added to your message</div>
      <dl className="annotate-facts">
        <dt>Page</dt>
        <dd className="annotate-address">{shareableAddress(page.url)}</dd>
        <dt>Still taken</dt>
        <dd>{taken}</dd>
      </dl>
      <pre className="annotate-lines">{pickLines(pick, still).join("\n")}</pre>
      <label className="annotate-note">
        Note
        <textarea
          ref={noteRef}
          rows={3}
          maxLength={NOTE_MAX}
          value={note}
          placeholder="What should change here?"
          onChange={(e) => onNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              onAdd();
            }
          }}
        />
      </label>
      <p className="annotate-small">
        The image is the visible page as it was, so anything shown in it goes too. The words go in the message, where you can edit them before
        you send. Nothing is sent until you send the message.
      </p>
      <p className="annotate-small" role={hasTarget ? undefined : "alert"}>
        {hasTarget ? <>Adds to the message in {chat ? <strong>{chat}</strong> : "the chat you were last in"}.</> : "No chat is open to add it to."}
      </p>
      <div className="annotate-actions">
        <button className="btn primary" disabled={adding || !hasTarget} onClick={onAdd}>
          {adding ? "Adding…" : "Add to message"}
        </button>
        <button className="btn" disabled={adding} onClick={onBack}>
          Pick again
        </button>
        <button className="link-btn" disabled={adding} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
