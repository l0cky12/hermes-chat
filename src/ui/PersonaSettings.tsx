// Settings → Persona: the SOUL.md of any profile on the Hermes server, edited as plain text. A picker at the top
// (PersonaPage) lists every profile Hermes has, starting on the one in use; each picked profile gets an editor of its
// own (PersonaSettings), so edits are never mixed, and picking another asks first while one is unsaved (ADR 0117).
// Picking one here doesn't change the profile the app uses. Nothing is shown as saved until Hermes, read back, has it
// (persona.ts). An unsaved edit is kept on this computer, so leaving, closing the app, or a crash doesn't lose it, and
// each version a save replaced is kept to put back (personaStore.ts). The text is the owner's, but it is treated as
// untrusted: it is only ever a textarea's value, never rendered.
//
// The shown profile's saved SOUL.md can be copied over another profile's, through the same check-first, read-back save
// (ADR 0118).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, FileText, RotateCcw, Save, TriangleAlert, Undo2, X } from "lucide-react";
import { asReadBack, certainlyUnwritten, PersonaError, sameSoul, soulNotes, type PersonaApi, type ProfileHome, type Soul } from "../hermes/persona";
import { LeavePersona } from "./LeavePersona";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { EARLIER_KEPT, type EarlierSoul, type PersonaDraft, type PersonaStore } from "../hermes/personaStore";
import { errorText } from "../hermes/values";

/** Where SOUL.md is, as the screen names it. */
export type PersonaWhere = {
  /** How the app reaches the server, e.g. `liam@hermes` or `hermes:9119`. */
  server: string;
  /** The route in full, e.g. `ssh://liam@hermes`. */
  route?: string;
  /** The profile whose SOUL.md is edited. For PersonaPage: the profile in use, which the picker starts on. */
  profile: string;
};

/** Says whether `profile`'s editor holds an edit Hermes doesn't have, and whether this computer could keep it. */
export type PersonaDirty = (dirty: boolean, kept: boolean, profile: string) => void;

/**
 * Settings → Persona: a picker of every profile Hermes has, and an editor for the one picked. Each profile's editor is
 * its own (keyed by `keyOf`), so its unsaved edit, kept versions and save under way stay with that profile. Picking
 * another profile while the editor has an unsaved edit or a save under way asks first, as leaving the screen does.
 */
