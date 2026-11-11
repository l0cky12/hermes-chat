// The composer's model picker and reasoning pill. The picker lists the models Hermes offers, starred ones first under
// Favorites; hovering a row (or moving to it with the arrow keys) shows its options beside the list: reasoning effort
// and fast mode. The pill shows the effort in use and changes it directly; it hides for a model without reasoning.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Brain, Check, ChevronDown, Columns2, Search, Star, Zap } from "lucide-react";
import {
  EFFORT_LABEL,
  capabilitiesOf,
  carryOptions,
  effortsFor,
  findOption,
  fromKey,
  guessCapabilities,
  modelKey,
  shortName,
  type Effort,
  type ModelCatalog,
  type ModelOption,
  type ModelPick,
} from "../hermes/models";
import { useDismiss, useReturnFocus } from "./bits";

/** The effort's name in menus. */
const EFFORT_NAME: Record<Effort, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * `catalog`: the models to list; undefined while it is read. `current`: the model in use, for the chat on screen or for
 * the next new chat. `defaultEffort`: the profile's effort, shown when `current` leaves effort as the profile has it.
 * `favorites`: starred models as `provider/model`. `onCompare`: the popover also offers Compare (ADR 0101), which picks a
 * second model to send the same messages to in the other pane.
 */
export type ModelControlsProps = {
  catalog?: ModelCatalog;
  current?: ModelPick;
  defaultEffort?: Effort;
  favorites: string[];
  onPick: (pick: ModelPick) => void;
  onToggleFavorite: (key: string) => void;
  onCompare?: (pick: ModelPick) => void;
  children?: ReactNode;
};

/** The picker's button and, beside it, the reasoning pill. */
export function ModelControls(props: ModelControlsProps) {
  return (
    <div className="model-controls">
      <ModelPicker {...props} />
      <ReasoningPill {...props} />
      {props.children}
    </div>
  );
}

const COMPARE_TITLE = "Pick a model to compare with";

/** One row of the list. `favorite`: it sits under Favorites. */
type Row = { key: string; option: ModelOption; favorite: boolean };

/** A starred model Hermes doesn't list (its provider signed out, say): still shown, but it can't be picked. */
function missingOption(key: string): ModelOption | undefined {
  const p = fromKey(key);
  return p && { ...p, providerName: p.provider, available: false, ...guessCapabilities(p.model) };
}

const matches = (o: ModelOption, words: string[]) => {
  const text = `${o.model} ${o.provider} ${o.providerName}`.toLowerCase();
  return words.every((w) => text.includes(w));
};

