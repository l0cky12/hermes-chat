// Settings → Providers, Subscription sign-ins (ADR 0106): the shown profile's subscription providers on Hermes. A
// device-code provider signs in from here: Hermes gives a code, the page to enter it at opens in the browser, and the
// screen waits on Hermes until the sign-in ends. A provider whose sign-in is `external` shows the command to run on the
// server. Signed in or out is always what Hermes's list says, read again after each change.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ExternalLink, Info, LogIn, LogOut } from "lucide-react";
import type { AccountsApi, Listed, ProviderSignIn, StartedSignIn } from "../hermes/accounts";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { Spinner } from "./bits";

export type SignInApi = Pick<AccountsApi, "signIns" | "startSignIn" | "waitSignIn" | "cancelSignIn" | "signedIn" | "signOut">;

/** The shortest time between two polls, for a Hermes that answers a poll at once instead of waiting. */
export const SIGN_IN_POLL_GAP_MS = 2000;

/** The one thing the section is doing: at most one sign-in or sign-out at a time. */
type Ui =
  | { kind: "idle" }
  | { kind: "starting"; id: string }
  | { kind: "waiting"; id: string; started: StartedSignIn }
  | { kind: "confirmSignOut"; id: string }
  | { kind: "signingOut"; id: string };

const IDLE: Ui = { kind: "idle" };

