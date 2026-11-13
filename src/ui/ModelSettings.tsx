// Settings → Model: the main model, subagents, auxiliary (helper task) models and the guardrails, as Hermes has them
// for the profile shown. Edits are one draft held here until a part is applied; leaving Settings drops it without
// asking, as the official desktop app does. Reads and writes: modelSettings.ts.
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { CircleDollarSign, Pin, RotateCcw, ShieldAlert, TriangleAlert } from "lucide-react";
import {
  AUX_AUTO,
  AUX_INHERIT,
  EFFORT_LEVELS,
  EFFORT_OFF,
  SUBAGENT_ROUTES,
  TEXT_TASK,
  auxChanged,
  auxPinWarning,
  auxProblem,
  chooseAuxProvider,
  chooseProvider,
  chooseRoute,
  draftFrom,
  mainChanged,
  mainProblem,
  pinnedElsewhere,
  subagentChanged,
  subagentProblem,
  type AuxDraft,
  type AuxTask,
  type CatalogProvider,
  type Draft,
  type ModelSettings as Settings,
  type ModelSettingsApi,
  type PinnedWarning,
  type SubagentRoute,
} from "../hermes/modelSettings";
import { isEffort, type ModelCatalog, type ModelPick } from "../hermes/models";
import { getUIPrefs, subscribe as subscribeUIPrefs, toggleModelFavorite } from "../hermes/uiPrefs";
import { ModelCombobox } from "./ModelCombobox";
import { ModelControls } from "./ModelPicker";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { AppliesBox, AppliesPart, HeadPart } from "./SettingsPage";
import { errorText } from "../hermes/values";

