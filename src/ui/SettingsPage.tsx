// A Settings page's header (ADR 0159): the page or section title, the profile it edits, a one-line description, chips
// for what it reads (server, file, when it was read), its page-wide actions, and one box saying how a change reaches
// chats. The header is drawn by Settings; the page's own component fills its parts through <HeadPart>, so the
// component keeps the state behind them (a picker, a Reload that is busy). Outside a header (a component rendered on
// its own, or Settings' search results) a part renders where it stands, or not at all; see HeadPart.
import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Info, User } from "lucide-react";

/** True while Settings shows search results: every folded help text is open then. (Re-exported by SettingRows.) */
export const SettingsSearching = createContext(false);

export type HeadSlot = "profile" | "desc" | "help" | "helpText" | "meta" | "actions" | "applies";
type Slots = Partial<Record<HeadSlot, HTMLElement | null>>;

/**
 * Where a page's head parts go. Absent: the component is rendered outside Settings' frame, and each part renders in
 * place. `search`: Settings shows search results, which have no page headers; only `applies` renders (in place, as a
 * section, so a match in it can be found), and the page's actions, chips and picker are left out.
 */
const HeadSlots = createContext<{ mode: "page"; slots: Slots } | { mode: "search" } | undefined>(undefined);

/** Whether a component is drawn under a page header (Settings' page, not a search or a component on its own). */
export function useInPage(): boolean {
  return useContext(HeadSlots)?.mode === "page";
}

/** Draws `children` in the header's `at` part. */
export function HeadPart({ at, children }: { at: HeadSlot; children: ReactNode }) {
  const head = useContext(HeadSlots);
  if (!head) return <>{children}</>;
  if (head.mode === "search") return at === "applies" ? <>{children}</> : null;
  const el = head.slots[at];
  return el ? createPortal(children, el) : null;
}

/** The context for search results: see HeadSlots. */
export function SearchHeads({ children }: { children: ReactNode }) {
  return <HeadSlots.Provider value={{ mode: "search" }}>{children}</HeadSlots.Provider>;
}

/**
 * The header of the page shown, and the page under it. `eyebrow` names the page when the title is one of its sections.
 * `profile` is the static "Profile in use" chip of a page that edits the profile in use; a page that picks its profile
 * puts the picker in the `profile` part itself.
 */
export function SettingsPage({
  eyebrow,
  title,
  titleId,
  description,
  profile,
  slot: given,
  narrow = false,
  children,
}: {
  eyebrow?: string;
  title: string;
  titleId?: string;
  description: ReactNode;
  profile?: string;
  /** What the profile part shows, when Settings itself picks the profile (External memory's). */
  slot?: ReactNode;
  /** A narrow window's bar names the page, so the header leaves out the title. */
  narrow?: boolean;
  children: ReactNode;
}) {
  const [slots, setSlots] = useState<Slots>({});
  // One ref callback per part, kept for the header's life: a new one each render would unset and set its part again.
  const refs = useRef<Partial<Record<HeadSlot, (el: HTMLElement | null) => void>>>({});
  const slot = (at: HeadSlot) => (refs.current[at] ??= (el) => setSlots((s) => (s[at] === el ? s : { ...s, [at]: el })));
  return (
    <>
      <header className={`page-head ${narrow ? "narrow" : ""}`}>
        {eyebrow && !narrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h2 className={`page-title ${narrow ? "sr-only" : ""}`} id={titleId} tabIndex={-1}>
          {title}
        </h2>
        <div className="page-slot" ref={slot("profile")}>
          {profile && <ProfileInUse name={profile} />}
          {given}
        </div>
        {/* A bare section's longer help: its (i) ends the description, and opens under it (ADR 0059's fold). */}
        <div className="page-desc-block">
          <p className="page-desc">
            {description}
            <span className="page-desc-more" ref={slot("desc")} />
            <span className="page-help" ref={slot("help")} />
          </p>
          <div className="page-help-text" ref={slot("helpText")} />
        </div>
        <div className="page-meta" ref={slot("meta")} />
        <div className="page-actions" ref={slot("actions")} />
        <div className="page-applies" ref={slot("applies")} />
      </header>
      <HeadSlots.Provider value={{ mode: "page", slots }}>{children}</HeadSlots.Provider>
    </>
  );
}

/** A page that edits the profile in use says so, where a picker would be on the pages that choose. */
export function ProfileInUse({ name }: { name: string }) {
  return (
    <span className="page-profile static">
      <User size={14} aria-hidden /> <span>Profile in use</span> <code translate="no">{name}</code>
    </span>
  );
}

/** The "Editing profile" label around a page's profile picker, with a badge while it isn't the profile in use. */
export function EditingProfile({ picker, inUse }: { picker: ReactNode; inUse: boolean }) {
  return (
    <span className="page-profile">
      <User size={14} aria-hidden /> <span>Editing profile</span> {picker}
      {!inUse && <span className="badge warn">not in use</span>}
    </span>
  );
}

/** A long path keeps its first three parts and its file name, cut on slashes: ~/.hermes/profiles/…/MEMORY.md. */
export function shortPath(v: string): string {
  const parts = v.split("/");
  return v.length > 40 && parts.length > 4 ? [...parts.slice(0, 3), "…", parts[parts.length - 1]].join("/") : v;
}

/** One labelled chip under the header: Server, File, Read. A path shows shortened, in full on hover. */
export function MetaChip({ label, value, path = false }: { label: string; value: string; path?: boolean }) {
  const home = path ? value.replace(/^\/home\/[^/]+|^\/Users\/[^/]+/, "~") : value;
  return (
    <span className="meta-chip">
      <span>{label}</span>
      <code title={value} translate="no">
        {path ? shortPath(home) : home}
      </code>
    </span>
  );
}

/**
 * How a change reaches chats, in one line, with the full explanation (and any safety checks) one click away. It is a
 * <section>, the unit Settings' search shows or hides, and opens while a search matches inside it.
 */
export function AppliesBox({ line, more, children }: { line: ReactNode; more: string; children: ReactNode }) {
  return (
    <section className="applies-box">
      <details>
        <summary>
          <Info size={14} aria-hidden />
          <span className="applies-line">{line}</span>
          <span className="applies-more">
            {more} <ChevronDown size={13} aria-hidden />
          </span>
        </summary>
        {children}
      </details>
    </section>
  );
}

/** A sub-heading inside an AppliesBox, such as "Safety checks". */
export function AppliesPart({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <>
      {title && <div className="applies-sub">{title}</div>}
      <div className="set-card">{children}</div>
    </>
  );
}

/** A long intro's first sentence, with the rest behind an inline More. */
export function MoreText({ first, rest }: { first: ReactNode; rest: ReactNode }) {
  const [open, setOpen] = useState(false);
  // A search reads what's drawn, so the rest shows while Settings is searched.
  const searching = useContext(SettingsSearching);
  return (
    <>
      {first}{" "}
      {open || searching ? (
        rest
      ) : (
        <button type="button" className="link-btn more-inline" onClick={() => setOpen(true)}>
          More
        </button>
      )}
    </>
  );
}
