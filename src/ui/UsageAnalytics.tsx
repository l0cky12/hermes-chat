// Usage analytics (GLOSSARY.md "Usage analytics", ADR 0026): where tokens and recorded cost add up, across chats,
// models, projects and profiles, from the totals Hermes stored for each chat. Nothing here prices anything: each cost
// is what Hermes recorded, labelled by how it got it, and every total says how much of the usage it covers.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, BarChart3, ChevronDown, ChevronUp, CircleAlert, Download, RefreshCw } from "lucide-react";
import type { Project } from "../hermes/projects";
import { offsetAt, offsetLabel } from "../hermes/schedule";
import { tokens, usd } from "../hermes/usage";
import {
  COST_KINDS,
  COST_KIND_LABEL,
  DIMENSION_LABEL,
  NO_MODEL,
  NO_PROJECT,
  StaleRead,
  chatCost,
  chatTotalShort,
  reportedNowhere,
  collectUsage,
  coverage,
  crossCheck,
  csvFileName,
  dayIn,
  filterChats,
  groupBy,
  periodOf,
  sortChats,
  sortGroups,
  sourceName,
  tallyLabel,
  totalOf,
  totalsOf,
  usageCsv,
  type CountField,
  type Dimension,
  type Group,
  type Period,
  type Progress,
  type RangeChoice,
  type Sort,
  type SortKey,
  type Totals,
  type UsageChat,
  type UsageDataset,
  type UsageIo,
} from "../hermes/usageAnalytics";
import { Spinner } from "./bits";
import { useLocale, type Formats } from "../i18n/locale";
import { errorText } from "../hermes/values";

const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ROLLING = [1, 7, 30, 90, 365] as const;
const rollingLabel = (d: number) => (d === 1 ? "Last 24 hours" : `Last ${d} days`);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Every time zone this computer knows, its own and UTC first. */
function zoneList(): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set([HERE, "UTC", ...all])];
}

/** Which profiles to read: the one the app shows, all of them, or one other. */
type ProfileChoice = { kind: "shown" } | { kind: "all" } | { kind: "one"; name: string };

type Read =
  | { state: "idle" }
  | { state: "loading"; progress?: Progress }
  | { state: "done"; data: UsageDataset }
  | { state: "error"; error: string };

const COLUMNS: { key: SortKey; label: string; short?: string; field?: CountField }[] = [
  { key: "chats", label: "Chats" },
  { key: "input", label: "Input, not cached", short: "Input", field: "input" },
  { key: "cacheRead", label: "Cache read", field: "cacheRead" },
  { key: "cacheWrite", label: "Cache written", field: "cacheWrite" },
  { key: "output", label: "Output", field: "output" },
  { key: "reasoning", label: "of which reasoning", short: "Reasoning", field: "reasoning" },
  { key: "calls", label: "Model calls", short: "Calls", field: "calls" },
  { key: "total", label: "Total tokens", short: "Total" },
  { key: "cost", label: "Recorded cost", short: "Cost" },
  { key: "coverage", label: "Cost covers", short: "Covers" },
];

export type UsageAnalyticsProps = {
  io: UsageIo;
  /** The profile the app shows; its projects are the ones known here. */
  profile: string;
  listProfiles: () => Promise<string[]>;
  projects: Project[];
  /** Each project's chats, by project id, as this computer keeps them. */
  projectChats: Readonly<Record<string, readonly string[]>>;
  connected: boolean;
  /** Opens a chat of the shown profile. */
  onOpenChat: (chat: UsageChat) => void;
  /** Saves the CSV where the owner picks; the path, or null when cancelled. */
  saveCsv: (csv: string, fileName: string) => Promise<string | null>;
  onClose: () => void;
  now?: () => number;
};

