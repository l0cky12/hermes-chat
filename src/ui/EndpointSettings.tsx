// Settings → Providers, Custom endpoints (ADR 0133): the shown profile's OpenAI-compatible endpoints on Hermes, such as
// Ollama, LM Studio, vLLM or Groq. Adding one has Hermes check it first (Rust's `hermes_save_endpoint`, which keeps the
// typed key out of the window's answers); one that doesn't pass is added only when the owner says so. An endpoint can
// be made the default model provider, or removed. Each change shows what Hermes's list says after it.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Info, Plus, Star, Trash2 } from "lucide-react";
import { endpointFormProblem, type AccountsApi, type CustomEndpoint, type EndpointForm, type Listed } from "../hermes/accounts";
import { withoutKey } from "../hermes/setup";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { Spinner } from "./bits";
import { errorText } from "../hermes/values";

export type EndpointApi = Pick<AccountsApi, "endpoints" | "saveEndpoint" | "activateEndpoint" | "removeEndpoint">;

type Ui =
  | { kind: "idle" }
  | { kind: "adding"; anyway: boolean }
  /** Hermes's check didn't pass; Add anyway saves it as typed. */
  | { kind: "checkFailed"; message: string }
  | { kind: "activating"; id: string }
  | { kind: "confirmRemove"; id: string }
  | { kind: "removing"; id: string };

const IDLE: Ui = { kind: "idle" };
const EMPTY: EndpointForm = { name: "", baseUrl: "", model: "", key: "" };

/** `where`: under an endpoint's row, under the form, or at the head of the list. */
type Note = { where: "add" | "list" | `row:${string}`; ok: boolean; text: string };

