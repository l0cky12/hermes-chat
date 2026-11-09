// Settings, Appearance: the color scheme, the themes (built-in and the owner's own), contrast, and chat width. A theme
// is four colors per mode (themes.ts); the editor shows a small copy of the app in both modes as the colors change.
import { useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Check, Copy, Moon, Paintbrush, Pencil, Plus, RotateCcw, Sun, Trash2 } from "lucide-react";
import { useLocale } from "../i18n/locale";
import { CHAT_WIDTHS, DEFAULT_APPEARANCE, MAX_CUSTOM_THEMES, themeOf, type Appearance, type AppearanceStore } from "./appearance";
import { arrowSelect } from "./bits";
import { SettingRow, SettingsSection } from "./SettingRows";
import {
  BUILTIN_THEMES,
  PALETTE_KEYS,
  MAX_THEME_NAME,
  freeName,
  isHex,
  mix,
  newThemeId,
  readThemeJson,
  themeJson,
  themeVars,
  type Mode,
  type Palette,
  type Scheme,
  type Theme,
} from "./themes";

/** A small drawing of the app in one palette: the list panel, a reply, a message, the composer with its send dot. */
export function MiniApp({ palette, mode, contrast, className = "" }: { palette: Palette; mode: Mode; contrast: number; className?: string }) {
  return (
    <div className={`mini ${className}`} style={themeVars(palette, mode, contrast) as CSSProperties} aria-hidden>
      <div className="mini-side">
        <span className="mini-pill" />
        <span className="mini-row on" />
        <span className="mini-row" />
        <span className="mini-row" />
      </div>
      <div className="mini-main">
        <span className="mini-bubble" />
        <span className="mini-line" />
        <span className="mini-line short" />
        <div className="mini-composer">
          <span className="mini-line short" />
          <span className="mini-send" />
        </div>
      </div>
    </div>
  );
}

/** The light and dark versions of a theme as two lit spheres. */
const orb = (p: Palette, mode: Mode): CSSProperties => ({
  background: `radial-gradient(circle at 32% 28%, ${mix(p.accent, mode === "light" ? "#ffffff" : p.text, 0.75)} 0%, ${p.accent} 42%, ${mix(p.accent, p.background, 0.75)} 78%, ${p.background} 100%)`,
});

const SCHEMES: Scheme[] = ["system", "light", "dark"];

