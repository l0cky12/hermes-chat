// Tags and Saved filters on screen (tags.ts, ADR 0106): the dialog that creates, renames and deletes the profile's
// tags, and the list's Saved filters, each of which opens the search palette with its filter.
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { ListFilter, Pencil, Tag as TagIcon, Trash2 } from "lucide-react";
import type { SavedFilter, TagsStore } from "../hermes/tags";
import { composing } from "./bits";
import { useModal } from "./modal";
import { errorText } from "../hermes/values";

/**
 * The profile's tags: create, rename and delete. Deleting asks first and says how many chats lose the tag. Closing it
 * puts focus on `returnTo` when that is still there (the chat row whose menu opened it), or back where it was.
 */
export function TagManager({
  store,
  profile,
  returnTo,
  onClose,
}: {
  store: TagsStore;
  profile: string;
  returnTo?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [deleting, setDeleting] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const newBox = useRef<HTMLInputElement>(null);
  const keys = useModal(box, returnTo);
  const [saving, setSaving] = useState(false);
  // Where focus goes once a row is back from renaming or deleting: that tag's Rename button, or "" for the new tag box.
  const [refocus, setRefocus] = useState<string>();
  useEffect(() => {
    if (refocus === undefined) return;
    const rename = [...(box.current?.querySelectorAll<HTMLElement>("[data-tag]") ?? [])].find((b) => b.dataset.tag === refocus);
    (rename ?? newBox.current)?.focus();
    setRefocus(undefined);
  }, [refocus]);
  const back = (tagId = "") => {
    setRenaming(undefined);
    setDeleting(undefined);
    setRefocus(tagId);
  };
  const count = (id: string) => Object.values(snap.chats).filter((of) => of.includes(id)).length;
  // One change at a time; each says whether it was kept.
  const run = async (fn: () => Promise<unknown>) => {
    if (saving) return false;
    setSaving(true);
    try {
      await fn();
      setError(undefined);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="leave-dialog tag-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-manager-title"
        onKeyDown={(e) => {
          keys(e);
          if (e.key !== "Escape" || composing(e)) return;
          e.preventDefault();
          if (renaming || deleting) back(renaming?.id ?? deleting);
          else onClose();
        }}
      >
        <h2 id="tag-manager-title" className="leave-title">
          <TagIcon size={14} aria-hidden /> Tags in {profile}
        </h2>
        <p className="muted small">Kept on this computer for this profile only. Hermes and your other Hermes clients don't see them.</p>
        <form
          className="tag-new"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => store.createTag(name)).then((ok) => ok && setName(""));
          }}
        >
          <input ref={newBox} autoFocus aria-label="New tag name" placeholder="New tag" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn" type="submit">
            Add tag
          </button>
        </form>
        {error && (
          <p className="palette-panel-error" role="alert">
            {error}
          </p>
        )}
        {snap.tags.length === 0 ? (
          <p className="empty-hint">No tags yet. Add one, then tag chats from their right-click menu or from search results.</p>
        ) : (
          <ul className="tag-list" aria-label="Tags">
            {snap.tags.map((t) => {
              const n = count(t.id);
              const chats = `${n} chat${n === 1 ? "" : "s"}`;
              if (renaming?.id === t.id)
                return (
                  <li key={`${t.id}-rename`}>
                    <form
                      className="tag-row"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(() => store.renameTag(t.id, renaming.name)).then((ok) => ok && back(t.id));
                      }}
                    >
                      <input autoFocus aria-label={`New name for ${t.name}`} value={renaming.name} onChange={(e) => setRenaming({ id: t.id, name: e.target.value })} />
                      <button className="btn primary" type="submit">
                        Save
                      </button>
                      <button className="btn" type="button" onClick={() => (back(t.id), setError(undefined))}>
                        Cancel
                      </button>
                    </form>
                  </li>
                );
              if (deleting === t.id)
                return (
                  <li key={`${t.id}-delete`} className="tag-row" role="group" aria-label={`Delete ${t.name}?`}>
                    <span className="tag-confirm">
                      Delete "{t.name}"? It comes off {chats}. Saved filters that use it will say it was deleted.
                    </span>
                    <button className="btn danger" onClick={() => void run(() => store.deleteTag(t.id)).then((ok) => ok && back())}>
                      Delete
                    </button>
                    <button className="btn" autoFocus onClick={() => back(t.id)}>
                      Cancel
                    </button>
                  </li>
                );
              return (
                <li key={t.id} className="tag-row">
                  <span className="tag-label">
                    <TagIcon size={11} aria-hidden />
                    {t.name}
                  </span>
                  <span className="tag-count">{chats}</span>
                  <button className="row-action" data-tag={t.id} aria-label={`Rename ${t.name}`} title="Rename" onClick={() => (setDeleting(undefined), setRenaming({ id: t.id, name: t.name }))}>
                    <Pencil size={13} aria-hidden />
                  </button>
                  <button className="row-action" aria-label={`Delete ${t.name}`} title="Delete" onClick={() => (setRenaming(undefined), setDeleting(t.id))}>
                    <Trash2 size={13} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The list's Saved filters: each opens the search palette with its filter, run again. A Saved filter is a search, not
 * a group: it puts no chat anywhere, unlike a project. Deleting one asks first, in its row.
 */
export function SavedFilters({ filters, onOpen, onDelete }: { filters: SavedFilter[]; onOpen: (f: SavedFilter) => void; onDelete: (id: string) => unknown }) {
  const [deleting, setDeleting] = useState<string>();
  if (!filters.length) return null;
  return (
    <nav className="saved-filters" aria-label="Saved filters">
      <div className="section-label saved-filters-label" title="Saved searches. Opening one runs it again; it doesn't group chats the way a project does.">
        <ListFilter size={12} aria-hidden /> Saved filters
      </div>
      {filters.map((f) =>
        deleting === f.id ? (
          <div key={`${f.id}-delete`} className="row confirming" onKeyDown={(e) => e.key === "Escape" && setDeleting(undefined)}>
            <span className="row-title">{f.name}</span>
            <button className="row-confirm danger" onClick={() => (onDelete(f.id), setDeleting(undefined))}>
              Delete
            </button>
            <button className="row-confirm" autoFocus onClick={() => setDeleting(undefined)}>
              Cancel
            </button>
          </div>
        ) : (
          <div key={f.id} className="row">
            <button className="row-open" title={`Search with the saved filter "${f.name}"`} onClick={() => onOpen(f)}>
              <ListFilter size={13} className="saved-filter-icon" aria-hidden />
              <span className="row-title">{f.name}</span>
            </button>
            <button className="row-action" aria-label={`Delete saved filter ${f.name}`} title="Delete" onClick={() => setDeleting(f.id)}>
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        ),
      )}
    </nav>
  );
}