/** The rows the picker lists for `query`: Favorites first, then each provider's other models. */
export function pickerRows(catalog: ModelCatalog | undefined, favorites: string[], query: string): { title: string; rows: Row[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const starred = new Set(favorites);
  const favRows = favorites
    .map((key) => ({ key, option: findOption(catalog, fromKey(key)) ?? missingOption(key) }))
    .filter((r): r is { key: string; option: ModelOption } => !!r.option && matches(r.option, words))
    .map((r) => ({ ...r, favorite: true }));
  const sections = favRows.length ? [{ title: "Favorites", rows: favRows }] : [];
  for (const p of catalog?.providers ?? []) {
    const rows = p.models.filter((m) => !starred.has(modelKey(m)) && matches(m, words)).map((option) => ({ key: modelKey(option), option, favorite: false }));
    if (rows.length) sections.push({ title: p.name, rows });
  }
  return sections;
}

function ModelPicker({ catalog, current, defaultEffort, favorites, onPick, onToggleFavorite, onCompare }: ModelControlsProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useDismiss(wrap, open, close);
  const caps = current && capabilitiesOf(catalog, current);
  const label = current ? shortName(current.model) : catalog ? "Default model" : "Loading models…";
  return (
    <div className="model-picker" ref={wrap}>
      <button
        className={`model-trigger ${open ? "on" : ""}`}
        title={current ? `${current.provider}/${current.model}` : undefined}
        aria-label={`Model: ${current ? current.model : label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-trigger-name">{label}</span>
        {current?.fast && caps?.fast && <Zap size={12} className="model-fast-mark" aria-label="fast mode" />}
        <ChevronDown size={13} />
      </button>
      {open && (
        <ModelPopover
          catalog={catalog}
          current={current}
          defaultEffort={defaultEffort}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
          onPick={(p, keepOpen) => {
            onPick(p);
            if (!keepOpen) close();
          }}
          onCompare={
            onCompare &&
            ((p) => {
              close();
              onCompare(p);
            })
          }
          onClose={close}
        />
      )}
    </div>
  );
}

function ModelPopover({
  catalog,
  current,
  defaultEffort,
  favorites,
  onPick,
  onToggleFavorite,
  onCompare,
  onClose,
}: Omit<ModelControlsProps, "onPick"> & { onPick: (p: ModelPick, keepOpen?: boolean) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  // Compare turns the same list into a pick of the second model; the pane's own model stays as it is.
  const [comparing, setComparing] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const sections = pickerRows(catalog, favorites, query);
  const rows = sections.flatMap((s) => s.rows);
  const currentKey = current && modelKey(current);
  // The row whose options show beside the list: the hovered one, or the one the arrow keys moved to.
  const [active, setActive] = useState(() => Math.max(0, rows.findIndex((r) => r.key === currentKey)));
  const at = Math.min(active, rows.length - 1);
  const activeRow = rows[at];
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const fly = useRef<HTMLDivElement>(null);
  const [flyTop, setFlyTop] = useState(0);
  useReturnFocus();

  // The options sit level with their row, moved up as far as needed to end within the popover's height.
  useLayoutEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-row="${at}"]`);
    if (!row || !box.current) return;
    row.scrollIntoView?.({ block: "nearest" });
    const outer = box.current.getBoundingClientRect();
    const top = row.getBoundingClientRect().top - outer.top;
    const room = outer.height - (fly.current?.offsetHeight ?? 0);
    setFlyTop(Math.max(0, Math.min(top, room)));
  }, [at, query]);

  const pick = (o: ModelOption, change: Partial<ModelPick> = {}, keepOpen = false) => {
    if (!o.available) return;
    // The row in use keeps its own options; another row takes what of them it can.
    const base = modelKey(o) === currentKey && current ? current : carryOptions(o, current, catalog);
    if (comparing) onCompare?.({ ...base, ...change });
    else onPick({ ...base, ...change }, keepOpen);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setActive((at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === "Enter" && activeRow && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      pick(activeRow.option);
    }
  };

  let n = -1;
  return (
    <div className="model-popover" role="dialog" aria-label={comparing ? COMPARE_TITLE : "Choose a model"} ref={box} onKeyDown={onKey}>
      {comparing && <div className="model-compare-title">{COMPARE_TITLE}</div>}
      <div className="model-search">
        <Search size={14} />
        <input
          ref={search}
          autoFocus
          placeholder="Search models"
          aria-label="Search models"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
      </div>
      <div className="model-list" ref={list}>
        {!catalog && <div className="model-empty">Loading models…</div>}
        {catalog && !rows.length && <div className="model-empty">{query ? "No model matches." : "Hermes listed no models."}</div>}
        {sections.map((s) => (
          <div key={s.title} className="model-section" role="group" aria-label={s.title}>
            <div className="model-section-title">{s.title}</div>
            {s.rows.map((r) => {
              const i = ++n;
              const o = r.option;
              const starred = r.favorite;
              const inUse = r.key === currentKey;
              return (
                <div
                  key={r.key}
                  data-row={i}
                  className={`model-row ${i === at ? "active" : ""} ${o.available ? "" : "unavailable"}`}
                  onMouseEnter={() => setActive(i)}
                >
                  <button
                    className={`model-star ${starred ? "on" : ""}`}
                    aria-label={`${starred ? "Unstar" : "Star"} ${o.model}`}
                    aria-pressed={starred}
                    title={starred ? "Remove from Favorites" : "Add to Favorites"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(r.key);
                    }}
                  >
                    <Star size={13} fill={starred ? "currentColor" : "none"} />
                  </button>
                  <button
                    className="model-choose"
                    aria-current={inUse || undefined}
                    disabled={!o.available}
                    title={o.available ? `${o.provider}/${o.model}` : `${o.provider}/${o.model} isn't available on this server now`}
                    onFocus={() => setActive(i)}
                    onClick={() => pick(o)}
                  >
                    <span className="model-name">{o.model}</span>
                    {s.title === "Favorites" && <span className="model-provider">{o.providerName}</span>}
                    {!o.available && <span className="model-provider">Unavailable</span>}
                    <span className="model-caps">
                      {o.reasoning && <Brain size={12} aria-label="reasoning" />}
                      {o.fast && <Zap size={12} aria-label="fast mode" />}
                    </span>
                    <span className="model-check">{inUse && <Check size={14} />}</span>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {catalog?.source === "fallback" && (
        <div className="model-note" title={catalog.reason}>
          Hermes didn't list its models, so these are common ones. A model the server isn't set up for is refused when the chat starts.
        </div>
      )}
      {onCompare && !comparing && (
        <button
          className="model-compare"
          title="Send each message to this pane's model and another, side by side"
          onClick={() => {
            setComparing(true);
            setQuery("");
            setActive(0);
            search.current?.focus();
          }}
        >
          <Columns2 size={14} aria-hidden /> Compare with another model
        </button>
      )}
      {activeRow && activeRow.option.available && !comparing && (
        <ModelOptions ref={fly} option={activeRow.option} pick={activeRow.key === currentKey ? current : carryOptions(activeRow.option, current, catalog)} defaultEffort={defaultEffort} top={flyTop} onPick={pick} />
      )}
    </div>
  );
}

/** A row's options, beside the list. `pick`: what choosing the row now would pick. */
function ModelOptions({
  ref,
  option,
  pick,
  defaultEffort,
  top,
  onPick,
}: {
  ref: React.Ref<HTMLDivElement>;
  option: ModelOption;
  pick?: ModelPick;
  defaultEffort?: Effort;
  top: number;
  onPick: (o: ModelOption, change: Partial<ModelPick>, keepOpen?: boolean) => void;
}) {
  const efforts = effortsFor(option);
  if (!efforts.length && !option.fast) return null;
  const effort = pick?.effort ?? defaultEffort;
  const fast = !!pick?.fast;
  return (
    <div className="model-options" ref={ref} style={{ top }} role="group" aria-label={`Options for ${option.model}`}>
      {efforts.length > 0 && (
        <>
          <div className="model-options-title">Reasoning effort</div>
          {efforts.map((e) => (
            <button key={e} className={`model-option ${e === effort ? "on" : ""}`} aria-pressed={e === effort} onClick={() => onPick(option, { effort: e })}>
              <span>{EFFORT_NAME[e]}</span>
              {e === effort && <Check size={13} />}
            </button>
          ))}
        </>
      )}
      {option.fast && (
        <button className="model-option model-fast" role="switch" aria-checked={fast} onClick={() => onPick(option, { fast: !fast }, true)}>
          <Zap size={13} />
          <span>Fast mode</span>
          <span className={`toggle ${fast ? "on" : ""}`} />
        </button>
      )}
    </div>
  );
}

/** The effort in use, as a pill that opens the effort menu. Hidden for a model without reasoning. */
function ReasoningPill({ catalog, current, defaultEffort, onPick }: ModelControlsProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useDismiss(wrap, open, close);
  if (!current) return null;
  const efforts = effortsFor(capabilitiesOf(catalog, current));
  if (!efforts.length) return null;
  const effort = current.effort ?? defaultEffort ?? "medium";
  return (
    <div className="pill-wrap" ref={wrap}>
      <button
        className={`reasoning-pill ${open ? "on" : ""}`}
        title="Reasoning effort"
        aria-label={`Reasoning effort: ${EFFORT_NAME[effort]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Brain size={12} />
        {EFFORT_LABEL[effort]}
      </button>
      {open && (
        <div
          className="menu pill-menu"
          role="menu"
          aria-label="Reasoning effort"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        >
          {efforts.map((e, i) => (
            <button
              key={e}
              role="menuitemradio"
              aria-checked={e === effort}
              className="menu-item"
              autoFocus={i === efforts.indexOf(effort) || (efforts.indexOf(effort) < 0 && i === 0)}
              onClick={() => {
                onPick({ ...current, effort: e });
                close();
              }}
            >
              <span className="menu-label">{EFFORT_NAME[e]}</span>
              <span className="menu-icon">{e === effort && <Check size={14} />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