function SchemePicker({ a, set }: { a: Appearance; set: (c: Partial<Appearance>) => void }) {
  const t = useLocale().appearance.scheme;
  const theme = themeOf(a);
  return (
    <div className="scheme-grid" role="radiogroup" aria-label={t.title} onKeyDown={(e) => arrowSelect(e, SCHEMES, a.scheme, (scheme) => set({ scheme }))}>
      {SCHEMES.map((id) => (
        <button
          key={id}
          className={`scheme-card ${a.scheme === id ? "on" : ""}`}
          role="radio"
          aria-checked={a.scheme === id}
          tabIndex={a.scheme === id ? 0 : -1}
          onClick={() => set({ scheme: id })}
        >
          {id === "system" ? (
            <div className="mini-split">
              <MiniApp palette={theme.light} mode="light" contrast={a.contrast} />
              <MiniApp palette={theme.dark} mode="dark" contrast={a.contrast} className="mini-right" />
            </div>
          ) : (
            <MiniApp palette={theme[id]} mode={id} contrast={a.contrast} />
          )}
          <span className="scheme-label">{t[id]}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A theme being made or changed. `id` is the custom theme it replaces; a new one has none. `session` tells one opening
 * of the editor from the next, so starting another draft starts afresh.
 */
type Draft = { id?: string; session: number; name: string; light: Palette; dark: Palette };

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const t = useLocale().appearance.editor;
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    setText(value);
  }
  const typed = (s: string) => {
    setText(s);
    const hex = s.startsWith("#") ? s : `#${s}`;
    if (isHex(hex)) onChange(hex.toLowerCase());
  };
  return (
    <label className="color-field">
      <span className="color-name">{label}</span>
      <input type="color" value={value} aria-label={t.color(label)} onChange={(e) => onChange(e.target.value)} />
      <input
        className="color-hex mono"
        value={text}
        aria-label={t.hex(label)}
        spellCheck={false}
        maxLength={7}
        aria-invalid={!isHex(text.startsWith("#") ? text : `#${text}`)}
        onChange={(e) => typed(e.target.value.trim())}
        onBlur={() => setText(value)}
      />
    </label>
  );
}

function ThemeEditor({
  draft: initial,
  contrast,
  taken,
  onSave,
  onCancel,
}: {
  draft: Draft;
  contrast: number;
  /** Names other themes have. */
  taken: string[];
  onSave: (t: Draft) => void;
  onCancel: () => void;
}) {
  const l = useLocale();
  const t = l.appearance.editor;
  const [draft, setDraft] = useState(initial);
  const [copied, setCopied] = useState(false);
  const name = draft.name.trim();
  const clash = taken.includes(name);
  const color = (mode: Mode, key: keyof Palette, hex: string) => setDraft((d) => ({ ...d, [mode]: { ...d[mode], [key]: hex } }));
  return (
    <div className="theme-editor" role="group" aria-label={initial.id ? l.appearance.themes.edit(initial.name) : t.new}>
      <div className="theme-editor-head">
        <input
          className="theme-name"
          aria-label={t.name}
          placeholder={t.name}
          value={draft.name}
          maxLength={MAX_THEME_NAME}
          autoFocus
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <button
          className="btn"
          title={t.copyTitle}
          onClick={() => {
            void navigator.clipboard?.writeText(themeJson({ id: "", ...draft, name: name || t.untitled }));
            setCopied(true);
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t.copied : t.copy}
        </button>
      </div>
      <div className="theme-editor-modes">
        {(["light", "dark"] as const).map((mode) => (
          <div key={mode} className="theme-editor-mode">
            <div className="theme-editor-title">
              {mode === "light" ? <Sun size={13} /> : <Moon size={13} />} {l.appearance.scheme[mode]}
            </div>
            <MiniApp palette={draft[mode]} mode={mode} contrast={contrast} className="mini-large" />
            <div className="color-fields">
              {PALETTE_KEYS.map((key) => (
                <ColorField key={key} label={t.colors[key]} value={draft[mode][key]} onChange={(hex) => color(mode, key, hex)} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="muted small theme-editor-hint">{t.hint}</p>
      <div className="theme-editor-actions">
        {clash && <span className="small sign-in-error">{t.taken}</span>}
        <button className="btn" onClick={onCancel}>
          {l.common.cancel}
        </button>
        <button className="btn primary" disabled={!name || clash} onClick={() => onSave({ ...draft, name })}>
          {initial.id ? t.save : t.create}
        </button>
      </div>
    </div>
  );
}

function ImportTheme({ onImport, onCancel }: { onImport: (t: Theme) => void; onCancel: () => void }) {
  const l = useLocale();
  const t = l.appearance.import;
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  return (
    <div className="theme-editor" role="group" aria-label={t.group}>
      <div className="theme-editor-title">{t.title}</div>
      <textarea
        className="theme-json mono"
        aria-label={t.json}
        rows={8}
        spellCheck={false}
        autoFocus
        value={text}
        placeholder={t.placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setError(undefined);
        }}
      />
      <div className="theme-editor-actions">
        {error && (
          <span className="small sign-in-error" role="alert">
            {error}
          </span>
        )}
        <button className="btn" onClick={onCancel}>
          {l.common.cancel}
        </button>
        <button
          className="btn primary"
          disabled={!text.trim()}
          onClick={() => {
            const read = readThemeJson(text, newThemeId);
            if (typeof read === "string") setError(t[read]);
            else onImport(read);
          }}
        >
          {t.add}
        </button>
      </div>
    </div>
  );
}

function ThemeCard({
  theme,
  selected,
  mode,
  custom,
  canDuplicate,
  onPick,
  onDuplicate,
  onEdit,
  onDelete,
}: {
  theme: Theme;
  selected: boolean;
  /** The mode showing, ringed on the selected theme. */
  mode: Mode;
  custom: boolean;
  /** False once the owner has as many themes as are kept. */
  canDuplicate: boolean;
  onPick: (mode?: Mode) => void;
  onDuplicate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const l = useLocale();
  const t = l.appearance.themes;
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={`theme-card ${selected ? "on" : ""}`}>
      <button className="theme-pick" aria-pressed={selected} aria-label={t.use(theme.name)} onClick={() => onPick()} />
      <div className="theme-orbs">
        {(["light", "dark"] as const).map((m) => (
          <button
            key={m}
            className={`theme-orb ${selected && mode === m ? "on" : ""}`}
            style={orb(theme[m], m)}
            aria-label={t.useIn(theme.name, t.modes[m])}
            title={t.inMode(theme.name, t.modes[m])}
            onClick={() => onPick(m)}
          >
            {selected && mode === m && <span className="theme-orb-mode">{m === "light" ? <Sun size={11} /> : <Moon size={11} />}</span>}
          </button>
        ))}
      </div>
      <div className="theme-foot">
        {confirming ? (
          <>
            <span className="theme-name-label small">{t.confirmDelete(theme.name)}</span>
            <button className="row-confirm" onClick={() => setConfirming(false)}>
              {l.common.cancel}
            </button>
            <button className="row-confirm danger" onClick={onDelete}>
              {t.confirm}
            </button>
          </>
        ) : (
          <>
            <span className="theme-name-label" translate="no">
              {theme.name}
            </span>
            {custom && (
              <>
                <button className="icon-btn small-icon" aria-label={t.edit(theme.name)} title={t.editTitle} onClick={onEdit}>
                  <Pencil size={13} />
                </button>
                <button className="icon-btn small-icon" aria-label={t.delete(theme.name)} title={t.deleteTitle} onClick={() => setConfirming(true)}>
                  <Trash2 size={13} />
                </button>
              </>
            )}
            <button
              className="icon-btn small-icon"
              aria-label={t.duplicate(theme.name)}
              title={canDuplicate ? t.duplicateTitle : t.duplicateFull(MAX_CUSTOM_THEMES)}
              disabled={!canDuplicate}
              onClick={onDuplicate}
            >
              <Copy size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Themes({ a, mode, set }: { a: Appearance; mode: Mode; set: (c: Partial<Appearance>) => void }) {
  const t = useLocale().appearance.themes;
  const [editing, setEditing] = useState<Draft | "import">();
  const sessions = useRef(0);
  const all = [...BUILTIN_THEMES, ...a.customThemes];
  const names = (except?: string) => all.filter((o) => o.id !== except).map((o) => o.name);
  // Past the limit, loading drops the extra themes, so none is offered.
  const full = a.customThemes.length >= MAX_CUSTOM_THEMES;
  const fullNote = full ? t.full(MAX_CUSTOM_THEMES) : undefined;
  const edit = (d: Omit<Draft, "session">) => setEditing({ ...d, session: ++sessions.current });
  const startFrom = (from: Theme, name: string) => edit({ name: freeName(name, names()), light: { ...from.light }, dark: { ...from.dark } });

  const save = (d: Omit<Draft, "session">) => {
    // A theme deleted while it was being edited comes back as a new one.
    const replaces = d.id && a.customThemes.some((o) => o.id === d.id) ? d.id : undefined;
    if (!replaces && full) return;
    const theme: Theme = { id: replaces ?? newThemeId(), name: d.name, light: d.light, dark: d.dark };
    const customThemes = replaces ? a.customThemes.map((o) => (o.id === replaces ? theme : o)) : [...a.customThemes, theme];
    set({ customThemes, themeId: theme.id });
    setEditing(undefined);
  };
  const pick = (theme: Theme, m?: Mode) => set(m ? { themeId: theme.id, scheme: m } : { themeId: theme.id });

  return (
    <SettingsSection
      title={t.title}
      action={
        <>
          <button className="btn" disabled={full} title={fullNote} onClick={() => startFrom(themeOf(a), t.mine)}>
            <Paintbrush size={14} /> {t.create}
          </button>
          <button className="btn" disabled={full} title={fullNote} onClick={() => setEditing("import")}>
            <Plus size={14} /> {t.add}
          </button>
        </>
      }
    >
      {editing && (
        <div className="set-block">
          {editing === "import" ? (
            <ImportTheme
              onCancel={() => setEditing(undefined)}
              onImport={(theme) => save({ name: freeName(theme.name, names()), light: theme.light, dark: theme.dark })}
            />
          ) : (
            <ThemeEditor
              key={editing.session}
              draft={editing}
              contrast={a.contrast}
              taken={names(editing.id)}
              onSave={save}
              onCancel={() => setEditing(undefined)}
            />
          )}
        </div>
      )}
      <div className="set-block theme-grid">
        {all.map((theme) => {
          const custom = !BUILTIN_THEMES.includes(theme);
          return (
            <ThemeCard
              key={theme.id}
              theme={theme}
              selected={theme.id === a.themeId}
              mode={mode}
              custom={custom}
              onPick={(m) => pick(theme, m)}
              canDuplicate={!full}
              onDuplicate={() => startFrom(theme, t.copyOf(theme.name))}
              onEdit={() => edit({ id: theme.id, name: theme.name, light: { ...theme.light }, dark: { ...theme.dark } })}
              onDelete={() => {
                if (editing !== "import" && editing?.id === theme.id) setEditing(undefined);
                set({
                  customThemes: a.customThemes.filter((o) => o.id !== theme.id),
                  ...(a.themeId === theme.id ? { themeId: DEFAULT_APPEARANCE.themeId } : {}),
                });
              }}
            />
          );
        })}
      </div>
    </SettingsSection>
  );
}

/** A labeled slider over a list of stops, with a reset before it once it's off the default. */
function SliderRow({
  title,
  hint,
  reset,
  value,
  min,
  max,
  step = 1,
  label,
  low,
  high,
  isDefault,
  onChange,
  onReset,
}: {
  title: string;
  hint: string;
  /** The reset button's name. */
  reset: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  low: string;
  high: string;
  isDefault: boolean;
  onChange: (n: number) => void;
  onReset: () => void;
}) {
  const l = useLocale();
  return (
    <SettingRow
      name={title}
      hint={hint}
      control={
        <>
          {!isDefault && (
            <button className="icon-btn small-icon" aria-label={reset} title={l.common.backToDefault} onClick={onReset}>
              <RotateCcw size={13} />
            </button>
          )}
          <div className="slider">
            <input
              type="range"
              aria-label={title}
              aria-valuetext={label}
              min={min}
              max={max}
              step={step}
              value={value}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            <div className="slider-scale small">
              <span>{low}</span>
              <span className="slider-value">{label}</span>
              <span>{high}</span>
            </div>
          </div>
        </>
      }
    />
  );
}

export function ThemeSettings({ store }: { store: AppearanceStore }) {
  const l = useLocale();
  const t = l.appearance.layout;
  const a = useSyncExternalStore(store.subscribe, store.get);
  const mode = useSyncExternalStore(store.subscribe, store.mode);
  const set = (change: Partial<Appearance>) => store.set(change);
  const d = DEFAULT_APPEARANCE;
  const widthAt = Math.max(0, CHAT_WIDTHS.indexOf(a.chatWidth));
  return (
    <>
      <SettingsSection title={l.appearance.scheme.title} intro={l.appearance.scheme.intro}>
        <div className="set-block">
          <SchemePicker a={a} set={set} />
        </div>
      </SettingsSection>
      <Themes a={a} mode={mode} set={set} />
      <SettingsSection title={t.title}>
        <SliderRow
          title={t.contrast}
          hint={t.contrastHint}
          reset={t.resetContrast}
          value={a.contrast}
          min={0}
          max={100}
          step={5}
          label={a.contrast === d.contrast ? l.common.default : t.contrastOffset(a.contrast - d.contrast)}
          low={t.softer}
          high={t.sharper}
          isDefault={a.contrast === d.contrast}
          onChange={(contrast) => set({ contrast })}
          onReset={() => set({ contrast: d.contrast })}
        />
        <SliderRow
          title={t.width}
          hint={t.widthHint}
          reset={t.resetWidth}
          value={widthAt}
          min={0}
          max={CHAT_WIDTHS.length - 1}
          label={a.chatWidth ? l.common.px(a.chatWidth) : t.fullWidth}
          low={t.narrow}
          high={t.full}
          isDefault={a.chatWidth === d.chatWidth}
          onChange={(i) => set({ chatWidth: CHAT_WIDTHS[i] })}
          onReset={() => set({ chatWidth: d.chatWidth })}
        />
      </SettingsSection>
    </>
  );
}
