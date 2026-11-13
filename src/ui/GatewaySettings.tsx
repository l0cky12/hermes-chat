// Settings → Gateways (ADR 0073): a profile's Telegram and Discord gateways on the server, one platform at a time,
// picked in Settings' tree (ADR 0160). Each shows its state as Hermes reports it, its on/off switch, and its settings. A token is write-only: the
// row shows Hermes's redacted preview, and Replace or Remove changes it only on Save; a row left alone keeps what Hermes
// has. Save reads the platform first and sends nothing if it changed on the server, then reads it again to confirm.
// Check status asks Hermes how the connection is; it sends no message (gateways.ts).
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Info, KeyRound, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { AppliesBox, EditingProfile, HeadPart, useInPage } from "./SettingsPage";
import { Spinner } from "./bits";
import {
  type Draft,
  type FieldEdit,
  type Gateway,
  type GatewayField,
  type GatewayList,
  type GatewaysApi,
  type PlatformId,
  type Problem,
  type SaveResult,
  type StatusCheck,
  GatewaysReadError,
  GatewaysUnsupportedError,
  changed,
  draftProblem,
} from "../hermes/gateways";
import { clockTime, errorText } from "../hermes/values";

type Note = { tone: "ok" | "warn" | "bad"; text: string; problem?: Problem };

const fresh = (g: Gateway): Draft => ({ enabled: g.enabled, edits: {} });

/** Where each platform's token comes from, and the Hermes extra that installs its library. */
const ABOUT: Record<PlatformId, { tokenFrom: string; extra: string }> = {
  telegram: { tokenFrom: "Telegram's @BotFather", extra: "telegram" },
  discord: { tokenFrom: "the Discord Developer Portal (your application → Bot → Reset Token)", extra: "discord" },
};

/** Hermes's state for a platform, as a badge and a line under it. */
function stateOf(g: Gateway): { tone: "ok" | "warn" | "bad" | "off"; badge: string; text: string } {
  switch (g.state) {
    case "disabled":
      return { tone: "off", badge: "Off", text: "Turned off: the gateway doesn't connect to it." };
    case "not_configured":
      return { tone: "warn", badge: "Needs setup", text: "Turned on, but a required setting is missing." };
    case "gateway_stopped":
      return { tone: "warn", badge: "Gateway stopped", text: "The profile's gateway isn't running on the server, so nothing connects until it starts." };
    case "pending_restart":
      return { tone: "warn", badge: "Restart needed", text: "The gateway is running but hasn't picked this up. Restart it on the server to connect." };
    case "connected":
      return { tone: "ok", badge: "Connected", text: "The gateway is connected." };
    case "connecting":
      return { tone: "warn", badge: "Connecting", text: "The gateway is connecting." };
    case "retrying":
      return { tone: "warn", badge: "Retrying", text: "The gateway lost the connection and is trying again." };
    case "startup_failed":
    case "fatal":
      return { tone: "bad", badge: "Not connected", text: "The gateway couldn't connect." };
    default:
      return { tone: "warn", badge: g.state.replace(/_/g, " "), text: `Hermes reports "${g.state}".` };
  }
}

/** A problem in words: what kind it is first, so a refused permission, a bad token and a missing package read apart. */
function ProblemText({ problem, g }: { problem: Problem; g: Gateway }) {
  const head: Record<Problem["kind"], string> = {
    permission: "Permission refused",
    "invalid-token": "Token turned down",
    "missing-dependency": "Missing on the server",
    other: "Problem",
  };
  const after: Record<Problem["kind"], string> = {
    permission: "Hermes, or the platform, doesn't allow this. Nothing here can change that; check the account or the server's settings.",
    "invalid-token": `Paste a new token from ${ABOUT[g.id].tokenFrom}.`,
    "missing-dependency": `Hermes couldn't load what ${g.name} needs where it runs, usually its library. Install Hermes's "${ABOUT[g.id].extra}" extra there, then restart the gateway.`,
    other: "",
  };
  return (
    <span className={`gw-problem ${problem.kind}`}>
      <strong>{head[problem.kind]}:</strong> {problem.text}
      {after[problem.kind] && <> {after[problem.kind]}</>}
    </span>
  );
}

/** What a save came to, in words. */
function saveNote(r: SaveResult, g: Gateway): Note {
  if (r.kind === "saved")
    return r.restart
      ? { tone: "warn", text: `Saved, and Hermes reads it back that way. The running gateway keeps its old ${g.name} settings until it restarts: restart it on the server to use them.` }
      : { tone: "ok", text: "Saved, and Hermes reads it back that way." };
  if (r.kind === "conflict") return { tone: "warn", text: `Not saved: ${g.name} changed on the server since this screen read it. This is what Hermes has now; check your changes and save again.` };
  if (r.kind === "refused") return { tone: "bad", text: "Not saved.", problem: r.problem };
  return { tone: "warn", text: `Hermes didn't confirm it: ${r.reason} The screen shows what Hermes has now.` };
}