type Note = { id?: string; ok: boolean; text: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function SignInSettings({
  api,
  profile,
  connected,
  openUrl,
  pollGapMs = SIGN_IN_POLL_GAP_MS,
}: {
  api: SignInApi;
  profile: string;
  connected: boolean;
  openUrl: (url: string) => Promise<void> | void;
  pollGapMs?: number;
}) {
  const [list, setList] = useState<Listed<ProviderSignIn>>();
  const [loadError, setLoadError] = useState<string>();
  const [ui, setUi] = useState<Ui>(IDLE);
  const [note, setNote] = useState<Note>();
  // As in ProviderSettings: `scopes` moves on with the profile or connection, so a late answer for another is dropped.
  const scopes = useRef(0);
  const reads = useRef(0);
  const live = (scope: number) => scope === scopes.current;
  // The sign-in this screen waits on. Cleared on Cancel, or when the screen goes, which cancels it on Hermes too.
  const session = useRef<string | undefined>(undefined);

  const load = (scope = scopes.current): Promise<Listed<ProviderSignIn> | undefined> => {
    if (!live(scope)) return Promise.resolve(undefined);
    const read = ++reads.current;
    return api.signIns(profile).then(
      (l) => {
        if (live(scope) && read === reads.current) {
          setList(l);
          setLoadError(undefined);
        }
        return l;
      },
      (e) => {
        if (live(scope) && read === reads.current) setLoadError(messageOf(e));
        return undefined;
      },
    );
  };

  useEffect(() => {
    const scope = ++scopes.current;
    setList(undefined);
    setLoadError(undefined);
    setUi(IDLE);
    setNote(undefined);
    if (connected) void load(scope);
    return () => {
      scopes.current++;
      const s = session.current;
      session.current = undefined;
      if (s) void api.cancelSignIn(profile, s);
    };
  }, [api, profile, connected]);

  const busy = ui.kind !== "idle" && ui.kind !== "confirmSignOut";

  const open = (url: string, id: string) =>
    void Promise.resolve(openUrl(url)).catch((e) => setNote({ id, ok: false, text: `Couldn't open your browser: ${messageOf(e)} Open ${url} yourself.` }));

  /** After a cancel: Hermes may have finished the sign-in before the cancel reached it, so the list says. */
  const afterCancel = async (scope: number, p: ProviderSignIn) => {
    if (!live(scope) || session.current) return;
    const after = await load(scope);
    if (!live(scope) || session.current || !after?.items.find((x) => x.id === p.id)?.signedIn) return;
    setNote({ id: p.id, ok: true, text: `Signed in to ${p.name} after all: Hermes finished the sign-in before the cancel reached it.` });
    await api.signedIn(profile).catch(() => undefined);
  };

  /** Waits on Hermes until the sign-in leaves `pending`, then reads the list to see whether it took. */
  const follow = async (scope: number, p: ProviderSignIn, started: StartedSignIn) => {
    const mine = () => live(scope) && session.current === started.session;
    let ended: { approved: true } | { approved: false; why: string };
    for (;;) {
      const t0 = Date.now();
      const progress = await api.waitSignIn(profile, p.id, started.session).catch((e: unknown) => ({ state: "failed" as const, why: `Lost track of it: ${messageOf(e)}` }));
      if (!mine()) return afterCancel(scope, p);
      if (progress.state === "approved") ended = { approved: true };
      else if (progress.state === "failed") ended = { approved: false, why: progress.why };
      else {
        await sleep(Math.max(0, pollGapMs - (Date.now() - t0)));
        if (!mine()) return afterCancel(scope, p);
        continue;
      }
      break;
    }
    session.current = undefined;
    if (!ended.approved) {
      // A poll that failed may leave the session running on Hermes.
      void api.cancelSignIn(profile, started.session);
      setUi(IDLE);
      setNote({ id: p.id, ok: false, text: `Not signed in: ${ended.why}` });
      return;
    }
    await api.signedIn(profile).catch(() => undefined);
    const after = await load(scope);
    if (!live(scope)) return;
    setUi(IDLE);
    if (after?.items.find((x) => x.id === p.id)?.signedIn) setNote({ id: p.id, ok: true, text: `Signed in to ${p.name}.` });
    else setNote({ id: p.id, ok: false, text: `Hermes says the sign-in finished, but ${after ? "doesn't list" : "its list couldn't be read to confirm"} ${p.name} as signed in.` });
  };

  const signIn = async (p: ProviderSignIn) => {
    if (busy) return;
    const scope = scopes.current;
    setUi({ kind: "starting", id: p.id });
    setNote(undefined);
    let started: StartedSignIn;
    try {
      started = await api.startSignIn(profile, p.id);
    } catch (e) {
      if (!live(scope)) return;
      setUi(IDLE);
      setNote({ id: p.id, ok: false, text: `Couldn't start the sign-in: ${messageOf(e)}` });
      return;
    }
    if (!live(scope)) {
      void api.cancelSignIn(profile, started.session);
      return;
    }
    session.current = started.session;
    setUi({ kind: "waiting", id: p.id, started });
    open(started.verificationUrl, p.id);
    void follow(scope, p, started);
  };

  const cancel = (p: ProviderSignIn) => {
    const s = session.current;
    session.current = undefined;
    if (s) void api.cancelSignIn(profile, s);
    setUi(IDLE);
    setNote({ id: p.id, ok: true, text: "Sign-in cancelled." });
  };

  const signOut = async (p: ProviderSignIn) => {
    const scope = scopes.current;
    setUi({ kind: "signingOut", id: p.id });
    setNote(undefined);
    let failed: string | undefined;
    try {
      await api.signOut(profile, p.id);
    } catch (e) {
      failed = messageOf(e);
    }
    if (!live(scope)) return;
    // The list decides, as for a key: Hermes's 409 says it had nothing stored, which may still leave it signed in.
    const after = await load(scope);
    if (!live(scope)) return;
    setUi(IDLE);
    const row = after?.items.find((x) => x.id === p.id);
    if (!after) setNote({ id: p.id, ok: false, text: `${failed ? `Not signed out: ${failed}` : "Hermes took the sign-out"}, and the list couldn't be read again to confirm it.` });
    else if (row?.signedIn) setNote({ id: p.id, ok: false, text: `Not signed out: ${failed ?? `Hermes still lists ${p.name} as signed in.`}` });
    else setNote({ id: p.id, ok: true, text: `Signed out of ${p.name}.` });
  };

  const section = (children: ReactNode) => (
    <SettingsSection
      title="Subscription sign-ins"
      intro={
        <>
          Use a subscription instead of an API key. Hermes keeps the sign-in on the server, in the <span className="mono">{profile}</span> profile.
        </>
      }
    >
      {children}
    </SettingsSection>
  );

  if (!connected) return section(<SettingNote role="status">Not connected to Hermes. The sign-ins show once it's connected.</SettingNote>);
  if (!list)
    return section(
      loadError ? (
        <SettingNote tone="bad" role="alert">
          <AlertTriangle size={14} />
          <span>Couldn't read the sign-ins from Hermes: {loadError}</span>
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
  if (list.unsupported || !list.items.length)
    return section(
      <SettingNote role="status">
        <Info size={14} />
        <span>
          This Hermes server doesn't let Hermes Chat sign in to subscription providers{list.unsupported ? ` (${list.unsupported})` : ""}. Sign in on the server instead,
          with <code>hermes auth add</code>.
        </span>
      </SettingNote>,
    );

  const row = (p: ProviderSignIn) => {
    const mine = ui.kind !== "idle" && ui.id === p.id ? ui : undefined;
    const state = p.signedIn ? `Signed in${p.expiresAt ? `, until ${new Date(p.expiresAt).toLocaleString()}` : ""}` : "Not signed in";
    return (
      <SettingRow
        key={p.id}
        name={p.name}
        hint={
          <>
            {state}.
            {p.flow === "external" && (
              <>
                {" "}
                Hermes Chat can't sign in to this one. Run <code>{p.command ?? `hermes auth add ${p.id}`}</code> on the server.
              </>
            )}
            {p.signOutHint && <> {p.signOutHint}</>}
          </>
        }
        control={
          !mine &&
          (p.signedIn
            ? p.canSignOut && (
                <button className="btn" disabled={busy} aria-label={`Sign out of ${p.name}`} onClick={() => setUi({ kind: "confirmSignOut", id: p.id })}>
                  <LogOut size={13} aria-hidden /> Sign out
                </button>
              )
            : p.flow === "device_code" && (
                <button className="btn" disabled={busy} aria-label={`Sign in to ${p.name}`} onClick={() => void signIn(p)}>
                  <LogIn size={13} aria-hidden /> Sign in
                </button>
              ))
        }
      >
        {mine?.kind === "starting" && (
          <div className="pk-line" role="status">
            <Spinner /> Asking Hermes for a code…
          </div>
        )}
        {mine?.kind === "waiting" && (
          <div className="si-code" role="status" aria-label={`Sign-in code for ${p.name}`}>
            <span>
              Enter this code at <span className="mono">{mine.started.verificationUrl}</span>:
            </span>
            <code className="si-user-code">{mine.started.userCode}</code>
            <span className="pk-line">
              <Spinner /> Waiting for you to finish in the browser…
            </span>
            <div className="confirm-actions">
              <button className="btn" onClick={() => cancel(p)}>
                Cancel
              </button>
              <button className="btn" onClick={() => open(mine.started.verificationUrl, p.id)}>
                <ExternalLink size={13} aria-hidden /> Open the page again
              </button>
            </div>
          </div>
        )}
        {(mine?.kind === "confirmSignOut" || mine?.kind === "signingOut") && (
          <div className="confirm set-confirm" role="alertdialog" aria-label={`Sign out of ${p.name}?`}>
            <span className="confirm-msg">
              Sign out of {p.name} in the <span className="mono">{profile}</span> profile on the server?
            </span>
            <div className="confirm-actions">
              <button className="btn" disabled={busy} onClick={() => setUi(IDLE)}>
                Cancel
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void signOut(p)}>
                {mine.kind === "signingOut" && <Spinner />} {mine.kind === "signingOut" ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </div>
        )}
        {note?.id === p.id && (
          <div className={`pk-line ${note.ok ? "ok" : "bad"}`} role={note.ok ? "status" : "alert"}>
            {note.text}
          </div>
        )}
      </SettingRow>
    );
  };

  return section(
    <>
      {loadError && (
        <SettingNote tone="bad" role="alert">
          <AlertTriangle size={14} />
          <span>Couldn't read the sign-ins from Hermes again: {loadError}</span>
          <button className="btn" onClick={() => void load()}>
            Try again
          </button>
        </SettingNote>
      )}
      {list.items.map(row)}
    </>,
  );
}