const EFFORT_LABEL: Record<string, string> = {
  [EFFORT_OFF]: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
const ROUTE_LABEL: Record<SubagentRoute, string> = {
  inherit: "Inherit from main agent",
  "parent-model": "Use parent model",
  "custom-model": "Custom model (use parent credentials)",
  provider: "Another provider and model",
};

type Part = "main" | "subagent" | "auxiliary";
/** A guardrail waiting for the owner's answer before the main model is applied. */
type Ask =
  | { kind: "pinned"; warning: PinnedWarning }
  | { kind: "expensive"; part: "main"; message: string }
  /** `confirmed`: the helper tasks to send confirmed on Switch anyway, this one among them. */
  | { kind: "expensive"; part: "auxiliary"; message: string; task: string; confirmed: string[] };
const askPart = (a: Ask): Part => (a.kind === "pinned" ? "main" : a.part);

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const providerName = (providers: CatalogProvider[], slug: string) => providers.find((p) => p.slug === slug)?.name ?? slug;

/** The catalog's providers; one Hermes has that the catalog no longer lists stays on offer. */
function ProviderSelect({ label, value, providers, onChange }: { label: string; value: string; providers: CatalogProvider[]; onChange: (slug: string) => void }) {
  const listed = providers.some((p) => p.slug === value);
  return (
    <select className="select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && (
        <option value="" disabled>
          Choose a provider…
        </option>
      )}
      {value && !listed && <option value={value}>{value}</option>}
      {providers.map((p) => (
        <option key={p.slug} value={p.slug}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/** The provider's models. Empty until one is picked: switching provider never keeps the old provider's model. */
function ModelSelect({ label, value, provider, providers, onChange }: { label: string; value: string; provider: string; providers: CatalogProvider[]; onChange: (m: string) => void }) {
  const models = providers.find((p) => p.slug === provider)?.models ?? [];
  return (
    <ModelCombobox
      label={label}
      value={value}
      models={models}
      disabled={!provider}
      placeholder={provider ? "Choose a model…" : "Choose a provider first"}
      onChange={onChange}
    />
  );
}

function EffortSelect({ label, value, first, disabled, onChange }: { label: string; value: string; first: [string, string]; disabled?: boolean; onChange: (e: string) => void }) {
  return (
    <select className="select" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value={first[0]}>{first[1]}</option>
      <option value={EFFORT_OFF}>Off</option>
      {EFFORT_LEVELS.map((l) => (
        <option key={l} value={l}>
          {EFFORT_LABEL[l]}
        </option>
      ))}
    </select>
  );
}

/** A part's state and its Discard and Apply, or the guardrail asked in their place. */
function ApplyRow({
  name,
  changed,
  problem,
  error,
  done,
  busy,
  disabled,
  ask,
  onDiscard,
  onApply,
}: {
  name: string;
  changed: boolean;
  problem?: string;
  error?: string;
  done?: boolean;
  busy: boolean;
  disabled: boolean;
  ask?: ReactNode;
  onDiscard: () => void;
  onApply: () => void;
}) {
  // Beside Discard and Apply: a change waits on this screen until it's applied, and leaving Settings drops it.
  const note = error ?? (changed ? (problem ?? "Not applied yet. Leaving Settings drops it.") : done ? "Applied. New chats use it." : "Same as Hermes. Changes wait here until you apply them.");
  // The card's last line: SettingsSection has no place under its card, and the part's state stays in view beside Apply.
  return (
    <SettingNote className="model-apply">
      <div className={`small ${error || (changed && problem) ? "sign-in-error" : "muted"}`} role={error ? "alert" : undefined}>
        {note}
      </div>
      {ask ?? (
        <div className="confirm-actions">
          <button className="btn" disabled={!changed || busy} onClick={onDiscard} aria-label={`Discard ${name} changes`}>
            <RotateCcw size={14} /> Discard
          </button>
          <button className="btn primary" disabled={!changed || !!problem || busy || disabled} onClick={onApply} aria-label={`Apply ${name}`}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </div>
      )}
    </SettingNote>
  );
}

/**
 * The Text generation model: the model chat titles are made with, picked like a chat's model. Unlike the rest of this
 * screen it's written as soon as it's picked, as it's one setting with nothing to review. Hermes keeps it as its
 * `title_generation` helper task, so its own titles and every other client on the profile use it too.
 */
function TextGeneration({
  saved,
  api,
  profile,
  connected,
  onSaved,
  show,
}: {
  saved: Settings;
  api: ModelSettingsApi;
  profile: string;
  connected: boolean;
  onSaved: (fresh: Settings) => void;
  /** Set anew to scroll this section into view and move focus to it. */
  show?: object;
}) {
  const { modelFavorites } = useSyncExternalStore(subscribeUIPrefs, getUIPrefs);
  const titleId = useId();
  useEffect(() => {
    // The section's heading, named by its id since something points here: it takes the focus, as a heading can't by itself.
    const heading = show && document.getElementById(titleId);
    if (!heading) return;
    heading.tabIndex = -1;
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }, [show, titleId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** A model Hermes flagged as expensive, not written until the owner says Use anyway. */
  const [ask, setAsk] = useState<{ next: AuxDraft; message: string }>();
  const task = saved.auxiliary.find((t) => t.task === TEXT_TASK);
  if (!task) return null;

  const pinned = task.provider !== AUX_AUTO;
  const current: ModelPick | undefined = pinned ? { provider: task.provider, model: task.model, ...(isEffort(task.effort) && { effort: task.effort }) } : undefined;
  // The catalog this screen read, as the composer's picker lists it. A helper task has no fast mode, so none is offered.
  const catalog: ModelCatalog = {
    profile,
    source: "server",
    providers: saved.providers.map((p) => ({
      slug: p.slug,
      name: p.name,
      models: p.models.map((model) => ({
        provider: p.slug,
        providerName: p.name,
        model,
        reasoning: p.caps[model]?.reasoning ?? true,
        canDisableReasoning: true,
        fast: false,
        available: true,
      })),
    })),
    // Left to inherit, it runs at the main model's effort.
    defaultEffort: isEffort(saved.main.effort) ? saved.main.effort : undefined,
  };

  const write = async (next: AuxDraft, confirmed = false) => {
    setBusy(true);
    setError(undefined);
    setAsk(undefined);
    try {
      const r = await api.applyAuxiliary(saved, { ...draftFrom(saved), auxiliary: { [TEXT_TASK]: next } }, confirmed ? [TEXT_TASK] : []);
      if (r.applied) onSaved(await api.load());
      else setAsk({ next, message: r.expensive });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Text generation" titleId={titleId}>
      <div className="text-gen" role="group" aria-label="Text generation model">
        <SettingRow
          name="Text generation model"
          hint={
            <>
              Used for chat titles, including Regenerate title.{" "}
              {pinned ? "" : `Until you pick one, it's the main model, ${saved.main.model || "the profile's"}.`}
            </>
          }
          more={
            <p>
              Hermes keeps it for the <span className="mono">{profile}</span> profile, so its own titles and other Hermes clients use it too.
            </p>
          }
          control={
            <>
              {pinned && (
                <button
                  className="icon-btn small-icon"
                  title="Use the main model"
                  aria-label="Use the main model for text generation"
                  disabled={busy || !connected}
                  onClick={() => void write({ provider: AUX_AUTO, model: "", effort: AUX_INHERIT })}
                >
                  <RotateCcw size={13} />
                </button>
              )}
              <fieldset className="text-gen-controls" disabled={busy || !connected}>
                <ModelControls
                  catalog={catalog}
                  current={current}
                  defaultEffort={catalog.defaultEffort}
                  favorites={modelFavorites}
                  onPick={(p) => void write({ provider: p.provider, model: p.model, effort: p.effort ?? AUX_INHERIT })}
                  onToggleFavorite={toggleModelFavorite}
                />
              </fieldset>
            </>
          }
        >
          {(busy || error) && (
            <div className={error ? "sign-in-error" : "muted"} role={error ? "alert" : "status"}>
              {error ? `Couldn't set the text generation model: ${error}` : "Saving…"}
            </div>
          )}
          {ask && (
            <div className="confirm set-confirm" role="alertdialog" aria-label="Expensive model">
              <span className="confirm-msg">
                <ShieldAlert size={12} /> Use {ask.next.model} for text generation?
              </span>
              <span className="confirm-detail">{ask.message}</span>
              <div className="confirm-actions">
                <button className="btn" onClick={() => setAsk(undefined)}>
                  Keep current
                </button>
                <button className="btn danger" onClick={() => void write(ask.next, true)}>
                  Use anyway
                </button>
              </div>
            </div>
          )}
        </SettingRow>
      </div>
    </SettingsSection>
  );
}

export function ModelSettings({
  api,
  profile,
  connected,
  showTextGeneration,
}: {
  api: ModelSettingsApi;
  profile: string;
  connected: boolean;
  /** Set anew to bring the Text generation model into view once the setup is read. */
  showTextGeneration?: object;
}) {
  const [saved, setSaved] = useState<Settings>();
  const [draft, setDraft] = useState<Draft>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<Part>();
  const [errors, setErrors] = useState<Partial<Record<Part, string>>>({});
  const [done, setDone] = useState<Partial<Record<Part, boolean>>>({});
  const [ask, setAsk] = useState<Ask>();

  const loaded = saved !== undefined;
  useEffect(() => {
    if (!connected || loaded) return;
    let live = true;
    api.load().then(
      (s) => {
        if (!live) return;
        setSaved(s);
        setDraft(draftFrom(s));
      },
      (e) => live && setLoadError(errorText(e)),
    );
    return () => void (live = false);
  }, [api, connected, loaded, attempt]);

  if (!saved || !draft) {
    return (
      <SettingsSection
        title="Main model"
        action={
          loadError && (
            <button
              className="btn"
              onClick={() => {
                setLoadError(undefined);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          )
        }
      >
        <SettingNote tone={loadError ? "bad" : "muted"} role={loadError ? "alert" : undefined}>
          {loadError
            ? `Couldn't read the model setup: ${loadError}`
            : connected
              ? "Reading the model setup from Hermes…"
              : "Connect to Hermes to see the model setup."}
        </SettingNote>
      </SettingsSection>
    );
  }

  const providers = saved.providers;
  const edit = (part: Part, change: (d: Draft) => Draft) => {
    setDraft((d) => d && change(d));
    setDone((x) => ({ ...x, [part]: false }));
    setErrors((x) => ({ ...x, [part]: undefined }));
    setAsk((a) => (a && askPart(a) === part ? undefined : a));
  };
  const discard = (part: Part) => edit(part, (d) => ({ ...d, [part]: draftFrom(saved)[part] }));

  /**
   * Applies one part, then reads Hermes back. Once it's all written, that part's draft becomes what Hermes now has; the
   * other parts' drafts are kept. When a guardrail stopped it part way, the draft stays for the owner to answer.
   */
  const apply = async (part: Part, write: () => Promise<boolean>) => {
    setBusy(part);
    setErrors((x) => ({ ...x, [part]: undefined }));
    try {
      const all = await write();
      const fresh = await api.load();
      setSaved(fresh);
      if (!all) return;
      setDraft((d) => d && { ...d, [part]: draftFrom(fresh)[part] });
      setDone((x) => ({ ...x, [part]: true }));
    } catch (e) {
      setErrors((x) => ({ ...x, [part]: errorText(e) }));
    } finally {
      setBusy(undefined);
    }
  };

  /** Asks the pinned-helpers guardrail first; Hermes answers the expensive-model one, having written nothing. */
  const applyMain = (answered: { pinned?: boolean; expensive?: boolean } = {}) => {
    const pinned = answered.pinned || answered.expensive ? undefined : auxPinWarning(saved, draft);
    if (pinned) return setAsk({ kind: "pinned", warning: pinned });
    setAsk(undefined);
    void apply("main", async () => {
      const r = await api.applyMain(saved, draft, answered.expensive);
      if (!r.applied) setAsk({ kind: "expensive", part: "main", message: r.expensive });
      return r.applied;
    });
  };
  const applyAuxiliary = (confirmed: string[] = []) => {
    setAsk(undefined);
    void apply("auxiliary", async () => {
      const r = await api.applyAuxiliary(saved, draft, confirmed);
      if (!r.applied) setAsk({ kind: "expensive", part: "auxiliary", message: r.expensive, task: r.task, confirmed: [...confirmed, r.task] });
      return r.applied;
    });
  };
  /** Keep current: the flagged model goes back to what Hermes has; nothing was written for it. */
  const keepCurrent = (a: Ask) => {
    setAsk(undefined);
    if (a.kind !== "expensive") return;
    if (a.part === "main") setDraft((d) => d && { ...d, main: { ...d.main, provider: saved.main.provider, model: saved.main.model } });
    else setDraft((d) => d && { ...d, auxiliary: { ...d.auxiliary, [a.task]: draftFrom(saved).auxiliary[a.task] } });
  };
  const expensiveNode = (a: Ask | undefined, part: Part) =>
    a?.kind === "expensive" && a.part === part ? (
      <div className="confirm" role="alertdialog" aria-label="Expensive model">
        <span className="confirm-msg">
          <ShieldAlert size={12} />{" "}
          {a.part === "main"
            ? `Switch the main model to ${draft.main.model}?`
            : `Use ${draft.auxiliary[a.task]?.model} for ${saved.auxiliary.find((t) => t.task === a.task)?.label ?? a.task}?`}
        </span>
        <span className="confirm-detail">{a.message}</span>
        <div className="confirm-actions">
          <button className="btn" onClick={() => keepCurrent(a)}>
            Keep current
          </button>
          <button className="btn danger" onClick={() => (a.part === "main" ? applyMain({ expensive: true }) : applyAuxiliary(a.confirmed))}>
            Switch anyway
          </button>
        </div>
      </div>
    ) : undefined;

  const m = draft.main;
  const caps = providers.find((p) => p.slug === m.provider)?.caps[m.model];
  const sub = draft.subagent;
  const auxEdited = auxChanged(saved, draft);
  const auxProblems = auxEdited.map((t) => auxProblem(t, draft.auxiliary[t.task])).filter((p): p is string => !!p);
  // Every task with a provider of its own: moving the main model off that provider would leave it behind.
  const pins = pinnedElsewhere(saved.auxiliary, "");
  const pinnedBy = [...new Set(pins.map((t) => t.provider))];

  const askNode =
    ask?.kind === "pinned" ? (
      <div className="confirm" role="alertdialog" aria-label="Auxiliary models still pinned">
        <span className="confirm-msg">
          <TriangleAlert size={12} /> Auxiliary models still pinned to {list(ask.warning.providers.map((p) => providerName(providers, p)))} — apply anyway?
        </span>
        <span>
          {list(ask.warning.tasks.map((t) => t.label))} will keep running there, not on {m.model}. Change them under Auxiliary models to move them
          too.
        </span>
        <div className="confirm-actions">
          <button className="btn" onClick={() => setAsk(undefined)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => applyMain({ pinned: true })}>
            Apply anyway
          </button>
        </div>
      </div>
    ) : (
      expensiveNode(ask, "main")
    );

  const number = (label: string, key: "maxIterations" | "maxConcurrent" | "timeoutSeconds", min: number) => (
    <input
      className="model-num"
      type="number"
      min={min}
      aria-label={label}
      value={sub[key]}
      onChange={(e) => edit("subagent", (d) => ({ ...d, subagent: { ...d.subagent, [key]: e.target.value } }))}
    />
  );

  return (
    <>
      <SettingsSection
        title="Main model"
        intro={
          <>
            The model new chats on the <span className="mono">{profile}</span> profile start with; chats already open keep theirs.
          </>
        }
      >
        <SettingRow
          name="Model"
          control={
            <div className="model-pick">
              <ProviderSelect
                label="Main provider"
                value={m.provider}
                providers={providers}
                onChange={(p) => edit("main", (d) => ({ ...d, main: chooseProvider(d.main, p) }))}
              />
              <ModelSelect
                label="Main model"
                value={m.model}
                provider={m.provider}
                providers={providers}
                onChange={(model) => edit("main", (d) => ({ ...d, main: { ...d.main, model } }))}
              />
            </div>
          }
        />
        <SettingRow
          name="Reasoning effort"
          hint={caps && !caps.reasoning ? "This model doesn't reason." : undefined}
          control={
            <div className="model-pick">
              <EffortSelect
                label="Main reasoning effort"
                value={m.effort}
                first={["", "Hermes default"]}
                onChange={(effort) => edit("main", (d) => ({ ...d, main: { ...d.main, effort } }))}
              />
            </div>
          }
        />
        <SettingRow
          name="Speed"
          hint={caps && !caps.fast && !m.fast ? "This model has no fast mode." : "Priority processing, where the provider bills more for it."}
          control={
            <label className="check">
              <input
                type="checkbox"
                aria-label="Fast mode"
                checked={m.fast}
                disabled={!!caps && !caps.fast && !m.fast}
                onChange={(e) => edit("main", (d) => ({ ...d, main: { ...d.main, fast: e.target.checked } }))}
              />
              Fast mode
            </label>
          }
        />
        <ApplyRow
          name="main model"
          changed={mainChanged(saved, draft)}
          problem={mainProblem(draft)}
          error={errors.main}
          done={done.main}
          busy={busy === "main"}
          disabled={!connected || busy !== undefined}
          ask={askNode}
          onDiscard={() => discard("main")}
          onApply={() => applyMain()}
        />
      </SettingsSection>

      <TextGeneration
        saved={saved}
        api={api}
        profile={profile}
        connected={connected}
        show={showTextGeneration}
        onSaved={(fresh) => {
          setSaved(fresh);
          // The other helper tasks' edits stay drafted; this one is what Hermes now has.
          setDraft((d) => d && { ...d, auxiliary: { ...d.auxiliary, [TEXT_TASK]: draftFrom(fresh).auxiliary[TEXT_TASK] } });
        }}
      />

      <SettingsSection
        title="Subagents"
        intro={
          <>
            The helpers Hermes starts with <span className="mono">delegate_task</span> to work on part of a job. By default they run on the main
            agent's model.
          </>
        }
      >
        <SettingRow
          name="Default subagent"
          hint={
            sub.route === "inherit"
              ? `Subagents run on the main agent's provider and model, ${saved.main.model}.`
              : sub.route === "parent-model"
                ? `Subagents run the main agent's model, ${saved.main.model}, on the provider chosen here. That provider must offer it.`
                : sub.route === "custom-model"
                  ? `Subagents run the model chosen here on the main agent's provider, ${providerName(providers, saved.main.provider)}, with its credentials.`
                  : "Subagents run on a provider and model of their own."
          }
          control={
            <div className="model-pick">
              <select
                className="select wide"
                aria-label="Subagent route"
                value={sub.route}
                onChange={(e) => {
                  const route = SUBAGENT_ROUTES.find((r) => r === e.target.value) ?? "inherit";
                  edit("subagent", (d) => ({ ...d, subagent: chooseRoute(d.subagent, route) }));
                }}
              >
                {SUBAGENT_ROUTES.map((r) => (
                  <option key={r} value={r}>
                    {ROUTE_LABEL[r]}
                  </option>
                ))}
              </select>
              {(sub.route === "parent-model" || sub.route === "provider") && (
                <ProviderSelect
                  label="Subagent provider"
                  value={sub.provider}
                  providers={providers}
                  onChange={(p) => edit("subagent", (d) => ({ ...d, subagent: chooseProvider(d.subagent, p) }))}
                />
              )}
              {(sub.route === "custom-model" || sub.route === "provider") && (
                <ModelSelect
                  label="Subagent model"
                  value={sub.model}
                  provider={sub.route === "custom-model" ? saved.main.provider : sub.provider}
                  providers={providers}
                  onChange={(model) => edit("subagent", (d) => ({ ...d, subagent: { ...d.subagent, model } }))}
                />
              )}
            </div>
          }
        />
        <SettingRow
          name="Reasoning effort"
          control={
            <div className="model-pick">
              <EffortSelect
                label="Subagent reasoning effort"
                value={sub.effort}
                first={["", "Inherit"]}
                onChange={(effort) => edit("subagent", (d) => ({ ...d, subagent: { ...d.subagent, effort } }))}
              />
            </div>
          }
        />
        <SettingRow name="Turn limit" hint="The turns one subagent may take." control={number("Subagent turn limit", "maxIterations", 1)} />
        <SettingRow name="Concurrency" hint="Subagents running at once." control={number("Subagent concurrency", "maxConcurrent", 1)} />
        <SettingRow
          name="Timeout (s)"
          hint="How long a subagent may go without progress. 0: no limit"
          control={number("Subagent timeout in seconds", "timeoutSeconds", 0)}
        />
        {saved.subagent.directEndpoint && (
          <SettingNote tone="warn">
            <TriangleAlert size={12} /> A direct endpoint is set for subagents in Hermes's config, and it takes precedence over the route here. Hermes
            Chat leaves it as it is.
          </SettingNote>
        )}
        {saved.namedRoutes > 0 && (
          <SettingNote>
            {saved.namedRoutes} named {saved.namedRoutes === 1 ? "route" : "routes"} from the advanced-delegation plugin{" "}
            {saved.namedRoutes === 1 ? "is" : "are"} set too; edit them in the official Hermes app.
          </SettingNote>
        )}
        <ApplyRow
          name="subagent"
          changed={subagentChanged(saved, sub)}
          problem={subagentProblem(sub)}
          error={errors.subagent}
          done={done.subagent}
          busy={busy === "subagent"}
          disabled={!connected || busy !== undefined}
          onDiscard={() => discard("subagent")}
          onApply={() => void apply("subagent", async () => (await api.applySubagent(saved, sub), true))}
        />
      </SettingsSection>

      <SettingsSection
        title="Auxiliary models"
        intro="Helper tasks Hermes runs beside a chat. Each runs on the main model unless it's given one of its own, so cheap helpers can run cheap."
      >
        {saved.auxiliary
          .filter((t) => t.task !== TEXT_TASK)
          .map((t: AuxTask) => {
            const a = draft.auxiliary[t.task];
            const auto = a.provider === AUX_AUTO;
            return (
              <SettingRow
                key={t.task}
                name={t.label}
                hint={t.hint}
                control={
                  <div className="model-pick">
                    <select
                      className="select"
                      aria-label={`${t.label} provider`}
                      value={a.provider}
                      onChange={(e) =>
                        edit("auxiliary", (d) => ({ ...d, auxiliary: { ...d.auxiliary, [t.task]: chooseAuxProvider(a, e.target.value) } }))
                      }
                    >
                      <option value={AUX_AUTO}>auto · use main model</option>
                      {!auto && !providers.some((p) => p.slug === a.provider) && <option value={a.provider}>{a.provider}</option>}
                      {providers.map((p) => (
                        <option key={p.slug} value={p.slug}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    {auto ? (
                      <ModelCombobox label={`${t.label} model`} value="" models={[]} placeholder={saved.main.model || "main model"} disabled />
                    ) : (
                      <ModelSelect
                        label={`${t.label} model`}
                        value={a.model}
                        provider={a.provider}
                        providers={providers}
                        onChange={(model) => edit("auxiliary", (d) => ({ ...d, auxiliary: { ...d.auxiliary, [t.task]: { ...a, model } } }))}
                      />
                    )}
                    <EffortSelect
                      label={`${t.label} effort`}
                      value={a.effort}
                      first={[AUX_INHERIT, "inherit · main model effort"]}
                      onChange={(effort) => edit("auxiliary", (d) => ({ ...d, auxiliary: { ...d.auxiliary, [t.task]: { ...a, effort } } }))}
                    />
                  </div>
                }
              />
            );
          })}
        <ApplyRow
          name="auxiliary models"
          changed={auxEdited.length > 0}
          problem={auxProblems[0]}
          error={errors.auxiliary}
          done={done.auxiliary}
          busy={busy === "auxiliary"}
          disabled={!connected || busy !== undefined}
          onDiscard={() => discard("auxiliary")}
          ask={expensiveNode(ask, "auxiliary")}
          onApply={() => applyAuxiliary()}
        />
      </SettingsSection>

      {/* Guardrails: checked when a main model is applied, before anything is written. In the page header's box (ADR 0160). */}
      <HeadPart at="applies">
        <AppliesBox line="Hermes checks pinned helpers and the price before it switches the main model." more="Safety checks">
          <AppliesPart>
            <Guardrails pins={pins} pinnedBy={pinnedBy} providers={providers} />
          </AppliesPart>
        </AppliesBox>
      </HeadPart>
    </>
  );
}

function Guardrails({ pins, pinnedBy, providers }: { pins: AuxTask[]; pinnedBy: string[]; providers: CatalogProvider[] }) {
  return (
    <>
        <SettingRow
          className="model-guard"
          name={
            <>
              <Pin size={13} /> Pinned helper tasks
            </>
          }
          hint={
            pins.length
              ? `${list(pins.map((t) => t.label))} ${pins.length === 1 ? "is" : "are"} pinned to ${list(pinnedBy.map((p) => providerName(providers, p)))}. Moving the main model to another provider asks first, since they'd keep running there.`
              : "No helper task is pinned to a provider of its own, so they all follow the main model."
          }
        />
        <SettingRow
          className="model-guard"
          name={
            <>
              <CircleDollarSign size={13} /> Expensive models
            </>
          }
          hint="Hermes checks the price of the main model you apply. If it's above Hermes's safety threshold, nothing is switched until you choose Switch anyway or Keep current."
        />
    </>
  );
}