export function UsageAnalytics({ io, profile, listProfiles, projects, projectChats, connected, onOpenChat, saveCsv, onClose, now = Date.now }: UsageAnalyticsProps) {
  const { fmt } = useLocale();
  const [range, setRange] = useState<RangeChoice>({ kind: "rolling", days: 30 });
  const [zone, setZone] = useState(HERE);
  const zones = useMemo(zoneList, []);
  const [who, setWho] = useState<ProfileChoice>({ kind: "shown" });
  const [allProfiles, setAllProfiles] = useState<string[]>([profile]);
  const [profilesError, setProfilesError] = useState<string>();
  const [model, setModel] = useState<string>();
  const [project, setProject] = useState<string>();
  const [dim, setDim] = useState<Dimension>("model");
  const [sort, setSort] = useState<Sort>({ key: "total", dir: "desc" });
  const [chatSort, setChatSort] = useState<Sort>({ key: "total", dir: "desc" });
  const [drill, setDrill] = useState<{ dim: Dimension; key: string; label: string }>();
  const [read, setRead] = useState<Read>({ state: "idle" });
  const [tick, setTick] = useState(0);
  const [exportNote, setExportNote] = useState<string>();
  const exporting = useRef(false);
  const drillHeading = useRef<HTMLHeadingElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    listProfiles().then(
      (names) => live && (setAllProfiles(names.includes(profile) ? names : [profile, ...names]), setProfilesError(undefined)),
      (e) => live && setProfilesError(errorText(e)),
    );
    return () => void (live = false);
  }, [listProfiles, profile, connected]);

  const profiles = who.kind === "shown" ? [profile] : who.kind === "all" ? allProfiles : [who.name];
  // A custom period depends on the zone; a rolling one doesn't.
  const periodKey = range.kind === "rolling" ? `r${range.days}` : `c${range.from}|${range.to}|${zone}`;
  const invalid = range.kind === "custom" ? (periodOf(range, zone, 0) as { error?: string }).error : undefined;

  // Each change of what to read starts a new read and cancels the one before: its answers are dropped, and it stops
  // asking Hermes at its next request.
  useEffect(() => {
    // Dates that aren't a period show nothing: the last read was for another period, and can't be exported as this
    // one. Offline, the last read stays, as read; one under way stops loading.
    if (invalid) {
      setRead({ state: "idle" });
      setDrill(undefined);
      setExportNote(undefined);
      return;
    }
    if (!connected) {
      setRead((r) => (r.state === "loading" ? { state: "idle" } : r));
      return;
    }
    const period = periodOf(range, zone, now()) as Period;
    const ac = new AbortController();
    setRead({ state: "loading" });
    setDrill(undefined);
    setExportNote(undefined);
    collectUsage(io, profiles, period, { signal: ac.signal, onProgress: (progress) => !ac.signal.aborted && setRead({ state: "loading", progress }), now }).then(
      (data) => !ac.signal.aborted && setRead({ state: "done", data }),
      (e) => !ac.signal.aborted && !(e instanceof StaleRead) && setRead({ state: "error", error: errorText(e) }),
    );
    return () => ac.abort();
    // `profiles` is keyed by its names; `range` and `zone` by `periodKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [io, connected, invalid, periodKey, profiles.join("\n"), tick]);

  const data = read.state === "done" ? read.data : undefined;
  // One membership for grouping, filtering and export: the projects Hermes has, archived ones too (labelled). A chat
  // kept here in a project Hermes no longer has is in no project.
  const listable = useMemo(() => [...projects].sort((a, b) => Number(a.archived) - Number(b.archived)), [projects]);
  const projectsOf = useMemo(() => {
    const known = new Set(projects.map((p) => p.id));
    const of = new Map<string, Set<string>>();
    for (const [id, chats] of Object.entries(projectChats)) if (known.has(id)) for (const c of chats) of.set(c, (of.get(c) ?? new Set()).add(id));
    return (c: UsageChat) => (c.profile === profile ? (of.get(c.id) ?? new Set<string>()) : undefined);
  }, [projectChats, projects, profile]);
  const projectName = (id: string) => {
    const p = projects.find((x) => x.id === id);
    return p && (p.archived ? `${p.name} (archived)` : p.name);
  };
  const ctx = { zone, projectsOf, projectName };

  const shownChats = useMemo(() => (data ? filterChats(data.chats, { model, project }, projectsOf) : []), [data, model, project, projectsOf]);
  const totals = useMemo(() => totalsOf(shownChats), [shownChats]);
  const groups = useMemo(() => sortGroups(groupBy(shownChats, dim, ctx), sort), [shownChats, dim, sort, zone, projectsOf, listable]);
  const models = useMemo(() => [...new Set((data?.chats ?? []).map((c) => c.model ?? NO_MODEL))].sort(), [data]);
  const drilled = drill && groupBy(shownChats, drill.dim, ctx).find((g) => g.key === drill.key);
  const filtered = model !== undefined || project !== undefined;

  useEffect(() => {
    if (drill) drillHeading.current?.focus();
  }, [drill]);

  // Back puts focus on the row it came from, mounted again with the breakdown.
  const closeDrill = () => {
    const key = drill?.key;
    setDrill(undefined);
    requestAnimationFrame(() => {
      const rows = screenRef.current?.querySelectorAll<HTMLButtonElement>("button[data-group]") ?? [];
      [...rows].find((b) => b.dataset.group === key)?.focus();
    });
  };

  const exportCsv = async () => {
    if (!data || exporting.current) return;
    exporting.current = true;
    setExportNote(undefined);
    try {
      const names = (c: UsageChat) => {
        const of = projectsOf(c);
        return of && [...of].flatMap((id) => projectName(id) ?? []);
      };
      const path = await saveCsv(usageCsv(sortChats(shownChats, { key: "started", dir: "asc" }), zone, names), csvFileName(data.period.from, data.period.to, zone));
      if (path) setExportNote(`Saved ${fmt.number(shownChats.length)} chats to ${path}.`);
    } catch (e) {
      setExportNote(`Couldn't export: ${errorText(e)}`);
    } finally {
      exporting.current = false;
    }
  };

  const failed = data?.profiles.filter((p) => p.state === "failed") ?? [];
  const capped = data?.profiles.filter((p) => p.state === "capped") ?? [];
  // Whole chats not read: a profile failed, or its period reached past the page limit. Every group may lack some.
  const unreadChats = failed.length > 0 || capped.length > 0;
  const partial = !!data && (unreadChats || data.missingSegments > 0);

  return (
    <div className="settings usage-screen" ref={screenRef}>
      <div className="settings-inner usage-inner">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <h1 className="project-title">
          <BarChart3 size={20} /> <span>Usage</span>
        </h1>
        <p className="muted">
          Tokens and cost as Hermes stored them for each chat, added up for the chats started in the period. Hermes Chat keeps no prices of its own: a cost
          is only what Hermes recorded.
        </p>

        <div className="usage-filters" role="group" aria-label="What to count">
          <label>
            <span>Period</span>
            <select
              value={range.kind === "rolling" ? String(range.days) : "custom"}
              onChange={(e) => {
                const v = e.target.value;
                if (v !== "custom") return setRange({ kind: "rolling", days: Number(v) });
                const today = dayIn(zone, now());
                setRange({ kind: "custom", from: dayIn(zone, now() - 6 * 86_400_000), to: today });
              }}
            >
              {ROLLING.map((d) => (
                <option key={d} value={d}>
                  {rollingLabel(d)}
                </option>
              ))}
              <option value="custom">Dates…</option>
            </select>
          </label>
          {range.kind === "custom" && (
            <>
              <label>
                <span>From</span>
                <input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-invalid={!!invalid} />
              </label>
              <label>
                <span>To</span>
                <input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-invalid={!!invalid} />
              </label>
            </>
          )}
          <label>
            <span>Time zone</span>
            <select value={zone} onChange={(e) => setZone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z === HERE ? `${z} (this computer)` : z} · {offsetLabel(offsetAt(z, now()))}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Profile</span>
            <select
              value={who.kind === "one" ? `=${who.name}` : who.kind}
              onChange={(e) => {
                const v = e.target.value;
                setWho(v === "shown" || v === "all" ? { kind: v } : { kind: "one", name: v.slice(1) });
              }}
            >
              <option value="shown">{profile} (shown)</option>
              <option value="all">All profiles</option>
              {allProfiles
                .filter((p) => p !== profile)
                .map((p) => (
                  <option key={p} value={`=${p}`}>
                    {p}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>Project</span>
            <select value={project ?? ""} onChange={(e) => setProject(e.target.value || undefined)} disabled={!listable.length && project === undefined}>
              <option value="">All chats</option>
              <option value={NO_PROJECT}>No project</option>
              {listable.map((p) => (
                <option key={p.id} value={p.id}>
                  {projectName(p.id)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Model</span>
            <select value={model ?? ""} onChange={(e) => setModel(e.target.value === "" ? undefined : e.target.value)}>
              <option value="">All models</option>
              {[...new Set([...models, ...(model !== undefined ? [model] : [])])].map((m) => (
                <option key={m} value={m}>
                  {m === NO_MODEL ? "No model recorded" : m}
                </option>
              ))}
            </select>
          </label>
        </div>
        {invalid && (
          <p className="job-banner" role="alert">
            <CircleAlert size={14} /> {invalid}
          </p>
        )}
        {project !== undefined && who.kind !== "shown" && (
          <p className="usage-note">Projects belong to the {profile} profile, so only its chats are counted while a project is picked.</p>
        )}
        {profilesError && <p className="usage-note">Couldn't list the other profiles: {profilesError}</p>}

        <div className="usage-status">
          <span role="status" aria-live="polite" className="muted small">
            {!connected
              ? "Not connected to Hermes."
              : read.state === "loading"
                ? read.progress
                  ? `Reading ${read.progress.profile}: ${fmt.number(read.progress.read)} chats so far…`
                  : "Reading Hermes…"
                : data
                  ? `Read ${fmt.time(data.readAt)}${partial ? " · partly" : ""}`
                  : ""}
          </span>
          {read.state === "loading" && <Spinner />}
          <span className="usage-status-actions">
            <button className="btn" disabled={!connected || read.state === "loading" || !!invalid} onClick={() => setTick((t) => t + 1)}>
              <RefreshCw size={14} /> Refresh
            </button>
            <button className="btn" disabled={!data || !shownChats.length} onClick={() => void exportCsv()} title="Save the chats counted here as a CSV file">
              <Download size={14} /> Export CSV…
            </button>
          </span>
        </div>
        {exportNote && (
          <p className="usage-note" role="status">
            {exportNote}
          </p>
        )}

        {!connected && !data && (
          <div className="empty-hint jobs-empty">Connect to Hermes to read its usage. A chat's own usage, beside its title, works as before.</div>
        )}
        {read.state === "error" && (
          <div className="job-error" role="alert">
            <p>Couldn't read usage: {read.error}</p>
            <button className="btn" onClick={() => setTick((t) => t + 1)}>
              Try again
            </button>
          </div>
        )}
        {data && <Problems data={data} />}

        {data && data.unsupported ? (
          <div className="empty-hint jobs-empty">
            This Hermes doesn't send token counts with its chat list, so there is nothing to add up. Each chat's own usage, beside its title, still shows
            what Hermes reports for it.
          </div>
        ) : data && !data.chats.length ? (
          <div className="empty-hint jobs-empty">{failed.length === data.profiles.length ? "Nothing could be read." : "No chats started in this period."}</div>
        ) : data && !shownChats.length ? (
          <div className="empty-hint jobs-empty">
            No chats match the project and model picked.{" "}
            <button
              className="link-btn"
              onClick={() => {
                setModel(undefined);
                setProject(undefined);
              }}
            >
              Show all chats
            </button>
          </div>
        ) : data ? (
          <>
            <TotalsTiles totals={totals} partial={partial} />
            <CostCard totals={totals} partial={unreadChats} />
            {!drill ? (
              <section className="usage-section" aria-labelledby="usage-breakdown">
                <div className="usage-section-head">
                  <h2 id="usage-breakdown">Breakdown</h2>
                  <div className="usage-dims" role="group" aria-label="Break down by">
                    {(["model", "source", "project", "profile", "day"] as Dimension[]).map((d) => (
                      <button key={d} className={`usage-dim ${dim === d ? "on" : ""}`} aria-pressed={dim === d} onClick={() => setDim(d)}>
                        {DIMENSION_LABEL[d]}
                      </button>
                    ))}
                  </div>
                </div>
                <BreakdownNote dim={dim} zone={zone} />
                <GroupTable
                  unreadChats={unreadChats}
                  groups={groups}
                  total={totalOf(totals.counts)}
                  sort={sort}
                  onSort={setSort}
                  dim={dim}
                  onDrill={(g) => {
                    setChatSort({ key: "total", dir: "desc" });
                    setDrill({ dim, key: g.key, label: g.label });
                  }}
                />
              </section>
            ) : (
              <section className="usage-section" aria-labelledby="usage-drill">
                <button className="back" onClick={closeDrill}>
                  <ArrowLeft size={15} /> Back to the breakdown
                </button>
                <h2 id="usage-drill" tabIndex={-1} ref={drillHeading}>
                  {DIMENSION_LABEL[drill.dim]}: {drill.dim === "day" ? fmt.day(drill.label) : drill.label}
                </h2>
                {drilled ? (
                  <>
                    <p className="usage-note">
                      {fmt.number(drilled.totals.chats)} {drilled.totals.chats === 1 ? "chat" : "chats"} · {tokens(totalOf(drilled.totals.counts))} tokens ·{" "}
                      {tallyLabel(drilled.totals.cost, { partial: unreadChats }).short}
                    </p>
                    <ChatTable chats={sortChats(drilled.chats, chatSort)} sort={chatSort} onSort={setChatSort} zone={zone} shownProfile={profile} onOpen={onOpenChat} />
                  </>
                ) : (
                  <p className="usage-note">No chats here match the filters now.</p>
                )}
              </section>
            )}
          </>
        ) : null}
        {/* Hermes's own sums stand apart from the chats: they show even when no chat matches, as for a period of only
            subagent runs and helper tasks. */}
        {data && !data.unsupported && data.period.days !== undefined && <HermesTotalsCard data={data} filtered={filtered} />}
        {data && !data.unsupported && data.period.days === undefined && (
          <p className="usage-note">Hermes's own sums, and its helper tasks' usage, cover only a period ending now: pick one of the "Last …" periods to see them.</p>
        )}
        {data && !data.unsupported && <Notes />}
      </div>
    </div>
  );
}

/** What couldn't be read, so a total that is short says so. */
function Problems({ data }: { data: UsageDataset }) {
  const { fmt } = useLocale();
  const lines: ReactNode[] = [];
  for (const p of data.profiles) {
    if (p.state === "failed")
      lines.push(
        p.read
          ? `Couldn't read all of the ${p.profile} profile: ${p.error}. Only the ${fmt.number(p.read)} chats read before that are counted, as far as they're in the period.`
          : `Couldn't read the ${p.profile} profile: ${p.error}. Its chats aren't counted.`,
      );
    if (p.state === "capped")
      lines.push(`The ${p.profile} profile has more chats in this period than Hermes Chat reads at once (${fmt.number(p.read)}); the oldest aren't counted. Pick a shorter period.`);
  }
  if (data.missingSegments)
    lines.push(
      `${fmt.number(data.missingSegments)} ${data.missingSegments === 1 ? "segment" : "segments"} of compressed chats couldn't be read${data.segmentsSkipped ? " (too many to read at once)" : ""}, so those chats are counted short and marked "+".`,
    );
  if (!lines.length) return null;
  return (
    <div className="usage-problems" role="alert">
      <strong>
        <CircleAlert size={14} /> These totals are partial.
      </strong>
      <ul>
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function TotalsTiles({ totals, partial }: { totals: Totals; partial: boolean }) {
  const { fmt } = useLocale();
  const c = totals.counts;
  const tile = (label: string, value: number, field?: CountField, sub?: string, short = false) => {
    const missing = field ? totals.unreported[field] : undefined;
    return (
      <div className="usage-tile">
        <dt>{label}</dt>
        <dd>
          {fmt.number(value)}
          {(missing || partial || short) && <span className="usage-plus" aria-label=" or more">+</span>}
        </dd>
        {sub && <dd className="usage-tile-sub">{sub}</dd>}
        {missing ? <dd className="usage-tile-sub">Not reported for {fmt.number(missing)} {missing === 1 ? "chat" : "chats"}</dd> : null}
      </div>
    );
  };
  return (
    <section className="usage-section" aria-labelledby="usage-tokens">
      <h2 id="usage-tokens">Tokens</h2>
      <dl className="usage-tiles">
        {tile("Total tokens", totalOf(c), undefined, "input + cache read + cache written + output", totals.totalShort > 0)}
        {tile("Input, not cached", c.input, "input")}
        {tile("Cache read", c.cacheRead, "cacheRead")}
        {tile("Cache written", c.cacheWrite, "cacheWrite")}
        {tile("Output", c.output, "output")}
        {tile("of which reasoning", c.reasoning, "reasoning", "already in Output")}
        {tile("Model calls", c.calls, "calls")}
        {tile("Chats", totals.chats, undefined, totals.noUsage ? `${fmt.number(totals.noUsage)} with no usage recorded` : undefined)}
      </dl>
      <p className="usage-note">
        Input, cache read and cache written don't overlap: together they are everything the model was sent. Reasoning is part of Output, so the total
        doesn't add it again. A "+" means some counts are missing, so the true figure is higher.
      </p>
    </section>
  );
}

/** The recorded cost, how much of the usage it covers, and by which kind. Never shown as a bill. */
/** `partial`: whole chats weren't read (a profile failed, or the page limit), so their cost is missing too. */
function CostCard({ totals, partial }: { totals: Totals; partial: boolean }) {
  const { fmt } = useLocale();
  const t = totals.cost;
  // A profile that couldn't be read, or chats past the page limit, are missing from the cost too.
  const label = tallyLabel(t, { partial });
  const short = label.short;
  const read = t.incomplete || partial ? " read" : "";
  const kinds = COST_KINDS.filter((k) => t.kinds[k].tokens > 0 || t.kinds[k].chats > 0);
  return (
    <section className="usage-section" aria-labelledby="usage-cost">
      <h2 id="usage-cost">Recorded cost</h2>
      <div className="usage-cost-head">
        <span className="usage-cost-big">{short}</span>
        <span className="usage-cost-cover">
          {t.tokens ? `covers ${pct(coverage(t))} of the tokens${read} in full` : "no model calls"} · not a bill
        </span>
      </div>
      <p className="usage-note">{label.detail}</p>
      {t.tokens > 0 && (
        <>
          <div className="usage-bar" role="img" aria-label={kinds.map((k) => `${COST_KIND_LABEL[k]}: ${pct(t.kinds[k].tokens / t.tokens)} of tokens`).join(", ")}>
            {kinds.map((k) =>
              t.kinds[k].tokens > 0 ? (
                <span
                  key={k}
                  className={`usage-bar-part cost-${k}`}
                  style={{ flexGrow: t.kinds[k].tokens }}
                  title={`${COST_KIND_LABEL[k]}: ${pct(t.kinds[k].tokens / t.tokens)} of tokens`}
                />
              ) : null,
            )}
          </div>
          <div className="ua-table-wrap">
            <table className="ua-table usage-cost-table">
              <thead>
                <tr>
                  <th scope="col">How Hermes got the cost</th>
                  <th scope="col">Chats</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Share of tokens</th>
                  <th scope="col">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {kinds.map((k) => (
                  <tr key={k}>
                    <th scope="row">
                      <span className={`usage-swatch cost-${k}`} aria-hidden /> {COST_KIND_LABEL[k]}
                    </th>
                    <td>{fmt.number(t.kinds[k].chats)}</td>
                    <td>{fmt.number(t.kinds[k].tokens)}</td>
                    <td>{pct(t.kinds[k].tokens / t.tokens)}</td>
                    <td>{k === "included" ? "No charge recorded" : k === "unknown" ? "None" : `${k === "actual" ? "" : "~"}${usd(t.kinds[k].usd)}${k === "partial" ? "+" : ""}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="usage-note">
        Hermes keeps one pricing status for each chat, its latest call's, and counts only the calls it could price. "At least" means the latest call had no
        price; "Unknown" means Hermes recorded no cost for the chat at all. A compressed chat can count under two kinds.
      </p>
    </section>
  );
}

function SortHeader({ col, sort, onSort, children }: { col: SortKey; sort: Sort; onSort: (s: Sort) => void; children: ReactNode }) {
  const on = sort.key === col;
  return (
    <th scope="col" aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button className="usage-sort" onClick={() => onSort({ key: col, dir: on && sort.dir === "desc" ? "asc" : on ? "desc" : col === "label" || col === "started" ? "asc" : "desc" })}>
        {children}
        {on && (sort.dir === "asc" ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />)}
      </button>
    </th>
  );
}

/** A group's count, "+" when some chat didn't report it or whole chats weren't read. */
const cell = (fmt: Formats, t: Totals, field: CountField, short: boolean) => (
  <>
    {field === "calls" ? fmt.number(t.counts.calls) : tokens(t.counts[field])}
    {t.unreported[field] || t.partialChats || short ? <span className="usage-plus">+</span> : null}
  </>
);

function GroupTable({
  groups,
  total,
  sort,
  onSort,
  dim,
  onDrill,
  unreadChats,
}: {
  groups: Group[];
  total: number;
  sort: Sort;
  onSort: (s: Sort) => void;
  dim: Dimension;
  onDrill: (g: Group) => void;
  /** Whole chats weren't read, so any group may be short of some. */
  unreadChats: boolean;
}) {
  const { fmt } = useLocale();
  /** A day group is keyed and sorted by its ISO day; it shows as a date. */
  const label = (g: Group) => (dim === "day" ? fmt.day(g.label) : g.label);
  return (
    <div className="ua-table-wrap">
      <table className="ua-table">
        <thead>
          <tr>
            <SortHeader col="label" sort={sort} onSort={onSort}>
              {DIMENSION_LABEL[dim]}
            </SortHeader>
            {COLUMNS.map((c) => (
              <SortHeader key={c.key} col={c.key} sort={sort} onSort={onSort}>
                <span title={c.label}>{c.short ?? c.label}</span>
              </SortHeader>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const sum = totalOf(g.totals.counts);
            const cost = tallyLabel(g.totals.cost, { partial: unreadChats });
            return (
              <tr key={g.key}>
                <th scope="row">
                  <button className="usage-drill" data-group={g.key} onClick={() => onDrill(g)} aria-label={`${label(g)}: show its ${g.totals.chats} chats`}>
                    <span className="usage-drill-label">{label(g)}</span>
                    <span className="usage-share" aria-hidden>
                      <span style={{ width: total ? `${(sum / total) * 100}%` : 0 }} />
                    </span>
                  </button>
                </th>
                <td>
                  {fmt.number(g.totals.chats)}
                  {unreadChats && <span className="usage-plus">+</span>}
                </td>
                {(["input", "cacheRead", "cacheWrite", "output", "reasoning", "calls"] as const).map((f) => (
                  <td key={f}>{cell(fmt, g.totals, f, unreadChats)}</td>
                ))}
                <td>
                  {tokens(sum)}
                  {g.totals.totalShort || unreadChats ? <span className="usage-plus">+</span> : null}
                </td>
                <td title={cost.detail}>{cost.short}</td>
                <td>{g.totals.cost.tokens ? `${pct(coverage(g.totals.cost))}${g.totals.cost.incomplete || unreadChats ? " of read" : ""}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ChatTable({ chats, sort, onSort, zone, shownProfile, onOpen }: { chats: UsageChat[]; sort: Sort; onSort: (s: Sort) => void; zone: string; shownProfile: string; onOpen: (c: UsageChat) => void }) {
  const { fmt } = useLocale();
  return (
    <div className="ua-table-wrap">
      <table className="ua-table usage-chats">
        <thead>
          <tr>
            <SortHeader col="label" sort={sort} onSort={onSort}>
              Chat
            </SortHeader>
            <SortHeader col="started" sort={sort} onSort={onSort}>
              Started
            </SortHeader>
            <th scope="col">Model last used</th>
            <SortHeader col="input" sort={sort} onSort={onSort}>
              Input
            </SortHeader>
            <SortHeader col="cacheRead" sort={sort} onSort={onSort}>
              Cache read
            </SortHeader>
            <SortHeader col="output" sort={sort} onSort={onSort}>
              Output
            </SortHeader>
            <SortHeader col="calls" sort={sort} onSort={onSort}>
              Calls
            </SortHeader>
            <SortHeader col="total" sort={sort} onSort={onSort}>
              Total
            </SortHeader>
            <SortHeader col="cost" sort={sort} onSort={onSort}>
              Cost
            </SortHeader>
          </tr>
        </thead>
        <tbody>
          {chats.map((c) => {
            const cost = chatCost(c);
            const mine = c.profile === shownProfile;
            return (
              <tr key={`${c.profile}\n${c.id}`}>
                <th scope="row">
                  {mine ? (
                    <button className="usage-drill" onClick={() => onOpen(c)} title="Open this chat">
                      <span className="usage-drill-label">{c.title}</span>
                    </button>
                  ) : (
                    <span className="usage-drill-label" title={`In the ${c.profile} profile: switch to it to open the chat`}>
                      {c.title}
                    </span>
                  )}
                  <span className="usage-chat-meta faint">
                    {sourceName(c.source)}
                    {!mine && ` · ${c.profile}`}
                    {c.archived && " · Archived"}
                    {c.segments.length + c.missing > 1 && ` · ${c.segments.length + c.missing} segments`}
                  </span>
                </th>
                <td>{fmt.day(dayIn(zone, c.startedAt))}</td>
                <td className="mono">{c.model ?? "—"}</td>
                {(["input", "cacheRead", "output", "calls"] as const).map((f) => (
                  <td key={f}>
                    {reportedNowhere(c, f) ? (
                      <span className="faint" title="Hermes didn't report this count">—</span>
                    ) : (
                      <>
                        {f === "calls" ? fmt.number(c.counts.calls) : tokens(c.counts[f])}
                        {(c.unreported.includes(f) || c.missing > 0) && (
                          <span className="usage-plus" title="Part of this chat didn't report this count, or couldn't be read">+</span>
                        )}
                      </>
                    )}
                  </td>
                ))}
                <td>
                  {tokens(totalOf(c.counts))}
                  {chatTotalShort(c) ? <span className="usage-plus">+</span> : null}
                </td>
                <td title={cost.detail}>{cost.short}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BreakdownNote({ dim, zone }: { dim: Dimension; zone: string }) {
  const text: Record<Dimension, string> = {
    model: "By the model each chat used last, as Hermes keeps it. A chat that changed model counts all its usage under its last one.",
    source: "By where each chat started. Scheduled jobs' runs are chats too.",
    project: "By the projects this computer has each chat in. A chat in two projects counts in both, so these rows can add up to more than the total. Other profiles' chats aren't in these projects.",
    profile: "By profile. Each profile keeps its own chats.",
    day: `By the day each chat started, on ${zone}'s clock. A chat's whole usage counts on that day, even what came later.`,
  };
  return <p className="usage-note">{text[dim]} Pick a row to see its chats.</p>;
}

/** Hermes's own sums for the same rolling period, beside what the chats add up to, and its helper tasks. */
function HermesTotalsCard({ data, filtered }: { data: UsageDataset; filtered: boolean }) {
  const { fmt } = useLocale();
  const checks = crossCheck(data);
  const unsupported = data.profiles.filter((p) => p.hermes?.state === "unsupported").map((p) => p.profile);
  const failed = data.profiles.flatMap((p) => (p.hermes?.state === "failed" ? [`${p.profile}: ${p.hermes.error}`] : []));
  const helpers = checks.flatMap((c) => c.hermes.helpers.map((h) => ({ ...h, profile: c.profile })));
  return (
    <section className="usage-section" aria-labelledby="usage-hermes">
      <h2 id="usage-hermes">Hermes's own totals</h2>
      <p className="usage-note">
        Hermes adds up every session it stored that started in the period, all profiles' read separately. That includes subagent runs and each segment of
        a compressed chat, which no chat list shows as chats, so its figures can be higher than the chats here. It has no cache-written count and no cost
        status.
        {filtered && " The project and model picked don't apply to Hermes's figures; they compare with all the chats read."}
      </p>
      {checks.length > 0 && (
        <div className="ua-table-wrap">
          <table className="ua-table">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Counted by</th>
                <th scope="col">Sessions</th>
                <th scope="col">Input</th>
                <th scope="col">Cache read</th>
                <th scope="col">Output</th>
                <th scope="col">Calls</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {checks.flatMap((c) => {
                const h = c.hermes;
                const t = totalsOf(data.chats.filter((x) => x.profile === c.profile));
                return [
                  <tr key={`${c.profile}-h`}>
                    <th scope="row" rowSpan={2}>
                      {c.profile}
                    </th>
                    <td>Hermes</td>
                    <td>{h.sessions !== undefined ? fmt.number(h.sessions) : "—"}</td>
                    <td>{h.input !== undefined ? fmt.number(h.input) : "—"}</td>
                    <td>{h.cacheRead !== undefined ? fmt.number(h.cacheRead) : "—"}</td>
                    <td>{h.output !== undefined ? fmt.number(h.output) : "—"}</td>
                    <td>{h.calls !== undefined ? fmt.number(h.calls) : "—"}</td>
                    <td>{h.estimatedUsd !== undefined ? `~${usd(h.estimatedUsd)}` : "—"}</td>
                  </tr>,
                  c.complete ? (
                    <tr key={`${c.profile}-c`}>
                      <td>Chats here</td>
                      <td>
                        {fmt.number(c.sessions)} in {fmt.number(c.chats)} chats
                      </td>
                      <td>{fmt.number(c.input)}</td>
                      <td>{fmt.number(c.cacheRead)}</td>
                      <td>{fmt.number(c.output)}</td>
                      <td>{fmt.number(c.calls)}</td>
                      <td>{tallyLabel(t.cost).short}</td>
                    </tr>
                  ) : (
                    <tr key={`${c.profile}-c`}>
                      <td>Chats here</td>
                      <td colSpan={6} className="usage-incomparable">
                        {c.incomparable === "chats"
                          ? "Not every chat in this profile could be read, so they don't compare."
                          : c.incomparable === "segments"
                            ? "Some segments of compressed chats couldn't be read, so they don't compare."
                            : "Some chats didn't report every count compared here, so they don't compare."}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      {checks.map((c) =>
        c.complete && c.hermes.sessions !== undefined && c.hermes.sessions > c.sessions ? (
          <p key={c.profile} className="usage-note">
            In {c.profile}, Hermes counts {fmt.number(c.hermes.sessions - c.sessions)} more sessions ({tokens(Math.max(0, (c.hermes.input ?? 0) - c.input))} more input) than the
            chats here hold: subagent runs, and segments of compressed chats that started earlier.
          </p>
        ) : null,
      )}
      {unsupported.length > 0 && <p className="usage-note">This Hermes has no usage sums of its own for {unsupported.join(", ")}, so there is nothing to compare.</p>}
      {failed.length > 0 && <p className="usage-note">Couldn't read Hermes's own sums for {failed.join("; ")}.</p>}
      {helpers.length > 0 && (
        <>
          <h3 className="usage-sub">Helper tasks</h3>
          <p className="usage-note">
            Hermes's own work around chats, such as titling, compression and background review. It is in no chat's usage and can't be filtered by project
            or model; Hermes estimates its cost.
          </p>
          <div className="ua-table-wrap">
            <table className="ua-table">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Profile</th>
                  <th scope="col">Models</th>
                  <th scope="col">Input</th>
                  <th scope="col">Output</th>
                  <th scope="col">Calls</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {helpers.map((h) => (
                  <tr key={`${h.profile}-${h.task}`}>
                    <th scope="row">{h.task.replace(/_/g, " ")}</th>
                    <td>{h.profile}</td>
                    <td className="mono">{h.models.join(", ") || "—"}</td>
                    <td>{fmt.number(h.input)}</td>
                    <td>{fmt.number(h.output)}</td>
                    <td>{fmt.number(h.calls)}</td>
                    <td>~{usd(h.estimatedUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Notes() {
  return (
    <section className="usage-section" aria-labelledby="usage-notes">
      <h2 id="usage-notes">What is counted</h2>
      <ul className="usage-notes">
        <li>Chats from every source and archived chats count; a chat counts in the period it started in, with all its usage so far.</li>
        <li>A compressed chat is one chat: its segments are read and added once each.</li>
        <li>Subagent runs and Hermes's helper tasks aren't in any chat's usage. Hermes's own totals above show them, for periods ending now.</li>
        <li>Projects come from this computer: chats added to a project in another Hermes Chat aren't known here.</li>
        <li>Nothing here is kept on this computer. Export CSV writes the chats counted here only where you save it.</li>
      </ul>
    </section>
  );
}
