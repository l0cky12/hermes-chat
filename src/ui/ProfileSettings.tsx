// Settings → Profiles (ADR 0156): every profile Hermes lists, made, cloned, renamed, described, given a model and
// deleted from one place. Switching stays in the chat list's header (ADR 0001): Open here goes through the same
// question and guard. Every word comes from the catalogue (ADR 0100).
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Brain, Copy, FolderOpen, MoreHorizontal, Pencil, Plus, Puzzle, RefreshCw, Sparkles, Trash2, TriangleAlert, Wand2 } from "lucide-react";
import type { CapabilityStore } from "../hermes/capabilities";
import type { CatalogProvider } from "../hermes/modelSettings";
import type { ProfileCloneApi } from "../hermes/profileClone";
import type { PendingRename } from "../hermes/profileLocalData";
import {
  DISPLAY_NAME_MAX,
  PROFILE_ROUTES,
  ProfileError,
  nameIssue,
  profileFailure,
  type ProfileAction,
  type ProfileFailure,
  type ProfileRow,
  type ProfilesApi,
} from "../hermes/profiles";
import { useLocale, type Locale } from "../i18n/locale";
import { Spinner, composing } from "./bits";
import { Menu } from "./ChatMenu";
import { CloneProfileDialog } from "./CloneProfile";
import { useModal } from "./modal";
import { SettingNote, SettingsSection } from "./SettingRows";

/** What keeps a profile from being renamed now: a reply running in it (`title`, when known), or a queue about to send. */
export type ProfileBusy = { kind: "reply"; title?: string } | { kind: "queue" };

/** What Settings → Profiles needs from the app. */
export type ProfilesWiring = {
  api: ProfilesApi;
  /** The Clone profile dialog's API (ADR 0074); without it there is no Clone. */
  clone?: ProfileCloneApi;
  /** What the connected Hermes lacks; a route found missing disables its action. */
  capabilities?: CapabilityStore;
  /** The profile the app shows. */
  inUse: string;
  connected: boolean;
  /** Unread chats in a profile not shown, as the switcher's last check found them. */
  unread: (name: string) => number | undefined;
  /** The models Settings → Model offers, for the model pickers. */
  catalog: () => Promise<CatalogProvider[]>;
  /** Whether work running in `name` keeps it from being renamed now. */
  busy: (name: string) => ProfileBusy | undefined;
  /** Queued and Failed messages holding text in `name`, which deleting it loses. */
  lostMessages: (name: string) => number;
  /** How many scheduled jobs `name` has; undefined when that couldn't be read. */
  jobCount: (name: string) => Promise<number | undefined>;
  /** What switching away from the profile in use leaves behind, asked about first, as the switcher does. */
  leaving?: string;
  /**
   * Switches the app to `name` through the switcher's own path: its guard asks about unsaved edits first. Resolves
   * false when the owner stayed. `keepSettings`: Settings stays open (a delete goes on after the switch).
   */
  switchTo: (name: string, keepSettings?: boolean) => Promise<boolean>;
  /** This computer's data for the profiles on this connection (profileLocalData.ts). */
  local: {
    /** A rename made on the server whose move here may not have finished. */
    pending: () => PendingRename | undefined;
    note: (from: string, to: string) => void;
    clear: () => void;
    /** Moves this computer's data from `from` to `to`; when `from` is in use, the app moves to `to` in place. */
    renamed: (from: string, to: string) => Promise<void>;
    /** Forgets this computer's data for `name`. */
    deleted: (name: string) => Promise<void>;
  };
  /** Shows Settings → Persona, Memory or Skills on `name`. */
  showTab: (tab: "persona" | "memory" | "skills", name: string) => void;
  copyText: (text: string) => Promise<void>;
};

/** How long a rename or delete runs before its button says the gateway is being stopped. */
const STOPPING_AFTER_MS = 1500;

/** A note the tab shows above the list after something happened. `open`: offer to open that profile. `command`: a command to copy. */
type Notice = { tone: "muted" | "warn" | "bad"; text: string; open?: string; command?: string };

type Dialog =
  | { kind: "new" }
  | { kind: "edit"; row: ProfileRow }
  | { kind: "delete"; row: ProfileRow }
  | { kind: "clone"; source: string };

const NO_STORE = { subscribe: () => () => {}, getSnapshot: () => undefined };

/** The words for a failed profile call. */
export function failureText(l: Locale, f: ProfileFailure, name: string): string {
  const w = l.profiles;
  switch (f.kind) {
    case "noRoute":
      return w.noRoute(PROFILE_ROUTES[f.action]);
    case "gone":
      return w.form.gone(name);
    case "refused":
      return w.form.refused(f.detail);
    case "lost":
      return w.form.lost(f.message);
    case "unsent":
      return f.message;
  }
}

/** Why `action` can't run now, or nothing: not connected, or the server lacks its route. */
function blocked(l: Locale, connected: boolean, lacks: (a: ProfileAction) => boolean, action: ProfileAction): string | undefined {
  if (!connected) return l.profiles.notConnected;
  if (lacks(action)) return l.profiles.noRoute(PROFILE_ROUTES[action]);
  return undefined;
}

/** A profile's name as shown: `default`'s display name first, when it has one. */
export const rowName = (l: Locale, p: Pick<ProfileRow, "name" | "displayName">) => (p.displayName && p.displayName !== p.name ? l.profiles.named(p.displayName, p.name) : p.name);

