// Settings → Toolsets: which toolsets Hermes offers the model, for the profile shown, as Hermes has them on the server.
// A switch changes one toolset for the whole profile; it is checked against a fresh read first and shown as saved only
// once Hermes reads it back that way. Beside each, read-only: whether the profile inherits Hermes's default list, what
// forces it off, and what the open chat actually has. Reads and writes: toolsets.ts.
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { AppliesBox, AppliesPart, HeadPart, MetaChip, useInPage } from "./SettingsPage";
import {
  UnsupportedServerError,
  changeableName,
  type Caution,
  type ChatTools,
  type Pending,
  type Toolset,
  type ToolsetChange,
  type ToolsetGuards,
  type ToolsetList,
  type ToolsetsApi,
  type WriteSupport,
} from "../hermes/toolsets";
import { clockTime, errorText } from "../hermes/values";

const onOff = (on: boolean) => (on ? "on" : "off");

/**
 * What happened to the latest change of one toolset, under its row. `unsettled`: Hermes didn't confirm it, for this
 * reason; a later read says what Hermes has instead of dropping the note.
 */
type Note = { tone: "ok" | "warn" | "error"; text: string; unsettled?: string };
/** A change being checked before it's sent: whether it may start an install or bring MCP servers back. */
type Checking = { name: string; enabled: boolean };

/** The chat open in the app, for what Hermes offers it now. `runtimeId`: its live session on this connection, if any. */
export type OpenChat = { id: string; title: string; runtimeId?: string; running?: boolean };

/** What the open chat has of a toolset's tools, or undefined when it can't tell (no tools, another platform, no read). */
function chatHas(t: Toolset, read: ChatTools | undefined): "all" | "none" | { some: number } | undefined {
  if (read?.kind !== "read" || t.configOnly || t.platform !== "cli" || !t.tools.length) return undefined;
  const n = t.tools.filter((x) => read.tools.has(x)).length;
  return n === t.tools.length ? "all" : n === 0 ? "none" : { some: n };
}

/** One caution, as the confirmation says it. */
function cautionText(c: Caution, t: Toolset): string {
  if (c.kind === "install") return `Hermes starts installing ${c.keys.join(", ")} on the server when ${t.label} is turned on, in the background, because it isn't installed there yet.`;
  if (c.kind === "noMcp")
    return `This profile has MCP servers turned off for ${t.platformLabel} with no_mcp. Hermes clears no_mcp whenever it saves a toolset change, so new chats would be offered the profile's MCP servers again.`;
  if (c.kind === "everywhere")
    return `This profile's agent.disabled_toolsets turns ${t.label} off on every platform. Turning it on here removes it from that list, so Hermes's other chats that list it, such as Telegram or Discord, get it back too.`;
  return `This app couldn't check ${c.what}.`;
}

/** Why a change the owner started wasn't asked about or sent: Hermes's list changed under it. */
function outdated(t: Toolset, now: Toolset | undefined): Note {
  return now === undefined
    ? { tone: "warn", text: `Not changed: Hermes no longer lists ${t.label}.` }
    : { tone: "warn", text: `Not changed: ${t.label} was turned ${onOff(now.enabled)} elsewhere while this was being checked. It shows as Hermes has it now.` };
}

