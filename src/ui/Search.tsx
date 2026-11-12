// Search across every chat in the profile from the Ctrl+K palette, with filters for Tag, Source, model, last activity
// and state (chatFilter.ts, ADR 0106). Words go to Hermes's own search; filters without words list the profile's chats
// from Hermes. A filter can be saved by name, and its results tagged in bulk once the owner has seen what would change.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ListFilter, Search, Tag as TagIcon, X } from "lucide-react";
import { STATE_LABEL, isEmptyFilter, tidyFilter, type ChatFilter, type ChatState, type FilterOutcome } from "../hermes/chatFilter";
import { SOURCE_LABEL, type Found, type Source } from "../hermes/model";
import { previewBulk, type BulkPreview, type ScopeTags } from "../hermes/tags";
import { SourceIcon, Spinner, highlight, useReturnFocus } from "./bits";
import { useLocale } from "../i18n/locale";
import { isTextEdit } from "./editKeys";
import { chordLabel, pick, useBindings } from "./keybindings";
import { trapTab } from "./modal";
import { errorText } from "../hermes/values";

/** Typing this long without a pause sends the search. */
const PAUSE_MS = 200;

const SOURCE_NAME: Record<Source, string> = { ...SOURCE_LABEL, cli: "Command line", desktop: "Hermes desktop app", import: "Imported transcripts", other: "Other platforms" };

/** Each part of a filter but its words, as the owner reads it, with what clears it. */
function filterParts(f: ChatFilter, tags: ScopeTags): { key: string; label: string; clear: ChatFilter }[] {
  const name = (id: string) => tags.tags.find((t) => t.id === id)?.name;
  return [
    ...(f.tags ?? []).map((id) => ({ key: `tag-${id}`, label: `Tag: ${name(id) ?? "(deleted tag)"}`, clear: { ...f, tags: f.tags!.filter((t) => t !== id) } })),
    ...(f.sources ?? []).map((s) => ({ key: `src-${s}`, label: `Source: ${SOURCE_NAME[s]}`, clear: { ...f, sources: f.sources!.filter((x) => x !== s) } })),
    ...(f.model ? [{ key: "model", label: `Model: ${f.model}`, clear: { ...f, model: undefined } }] : []),
    ...(f.from ? [{ key: "from", label: `Active from ${f.from}`, clear: { ...f, from: undefined } }] : []),
    ...(f.to ? [{ key: "to", label: `Active until ${f.to}`, clear: { ...f, to: undefined } }] : []),
    ...(f.state ? [{ key: "state", label: `State: ${STATE_LABEL[f.state]}`, clear: { ...f, state: undefined } }] : []),
  ];
}

/** Why the results may not be every chat that matches, or why none can. */
function outcomeNotes(o: FilterOutcome): string[] {
  return [
    o.missingTags.length > 0 && "This filter names a tag that was deleted, so no chat can match it. Remove that tag to search again.",
    o.capped === "search" &&
      `Hermes's search gives its ${o.found.length ? "best matches" : "matches"} only, at most 100 chats, before these filters are checked here. More chats may match: add words to narrow the search.`,
    o.capped === "list" && "Only the 2,000 most recent chats were checked. Older ones may match too.",
    o.noModel > 0 &&
      `Hermes didn't record a model for ${o.noModel} chat${o.noModel === 1 ? "" : "s"} that matched everything else, so the model filter left ${o.noModel === 1 ? "it" : "them"} out.`,
    o.noSource > 0 &&
      `Hermes stored ${o.noSource} chat${o.noSource === 1 ? "" : "s"} that matched everything else as local, without saying which app started ${o.noSource === 1 ? "it" : "them"}, so the source filter left ${o.noSource === 1 ? "it" : "them"} out.`,
  ].filter((n): n is string => !!n);
}

