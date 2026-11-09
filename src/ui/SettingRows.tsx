// The layout every Settings page is moving to (#174, ADR 0059). A section is a heading, at most one line under it, and a
// card of rows. A row is a setting's name with a one-line hint on the left and its control on the right. Longer help
// folds behind an (i) button beside the name or heading, and opens by itself while Settings is searched, so a match
// inside it can be seen. Each section stays a <section>, the unit Settings' search shows or hides (settingsSearch.ts).
import { createContext, type ReactNode, useContext, useId, useState } from "react";
import { Info } from "lucide-react";
import { useLocale } from "../i18n/locale";

/** True while Settings shows search results: every folded help text is open then. */
export const SettingsSearching = createContext(false);

/** The (i) button and the help it opens. `about` names what it's about, for assistive technology. */
function useMore(about: string | undefined, more: ReactNode) {
  const l = useLocale();
  const searching = useContext(SettingsSearching);
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!more) return { button: null, panel: null };
  const shown = open || searching;
  return {
    button: (
      <button
        type="button"
        className={`set-more-btn ${shown ? "on" : ""}`}
        aria-label={l.common.about(about ?? l.common.thisSetting)}
        aria-expanded={shown}
        aria-controls={id}
        // While searching every help shows; a press then would only change what shows once the search ends.
        onClick={() => !searching && setOpen(!open)}
      >
        <Info size={13} aria-hidden />
      </button>
    ),
    panel: (
      <div id={id} className="set-more" hidden={!shown}>
        {more}
      </div>
    ),
  };
}

/**
 * A heading, an optional one-line `intro`, and a card holding `children` (rows). `action` sits at the heading's end,
 * for a button that acts on the whole section (Add connection, Check for updates).
 */
export function SettingsSection({
  title,
  titleId,
  intro,
  more,
  action,
  className = "",
  children,
}: {
  title: string;
  /** The heading's id, which also names the section (a landmark), when something else points at it. */
  titleId?: string;
  intro?: ReactNode;
  /** Longer help, folded behind the (i) beside the heading. */
  more?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const { button, panel } = useMore(title, more);
  return (
    // Named by its heading only when something points at it: a page of named sections would be a page of landmarks.
    <section className={`set-section ${className}`} aria-labelledby={titleId}>
      <div className="set-head">
        {/* The (i) stays outside the heading, so the heading's name is only its title. */}
        <h2 id={titleId}>{title}</h2>
        {button}
        {action && <div className="set-head-action">{action}</div>}
      </div>
      {intro && <div className="set-intro">{intro}</div>}
      {panel}
      <div className="set-card">{children}</div>
    </section>
  );
}

/**
 * One setting: `name` and `hint` on the left, `control` on the right. `children` go under both, full width: a
 * confirmation, a test result, a problem the control ran into. `nameId` and `hintId` are for a control that is
 * labelled or described by them; the (i) button is outside both, so it never joins the control's name.
 */
export function SettingRow({
  name,
  nameId,
  nameAs: Name = "span",
  hint,
  hintId,
  more,
  about,
  control,
  className = "",
  children,
}: {
  name: ReactNode;
  nameId?: string;
  /** "h3" when the row heads what's under it (a provider's settings, the skill being edited), so it's a heading to jump to. */
  nameAs?: "span" | "h3";
  hint?: ReactNode;
  hintId?: string;
  /** Longer help, folded behind the (i) beside the name. */
  more?: ReactNode;
  /** What the (i) is about, when `name` isn't plain text. */
  about?: string;
  control?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const { button, panel } = useMore(about ?? (typeof name === "string" ? name : undefined), more);
  return (
    <div className={`set-row ${className}`}>
      <div className="set-text">
        <div className="set-name-line">
          <Name className="set-name" id={nameId}>
            {name}
          </Name>
          {button}
        </div>
        {hint && (
          <div className="set-hint" id={hintId}>
            {hint}
          </div>
        )}
        {panel}
      </div>
      {control && <div className="set-control">{control}</div>}
      {children && <div className="set-sub">{children}</div>}
    </div>
  );
}

/** A line across the card that isn't a setting: a status, or a problem with the whole section. */
export function SettingNote({ tone = "muted", role, className = "", children }: { tone?: "muted" | "warn" | "bad"; role?: "status" | "alert"; className?: string; children: ReactNode }) {
  return (
    <div className={`set-note ${tone} ${className}`} role={role}>
      {children}
    </div>
  );
}
