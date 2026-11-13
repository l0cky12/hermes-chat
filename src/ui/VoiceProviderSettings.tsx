// Settings → Voice → Speech providers: pick the profile's speech-to-text and text-to-speech provider on Hermes, set the
// picked one's model, voice and language, and give it an API key. See src/hermes/voiceSettings.ts and ADR 0115.
// Keys are write-only: Hermes says only whether one is set, a typed one is sent once, and the field is emptied after.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { KeyRound, RefreshCw, RotateCcw, Save } from "lucide-react";
import {
  KINDS,
  KIND_LABEL,
  STT_LANGUAGE,
  type VoiceDraft,
  type VoiceKind,
  type VoiceProvider,
  type VoiceRead,
  type VoiceSave,
  type VoiceSettingsApi,
  VoiceUnsupportedError,
  activeOf,
  changedUnder,
  withoutChanged,
  namedOf,
  pickedOf,
  draftChanges,
  draftProblems,
  emptyDraft,
  fieldsOf,
  readiness,
} from "../hermes/voiceSettings";
import { Spinner } from "./bits";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { HeadPart, useInPage } from "./SettingsPage";
import { errorText } from "../hermes/values";

const USED_FOR: Record<VoiceKind, string> = {
  stt: "Dictation, and what you say in a voice conversation.",
  tts: "Read aloud, and Hermes's side of a voice conversation.",
};

/** What a save came to, in words. */
function outcomeText(r: VoiceSave): { ok: boolean; text: string } {
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0]);
  switch (r.kind) {
    case "saved":
      return {
        ok: true,
        text:
          "Saved on Hermes, and read back. Dictation, Read aloud and voice conversations use it from their next recording or reply." +
          (r.warning ? ` Hermes answered with an error (${r.warning}), but it reads back as saved.` : ""),
      };
    case "conflict":
      return { ok: false, text: `Not saved: ${list(r.what)} changed on Hermes since you opened this. The values shown now are Hermes's; check them, then save again.` };
    case "mismatch":
      return { ok: false, text: `Hermes took the save, but reading it back doesn't show ${list(r.what)}. The values shown are what Hermes has now.` };
    case "failed":
      return {
        ok: false,
        text: r.refused
          ? `Hermes refused it: ${r.reason}. ${r.done.length ? `It had already saved ${list(r.done)}.` : "Nothing was changed."}`
          : `Hermes didn't confirm it: ${r.reason}. ${r.done.length ? `It took ${list(r.done)}; the rest` : "It"} may have been saved, or may yet be.${r.read ? " The values shown are what Hermes has now." : ""}`,
      };
  }
}

/**
 * The profile's speech providers on Hermes. Every read and save names the profile it is for, and an answer for another
 * profile or connection than the one shown now is dropped, so a late one can't overwrite what's shown.
 */
