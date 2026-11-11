// Settings → Memory → External memory: which memory provider each profile uses, and each provider's settings, as Hermes
// has them on the server (memoryProviders.ts, ADR 0045). The table shows every profile's provider and, for Honcho, which
// profiles share a store. Below it one profile at a time, which needn't be the one the app shows, can switch provider,
// change its settings, copy another profile's to share its memory, and install what a provider needs. Nothing is
// written until the owner saves; every write is checked against a fresh read and read back. Typed secrets live only in
// this form and go only to Hermes.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Copy, Download, ExternalLink, Info, RefreshCw, ChevronRight } from "lucide-react";
import {
  MemoryProvidersUnsupported,
  copiedValues,
  valueProblem,
  visible,
  type MemoryChange,
  type MemoryProvidersApi,
  type OverviewRow,
  type ProfileMemory,
  type ProviderField,
  type ProviderForm,
  type ProviderRow,
  type ProviderSetup,
  type SetupStep,
} from "../hermes/memoryProviders";
import { linkTarget } from "../hermes/preview";
import { SettingNote, SettingsSection } from "./SettingRows";
import { PreviewLink } from "./previewContext";
import { errorText } from "../hermes/values";

type Notice = { tone: "ok" | "warn" | "error"; text: string };
type Busy = "use" | "save" | "setup" | "copy";

const BUILT_IN = "Built-in only";
const providerName = (name: string) => name || BUILT_IN;

/** How each of Hermes's provider states reads here. */
const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" }> = {
  ready: { label: "Ready", tone: "ok" },
  needs_config: { label: "Needs settings", tone: "warn" },
  unavailable: { label: "Unavailable", tone: "warn" },
  missing: { label: "Not installed", tone: "bad" },
};
const statusOf = (s: string | undefined) => (s ? (STATUS[s] ?? { label: s, tone: "warn" as const }) : undefined);

function StatusBadge({ status }: { status?: string }) {
  const s = statusOf(status);
  return s ? <span className={`badge provider-status ${s.tone}`}>{s.label}</span> : null;
}

/** How Hermes's setup step results read here (`_command_result`, `prepare_memory_provider_dependencies`). */
const STEP: Record<string, string> = {
  installed: "installed",
  already_installed: "already installed",
  verified: "installed and checked",
  missing: "not found, so installing",
  failed: "failed",
  no_declared_steps: "nothing to install",
  restart_required: "installed; restart Hermes to use it",
};

/** What `row` needs before it can be used, in a sentence; undefined when it's ready. */
function whyNotReady(row: ProviderRow): string | undefined {
  if (row.status === "ready") return undefined;
  if (row.status === "missing") return "Hermes can't find this provider for the profile any more. Install it again on the server, or pick another.";
  if (!row.setup.installed) return "What it needs isn't installed on the server yet.";
  if (row.status === "needs_config") return "Its settings aren't complete: fill in what it requires, such as an API key.";
  return "It reports it can't run with its settings as they are. Check them, such as the API key.";
}

/** What a write came to, for the owner. `label`: what was being done, such as "Saved Honcho for research". */
function noticeOf(change: MemoryChange, done: string, profile: string): Notice {
  switch (change.kind) {
    case "saved":
      return { tone: "ok", text: `${done}, and read back from Hermes. Chats started on ${profile} from now on use it.` };
    case "conflict":
      return { tone: "warn", text: `Nothing was sent: ${change.what === "provider" ? `the provider ${profile} uses` : change.what} changed on the server since you opened it. This shows what Hermes has now.` };
    case "refused":
      return {
        tone: "error",
        text: change.wrote
          ? `Hermes saved the settings but didn't switch ${profile} to this provider: ${change.reason}`
          : `Hermes refused: ${change.reason}`,
      };
    case "mismatch":
      return {
        tone: "warn",
        text: change.fields.length
          ? `Hermes took it, but reading back shows ${change.fields.join(", ")} differently. This shows what Hermes has now.`
          : `Hermes took it, but reading back shows ${providerName(change.memory.active)} in use on ${profile}.`,
      };
    case "unknown":
      return { tone: "warn", text: `Hermes didn't confirm it (${change.reason}), and reading back doesn't show it. It may yet land; Reload to check.` };
  }
}