/** The note a change's outcome leaves under the toolset's row. */
function noteFor(t: Toolset, enabled: boolean, r: ToolsetChange): Note {
  const now = r.list?.toolsets.find((x) => x.name === t.name)?.enabled;
  switch (r.kind) {
    case "saved":
      return {
        tone: r.warning ? "warn" : "ok",
        text:
          (r.warning ? `Hermes answered with an error (${r.warning}), but reads ${t.label} back as ${onOff(enabled)}.` : `Saved: Hermes reads ${t.label} back as ${onOff(enabled)}.`) +
          " It's the profile's list for new chats." +
          (r.installing ? ` Hermes also started installing ${r.installing} on the server for it, in the background.` : "") +
          (r.mcpBack ? " Hermes cleared no_mcp, so new chats are offered the profile's MCP servers again." : "") +
          (r.everywhereBack ? " Hermes also removed it from agent.disabled_toolsets, so it's back on every platform that lists it." : ""),
      };
    case "confirm":
      return { tone: "warn", text: `Not sent yet: checked again just before sending, turning ${t.label} ${onOff(enabled)} now needs your confirmation above.` };
    case "conflict":
      return r.now === undefined
        ? { tone: "warn", text: `Not changed: Hermes no longer lists ${t.label}.` }
        : { tone: "warn", text: `Not changed: ${t.label} was turned ${onOff(r.now)} elsewhere since this list was read. It shows as Hermes has it now.` };
    case "rejected":
      return {
        tone: "error",
        text: `Hermes refused the change (${r.reason}). ${now === undefined ? `It was ${onOff(t.enabled)} before.` : `It reads ${t.label} back as ${onOff(now)}.`}`,
      };
    case "mismatch":
      return {
        tone: "error",
        text:
          `Hermes took the change but reads ${t.label} back as ${onOff(now ?? !enabled)}. Something else in the profile's settings, ` +
          "such as agent.disabled_toolsets, decides it. Check it with hermes tools on the server.",
      };
    case "unknown":
      return {
        tone: "warn",
        unsettled: r.reason,
        text:
          `Hermes didn't confirm the change (${r.reason}), so it may or may not have it. ` +
          (now === undefined ? "It's read again when Hermes is back; Refresh to check sooner." : `Read back just now, ${t.label} is ${onOff(now)}. Refresh to check again.`),
      };
  }
}