export function PersonaPage({
  api,
  where,
  connected,
  store,
  keyOf,
  onDirty,
  now,
}: {
  api: PersonaApi;
  /** `profile`: the profile in use, which the picker starts on. */
  where: PersonaWhere;
  connected: boolean;
  store: PersonaStore;
  /** Where a profile's edits are kept for this connection (personaStore.ts `personaKey`). */
  keyOf: (profile: string) => string;
  onDirty: PersonaDirty;
  now?: () => number;
}) {
  const inUse = where.profile;
  const [picked, setPicked] = useState(inUse);
  /** The server's profiles by name, once listed. */
  const [listed, setListed] = useState<string[]>();
  const [listProblem, setListProblem] = useState<string>();
  /** What the editor last said: an edit Hermes doesn't have (or a save under way), and whether this computer keeps it. */
  const [unsaved, setUnsaved] = useState({ dirty: false, kept: true });
  /** A profile picked while the editor had an unsaved edit: asked about before it opens. */
  const [asking, setAsking] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const report = useCallback<PersonaDirty>(
    (dirty, kept, profile) => {
      setUnsaved({ dirty, kept });
      onDirty(dirty, kept, profile);
    },
    [onDirty],
  );

  const list = useCallback(async () => {
    setListProblem(undefined);
    try {
      const profiles = await api.profiles();
      if (alive.current) setListed(profiles.map((p) => p.name));
    } catch (e) {
      if (alive.current) setListProblem(errorText(e));
    }
  }, [api]);

  // Listed once connected; a list that failed for want of a connection is tried again once it is back.
  useEffect(() => {
    if (connected && !listed) void list();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [connected]);

  const pick = (profile: string) => {
    if (profile === picked) return;
    if (unsaved.dirty) setAsking(profile);
    else setPicked(profile);
  };

  // The profile in use and the one picked are always offered, even before the list comes, or if it leaves them out.
  const names = [...new Set([inUse, ...(listed ?? []), picked])];
  if (listed) names.sort((a, b) => (a === inUse ? -1 : b === inUse ? 1 : listed.indexOf(a) - listed.indexOf(b)));
  const picker = (
    <select className="select persona-profile" aria-label="Profile" value={picked} onChange={(e) => pick(e.target.value)}>
      {names.map((p) => (
        <option key={p} value={p}>
          {p === inUse ? `${p} (in use)` : p}
        </option>
      ))}
    </select>
  );
  const pickerProblem = listProblem && (
    <div className="muted" role="status">
      Couldn't list the server's profiles: {listProblem}{" "}
      <button className="link-btn" disabled={!connected} onClick={() => void list()}>
        Try again
      </button>
    </div>
  );

  return (
    <>
      <PersonaSettings
        key={keyOf(picked)}
        api={api}
        where={{ ...where, profile: picked }}
        inUse={inUse}
        picker={picker}
        pickerProblem={pickerProblem}
        connected={connected}
        store={store}
        storeKey={keyOf(picked)}
        profiles={listed}
        storeKeyFor={keyOf}
        onDirty={report}
        now={now}
      />
      {asking && (
        <LeavePersona
          what="pick"
          profile={picked}
          kept={unsaved.kept}
          onStay={() => setAsking(undefined)}
          onGo={() => {
            setAsking(undefined);
            setPicked(asking);
          }}
        />
      )}
    </>
  );
}

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

const chars = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "character" : "characters"}`;
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const when = (at: number) => {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? `today at ${clock(at)}` : `${d.toLocaleDateString()} at ${clock(at)}`;
};

export function PersonaSettings({
  api,
  where,
  inUse = where.profile,
  picker,
  pickerProblem,
  connected,
  store,
  storeKey,
  onDirty,
  now = Date.now,
  profiles,
  storeKeyFor,
}: {
  api: PersonaApi;
  where: PersonaWhere;
  /** The profile the app is using, which may not be the one edited here. */
  inUse?: string;
  /** Shown in place of the profile's name, to pick another (PersonaPage). */
  picker?: ReactNode;
  /** Why the picker couldn't list the server's profiles, shown under it. */
  pickerProblem?: ReactNode;
  /** Every profile Hermes lists, once read: where this SOUL.md can be copied. */
  profiles?: readonly string[];
  /** Where another profile's edits and earlier versions are kept, for a copy over its SOUL.md. Without it, no copying. */
  storeKeyFor?: (profile: string) => string;
  connected: boolean;
  store: PersonaStore;
  /** Where this connection and profile's edits are kept (personaStore.ts `personaKey`). */
  storeKey: string;
  /**
   * Says whether there is an edit Hermes doesn't have yet, so leaving can ask first, whether this computer could keep
   * it, and for which profile. False once this closes.
   */
  onDirty: PersonaDirty;
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
  /** The edit kept for this connection and profile is in storage, not only in memory until the app closes. */
  const [kept, setKept] = useState(() => store.draftStored(storeKey));
  /** Hermes said a save worked but it couldn't be read back: the edit stays unsaved until a read says what Hermes has. */
  const [unverified, setUnverified] = useState(false);
  /** A save started before this editor opened (it was left while saving), until it settles. */
  const [earlierSave, setEarlierSave] = useState(() => store.saveUnderWay(storeKey));
  const [notice, setNotice] = useState<Notice>();
  const [conflict, setConflict] = useState<Conflict>();
  const [ask, setAsk] = useState<Ask>();
  /** An unsaved edit kept on this computer from before, until the owner restores or discards it. */
  const [recover, setRecover] = useState<PersonaDraft | undefined>(() => store.draft(storeKey));
  const [earlier, setEarlier] = useState<EarlierSoul[]>(() => store.earlier(storeKey));
  const [viewing, setViewing] = useState<number>();
  /** Copying to another profile: where to, and its SOUL.md as read just now (or why it couldn't be). */
  const [copyTo, setCopyTo] = useState<string>();
  const [copyAsk, setCopyAsk] = useState<{ to: string; target?: Soul; problem?: string }>();
  const [copying, setCopying] = useState(false);
  const [copyNotice, setCopyNotice] = useState<{ ok: boolean; text: string }>();
  // Results that come back after this has closed, or for a read since replaced, are dropped.
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Once a save started before this editor opened is done, read what Hermes has now, unless the owner is editing.
  useEffect(() => {
    if (!earlierSave) return;
    let current = true;
    void earlierSave.then(() => {
      if (!current || !alive.current) return;
      setEarlierSave(undefined);
      if (!wasDirty.current) void read();
    });
    return () => {
      current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [earlierSave]);

  const loaded = load.state === "loaded" ? load : undefined;
  const editing = !!loaded && (loaded.base.exists || creating);
  const dirty = editing && (unverified || asReadBack(text) !== asReadBack(loaded.base.content));
  const wasDirty = useRef(dirty);
  wasDirty.current = dirty;
  /** A reload or save under way, here or from before this editor opened: nothing may change the text until it lands. */
  const busy = saving || reloading || !!earlierSave;

  // Leaving asks first while there is an edit Hermes doesn't have, or a save whose outcome isn't known yet.
  // A kept edit waiting to be restored that only memory holds is lost on closing too, so that asks first as well.
  const atRisk = !!recover && !kept;
  useEffect(() => onDirty(dirty || saving || atRisk, kept, profile), [dirty, saving, atRisk, kept, onDirty, profile]);
  useEffect(() => () => onDirty(false, true, profile), [onDirty, profile]);

  // The edit is kept on this computer as it is typed. A kept edit waiting to be restored isn't overwritten meanwhile.
  useEffect(() => {
    if (!loaded || recover) return;
    setKept(store.setDraft(storeKey, dirty ? { text, base: loaded.base, at: now() } : undefined));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
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
        setUnverified(false);
        then?.(soul);
      } catch (e) {
        if (!alive.current || mine !== seq.current) return;
        const problem = e instanceof PersonaError ? e : new PersonaError("error", errorText(e));
        setLoad((l) => (l.state === "loaded" ? l : { state: "problem", problem }));
        if (wasLoaded.current) setNotice({ kind: "failed", message: `Couldn't reload: ${problem.message}` });
      } finally {
        if (alive.current && mine === seq.current) setReloading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
    [api, profile],
  );

  // Read once connected; a read that failed for want of a connection is tried again once it is back.
  useEffect(() => {
    if (!connected) return;
    if (load.state !== "loaded") void read();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [connected]);

  // A kept edit that matches what Hermes has now is nothing to restore.
  useEffect(() => {
    if (loaded && recover && sameSoul({ exists: true, content: recover.text }, loaded.server) && loaded.server.exists) {
      setRecover(undefined);
      store.setDraft(storeKey, undefined);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
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
    setUnverified(false);
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
    // Kept before anything goes out, against the base this save checks, so leaving mid-save can't lose the text.
    setKept(store.setDraft(storeKey, { text: sent, base, at: now() }));
    try {
      const saving = api.save(profile, base, sent);
      store.trackSave(storeKey, saving);
      const r = await saving;
      // What a write replaced is kept, and a confirmed save's draft let go, even if the owner has left meanwhile.
      const replaced = r.kind === "conflict" ? undefined : store.addEarlier(storeKey, r.previous, now());
      // Only the draft this save sent is let go: one edited further meanwhile (after leaving and restoring) stays.
      const kept = store.draft(storeKey);
      if (r.kind === "saved" && (!kept || asReadBack(kept.text) === asReadBack(sent))) store.setDraft(storeKey, undefined);
      if (!alive.current) return;
      if (replaced) setEarlier(replaced);
      if (r.kind === "saved") {
        setLoad({ state: "loaded", server: r.soul, base: r.soul, readAt: now() });
        setText(r.soul.content);
        setCreating(false);
        setConflict(undefined);
        setUnverified(false);
        setNotice({ kind: "saved", at: now(), created: !r.previous.exists });
      } else if (r.kind === "conflict") {
        setLoad({ ...loaded, server: r.server, readAt: now() });
        setConflict({ server: r.server, written: false });
      } else if (r.kind === "changed") {
        setLoad({ ...loaded, server: r.server, readAt: now() });
        setConflict({ server: r.server, written: true });
      } else {
        // Until a read says what Hermes has, the edit stays unsaved against the base it was written over: kept on this
        // computer, and leaving still asks, even when the text matches that base.
        setLoad({ ...loaded, base });
        setConflict(undefined);
        setUnverified(true);
        setCreating(!base.exists);
        setKept(store.setDraft(storeKey, { text: sent, base, at: now() }));
        setNotice({
          kind: "unverified",
          message: `Hermes said it saved SOUL.md, but reading it back failed: ${r.problem.message} Your text is still here as unsaved changes. Reload to check what Hermes has.`,
        });
      }
    } catch (e) {
      if (!alive.current) return;
      setNotice({ kind: "failed", message: `${errorText(e)} Your changes are still here${kept ? ", and kept on this computer" : ""}.` });
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
    setUnverified(false);
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

  const targets = (profiles ?? []).filter((p) => p !== profile);
  const target = copyTo && targets.includes(copyTo) ? copyTo : targets[0];

  // Typing in the editor while the question is open drops it: the copy is SOUL.md as Hermes has it saved.
  useEffect(() => {
    if (dirty || recover) setCopyAsk(undefined);
  }, [dirty, recover]);

  /** Reads the target's SOUL.md, to say what the copy replaces; the save checks Hermes still has it. */
  const askCopy = async (to: string) => {
    if (!storeKeyFor) return;
    setCopyNotice(undefined);
    setCopyAsk({ to });
    try {
      // A save to that profile still under way (its editor was left while saving) lands first, so the copy is checked
      // against what it left, and can't be overwritten by it.
      await store.saveUnderWay(storeKeyFor(to))?.catch(() => {});
      const soul = await api.read(to);
      if (alive.current) setCopyAsk((a) => (a?.to === to ? { to, target: soul } : a));
    } catch (e) {
      if (alive.current) setCopyAsk((a) => (a?.to === to ? { to, problem: errorText(e) } : a));
    }
  };

  /** Writes this profile's SOUL.md, as Hermes has it now, over `to`'s, if `to` still has what was read. */
  const copy = async () => {
    if (!copyAsk?.target || !loaded || !storeKeyFor || copying || wasDirty.current || recover) return;
    const { to, target: base } = copyAsk;
    const key = storeKeyFor(to);
    // One write to a profile's SOUL.md at a time, as its own editor keeps (ADR 0014).
    if (store.saveUnderWay(key)) {
      setCopyAsk(undefined);
      setCopyNotice({ ok: false, text: `A save to ${to}'s persona is still under way, so nothing was copied. Copy again once it's done.` });
      return;
    }
    setCopying(true);
    setCopyNotice(undefined);
    try {
      const source = await api.read(profile);
      if (!alive.current) return;
      if (wasDirty.current) {
        setCopyAsk(undefined);
        setCopyNotice({ ok: false, text: "You started editing, so nothing was copied: the copy is SOUL.md as Hermes has it saved. Save or discard your changes, then copy." });
        return;
      }
      if (!sameSoul(source, loaded.server)) {
        setCopyAsk(undefined);
        setCopyNotice({ ok: false, text: `${profile}'s SOUL.md changed on the server since it was read here, so nothing was copied. Reload it, check it, then copy again.` });
        return;
      }
      if (store.saveUnderWay(key)) {
        setCopyAsk(undefined);
        setCopyNotice({ ok: false, text: `A save to ${to}'s persona started meanwhile, so nothing was copied. Copy again once it's done.` });
        return;
      }
      const saving = api.save(to, base, source.content);
      store.trackSave(key, saving);
      let r: Awaited<typeof saving>;
      try {
        r = await saving;
      } catch (e) {
        if (!(e instanceof PersonaError) || certainlyUnwritten(e)) throw e;
        // Hermes may have written it: what the target had is kept, as a save from its own editor keeps it.
        store.addEarlier(key, base, now());
        if (!alive.current) return;
        setCopyAsk(undefined);
        setCopyNotice({
          ok: false,
          text: `Hermes may have written the copy to ${to}, but it couldn't be confirmed: ${e.message} What ${to} had before is kept under Earlier versions in its Persona. Open ${to}'s persona once connected to see what Hermes has.`,
        });
        return;
      }
      if (r.kind !== "conflict") store.addEarlier(key, r.previous, now());
      if (!alive.current) return;
      setCopyAsk(undefined);
      setCopyNotice(
        r.kind === "saved"
          ? { ok: true, text: `Copied to ${to}, and read back from Hermes. Chats started on ${to} from now on use it. What ${to} had before is under Earlier versions in its Persona.` }
          : r.kind === "conflict"
            ? { ok: false, text: `${to}'s SOUL.md changed on the server since it was read, so nothing was written. Pick Copy again to see what it has now.` }
            : r.kind === "changed"
              ? { ok: false, text: `Hermes wrote the copy, but reading ${to}'s SOUL.md back found other text: something else changed it at the same time.` }
              : { ok: false, text: `Hermes may have written the copy, but reading ${to}'s SOUL.md back failed: ${r.problem.message}` },
      );
    } catch (e) {
      if (alive.current) setCopyNotice({ ok: false, text: `Nothing was copied: ${errorText(e)}` });
    } finally {
      if (alive.current) setCopying(false);
    }
  };

  const file = home?.path ? `${home.path.replace(/\/+$/, "")}/SOUL.md` : undefined;
  const notes = editing ? soulNotes(text) : [];
  const canWrite = connected && !busy && !!loaded;

  return (
    <div className="persona">
      <SettingsSection
        title="Persona"
        intro={
          <>
            The <span className="mono">SOUL.md</span> file in a profile's folder on the Hermes server: who Hermes is and how it speaks in the profile's
            chats.
          </>
        }
        more={
          <>
            <p>Hermes Chat edits it as plain text and keeps its Markdown as you write it.</p>
            <p>
              When a saved persona takes effect: Hermes reads SOUL.md when a chat starts. Chats started after you save use the new persona, in Hermes
              Chat, in other Hermes clients and on messaging platforms that use the {profile} profile. A chat already under way keeps the persona it
              started with, unless Hermes rebuilds its instructions, as it does when the chat's model changes. Hermes doesn't need to restart, and
              Hermes Chat never restarts it.
            </p>
          </>
        }
      >
        <SettingRow name="Server" control={<span className="set-value mono persona-fact">{where.route ?? where.server}</span>} />
        <SettingRow
          name="Profile"
          hint={picker ? "Pick any profile on this server to edit its persona; that doesn't change the profile Hermes Chat is using." : undefined}
          control={picker ?? <span className="set-value mono persona-fact">{profile}</span>}
        >
          {pickerProblem}
          {profile !== inUse && (
            <div className="muted">
              Hermes Chat is using the <span className="mono">{inUse}</span> profile, so chats started here keep its persona. This one is for chats on
              the <span className="mono">{profile}</span> profile, in any Hermes client.
            </div>
          )}
        </SettingRow>
        <SettingRow
          name="File"
          control={
            file ? (
              <span className="set-value mono persona-fact">{file}</span>
            ) : (
              <span className="muted">SOUL.md in the {profile} profile's folder on the server</span>
            )
          }
        />
        {home?.distribution && (
          <SettingNote tone="warn">
            <TriangleAlert size={13} aria-hidden />
            <span>
              This profile was installed from the <span className="mono">{home.distribution}</span> profile distribution. Updating it from there (
              <span className="mono">hermes profile update</span>) can replace SOUL.md.
            </span>
          </SettingNote>
        )}
        {earlierSave && (
          <SettingNote role="status">A save you started before leaving Persona is still under way. Editing waits until Hermes answers it.</SettingNote>
        )}
        {load.state === "loading" && <SettingNote>Reading SOUL.md from Hermes…</SettingNote>}
        {(recover || load.state !== "loading") && (
          <div className="set-block persona-editor">
            {recover && (
              <div className="persona-banner" role="status">
                <FileText size={14} />
                <div>
                  <div>
                    Changes you didn't save, from {when(recover.at)}, are kept {kept ? "on this computer" : "in this app until it closes"} ({chars(recover.text.length)}).
                    {loaded && !sameSoul(recover.base, loaded.server) && " SOUL.md has changed on the server since you made them."}
                    {!loaded && " They come back once SOUL.md loads."}
                  </div>
                  {!kept && (
                    <div className="sign-in-error" role="alert">
                      This computer's storage couldn't take them, so they last only until the app closes.{" "}
                      <button className="link-btn" onClick={() => void navigator.clipboard?.writeText(recover.text)}>
                        Copy them
                      </button>
                    </div>
                  )}
                  {loaded && (
                    <div className="confirm-actions persona-actions-left">
                      <button className="btn primary" disabled={busy} onClick={restoreKept}>
                        Restore them
                      </button>
                      <button className="btn" disabled={busy} onClick={discardKept}>
                        Discard them
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

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
                  <button className="btn primary" disabled={!connected || !!recover || busy} onClick={() => setCreating(true)}>
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
                        <button className="btn" disabled={busy} onClick={takeServer}>
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
                <NoticeLine notice={notice} undoDisabled={busy} onUndo={undoDiscard} />
              </>
            )}
          </div>
        )}
      </SettingsSection>

      {loaded && loaded.server.exists && storeKeyFor && targets.length > 0 && (
        <SettingsSection
          title="Copy to another profile"
          titleId="persona-copy-heading"
          intro={<>Replaces another profile's SOUL.md with the {profile} profile's, as Hermes has it saved.</>}
        >
          <SettingRow
            name="To profile"
            nameId="persona-copy-to"
            hint={<>Chats started on that profile afterwards use it; the {profile} profile doesn't change.</>}
            control={
              <>
                <select
                  className="select mono"
                  aria-labelledby="persona-copy-to"
                  value={target}
                  disabled={copying}
                  onChange={(e) => (setCopyTo(e.target.value), setCopyAsk(undefined), setCopyNotice(undefined))}
                >
                  {targets.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <button
                  className="btn"
                  disabled={!connected || copying || dirty || !!recover || !target}
                  title={dirty || recover ? "Save or discard your changes first: the copy is SOUL.md as Hermes has it saved." : undefined}
                  onClick={() => target && void askCopy(target)}
                >
                  <Copy size={14} /> Copy…
                </button>
              </>
            }
          >
            {copyAsk && (
              <div className="confirm persona-confirm" role="alertdialog" aria-label={`Replace ${copyAsk.to}'s SOUL.md?`}>
                <span className="confirm-msg">
                  {copyAsk.problem
                    ? `Couldn't read ${copyAsk.to}'s SOUL.md to check it first, so nothing can be copied: ${copyAsk.problem}`
                    : !copyAsk.target
                      ? `Reading ${copyAsk.to}'s SOUL.md…`
                      : copyAsk.target.exists
                        ? `Replace ${copyAsk.to}'s SOUL.md (${chars(copyAsk.target.content.length)}) with ${profile}'s (${chars(loaded.server.content.length)})? What ${copyAsk.to} has now is kept under Earlier versions in its Persona, on this computer.`
                        : `${copyAsk.to} has no SOUL.md. Create one there with ${profile}'s (${chars(loaded.server.content.length)})?`}
                  {storeKeyFor && store.draft(storeKeyFor(copyAsk.to)) && ` Changes to ${copyAsk.to}'s persona you didn't save are kept on this computer; they stay, and show as made to an older SOUL.md.`}
                </span>
                <div className="confirm-actions">
                  <button className="btn" autoFocus onClick={() => setCopyAsk(undefined)}>
                    Cancel
                  </button>
                  <button className="btn danger" disabled={!connected || copying || !copyAsk.target || dirty || !!recover} onClick={() => void copy()}>
                    {copying ? "Copying…" : copyAsk.target?.exists === false ? `Create in ${copyAsk.to}` : `Replace ${copyAsk.to}'s`}
                  </button>
                </div>
              </div>
            )}
            {copyNotice && (
              <div className={copyNotice.ok ? "muted" : "sign-in-error"} role={copyNotice.ok ? "status" : "alert"}>
                {copyNotice.text}
              </div>
            )}
          </SettingRow>
        </SettingsSection>
      )}

      {earlier.length > 0 && (
        <SettingsSection
          title="Earlier versions"
          intro={
            <>
              The SOUL.md each save from this computer replaced, for the {profile} profile on {where.server}. The last {EARLIER_KEPT} are kept on
              this computer, newest first.
            </>
          }
        >
          {earlier.map((v, i) => (
            <SettingRow
              key={`${v.replacedAt}-${i}`}
              name={`Replaced ${when(v.replacedAt)}`}
              hint={v.exists ? chars(v.content.length) : "There was no SOUL.md."}
              control={
                v.exists && (
                  <button className="btn" aria-expanded={viewing === i} onClick={() => setViewing(viewing === i ? undefined : i)}>
                    {viewing === i ? "Hide" : "View"}
                  </button>
                )
              }
            >
              {viewing === i && (
                <>
                  <textarea
                    className="persona-text persona-readonly"
                    readOnly
                    aria-label={`SOUL.md replaced ${when(v.replacedAt)}`}
                    value={v.content}
                    rows={10}
                    spellCheck={false}
                  />
                  <div className="persona-actions">
                    <button className="btn" disabled={!loaded || busy || !!recover} onClick={() => putInEditor(v)}>
                      Put in the editor
                    </button>
                    <button className="btn" onClick={() => void navigator.clipboard?.writeText(v.content)}>
                      Copy
                    </button>
                  </div>
                  <div className="muted">Putting it in the editor doesn't save it: Save does, after checking what Hermes has.</div>
                </>
              )}
            </SettingRow>
          ))}
        </SettingsSection>
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

function NoticeLine({ notice, undoDisabled, onUndo }: { notice?: Notice; undoDisabled: boolean; onUndo: () => void }) {
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
        <button className="link-btn" disabled={undoDisabled} onClick={onUndo}>
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
