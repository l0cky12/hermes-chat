// Which profile a Settings tab shows (ADR 0118): Skills, Memory and Persona each pick one of the server's profiles,
// starting on the profile the app shows. The list is Hermes's own (`GET /api/profiles`); until it's read, or when it
// can't be, only the profiles already known are offered. Picking one goes through Settings' question first, so an
// unsaved edit is never dropped without asking.

/** Every name once, in Hermes's order, with `also` added where Hermes didn't list them (yet). */
export const profileChoices = (listed: readonly string[] | undefined, ...also: string[]) => [...new Set([...(listed ?? []), ...also])];

export function ProfilePicker({
  value,
  shown,
  profiles,
  onPick,
  disabled,
  label,
  defaultName,
}: {
  /** The profile the tab shows now. */
  value: string;
  /** The profile the app shows, marked in the list. */
  shown: string;
  /** Every profile Hermes lists, once read. */
  profiles?: readonly string[];
  onPick: (profile: string) => void;
  disabled?: boolean;
  /** What the list picks, for screen readers, e.g. "Profile whose skills are shown". */
  label: string;
  /** The display name Hermes keeps for `default`, shown before its id (ADR 0156). */
  defaultName?: string;
}) {
  const names = profileChoices(profiles, shown, value);
  return (
    <select
      className="profile-pick mono"
      aria-label={label}
      value={value}
      disabled={disabled || names.length < 2}
      title={!profiles ? "Reading the server's profiles…" : names.length < 2 ? "This server has one profile." : undefined}
      onChange={(e) => e.target.value !== value && onPick(e.target.value)}
    >
      {names.map((n) => (
        <option key={n} value={n}>
          {(n === "default" && defaultName ? `${defaultName} (default)` : n) + (n === shown ? " (in use)" : "")}
        </option>
      ))}
    </select>
  );
}
