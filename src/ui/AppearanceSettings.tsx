// Settings, the Appearance tab: the interface language, then the color scheme, themes, contrast and chat width
// (ThemePicker.tsx), then the interface and code fonts and sizes, and Word wrap, each with a preview of what it changes.
// Changes apply at once and are kept on this computer only (appearance.ts). Last, whether the status bar shows
// (StatusBar.tsx), so a bar hidden from its own menu can come back.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { LANGUAGES, parseLanguageChoice, useLocale } from "../i18n/locale";
import { DEFAULT_APPEARANCE, MONO_SIZES, UI_SIZES, type Appearance, type AppearanceStore, type Fonts } from "./appearance";
import { Markdown } from "./Markdown";
import { SettingRow, SettingsSection } from "./SettingRows";
import { StatusBarSetting } from "./StatusBar";
import { ThemeSettings } from "./ThemePicker";
import { useChordLabel } from "./keybindings";

const CODE_SAMPLE = [
  "```ts",
  "// 0O 1lI: one long line shows what Word wrap does.",
  "export function describe(chat: Chat): string {",
  "  return `${chat.title}: ${chat.items.length} messages, last updated ${new Date(chat.updatedAt).toLocaleString()}`;",
  "}",
  "```",
].join("\n");

/** The font picker: the app's default first, then the installed families. A saved font no longer installed stays listed. */
function FontSelect({ label, value, groups, onChange }: { label: string; value: string; groups: [string, string[]][]; onChange: (f: string) => void }) {
  const l = useLocale();
  const listed = groups.some(([, fonts]) => fonts.includes(value));
  return (
    <select className="select font-select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{l.common.default}</option>
      {value && !listed && (
        <option value={value} translate="no">
          {value}
        </option>
      )}
      {groups.map(([name, fonts]) =>
        fonts.length ? (
          <optgroup key={name} label={name}>
            {fonts.map((f) => (
              <option key={f} value={f} translate="no">
                {f}
              </option>
            ))}
          </optgroup>
        ) : null,
      )}
    </select>
  );
}

function SizeSelect({ label, value, sizes, onChange }: { label: string; value: number; sizes: number[]; onChange: (n: number) => void }) {
  const l = useLocale();
  return (
    <select className="select size-select" aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {sizes.map((n) => (
        <option key={n} value={n}>
          {l.common.px(n)}
        </option>
      ))}
    </select>
  );
}

/** One font setting: its name, what it covers, a reset once it differs from the default, and the pickers. */
function FontRow({
  title,
  hint,
  reset,
  changed,
  onReset,
  children,
}: {
  title: string;
  hint: string;
  /** The reset button's name. */
  reset: string;
  changed: boolean;
  onReset: () => void;
  children: ReactNode;
}) {
  const l = useLocale();
  return (
    <SettingRow
      name={title}
      hint={hint}
      control={
        <>
          {changed && (
            <button className="icon-btn small-icon" aria-label={reset} title={l.common.backToDefault} onClick={onReset}>
              <RotateCcw size={13} />
            </button>
          )}
          {children}
        </>
      }
    />
  );
}

/** System, then each language by its own name. System's says which language it comes to on this desktop. */
function LanguageSetting({ store, a }: { store: AppearanceStore; a: Appearance }) {
  const l = useLocale();
  const t = l.appearance.language;
  return (
    <SettingsSection title={t.title}>
      <SettingRow
        name={t.name}
        hint={t.hint}
        control={
          <select className="select" aria-label={t.name} value={a.language} onChange={(e) => store.set({ language: parseLanguageChoice(e.target.value) })}>
            <option value="system">{t.system(LANGUAGES[store.locale("system").language].name)}</option>
            {Object.entries(LANGUAGES).map(([id, { name }]) => (
              <option key={id} value={id} lang={id} translate="no">
                {name}
              </option>
            ))}
          </select>
        }
      />
    </SettingsSection>
  );
}

export function AppearanceSettings({ store, listFonts }: { store: AppearanceStore; listFonts: () => Promise<Fonts> }) {
  const a = useSyncExternalStore(store.subscribe, store.get);
  const { fonts: t, wordWrap: wrap } = useLocale().appearance;
  const searchKey = useChordLabel("search");
  const [fonts, setFonts] = useState<Fonts>({ all: [], mono: [] });
  useEffect(() => {
    let live = true;
    void listFonts().then((f) => live && setFonts(f));
    return () => void (live = false);
  }, [listFonts]);

  const set = (change: Partial<Appearance>) => store.set(change);
  const d = DEFAULT_APPEARANCE;
  const otherFonts = fonts.all.filter((f) => !fonts.mono.includes(f));

  return (
    <>
      <LanguageSetting store={store} a={a} />
      <ThemeSettings store={store} />
      <SettingsSection title={t.title}>
        <FontRow
          title={t.ui}
          hint={t.uiHint}
          reset={t.resetUi}
          changed={a.uiFont !== d.uiFont || a.uiSize !== d.uiSize}
          onReset={() => set({ uiFont: d.uiFont, uiSize: d.uiSize })}
        >
          <FontSelect label={t.ui} value={a.uiFont} groups={[[t.installed, fonts.all]]} onChange={(uiFont) => set({ uiFont })} />
          <SizeSelect label={t.uiSize} value={a.uiSize} sizes={UI_SIZES} onChange={(uiSize) => set({ uiSize })} />
        </FontRow>
        <div className="set-block">
          <div className="appearance-preview ui-preview">{t.uiSample(searchKey)}</div>
        </div>

        <FontRow
          title={t.code}
          hint={t.codeHint}
          reset={t.resetCode}
          changed={a.monoFont !== d.monoFont || a.monoSize !== d.monoSize}
          onReset={() => set({ monoFont: d.monoFont, monoSize: d.monoSize })}
        >
          <FontSelect
            label={t.code}
            value={a.monoFont}
            groups={[
              [t.monospace, fonts.mono],
              [t.other, otherFonts],
            ]}
            onChange={(monoFont) => set({ monoFont })}
          />
          <SizeSelect label={t.codeSize} value={a.monoSize} sizes={MONO_SIZES} onChange={(monoSize) => set({ monoSize })} />
        </FontRow>
        <div className="set-block">
          {/* Sample code, the same in every language. */}
          <div className="appearance-preview code-preview" translate="no">
            <Markdown text={CODE_SAMPLE} />
          </div>
        </div>

        <SettingRow
          name={wrap.name}
          nameId="word-wrap-label"
          hint={wrap.hint}
          hintId="word-wrap-help"
          control={
            <button
              className="switch"
              role="switch"
              aria-checked={a.wordWrap}
              aria-labelledby="word-wrap-label"
              aria-describedby="word-wrap-help"
              onClick={() => set({ wordWrap: !a.wordWrap })}
            >
              <span className="switch-knob" />
            </button>
          }
        />
        <StatusBarSetting />
      </SettingsSection>
    </>
  );
}