export function MemoryProviderSettings({
  api,
  profile,
  connected,
  onDirtyChange,
  discardSignal = 0,
  target: targetProp,
  onProfiles,
  onPick,
  overview = "table",
}: {
  api: MemoryProvidersApi;
  /** The profile to manage, chosen outside (Settings' Memory list, ADR 0113); the owner has already agreed to leave unsaved changes. */
  target?: string;
  /** Called with every profile's name once they're read, for a list drawn elsewhere. */
  onProfiles?: (profiles: string[]) => void;
  /** With `target` from outside: a profile picked in the table goes here, so the list elsewhere follows it. */
  onPick?: (profile: string) => void;
  /** "folded": the all-profiles table sits under a fold, since a list elsewhere already names them. */
  overview?: "table" | "folded";
  /** The profile the app shows, which the screen starts on. */
  profile: string;
  connected: boolean;
  /** Called with whether a setting has an unsaved change, and with false once this goes. */
  onDirtyChange: (dirty: boolean) => void;
  /** Changes when the owner chose to discard unsaved changes from outside, which drops them here too. */
  discardSignal?: number;
}) {
  const [rows, setRows] = useState<OverviewRow[]>();
  const [overviewError, setOverviewError] = useState<string>();
  const [unsupported, setUnsupported] = useState<string>();
  const [target, setTarget] = useState(profile);
  const [memory, setMemory] = useState<ProfileMemory>();
  const [memoryError, setMemoryError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [form, setForm] = useState<ProviderForm>();
  const [formError, setFormError] = useState<string>();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Busy>();
  const [notice, setNotice] = useState<Notice>();
  const [confirmSetup, setConfirmSetup] = useState(false);
  const [steps, setSteps] = useState<{ provider: string; ok: boolean; steps: SetupStep[] }>();
  const [copyFrom, setCopyFrom] = useState("");
  // Leaving the open provider or profile with unsaved changes asks first; this is what it would do.
  const [leaving, setLeaving] = useState<() => void>();
  const alive = useRef(true);
  const reads = useRef(0);

  const dirty = Object.keys(edits).length > 0;
  useEffect(() => {
    onDirtyChange(dirty);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [dirty]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onDirtyChange(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, []);
  const discards = useRef(discardSignal);
  useEffect(() => {
    if (discardSignal === discards.current) return;
    discards.current = discardSignal;
    setEdits({});
    setLeaving(undefined);
  }, [discardSignal]);

  // Only the latest read of the table counts: two writes in a row each read it again, and may answer out of order.
  const overviews = useRef(0);
  const loadOverview = async () => {
    const n = ++overviews.current;
    setOverviewError(undefined);
    try {
      const next = await api.overview(await api.profiles());
      if (alive.current && n === overviews.current) setRows(next);
    } catch (e) {
      if (alive.current && n === overviews.current) setOverviewError(errorText(e));
    }
  };

  /** Reads `who`'s providers and, if one is open, its settings; a later read wins over an earlier one. */
  const loadProfile = async (who: string, provider = open) => {
    const n = ++reads.current;
    setMemoryError(undefined);
    try {
      const m = await api.read(who);
      if (!alive.current || n !== reads.current) return;
      setMemory(m);
      setUnsupported(undefined);
      if (provider) await loadForm(who, provider, n);
    } catch (e) {
      if (!alive.current || n !== reads.current) return;
      if (e instanceof MemoryProvidersUnsupported) setUnsupported(e.message);
      else setMemoryError(errorText(e));
    }
  };

  const loadForm = async (who: string, name: string, n = ++reads.current) => {
    setFormError(undefined);
    try {
      const f = await api.form(who, name);
      if (alive.current && n === reads.current) setForm(f);
    } catch (e) {
      if (alive.current && n === reads.current) setFormError(`Couldn't read ${name}'s settings: ${errorText(e)}`);
    }
  };

  useEffect(() => {
    if (!connected || memory || unsupported) return;
    void loadOverview();
    void loadProfile(target);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [connected]);

  /** Runs `go` now, or once the owner agrees to drop unsaved changes. */
  const leave = (go: () => void) => {
    const run = () => {
      setLeaving(undefined);
      setEdits({});
      setNotice(undefined);
      setConfirmSetup(false);
      go();
    };
    if (dirty) setLeaving(() => run);
    else run();
  };

  const manage = (who: string) => {
    if (busy || who === target) return;
    leave(() => switchTo(who));
  };
  // A profile picked outside shows once no write or read is under way, as `manage` waits, so a late answer can't land on it.
  useEffect(() => {
    if (targetProp !== undefined && targetProp !== target && !busy) {
      setEdits({});
      setNotice(undefined);
      setConfirmSetup(false);
      switchTo(targetProp);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [targetProp, busy]);
  useEffect(() => {
    if (rows) onProfiles?.(rows.map((r) => r.profile));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [rows]);
  const switchTo = (who: string) => {
    {
      setTarget(who);
      setMemory(undefined);
      setOpen(undefined);
      setForm(undefined);
      setCopyFrom("");
      setSteps(undefined);
      void loadProfile(who, undefined);
    }
  };

  const openProvider = (name: string) => {
    if (busy || name === open) return;
    leave(() => {
      setOpen(name);
      setForm(undefined);
      setCopyFrom("");
      setSteps(undefined);
      void loadForm(target, name);
    });
  };

  /** Shows what a write left, and reads the overview again, since a profile's provider or store may have changed. */
  const settle = (change: MemoryChange, done: string) => {
    if (change.memory) setMemory(change.memory);
    if (change.form) setForm(change.form);
    // Saved, or written though Hermes refused to switch: nothing is left unsaved. Otherwise only what Hermes now has
    // as typed stops counting as a change; a typed secret stays, as Hermes never says what it holds.
    if (change.kind === "saved" || (change.kind === "refused" && change.wrote)) setEdits({});
    else if (change.form) {
      const fields = change.form.fields;
      setEdits((e) => Object.fromEntries(Object.entries(e).filter(([k, v]) => fields.some((f) => f.key === k && (f.kind === "secret" || f.value !== v)))));
    }
    setNotice(noticeOf(change, done, target));
    void loadOverview();
  };

  const use = async (name: string) => {
    if (!memory || busy) return;
    setBusy("use");
    setNotice(undefined);
    try {
      const change = await api.use(target, name, memory.active);
      if (alive.current) settle(change, name ? `${target} now uses ${name}` : `${target} now uses built-in memory only`);
    } catch (e) {
      if (alive.current) setNotice({ tone: "error", text: errorText(e) });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const save = async () => {
    if (!form || busy || !dirty) return;
    setBusy("save");
    setNotice(undefined);
    try {
      const change = await api.save(form, edits, memory?.active ?? "");
      if (alive.current) settle(change, `Saved ${form.label} for ${target}`);
    } catch (e) {
      if (alive.current) setNotice({ tone: "error", text: `${errorText(e)} Your changes are still here.` });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const copy = async () => {
    if (!form || !copyFrom || busy) return;
    setBusy("copy");
    setNotice(undefined);
    try {
      // The target read again too, so the copy is measured against what Hermes has now, not when it was opened.
      const [source, fresh] = await Promise.all([api.form(copyFrom, form.name), api.form(target, form.name)]);
      if (!alive.current) return;
      setForm(fresh);
      if (source.surface !== form.surface || !source.fields.length) {
        setNotice({ tone: "warn", text: `${copyFrom} has no ${form.label} settings this app can copy.` });
        return;
      }
      const values = copiedValues(source, fresh);
      setEdits((e) => ({ ...Object.fromEntries(Object.entries(e).filter(([k]) => fresh.fields.find((f) => f.key === k)?.kind === "secret")), ...values }));
      const secrets = fresh.fields.filter((f) => f.kind === "secret");
      const missing = secrets.filter((f) => !f.isSet);
      setNotice({
        tone: "ok",
        text:
          (Object.keys(values).length
            ? `Copied ${Object.keys(values).length} setting${Object.keys(values).length === 1 ? "" : "s"} from ${copyFrom}. Check them, then Save to use them on ${target}.`
            : `${target} already has ${copyFrom}'s settings.`) +
          (missing.length ? ` ${missing.map((f) => f.label).join(", ")} isn't copied, as Hermes never sends it back: type it here.` : ""),
      });
    } catch (e) {
      if (alive.current) setNotice({ tone: "error", text: `Couldn't read ${copyFrom}'s settings: ${errorText(e)}` });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const install = async (name: string, confirmed: ProviderSetup) => {
    if (busy) return;
    setBusy("setup");
    setConfirmSetup(false);
    setNotice(undefined);
    try {
      const out = await api.setup(target, name, confirmed);
      if (!alive.current) return;
      if (out.kind === "done") {
        if (out.memory) setMemory(out.memory);
        setSteps({ provider: name, ok: out.ok, steps: out.steps });
        // `restart_required`: the packages are ready, but the running Hermes isn't using that environment yet.
        const restart = out.steps.some((s) => s.status === "restart_required");
        setNotice(
          !out.ok
            ? { tone: "error", text: `Some of ${name}'s setup failed on the server. Its output is below.` }
            : restart
              ? { tone: "warn", text: `Hermes installed ${name}'s requirements on the server. Restart Hermes there before chats can use them.` }
              : { tone: "ok", text: `Hermes ran ${name}'s setup on the server.` },
        );
        void loadOverview();
      } else if (out.kind === "changed") {
        setMemory(out.memory);
        setNotice({ tone: "warn", text: `Nothing was run: what ${name} needs installed changed on the server since you looked. Check it below and install again.` });
      } else setNotice({ tone: out.kind === "refused" ? "error" : "warn", text: out.kind === "refused" ? `Hermes refused: ${out.reason}` : `Hermes didn't confirm the setup (${out.reason}). Reload to see where it got to.` });
    } catch (e) {
      if (alive.current) setNotice({ tone: "error", text: errorText(e) });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const reload = () => {
    if (busy) return;
    leave(() => {
      void loadOverview();
      void loadProfile(target);
    });
  };

  // Which profiles share a store with each one, by the settings that pick it.
  const sharing = (row: OverviewRow) =>
    row.ok && row.store
      ? (rows ?? []).filter((r) => r.profile !== row.profile && r.ok && r.store?.key === row.store!.key).map((r) => r.profile)
      : [];
  const valueOf = (f: ProviderField) => edits[f.key] ?? f.value;
  const values = form ? Object.fromEntries(form.fields.map((f) => [f.key, valueOf(f)])) : {};
  const edit = (f: ProviderField, v: string) =>
    setEdits((e) => {
      const next = { ...e };
      if (f.kind === "secret" ? v === "" : v === f.value) delete next[f.key];
      else next[f.key] = v;
      return next;
    });
  const shown = form?.fields.filter((f) => visible(f, values)) ?? [];
  const problems = shown.flatMap((f) => (f.key in edits ? [valueProblem(f, edits[f.key])].filter(Boolean) : []));
  const openRow = memory?.providers.find((p) => p.name === open);
  const sharers = (rows ?? []).filter((r) => r.ok && r.active === open && r.profile !== target).map((r) => r.profile);

  const renderField = (f: ProviderField) => {
    const v = valueOf(f);
    const changed = f.key in edits;
    const problem = changed ? valueProblem(f, edits[f.key]) : undefined;
    const id = `provider-field-${f.key}`;
    const hint = problem ?? (f.shared && changed ? `Hermes keeps this once for every profile that reads the same ${form?.label ?? ""} config file, not only ${target}.` : undefined) ?? (f.kind === "secret" ? (f.isSet ? "Set on the server. Type a new one to replace it; Hermes never sends it back." : "Not set on the server.") : !v && f.inUse ? `Blank uses ${f.inUse}.` : f.description);
    return (
      <label key={f.key} className={`field provider-field ${f.kind === "bool" ? "check" : ""}`} htmlFor={id}>
        <span className="field-label">
          {f.label}
          {f.required && <span className="muted small">required</span>}
          {changed && <span className="badge warn">Unsaved</span>}
          {f.shared && <span className="badge" title="Kept once in the provider's config file, for every profile that reads it">All profiles on this file</span>}
        </span>
        {f.kind === "select" ? (
          <select id={id} value={v} disabled={!!busy} onChange={(e) => edit(f, e.target.value)}>
            {!f.options.some((o) => o.value === v) && <option value={v}>{v || "(none)"}</option>}
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : f.kind === "bool" ? (
          <input id={id} type="checkbox" checked={["1", "true", "yes", "on"].includes(v.toLowerCase())} disabled={!!busy} onChange={(e) => edit(f, e.target.checked ? "true" : "false")} />
        ) : f.kind === "json" ? (
          <textarea id={id} className="memory-text mono" rows={3} spellCheck={false} value={v} placeholder={f.placeholder} disabled={!!busy} onChange={(e) => edit(f, e.target.value)} />
        ) : (
          <input
            id={id}
            type={f.kind === "secret" ? "password" : "text"}
            inputMode={f.kind === "number" ? "decimal" : undefined}
            autoComplete="off"
            spellCheck={false}
            value={v}
            placeholder={f.kind === "secret" ? (f.isSet ? "•••••••• (set)" : f.placeholder || "Not set") : f.placeholder}
            disabled={!!busy}
            onChange={(e) => edit(f, e.target.value)}
          />
        )}
        {hint && <span className={`field-hint block ${problem ? "err" : ""}`}>{hint}</span>}
        {f.kind === "secret" && (
          <WebPageLink href={f.url} className="field-hint">
            Get one <ExternalLink size={11} />
          </WebPageLink>
        )}
      </label>
    );
  };

  /** The fields under their headings, in the order Hermes lists them. */
  const grouped = (fields: ProviderField[]) => {
    const groups = [...new Set(fields.map((f) => f.group))];
    return groups.map((g) => (
      <div key={g || "-"} className="provider-group">
        {g && <div className="provider-group-name">{g}</div>}
        {fields.filter((f) => f.group === g).map(renderField)}
      </div>
    ));
  };

  const overviewTable = (
    <>
          {overviewError ? (
            <div className="memory-state error" role="alert">
              <AlertTriangle size={14} />
              <div className="small">Couldn't list the profiles' providers: {overviewError}</div>
            </div>
          ) : !rows ? (
            <div className="memory-state" role="status">
              <div className="small muted">Reading each profile's provider from Hermes…</div>
            </div>
          ) : (
            <div className="provider-table-wrap">
              <table className="provider-table" aria-label="Memory provider by profile">
                <thead>
                  <tr>
                    <th scope="col">Profile</th>
                    <th scope="col">Provider</th>
                    <th scope="col">Memory store</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const with_ = sharing(r);
                    return (
                      <tr key={r.profile} className={r.profile === target ? "on" : undefined} aria-current={r.profile === target || undefined}>
                        <th scope="row">
                          <button className="link-btn mono" disabled={!!busy} onClick={() => (targetProp !== undefined && onPick ? onPick(r.profile) : manage(r.profile))} title={`Manage ${r.profile}'s provider below`}>
                            {r.profile}
                          </button>
                          {r.profile === profile && <div className="muted small">shown in the app</div>}
                        </th>
                        {r.ok ? (
                          <>
                            <td>
                              <span className={r.active ? "mono" : "muted"}>{providerName(r.active)}</span> {r.active && r.status !== "ready" && <StatusBadge status={r.status} />}
                            </td>
                            <td className="small">
                              {r.store ? (
                                <>
                                  {r.store.parts.map((p) => (
                                    <div key={p.label}>
                                      <span className="muted">{p.label}:</span> <span className="mono">{p.value}</span>
                                    </div>
                                  ))}
                                  <div className={`provider-sharing ${with_.length ? "" : "muted"}`}>{with_.length ? `Same store as ${with_.join(", ")}` : "No other profile on this store"}</div>
                                </>
                              ) : (
                                <span className="muted">{r.active ? "Set by its settings" : "Its own files"}</span>
                              )}
                            </td>
                          </>
                        ) : (
                          <td colSpan={2} className="small err-text">
                            Couldn't read: {r.reason}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
    </>
  );
  /** What a write came to; `note`: as a line across the card, rather than in the open provider's settings. */
  const noticeLine = (n: Notice, note: boolean) => {
    const kind = n.tone === "ok" ? "ok" : n.tone === "warn" ? "unsure" : "error";
    const body = (
      <>
        {n.tone === "ok" ? <Check size={14} /> : <AlertTriangle size={14} />}
        <span>{n.text}</span>
      </>
    );
    const role = n.tone === "ok" ? "status" : "alert";
    return note ? (
      <SettingNote tone={n.tone === "ok" ? "muted" : n.tone === "warn" ? "warn" : "bad"} role={role} className={`memory-notice ${kind}`}>
        {body}
      </SettingNote>
    ) : (
      <div className={`memory-notice ${kind}`} role={role}>
        {body}
      </div>
    );
  };

  // The open provider's settings, under its row in the list (ADR 0059), with what a write to them came to.
  const editorBlock = open && openRow && memory && (
    <div className="set-block provider-editor" role="group" aria-label={`${open} settings for ${target}`}>
      {whyNotReady(openRow) && (
        <div className="memory-state warn" role="status">
          <AlertTriangle size={14} />
          <div className="small">{whyNotReady(openRow)}</div>
        </div>
      )}

      {(openRow.setup.python || openRow.setup.external.length > 0) && (
        <div className="provider-setup">
          <div className="provider-group-name">On the server</div>
          <div className="small">
            {openRow.setup.installed ? (
              <span>
                <Check size={12} /> What it needs is installed.
              </span>
            ) : (
              <span>Not installed yet.</span>
            )}
          </div>
          {openRow.setup.pip.length > 0 && <div className="small muted">Python packages, into its own environment: <span className="mono">{openRow.setup.pip.join(", ")}</span></div>}
          {openRow.setup.external.map((d) => (
            <div key={d.name} className="small muted">
              {d.name}: <span className="mono">{d.install || "(no install command)"}</span>
            </div>
          ))}
          {confirmSetup ? (
            <div className="confirm" role="alertdialog" aria-label={`Install ${open} on the server?`}>
              <span className="confirm-msg">
                Hermes will run these on the server, as its own user, for {target}:
              </span>
              <span className="confirm-detail">
                {[...(openRow.setup.python ? ["hermes pm install (Python packages)"] : []), ...openRow.setup.external.filter((d) => d.install).map((d) => d.install)].join("\n")}
              </span>
              <div className="confirm-actions">
                <button className="btn" autoFocus onClick={() => setConfirmSetup(false)}>
                  Cancel
                </button>
                <button className="btn primary" disabled={!connected || !!busy} onClick={() => void install(open, openRow.setup)}>
                  Install
                </button>
              </div>
            </div>
          ) : (
            !openRow.setup.installed && (
              <div>
                <button className="btn" disabled={!connected || !!busy} onClick={() => setConfirmSetup(true)}>
                  <Download size={14} /> {busy === "setup" ? "Installing…" : "Install on the server"}
                </button>
              </div>
            )
          )}
          {steps?.provider === open && (
            <ul className="provider-steps small" aria-label="Setup output">
              {steps.steps.map((s, i) => (
                <li key={i}>
                  <span className={s.status === "failed" ? "err-text" : ""}>
                    {s.name} — {STEP[s.status] ?? s.status.replace(/_/g, " ")}
                  </span>
                  {s.command && <span className="mono muted"> {s.command}</span>}
                  {s.output && <pre className="provider-output">{s.output}</pre>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {formError ? (
        <div className="memory-state error" role="alert">
          <AlertTriangle size={14} />
          <div className="small">{formError}</div>
          <button className="btn" disabled={!connected} onClick={() => void loadForm(target, open)}>
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      ) : !form || form.name !== open ? (
        <div className="small muted">Reading {open}'s settings…</div>
      ) : (
        <>
          {sharers.length > 0 && (
            <div className="provider-copy">
              <label className="field">
                <span className="field-label">Copy settings from another profile on {open}</span>
                <select value={copyFrom} disabled={!!busy} onChange={(e) => setCopyFrom(e.target.value)}>
                  <option value="">Choose a profile…</option>
                  {sharers.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn" disabled={!copyFrom || !!busy} onClick={() => void copy()}>
                <Copy size={14} /> {busy === "copy" ? "Copying…" : "Copy"}
              </button>
              <span className="field-hint block">To share a profile's memory, copy its settings: both then point at the same store. API keys aren't copied.</span>
            </div>
          )}
          {form.fields.length === 0 ? (
            <p className="small muted">This provider has no settings Hermes lets another app change.</p>
          ) : (
            <>
              {grouped(shown.filter((f) => f.main))}
              {shown.some((f) => !f.main) && (
                <details className="provider-more">
                  <summary>More settings ({shown.filter((f) => !f.main).length})</summary>
                  {grouped(shown.filter((f) => !f.main))}
                </details>
              )}
            </>
          )}
          <WebPageLink href={form.docsUrl} className="link small provider-docs">
            {form.label} documentation <ExternalLink size={11} />
          </WebPageLink>
          <div className="confirm-actions">
            {dirty && (
              <button className="btn" disabled={!!busy} onClick={() => setEdits({})}>
                Cancel
              </button>
            )}
            {dirty ? (
              <button className="btn primary" disabled={!connected || !!busy || problems.length > 0} onClick={() => void save()}>
                {busy === "save" ? "Saving…" : `Save and use for ${target}`}
              </button>
            ) : memory.active === open ? (
              <span className="small muted">{target} uses {open}.</span>
            ) : (
              <button className="btn primary" disabled={!connected || !!busy || openRow.status !== "ready"} title={openRow.status !== "ready" ? "Hermes uses a provider only once it's ready." : undefined} onClick={() => void use(open)}>
                {busy === "use" ? "Switching…" : `Use for ${target}`}
              </button>
            )}
          </div>
        </>
      )}
      {notice && noticeLine(notice, false)}
    </div>
  );

  const shows = !unsupported && (connected || !!rows);
  // The settings show under their row only while the list does.
  const editorShown = !!editorBlock && !memoryError;
  return (
    <>
      <SettingsSection
        title="External memory"
        titleId="external-memory-heading"
        className="external-memory"
        intro="Besides its built-in memory, each profile can use one external memory provider, such as Honcho, that keeps what the agent learns in its own store."
        more={
          <p>
            Profiles use the same memory only when they use the same provider pointed at the same store; otherwise each keeps its own. For Honcho, the
            table lists the server, workspace and peers each profile uses, and which profiles match. Matching profiles share memory when they also use the
            same Honcho account.
          </p>
        }
        action={
          shows && (
            <button className="btn" disabled={!connected || !!busy} onClick={reload} title="Read every profile's provider from Hermes again.">
              <RefreshCw size={14} /> Reload
            </button>
          )
        }
      >
        {unsupported ? (
          <SettingNote role="status">
            <Info size={14} />
            <span>{unsupported}</span>
          </SettingNote>
        ) : !shows ? (
          <SettingNote role="status">Not connected to Hermes. Providers show once it's connected.</SettingNote>
        ) : overview === "folded" ? (
          <div className="set-block">
            <details className="disc provider-fold">
              <summary>
                <ChevronRight size={13} className="disc-chev" aria-hidden /> All profiles and their stores
              </summary>
              {overviewTable}
            </details>
          </div>
        ) : (
          <div className="set-block provider-overview">
            <h3>Profiles</h3>
            {overviewTable}
          </div>
        )}
      </SettingsSection>

      {shows && (
        <SettingsSection
          title={`Provider for ${target}`}
          titleId="provider-manage-heading"
          more={
            <>
              <p>
                Saving a provider's settings also makes it the profile's provider, as Hermes does. Hermes picks the provider when it starts a chat's agent,
                so chats started after a change use it; a chat already going keeps the one it started with. The built-in memory above stays on with any
                provider.
              </p>
              <p>
                The list holds the providers Hermes finds for the profile: those bundled with Hermes and those installed in the profile's plugins. To add
                another from Hermes's plugin catalog, such as Mem0 or Hindsight, run <code>hermes -p {target} plugins install &lt;name&gt;</code> on the
                server, then Reload.
              </p>
            </>
          }
        >
          {leaving && (
            <div className="set-block confirm set-confirm" role="alertdialog" aria-label="Discard your changes?">
              <span className="confirm-msg">Discard your unsaved provider settings? Nothing of them has been sent to Hermes.</span>
              <div className="confirm-actions">
                <button className="btn" autoFocus onClick={() => setLeaving(undefined)}>
                  Keep editing
                </button>
                <button className="btn danger" onClick={leaving}>
                  Discard changes
                </button>
              </div>
            </div>
          )}
          {memoryError ? (
            <SettingNote tone="bad" role="alert" className="memory-problem">
              <AlertTriangle size={14} />
              <div>Couldn't read {target}'s providers: {memoryError}</div>
              <button className="btn" disabled={!connected} onClick={() => void loadProfile(target)}>
                <RefreshCw size={14} /> Try again
              </button>
            </SettingNote>
          ) : !memory ? (
            <SettingNote role="status">Reading {target}'s providers from Hermes…</SettingNote>
          ) : (
            <ul className="provider-list memory-provider-list" aria-label={`Memory providers for ${target}`}>
              <li>
                <div className={`provider-row ${memory.active === "" ? "active" : ""}`}>
                  <div className="provider-row-main">
                    <span className="provider-row-name">{BUILT_IN}</span>
                    {memory.active === "" && <span className="badge provider-status ok">In use</span>}
                    <div className="muted small">Only the two memory files above. Turns off the external provider; what it stored stays where it is.</div>
                  </div>
                  {memory.active !== "" && (
                    <button className="btn" disabled={!connected || !!busy} onClick={() => leave(() => void use(""))}>
                      {busy === "use" ? "Switching…" : `Use for ${target}`}
                    </button>
                  )}
                </div>
              </li>
              {memory.providers.map((p) => (
                <li key={p.name}>
                  <button className={`provider-row ${memory.active === p.name ? "active" : ""} ${open === p.name ? "on" : ""}`} aria-expanded={open === p.name} disabled={!!busy && open !== p.name} onClick={() => openProvider(p.name)}>
                    <div className="provider-row-main">
                      <span className="provider-row-name mono">{p.name}</span>
                      {memory.active === p.name && <span className="badge provider-status ok">In use</span>}
                      <StatusBadge status={p.status} />
                      <div className="muted small">{p.description}</div>
                    </div>
                  </button>
                  {open === p.name && editorBlock}
                </li>
              ))}
              {memory.active && !memory.providers.some((p) => p.name === memory.active) && (
                <li>
                  <div className="provider-row active">
                    <div className="provider-row-main">
                      <span className="provider-row-name mono">{memory.active}</span> <span className="badge provider-status ok">In use</span> <StatusBadge status="missing" />
                      <div className="muted small">The profile names this provider, but Hermes doesn't find it installed for {target}, so chats run with built-in memory only.</div>
                    </div>
                  </div>
                </li>
              )}
            </ul>
          )}
          {notice && !editorShown && noticeLine(notice, true)}
        </SettingsSection>
      )}
    </>
  );
}

function WebPageLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  const link = linkTarget(href, location.origin);
  if (!link || link.kind === "elsewhere") return null;
  return (
    <PreviewLink href={link.url} className={className} click="menu">
      {children}
    </PreviewLink>
  );
}
