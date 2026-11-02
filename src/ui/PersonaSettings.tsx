// Settings → Persona: the shown profile's SOUL.md on the Hermes server, edited as plain text. Nothing is shown as saved
// until Hermes, read back, has it (persona.ts). An unsaved edit is kept on this computer, so leaving, closing the app,
// or a crash doesn't lose it, and each version a save replaced is kept to put back (personaStore.ts). The text is the
// owner's, but it is treated as untrusted: it is only ever a textarea's value, never rendered.
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, History, RotateCcw, Save, TriangleAlert, Undo2, X } from "lucide-react";
import { asReadBack, PersonaError, sameSoul, soulNotes, type PersonaApi, type ProfileHome, type Soul } from "../hermes/persona";
import { EARLIER_KEPT, type EarlierSoul, type PersonaDraft, type PersonaStore } from "../hermes/personaStore";

/** Where SOUL.md is, as the screen names it. */
export type PersonaWhere = {
  /** How the app reaches the server, e.g. `liam@hermes` or `hermes:9119`. */
  server: string;
  /** The route in full, e.g. `ssh://liam@hermes`. */
  route?: string;
  profile: string;
};

type Load =
  | { state: "loading" }
  | { state: "problem"; problem: PersonaError }
  /** `server`: SOUL.md as last read. `base`: the SOUL.md the edit started from; a Save checks Hermes still has it. */
  | { state: "loaded"; server: Soul; base: Soul; readAt: number };

/** What happened last, shown under the editor. */
type Notice =
  | { kind: "saved"; at: number; created: boolean }
  | { kind: "unverified"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "reloaded"; at: number }
  | { kind: "discarded"; text: string; creating: boolean };

/** SOUL.md changed on the server under the edit. `written`: a save from here went through first. */
type Conflict = { server: Soul; written: boolean };