export function VoiceProviderSettings({
  api,
  profile,
  connected,
  onSaved = () => {},
}: {
  api: VoiceSettingsApi;
  profile: string;
  connected: boolean;
  /** After a save Hermes may have taken: the voice set-up shown elsewhere is read again. */
  onSaved?: () => void;
}) {
  const [read, setRead] = useState<VoiceRead>();
  const [loadError, setLoadError] = useState<string>();
  const [unsupported, setUnsupported] = useState<string>();
  const [draft, setDraft] = useState<VoiceDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string }>();
  // Bumped by every new profile, connection and reload: an answer from before is dropped.
  const epoch = useRef(0);
  const readRef = useRef(read);
  readRef.current = read;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const shown = useRef({ api, profile });
  shown.current = { api, profile };
  const current = (mine: number, forApi: VoiceSettingsApi, forProfile: string) =>
    mine === epoch.current && shown.current.api === forApi && shown.current.profile === forProfile;

  const load = () => {
    const mine = ++epoch.current;
    const forApi = api;
    const forProfile = profile;
    setLoadError(undefined);
    forApi.read(forProfile).then(
      (r) => {
        if (!current(mine, forApi, forProfile)) return;
        setUnsupported(undefined);
        // What the owner has typed stays, except where Hermes's value changed since the read it was made from: a later
        // save is checked against this read, so a change under the draft would otherwise be overwritten unseen.
        const before = readRef.current;
        if (before) {
          const { what, kinds, paths } = changedUnder(before, r, draftRef.current);
          if (what.length) {
            setDraft((d) => withoutChanged(d, kinds, paths));
            setOutcome({ ok: false, text: `Changed on Hermes since you opened this: ${what.join(", ")}. Hermes's values are shown there now.` });
          }
        }
        setRead(r);
      },
      (e) => {
        if (!current(mine, forApi, forProfile)) return;
        if (e instanceof VoiceUnsupportedError) setUnsupported(e.message);
        else setLoadError(errorText(e));
      },
    );
  };

  useEffect(() => {
    // Another profile or connection starts afresh: nothing of the last one's read, draft or typed key is kept.
    setRead(undefined);
    setDraft(emptyDraft());
    setOutcome(undefined);
    setUnsupported(undefined);
    setLoadError(undefined);
    setSaving(false);
    if (connected) load();
    else epoch.current++;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `epoch` is a counter, not a DOM node: the cleanup bumps its live value so a late answer for the old profile or connection is dropped
    return () => void epoch.current++;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reset and read again only when the api, profile or connection changes; `load` is new every render, so listing it would read again on every render
  }, [api, profile, connected]);

  const changed = draftChanges(draft);
  const problems = read && changed ? draftProblems(read, draft) : [];
  // A save for this profile still on its way from before this panel opened (Settings was left and opened again, or the
  // profile switched back): it is shown, nothing is saved over it, and Hermes is read again once it lands.
  const elsewhere = useSyncExternalStore(api.subscribe, () => api.pending() === profile) && !saving;
  const wasElsewhere = useRef(false);
  useEffect(() => {
    if (wasElsewhere.current && !elsewhere && connected) load();
    wasElsewhere.current = elsewhere;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- acts only when `elsewhere` turns false; `load` is new every render
  }, [elsewhere]);
  const busy = saving || elsewhere;

  const save = async () => {
    if (!read || busy || problems.length) return;
    // A read still on its way from before the save would show what Hermes had then: it is dropped.
    const mine = ++epoch.current;
    const forApi = api;
    const forProfile = profile;
    setSaving(true);
    setOutcome(undefined);
    let r: VoiceSave;
    try {
      r = await forApi.save(forProfile, read, draft);
    } catch (e) {
      if (!current(mine, forApi, forProfile)) return;
      setSaving(false);
      setDraft((d) => ({ ...d, keys: {} }));
      setOutcome({ ok: false, text: `Couldn't save: ${errorText(e)}` });
      return;
    }
    // The save finished on Hermes whatever is shown now; what it came to is told only to the profile it was for.
    if (r.kind !== "conflict" && !(r.kind === "failed" && r.refused && !r.done.length)) onSaved();
    if (!current(mine, forApi, forProfile)) return;
    setSaving(false);
    setOutcome(outcomeText(r));
    if ("read" in r && r.read) setRead(r.read);
    // A typed key is sent once and never kept. Picks and settings stay for another try unless they were saved, or another
    // client changed them meanwhile: then Hermes's value is shown instead.
    setDraft((d) => {
      if (r.kind === "saved") return emptyDraft();
      const next: VoiceDraft = { provider: { ...d.provider }, settings: { ...d.settings }, keys: {} };
      return r.kind === "conflict" ? withoutChanged(next, r.kinds, r.paths) : next;
    });
  };

  // Another pick drops what was typed for the last one on that side: nothing hidden is ever sent.
  const setProvider = (kind: VoiceKind, name: string) =>
    setDraft((d) => {
      const provider = { ...d.provider };
      if (read && (pickedOf(read, kind)?.name ?? "") === name) delete provider[kind];
      else provider[kind] = name;
      const picked = read?.sides[kind].providers.find((p) => p.name === name);
      const own = new Set(fieldsOf(kind, picked).map((f) => f.path));
      const settings = Object.fromEntries(Object.entries(d.settings).filter(([path]) => !path.startsWith(`${kind}.`) || path === STT_LANGUAGE || own.has(path)));
      return { provider, settings, keys: { ...d.keys, [kind]: {} } };
    });
  const setSetting = (path: string, value: string) =>
    setDraft((d) => {
      const settings = { ...d.settings };
      if ((read?.values[path] ?? "") === value) delete settings[path];
      else settings[path] = value;
      return { ...d, settings };
    });
  const setKey = (kind: VoiceKind, env: string, value: string) =>
    setDraft((d) => ({ ...d, keys: { ...d.keys, [kind]: { ...d.keys[kind], [env]: value } } }));

  // Under Settings' page header (ADR 0160) Reload is the page's; every re-read in Settings is a Reload there.
  const inPage = useInPage();
  const action = !connected || unsupported ? undefined : loadError ? (
    <button className="btn" onClick={load}>
      <RotateCcw size={14} /> Try again
    </button>
  ) : (
    read && (
      <button className="btn" disabled={busy} onClick={load}>
        <RefreshCw size={14} /> Reload
      </button>
    )
  );
  return (
    <SettingsSection
      title="Speech providers"
      titleId="voice-providers-title"
      className="voice-providers"
      intro={
        <>
          Which provider Hermes transcribes and speaks with for the <span className="mono">{profile}</span> profile, and its model, voice and
          language.
        </>
      }
      more={
        <>
          <p>
            They are saved in the profile's config on the Hermes server, as <span className="mono">hermes tools</span> saves them there.
          </p>
          <p>
            Keys are saved in the profile's .env on the server and never shown here again: Hermes says only whether one is set. Installing a local
            provider's software (Local Whisper, Piper) and signing in to Nous Portal or xAI are done on the server with{" "}
            <span className="mono">hermes tools</span>.
          </p>
        </>
      }
      action={inPage ? undefined : action}
    >
      {inPage && action && <HeadPart at="actions">{action}</HeadPart>}
      {!connected ? (
        <SettingNote>Connect to Hermes to see and change this profile's speech providers.</SettingNote>
      ) : unsupported ? (
        <div className="set-block" role="note">
          <p className="small">{unsupported}</p>
          <p className="muted small">
            Until then, pick the providers on the server with <span className="mono">hermes tools</span> (Speech-to-Text and Text-to-Speech). The
            ones the profile names now are shown under Voice above.
          </p>
        </div>
      ) : loadError ? (
        <SettingNote tone="bad" role="alert">
          Couldn't read the speech providers: {loadError}
        </SettingNote>
      ) : !read ? (
        <SettingNote>
          <Spinner /> Reading the speech providers from Hermes…
        </SettingNote>
      ) : (
        <>
          {KINDS.map((kind) => (
            <ProviderSide
              key={kind}
              kind={kind}
              read={read}
              draft={draft}
              disabled={busy}
              onProvider={(name) => setProvider(kind, name)}
              onSetting={setSetting}
              onKey={(env, value) => setKey(kind, env, value)}
            />
          ))}
          {/* The card's last line: SettingsSection has no place under its card, and what a save came to stays beside Save. */}
          <SettingNote className="voice-save">
            <div
              className={(outcome && !outcome.ok) || problems.length ? "sign-in-error" : "muted"}
              role={(outcome && !outcome.ok) || problems.length ? "alert" : "status"}
            >
              {busy ? (
                <>
                  <Spinner /> Saving to Hermes, then reading it back…
                </>
              ) : problems.length ? (
                problems.join(" ")
              ) : (
                (outcome?.text ?? (changed ? "Not saved yet." : ""))
              )}
            </div>
            <div className="confirm-actions">
              <button className="btn" disabled={!changed || busy} onClick={() => (setDraft(emptyDraft()), setOutcome(undefined))}>
                Discard changes
              </button>
              <button className="btn primary" disabled={!changed || busy || problems.length > 0} onClick={save}>
                <Save size={13} /> {busy ? "Saving…" : "Save to Hermes"}
              </button>
            </div>
          </SettingNote>
        </>
      )}
    </SettingsSection>
  );
}

