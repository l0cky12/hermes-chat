// Settings → Providers (ADR 0095): the shown profile's model provider API keys on Hermes. Saved keys show as Hermes's
// redacted preview and can be replaced or removed; a key for another provider is added below. Checking and saving go
// through Rust (`hermes_save_provider_key`), and so does removing, which reads the list back (`hermes_remove_provider_key`):
// a key leaves this screen only once Hermes shows it unset. The typed key is never shown, not even in an error.
import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Info, KeyRound, Trash2 } from "lucide-react";
import type { Hermes } from "../hermes/transport";
import { savedKeyText, withoutKey, type ProviderKey, type ProviderSetup } from "../hermes/setup";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { Spinner } from "./bits";
import { errorText } from "../hermes/values";

/** What Settings → Providers needs of the connection: the key calls, and the profile they write for. */
export type ProviderKeysApi = Pick<Hermes, "providerSetup" | "saveProviderKey" | "removeProviderKey" | "keyChangesSettled" | "profile">;

/** What the one action on the screen is doing: at most one, so no two keys are ever changed at once. */
type Ui =
  | { kind: "idle" }
  | { kind: "replacing"; provider: string }
  | { kind: "confirmRemove"; provider: string }
  | { kind: "saving"; provider: string }
  | { kind: "removing"; provider: string };

const IDLE: Ui = { kind: "idle" };

/** `where`: under a saved key's row, in the Add a key section, or at the head of the saved keys. */
type Note = { where: "add" | "list" | `row:${string}`; ok: boolean; text: string };