export function EndpointSettings({ api, profile, connected }: { api: EndpointApi; profile: string; connected: boolean }) {
  const [list, setList] = useState<Listed<CustomEndpoint>>();
  const [loadError, setLoadError] = useState<string>();
  const [ui, setUi] = useState<Ui>(IDLE);
  const [form, setForm] = useState<EndpointForm>(EMPTY);
  const [note, setNote] = useState<Note>();
  const ids = useId();
  const scopes = useRef(0);
  const reads = useRef(0);
  const live = (scope: number) => scope === scopes.current;

  const load = (scope = scopes.current): Promise<Listed<CustomEndpoint> | undefined> => {
    if (!live(scope)) return Promise.resolve(undefined);
    const read = ++reads.current;
    return api.endpoints(profile).then(
      (l) => {
        if (live(scope) && read === reads.current) {
          setList(l);
          setLoadError(undefined);
        }
        return l;
      },
      (e) => {
        if (live(scope) && read === reads.current) setLoadError(errorText(e));
        return undefined;
      },
    );
  };

  useEffect(() => {
    const scope = ++scopes.current;
    setList(undefined);
    setLoadError(undefined);
    setUi(IDLE);
    setForm(EMPTY);
    setNote(undefined);
    if (connected) void load(scope);
    return () => void scopes.current++;
  }, [api, profile, connected]);

  const busy = ui.kind === "adding" || ui.kind === "activating" || ui.kind === "removing";
  const edit = (field: keyof EndpointForm) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    setNote(undefined);
    if (ui.kind === "checkFailed") setUi(IDLE);
  };

  const add = async (anyway: boolean) => {
    if (busy) return;
    const problem = endpointFormProblem(form);
    if (problem) {
      setNote({ where: "add", ok: false, text: problem });
      return;
    }
    const scope = scopes.current;
    const typed = form;
    setUi({ kind: "adding", anyway });
    setNote(undefined);
    let saved: Awaited<ReturnType<EndpointApi["saveEndpoint"]>>;
    try {
      saved = await api.saveEndpoint(profile, typed, anyway);
    } catch (e) {
      if (!live(scope)) return;
      setUi(IDLE);
      setNote({ where: "add", ok: false, text: `Not added: ${withoutKey(errorText(e), typed.key ?? "")}` });
      return;
    }
    if (!live(scope)) return;
    if (saved.outcome === "checkFailed") {
      setUi({ kind: "checkFailed", message: withoutKey(saved.message, typed.key ?? "") });
      return;
    }
    const after = await load(scope);
    if (!live(scope)) return;
    setUi(IDLE);
    const name = typed.name.trim();
    if (after?.items.some((x) => x.id === saved.id)) {
      setForm(EMPTY);
      setNote({ where: "add", ok: true, text: `Added ${name}${saved.checked ? "" : ", unchecked"}. Use as default makes Hermes use it.` });
    } else setNote({ where: "add", ok: false, text: `Hermes took ${name}, but ${after ? "doesn't list it" : "its list couldn't be read to confirm it"}.` });
  };

  /** Activates or removes `e`, then reads the list, which decides what the note says. */
  const change = async (e: CustomEndpoint, kind: "activating" | "removing") => {
    const scope = scopes.current;
    setUi({ kind, id: e.id });
    setNote(undefined);
    let failed: string | undefined;
    try {
      await (kind === "activating" ? api.activateEndpoint(profile, e.id) : api.removeEndpoint(profile, e.id));
    } catch (err) {
      failed = errorText(err);
    }
    if (!live(scope)) return;
    const after = await load(scope);
    if (!live(scope)) return;
    setUi(IDLE);
    const row = after?.items.find((x) => x.id === e.id);
    const verb = kind === "activating" ? "made the default" : "removed";
    if (!after) setNote({ where: `row:${e.id}`, ok: false, text: `${failed ? `Not ${verb}: ${failed}` : `Hermes took it`}, and the list couldn't be read again to confirm it.` });
    else if (kind === "activating" ? !row?.current : row)
      setNote({ where: row ? `row:${e.id}` : "list", ok: false, text: `Not ${verb}: ${failed ?? `Hermes's list still shows it as it was.`}` });
    else if (kind === "activating") setNote({ where: `row:${e.id}`, ok: true, text: `Hermes now uses ${e.name} by default, with ${row!.model}.` });
    else setNote({ where: "list", ok: true, text: `Removed ${e.name} from the ${profile} profile.` });
  };

  const section = (children: ReactNode) => (
    <SettingsSection
      title="Custom endpoints"
      intro="OpenAI-compatible servers, such as Ollama, LM Studio, vLLM, or Groq at https://api.groq.com/openai/v1. Hermes reaches them from the server, so localhost is the Hermes server."
    >
      {children}
    </SettingsSection>
  );

  if (!connected) return section(<SettingNote role="status">Not connected to Hermes. The endpoints show once it's connected.</SettingNote>);
  if (!list)
    return section(
      loadError ? (
        <SettingNote tone="bad" role="alert">
          <AlertTriangle size={14} />
          <span>Couldn't read the endpoints from Hermes: {loadError}</span>
          <button className="btn" onClick={() => void load()}>
            Try again
          </button>
        </SettingNote>
      ) : (
        <SettingNote role="status">
          <Spinner /> Asking Hermes…
        </SettingNote>
      ),
    );
  if (list.unsupported)
    return section(
      <SettingNote role="status">
        <Info size={14} />
        <span>This Hermes server doesn't let Hermes Chat manage custom endpoints ({list.unsupported}). Set them up on the server instead, with <code>hermes model</code>.</span>
      </SettingNote>,
    );

  const lineOf = (where: Note["where"]) =>
    note?.where === where && (
      <div className={`pk-line ${note.ok ? "ok" : "bad"}`} role={note.ok ? "status" : "alert"}>
        {note.text}
      </div>
    );

  const row = (e: CustomEndpoint) => {
    const mine = ui.kind !== "idle" && "id" in ui && ui.id === e.id ? ui : undefined;
    return (
      <SettingRow
        key={e.id}
        name={
          <>
            {e.name}
            {e.current && <span className="si-badge">Default</span>}
          </>
        }
        hint={
          <>
            <span className="mono">{e.baseUrl}</span>, {e.model || "no model"}
            {e.hasKey ? ", with a key" : ""}
          </>
        }
        control={
          !mine && (
            <>
              {!e.current && (
                <button className="btn" disabled={busy} aria-label={`Use ${e.name} as the default`} onClick={() => void change(e, "activating")}>
                  <Star size={13} aria-hidden /> Use as default
                </button>
              )}
              <button className="btn" disabled={busy} aria-label={`Remove ${e.name}`} onClick={() => setUi({ kind: "confirmRemove", id: e.id })}>
                <Trash2 size={13} aria-hidden /> Remove
              </button>
            </>
          )
        }
      >
        {mine?.kind === "activating" && (
          <div className="pk-line" role="status">
            <Spinner /> Making it the default…
          </div>
        )}
        {(mine?.kind === "confirmRemove" || mine?.kind === "removing") && (
          <div className="confirm set-confirm" role="alertdialog" aria-label={`Remove ${e.name}?`}>
            <span className="confirm-msg">
              Remove {e.name}{e.hasKey ? " and its key" : ""} from the <span className="mono">{profile}</span> profile on the server?
              {e.current ? " It's the default model provider now, so pick another in Settings → Model." : ""}
            </span>
            <div className="confirm-actions">
              <button className="btn" disabled={busy} onClick={() => setUi(IDLE)}>
                Cancel
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void change(e, "removing")}>
                {mine.kind === "removing" && <Spinner />} {mine.kind === "removing" ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        )}
        {lineOf(`row:${e.id}`)}
      </SettingRow>
    );
  };

  const adding = ui.kind === "adding";
  // Each input is named "Endpoint …", so it isn't mistaken for the Provider keys' "API key" above it.
  const field = (key: keyof EndpointForm, label: string, props: { placeholder: string; type?: string; hint?: string }) => (
    <SettingRow name={<label htmlFor={`${ids}-${key}`}>{label}</label>} about={label} hint={props.hint}>
      <input
        id={`${ids}-${key}`}
        aria-label={`Endpoint ${label === "API key" ? label : label.toLowerCase()}`}
        className="pk-input"
        type={props.type ?? "text"}
        autoComplete="off"
        spellCheck={false}
        placeholder={props.placeholder}
        value={form[key] ?? ""}
        disabled={busy}
        onChange={edit(key)}
      />
    </SettingRow>
  );

  return section(
    <>
      {loadError && (
        <SettingNote tone="bad" role="alert">
          <AlertTriangle size={14} />
          <span>Couldn't read the endpoints from Hermes again: {loadError}</span>
          <button className="btn" onClick={() => void load()}>
            Try again
          </button>
        </SettingNote>
      )}
      {list.items.length ? list.items.map(row) : <SettingNote role="status">No custom endpoint in the <span className="mono">{profile}</span> profile yet.</SettingNote>}
      {note?.where === "list" && (
        <SettingNote tone={note.ok ? "muted" : "warn"} role={note.ok ? "status" : "alert"}>
          {note.text}
        </SettingNote>
      )}
      <div className="si-add" role="group" aria-label="Add an endpoint">
        {field("name", "Name", { placeholder: "Ollama" })}
        {field("baseUrl", "Address", { placeholder: "http://localhost:11434/v1", hint: "The OpenAI-compatible base URL, usually ending in /v1." })}
        {field("model", "Model", { placeholder: "The first one Hermes finds", hint: "Optional." })}
        {field("key", "API key", { placeholder: "None", type: "password", hint: "Optional. Hermes keeps it in the profile's .env on the server, and Hermes Chat doesn't keep it." })}
        <div className="confirm-actions">
          <button className="btn primary" disabled={busy || !form.name.trim() || !form.baseUrl.trim()} onClick={() => void add(false)}>
            {adding && !ui.anyway ? <Spinner /> : <Plus size={13} aria-hidden />} {adding && !ui.anyway ? "Checking…" : "Check and add"}
          </button>
        </div>
        {ui.kind === "checkFailed" && (
          <div className="confirm set-confirm" role="alertdialog" aria-label="Add it anyway?">
            <span className="confirm-msg">Hermes checked it, and it didn't pass: {ui.message}</span>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setUi(IDLE)}>
                Cancel
              </button>
              <button className="btn" onClick={() => void add(true)}>
                Add anyway
              </button>
            </div>
          </div>
        )}
        {adding && ui.anyway && (
          <div className="pk-line" role="status">
            <Spinner /> Adding…
          </div>
        )}
        {lineOf("add")}
      </div>
    </>,
  );
}