export function ProfileSettings({ wiring }: { wiring: ProfilesWiring }) {
  const l = useLocale();
  const w = l.profiles;
  const { api, connected, inUse } = wiring;
  // Drawn again when the server is found to lack a route.
  const store = wiring.capabilities ?? NO_STORE;
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [rows, setRows] = useState<ProfileRow[]>();
  const [listError, setListError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState(inUse);
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const [dialog, setDialog] = useState<Dialog>();
  const [notice, setNotice] = useState<Notice>();
  const [offer, setOffer] = useState<PendingRename>();
  const [menu, setMenu] = useState<{ row: ProfileRow; x: number; y: number }>();
  /** The switcher's question, while it's asked: on top of any dialog, which stays (a delete goes on after it). */
  const [ask, setAsk] = useState<{ to: string; answer: (go: boolean) => void }>();
  const listRef = useRef<HTMLDivElement>(null);
  /** The selected row, where each dialog puts focus back. */
  const selectedRow = useRef<HTMLDivElement>(null);
  /** Counts list reads: only the latest one's answer is shown, so an older read can't put back a row since changed. */
  const readGen = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);
  const lacking = (a: ProfileAction) => !!wiring.capabilities?.lacksAction("profiles", a);

  /** Reads the list. Resolves to the row selected after it, or undefined when a newer read or a failure took over. */
  const read = async (select?: string, edit?: string): Promise<string | undefined> => {
    const gen = ++readGen.current;
    setReading(true);
    try {
      const listed = await api.list();
      if (!live.current || gen !== readGen.current) return undefined;
      setRows(listed);
      setListError(undefined);
      const kept = (s: string) => (listed.some((p) => p.name === s) ? s : (listed.find((p) => p.name === inUse)?.name ?? listed[0]?.name ?? s));
      const next = select && listed.some((p) => p.name === select) ? select : kept(selectedNow.current);
      setSelected(next);
      const editing = edit && listed.find((p) => p.name === edit);
      if (editing) setDialog({ kind: "edit", row: editing });
      // A rename the app closed in the middle of: Hermes renamed it, but this computer's data may not have moved.
      const pending = wiring.local.pending();
      if (pending) {
        const from = listed.some((p) => p.name === pending.from);
        const to = listed.some((p) => p.name === pending.to);
        if (!from && to) setOffer(pending);
        else {
          wiring.local.clear();
          setOffer(undefined);
        }
      }
      return next;
    } catch (e) {
      if (live.current && gen === readGen.current) setListError(failureText(l, profileFailure(e, "create"), ""));
      return undefined;
    } finally {
      if (live.current && gen === readGen.current) setReading(false);
    }
  };
  useEffect(() => {
    if (connected) void read();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per connect; `read` is a new function every render
  }, [connected]);

  const focusRow = (name: string) => requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-profile="${CSS.escape(name)}"]`)?.focus());

  /** Switches to `name` through the switcher's question, then its guard. Resolves whether the app switched. */
  const switchTo = (name: string, keepSettings = false) =>
    new Promise<boolean>((done) => {
      const go = () => void wiring.switchTo(name, keepSettings).then(done, () => done(false));
      if (!wiring.leaving) return go();
      setAsk({
        to: name,
        answer: (yes) => {
          setAsk(undefined);
          if (yes) go();
          else done(false);
        },
      });
    });

  const moveDone = async (p: PendingRename) => {
    setOffer(undefined);
    try {
      await wiring.local.renamed(p.from, p.to);
      wiring.local.clear();
      setNotice({ tone: "muted", text: w.moved(p.to) });
    } catch {
      setNotice({ tone: "warn", text: w.movePartly(p.from, p.to) });
    }
  };

  const openMenu = (row: ProfileRow, x: number, y: number) => {
    setSelected(row.name);
    setMenu({ row, x, y });
  };
  const menuAt = (row: ProfileRow, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    openMenu(row, r.left + 24, r.bottom);
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows?.length || composing(e)) return;
    const at = rows.findIndex((p) => p.name === selected);
    const row = rows[at];
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
      setSelected(rows[next].name);
      focusRow(rows[next].name);
    } else if (!row) return;
    else if (e.key === "Enter") {
      e.preventDefault();
      setDialog({ kind: "edit", row });
    } else if (e.key === "Delete") {
      e.preventDefault();
      if (row.name !== "default" && connected && !lacking("remove")) setDialog({ kind: "delete", row });
    } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      const el = listRef.current?.querySelector<HTMLElement>(`[data-profile="${CSS.escape(row.name)}"]`);
      if (el) menuAt(row, el);
    }
  };

  const inUseGone = rows !== undefined && !rows.some((p) => p.name === inUse);
  const newBlocked = blocked(l, connected, lacking, "create");

  return (
    <>
      <SettingsSection
        title={w.title}
        intro={w.intro}
        more={<p>{w.more}</p>}
        action={
          <>
            <button className="btn" disabled={!!newBlocked} title={newBlocked} onClick={() => setDialog({ kind: "new" })}>
              <Plus size={14} aria-hidden /> {w.newProfile}
            </button>
            <button className="icon-btn" aria-label={w.refresh} title={w.refresh} disabled={!connected || reading} onClick={() => void read()}>
              {reading ? <Spinner /> : <RefreshCw size={14} aria-hidden />}
            </button>
          </>
        }
      >
        {!connected && rows && <SettingNote tone="warn">{w.stale}</SettingNote>}
        {listError && (
          <SettingNote tone="bad" role="alert">
            {listError}{" "}
            <button className="link-btn" disabled={!connected} onClick={() => void read()}>
              {w.tryAgain}
            </button>
          </SettingNote>
        )}
        {inUseGone && connected && (
          <SettingNote tone="warn" role="status">
            {w.inUseGone(inUse)}{" "}
            <button className="link-btn" onClick={() => void switchTo("default")}>
              {w.openDefault}
            </button>
          </SettingNote>
        )}
        {offer && (
          <SettingNote tone="warn" role="status">
            {w.moveOffer(offer.from, offer.to)}{" "}
            <button className="link-btn" onClick={() => void moveDone(offer)}>
              {w.move}
            </button>{" "}
            <button
              className="link-btn"
              onClick={() => {
                wiring.local.clear();
                setOffer(undefined);
              }}
            >
              {w.leave}
            </button>
          </SettingNote>
        )}
        {notice && (
          <SettingNote tone={notice.tone} role={notice.tone === "bad" ? "alert" : "status"}>
            {notice.text}
            {notice.command && (
              <>
                {" "}
                <code translate="no">{notice.command}</code> <CopyButton text={notice.command} copy={wiring.copyText} />
              </>
            )}
            {notice.open && (
              <>
                {" "}
                <button className="link-btn" onClick={() => void switchTo(notice.open!)}>
                  {w.openNow(notice.open)}
                </button>
              </>
            )}{" "}
            <button className="link-btn" onClick={() => setNotice(undefined)}>
              {w.dismiss}
            </button>
          </SettingNote>
        )}
        {!rows && !listError && (
          <div className="profile-rows" aria-busy="true" aria-label={w.loading}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="profile-row skeleton" aria-hidden />
            ))}
          </div>
        )}
        {rows && (
          <div
            ref={listRef}
            className={`profile-rows ${!connected ? "stale" : ""}`}
            role="listbox"
            aria-label={w.list}
            aria-describedby="profiles-keys"
            onKeyDown={onListKey}
          >
            {rows.map((row) => (
              <ProfileRowView
                key={row.name}
                row={row}
                selected={row.name === selected}
                rowRef={row.name === selected ? selectedRow : undefined}
                inUse={row.name === inUse}
                unread={row.name === inUse ? undefined : wiring.unread(row.name)}
                onSelect={() => setSelected(row.name)}
                onEdit={() => setDialog({ kind: "edit", row })}
                onMenu={(x, y) => openMenu(row, x, y)}
                onMenuButton={(el) => menuAt(row, el)}
              />
            ))}
          </div>
        )}
        <p id="profiles-keys" className="muted small profile-keys">
          {w.keys}
        </p>
      </SettingsSection>

      {menu && (
        <Menu label={w.actionsOf(menu.row.name)} x={menu.x} y={menu.y} onClose={() => setMenu(undefined)}>
          <MenuEntry
            icon={<FolderOpen size={15} />}
            label={w.menu.open}
            why={menu.row.name === inUse ? w.openInUse : !connected ? w.notConnected : undefined}
            onPick={() => {
              setMenu(undefined);
              void switchTo(menu.row.name);
            }}
          />
          <MenuEntry
            icon={<Pencil size={15} />}
            label={w.menu.edit}
            onPick={() => {
              setMenu(undefined);
              setDialog({ kind: "edit", row: menu.row });
            }}
          />
          {wiring.clone && (
            <MenuEntry
              icon={<Copy size={15} />}
              label={w.menu.clone}
              why={blocked(l, connected, lacking, "create")}
              onPick={() => {
                setMenu(undefined);
                setDialog({ kind: "clone", source: menu.row.name });
              }}
            />
          )}
          <div className="menu-sep" role="separator" />
          {(
            [
              ["persona", <Sparkles size={15} key="i" />, w.menu.persona],
              ["memory", <Brain size={15} key="i" />, w.menu.memory],
              ["skills", <Puzzle size={15} key="i" />, w.menu.skills],
            ] as const
          ).map(([tab, icon, label]) => (
            <MenuEntry
              key={tab}
              icon={icon}
              label={label}
              onPick={() => {
                setMenu(undefined);
                wiring.showTab(tab, menu.row.name);
              }}
            />
          ))}
          <div className="menu-sep" role="separator" />
          <MenuEntry
            icon={<Trash2 size={15} />}
            label={w.menu.delete}
            danger
            why={menu.row.name === "default" ? w.builtInKept : blocked(l, connected, lacking, "remove")}
            onPick={() => {
              setMenu(undefined);
              setDialog({ kind: "delete", row: menu.row });
            }}
          />
        </Menu>
      )}

      {(dialog?.kind === "new" || dialog?.kind === "edit") && (
        <ProfileForm
          wiring={wiring}
          row={dialog.kind === "edit" ? dialog.row : undefined}
          rows={rows ?? []}
          lacking={lacking}
          returnTo={selectedRow}
          onClone={wiring.clone && (() => setDialog({ kind: "clone", source: selected }))}
          onDone={(result) => {
            setDialog(undefined);
            setNotice(result.notice);
            void read(result.select, result.edit).then((now) => !result.edit && now && focusRow(now));
          }}
          // Closed without finishing: what saved meanwhile (Write for me, a field before one that failed) shows.
          onClose={() => {
            setDialog(undefined);
            void read();
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteProfile
          wiring={wiring}
          row={dialog.row}
          returnTo={selectedRow}
          switchAway={() => switchTo("default", true)}
          onDone={(n) => {
            setDialog(undefined);
            setNotice(n);
            // The deleted row is gone: focus goes to the row the list selects now.
            void read().then((now) => now && focusRow(now));
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "clone" && wiring.clone && (
        <CloneProfileDialog
          api={wiring.clone}
          current={dialog.source}
          returnTo={selectedRow}
          onClose={() => {
            setDialog(undefined);
            void read();
          }}
          onMade={(name) => void read(name)}
          onOpen={(name) => {
            setDialog(undefined);
            void switchTo(name);
          }}
        />
      )}
      {ask && <SwitchQuestion to={ask.to} note={wiring.leaving ?? ""} onStay={() => ask.answer(false)} onGo={() => ask.answer(true)} />}
    </>
  );
}

function MenuEntry({ icon, label, why, danger, onPick }: { icon: ReactNode; label: string; why?: string; danger?: boolean; onPick: () => void }) {
  const id = useId();
  return (
    <>
      <button
        role="menuitem"
        className={`menu-item ${danger ? "danger" : ""}`}
        aria-disabled={why ? true : undefined}
        aria-describedby={why ? id : undefined}
        title={why}
        onClick={() => !why && onPick()}
      >
        <span className="menu-icon">{icon}</span>
        <span className="menu-label">{label}</span>
      </button>
      {why && (
        <div id={id} className="menu-note">
          {why}
        </div>
      )}
    </>
  );
}

function CopyButton({ text, copy }: { text: string; copy: (text: string) => Promise<void> }) {
  const l = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <button className="link-btn" onClick={() => void copy(text).then(() => setCopied(true), () => {})}>
      {copied ? l.profiles.del.copied : l.profiles.del.copy}
    </button>
  );
}

/** One profile in the list: its name and badges, its model and skills, and its description. */
function ProfileRowView({
  row,
  rowRef,
  selected,
  inUse,
  unread,
  onSelect,
  onEdit,
  onMenu,
  onMenuButton,
}: {
  row: ProfileRow;
  rowRef?: RefObject<HTMLDivElement | null>;
  selected: boolean;
  inUse: boolean;
  unread?: number;
  onSelect: () => void;
  onEdit: () => void;
  onMenu: (x: number, y: number) => void;
  onMenuButton: (el: HTMLElement) => void;
}) {
  const l = useLocale();
  const w = l.profiles;
  const more = useRef<HTMLButtonElement>(null);
  return (
    <div
      ref={rowRef}
      className={`profile-row ${selected ? "on" : ""}`}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-profile={row.name}
      onClick={onSelect}
      onFocus={onSelect}
      onDoubleClick={onEdit}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <div className="profile-row-head">
        <span className="profile-row-name">
          {row.displayName && row.displayName !== row.name ? (
            <>
              <span translate="no">{row.displayName}</span> <span className="mono muted" translate="no">({row.name})</span>
            </>
          ) : (
            <span className="mono" translate="no">
              {row.name}
            </span>
          )}
        </span>
        {inUse && <span className="badge ok">{w.inUse}</span>}
        {row.isDefault && <span className="badge">{w.builtIn}</span>}
        {row.gatewayRunning && <span className="badge">{w.gateway}</span>}
        {!!unread && <span className="badge warn">{w.unread(unread)}</span>}
        {row.distribution && <span className="badge">{w.distribution(row.distribution)}</span>}
      </div>
      <div className="profile-row-facts muted small">
        <span>{row.model && row.provider ? w.model(row.model, row.provider) : w.noModel}</span>
        {row.skillCount !== undefined && <span>{w.skills(row.skillCount)}</span>}
      </div>
      <div className="profile-row-foot">
        <span className={`profile-row-desc small ${row.description ? "" : "muted"}`}>
          {row.description ? <span translate="no">{row.description}</span> : w.noDescription}
          {row.description && row.descriptionAuto && (
            <span className="badge profile-auto" title={w.autoTitle}>
              {w.auto}
            </span>
          )}
        </span>
        <span className="profile-row-actions">
          <button
            className="btn"
            tabIndex={-1}
            aria-label={w.editOf(row.name)}
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <Pencil size={13} aria-hidden /> {w.edit}
          </button>
          <button
            ref={more}
            className="icon-btn"
            tabIndex={-1}
            aria-label={w.actionsOf(row.name)}
            title={w.actionsOf(row.name)}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              onMenuButton(more.current!);
            }}
          >
            <MoreHorizontal size={15} aria-hidden />
          </button>
        </span>
      </div>
    </div>
  );
}

/** The switcher's question before switching while something is left behind (Sidebar.tsx `LeaveProfile`). Stay has focus. */
function SwitchQuestion({ to, note, onStay, onGo }: { to: string; note: string; onStay: () => void; onGo: () => void }) {
  const l = useLocale();
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const noteId = useId();
  const titleId = useId();
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onStay()}>
      <div
        ref={box}
        className="leave-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={noteId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e)) onStay();
        }}
      >
        <h2 id={titleId} className="leave-title">
          {l.profiles.leaving.title(to)}
        </h2>
        <p id={noteId} className="muted">
          {note}
        </p>
        <div className="confirm-actions">
          <button className="btn" autoFocus onClick={onStay}>
            {l.profiles.leaving.stay}
          </button>
          <button className="btn primary" onClick={onGo}>
            {l.profiles.leaving.go}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A field's state after Save: saved, or why not. */
type FieldState = { kind: "saved" } | { kind: "failed"; text: string };

/** The model pickers: a provider from Settings → Model's catalogue, then one of its models or any typed. */
function ModelPicker({
  catalog,
  provider,
  model,
  onChange,
  optional,
  labelId,
  disabled,
}: {
  disabled?: boolean;
  catalog?: CatalogProvider[];
  provider: string;
  model: string;
  onChange: (provider: string, model: string) => void;
  optional: boolean;
  labelId: string;
}) {
  const l = useLocale();
  const f = l.profiles.form;
  const listId = useId();
  const providers = catalog ?? [];
  const known = providers.some((p) => p.slug === provider);
  const models = providers.find((p) => p.slug === provider)?.models ?? [];
  return (
    <div className="profile-model" role="group" aria-labelledby={labelId}>
      <select aria-label={f.provider} value={provider} disabled={disabled} onChange={(e) => onChange(e.target.value, "")}>
        {optional && <option value="">{f.noProvider}</option>}
        {provider && !known && (
          <option value={provider} translate="no">
            {provider}
          </option>
        )}
        {providers.map((p) => (
          <option key={p.slug} value={p.slug} translate="no">
            {p.name}
          </option>
        ))}
      </select>
      <input aria-label={f.modelName} list={listId} className="mono" value={model} disabled={!provider || disabled} onChange={(e) => onChange(provider, e.target.value)} />
      <datalist id={listId}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}

/** What a finished form tells the tab: what to say, which row to select, and a profile to edit next. */
type FormResult = { notice?: Notice; select?: string; edit?: string };

/**
 * New profile and Edit, one modal. New makes a blank profile in one create. Edit saves each changed field through its
 * own route, in order: description, model, then the name, so the earlier calls still use the old name. A failed field
 * keeps the dialog open, marked with Hermes's words; the fields that saved stay saved.
 */
function ProfileForm({
  wiring,
  row,
  rows,
  lacking,
  returnTo,
  onClone,
  onDone,
  onClose,
}: {
  wiring: ProfilesWiring;
  row?: ProfileRow;
  rows: readonly ProfileRow[];
  lacking: (a: ProfileAction) => boolean;
  returnTo: RefObject<HTMLElement | null>;
  onClone?: () => void;
  onDone: (result: FormResult) => void;
  onClose: () => void;
}) {
  const l = useLocale();
  const w = l.profiles;
  const f = w.form;
  const { api, connected } = wiring;
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const nameId = useId();
  const nameNote = useId();
  const descId = useId();
  const modelId = useId();
  const soulId = useId();
  const isDefault = row?.name === "default";
  // What the form started from; a field equal to it isn't sent.
  const [base, setBase] = useState({
    name: row ? (isDefault ? (row.displayName ?? "") : row.name) : "",
    description: row?.description ?? "",
    provider: row?.provider ?? "",
    model: row?.model ?? "",
  });
  const [name, setName] = useState(base.name);
  const [description, setDescription] = useState(base.description);
  const [provider, setProvider] = useState(base.provider);
  const [model, setModel] = useState(base.model);
  const [soul, setSoul] = useState("");
  const [catalog, setCatalog] = useState<CatalogProvider[]>();
  const [catalogError, setCatalogError] = useState<string>();
  const [states, setStates] = useState<Partial<Record<"name" | "description" | "model" | "create", FieldState>>>({});
  const [saving, setSaving] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [writing, setWriting] = useState(false);
  const [writeNote, setWriteNote] = useState<{ tone: "muted" | "bad"; text: string }>();
  /** Asked before leaving with unsaved changes: `then` is where leaving goes (the persona link), else the dialog closes. */
  const [asking, setAsking] = useState<{ then?: () => void }>();
  const [madeNoModel, setMadeNoModel] = useState<{ name: string; error: string }>();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    wiring.catalog().then(
      (c) => live.current && setCatalog(c),
      (e: unknown) => live.current && setCatalogError(f.catalogFailed(e instanceof Error ? e.message : String(e))),
    );
    return () => void (live.current = false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the catalogue is read once, when the dialog opens
  }, []);

  const trimmed = name.trim();
  const nameChanged = trimmed !== base.name;
  const descChanged = description.trim() !== base.description.trim();
  const modelChanged = (provider !== base.provider || model.trim() !== base.model) && !!provider && !!model.trim();
  const dirty = (row ? nameChanged : !!trimmed) || descChanged || (provider !== base.provider || model.trim() !== base.model) || !!soul.trim();

  const issue = isDefault
    ? !trimmed
      ? f.displayEmpty
      : trimmed.length > DISPLAY_NAME_MAX
        ? f.displayLong(DISPLAY_NAME_MAX)
        : undefined
    : (() => {
        if (row && !nameChanged) return undefined;
        const i = nameIssue(trimmed, rows, row?.name);
        return i === undefined ? undefined : i === "empty" ? f.issues.empty : i === "invalid" ? f.issues.invalid : f.issues[i](trimmed);
      })();
  const busy = row && nameChanged && !isDefault ? wiring.busy(row.name) : undefined;
  const busyText = busy ? (busy.kind === "queue" ? f.busyQueue : busy.title ? f.busyReply(busy.title) : f.busyReplyHere) : undefined;
  const why = (a: ProfileAction) => blocked(l, connected, lacking, a);
  const renameWhy = row && nameChanged ? why("rename") : undefined;
  const descWhy = descChanged ? (row ? why("describe") : undefined) : undefined;
  const modelWhy = row && modelChanged ? why("setModel") : undefined;
  const createWhy = row ? undefined : why("create");
  const saveWhy = createWhy ?? (!connected ? w.notConnected : undefined) ?? (issue && (row ? nameChanged : true) ? issue : undefined) ?? busyText ?? renameWhy ?? descWhy ?? modelWhy;
  const nothing = row && !nameChanged && !descChanged && !modelChanged;

  /** Leaves the dialog, asking first when it holds changes; never while a save or Write for me runs. */
  const leave = (then?: () => void) => {
    if (saving || writing) return;
    if (dirty) setAsking({ then });
    else (then ?? onClose)();
  };
  const close = () => leave();

  const writeForMe = async () => {
    if (!row) return;
    setWriting(true);
    setWriteNote(undefined);
    try {
      const out = await api.describeAuto(row.name);
      if (!live.current) return;
      if (out.ok) {
        setDescription(out.description);
        // Hermes saved it, as its own; the form starts from it now.
        setBase((b) => ({ ...b, description: out.description }));
        setWriteNote({ tone: "muted", text: f.writeSaved });
      } else setWriteNote({ tone: "bad", text: f.writeFailed(out.reason) });
    } catch (e) {
      if (live.current) setWriteNote({ tone: "bad", text: failureText(l, profileFailure(e, "describeAuto"), row.name) });
    } finally {
      if (live.current) setWriting(false);
    }
  };

  const create = async () => {
    setSaving(true);
    setStates({});
    try {
      const made = await api.create({
        name: trimmed,
        description,
        ...(provider && model.trim() && { provider, model: model.trim() }),
        ...(soul.trim() && { soul }),
      });
      if (!live.current) return;
      if (!made.modelSet && provider && model.trim() && made.answered) {
        setMadeNoModel({ name: made.name, error: made.modelError ?? f.modelNotSetWhy });
        setSaving(false);
        return;
      }
      onDone({ notice: { tone: "muted", text: made.answered ? w.created(made.name) : w.createdUnanswered(made.name), open: made.name }, select: made.name });
    } catch (e) {
      if (!live.current) return;
      const failure = profileFailure(e, "create");
      setStates({ create: { kind: "failed", text: failure.kind === "refused" ? failure.detail : failureText(l, failure, trimmed) } });
      setSaving(false);
    }
  };

  const save = async () => {
    if (!row) return;
    setSaving(true);
    const next: typeof states = {};
    const show = () => live.current && setStates({ ...next });
    let failed = false;
    const fail = (key: "name" | "description" | "model", e: unknown, action: ProfileAction) => {
      next[key] = { kind: "failed", text: failureText(l, profileFailure(e, action), row.name) };
      failed = true;
      show();
    };
    if (descChanged)
      try {
        const kept = await api.describe(row.name, description);
        next.description = { kind: "saved" };
        setBase((b) => ({ ...b, description: kept }));
        show();
      } catch (e) {
        fail("description", e, "describe");
      }
    if (modelChanged)
      try {
        await api.setModel(row.name, provider, model.trim());
        next.model = { kind: "saved" };
        setBase((b) => ({ ...b, provider, model: model.trim() }));
        show();
      } catch (e) {
        fail("model", e, "setModel");
      }
    let renamedTo: string | undefined;
    let localFailed = false;
    if (nameChanged && !failed) {
      const from = row.name;
      const timer = row.gatewayRunning ? setTimeout(() => live.current && setStopping(true), STOPPING_AFTER_MS) : undefined;
      if (!isDefault) wiring.local.note(from, trimmed);
      try {
        const done = await api.rename(from, trimmed);
        if (!isDefault) {
          renamedTo = done.name;
          try {
            await wiring.local.renamed(from, done.name);
            wiring.local.clear();
          } catch {
            // Hermes renamed it; what didn't move here stays noted, and the tab offers the move again.
            localFailed = true;
          }
        }
        next.name = { kind: "saved" };
        setBase((b) => ({ ...b, name: isDefault ? (done.displayName ?? trimmed) : done.name }));
        show();
      } catch (e) {
        const failure = profileFailure(e, "rename");
        // Refused or never sent: nothing moved. A lost answer stays noted, so the next list read can offer the move.
        if (!isDefault && failure.kind !== "lost") wiring.local.clear();
        fail("name", e, "rename");
      } finally {
        clearTimeout(timer);
        if (live.current) setStopping(false);
      }
    }
    if (!live.current) return;
    setSaving(false);
    if (!failed)
      onDone({
        notice: localFailed && renamedTo
          ? { tone: "warn", text: w.movePartly(row.name, renamedTo) }
          : { tone: "muted", text: renamedTo ? w.renamed(row.name, renamedTo) : w.saved(row.name) },
        select: renamedTo ?? row.name,
      });
  };

  const stateNote = (s?: FieldState) =>
    s && (
      <div className={`small ${s.kind === "failed" ? "sign-in-error" : "muted"}`} role={s.kind === "failed" ? "alert" : undefined}>
        {s.kind === "saved" ? f.fieldSaved : s.text}
      </div>
    );

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e)) {
            e.preventDefault();
            if (asking) setAsking(undefined);
            else close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          {row ? f.editTitle(rowName(l, row)) : f.newTitle}
        </h2>
        {madeNoModel ? (
          <>
            <p role="alert">{f.modelNotSet(madeNoModel.error)}</p>
            <div className="confirm-actions">
              <button
                className="btn"
                autoFocus
                onClick={() => onDone({ notice: { tone: "warn", text: f.modelNotSet(madeNoModel.error), open: madeNoModel.name }, select: madeNoModel.name })}
              >
                {w.dismiss}
              </button>
              <button className="btn primary" onClick={() => onDone({ select: madeNoModel.name, edit: madeNoModel.name })}>
                {f.setModel}
              </button>
            </div>
          </>
        ) : asking ? (
          <>
            <p className="muted">{f.leaveNote}</p>
            <div className="confirm-actions">
              <button className="btn" autoFocus onClick={() => setAsking(undefined)}>
                {f.keepEditing}
              </button>
              <button className="btn danger" onClick={asking.then ?? onClose}>
                {f.discard}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label className="field-label" htmlFor={nameId}>
                {isDefault ? f.displayName : f.name}
              </label>
              <input
                id={nameId}
                className={isDefault ? undefined : "mono"}
                autoFocus
                value={name}
                readOnly={saving}
                maxLength={isDefault ? DISPLAY_NAME_MAX + 10 : 70}
                aria-invalid={!!issue && (row ? nameChanged : !!name)}
                aria-describedby={nameNote}
                onChange={(e) => setName(e.target.value)}
              />
              <div id={nameNote} className="set-hint">
                {issue && (row ? nameChanged : !!name) ? <span className="sign-in-error">{issue}</span> : isDefault ? f.displayHint : f.nameHint}
              </div>
              {row?.gatewayRunning && !isDefault && nameChanged && (
                <SettingNote tone="warn">
                  <TriangleAlert size={12} aria-hidden /> {f.gatewayWarn}
                </SettingNote>
              )}
              {busyText && <SettingNote tone="warn">{busyText}</SettingNote>}
              {renameWhy && !states.name && <SettingNote tone="warn">{renameWhy}</SettingNote>}
              {stateNote(states.name)}
            </div>
            <div className="field">
              <div className="field-label">
                <label htmlFor={descId}>{row ? f.description : f.descriptionOptional}</label>
                {row && (
                  <button className="btn profile-write" disabled={writing || saving || !!why("describeAuto")} title={why("describeAuto")} onClick={() => void writeForMe()}>
                    {writing ? <Spinner /> : <Wand2 size={13} aria-hidden />} {f.writeForMe}
                  </button>
                )}
              </div>
              <input id={descId} value={description} onChange={(e) => setDescription(e.target.value)} disabled={writing || saving} />
              {writing && <div className="small muted">{f.writing}</div>}
              {writeNote && (
                <div className={`small ${writeNote.tone === "bad" ? "sign-in-error" : "muted"}`} role={writeNote.tone === "bad" ? "alert" : "status"}>
                  {writeNote.text}
                </div>
              )}
              {stateNote(states.description)}
            </div>
            <div className="field">
              <span className="field-label" id={modelId}>
                {row ? f.model : f.modelOptional}
              </span>
              <ModelPicker
                disabled={saving || writing}
                catalog={catalog}
                provider={provider}
                model={model}
                optional={!row || !base.provider}
                labelId={modelId}
                onChange={(p, m) => {
                  setProvider(p);
                  setModel(m);
                }}
              />
              {catalogError && <div className="small muted">{catalogError}</div>}
              {stateNote(states.model)}
            </div>
            {row ? (
              <div className="field">
                <span className="field-label">{w.menu.persona}</span>
                <button
                  className="link-btn profile-persona-link"
                  disabled={saving || writing}
                  onClick={() =>
                    leave(() => {
                      onClose();
                      wiring.showTab("persona", row.name);
                    })
                  }
                >
                  {f.personaLink}
                </button>
              </div>
            ) : (
              <div className="field">
                <label className="field-label" htmlFor={soulId}>
                  {f.persona}
                </label>
                <textarea id={soulId} className="persona-text profile-soul" rows={4} readOnly={saving} placeholder={f.personaDefault} value={soul} onChange={(e) => setSoul(e.target.value)} />
                <div className="set-hint">{f.personaHint}</div>
              </div>
            )}
            {!row && <SettingNote>{f.keysNote}</SettingNote>}
            {stateNote(states.create)}
            {!row && onClone && (
              <button className="link-btn profile-clone-link" disabled={saving} onClick={() => leave(onClone)}>
                {f.cloneInstead}
              </button>
            )}
            <div className="confirm-actions">
              <button className="btn" onClick={close} disabled={saving || writing}>
                {l.common.cancel}
              </button>
              <button
                className="btn primary"
                disabled={saving || writing || !!saveWhy || (!!row && nothing)}
                title={saveWhy ?? (row && nothing ? f.nothingChanged : undefined)}
                onClick={() => void (row ? save() : create())}
              >
                {saving && <Spinner />} {stopping ? f.stopping : saving ? (row ? f.saving : f.creating) : row ? f.save : f.create}
              </button>
            </div>
            {saveWhy && !saving && saveWhy !== issue && saveWhy !== busyText && saveWhy !== renameWhy && (
              <div className="small muted profile-save-why" role="status">
                {saveWhy}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The question before deleting a profile: what goes on the server and on this computer, the counts the app could
 * read, and the profile's name typed to confirm. Deleting the profile in use switches to `default` first, through the
 * switcher's own question and guard; staying deletes nothing.
 */
function DeleteProfile({
  wiring,
  row,
  returnTo,
  switchAway,
  onDone,
  onClose,
}: {
  wiring: ProfilesWiring;
  row: ProfileRow;
  returnTo: RefObject<HTMLElement | null>;
  switchAway: () => Promise<boolean>;
  onDone: (notice: Notice) => void;
  onClose: () => void;
}) {
  const l = useLocale();
  const d = l.profiles.del;
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const noteId = useId();
  const typedId = useId();
  const [typed, setTyped] = useState("");
  const [counts, setCounts] = useState<{ chats?: number; jobs?: number }>({});
  const [phase, setPhase] = useState<"ask" | "switching" | "deleting" | "stopping">("ask");
  const [problem, setProblem] = useState<string>();
  const inUse = row.name === wiring.inUse;
  const lost = wiring.lostMessages(row.name);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void wiring.api.chatCount(row.name).then((chats) => live.current && setCounts((c) => ({ ...c, chats })));
    void wiring.jobCount(row.name).then(
      (jobs) => live.current && setCounts((c) => ({ ...c, jobs })),
      () => {},
    );
    return () => void (live.current = false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- counted once, when the dialog opens on its row
  }, []);

  const go = async () => {
    setProblem(undefined);
    if (inUse) {
      setPhase("switching");
      const switched = await switchAway();
      if (!live.current) return;
      if (!switched) {
        setPhase("ask");
        setProblem(d.stayed);
        return;
      }
    }
    setPhase("deleting");
    const timer = row.gatewayRunning ? setTimeout(() => live.current && setPhase("stopping"), STOPPING_AFTER_MS) : undefined;
    try {
      const out = await wiring.api.remove(row.name);
      const forgot = await wiring.local.deleted(row.name).then(
        () => true,
        () => false,
      );
      if (!forgot) return onDone({ tone: "warn", text: d.forgetPartly(row.name) });
      onDone(
        out.kind === "settling"
          ? out.retryCommand
            ? { tone: "warn", text: d.settling(row.name), command: out.retryCommand }
            : { tone: "warn", text: d.settlingNoCommand(row.name) }
          : out.kind === "alreadyGone"
            ? { tone: "muted", text: d.alreadyGone(row.name) }
            : { tone: "muted", text: d.deleted(row.name) },
      );
    } catch (e) {
      if (!live.current) return;
      setProblem(d.failed(failureText(l, e instanceof ProfileError ? e.failure : profileFailure(e, "remove"), row.name)));
      setPhase("ask");
    } finally {
      clearTimeout(timer);
    }
  };

  const busy = phase !== "ask";
  const matches = typed.trim() === row.name;
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={box}
        className="leave-dialog profile-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={noteId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e) && !busy) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <TriangleAlert size={14} aria-hidden /> {d.title(row.name)}
        </h2>
        <div id={noteId}>
          <p>{d.server}</p>
          <ul className="profile-delete-list">
            <li>{counts.chats !== undefined ? d.chatsCount(counts.chats) : d.chats}</li>
            <li>{row.skillCount !== undefined ? d.partsCount(row.skillCount) : d.parts}</li>
            <li>{d.keys}</li>
            <li>{counts.jobs !== undefined ? d.jobsCount(counts.jobs) : d.jobs}</li>
          </ul>
          {row.gatewayRunning && <p>{d.gateway}</p>}
          <p>{d.local}</p>
          {lost > 0 && <SettingNote tone="warn">{d.lost(lost)}</SettingNote>}
          {inUse && <SettingNote tone="warn">{d.inUse}</SettingNote>}
          <p className="muted">{d.noUndo}</p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={typedId}>
            {d.confirmLabel(row.name)}
          </label>
          <input id={typedId} className="mono" autoFocus value={typed} disabled={busy} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !composing(e) && matches && !busy && void go()} />
        </div>
        {problem && (
          <p className="sign-in-error" role="alert">
            {problem}
          </p>
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            {l.common.cancel}
          </button>
          <button className="btn danger" disabled={!matches || busy || !wiring.connected} title={!wiring.connected ? l.profiles.notConnected : undefined} onClick={() => void go()}>
            {busy && <Spinner />} {phase === "switching" ? d.switching : phase === "stopping" ? l.profiles.form.stopping : phase === "deleting" ? d.deleting : d.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