/** A question asked in place before something that would drop text or write something unusual. */
type Ask = "reload" | "empty" | "overwrite";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const chars = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "character" : "characters"}`;
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const when = (at: number) => {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? `today at ${clock(at)}` : `${d.toLocaleDateString()} at ${clock(at)}`;
};

export function PersonaSettings({
  api,
  where,
  connected,
  store,
  storeKey,
  onDirty,
  now = Date.now,
}: {
  api: PersonaApi;
  where: PersonaWhere;
  connected: boolean;
  store: PersonaStore;
  /** Where this connection and profile's edits are kept (personaStore.ts `personaKey`). */
  storeKey: string;
  /**
   * Says whether there is an edit Hermes doesn't have yet, so leaving can ask first, and whether this computer could
   * keep it. False once this closes.
   */
  onDirty: (dirty: boolean, kept: boolean) => void;
  now?: () => number;
}) {
  const { profile } = where;
  const [load, setLoad] = useState<Load>(() =>
    connected ? { state: "loading" } : { state: "problem", problem: new PersonaError("disconnected", "Not connected to Hermes.") },
  );
  const wasLoaded = useRef(false);
  wasLoaded.current = load.state === "loaded";
  const [home, setHome] = useState<ProfileHome>();
  const [text, setText] = useState("");
  /** Editing a SOUL.md that doesn't exist yet, which the owner asked to create. */
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  /** A reload under way: the editor is read-only until it lands, so its answer can't replace text typed meanwhile. */
  const [reloading, setReloading] = useState(false);
  /** The last write of the edit to this computer's storage worked. */
  const [kept, setKept] = useState(true);
  const [notice, setNotice] = useState<Notice>();
  const [conflict, setConflict] = useState<Conflict>();
  const [ask, setAsk] = useState<Ask>();
  /** An unsaved edit kept on this computer from before, until the owner restores or discards it. */
  const [recover, setRecover] = useState<PersonaDraft | undefined>(() => store.draft(storeKey));
  const [earlier, setEarlier] = useState<EarlierSoul[]>(() => store.earlier(storeKey));
  const [viewing, setViewing] = useState<number>();
  // Results that come back after this has closed, or for a read since replaced, are dropped.
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loaded = load.state === "loaded" ? load : undefined;
  const editing = !!loaded && (loaded.base.exists || creating);
  const dirty = editing && asReadBack(text) !== asReadBack(loaded.base.content);

  // Leaving asks first while there is an edit Hermes doesn't have, or a save whose outcome isn't known yet.
  useEffect(() => onDirty(dirty || saving, kept), [dirty, saving, kept, onDirty]);
  useEffect(() => () => onDirty(false, true), [onDirty]);

  // The edit is kept on this computer as it is typed. A kept edit waiting to be restored isn't overwritten meanwhile.
  useEffect(() => {
    if (!loaded || recover) return;
    setKept(store.setDraft(storeKey, dirty ? { text, base: loaded.base, at: now() } : undefined));
  }, [text, dirty, loaded?.base, recover]);

  const read = useCallback(
    async (then?: (soul: Soul) => void) => {
      const mine = ++seq.current;
      setLoad((l) => (l.state === "loaded" ? l : { state: "loading" }));
      setReloading(true);
      void api.home(profile).then(
        (h) => alive.current && setHome(h),
        () => {},
      );
      try {
        const soul = await api.read(profile);
        if (!alive.current || mine !== seq.current) return;
        setLoad({ state: "loaded", server: soul, base: soul, readAt: now() });
        setText(soul.content);
        setCreating(false);
        setConflict(undefined);
        then?.(soul);
      } catch (e) {
        if (!alive.current || mine !== seq.current) return;
        const problem = e instanceof PersonaError ? e : new PersonaError("error", messageOf(e));
        setLoad((l) => (l.state === "loaded" ? l : { state: "problem", problem }));
        if (wasLoaded.current) setNotice({ kind: "failed", message: `Couldn't reload: ${problem.message}` });
      } finally {
        if (alive.current && mine === seq.current) setReloading(false);
      }
    },
    [api, profile],
  );

  // Read once connected; a read that failed for want of a connection is tried again once it is back.
  useEffect(() => {
    if (!connected) return;
    if (load.state !== "loaded") void read();
  }, [connected]);

  // A kept edit that matches what Hermes has now is nothing to restore.
  useEffect(() => {
    if (loaded && recover && sameSoul({ exists: true, content: recover.text }, loaded.server) && loaded.server.exists) {
      setRecover(undefined);
      store.setDraft(storeKey, undefined);
    }
  }, [loaded?.server, recover]);

  const reload = () => {
    setAsk(undefined);
    const dropped = dirty ? { text, creating } : undefined;
    void read(() => setNotice(dropped ? { kind: "discarded", ...dropped } : { kind: "reloaded", at: now() }));
  };

  const cancel = () => {
    if (!loaded) return;
    if (dirty) setNotice({ kind: "discarded", text, creating });
    setText(loaded.base.content);
    setCreating(false);
    setAsk(undefined);
  };

  // Swaps the text set aside with what is in the editor now, so text typed since isn't lost either.
  const undoDiscard = () => {
    if (notice?.kind !== "discarded" || !loaded) return;
    setCreating(notice.creating && !loaded.base.exists);
    setText(notice.text);
    setNotice(dirty ? { kind: "discarded", text, creating } : undefined);
  };

  const save = async (base: Soul) => {
    if (!loaded) return;
    const sent = text;
    setAsk(undefined);
    setSaving(true);
    setNotice(undefined);
    try {
      const r = await api.save(profile, base, sent);
      // What a write replaced is kept, and a confirmed save's draft let go, even if the owner has left meanwhile.
      const replaced = r.kind === "conflict" ? undefined : store.addEarlier(storeKey, r.previous, now());
      if (r.kind === "saved") store.setDraft(storeKey, undefined);
      if (!alive.current) return;
      if (replaced) setEarlier(replaced);
      if (r.kind === "saved") {
        setLoad({ state: "loaded", server: r.soul, base: r.soul, readAt: now() });
        setText(r.soul.content);
        setCreating(false);
        setConflict(undefined);
        setNotice({ kind: "saved", at: now(), created: !r.previous.exists });
      } else if (r.kind === "conflict") {
        setLoad({ ...loaded, server: r.server, readAt: now() });
        setConflict({ server: r.server, written: false });
      } else if (r.kind === "changed") {
        setLoad({ ...loaded, server: r.server, readAt: now() });
        setConflict({ server: r.server, written: true });
      } else {
        // Until a read says what Hermes has, the edit stays unsaved: kept on this computer, and leaving still asks.
        setNotice({
          kind: "unverified",
          message: `Hermes said it saved SOUL.md, but reading it back failed: ${r.problem.message} Your text is still here as unsaved changes. Reload to check what Hermes has.`,
        });
      }
    } catch (e) {
      if (!alive.current) return;
      setNotice({ kind: "failed", message: `${messageOf(e)} Your changes are still here${kept ? ", and kept on this computer" : ""}.` });
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const trySave = () => {
    if (!loaded) return;
    if (!text.trim() && !ask) return setAsk("empty");
    void save(loaded.base);
  };

  /** Uses what Hermes has now, keeping the owner's text to undo. */
  const takeServer = () => {
    if (!conflict || !loaded) return;
    setNotice({ kind: "discarded", text, creating });
    setLoad({ ...loaded, server: conflict.server, base: conflict.server });
    setText(conflict.server.content);
    setCreating(false);
    setConflict(undefined);
  };

  const restoreKept = () => {
    if (!recover || !loaded) return;
    setText(recover.text);
    setCreating(!recover.base.exists);
    setLoad({ ...loaded, base: recover.base });
    if (!sameSoul(recover.base, loaded.server)) setConflict({ server: loaded.server, written: false });
    setRecover(undefined);
  };

  const discardKept = () => {
    setRecover(undefined);
    store.setDraft(storeKey, undefined);
  };

  const putInEditor = (v: EarlierSoul) => {
    if (!loaded) return;
    if (dirty) setNotice({ kind: "discarded", text, creating });
    else setNotice(undefined);
    if (!loaded.base.exists) setCreating(true);
    setText(v.content);
    setViewing(undefined);
  };

  const file = home?.path ? `${home.path.replace(/\/+$/, "")}/SOUL.md` : undefined;
  const notes = editing ? soulNotes(text) : [];
  const canWrite = connected && !saving && !reloading && !!loaded;

  return (
    <div className="persona">
      <section>
        <h2>Persona</h2>
        <p className="muted">
          The persona is the <span className="mono">SOUL.md</span> file in a profile's folder on the Hermes server: who Hermes is and how it speaks,
          for every chat in the profile. Hermes Chat edits it as plain text and keeps its Markdown as you write it.
        </p>
        <dl className="persona-where" aria-label="Persona file">
          <dt>Server</dt>
          <dd className="mono">{where.route ?? where.server}</dd>
          <dt>Profile</dt>
          <dd className="mono">{profile}</dd>
          <dt>File</dt>
          <dd>
            {file ? <span className="mono">{file}</span> : <span className="muted">SOUL.md in the {profile} profile's folder on the server</span>}
          </dd>
        </dl>
        <p className="muted small persona-effect">
          Hermes reads SOUL.md when a chat starts. Chats started after you save use the new persona, in Hermes Chat, in other Hermes clients and on
          messaging platforms that use the {profile} profile. A chat already under way keeps the persona it started with, unless Hermes rebuilds its
          instructions, as it does when the chat's model changes. Hermes doesn't need to restart, and Hermes Chat never restarts it.
        </p>
        {home?.distribution && (
          <p className="muted small persona-effect">
            <TriangleAlert size={12} /> This profile was installed from the <span className="mono">{home.distribution}</span> profile distribution.
            Updating it from there (<span className="mono">hermes profile update</span>) can replace SOUL.md.
          </p>
        )}
      </section>

      <section>
        {recover && (
          <div className="persona-banner" role="status">
            <FileText size={14} />
            <div>
              <div>
                Changes you didn't save, from {when(recover.at)}, are kept on this computer ({chars(recover.text.length)}).
                {loaded && !sameSoul(recover.base, loaded.server) && " SOUL.md has changed on the server since you made them."}
                {!loaded && " They come back once SOUL.md loads."}
              </div>
              {loaded && (
                <div className="confirm-actions persona-actions-left">
                  <button className="btn primary" onClick={restoreKept}>
                    Restore them
                  </button>
                  <button className="btn" onClick={discardKept}>
                    Discard them
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {load.state === "loading" && <p className="muted">Reading SOUL.md from Hermes…</p>}

        {load.state === "problem" && (
          <Problem problem={load.problem} connected={connected} profile={profile} onRetry={() => void read()} />
        )}

        {loaded && !editing && (
          <div className="persona-missing">
            <p>
              The {profile} profile has no SOUL.md, so Hermes uses its built-in identity. Hermes writes its default SOUL.md here itself the next time
              it sets up this profile's folder. Creating one now gives this profile a persona of your own; no other profile changes.
            </p>
            <div className="persona-actions">
              <button className="btn primary" disabled={!connected || !!recover} onClick={() => setCreating(true)}>
                <FileText size={14} /> Create SOUL.md
              </button>
              <button className="btn" disabled={!connected} onClick={reload}>
                <RotateCcw size={14} /> Reload
              </button>
            </div>
          </div>
        )}

        {loaded && editing && (
          <>
            {conflict && (
              <div className="persona-conflict">
                <div className="confirm-msg" role="alert">
                  <TriangleAlert size={13} />{" "}
                  {conflict.written
                    ? "Hermes saved your version, but reading it back found different text: something else changed SOUL.md at the same time."
                    : "SOUL.md changed on the server since you started editing, so nothing was saved."}{" "}
                  Your text is still in the editor. This is what Hermes has now:
                </div>
                <textarea
                  className="persona-text persona-readonly"
                  readOnly
                  aria-label="SOUL.md on the server now"
                  value={conflict.server.exists ? conflict.server.content : ""}
                  placeholder={conflict.server.exists ? undefined : "There is no SOUL.md on the server now."}
                  rows={8}
                  spellCheck={false}
                />
                {ask === "overwrite" ? (
                  <div className="confirm">
                    <span>Replace what Hermes has now with your text? What it has now is kept under Earlier versions.</span>
                    <div className="confirm-actions">
                      <button className="btn" autoFocus onClick={() => setAsk(undefined)}>
                        Keep editing
                      </button>
                      <button className="btn danger" disabled={!canWrite} onClick={() => void save(conflict.server)}>
                        Save mine over it
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="persona-actions">
                    <button className="btn" disabled={!canWrite} onClick={() => setAsk("overwrite")}>
                      Save mine over it…
                    </button>
                    <button className="btn" disabled={saving} onClick={takeServer}>
                      Use the server's version
                    </button>
                  </div>
                )}
              </div>
            )}

            <label className="field">
              <span className="field-label">
                SOUL.md · {profile}
                {dirty && <span className="badge warn">Unsaved</span>}
                {!loaded.base.exists && <span className="badge">New file</span>}
              </span>
              <textarea
                className="persona-text"
                aria-label={`SOUL.md for the ${profile} profile`}
                value={text}
                readOnly={saving || reloading || !!recover}
                onChange={(e) => {
                  setText(e.target.value);
                  if (notice?.kind !== "discarded") setNotice(undefined);
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap="soft"
                rows={13}
                placeholder={loaded.base.exists ? "SOUL.md is empty." : "# Persona\n\nWho Hermes is, and how it speaks…"}
              />
              <span className="field-hint">
                {chars(text.length)} · Read from Hermes {when(loaded.readAt)}
              </span>
            </label>

            {notes.map((n) => (
              <p key={n} className="muted small persona-note">
                <TriangleAlert size={12} /> {n}
              </p>
            ))}

            {ask === "empty" && (
              <div className="confirm persona-confirm" role="alertdialog" aria-label="Save an empty SOUL.md?">
                <span>Save an empty SOUL.md? Hermes then uses its built-in identity for new chats on the {profile} profile.</span>
                <div className="confirm-actions">
                  <button className="btn" autoFocus onClick={() => setAsk(undefined)}>
                    Keep editing
                  </button>
                  <button className="btn danger" disabled={!canWrite} onClick={() => void save(loaded.base)}>
                    Save empty
                  </button>
                </div>
              </div>
            )}
            {ask === "reload" && (
              <div className="confirm persona-confirm" role="alertdialog" aria-label="Reload SOUL.md?">
                <span>Reload replaces your unsaved changes with what Hermes has now. You can undo that afterwards.</span>
                <div className="confirm-actions">
                  <button className="btn" autoFocus onClick={() => setAsk(undefined)}>
                    Keep editing
                  </button>
                  <button className="btn danger" disabled={!connected} onClick={reload}>
                    Reload anyway
                  </button>
                </div>
              </div>
            )}

            <div className="persona-actions">
              <button className="btn primary" disabled={!canWrite || !dirty || !!conflict || !!recover} onClick={trySave}>
                <Save size={14} /> {saving ? "Saving…" : loaded.base.exists ? "Save" : "Create SOUL.md"}
              </button>
              <button className="btn" disabled={saving || reloading || (!dirty && !creating)} onClick={cancel}>
                <X size={14} /> Cancel
              </button>
              <button className="btn" disabled={!connected || saving || reloading} onClick={() => (dirty ? setAsk("reload") : reload())}>
                <RotateCcw size={14} /> Reload
              </button>
            </div>

            {!connected && (
              <p className="muted small persona-note" role="status">
                Not connected to Hermes, so nothing can be saved or reloaded now.{dirty && kept && " Your changes are kept on this computer."}
              </p>
            )}
            {dirty && !kept && (
              <p className="sign-in-error persona-note" role="alert">
                Hermes Chat couldn't write your changes to this computer's storage: it is full or can't be written. They last only until the app
                closes, unless you save them.{" "}
                <button className="link-btn" onClick={() => void navigator.clipboard?.writeText(text)}>
                  Copy them
                </button>
              </p>
            )}
            <NoticeLine notice={notice} onUndo={undoDiscard} />
          </>
        )}
      </section>

      {earlier.length > 0 && (
        <section>
          <h2>
            <History size={14} /> Earlier versions
          </h2>
          <p className="muted small">
            The SOUL.md each save from this computer replaced, for the {profile} profile on {where.server}. The last {EARLIER_KEPT} are kept on this
            computer, newest first.
          </p>
          <ul className="persona-earlier">
            {earlier.map((v, i) => (
              <li key={`${v.replacedAt}-${i}`}>
                <div className="persona-earlier-row">
                  <span>
                    Replaced {when(v.replacedAt)} · {v.exists ? chars(v.content.length) : "there was no SOUL.md"}
                  </span>
                  {v.exists && (
                    <button className="btn" aria-expanded={viewing === i} onClick={() => setViewing(viewing === i ? undefined : i)}>
                      {viewing === i ? "Hide" : "View"}
                    </button>
                  )}
                </div>
                {viewing === i && (
                  <div className="persona-earlier-view">
                    <textarea
                      className="persona-text persona-readonly"
                      readOnly
                      aria-label={`SOUL.md replaced ${when(v.replacedAt)}`}
                      value={v.content}
                      rows={10}
                      spellCheck={false}
                    />
                    <div className="persona-actions">
                      <button className="btn" disabled={!loaded || saving || !!recover} onClick={() => putInEditor(v)}>
                        Put in the editor
                      </button>
                      <button className="btn" onClick={() => void navigator.clipboard?.writeText(v.content)}>
                        Copy
                      </button>
                    </div>
                    <p className="muted small">Putting it in the editor doesn't save it: Save does, after checking what Hermes has.</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Problem({ problem, connected, profile, onRetry }: { problem: PersonaError; connected: boolean; profile: string; onRetry: () => void }) {
  const title: Record<PersonaError["kind"], string> = {
    disconnected: "Not connected to Hermes",
    "signed-out": "Signed out of the dashboard",
    unsupported: "This Hermes server can't edit personas",
    "no-profile": `No ${profile} profile`,
    permission: "Not allowed",
    error: "Couldn't read SOUL.md",
  };
  const after: Partial<Record<PersonaError["kind"], string>> = {
    disconnected: "SOUL.md loads once the connection is back.",
    "signed-out": "Sign out and sign in again to edit the persona.",
    unsupported: "Nothing has been read or written.",
    permission: "Check the owner and permissions of SOUL.md and the profile's folder on the server.",
  };
  return (
    <div className={`persona-problem ${problem.kind}`} role="alert">
      <div className="confirm-msg">
        <TriangleAlert size={13} /> {title[problem.kind]}
      </div>
      <div className="small">{problem.message}</div>
      {after[problem.kind] && <div className="muted small">{after[problem.kind]}</div>}
      {problem.kind !== "unsupported" && problem.kind !== "signed-out" && (
        <div className="persona-actions">
          <button className="btn" disabled={!connected} onClick={onRetry}>
            <RotateCcw size={14} /> Try again
          </button>
        </div>
      )}
    </div>
  );
}

function NoticeLine({ notice, onUndo }: { notice?: Notice; onUndo: () => void }) {
  if (!notice) return null;
  if (notice.kind === "saved")
    return (
      <p className="persona-saved small" role="status">
        {notice.created ? "Created" : "Saved"} SOUL.md at {clock(notice.at)}, and read it back from Hermes. New chats on this profile use it.
      </p>
    );
  if (notice.kind === "reloaded")
    return (
      <p className="muted small" role="status">
        Reloaded from Hermes at {clock(notice.at)}.
      </p>
    );
  if (notice.kind === "discarded")
    return (
      <p className="muted small persona-note" role="status">
        Your unsaved changes were set aside ({chars(notice.text.length)}).{" "}
        <button className="link-btn" onClick={onUndo}>
          <Undo2 size={12} /> Undo
        </button>
      </p>
    );
  return (
    <p className="sign-in-error" role="alert">
      {notice.message}
    </p>
  );
}