function ProviderSide({
  kind,
  read,
  draft,
  disabled,
  onProvider,
  onSetting,
  onKey,
}: {
  kind: VoiceKind;
  read: VoiceRead;
  draft: VoiceDraft;
  disabled: boolean;
  onProvider: (name: string) => void;
  onSetting: (path: string, value: string) => void;
  onKey: (env: string, value: string) => void;
}) {
  const providers = read.sides[kind].providers;
  const inUse = activeOf(read, kind);
  // With nothing named, the select shows "Picked by Hermes" and the provider in use can be picked to name it.
  const pickedName = draft.provider[kind] ?? pickedOf(read, kind)?.name;
  // Its settings and keys show for the one in use when nothing is named.
  const picked = providers.find((p) => p.name === (pickedName ?? inUse?.name));
  const named = namedOf(read, kind);
  const label = KIND_LABEL[kind];
  const fields = fieldsOf(kind, picked);
  const value = (path: string) => draft.settings[path] ?? read.values[path] ?? "";

  return (
    <div className="voice-side" role="group" aria-label={label}>
      <SettingRow
        name={label}
        nameAs="h3"
        hint={USED_FOR[kind]}
        control={
          <select
            className="select"
            aria-label={`${label} provider`}
            value={pickedName ?? ""}
            disabled={disabled}
            onChange={(e) => onProvider(e.target.value)}
          >
            {!pickedOf(read, kind) && <option value="">{inUse ? `Picked by Hermes (now ${inUse.name})` : "None picked"}</option>}
            {providers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.active ? " (in use)" : ""} · {readiness(p).badge}
              </option>
            ))}
          </select>
        }
      >
        {kind === "stt" && !named && inUse && !draft.provider.stt && (
          <div className="muted">
            The profile names none, so Hermes picks as it transcribes: {inUse.name} if it's installed, else the first cloud provider with a key.
            Saving a pick here names it.
          </div>
        )}
        {named && !inUse && (
          <div className="muted">
            The profile names <span className="mono">{named}</span>, which isn't one Hermes lists to pick from here (a command or plugin provider set
            on the server). Picking one here replaces it.
          </div>
        )}
      </SettingRow>
      {/* What each provider needs, and the picked one's settings and keys. */}
      <div className="set-block">
        <ul className="voice-provider-list" aria-label={`${label} providers`}>
          {providers.map((p) => {
            const r = readiness(p);
            return (
              <li key={p.name} className={p.name === picked?.name ? "picked" : undefined}>
                <span className="voice-provider-name">{p.name}</span>
                {p.active && <span className="badge">In use</span>}
                <span className={`badge ${r.ok ? "ok" : "warn"}`}>{r.badge}</span>
                {p.tag && <span className="muted small voice-provider-tag">{p.tag}</span>}
              </li>
            );
          })}
        </ul>
        {picked && (
          <div className="voice-picked" aria-label={`${picked.name} settings`} role="group">
            <p className={`small ${readiness(picked).ok ? "muted" : ""}`}>
              <b>{picked.name}</b>: {readiness(picked).text}
            </p>
            {picked.keys.map((k) => (
              <KeyField key={k.env} k={k} provider={picked} typed={draft.keys[kind]?.[k.env] ?? ""} disabled={disabled} onKey={onKey} />
            ))}
            {fields.map((f) => (
              <SettingField
                key={f.path}
                path={f.path}
                label={f.label}
                hint={f.hint}
                value={value(f.path)}
                options={read.options[f.path]}
                disabled={disabled}
                onSetting={onSetting}
              />
            ))}
            {kind === "stt" && (
              <SettingField
                path={STT_LANGUAGE}
                label="Language for every provider"
                hint="A code such as en, or blank to detect it. A provider's own language, above, comes first."
                value={value(STT_LANGUAGE)}
                disabled={disabled}
                onSetting={onSetting}
              />
            )}
            {picked.managed ? (
              <p className="muted small">Hermes's Nous Portal gateway picks the model and voice for this one.</p>
            ) : (
              !fields.length && <p className="muted small">Its other settings stay as the profile's config on the server has them.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function KeyField({
  k,
  provider,
  typed,
  disabled,
  onKey,
}: {
  k: VoiceProvider["keys"][number];
  provider: VoiceProvider;
  typed: string;
  disabled: boolean;
  onKey: (env: string, value: string) => void;
}) {
  return (
    <label className="voice-field">
      <span>
        <KeyRound size={12} aria-hidden /> {k.prompt} <span className="mono muted">{k.env}</span>{" "}
        <span className={`badge ${k.set ? "ok" : "warn"}`}>{k.set ? "Set" : "Not set"}</span>
      </span>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={`${provider.name} ${k.prompt}`}
        placeholder={k.set ? "Saved on the server. Type a new key to replace it." : "Not set. Type the key to save it on the server."}
        value={typed}
        disabled={disabled}
        onChange={(e) => onKey(k.env, e.target.value)}
      />
    </label>
  );
}

function SettingField({
  path,
  label,
  hint,
  value,
  options,
  disabled,
  onSetting,
}: {
  path: string;
  label: string;
  hint?: string;
  value: string;
  options?: string[];
  disabled: boolean;
  onSetting: (path: string, value: string) => void;
}) {
  return (
    <label className="voice-field">
      <span>
        {label} <span className="mono muted">{path}</span>
      </span>
      {options?.length ? (
        <select value={value} disabled={disabled} onChange={(e) => onSetting(path, e.target.value)}>
          {!options.includes(value) && <option value={value}>{value || "(blank)"}</option>}
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input type="text" spellCheck={false} value={value} disabled={disabled} onChange={(e) => onSetting(path, e.target.value)} />
      )}
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
}