function ToolsetRow({
  t,
  write,
  connected,
  locked,
  saving,
  checking,
  problem,
  offEverywhere,
  inherited,
  chat,
  note,
  ask,
  onToggle,
}: {
  t: Toolset;
  write?: WriteSupport;
  connected: boolean;
  /** Another change, or a read, is under way: no switch takes a click. */
  locked: boolean;
  saving?: Pending;
  checking?: Checking;
  /** What keeps its provider from working, from the provider readiness Hermes reports. */
  problem?: string;
  /** Named in `agent.disabled_toolsets`, which turns it off on every platform. */
  offEverywhere?: boolean;
  /** The profile has saved no list for its platform: it inherits Hermes's default. Undefined: couldn't tell. */
  inherited?: boolean;
  /** What the open chat has of its tools. */
  chat?: ReturnType<typeof chatHas>;
  note?: Note;
  /** The confirmation a change of this toolset is waiting on, under its row. */
  ask?: ReactNode;
  onToggle: (t: Toolset) => void;
}) {
  const id = `toolset-${t.name}`;
  const mine = saving?.name === t.name ? saving : undefined;
  const checkingMe = checking?.name === t.name ? checking : undefined;
  const canSwitch = write?.ok === true && changeableName(t.name);
  return (
    <SettingRow
      className="toolset-row"
      nameId={`${id}-label`}
      about={t.label}
      name={
        <>
          {t.label}
          {t.platform !== "cli" && <span className="badge">{t.platformLabel} only</span>}
          {(!t.configured || problem) && <span className="badge warn">Needs setup</span>}
          {inherited && !t.configOnly && <span className="badge">Inherited</span>}
          {offEverywhere && <span className="badge off">Forced off on every platform</span>}
        </>
      }
      // What it is, then what the open chat has of it.
      hint={
        <>
          {/* Plugin toolsets can describe themselves at length: two lines here, all of it on hover. */}
          <div className="toolset-desc" id={`${id}-desc`} title={t.description || undefined}>
            {t.description || t.tools.join(", ")}
          </div>
          {chat !== undefined && (
            <div className="toolset-chat">
              This chat: {chat === "all" ? "has it" : chat === "none" ? "doesn't have it" : `has ${chat.some} of its ${t.tools.length} tools`}.
              {(chat === "all") !== t.enabled && ` That isn't the profile's setting: an open chat keeps the tools Hermes built it with${t.enabled ? ", and Hermes leaves out tools whose requirements aren't met" : ""}.`}
            </div>
          )}
        </>
      }
      more={t.configOnly && <p>A setting with no tools of its own: it turns speech-to-text on or off for the profile, Dictation in this app included.</p>}
      control={
        canSwitch ? (
          <button
            className="switch"
            id={`${id}-switch`}
            role="switch"
            aria-checked={t.enabled}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-desc`}
            aria-busy={mine || checkingMe ? true : undefined}
            disabled={!connected || locked}
            onClick={() => onToggle(t)}
          >
            <span className="switch-knob" />
          </button>
        ) : (
          <span className={`badge ${t.enabled ? "" : "off"}`} aria-label={`${t.label} is ${onOff(t.enabled)}`}>
            {t.enabled ? "On" : "Off"}
          </span>
        )
      }
    >
      {t.platform !== "cli" && <div className="muted">Changes Hermes's {t.platformLabel} chats, not this app's.</div>}
      {offEverywhere && <div className="muted">The profile's agent.disabled_toolsets turns it off on every platform. Turning it on here takes it off that list.</div>}
      {(!t.configured || problem) && (
        <div className="muted">
          {problem ?? "Its provider or API key isn't set up on the server."} {t.configOnly ? "It may not work" : "Its tools may not work, or be offered,"} even while it's on. Set it up with{" "}
          <span className="mono">hermes tools</span> there.
        </div>
      )}
      {write?.ok && !changeableName(t.name) && <div className="muted">This app can't send its name to Hermes, so it can't change it.</div>}
      {(mine || checkingMe) && (
        <div className="muted" role="status">
          {mine ? `Saving: turning ${t.label} ${onOff(mine.enabled)}…` : `Checking what turning ${t.label} ${onOff(checkingMe!.enabled)} does…`}
        </div>
      )}
      {!mine && !checkingMe && note && (
        <div className={note.tone === "error" ? "sign-in-error" : note.tone === "warn" ? "warn-note" : "muted"} role={note.tone === "ok" ? "status" : "alert"}>
          {note.text}
        </div>
      )}
      {ask}
    </SettingRow>
  );
}

export function ToolsetSettings({
  api,
  profile,
  connected,
  runningReplies = 0,
  onGuide,
  chat,
}: {
  /** Opens the compatibility guide at the toolset switches, from the note saying they can't be changed here. */
  onGuide?: () => void;
  api: ToolsetsApi;
  profile: string;
  connected: boolean;
  /** Chats of this profile with a reply running now. */
  runningReplies?: number;
  /** The chat open in the app's active pane, in this profile. */
  chat?: OpenChat;
}) {
  const inPage = useInPage();
  const [list, setList] = useState<ToolsetList>();
  const [write, setWrite] = useState<WriteSupport>();
  const [guards, setGuards] = useState<ToolsetGuards>();
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string>();
  const [unsupported, setUnsupported] = useState<string>();
  const [reading, setReading] = useState(false);
  const [checking, setChecking] = useState<Checking>();
  const [notes, setNotes] = useState<Record<string, Note>>({});
  /** A change waiting for the owner's confirmation. `again`: the check right before sending found something new. */
  const [ask, setAsk] = useState<{ t: Toolset; enabled: boolean; cautions: Caution[]; again?: boolean }>();
  /** A change whose outcome is unknown: the list is read again once Hermes is back. */
  const [reread, setReread] = useState(false);
  // The change on its way belongs to the API, not to this screen: leaving and coming back still shows it and waits.
  const pending = useSyncExternalStore(api.subscribe, api.pending);
  const savingHere = pending?.profile === profile ? pending : undefined;
  // Synchronous guards, since state lands after a second click could.
  const readingNow = useRef(false);
  const checkingNow = useRef(false);
  /** A read asked for while another read or a change was under way; `true` also asks whether Hermes takes changes. */
  const wanted = useRef<boolean | undefined>(undefined);
  const live = useRef(true);
  /** Bumped by each change's result: a read that started before it is older than what's shown, and is dropped. */
  const stamp = useRef(0);
  /** Bumped by each config-guards read after a change, and by each full read: only the latest one's answer is shown. */
  const guardsRead = useRef(0);
  /** Bumped by each provider-readiness read: only the latest one's answer is shown. */
  const readinessRead = useRef(0);
  /**
   * The list as last accepted, set together with the state: a change being checked compares against it, and a read can
   * land after a check started but before React renders it.
   */
  const shownList = useRef<ToolsetList | undefined>(undefined);
  const show = (l: ToolsetList) => {
    shownList.current = l;
    setList(l);
  };
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  // What the open chat has, read for its live session only. Each read is numbered: only the latest one's answer, for the
  // session still open, is shown, so a late answer for a chat left (or a connection gone) never replaces it.
  const [chatRead, setChatRead] = useState<{ runtimeId: string; read?: ChatTools; error?: string }>();
  const chatSeq = useRef(0);
  const runtimeId = connected ? chat?.runtimeId : undefined;
  const readChat = useCallback(async () => {
    const mine = ++chatSeq.current;
    if (!runtimeId) return setChatRead(undefined);
    setChatRead((c) => (c?.runtimeId === runtimeId ? c : { runtimeId }));
    const out = await api.chatTools(profile, runtimeId).then(
      (read) => ({ runtimeId, read }),
      (e) => ({ runtimeId, error: errorText(e) }),
    );
    if (live.current && mine === chatSeq.current) setChatRead(out);
  }, [api, profile, runtimeId]);
  useEffect(() => void readChat(), [readChat]);
  // Called after an await (a save, a focus), when the chat's live session may have changed: always the current one.
  const readChatNow = useRef(readChat);
  readChatNow.current = readChat;
  // The chat read shown, only while it is for the session open now.
  const chatShown = chatRead?.runtimeId === runtimeId ? chatRead : undefined;

  /**
   * Reads the list for this component's profile, and with `full` whether Hermes takes changes, the config guards and
   * provider readiness too. Asked while another read is under way, it runs once that is done; while a change to this
   * profile is on its way, it runs, and runs again once the change is done.
   */
  const read = useCallback(
    async (full: boolean) => {
      if (readingNow.current) {
        wanted.current = (wanted.current ?? false) || full;
        return;
      }
      if (api.pending()?.profile === profile) wanted.current = wanted.current ?? false;
      readingNow.current = true;
      const started = stamp.current;
      // Numbered when the read starts: a later guards read (after a change, on focus) supersedes this one's answer.
      const guardsSeq = full ? ++guardsRead.current : 0;
      setReading(true);
      try {
        const [fresh, support, g] = await Promise.all([
          api.list(profile),
          full ? api.writeSupport(profile).catch((e): WriteSupport => ({ ok: false, reason: `Couldn't check whether Hermes takes changes: ${errorText(e)}` })) : undefined,
          full ? api.guards(profile) : undefined,
        ]);
        if (!live.current) return;
        if (stamp.current !== started) return;
        // A note about a toolset that has changed since (elsewhere) no longer describes it, and an unconfirmed change is
        // settled by this read: the switch shows what Hermes has.
        const before = new Map(shownList.current?.toolsets.map((t) => [t.name, t.enabled]));
        const moved = new Set(fresh.toolsets.filter((t) => before.has(t.name) && before.get(t.name) !== t.enabled).map((t) => t.name));
        setNotes((n) =>
          Object.fromEntries(
            Object.entries(n).flatMap(([name, note]): [string, Note][] => {
              const t = fresh.toolsets.find((x) => x.name === name);
              if (note.unsettled !== undefined && t)
                return [[name, { tone: "warn", text: `Hermes didn't confirm the last change (${note.unsettled}). Read back at ${clockTime(fresh.readAt)}, ${t.label} is ${onOff(t.enabled)}.` }]];
              return moved.has(name) ? [] : [[name, note]];
            }),
          ),
        );
        show(fresh);
        // A confirmation open for a toolset that has since changed, or gone, no longer asks the right question.
        setAsk((a) => {
          if (!a) return a;
          const now = fresh.toolsets.find((x) => x.name === a.t.name);
          if (now && now.enabled === a.t.enabled) return a;
          setNotes((n) => ({ ...n, [a.t.name]: outdated(a.t, now) }));
          return undefined;
        });
        if (support) setWrite(support);
        if (full && guardsSeq === guardsRead.current) setGuards(g);
        setLoadError(undefined);
        setUnsupported(undefined);
        setReread(false);
        if (full) {
          const mine = ++readinessRead.current;
          void api.setupProblems(profile, fresh).then((p) => live.current && mine === readinessRead.current && setProblems(p));
        }
      } catch (e) {
        if (!live.current || stamp.current !== started) return;
        if (e instanceof UnsupportedServerError) setUnsupported(e.message);
        else setLoadError(errorText(e));
      } finally {
        readingNow.current = false;
        if (live.current) setReading(false);
        // What was asked meanwhile, such as the read on reconnecting, on every path out, a dropped or failed read
        // included. One waiting for a change to this profile runs when that is done.
        if (wanted.current !== undefined && live.current && api.pending()?.profile !== profile) {
          const again = wanted.current;
          wanted.current = undefined;
          void read(again);
        }
      }
    },
    [api, profile],
  );

  // A change finishing (here, or before this screen was opened) runs the read that waited for it.
  useEffect(() => {
    if (pending || wanted.current === undefined || !connected) return;
    const again = wanted.current;
    wanted.current = undefined;
    void read(again);
  }, [pending, connected, read]);

  // The first read, again on reconnecting (another client may have changed it meanwhile), and after an unknown outcome.
  const wasConnected = useRef(false);
  useEffect(() => {
    const back = connected && !wasConnected.current;
    wasConnected.current = connected;
    if (back) void read(true);
  }, [connected, read]);
  useEffect(() => {
    if (connected && reread) void read(false);
  }, [connected, reread, read]);
  // Coming back to the window reads it again, for changes made elsewhere meanwhile.
  useEffect(() => {
    // Another client may have saved the profile's own list, or forced a toolset off: the config is read again too.
    // The list through its ref: a focus right after the first read lands can come before this effect runs again.
    const onFocus = () => connected && shownList.current && (void read(false), void readChatNow.current(), readGuards());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-listen when the connection or `read` changes; `readGuards` is new every render but reads the same `api` and `profile` that `read` is keyed on
  }, [connected, read]);

  /** The config facts (inherited, forced off, no_mcp) read again; only the latest read's answer is shown. */
  const readGuards = () => {
    const mine = ++guardsRead.current;
    void api.guards(profile).then((g) => g && live.current && mine === guardsRead.current && setGuards(g));
  };

  const commit = async (t: Toolset, enabled: boolean, accepted: Caution[] = []) => {
    let note: Note;
    try {
      const r = await api.set(profile, t.name, enabled, t.enabled, accepted);
      if (!live.current) return;
      stamp.current++;
      // Every outcome but a lost answer carries the list as Hermes has it after the attempt.
      if (r.list) show(r.list);
      if (r.kind === "confirm") {
        const fresh = r.list.toolsets.find((x) => x.name === t.name) ?? t;
        setAsk({ t: fresh, enabled, cautions: r.cautions, again: true });
      }
      if (r.kind === "unknown" && !r.list) setReread(true);
      if (r.kind === "saved" && r.mcpBack) setGuards((g) => g && { ...g, noMcp: g.noMcp.filter((p) => p !== t.platform) });
      if (r.kind === "saved" && r.everywhereBack) setGuards((g) => g && { ...g, disabledEverywhere: g.disabledEverywhere.filter((n) => n !== t.name) });
      note = noteFor(t, enabled, r);
    } catch (e) {
      if (!live.current) return;
      // The read before the change failed: nothing was sent.
      note = { tone: "error", text: `Nothing changed: couldn't read ${t.label} from Hermes first: ${errorText(e)}` };
    }
    setNotes((n) => ({ ...n, [t.name]: note }));
    // Whether the change reached the open chat is read, not assumed; so is whether the profile now has its own list.
    void readChatNow.current();
    readGuards();
  };

  const toggle = async (t: Toolset) => {
    // A read under way doesn't hold a change up: the write checks a fresh read itself, and a read older than its result
    // is dropped. (Coming back to the window starts one, which must not swallow the click that brought the owner back.)
    if (checkingNow.current || api.pending() || !connected) return;
    checkingNow.current = true;
    setAsk(undefined);
    setNotes(({ [t.name]: _gone, ...rest }) => rest);
    const enabled = !t.enabled;
    let cautions: Caution[];
    try {
      setChecking({ name: t.name, enabled });
      cautions = await api.cautions(profile, t, enabled);
    } finally {
      checkingNow.current = false;
      if (live.current) setChecking(undefined);
    }
    if (!live.current) return;
    // The list may have been read again while this was checked: ask, or send, only about what Hermes has now.
    const now = shownList.current?.toolsets.find((x) => x.name === t.name);
    if (!now || now.enabled !== t.enabled) return setNotes((n) => ({ ...n, [t.name]: outdated(t, now) }));
    if (cautions.length) return setAsk({ t: now, enabled, cautions });
    await commit(now, enabled);
  };

  const confirm = async () => {
    if (!ask || api.pending() || !connected) return;
    const { t, enabled, cautions } = ask;
    setAsk(undefined);
    await commit(t, enabled, cautions);
  };

  // A confirmation opens under its toolset, which may be far down the list: brought into view, with the keyboard on
  // its safe choice. Declining hands the keyboard back to the switch.
  const askBox = useRef<HTMLDivElement>(null);
  const asking = ask && `${ask.t.name}:${ask.enabled}:${ask.again ? 1 : 0}`;
  useEffect(() => {
    if (!asking) return;
    askBox.current?.scrollIntoView?.({ block: "nearest" });
    askBox.current?.querySelector("button")?.focus();
  }, [asking]);
  const decline = () => {
    const name = ask?.t.name;
    setAsk(undefined);
    if (name) document.getElementById(`toolset-${name}-switch`)?.focus();
  };

  const intro = (
    <>
      Which tools Hermes offers the model in the <span className="mono">{profile}</span> profile.
    </>
  );
  // How a change applies: the section's (i).
  const how = (
    <>
      <p>
        Hermes keeps this list on the server, in the profile's settings, so the command line, the TUI and the Hermes desktop app use it too. It is the
        same for every chat in the profile.
      </p>
      <p>
        <strong>How a change applies:</strong> this chat, the {profile} profile, the whole server
      </p>
      <dl className="toolset-scopes" aria-label="What a change reaches">
        <dt>
          This chat <span className="badge off">Not changeable here</span>
        </dt>
        <dd className="muted">
          Hermes has no setting for one chat's toolsets that keeps the conversation: its only way rebuilds the chat's agent and clears what the chat holds in
          memory. A chat Hermes already has open, and a reply running in it, keeps the tools it was built with, its next turns included. Under each
          toolset, the open chat's line says what Hermes offers it now.
        </dd>
        <dt>
          The <span className="mono">{profile}</span> profile <span className="badge">Changed here</span>
        </dt>
        <dd className="muted">
          <strong>When it takes effect:</strong> in chats Hermes starts after the change, and a chat Hermes opens again after closing it, in every Hermes
          client.
        </dd>
        <dt>
          The whole server <span className="badge off">Not changeable here</span>
        </dt>
        <dd className="muted">
          A server started with <span className="mono">HERMES_TUI_TOOLSETS</span> set uses that list for every chat instead. It is set where Hermes runs, and no
          route reports or changes it.
        </dd>
      </dl>
      <p>
        Forced values come on top: agent.disabled_toolsets turns toolsets off on every platform, and a server pin replaces the list.
      </p>
      <p className="toolset-scope">
        <ShieldCheck size={12} /> Toolsets aren't Approvals. Turning one on doesn't change which commands Hermes asks about before running them, or YOLO.
      </p>
    </>
  );

  if (unsupported || !list) {
    return (
      <SettingsSection
        title="Toolsets"
        intro={intro}
        more={how}
        action={
          (loadError || unsupported) &&
          connected && (
            <button className="btn" disabled={reading} onClick={() => void read(true)}>
              Try again
            </button>
          )
        }
      >
        <SettingNote tone={loadError ? "bad" : unsupported ? "warn" : "muted"} role={loadError || unsupported ? "alert" : "status"}>
          {unsupported ?? (loadError ? `Couldn't read the toolsets: ${loadError}` : connected ? "Reading the toolsets from Hermes…" : "Connect to Hermes to see the profile's toolsets.")}
        </SettingNote>
      </SettingsSection>
    );
  }

  const locked = !!pending || !!checking;
  const here = list.toolsets.filter((t) => t.platform === "cli");
  const elsewhere = list.toolsets.filter((t) => t.platform !== "cli");
  // Names in agent.disabled_toolsets that aren't a listed toolset, such as a composite like `debugging`: they turn off
  // the tools inside them, which no switch here undoes.
  const unlisted = guards?.disabledEverywhere.filter((n) => !list.toolsets.some((t) => t.name === n)) ?? [];
  const row = (t: Toolset) => (
    <ToolsetRow
      key={t.name}
      t={t}
      write={write}
      connected={connected}
      locked={locked}
      saving={savingHere}
      checking={checking}
      problem={problems[t.name]}
      offEverywhere={guards?.disabledEverywhere.includes(t.name)}
      inherited={guards && !guards.noMcpUnclear.includes(t.platform) ? !guards.savedLists.includes(t.platform) : undefined}
      chat={chatHas(t, chatShown?.read)}
      note={notes[t.name]}
      onToggle={(x) => void toggle(x)}
      ask={
        ask?.t.name === t.name && (
          <div className="confirm toolset-ask" role="alertdialog" ref={askBox} aria-label={`Turn ${ask.t.label} ${onOff(ask.enabled)}`}>
            <span className="confirm-msg">
              <TriangleAlert size={12} /> Turn {ask.t.label} {onOff(ask.enabled)}?
            </span>
            {ask.again && <span className="confirm-detail">Checked again just before sending, this changed since you were asked:</span>}
            {ask.cautions.map((c, i) => (
              <span className="confirm-detail" key={i}>
                {cautionText(c, ask.t)}
              </span>
            ))}
            <div className="confirm-actions">
              <button className="btn" onClick={decline}>
                Keep it {onOff(ask.t.enabled)}
              </button>
              <button className="btn danger" disabled={!connected || !!pending} onClick={() => void confirm()}>
                Turn {onOff(ask.enabled)}
              </button>
            </div>
          </div>
        )
      }
    />
  );

  // Under Settings' page header (ADR 0159): Reload, when the list was read, and whether the profile has a list of its
  // own with what this chat has, in the summary box. Every re-read in Settings is a Reload.
  const reload = (
    <button className="btn" disabled={!connected || locked || reading} onClick={() => (void read(true), void readChat())}>
      <RefreshCw size={14} /> {reading ? "Reloading…" : "Reload"}
    </button>
  );
  const saved =
    guards && list.toolsets.some((t) => t.platform === "cli")
      ? guards.noMcpUnclear.includes("cli")
        ? { line: "This app can't tell whether the profile has saved its own list.", text: "This app can't tell whether the profile has saved its own list: it's saved in a form this app can't read for certain." }
        : guards.savedLists.includes("cli")
          ? { line: "Saved in profile: the profile has its own list, shown here.", text: "Saved in profile: the profile has its own list, shown here." }
          : {
              line: "Inherited: this profile uses Hermes's default list until you change one.",
              text: "Inherited: the profile hasn't saved a list of its own, so it has Hermes's default. The first change here saves the whole list, as shown, into the profile.",
            }
      : undefined;
  const chatStatus = (
    <SettingNote className="toolset-chat-status">
      <div role="status" aria-label="This chat">
        {!chat
          ? "No chat is open, so there's no chat to compare with."
          : !connected
            ? `“${chat.title}”: what it has is read when Hermes is back.`
            : !chat.runtimeId
              ? `“${chat.title}” isn't open on Hermes yet, so it has no tools of its own: it gets the profile's list when Hermes opens it.`
              : !chatShown?.read && !chatShown?.error
                ? `Reading what “${chat.title}” has…`
                : chatShown.error
                  ? <span className="sign-in-error">Couldn't read what “{chat.title}” has: {chatShown.error}</span>
                  : chatShown.read!.kind === "closed"
                    ? `Hermes no longer has “${chat.title}” open: it gets the profile's list when it's opened again.`
                    : chatShown.read!.kind === "unsupported"
                      ? `${chatShown.read!.reason} Each toolset shows the profile's setting only.`
                      : `“${chat.title}”: what Hermes offers it, read at ${clockTime(chatShown.read!.readAt)}, is under each toolset.`}
        {chat?.running && connected && " A reply is running in it now; nothing here changes the tools it's using."}
      </div>
    </SettingNote>
  );
  return (
    <>
      {inPage && (
        <>
          {!reading && !loadError && (
            <HeadPart at="meta">
              <MetaChip label="Read" value={clockTime(list.readAt)} />
            </HeadPart>
          )}
          <HeadPart at="actions">{reload}</HeadPart>
          <HeadPart at="applies">
            <AppliesBox line={saved?.line ?? "Which tools new chats in this profile get."} more="Details">
              <AppliesPart>
                {saved && <SettingNote role="status">{saved.text}</SettingNote>}
                {chatStatus}
              </AppliesPart>
            </AppliesBox>
          </HeadPart>
        </>
      )}
      <SettingsSection
        bare={inPage}
        title="Toolsets"
        intro={intro}
        more={how}
        action={!inPage && reload}
      >
        {guards?.codingFocus && (
          <SettingNote tone="warn" role="status">
            This profile's agent.coding_context is focus: in a code workspace, Hermes gives new chats its own coding selection of toolsets instead of this list.
          </SettingNote>
        )}
        {unlisted.length > 0 && (
          <SettingNote tone="warn" role="status">
            This profile's agent.disabled_toolsets also names {unlisted.join(", ")}, which turns off the tools inside{" "}
            {unlisted.length === 1 ? "it" : "them"} on every platform. A toolset sharing those tools stays off: turning it on here won't take, and the app
            says so when it reads it back.
          </SettingNote>
        )}
        {runningReplies > 0 && (
          <SettingNote tone="warn" role="status">
            <TriangleAlert size={12} /> A reply is running in {runningReplies === 1 ? "a chat" : `${runningReplies} chats`} of this profile. A change here doesn't
            reach {runningReplies === 1 ? "it" : "them"}.
          </SettingNote>
        )}
        {!connected && (
          <SettingNote tone="warn" role="status">
            Not connected to Hermes. This is what Hermes had at {clockTime(list.readAt)}; it can't be changed until Hermes is back.
          </SettingNote>
        )}
        {write && !write.ok && (
          <SettingNote tone="warn" role="status">
            <span>
              {write.reason} Each toolset shows whether it's on.{" "}
              {onGuide && (
                <button className="link-btn" onClick={onGuide} aria-label="Compatibility guide: Toolset switches">
                  Compatibility guide
                </button>
              )}
            </span>
          </SettingNote>
        )}
        {!inPage && saved && <SettingNote role="status">{saved.text}</SettingNote>}
        {!inPage && chatStatus}
        {pending && pending.profile !== profile && (
          <SettingNote role="status">Waiting for a change in the {pending.profile} profile to finish before this one can change.</SettingNote>
        )}
        {(!inPage || reading || loadError) && (
          <SettingNote role="status">
            <span>
              {reading ? "Reading the toolsets from Hermes…" : loadError ? null : `Read from Hermes at ${clockTime(list.readAt)}.`}
              {loadError && <span className="sign-in-error">Couldn't read them again: {loadError}</span>}
            </span>
          </SettingNote>
        )}
        <div className="toolset-list" role="group" aria-label="Toolsets for this app's chats">
          {here.map(row)}
        </div>
      </SettingsSection>
      {elsewhere.length > 0 && (
        <SettingsSection title="Other platforms" intro="These only reach the platform named on each, such as Hermes's Discord bot, not chats in this app.">
          <div className="toolset-list" role="group" aria-label="Toolsets for other platforms">
            {elsewhere.map(row)}
          </div>
        </SettingsSection>
      )}
    </>
  );
}
