// A model field for Settings → Model (#538): one provider's models in a combobox, searched as the composer's picker
// searches. Typing narrows the list, the arrow keys move through it, Enter picks, Escape closes. A pick only calls
// `onChange`; what it means (a draft, applied later) is the caller's.
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { composing } from "./bits";
import { hasWords, searchWords } from "./ModelPicker";

export function ModelCombobox({
  label,
  value,
  models,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  /** The model chosen. Listed and shown even when `models` no longer has it. */
  value: string;
  models: string[];
  /** Shown while no model is chosen. */
  placeholder: string;
  disabled?: boolean;
  onChange?: (model: string) => void;
}) {
  // `query` is what's typed; the field shows it while the list is open and the chosen model otherwise.
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const unlisted = !!value && !models.includes(value);
  const all = unlisted ? [value, ...models] : models;
  const rows = all.filter((m) => hasWords(m, searchWords(query)));
  const at = Math.min(active, rows.length - 1);

  useLayoutEffect(() => {
    if (open) list.current?.querySelector(`[data-row="${at}"]`)?.scrollIntoView?.({ block: "nearest" });
    // Closed with the focus still here (a pick, Escape): the model's name is selected, so typing starts a new search.
    else if (document.activeElement === field.current) field.current?.select();
  }, [open, at, query]);

  const show = (q: string) => {
    setOpen(true);
    setQuery(q);
    setActive(q ? 0 : Math.max(0, all.indexOf(value)));
  };
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const pick = (m: string) => {
    close();
    if (m !== value) onChange?.(m);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (composing(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) show("");
      else if (rows.length) setActive((at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === "Enter" && open && rows[at]) {
      e.preventDefault();
      pick(rows[at]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="model-combo">
      <input
        ref={field}
        className="select wide"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && rows[at] ? `${listId}-${at}` : undefined}
        value={open ? query : value}
        placeholder={open ? value || "Search models" : placeholder}
        title={value || undefined}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        // Typing into the field after tabbing to it replaces the model's name instead of adding to it.
        onFocus={(e) => e.currentTarget.select()}
        onClick={() => !open && show("")}
        onChange={(e) => show(e.target.value)}
        onKeyDown={onKey}
        onBlur={close}
      />
      <ChevronDown size={14} className="model-combo-chevron" aria-hidden />
      {open && (
        // The field keeps the focus while the list is clicked or scrolled, so blurring it means leaving.
        <div className="model-combo-pop" onMouseDown={(e) => e.preventDefault()}>
          <div className="model-combo-list" role="listbox" id={listId} aria-label={label} ref={list}>
            {rows.map((m, i) => (
              <div
                key={m}
                id={`${listId}-${i}`}
                data-row={i}
                role="option"
                aria-selected={i === at}
                className={`model-combo-option ${i === at ? "active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(m)}
              >
                <span className="model-name">{m}</span>
                {unlisted && m === value && <span className="model-provider">Not listed now</span>}
                <span className="model-check">{m === value && <Check size={14} aria-hidden />}</span>
              </div>
            ))}
          </div>
          {!rows.length && (
            <div className="model-empty" role="status">
              {query ? "No models match." : "This provider lists no models."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