export function ProviderSettings({ hermes, profile, connected, openModel }: { hermes: ProviderKeysApi; profile: string; connected: boolean; openModel?: () => void }) {
  const [setup, setSetup] = useState<ProviderSetup>();
  const [loadError, setLoadError] = useState<string>();
  const [ui, setUi] = useState<Ui>(IDLE);
  const [replacement, setReplacement] = useState("");
  const [chosen, setChosen] = useState<string>();
  const [addKey, setAddKey] = useState("");
  const [note, setNote] = useState<Note>();
  const ids = useId();
  // The connection and profile this screen reads and writes for. `scopes` moves on when either changes, and `reads` with
  // each read of the list. A list or its error counts only for the latest read in the same scope; a save's or removal's
  // answer counts while the scope is the same. So a late answer for another profile is dropped, and a key typed for one
  // never goes to the other.
  const scopes = useRef(0);
  const reads = useRef(0);
  const live = (scope: number) => scope === scopes.current;

  /**
   * Reads the list again for `scope`. Resolves with what Hermes answered, even if a later read has replaced it on
   * screen; undefined when it failed, or when `scope` is no longer the one shown.
   */
  const load = (scope = scopes.current): Promise<ProviderSetup | undefined> => {
    if (!live(scope)) return Promise.resolve(undefined);
    const read = ++reads.current;
    return hermes
      .keyChangesSettled()
      .then(() => hermes.providerSetup())
      .then(
      (s) => {
        if (live(scope) && read === reads.current) {
          setSetup(s);
          setLoadError(undefined);
        }
        return s;
      },
      (e) => {
        if (live(scope) && read === reads.current) setLoadError(errorText(e));
        return undefined;
      },
    );
  };
  useEffect(() => {
    scopes.current++;
    setSetup(undefined);
    setLoadError(undefined);
    setUi(IDLE);
    setReplacement("");
    setChosen(undefined);
    setAddKey("");
    setNote(undefined);
    if (connected) void load();
  }, [hermes, profile, connected]);

  const busy = ui.kind === "saving" || ui.kind === "removing";

  const save = async (k: ProviderKey, value: string, where: "add" | `row:${string}`) => {
    if (busy || !value.trim() || hermes.profile !== profile) return;
    const scope = scopes.current;
    setUi({ kind: "saving", provider: k.provider });
    setNote(undefined);
    try {
      const saved = await hermes.saveProviderKey(k.envVar, value);
      if (!live(scope)) return;
      (where === "add" ? setAddKey : setReplacement)("");
      setNote({ where, ok: true, text: savedKeyText(saved, k.label) });
    } catch (e) {
      if (!live(scope)) return;
      setNote({ where, ok: false, text: `Not saved: ${withoutKey(errorText(e), value)}` });
      // A failed replacement keeps its input, with what was typed, to fix and send again.
      setUi(where === "add" ? IDLE : { kind: "replacing", provider: k.provider });
      return;
    }
    setUi(IDLE);
    void load(scope);
  };

  const remove = async (k: ProviderKey) => {
    if (busy || hermes.profile !== profile) return;
    const scope = scopes.current;
    setUi({ kind: "removing", provider: k.provider });
    setNote(undefined);
    let failed: string | undefined;
    try {
      await hermes.removeProviderKey(k.envVar);
    } catch (e) {
      failed = errorText(e);
    }
    if (!live(scope)) return;
    // Whatever the removal answered, the list decides: one that timed out after the delete may have removed the key.
    const read = await load(scope);
    if (!live(scope)) return;
    const after = read?.unsupported ? undefined : read;
    setUi(IDLE);
    if (!after)
      setNote(
        failed
          ? { where: `row:${k.provider}`, ok: false, text: `Not removed: ${failed} The list couldn't be read again, so what it shows may be out of date.` }
          : { where: "list", ok: false, text: `Removed the ${k.label} key, but the list couldn't be read again to confirm it.` },
      );
    else if (after.keys.find((x) => x.provider === k.provider)?.isSet)
      setNote({ where: `row:${k.provider}`, ok: false, text: `Not removed: ${failed ?? `Hermes still lists a ${k.label} key. It may be set another way on the server.`}` });
    else setNote({ where: "list", ok: true, text: `Removed the ${k.label} key from the ${profile} profile.` });
  };

  const noteLine = (where: Note["where"]) =>
    note?.where === where && (
      <div className={`pk-line ${note.ok ? "ok" : "bad"}`} role={note.ok ? "status" : "alert"}>
        {note.text}
      </div>
    );

  if (!connected)
    return (
      <SettingsSection title="Saved keys">
        <SettingNote role="status">Not connected to Hermes. The provider keys show once it's connected.</SettingNote>
      </SettingsSection>
    );
  if (!setup)
    return (
      <SettingsSection title="Saved keys">
        {loadError ? (
          <SettingNote tone="bad" role="alert">
            <AlertTriangle size={14} />
            <span>Couldn't read the providers from Hermes: {loadError}</span>
            <button className="btn" onClick={() => void load()}>
              Try again
            </button>
          </SettingNote>
        ) : (
          <SettingNote role="status">
            <Spinner /> Asking Hermes…
          </SettingNote>
        )}
      </SettingsSection>
    );
  if (setup.unsupported || !setup.keys.length)
    return (
      <SettingsSection title="Saved keys">
        <SettingNote role="status">
          <Info size={14} />
          <span>
            This Hermes server doesn't let Hermes Chat set provider keys{setup.unsupported ? ` (${setup.unsupported})` : ""}. Set them on the server instead, for
            example on the dashboard's Keys page.
          </span>
        </SettingNote>
      </SettingsSection>
    );

  const saved = setup.keys.filter((k) => k.isSet);
  const unset = setup.keys.filter((k) => !k.isSet);
  const pick = unset.find((k) => k.provider === chosen) ?? unset[0];
  const profileName = <span className="mono">{profile}</span>;

  const savedRow = (k: ProviderKey) => {
    const mine = ui.kind !== "idle" && ui.provider === k.provider ? ui : undefined;
    const inputId = `${ids}-${k.provider}`;
    const replacing = mine?.kind === "replacing" || mine?.kind === "saving";
    return (
      <SettingRow
        key={k.provider}
        name={k.label}
        hint={
          <>
            Saved on the server: <code>{k.preview ?? "«redacted»"}</code>
          </>
        }
        control={
          !mine && (
            <>
              <button
                className="btn"
                disabled={busy}
                aria-label={`Replace the ${k.label} key`}
                onClick={() => {
                  setReplacement("");
                  setNote(undefined);
                  setUi({ kind: "replacing", provider: k.provider });
                }}
              >
                <KeyRound size={13} aria-hidden /> Replace
              </button>
              <button
                className="btn"
                disabled={busy}
                aria-label={`Remove the ${k.label} key`}
                onClick={() => {
                  setNote(undefined);
                  setUi({ kind: "confirmRemove", provider: k.provider });
                }}
              >
                <Trash2 size={13} aria-hidden /> Remove
              </button>
            </>
          )
        }
      >
        {replacing && (
          <>
            <input
              id={inputId}
              className="pk-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              aria-label={`New ${k.label} key`}
              placeholder="Paste the new key"
              value={replacement}
              disabled={busy}
              onChange={(e) => setReplacement(e.target.value)}
            />
            <div className="confirm-actions">
              <button className="btn" disabled={busy} onClick={() => setUi(IDLE)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy || !replacement.trim()} aria-label={`Check and save the new ${k.label} key`} onClick={() => void save(k, replacement, `row:${k.provider}`)}>
                {mine?.kind === "saving" && <Spinner />} {mine?.kind === "saving" ? "Checking…" : "Check and save"}
              </button>
            </div>
          </>
        )}
        {(mine?.kind === "confirmRemove" || mine?.kind === "removing") && (
          <div className="confirm set-confirm" role="alertdialog" aria-label={`Remove the ${k.label} key?`}>
            <span className="confirm-msg">
              Remove the {k.label} key from the {profileName} profile on the server?
            </span>
            <div className="confirm-actions">
              <button className="btn" disabled={busy} onClick={() => setUi(IDLE)}>
                Cancel
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void remove(k)}>
                {mine.kind === "removing" && <Spinner />} {mine.kind === "removing" ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        )}
        {noteLine(`row:${k.provider}`)}
      </SettingRow>
    );
  };

  return (
    <>
      <SettingsSection
        title="Saved keys"
        intro={setup.ready.length ? `Hermes can use ${setup.ready.join(", ")} now.` : "Hermes doesn't list a model provider it can use yet. Add a key to start chatting."}
      >
        {loadError && (
          <SettingNote tone="bad" role="alert">
            <AlertTriangle size={14} />
            <span>Couldn't read the providers from Hermes again: {loadError}</span>
            <button className="btn" onClick={() => void load()}>
              Try again
            </button>
          </SettingNote>
        )}
        {saved.length ? saved.map(savedRow) : <SettingNote role="status">No provider key is saved in the {profileName} profile yet.</SettingNote>}
        {note?.where === "list" && (
          <SettingNote tone={note.ok ? "muted" : "warn"} role={note.ok ? "status" : "alert"}>
            {note.text}
          </SettingNote>
        )}
      </SettingsSection>

      <SettingsSection
        title="Add a key"
        intro={
          <>
            Hermes checks the key with the provider, then saves it in the {profileName} profile's <code>.env</code> on the server. Hermes Chat doesn't keep it.
          </>
        }
      >
        {pick ? (
          <>
            <SettingRow
              name={<label htmlFor={`${ids}-provider`}>Provider</label>}
              about="Provider"
              hint={pick.url ? <>Get a key at <span className="mono">{pick.url}</span>.</> : undefined}
              control={
                <select
                  id={`${ids}-provider`}
                  value={pick.provider}
                  disabled={busy}
                  onChange={(e) => {
                    setChosen(e.target.value);
                    setNote(undefined);
                  }}
                >
                  {unset.map((k) => (
                    <option key={k.provider} value={k.provider}>
                      {k.label}
                    </option>
                  ))}
                </select>
              }
            />
            <SettingRow name={<label htmlFor={`${ids}-key`}>API key</label>} about="API key">
              <input
                id={`${ids}-key`}
                className="pk-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the key"
                value={addKey}
                disabled={busy}
                onChange={(e) => {
                  setAddKey(e.target.value);
                  setNote(undefined);
                }}
              />
              <div className="confirm-actions">
                <button className="btn primary" disabled={busy || !addKey.trim()} onClick={() => void save(pick, addKey, "add")}>
                  {ui.kind === "saving" && ui.provider === pick.provider && <Spinner />} {ui.kind === "saving" && ui.provider === pick.provider ? "Checking…" : "Check and save"}
                </button>
              </div>
              {noteLine("add")}
            </SettingRow>
          </>
        ) : (
          <SettingNote role="status">Hermes has a key saved for every provider it offers. Replace one above to change it.</SettingNote>
        )}
        {!pick && note?.where === "add" && (
          <SettingNote tone={note.ok ? "muted" : "warn"} role={note.ok ? "status" : "alert"}>
            {note.text}
          </SettingNote>
        )}
        <SettingNote>
          To pick the default model, open{" "}
          {openModel ? (
            <button className="link" onClick={openModel}>
              Settings → Model
            </button>
          ) : (
            "Settings → Model"
          )}
          .
        </SettingNote>
      </SettingsSection>
    </>
  );
}