export function GatewaySettings({
  api,
  profile,
  shown: inUse,
  connected,
  picker,
  openUrl,
  platform = "telegram",
  onPlatforms,
}: {
  api: GatewaysApi;
  profile: string;
  /** The profile the app uses; the header marks a picked profile that isn't it. */
  shown?: string;
  connected: boolean;
  picker?: ReactNode;
  openUrl: (url: string) => Promise<void> | void;
  /** The platform shown, picked in Settings' tree. */
  platform?: PlatformId;
  /** Told which platforms this Hermes offers, once read, so Settings' tree offers only those. */
  onPlatforms?: (ids: PlatformId[]) => void;
}) {
  const [list, setList] = useState<GatewayList>();
  const [problem, setProblem] = useState<{ unsupported: boolean; permission: boolean; text: string }>();
  const [loading, setLoading] = useState(false);
  const selected = platform;
  const inPage = useInPage();
  const [drafts, setDrafts] = useState<Partial<Record<PlatformId, Draft>>>({});
  const [notes, setNotes] = useState<Partial<Record<PlatformId, Note>>>({});
  const [checks, setChecks] = useState<Partial<Record<PlatformId, StatusCheck>>>({});
  const [busy, setBusy] = useState<Partial<Record<PlatformId, "save" | "check">>>({});
  const live = useRef(true);
  // Every answer is for the profile asked; one that comes back after a switch is dropped.
  const shown = useRef(profile);
  shown.current = profile;
  const mine = (p: string) => live.current && shown.current === p;

  const load = useCallback(async () => {
    const p = profile;
    setLoading(true);
    try {
      const l = await api.list(p);
      if (!mine(p)) return;
      setList(l);
      setProblem(undefined);
    } catch (e) {
      if (mine(p)) setProblem({ unsupported: e instanceof GatewaysUnsupportedError, permission: e instanceof GatewaysReadError && e.kind === "permission", text: errorText(e) });
    } finally {
      if (mine(p)) setLoading(false);
    }
  }, [api, profile]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const gateways = list?.gateways ?? [];
  const g = gateways.find((x) => x.id === selected) ?? gateways[0];
  const offered = gateways.map((x) => x.id).join(" ");
  useEffect(() => {
    if (list) onPlatforms?.(offered ? (offered.split(" ") as PlatformId[]) : []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tell Settings when the offered platforms change, not on every new callback
  }, [offered, !!list]);

  // Under Settings' page header (ADR 0160) the profile, Reload and when a change applies are the header's.
  const profileRow = inPage ? (
    <HeadPart at="profile">
      <EditingProfile picker={picker ?? <span className="mono">{profile}</span>} inUse={!inUse || inUse === profile} />
    </HeadPart>
  ) : (
    <SettingRow name="Profile" control={picker ?? <span className="set-value mono">{profile}</span>} />
  );
  const reload = (
    <button className="btn" disabled={!connected || loading} onClick={() => void load()}>
      <RefreshCw size={14} aria-hidden /> Reload
    </button>
  );
  const about = (
    <p>
      Hermes keeps each token in the profile's .env on the server and shows only a redacted preview of it, so this app never has it back. A change applies the next time the profile's gateway starts. Nothing here sends a message, and Check
      status only asks Hermes how the connection is.
    </p>
  );

  if (problem)
    return (
      <SettingsSection title="Gateways" titleId="gw-heading" bare={inPage}>
        {profileRow}
        <SettingNote tone={problem.unsupported ? "muted" : "bad"} role="alert">
          {problem.unsupported ? <Info size={14} /> : <AlertTriangle size={14} />}
          <span>{problem.unsupported ? problem.text : problem.permission ? `Permission refused: Hermes won't let this sign-in read the gateways: ${problem.text}` : `Couldn't read the gateways: ${problem.text}`}</span>
          {!problem.unsupported && (
            <button className="btn" disabled={!connected || loading} onClick={() => void load()}>
              <RefreshCw size={14} /> {loading ? "Trying…" : "Try again"}
            </button>
          )}
        </SettingNote>
      </SettingsSection>
    );

  const status = !list ? (
    <SettingNote role="status">{connected ? "Reading the gateways from Hermes…" : "Not connected to Hermes. The gateways show once it's connected."}</SettingNote>
  ) : !gateways.length ? (
    <SettingNote role="status">This Hermes offers neither Telegram nor Discord.</SettingNote>
  ) : (
    !connected && (
      <SettingNote tone="warn" role="status">
        <AlertTriangle size={14} />
        <span>Not connected to Hermes. This is what it had at {clockTime(list.readAt)}; reconnect to change it.</span>
      </SettingNote>
    )
  );
  const head = inPage ? (
    <>
      {profileRow}
      <HeadPart at="actions">{reload}</HeadPart>
      <HeadPart at="applies">
        <AppliesBox line="A change applies the next time the profile's gateway starts. The gateway runs on the server, which keeps the tokens." more="Details">
          <div className="applies-text">{about}</div>
        </AppliesBox>
      </HeadPart>
      {status && (
        <SettingsSection title="Gateways" bare>
          {status}
        </SettingsSection>
      )}
    </>
  ) : (
    <SettingsSection
      title="Gateways"
      titleId="gw-heading"
      intro="Reach this profile's Hermes from Telegram or Discord. The gateway runs on the server, and Hermes keeps the tokens there."
      more={about}
      action={reload}
    >
      {profileRow}
      {!list ? (
        <SettingNote role="status">{connected ? "Reading the gateways from Hermes…" : "Not connected to Hermes. The gateways show once it's connected."}</SettingNote>
      ) : !gateways.length ? (
        <SettingNote role="status">This Hermes offers neither Telegram nor Discord.</SettingNote>
      ) : (
        !connected && (
          <SettingNote tone="warn" role="status">
            <AlertTriangle size={14} />
            <span>Not connected to Hermes. This is what it had at {clockTime(list.readAt)}; reconnect to change it.</span>
          </SettingNote>
        )
      )}
    </SettingsSection>
  );

  if (!list || !g) return head;

  const draft = drafts[g.id] ?? fresh(g);
  const setDraft = (d: Draft) => setDrafts((all) => ({ ...all, [g.id]: d }));
  const setEdit = (key: string, e: FieldEdit) => setDraft({ ...draft, edits: { ...draft.edits, [key]: e } });
  const b = busy[g.id];
  const locked = !connected || !!b;
  const dirty = changed(g, draft);
  const local = draftProblem(g, draft);
  const note = notes[g.id];
  const check = checks[g.id];
  const st = stateOf(g);

  const save = async () => {
    const p = profile;
    const id = g.id;
    setBusy((all) => ({ ...all, [id]: "save" }));
    setNotes((all) => ({ ...all, [id]: undefined }));
    const r = await api.save(p, g, draft);
    if (!mine(p)) return;
    setBusy((all) => ({ ...all, [id]: undefined }));
    if (r.list) setList(r.list);
    // A typed token goes once Hermes may have it; a refusal or a conflict keeps the draft to fix and send again.
    if (r.kind === "saved" || r.kind === "unconfirmed") setDrafts((all) => ({ ...all, [id]: undefined }));
    setChecks((all) => ({ ...all, [id]: undefined }));
    setNotes((all) => ({ ...all, [id]: saveNote(r, g) }));
  };

  const runCheck = async () => {
    const p = profile;
    const id = g.id;
    setBusy((all) => ({ ...all, [id]: "check" }));
    const { check: c, list: l } = await api.check(p, id);
    if (!mine(p)) return;
    setBusy((all) => ({ ...all, [id]: undefined }));
    if (l) setList(l);
    setChecks((all) => ({ ...all, [id]: c }));
  };

  const fieldRow = (f: GatewayField) => {
    const e = draft.edits[f.key] ?? { kind: "keep" };
    const inputId = `gw-${g.id}-${f.key}`;
    if (!f.secret) {
      const value = e.kind === "replace" ? e.value : (f.value ?? "");
      return (
        <SettingRow key={f.key} name={<label htmlFor={inputId}>{f.label}</label>} about={f.label} hint={f.hint} more={f.url ? <p>See {f.url}</p> : undefined}>
          <input id={inputId} className="gw-input" value={value} disabled={locked} spellCheck={false} autoComplete="off" onChange={(ev) => setEdit(f.key, { kind: "replace", value: ev.target.value })} />
        </SettingRow>
      );
    }
    const now =
      e.kind === "remove" ? (
        <>Removed on Save.{f.required && ` Without it, ${g.name} can't connect.`}</>
      ) : f.set ? (
        <>
          Set on the server: <span className="mono">{f.preview ?? "«redacted»"}</span>
        </>
      ) : (
        <>Not set.</>
      );
    return (
      <SettingRow
        key={f.key}
        name={e.kind === "replace" ? <label htmlFor={inputId}>{f.label}</label> : f.label}
        about={f.label}
        hint={<span>{now}</span>}
        more={f.hint ? <p>{f.hint}</p> : undefined}
        control={
          e.kind === "keep" ? (
            <>
              <button className="btn" disabled={locked} aria-label={`${f.set ? "Replace" : "Add"} ${f.label}`} onClick={() => setEdit(f.key, { kind: "replace", value: "" })}>
                <KeyRound size={13} aria-hidden /> {f.set ? "Replace" : "Add"}
              </button>
              {f.set && (
                <button className="btn" disabled={locked} aria-label={`Remove ${f.label}`} onClick={() => setEdit(f.key, { kind: "remove" })}>
                  <Trash2 size={13} aria-hidden /> Remove
                </button>
              )}
            </>
          ) : (
            <button className="btn" disabled={locked} aria-label={`Keep ${f.label} as it is`} onClick={() => setEdit(f.key, { kind: "keep" })}>
              <Undo2 size={13} aria-hidden /> {f.set ? "Keep current" : "Cancel"}
            </button>
          )
        }
      >
        {e.kind === "replace" && (
          <input
            id={inputId}
            className="gw-input"
            type="password"
            autoFocus
            value={e.value}
            disabled={locked}
            spellCheck={false}
            autoComplete="off"
            placeholder={f.set ? "Paste the new value. Left empty, the current one stays." : "Paste the value"}
            onChange={(ev) => setEdit(f.key, { kind: "replace", value: ev.target.value })}
          />
        )}
      </SettingRow>
    );
  };

  return (
    <>
      {head}
      <SettingsSection
            bare={inPage}
            title={g.name}
            titleId={`gw-${g.id}-heading`}
            intro={g.description}
            more={
              <p>
                The bot token comes from {ABOUT[g.id].tokenFrom}. Allowed user IDs are the {g.name} accounts that may talk to Hermes; left empty, Hermes asks new users to pair first.
                {g.docsUrl && (
                  <>
                    {" "}
                    <button className="link" onClick={() => void Promise.resolve(openUrl(g.docsUrl!)).catch(() => undefined)}>
                      {g.name}'s guide <ExternalLink size={12} aria-hidden />
                    </button>
                  </>
                )}
              </p>
            }
          >
            <SettingRow
              name="Status"
              hint={st.text}
              more={
                inPage && (
                  <p>
                    The bot token comes from {ABOUT[g.id].tokenFrom}. Allowed user IDs are the {g.name} accounts that may talk to Hermes; left empty, Hermes asks new users to pair first.
                  </p>
                )
              }
              control={
                <span className={`badge ${st.tone === "off" ? "off" : st.tone}`} role="status">
                  {st.badge}
                </span>
              }
            >
              {g.error && (
                <div className="gw-line" role="alert">
                  <ProblemText problem={g.error} g={g} />
                </div>
              )}
              {g.state === "gateway_stopped" && list.startCommand && (
                <div className="gw-line">
                  Start it on the server with <span className="mono">{list.startCommand}</span>.
                </div>
              )}
            </SettingRow>
            <SettingRow
              name={<span id={`gw-${g.id}-on`}>Turned on</span>}
              about="Turned on"
              hint={draft.enabled === g.enabled ? `The gateway connects to ${g.name} only while this is on.` : `${draft.enabled ? "Turned on" : "Turned off"} on Save.`}
              control={
                <button className="switch" role="switch" aria-checked={draft.enabled} aria-labelledby={`gw-${g.id}-on`} disabled={locked} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}>
                  <span className="switch-knob" />
                </button>
              }
            />
            {g.fields.map(fieldRow)}
            <SettingRow
              name="Check status"
              hint="Asks Hermes how the connection is. It sends no message."
              control={
                <button className="btn" disabled={locked} onClick={() => void runCheck()}>
                  {b === "check" && <Spinner />} {b === "check" ? "Checking…" : "Check status"}
                </button>
              }
            >
              {check && (
                <div className={`gw-line ${check.ok ? "ok" : "bad"}`} role="status">
                  {check.problem ? <ProblemText problem={check.problem} g={g} /> : <span>{check.text}</span>} <span className="muted">({clockTime(check.at)})</span>
                </div>
              )}
            </SettingRow>
            {/* Save reads like Model's footer: the state, then Discard and Save. */}
            <div className="set-note set-commit">
              <span>{local ?? (dirty ? "Hermes is read first, and nothing is sent if it changed meanwhile." : "No changes.")}</span>
              <span className="set-commit-actions">
                <button className="btn" disabled={!!b || (!dirty && !drafts[g.id])} onClick={() => setDrafts((all) => ({ ...all, [g.id]: undefined }))}>
                  Discard
                </button>
                <button className="btn primary" disabled={locked || !dirty || !!local} onClick={() => void save()}>
                  {b === "save" && <Spinner />} {b === "save" ? "Saving…" : "Save"}
                </button>
              </span>
              {note && (
                <div className={`gw-line ${note.tone}`} role={note.tone === "bad" ? "alert" : "status"}>
                  {note.text} {note.problem && <ProblemText problem={note.problem} g={g} />}
                </div>
              )}
            </div>
      </SettingsSection>
    </>
  );
}