export function SearchPalette({
  profile,
  tags,
  initial,
  initialName,
  onRun,
  onPick,
  onClose,
  onSave,
  onBulk,
  onManageTags,
  passKey = () => false,
}: {
  profile: string;
  tags: ScopeTags;
  /** A Saved filter being opened, and its name. */
  initial?: ChatFilter;
  initialName?: string;
  onRun: (f: ChatFilter) => Promise<FilterOutcome>;
  onPick: (found: Found) => void;
  onClose: () => void;
  /** Saves the filter by name; rejects saying why it couldn't. */
  onSave: (name: string, f: ChatFilter) => Promise<unknown>;
  /** Applies a bulk tag edit the owner confirmed; rejects, changing nothing, if it couldn't. */
  onBulk: (p: BulkPreview) => Promise<unknown>;
  onManageTags: () => void;
  /** The app's shortcuts that still work over the palette, such as Ctrl+K, which closes it. */
  passKey?: (e: KeyboardEvent) => boolean;
}) {
  const l = useLocale();
  const [filter, setFilter] = useState<ChatFilter>(initial ?? {});
  const keys = useBindings();
  const [filtersOpen, setFiltersOpen] = useState(!!initial && Object.keys(tidyFilter({ ...initial, text: undefined })).length > 0);
  const tidy = tidyFilter(filter);
  const key = JSON.stringify(tidy);
  // The results and the filter they answer, so a slow answer to an older one is never shown.
  // The results, and the filter and tags they answer, so an answer to an older search is never acted on.
  const [results, setResults] = useState<{ key: string; tags?: ScopeTags | null; text?: string; outcome?: FilterOutcome }>({ key: "{}" });
  const [error, setError] = useState<string>();
  const [sel, setSel] = useState(0);
  const [panel, setPanel] = useState<"save" | "bulk">();
  const [note, setNote] = useState<string>();
  const filtersId = useId();
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useReturnFocus();
  // A panel's buttons go when it closes, so focus goes back to the words.
  const closePanel = () => {
    setPanel(undefined);
    input.current?.focus();
  };
  // A change to the tags re-runs a filter that names any.
  const tagDep = tidy.tags ? tags : null;

  useEffect(() => {
    setError(undefined);
    if (isEmptyFilter(tidy)) {
      setResults({ key });
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      onRun(tidy).then(
        (outcome) => current && (setResults({ key, tags: tagDep, text: tidy.text, outcome }), setSel(0)),
        (e) => current && setError(`Couldn't search: ${errorText(e)}`),
      );
    }, PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- search again only when the filter (by its `key`) or the tags it names change; `tidy` and `onRun` are new every render, so listing them would restart the search on every render
  }, [key, tagDep]);
  // A bulk edit is for the results it previewed: a new filter, or a change to the tags it filters by, ends it,
  // applying nothing. Either searches again, so a failed search has ended it too.
  useEffect(() => setPanel((p) => (p === "bulk" ? undefined : p)), [key, tagDep]);

  const empty = isEmptyFilter(tidy);
  const outcome = results.key === key && results.tags === tagDep ? results.outcome : undefined;
  const shownOutcome = error ? undefined : results.outcome;
  const found = shownOutcome?.found ?? [];
  // Results for an earlier filter stay on screen until the new ones come, but can't be opened or tagged.
  const stale = !outcome;
  const searching = !empty && !outcome && !error;
  const parts = filterParts(tidy, tags);
  const set = (patch: Partial<ChatFilter>) => {
    setNote(undefined);
    setFilter((f) => ({ ...f, ...patch }));
  };

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Search chats"
        ref={box}
        onMouseDown={(e) => e.stopPropagation()}
        // The app's shortcuts don't reach past the palette, except the ones `passKey` lets through, and undo and redo
        // in its fields, which the window runs (editKeys.ts). Tab stays inside it. Escape closes an open panel first,
        // applying nothing, then the palette.
        onKeyDown={(e) => {
          if (!passKey(e) && !isTextEdit(e)) e.stopPropagation();
          // A Tab chord the owner gave a result key is the input's, not the trap's.
          if (!e.defaultPrevented) trapTab(e, box.current);
          if (pick(e, "palette") !== "paletteClose") return;
          // Taken, so Search's own app-wide keys, if the owner put Close on them too, don't open it again.
          e.preventDefault();
          if (panel) closePanel();
          else onClose();
        }}
      >
        <div className="palette-input">
          {searching ? <Spinner /> : <Search size={16} />}
          <input
            ref={input}
            autoFocus
            placeholder="Search all chats, including Settled"
            aria-label="Words to search for"
            value={filter.text ?? ""}
            onChange={(e) => set({ text: e.target.value })}
            onKeyDown={(e) => {
              const command = pick(e, "palette");
              if (command === "paletteDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, found.length - 1));
              } else if (command === "paletteUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (command === "paletteOpen" && !stale && found[sel]) {
                e.preventDefault();
                onPick(found[sel]);
              }
            }}
          />
          <button
            className={`palette-filters-btn ${parts.length ? "on" : ""}`}
            aria-expanded={filtersOpen}
            aria-controls={filtersId}
            onClick={() => setFiltersOpen((o) => !o)}
          >
            <ListFilter size={14} aria-hidden /> Filters{parts.length ? ` (${parts.length})` : ""}
          </button>
          <kbd>{chordLabel(keys.paletteClose[0])}</kbd>
        </div>
        {filtersOpen && <FilterBar id={filtersId} filter={filter} tags={tags} onChange={set} onManageTags={onManageTags} />}
        {parts.length > 0 && (
          <div className="filter-chips" role="group" aria-label="Active filters">
            <span className="filter-scope" title="Filters apply to the profile on screen only">
              In {profile}
              {initialName && JSON.stringify(tidyFilter(initial ?? {})) === key ? `, saved as "${initialName}"` : ""}:
            </span>
            {parts.map((p) => (
              <span key={p.key} className="chip filter-chip">
                <span className="chip-name">{p.label}</span>
                <button aria-label={`Remove filter ${p.label}`} title="Remove this filter" onClick={() => set(p.clear)}>
                  <X size={12} aria-hidden />
                </button>
              </span>
            ))}
            <button className="link-btn" onClick={() => set({ tags: undefined, sources: undefined, model: undefined, from: undefined, to: undefined, state: undefined })}>
              Clear filters
            </button>
          </div>
        )}
        {panel === "save" && (
          <SaveFilter
            onSave={async (name) => {
              await onSave(name, tidy);
              closePanel();
              setNote(`Saved as "${name.trim()}". It's in the list's Saved filters.`);
            }}
            onCancel={closePanel}
          />
        )}
        {panel === "bulk" && (
          <BulkTag
            tags={tags}
            chatIds={found.map((f) => f.chatId)}
            titles={new Map(found.map((f) => [f.chatId, f.title]))}
            onApply={async (p) => {
              await onBulk(p);
              closePanel();
              setNote(`${p.add ? "Added" : "Removed"} "${p.tag.name}" ${p.add ? "to" : "from"} ${p.change.length} chat${p.change.length === 1 ? "" : "s"}.`);
            }}
            onCancel={closePanel}
            onManageTags={onManageTags}
          />
        )}
        {note && (
          <div className="palette-note ok" role="status">
            {note}
          </div>
        )}
        {shownOutcome && !error && outcomeNotes(shownOutcome).map((n) => (
          <div key={n} className="palette-note" role="note">
            {n}
          </div>
        ))}
        <div className="palette-results">
          {error && (
            <div className="palette-empty err" role="alert">
              {error}
            </div>
          )}
          {!error && empty && <div className="palette-empty">Search the words and titles of every chat, or pick filters</div>}
          {!error && !empty && outcome && found.length === 0 && !outcome.missingTags.length && (
            <div className="palette-empty">{parts.length ? "No chats match these filters" : "No matches"}</div>
          )}
          {found.map((f, i) => (
            <button
              key={f.chatId}
              className={`hit-row ${i === sel ? "sel" : ""} ${stale ? "stale" : ""}`}
              aria-disabled={stale || undefined}
              ref={(el) => void (i === sel && el?.scrollIntoView?.({ block: "nearest" }))}
              onMouseEnter={() => setSel(i)}
              onClick={() => !stale && onPick(f)}
            >
              <div className="hit-title">
                <SourceIcon source={f.source} />
                <span className="hit-name">{highlight(f.title, results.text ?? "", "hl")}</span>
                {f.archived ? <span className="badge">Archived</span> : f.settled && <span className="badge">Settled</span>}
                <span className="hit-time">{l.fmt.age(f.updatedAt)}</span>
              </div>
              <HitTags tags={tags} chatId={f.chatId} model={tidy.model || tidy.text ? f.model : undefined} />
              {f.snippet.length > 0 && (
                <div className="hit-snippet">
                  {f.snippet.map((p, j) =>
                    p.hit ? (
                      <mark key={j} className="hl">
                        {p.text}
                      </mark>
                    ) : (
                      p.text
                    ),
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
        {!empty && !panel && (
          <div className="palette-foot">
            <button className="btn" onClick={() => (setNote(undefined), setPanel("save"))}>
              Save filter…
            </button>
            <button className="btn" disabled={!found.length || stale} onClick={() => (setNote(undefined), setPanel("bulk"))}>
              <TagIcon size={13} aria-hidden /> Tag {found.length} result{found.length === 1 ? "" : "s"}…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A chat's tags, by name, and its model when the filter is about models. */
function HitTags({ tags, chatId, model }: { tags: ScopeTags; chatId: string; model?: string }) {
  const names = (tags.chats[chatId] ?? []).flatMap((id) => tags.tags.find((t) => t.id === id)?.name ?? []);
  if (!names.length && !model) return null;
  return (
    <div className="hit-tags">
      {names.map((n) => (
        <span key={n} className="tag-label">
          <TagIcon size={11} aria-hidden />
          <span className="sr-only">Tag </span>
          {n}
        </span>
      ))}
      {model && <span className="hit-model">{model}</span>}
    </div>
  );
}

function FilterBar({
  id,
  filter,
  tags,
  onChange,
  onManageTags,
}: {
  id: string;
  filter: ChatFilter;
  tags: ScopeTags;
  onChange: (patch: Partial<ChatFilter>) => void;
  onManageTags: () => void;
}) {
  const unpicked = tags.tags.filter((t) => !filter.tags?.includes(t.id));
  const field = (label: string, control: ReactNode) => (
    <label className="filter-field">
      <span>{label}</span>
      {control}
    </label>
  );
  return (
    <div className="filter-bar" id={id} role="group" aria-label="Filters">
      {field(
        "Tag",
        <select value="" disabled={!unpicked.length} onChange={(e) => e.target.value && onChange({ tags: [...(filter.tags ?? []), e.target.value] })}>
          <option value="">{tags.tags.length ? (unpicked.length ? "Add a tag…" : "All tags picked") : "No tags yet"}</option>
          {unpicked.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>,
      )}
      {field(
        "Source",
        <select
          value={filter.sources?.length === 1 ? filter.sources[0] : ""}
          onChange={(e) => onChange({ sources: e.target.value ? [e.target.value as Source] : undefined })}
        >
          <option value="">Any</option>
          {(Object.keys(SOURCE_NAME) as Source[]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_NAME[s]}
            </option>
          ))}
        </select>,
      )}
      {field("Model", <input type="text" placeholder="Any" value={filter.model ?? ""} onChange={(e) => onChange({ model: e.target.value })} />)}
      {field("Active from", <input type="date" value={filter.from ?? ""} max={filter.to} onChange={(e) => onChange({ from: e.target.value || undefined })} />)}
      {field("Until", <input type="date" value={filter.to ?? ""} min={filter.from} onChange={(e) => onChange({ to: e.target.value || undefined })} />)}
      {field(
        "State",
        <select value={filter.state ?? ""} onChange={(e) => onChange({ state: (e.target.value || undefined) as ChatState | undefined })}>
          <option value="">Active and Settled</option>
          {(Object.keys(STATE_LABEL) as ChatState[]).map((s) => (
            <option key={s} value={s}>
              {STATE_LABEL[s]}
            </option>
          ))}
        </select>,
      )}
      <button className="link-btn filter-manage" onClick={onManageTags}>
        Manage tags…
      </button>
    </div>
  );
}

function SaveFilter({ onSave, onCancel }: { onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="palette-panel"
      aria-label="Save filter"
      onSubmit={(e) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        onSave(name).catch((err) => (setError(errorText(err)), setSaving(false)));
      }}
    >
      <label className="filter-field grow">
        <span>Name this filter</span>
        <input autoFocus value={name} aria-invalid={!!error} onChange={(e) => (setName(e.target.value), setError(undefined))} />
      </label>
      <button className="btn primary" type="submit" disabled={saving}>
        Save
      </button>
      <button className="btn" type="button" onClick={onCancel}>
        Cancel
      </button>
      <p className="palette-panel-hint">Saved on this computer for this profile. Opening it runs the search again; it doesn't group chats the way a project does.</p>
      {error && (
        <p className="palette-panel-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Adding a tag to, or taking it off, every chat in the results. The owner picks the tag, sees which chats would
 * change, and confirms. Nothing changes until then; Cancel, or Escape, leaves every chat as it was.
 */
function BulkTag({
  tags,
  chatIds,
  titles,
  onApply,
  onCancel,
  onManageTags,
}: {
  tags: ScopeTags;
  chatIds: string[];
  titles: Map<string, string>;
  onApply: (p: BulkPreview) => Promise<void>;
  onCancel: () => void;
  onManageTags: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [tagId, setTagId] = useState(tags.tags[0]?.id ?? "");
  const [add, setAdd] = useState(true);
  const [preview, setPreview] = useState<BulkPreview>();
  const [error, setError] = useState<string>();
  const summaryId = useId();
  if (!tags.tags.length)
    return (
      <div className="palette-panel" role="group" aria-label="Tag results">
        <p className="palette-panel-hint">There are no tags yet in this profile.</p>
        <button className="btn" onClick={onManageTags}>
          Manage tags…
        </button>
        <button className="btn" autoFocus onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  if (preview) {
    const { change, unchanged, tag } = preview;
    const n = change.length;
    return (
      <div className="palette-panel bulk-preview" role="group" aria-label="Confirm tag change">
        <p className="bulk-summary" id={summaryId}>
          {n === 0
            ? `Nothing to change: ${add ? "every chat here already has" : "no chat here has"} "${tag.name}".`
            : `${add ? "Add" : "Remove"} "${tag.name}" ${add ? "to" : "from"} ${n} chat${n === 1 ? "" : "s"}${unchanged.length ? `. ${unchanged.length} already ${unchanged.length === 1 ? (add ? "has it" : "doesn't have it") : add ? "have it" : "don't have it"} and ${unchanged.length === 1 ? "stays as it is" : "stay as they are"}` : ""}.`}
        </p>
        {n > 0 && (
          <ul className="bulk-list" aria-label="Chats that would change">
            {change.map((c) => (
              <li key={c}>{titles.get(c) ?? c}</li>
            ))}
          </ul>
        )}
        <p className="palette-panel-hint">Only the chats listed in the results change. Tags are kept on this computer, not in Hermes.</p>
        {error && (
          <p className="palette-panel-error" role="alert">
            {error}
          </p>
        )}
        <div className="bulk-actions">
          <button
            className="btn primary"
            disabled={n === 0 || applying}
            aria-describedby={summaryId}
            onClick={() => {
              setApplying(true);
              onApply(preview).catch((e) => (setError(errorText(e)), setApplying(false)));
            }}
          >
            {add ? "Add to" : "Remove from"} {n} chat{n === 1 ? "" : "s"}
          </button>
          <button className="btn" autoFocus onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="palette-panel"
      aria-label="Tag results"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          setPreview(previewBulk(tags, chatIds, tagId, add));
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      <label className="filter-field">
        <span>Tag</span>
        <select autoFocus value={tagId} onChange={(e) => setTagId(e.target.value)}>
          {tags.tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="bulk-mode">
        <legend className="sr-only">Add or remove</legend>
        <label>
          <input type="radio" name="bulk-mode" checked={add} onChange={() => setAdd(true)} /> Add to {chatIds.length} result{chatIds.length === 1 ? "" : "s"}
        </label>
        <label>
          <input type="radio" name="bulk-mode" checked={!add} onChange={() => setAdd(false)} /> Remove from them
        </label>
      </fieldset>
      <button className="btn primary" type="submit">
        Preview
      </button>
      <button className="btn" type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && (
        <p className="palette-panel-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
