import { type ReactNode, type RefObject, Suspense, lazy, useCallback, useLayoutEffect, useMemo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal, flushSync } from "react-dom";
import { ArrowLeft, ArrowRight, Columns2, FolderCog, GitBranch, PanelBottom, PanelLeft, PanelRight, PanelTop, X } from "lucide-react";
import { CONNECT_STOPPED, LIVE_MIN_GAP_MS, RenameConflict, connect, openSaved, readSaved, toSource, type Delivery, type Hermes } from "./hermes/transport";
import { invoke } from "@tauri-apps/api/core";
import type { CommandHost } from "./ui/SlashCommands";
import { STEER, type ServerCommandList } from "./hermes/commands";
import type { SkillCall, SkillCommands } from "./hermes/skillCommands";
import { CHECK_EVERY_MS } from "./hermes/otherProfiles";
import { type Account, type Kept, type SavedSignIn, launchOpen, launchSignIn, removeConnection, savedSignIn, signIn, signInForm, signOutToSignIn } from "./hermes/account";
import { CONNECTIONS_KEY, Connections, type SavedConnection, addressLabel, defaultName, keptRouteHealth, prefScope } from "./hermes/connections";
import { forgetConnectionData } from "./hermes/forgetConnection";
import { serial as makeSerial } from "./hermes/serial";
import { localChatCache } from "./hermes/chatCache";
import { draftKey, drafts } from "./hermes/drafts";
import { PersonaStore, personaKey } from "./hermes/personaStore";
import { sending, unsaved, type Sending } from "./hermes/unsaved";
import { connOf, restoreBlocked, savedBackupEnv } from "./hermes/backup";
import { chatToReopen, forgetOpenChat, rememberOpenChat } from "./hermes/uiPrefs";
import { PROJECTS_KEY, projectLinks, projectScope } from "./hermes/projectLinks";
import { ProjectsStore, type Project } from "./hermes/projects";
import { instructionsMessage, modelProblem, resolveNewChat, savedDefaults, type ProjectDefaults } from "./hermes/projectDefaults";
import { systemSecrets } from "./hermes/tauriKeyring";
import { appUpdates } from "./hermes/tauriUpdates";
import { needsAttention, type Updater } from "./hermes/updates";
import { desktopNotify } from "./hermes/tauriNotify";
import { ScreenshotDesk, type ScreenshotApi } from "./hermes/screenshots";
import { desktopSummon, type SummonApi } from "./hermes/summon";
import { onDesktopScreenshot, screenshotSupport, showWindow, syncScreenshotOutbox, tauriScreenshots, type ScreenshotSupport } from "./hermes/tauriScreenshot";
import { ConnectionManager, RailConnections, RemoveConnection, SwitchConnection } from "./ui/Connections";
import { checkShortcut, shortcutLabel, shortcutOf } from "./ui/shortcut";

import { reachRoute, tauriPipe, tauriProbe, tauriReach, type SignInDetails } from "./hermes/tauriPipe";
import { AttemptLog, tauriAttemptStore } from "./hermes/attempts";
import { readMethods } from "./hermes/signInMethods";
import { PreferredRoutes, type RouteHealth, routesOf, sshAddressOf } from "./hermes/routes";
import { isSetUp, testSignIn, type TestOutcome } from "./hermes/setup";
import { isOutgoing, isWaiting, type Attachment, type Chat, type ConnectionStatus, type Found } from "./hermes/model";
import type { ModelCatalog, ModelPick } from "./hermes/models";
import { ChatList, Rail, leavingNote } from "./ui/Sidebar";
import { type ChatLink, type ConnectionRefs, checkConnection, connectionKey, connectionLabel, connectionRefs, formatChatLink, locateChat, parseChatLink } from "./hermes/chatLinks";
import { desktopLinks, type LinkInbox } from "./hermes/tauriLinks";
import { ChatLinkNotice, type LinkNoticeView } from "./ui/ChatLinkNotice";
import { Inbox } from "./ui/Inbox";
import { Bots } from "./ui/Bots";
import { Office } from "./ui/Office";
import { EMPTY_OFFICE_MEMORY } from "./ui/OfficeBuilding";
import { officeRooms, type Desk, type Room } from "./hermes/office";
import type { SubagentId } from "./hermes/subagents";
import { botActivity, isBotChat, isBotChatTitle, newInBotChatNote, type Bot } from "./hermes/bots";
import { inboxAcks, inboxEntries, inboxScope, needsOwner, type InboxEntry } from "./hermes/inbox";
import { ChatPane, type FollowUpHost, type JumpTarget } from "./ui/ChatPane";
import type { ChatPin } from "./ui/ChatMenu";
import { BranchDialog, BranchedFrom } from "./ui/Branch";
import { MembershipDialog, MembershipStatus, needsOwner as membershipNeedsOwner } from "./ui/MembershipSync";
import { ReplayDialog } from "./ui/Replay";
import { replayBlocked, variantsIn, type ReplayKind } from "./hermes/replay";
import { branchBlocked, type BranchLink } from "./hermes/branch";
import type { QueueApi } from "./ui/Queue";
import { paneNames, Split, usePaneVisible, type PaneSlot, type SplitDir } from "./ui/Split";
import { closeTabIn, navigateTabs, PaneDrop, TabStrip, type TabAction } from "./ui/Tabs";
import { dropLabel, EDGE_SIDE, EDGES, moveTab, sameMove, type DropZone, type MovedChat, type TabDrop } from "./ui/tabMoves";
import type { VoiceApi } from "./ui/Voice";
import { prefsOf, tauriLocalStt, type LocalSttApi } from "./hermes/localStt";
import { DEFAULT_STT_PREFS, sttRoute } from "./hermes/sttRoute";
import { SearchPalette } from "./ui/Search";
import { SavedFilters, TagManager } from "./ui/Tags";
import { useSnoozeClock } from "./ui/Snooze";
import { TagsStore, savedTagsFile, type SavedFilter } from "./hermes/tags";
import { AttentionClock, ClearedStore, PINS_KEY, PinStore, SNOOZE_KEY, SnoozeStore, chatSections, heldClears, wakeFull } from "./hermes/snooze";
import { IDLE_COMPACT_CHECK_MS, IdleCompactor, idleCompactionNote } from "./hermes/idleCompact";
import { runFilter } from "./hermes/chatFilter";
import { SettingsScreen, type PersonaWiring } from "./ui/Settings";
import { LeavePersona, type LeaveWhat } from "./ui/LeavePersona";
import { LeaveArtifacts } from "./ui/ArtifactEditor";
import { ArtifactStore, artifactIo, artifactKey, isDirty } from "./hermes/artifacts";
import { LeaveMemoryEdit, useCloseGuard } from "./ui/LeaveMemoryEdit";
import { tauriCloseGuard, type CloseGuard } from "./ui/tauriWindow";
import { FileBrowser } from "./ui/FileBrowser";
import { OutputsScreen, type OutputsScope } from "./ui/Outputs";
import { UsageAnalytics } from "./ui/UsageAnalytics";
import { note, type RemoteLog } from "./hermes/logs";
import { OutputsIndex, outputsIn, sessionOf, splitPath, type Output } from "./hermes/outputs";
import { STATUS_LABEL, composing, routeLabel } from "./ui/bits";
import { ProjectScreen, ProjectSwitcher, type ProjectUnread } from "./ui/Projects";
import { ScheduledJobs } from "./ui/ScheduledJobs";
import { TroubleshootStore, startTroubleshoot } from "./hermes/troubleshoot";
import { CapabilityGate } from "./ui/Diagnostics";
import { guideUrl, type CapabilityId } from "./hermes/capabilities";
import { useCapabilities } from "./ui/Diagnostics";
import { Automations } from "./ui/Automations";
import { tauriLocalTerminal, tauriTerminal } from "./ui/tauriTerminal";
import { terminalTarget, terminalTargetGuessed, terminalTargetKey, type TerminalKind } from "./hermes/terminal";
import { REPO_PATH_KEY, REPO_RECENT_KEY, REPO_TARGET_KEY, readRecent, remember, repoTarget } from "./hermes/repo";
import { RepositoryScreen } from "./ui/Repository";
import { startInWorktree, worktreeChats, type WorktreeChat, type WorktreeStart } from "./hermes/worktrees";
import type { RepoApi } from "./hermes/repo";
import { tauriRepo } from "./ui/tauriRepo";
import { ApplyDefaults, NewChatSettingsView } from "./ui/ProjectDefaultsNotes";
import { appearanceStore } from "./ui/appearance";
import { StatusBar } from "./ui/StatusBar";
import { ApprovalsPill } from "./ui/ApprovalsPill";
import { systemFonts } from "./ui/tauriFonts";
import { SignIn } from "./ui/SignIn";
import { Onboarding, type SetupMode } from "./ui/Onboarding";
import { ModelControls } from "./ui/ModelPicker";
import { PreviewPane } from "./ui/PreviewPane";
import { PANE_MIN_WIDTH, SidePanel, type PanelTab } from "./ui/SidePanel";
import { ScreenTab } from "./ui/Screen";
import { LinksProvider } from "./ui/previewContext";
import { tauriLocalFiles, tauriServerPages, tauriWebPages, type LocalFiles, type ServerPages, type WebPages } from "./ui/tauriPreview";
import type { PreviewTarget } from "./hermes/preview";
import type { Route } from "./hermes/pipe";
import { tauriTray, type TrayWiring } from "./hermes/tauriTray";
import { usePageHidden, useWindowHidden } from "./ui/windowState";
import { getUIPrefs, setUIPrefs, subscribe as subscribeUIPrefs, toggleModelFavorite, type StickyModelPick } from "./hermes/uiPrefs";

/** Keeps the repository folder opened last, and the recent ones, on this computer (Repository screen, ADR 0034). */
function rememberRepo(top: string) {
  try {
    localStorage.setItem(REPO_PATH_KEY, top);
    localStorage.setItem(REPO_RECENT_KEY, JSON.stringify(remember(readRecent(localStorage.getItem(REPO_RECENT_KEY)), top)));
  } catch {
    // A full or unavailable localStorage only loses the memory of the folder.
  }
}

// xterm.js is loaded only once the Terminal is first opened.
const TerminalTab = lazy(() => import("./ui/Terminal").then((m) => ({ default: m.TerminalTab })));

// Hermes also announces store changes over the socket; the poll catches anything it misses.
const SYNC_EVERY_MS = 60_000;
// While the inbox is open it asks for fresh checks this often; they run at most every 15 seconds (transport.ts).
const INBOX_CHECK_EVERY_MS = 30_000;
const TOAST_MS = 5_000;
const ACTION_TOAST_MS = 15_000;

/** A short notice above the composer; `undo` puts back what it reports. `at` restarts the timer for a repeat. */
type Toast = { text: string; undo?: () => void; action?: { label: string; run: () => void }; at: number };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const withoutProfile = ({ profile: _profile, ...pick }: StickyModelPick): ModelPick => pick;

/** Below this width the side panel's Server files drop columns and show a file below the list. */
const PANEL_COMPACT_WIDTH = 640;
/** The narrowest the chat gets beside the preview pane; narrower than this and the pane covers the chat instead. */
const CHAT_MIN_WIDTH = 440;
const PREVIEW_DEFAULT_WIDTH = 480;

/** How the preview pane names the Hermes server: the SSH target, or the dashboard's host. */
function serverLabel(route?: Route): string {
  if (!route) return "the server";
  if (route.kind === "ssh") return route.target;
  try {
    return new URL(route.url).host;
  } catch {
    return route.url;
  }
}

/** An element's width as it changes; 0 where it can't be measured (as in tests). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

let connectionStore: Connections | undefined;
/** The saved connections, read (and the old single sign-in migrated) the first time they're needed. */
const savedConnections = () => (connectionStore ??= new Connections(localStorage));

/** How each connection's routes did lately, kept with the connection across restarts (routes.ts `RouteHealth`). */
const routeHealth = new Map<string, RouteHealth>();
const healthOf = (id: string) => routeHealth.get(id) ?? routeHealth.set(id, keptRouteHealth(savedConnections(), id)).get(id)!;
/** The record of recent connection attempts, kept on disk between launches (attempts.ts, #270). */
const connectionAttempts = new AttemptLog(tauriAttemptStore);
/**
 * A connection's pipe: its routes in order, and the server id the first route that names one reports kept (ADR 0056).
 * Each opening is kept in the record of connection attempts.
 */
const pipeFor = (c: SavedConnection, d: SignInDetails) =>
  tauriPipe(d, { onServer: (server) => savedConnections().setServer(c.id, server), health: healthOf(c.id), attempts: connectionAttempts });

const account: Account = {
  get connections() {
    return savedConnections();
  },
  secrets: systemSecrets,
  connect: (c, d, signal) => connect(pipeFor(c, d), undefined, localChatCache(c), desktopNotify, signal),
  readSaved: (c, d, reason) => readSaved(pipeFor(c, d), reason, localChatCache(c), desktopNotify),
  openSaved: (c, d) => openSaved(pipeFor(c, d), localChatCache(c), desktopNotify),
};

/** The sign-in methods a connection's server offers, read without signing in (ADR 0058). */
const serverMethods = (d: SignInDetails) => readMethods((one, expect) => tauriReach(one, expect, true, true), d);

/** Deletes what this computer keeps for a removed connection (forgetConnection.ts). */
const forgetLocal = (c: SavedConnection) => forgetConnectionData(c, { defaults: savedDefaults, tags: savedTagsFile, persona: savedPersona, afterwards: syncScreenshotOutbox });

const savedDrafts = drafts(localStorage);
const savedConnectionRefs = connectionRefs(localStorage);
const savedProjects = projectLinks(localStorage);
const savedPersona = new PersonaStore(localStorage);
// Applied as the app loads, so the chosen fonts show from the first screen.
const appearance = appearanceStore(localStorage, document.documentElement);
const backupEnv = savedBackupEnv(() => savedConnections().recent());

/** The names of the extra request headers a sign-in sends; only a URL sends them. */
const headerNames = (d: SignInDetails) =>
  d.routes
    ? [...new Set(d.routes.filter((r) => r.kind !== "ssh").flatMap((r) => (r.headers ?? []).map((h) => h.name.trim())))]
    : d.mode === "url"
      ? (d.headers ?? []).map((h) => h.name.trim())
      : [];

const BLANK: SignInDetails = { mode: "ssh", sshTarget: "", url: "", username: "", password: "", headers: [] };

/**
 * `d`, the sign-in `c` was made with, held to the server `c` knows now: a route may have reported it since `d` was read
 * (ADR 0056). Only a connection with several routes is held to one.
 */
const withKnownServer = (c: SavedConnection, d: SignInDetails): SignInDetails => {
  const server = savedConnections().get(c.id)?.server;
  return d.routes && server ? { ...d, server } : d;
};

/**
 * What launch ends in: signed in to the connection in use with its saved password, or the sign-in screen and why.
 * `connection` absent there: none is in use (none saved, or the one in use was removed), so the owner picks one.
 * `firstRun`: nothing is saved on this computer, so setup opens instead of the sign-in screen.
 */
type Launch =
  | { hermes: Hermes; connection: SavedConnection; details: SignInDetails; turnedDown?: Promise<string | undefined> }
  | { connection?: SavedConnection; initial: SignInDetails; error?: string; firstRun?: boolean };

/**
 * Setup, open over whatever else shows: where it was opened from, the connection it saves (`target`, a new one not
 * saved yet when adding), and its name.
 */
type Setup = { mode: SetupMode; initial: SignInDetails; target: SavedConnection; name?: string };
let launching: Promise<Launch> | undefined;

/**
 * Signs in to the connection in use with its saved password, if there is one. With a chat list saved for it, that
 * shows at once while signing in runs, and `turnedDown` says if the password turns out wrong (ADR 0089). With none,
 * signing in is waited for; if Hermes can't be reached, what this computer saved for it opens to read. If that fails
 * the sign-in screen has it filled in, so Connect tries again.
 * With no password saved, the sign-in screen asks for it. With no connection in use, the sign-in screen offers the
 * saved ones and picks none, unless nothing is saved at all: then it's the first run, and setup opens. Runs once,
 * though StrictMode runs effects twice.
 */
function launch(): Promise<Launch> {
  return (launching ??= (async () => {
    const c = account.connections.current();
    if (!c) return { initial: BLANK, firstRun: !account.connections.recent().length };
    const saved = await savedSignIn(c, account);
    if (!saved) return { connection: c, initial: await signInForm(c, account) };
    try {
      return { ...(await launchOpen(c, saved, account)), connection: c, details: saved };
    } catch (e) {
      return { connection: c, initial: saved, error: messageOf(e) };
    }
  })());
}

export default function App({ links = desktopLinks }: { links?: LinkInbox } = {}) {
  const [hermes, setHermes] = useState<Hermes | null>(null);
  // The connection in use, or the one the sign-in screen is for; none when the owner hasn't picked one.
  const [connection, setConnection] = useState<SavedConnection>();
  // A chat link the desktop opened (ADR 0037). One that isn't a chat link says why at once, on any screen. A good one
  // waits here until Main takes it, so it opens once signed in.
  const arrived = useSyncExternalStore(links.subscribe, links.getSnapshot);
  // Until the link the app was started with has been read, an empty inbox doesn't mean there's none, so Main, which
  // decides at once whether to reopen the last chat, waits.
  const linksReady = useSyncExternalStore(links.subscribe, links.isReady);
  // `at` tells Main a newer link, one that can't open, replaced whatever an older link was doing.
  const [badLink, setBadLink] = useState<{ reason: string; at: number }>();
  const goodLink = useMemo(() => {
    if (!arrived) return undefined;
    const parsed = parseChatLink(arrived.raw);
    return parsed.ok ? { link: parsed.link, at: arrived.at } : undefined;
  }, [arrived]);
  useEffect(() => {
    if (!arrived) return;
    const parsed = parseChatLink(arrived.raw);
    if (parsed.ok) return setBadLink(undefined);
    setBadLink({ reason: parsed.reason, at: arrived.at });
    links.clear(arrived.at);
  }, [arrived]);
  const linkNotice = badLink ? (
    <ChatLinkNotice view={{ kind: "error", text: `Hermes Chat didn't open that link. ${badLink.reason}` }} onClose={() => setBadLink(undefined)} />
  ) : (
    goodLink &&
    !hermes && (
      <ChatLinkNotice
        view={{ kind: "pending", text: `A chat link is waiting. It opens the chat in the ${goodLink.link.profile} profile once you're signed in. Nothing is sent.` }}
        onClose={() => links.clear(goodLink.at)}
      />
    )
  );
  // The sign-in screen's details; none while launch is signing in with the saved password.
  const [initial, setInitial] = useState<SignInDetails>();
  const [error, setError] = useState<string>();
  // Why the keyring couldn't save the password at sign-in, shown once signed in.
  const [notSaved, setNotSaved] = useState<string>();
  const [kept, setKept] = useState<Kept>({ password: true, headers: true });
  // Whether the main screen reopens the profile's last open chat: at launch, and on switching to a connection.
  const [coldStart, setColdStart] = useState(true);
  const [setup, setSetup] = useState<Setup>();
  const setupRef = useRef(setup);
  setupRef.current = setup;
  // Moves on with everything the owner does on the sign-in screen, so a Run setup again still reading the keyring
  // gives way to whatever was asked for after it.
  const signInAsks = useRef(0);
  const [confirmingSetup, setConfirmingSetup] = useState(false);
  const connectionGuard = useRef<((to: SavedConnection) => Promise<boolean>) | undefined>(undefined);
  // A connection being switched to, for the screen shown meanwhile.
  const [switchingTo, setSwitchingTo] = useState<SavedConnection>();
  // Asked from the sign-in screen: remove this connection?
  const [removing, setRemoving] = useState<SavedConnection>();
  const [removingActive, setRemovingActive] = useState<SavedConnection>();
  // Counts connections, so the main screen starts afresh for each one.
  const [connections, setConnections] = useState(0);
  const current = useRef<Hermes | null>(null);
  current.current = hermes;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  // The sign-in the connection in use was made with, password and all, so setup can put it back if a new one fails,
  // even when the keyring couldn't keep the password. The transport holds it anyway, to reconnect.
  const signedInWith = useRef<SignInDetails>(undefined);
  // The names of the extra request headers the connection sends, for Settings.
  const [headers, setHeaders] = useState<string[]>([]);
  const store = account.connections;
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const recent = store.recent();
  // Another window added, renamed or removed one.
  useEffect(() => {
    const changed = (e: StorageEvent) => (e.key === null || e.key === CONNECTIONS_KEY) && store.reread();
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [store]);

  // Rust holds one connection, so anything that opens or closes one runs after the one before has finished: a later
  // switch can never be overtaken by an earlier one, and the one left behind is closed before the next one opens.
  // `stale()`: a newer change was asked for meanwhile, so this one stops at its next step.
  const [serial] = useState(makeSerial);

  useEffect(() => {
    void launch().then((l) => {
      setConnection(l.connection);
      if ("hermes" in l) {
        signedInWith.current = l.details;
        setHeaders(headerNames(l.details));
        current.current = l.hermes;
        setHermes(l.hermes);
        // The saved password or token was turned down while the saved chats showed: the sign-in screen asks, as it
        // would have without them, unless the owner has moved on meanwhile.
        void l.turnedDown?.then((why) => {
          if (why !== undefined && current.current === l.hermes) showSignIn(l.connection, l.details, why);
        });
        return;
      }
      setInitial(l.initial);
      setError(l.error);
      if (l.firstRun) setSetup({ mode: "first-run", initial: BLANK, target: store.draft(BLANK) });
    });
  }, []);

  const use = (h: Hermes | null) => {
    current.current = h;
    setHermes(h);
    setConnections((n) => n + 1);
  };

  // On a fallback route, the routes before it are checked now and then without the password, and the connection
  // moves back to one that answers once nothing is running (ADR 0056).
  useEffect(() => {
    const d = signedInWith.current;
    const id = connection?.id;
    if (!hermes || !id || !d?.routes || routesOf(d).filter((r) => !r.off).length < 2) return;
    return new PreferredRoutes(hermes, d, reachRoute, healthOf(id), () => store.get(id)?.server ?? d.server).start();
  }, [hermes, connection?.id]);

  /** The sign-in screen, for `c` with `d` filled in, or with none picked. */
  const showSignIn = (c: SavedConnection | undefined, d: SignInDetails = BLANK, why?: string) => {
    signedInWith.current = undefined;
    current.current = null;
    setHermes(null);
    setConnection(c);
    setNotSaved(undefined);
    setKept({ password: true, headers: true });
    setInitial(d);
    setError(why);
  };

  /**
   * Leaves the connection in use for `target`, which signs in with its saved password, or Offline with what this
   * computer saved for it. Without a saved password, or if signing in fails, the sign-in screen asks for `target`.
   * The connection left behind is closed first; Hermes keeps its running replies going on the server.
   */
  const switchTo = (target: SavedConnection) =>
    serial(async (stale) => {
      if (stale()) return;
      setSwitchingTo(target);
      try {
        await current.current?.close().catch(() => {});
        setHermes(null);
        const d = await savedSignIn(target, account);
        if (stale()) return;
        if (!d) return showSignIn(target, await signInForm(target, account));
        try {
          const h = await launchSignIn(target, d, account);
          if (stale()) return void (await h.close().catch(() => {}));
          store.use(target.id);
          signedInWith.current = d;
          setConnection(store.get(target.id) ?? target);
          setHeaders(headerNames(d));
          setNotSaved(undefined);
          setKept({ password: true, headers: true });
          setError(undefined);
          // The connection's own last open chat, in the profile it showed last.
          setColdStart(true);
          use(h);
        } catch (e) {
          if (!stale()) showSignIn(target, d, messageOf(e));
        }
      } finally {
        if (!stale()) setSwitchingTo(undefined);
      }
    });

  /**
   * Setup's Save and connect, and the sign-in screen's Connect: signs in to `target` with `d`, and keeps it. The
   * connection in use closes first, or its reconnects would take Rust's one connection back. If the new one fails
   * after all, the one in use before is put back, as at launch: Offline with what this computer saved if it can't
   * connect either. `signal` is Setup's Stop: while Hermes hasn't answered, it stops the sign-in, which then fails
   * with nothing saved, and the one in use before is put back the same way.
   */
  const connectWith = async (target: SavedConnection, d: SignInDetails, name?: string, signal?: AbortSignal) => {
    // Setup can spend minutes testing while more work or approvals arrive. Ask at the actual switch, using Main's
    // latest state, and keep Setup mounted but hidden so cancelling the question keeps its tested details.
    if (setup && current.current && connectionGuard.current) {
      setConfirmingSetup(true);
      try {
        if (!(await connectionGuard.current({ ...target, name: name?.trim() || target.name })))
          throw new Error("Connection unchanged. You can continue setup when you are ready.");
      } finally {
        setConfirmingSetup(false);
      }
    }
    // Stopped while it waits its turn: it never starts, and the connection in use isn't touched.
    return serial.stoppable(signal, () => new Error(CONNECT_STOPPED), async (stale) => {
      if (stale()) throw new Error("A newer connection was selected.");
      const before = current.current;
      const beforeConnection = connectionRef.current;
      const beforeDetails = signedInWith.current;
      if (before) await before.close().catch(() => {});
      try {
        const { hermes: h, connection: c, notSaved, kept } = await signIn(target, d, account, name, signal);
        if (stale()) {
          await h.close().catch(() => {});
          use(null);
          throw new Error("A newer connection was selected.");
        }
        setNotSaved(notSaved);
        setKept(kept);
        setHeaders(headerNames(d));
        setError(undefined);
        // The last chat open was on the connection before, or this one as it was before the change.
        setColdStart(!before || beforeConnection?.id !== c.id);
        signedInWith.current = d;
        setConnection(c);
        use(h);
        return { notSaved, kept };
      } catch (e) {
        if (!stale() && before && beforeConnection) {
          const previous = beforeDetails ?? (await savedSignIn(beforeConnection, account));
          const back = previous ? await launchSignIn(beforeConnection, previous, account).catch(() => null) : null;
          if (back && previous) setHeaders(headerNames(previous));
          if (!back) {
            signedInWith.current = undefined;
            setInitial(await signInForm(beforeConnection, account));
          }
          use(back);
        }
        throw e;
      }
    });
  };

  /**
   * Removes a saved connection (account.ts `removeConnection`). The one in use is signed out of first; then the
   * sign-in screen offers the others and picks none, or setup opens when none is left.
   */
  const removeSaved = (c: SavedConnection) =>
    serial(async () => {
      const inUse = connectionRef.current?.id === c.id;
      let closed = false;
      try {
        await removeConnection(c, account, forgetLocal, inUse ? async () => {
          await current.current?.close().catch(() => {});
          closed = true;
          setRemovingActive(c);
          setInitial(undefined);
          use(null);
        } : undefined);
      } catch (e) {
        if (closed) showSignIn(c, await signInForm(c, account), `Couldn't finish removing this connection: ${messageOf(e)}. Its remaining local data is still saved. Try removing it again, or sign in.`);
        throw e;
      } finally {
        setRemovingActive(undefined);
      }
      if (!inUse) return;
      showSignIn(undefined);
      setColdStart(false);
      if (!store.recent().length) setSetup({ mode: "first-run", initial: BLANK, target: store.draft(BLANK) });
    });

  const setupLayer = setup && (
    <div hidden={confirmingSetup} inert={confirmingSetup}>
      <Onboarding
        key={`${setup.mode}:${setup.target.id}`}
        mode={setup.mode}
        initial={setup.initial}
        initialName={setup.name}
        probe={tauriProbe}
        reach={tauriReach}
        readMethods={serverMethods}
        hermes={hermes ?? undefined}
        onConnect={(d, name, signal) => connectWith(setup.target, d, name, signal)}
        onCancel={setup.mode === "first-run" ? undefined : () => setSetup(undefined)}
        onDone={() => setSetup(undefined)}
      />
    </div>
  );

  /** Setup to change `c`: from the sign-in it is using, if it's the one in use, header values and all but the password. */
  const editConnection = async (c: SavedConnection) => {
    const now = c.id === connectionRef.current?.id && signedInWith.current ? withKnownServer(c, { ...signedInWith.current, password: "", token: undefined }) : await signInForm(c, account);
    // ServerFields clears the header values if the URL changes, so they never go to another server.
    setSetup({ mode: c.id === connectionRef.current?.id && current.current ? "reconfigure" : "edit", initial: now, target: c, name: c.name });
  };

  // Updates: checked once as the app starts, if the owner wants that. Back in the window, a package update waiting to be
  // installed looks again for pacman having installed it, which the owner does in a terminal.
  useEffect(() => {
    if (getUIPrefs().checkUpdatesOnLaunch && appUpdates.getSnapshot().state === "idle") void appUpdates.check();
    const onFocus = () => void appUpdates.check({ installedOnly: true });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (hermes && connection && linksReady)
    return (
      <>
        <Main
          key={connections}
          hermes={hermes}
          connection={connection}
          saved={recent}
          savedUnsaved={store.unsaved}
          headers={headers}
          notSaved={notSaved}
          kept={kept}
          reopenLast={coldStart && !goodLink}
          covered={!!setup && !confirmingSetup}
          link={goodLink}
          linkSuperseded={badLink?.at}
          onLinkTaken={(at) => links.clear(at)}
          connectionGuard={connectionGuard}
          onSetUp={() => void editConnection(connection)}
          onSwitchConnection={(c) => void switchTo(c)}
          onAddConnection={() => setSetup({ mode: "add", initial: BLANK, target: store.draft(BLANK) })}
          onEditConnection={(c) => void editConnection(c)}
          onRenameConnection={(c, name) => {
            store.rename(c.id, name);
            if (c.id === connection.id) setConnection(store.get(c.id));
          }}
          onRemoveConnection={removeSaved}
          onTestConnection={async (c) => {
            const d = c.id === connection.id && signedInWith.current ? withKnownServer(c, signedInWith.current) : await savedSignIn(c, account);
            if (!d) throw new Error(`No ${c.method === "token" ? "token" : "password"} is saved for this connection, so it can't be tested. Edit it to sign in again.`);
            return testSignIn(tauriProbe, d);
          }}
          onSignOut={() =>
            serial(async () => {
              // Everything is read first, then shown at once: the sign-in screen keeps the details it mounts with.
              const { initial, error } = await signOutToSignIn(hermes, connection, account);
              setColdStart(false);
              showSignIn(connection, initial, error);
            })
          }
        />
        {setupLayer}
        {linkNotice}
      </>
    );
  // Setup keeps Main's slot order (Main, then setup), so finishing sign-in doesn't remount it at its first step.
  if (setupLayer)
    return (
      <>
        {null}
        {setupLayer}
        {linkNotice}
      </>
    );
  if (!initial || hermes || switchingTo || removingActive)
    return (
      <div className="first-run">
        <div className="first-run-card">
          <div className="rail-brand big">H</div>
          <p className="muted" role="status">
            {removingActive ? `Removing ${removingActive.name}…` : switchingTo ? `Connecting to ${switchingTo.name}…` : "Signing in…"}
          </p>
        </div>
        {linkNotice}
      </div>
    );
  return (
    <>
      {linkNotice}
      <SignIn
        key={connection?.id ?? "none"}
        initial={initial}
        error={error}
        connection={connection}
        connections={recent}
        readMethods={serverMethods}
        onSetUp={() => {
          signInAsks.current++;
          setSetup({ mode: "sign-in", initial: BLANK, target: store.draft(BLANK) });
        }}
        onRerunSetup={(c) => {
          const mine = ++signInAsks.current;
          void serial(async (stale) => {
            // From what is saved for it, as Edit does. Setup opens only if nothing else was asked for meanwhile: the
            // screen is still for `c`, nothing signed in, and no other setup opened.
            const d = await signInForm(c, account);
            if (stale() || mine !== signInAsks.current || setupRef.current || current.current || connectionRef.current?.id !== c.id) return;
            setSetup({ mode: "edit", initial: d, target: c, name: c.name });
          });
        }}
        onPick={(c) => {
          signInAsks.current++;
          void serial(async (stale) => {
            const d = (await savedSignIn(c, account)) ?? (await signInForm(c, account));
            if (!stale()) showSignIn(c, d);
          });
        }}
        onRemove={(c) => {
          signInAsks.current++;
          setRemoving(c);
        }}
        onSignIn={async (d) => {
          if (!connection) return;
          signInAsks.current++;
          setError(undefined);
          try {
            await connectWith(connection, d);
          } catch (e) {
            setError(messageOf(e));
          }
        }}
      />
      {removing && (
        <RemoveConnection
          c={removing}
          inUse={false}
          onCancel={() => setRemoving(undefined)}
          onRemove={async () => {
            await removeSaved(removing);
            setRemoving(undefined);
            if (removing.id === connectionRef.current?.id) showSignIn(undefined);
            if (!store.recent().length) setSetup({ mode: "first-run", initial: BLANK, target: store.draft(BLANK) });
          }}
        />
      )}
    </>
  );
}

/**
 * One pane of the chat area. `chatId` null: the New chat pane. `tabs`: the chats open in the pane's tabs, `chatId`'s
 * among them (Tabs.tsx). `draftError`: why the New chat pane couldn't start a chat. `picked`: the search result its chat
 * was opened from; `at` tells one pick from the next.
 */
type Pane = {
  key: string;
  view: number;
  chatId: string | null;
  tabs: (string | null)[];
  draftError?: string;
  picked?: { found: Found; at: number };
  jump?: JumpTarget;
  /** A subagent of the chat `chatId` to open in its Subagents panel, from the agent office; `at` tells one request from the next. */
  subagent?: { chatId: string; id: SubagentId; at: number };
  /** The worktree a New chat pane starts its chat in, picked in the Repository screen (ADR 0043). */
  worktree?: WorktreeStart;
};

let panesMade = 0;
/** A pane's key, which is also its name to Hermes for what is on screen (transport.ts `open`). */
const newPaneKey = () => `pane-${++panesMade}`;
let viewsMade = 0;
/** A pane's `view`: new each time what the pane shows changes, but not when only its tabs do, so a chat starting in the
 * pane can tell the owner went elsewhere from a tab closing beside it. */
const newView = () => ++viewsMade;

/** The chat a pane on the New chat pane shows: nothing yet, or why the chat couldn't start. */
const draftChat = (draftError?: string): Chat => ({
  id: "draft",
  title: "New chat",
  source: "app",
  settled: false,
  updatedAt: Date.now(),
  items: draftError ? [{ kind: "error", id: "e-draft", text: draftError }] : [],
});
/** What the desktop is told when a desktop shortcut's screenshot is attached while Hermes Chat isn't focused. */
const SCREENSHOT_ATTACHED = { title: "Screenshot attached", body: "Review it in Hermes Chat before you send it." };

/** The real screenshot calls, and what a desktop shortcut does once its screenshot is attached. */
export type Screenshots = {
  api: ScreenshotApi;
  syncOutbox?: () => Promise<void>;
  /** Calls `fn` whenever a desktop shortcut asks for a screenshot; returns the function that stops it. */
  onDesktopShortcut: (fn: () => void) => () => void;
  /** A desktop shortcut's screenshot was attached: bring the window forward, and say so if it still isn't focused. */
  attached: () => void;
  /** How screenshots are taken on this desktop, for Settings. */
  support?: () => Promise<ScreenshotSupport>;
};
const tauriScreenshotWiring: Screenshots = {
  api: tauriScreenshots,
  syncOutbox: syncScreenshotOutbox,
  onDesktopShortcut: onDesktopScreenshot,
  support: screenshotSupport,
  attached: () =>
    void showWindow().then(() => {
      if (!document.hasFocus()) void desktopNotify(SCREENSHOT_ATTACHED).catch(() => {});
    }),
};

export function Main({
  hermes,
  connection: given,
  headers = [],
  notSaved,
  kept = { password: true, headers: true },
  reopenLast = false,
  covered = false,
  onSetUp,
  saved = [],
  savedUnsaved = false,
  onSwitchConnection,
  onAddConnection,
  onEditConnection,
  onRenameConnection,
  onRemoveConnection,
  onTestConnection,
  connectionGuard,
  localFiles = tauriLocalFiles,
  webPages = tauriWebPages,
  serverPages = tauriServerPages,
  screenshots = tauriScreenshotWiring,
  summon = desktopSummon,
  personaStore = savedPersona,
  guardClose = tauriCloseGuard,
  onSignOut,
  updates = appUpdates,
  link,
  linkSuperseded,
  onLinkTaken,
  refs = savedConnectionRefs,
  tray = tauriTray,
  repoApi = tauriRepo,
  localStt = tauriLocalStt,
}: {
  hermes: Hermes;
  /** The saved connection in use (connections.ts); a bare sign-in (in tests) is keyed by its address, as before. */
  connection: SavedConnection | SavedSignIn;
  /** Every saved connection, most recently used first, for the recent-connection picker and the manager. */
  saved?: SavedConnection[];
  /** The connection list's last change couldn't be stored. */
  savedUnsaved?: boolean;
  /** Leaves this connection for another, once the owner has agreed to leave whatever is running here. */
  onSwitchConnection?: (c: SavedConnection) => void;
  onAddConnection?: () => void;
  /** Opens setup for `c`; for another connection than this one, once the owner has agreed to leave. */
  onEditConnection?: (c: SavedConnection) => void;
  onRenameConnection?: (c: SavedConnection, name: string) => void;
  /** Removes `c`; signs out first when it's this one. Rejects with why it couldn't. */
  onRemoveConnection?: (c: SavedConnection) => Promise<void>;
  /** Tests `c` with its saved sign-in; rejects when it has none. */
  onTestConnection?: (c: SavedConnection) => Promise<TestOutcome>;
  /** Setup asks the current screen immediately before replacing its connection. */
  connectionGuard?: RefObject<((to: SavedConnection) => Promise<boolean>) | undefined>;
  /** The names of the extra request headers the connection sends. */
  headers?: string[];
  notSaved?: string;
  /** What the keyring kept at sign-in. */
  kept?: Kept;
  /** This is the app starting: open the profile's last open chat, if the owner wants it reopened. */
  reopenLast?: boolean;
  /** Setup is open over the app: nothing here takes focus or keys. */
  covered?: boolean;
  /** Opens setup from Settings. */
  onSetUp?: () => void;
  localFiles?: LocalFiles;
  webPages?: WebPages;
  /** Pages on the Hermes server's own loopback, through SSH (ADR 0052). */
  serverPages?: ServerPages;
  screenshots?: Screenshots;
  /** The Repository screen's helper over ssh, and worktrees' (ADR 0034, 0043). */
  repoApi?: RepoApi;
  /** Speech to text on this computer and where each recording goes, decided by Rust (ADR 0065, 0067). */
  localStt?: LocalSttApi;
  /** Tells the window `hermes-chat --show` or `--toggle` brought it forward; none outside the desktop app. */
  summon?: SummonApi;
  /** Where Settings → Persona keeps unsaved edits and replaced versions on this computer. */
  personaStore?: PersonaStore;
  /** Asks before the window closes; registered only while Settings → Persona holds an unsaved edit. */
  guardClose?: CloseGuard;
  onSignOut: () => Promise<void>;
  updates?: Updater;
  /** A chat link to open (ADR 0037); `at` tells one from the next. Main takes it with `onLinkTaken`. */
  link?: { link: ChatLink; at: number };
  onLinkTaken?: (at: number) => void;
  /** When a newer link that can't open arrived: it replaces whatever an older link was doing, notice and all. */
  linkSuperseded?: number;
  /** The connection references chat links name (chatLinks.ts). */
  refs?: ConnectionRefs;
  /** The tray icon and Close to tray (tray.rs, ADR 0034). */
  tray?: TrayWiring;
}) {
  const connection: SavedConnection = "id" in given ? given : { ...given, id: "", name: defaultName(given), addedAt: 0 };
  const { profile, chats, olderPulled, archivedListed, status, route, unsecure, closedReason, syncError, others, live, models, switching, branchNews } = useSyncExternalStore(
    hermes.subscribe,
    hermes.getSnapshot,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Settings → Persona holds an edit Hermes doesn't have, or a save under way: leaving it asks first.
  const personaDirty = useRef(false);
  const [personaUnsaved, setPersonaUnsaved] = useState(false);
  // This computer could keep the unsaved edit, so leaving doesn't lose it.
  const [personaKept, setPersonaKept] = useState(true);
  // The profile whose persona is open: Settings → Persona can edit any profile's, not only the one in use.
  const [personaProfile, setPersonaProfile] = useState<string>();
  const onPersonaDirty = useCallback((dirty: boolean, kept: boolean, profile: string) => {
    personaDirty.current = dirty;
    setPersonaUnsaved(dirty);
    setPersonaKept(kept);
    setPersonaProfile(profile);
  }, []);
  // An unsaved edit in Settings → Memory (MemorySettings.tsx) lives only on screen: leaving it asks first too.
  const memoryDirty = useRef(false);
  const [memoryUnsaved, setMemoryUnsaved] = useState(false);
  // Bumped when the owner discards the edit, so Settings → Memory drops it even if what follows doesn't close it.
  const [memoryDiscards, setMemoryDiscards] = useState(0);
  const onMemoryDirty = useCallback((dirty: boolean) => {
    memoryDirty.current = dirty;
    setMemoryUnsaved(dirty);
  }, []);
  // An unsaved edit in Settings → Skills (SkillSettings.tsx) lives only on screen too, and is guarded the same way.
  const skillDirty = useRef(false);
  const [skillUnsaved, setSkillUnsaved] = useState(false);
  const [skillDiscards, setSkillDiscards] = useState(0);
  const onSkillDirty = useCallback((dirty: boolean) => {
    skillDirty.current = dirty;
    setSkillUnsaved(dirty);
  }, []);
  // Artifacts open to edit beside the chat (artifacts.ts, ADR 0029): their drafts live in memory for this sign-in, so
  // moving around the app keeps them, and only signing out or closing the window would drop one.
  const artifacts = useMemo(
    () => new ArtifactStore((ref) => artifactIo({ host: ref.host, files: hermes.files, fs: hermes.artifactFs(ref.profile, ref.session) }), (o) => hermes.askForEdit(o)),
    [hermes],
  );
  const artSnap = useSyncExternalStore(artifacts.subscribe, artifacts.getSnapshot);
  const artifactUnsaved = [...artSnap.values()].some(isDirty);
  const [leaving, setLeaving] = useState<{ edit: "persona" | "memory" | "skill" | "artifact"; what: LeaveWhat; go: () => void; stay?: () => void }>();
  /** Runs `go` now, or once the owner agrees to leave an unsaved persona, memory, skill or artifact edit behind. `stay` runs if they don't. */
  const guard = (go: () => void, what: LeaveWhat = "leave", stay?: () => void) => {
    // Signing out or closing drops artifact edits too: once a settings edit is left, they are asked about in turn.
    const next = what === "signout" || what === "close" ? () => (artifacts.unsaved().length ? setLeaving({ edit: "artifact", what, go, stay }) : go()) : go;
    if (memoryDirty.current) return setLeaving({ edit: "memory", what, go: next, stay });
    if (skillDirty.current) return setLeaving({ edit: "skill", what, go: next, stay });
    if (personaDirty.current) return setLeaving({ edit: "persona", what, go: next, stay });
    next();
  };
  const guardRef = useRef(guard);
  guardRef.current = guard;
  // Closing the window asks too, only while there is something to lose. A memory edit also holds a page reload.
  useCloseGuard(memoryUnsaved || skillUnsaved || artifactUnsaved, (close) => guardRef.current(close, "close"));
  const guardCloseRef = useRef(guardClose);
  useEffect(() => {
    if (!personaUnsaved) return;
    let stop: (() => void) | undefined;
    let gone = false;
    guardCloseRef.current((close) => guardRef.current(close, "close")).then(
      (off) => (gone ? off() : (stop = off)),
      () => {},
    );
    return () => {
      gone = true;
      stop?.();
    };
  }, [personaUnsaved]);
  // A new object each time a row asks Settings to show the Text generation model; the rail's button opens it plainly.
  const [showTextGeneration, setShowTextGeneration] = useState<object>();
  /** Set to open Settings on its Memory tab, from the context inspector. */
  const [showMemory, setShowMemory] = useState<object>();
  /** Set, each time anew, to open Settings → Diagnostics, at the capability a screen's note named. */
  const [showDiagnostics, setShowDiagnostics] = useState<{ id?: CapabilityId }>();
  /** What the connected Hermes supports, for the menus that say what it lacks (capabilities.ts). */
  const caps = useCapabilities(hermes.capabilities);
  /** Set, each time anew, to open Settings on its Voice tab, from a voice conversation's "Change voice settings". */
  const [showVoice, setShowVoice] = useState<object>();
  const openVoiceSettings = useRef(() => {});
  const voice = useMemo<VoiceApi>(
    () => ({
      // Speech to text may run on this computer, first or as backup (ADR 0065, 0067); Rust decides where a recording
      // goes, and its answer says where it ran. The route read here also tells the composer whether Hermes is needed.
      setup: () =>
        Promise.all([hermes.voiceSetup(), localStt.state().catch(() => undefined)]).then(([setup, local]) => {
          return local?.onThisComputer
            ? { ...setup, sttLocal: { label: local.label ?? undefined, problem: local.problem ?? undefined, backup: !!local.backup } }
            : setup;
        }),
      transcribe: (audio, mime, signal) => localStt.transcribe({ audio, mime, profile: hermes.profile, signal }),
      speak: (text) => hermes.speak(text),
      onChange: (fn) => {
        const offHermes = hermes.onVoiceChange(fn);
        const offLocal = localStt.onChange(fn);
        return () => (offHermes(), offLocal());
      },
      openSettings: () => openVoiceSettings.current(),
    }),
    [hermes, localStt],
  );
  // The speech-to-text route as Rust reads it, also while Hermes is offline: Dictation can run on this computer then.
  useEffect(() => {
    const read = () => void sttRoute.refresh(() => localStt.state().then(prefsOf, () => DEFAULT_STT_PREFS));
    read();
    return localStt.onChange(read);
  }, [localStt]);
  // The project screen covers the chat pane, as Settings does.
  const [projectOpen, setProjectOpen] = useState(false);
  // The membership sync's dialog: the move to Hermes, and conflicts with another computer (ADR 0033).
  const [membershipOpen, setMembershipOpen] = useState(false);
  /** The Scheduled jobs screen covers the chat, as Settings does. */
  const [jobsOpen, setJobsOpen] = useState(false);
  /** The job the Scheduled jobs screen opens on, when something other than the rail opened it; `n` starts it again. */
  const [jobsAt, setJobsAt] = useState<{ id: string; n: number }>();
  /** Automations (webhook routes, ADR 0036) cover the chat too. */
  const [automationsOpen, setAutomationsOpen] = useState(false);
  // The side panel's Terminal (ADR 0022, ADR 0039): which shell is shown, kept in the prefs so it opens on the one picked
  // last (the Hermes server's until then, ADR 0051), and which are running, for the rail's dot.
  const termKind = useSyncExternalStore(subscribeUIPrefs, getUIPrefs).terminalKind;
  // The list holds the profile's archived chats only while its Archived section is shown (ADR 0063); a profile switch
  // starts without them, so they are listed again then.
  const archivedShown = useSyncExternalStore(subscribeUIPrefs, getUIPrefs).chatSectionsShown.includes("archived");
  useEffect(() => {
    if (archivedShown !== archivedListed) void hermes.listArchived(archivedShown);
  }, [hermes, archivedShown, archivedListed]);
  const [termRunning, setTermRunning] = useState<Record<TerminalKind, boolean>>({ server: false, local: false });
  const terminalRunning = termRunning.server || termRunning.local;
  // The owner holds Hermes's screen: its computer use waits until they hand back, so the Screen tab says so.
  const [screenHeld, setScreenHeld] = useState(false);
  // The Repository screen covers the chat panes too (ADR 0034).
  const [repoOpen, setRepoOpen] = useState(false);
  /** Where the Repository screen opens when a chat's worktree label opened it: that worktree's Worktrees view. */
  const [repoAt, setRepoAt] = useState<{ target: string; path: string; view: "worktrees"; n: number }>();
  // The side panel's Files: the folder open last stays for this sign-in. `filesKey` opens it at `filesPath` again.
  const [filesPath, setFilesPath] = useState<string>();
  const [filesKey, setFilesKey] = useState(0);
  // Outputs covers the chat panes too, but not the preview pane, where its files open.
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [outputsScope, setOutputsScope] = useState<OutputsScope>("chat");
  // Usage analytics covers the chat panes too (ADR 0026). It reads Hermes afresh each time it opens.
  const [usageOpen, setUsageOpen] = useState(false);
  const usageIo = useMemo(() => hermes.usageIo(), [hermes]);
  // Settings → Diagnostics → Logs reads the profile's Hermes logs (ADR 0033, 0087). What it read goes when it closes;
  // this app's own diagnostics stay.
  const logs = useMemo(
    () => ({
      connection: route?.kind === "ssh" ? "SSH tunnel" : "dashboard URL",
      read: (file: RemoteLog, lines: number) => hermes.readLog(profile, file, lines),
      save: (text: string, fileName: string) => invoke<string | null>("logs_export", { text, fileName }),
      attempts: connectionAttempts,
    }),
    [route?.kind, hermes, profile],
  );
  const listProfiles = useCallback(() => hermes.profiles(), [hermes]);
  const update = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const updateWaiting = needsAttention(update);
  // Drafts were saved for the restart; nothing typed after that would survive it.
  const restarting = update.state === "restarting";
  // The chat to reopen at launch, until Hermes's list shows it is there or gone, or the owner goes somewhere first.
  // Kept per connection and profile, so the same profile name on another server keeps its own (connections.ts).
  const pref = prefScope(connection, profile);
  const [reopening, setReopening] = useState(() => (reopenLast ? chatToReopen(pref) : undefined));
  // One pane, or two side by side. The chat to reopen opens at once when the list saved on this computer has it, so the
  // New chat pane doesn't show first.
  const [panes, setPanes] = useState<Pane[]>(() => {
    const chatId = reopening && chats.some((c) => c.id === reopening) ? reopening : null;
    return [{ key: newPaneKey(), view: newView(), chatId, tabs: [chatId] }];
  });
  // Side by side ("row") or one above the other ("column"), when there are two panes.
  const [splitDir, setSplitDir] = useState<SplitDir>("row");
  // The pane the chat list, Search, New chat and the keyboard shortcuts act on.
  const [activeKey, setActiveKey] = useState(() => panes[0].key);
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const firstPane = useRef(panes[0].key);
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const active = panes.find((p) => p.key === activeKey) ?? panes[0];
  const other = panes.find((p) => p !== active);
  const split = panes.length > 1;
  const [listOpen, setListOpen] = useState(true);
  const [toast, setToast] = useState<Toast | null>(notSaved ? { text: notSaved, at: Date.now() } : null);
  // This app's diagnostics for the Logs screen (ADR 0033): the connection's changes, and the failures the app showed.
  useEffect(() => {
    note(status === "connected" ? "INFO" : "WARNING", `Connection to ${routeLabel(route) ?? "Hermes"}, profile ${profile}: ${STATUS_LABEL[status]}${status !== "connected" && closedReason ? ` (${closedReason})` : ""}`);
  }, [status, closedReason, profile]);
  useEffect(() => {
    if (syncError) note("WARNING", `Chat list: ${syncError}`);
  }, [syncError]);
  useEffect(() => {
    if (toast) note("WARNING", `Shown: ${toast.text}`);
  }, [toast]);
  // What became of a branch whose answer was lost, once the chat list settled it (ADR 0027).
  useEffect(() => {
    if (branchNews) setToast({ text: branchNews.text, at: branchNews.at });
  }, [branchNews?.at]);
  const [searchOpen, setSearchOpen] = useState(false);
  // The Saved filter the search palette opened with, if any; and the tag editor.
  const [searchStart, setSearchStart] = useState<SavedFilter>();
  const [tagsOpen, setTagsOpen] = useState(false);
  /** Where focus goes when the tag editor closes: the chat row whose menu opened it. */
  const tagsReturn = useRef<HTMLElement | null>(null);
  const openTags = (returnTo: HTMLElement | null = null) => {
    tagsReturn.current = returnTo;
    setTagsOpen(true);
  };

  // The inbox: what needs the owner, or finished, across the profiles (hermes/inbox.ts). Dismissals are kept on this
  // computer for the connection, and change nothing else. `goTo`: an entry's chat to open once its profile's list
  // has it. `focusItem`: the card or message in a pane to show once it is on screen.
  const [inboxOpen, setInboxOpen] = useState(false);
  /** The Bots view (Bots.tsx, ADR 0066), and a bot's chat to open once its profile is shown. */
  const [botsOpen, setBotsOpen] = useState(false);
  const [botGo, setBotGo] = useState<{ bot: Bot; then: "open" | "new"; nav: number }>();
  /** The agent office (Office.tsx, ADR 0077), unless Settings turns it off. */
  const [officeOpen, setOfficeOpen] = useState(false);
  const ackScope = inboxScope(connection);
  const acks = useMemo(() => inboxAcks(localStorage, ackScope), [ackScope]);
  const dismissed = useSyncExternalStore(acks.subscribe, acks.getSnapshot);
  const [seen] = useState(() => new Map<string, number>());
  const [goTo, setGoTo] = useState<{ entry: InboxEntry; approval: boolean }>();
  const [focusItem, setFocusItem] = useState<{ pane: string; chatId: string; itemId?: string; approval: boolean }>();

  // The model pick is sticky: new chats start on it, in this profile, until the owner picks another. It is kept on this
  // computer only and never becomes the profile's default. Picked in another profile, it gives way to this profile's
  // own model. A chat on screen shows the model it runs on, and a pick there switches that chat alone.
  const { modelPicker, modelPicks, modelFavorites, previewWidth, screenshotShortcut, agentOffice, inboxAutoDismissDays } = useSyncExternalStore(subscribeUIPrefs, getUIPrefs);
  const officeShown = officeOpen && agentOffice !== "off";
  // Who sits where in the building. It outlives the building's view, so hidden to the tray, minimized, behind Settings
  // or switched to List and back, each agent comes back to the desk it had.
  const officeFloorMemory = useRef(EMPTY_OFFICE_MEMORY);
  const catalog = models?.profile === profile ? models : undefined;
  const sticky: ModelPick | undefined = modelPicks[pref] ?? (modelPicker?.profile === pref ? withoutProfile(modelPicker) : catalog?.defaultPick);

  // The side panel beside the chat (ADR 0039): its tab, and whether it is open. Once opened it stays mounted for this
  // sign-in, hidden while closed, so a shell or the screen in it keeps running. `panelHidden`: in a window too narrow
  // for both, the panel covers the chat, and the owner has gone back to the chat without closing it.
  const [panelTab, setPanelTab] = useState<PanelTab>("preview");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);
  const [panelHidden, setPanelHidden] = useState(false);
  // What the Preview tab shows; null for the page that asks what to open.
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  // Counts what has been opened, so opening the same file again loads it again.
  const [previewSeq, setPreviewSeq] = useState(0);
  // The width while the owner drags the panel's edge; it is kept in the display preferences once they let go.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const openPanel = useCallback((tab: PanelTab) => {
    setPanelTab(tab);
    setPanelOpen(true);
    setPanelMounted(true);
    setPanelHidden(false);
  }, []);
  const openPreview = useCallback(
    (t: PreviewTarget) => {
      setPreview(t);
      setPreviewSeq((n) => n + 1);
      openPanel("preview");
    },
    [openPanel],
  );
  const mainRef = useRef<HTMLElement>(null);
  const mainWidth = useWidth(mainRef);

  // Projects are Hermes's, one store for each connection and profile; which chats are in each is kept on this computer.
  // A project picked in the switcher narrows the list to its chats. Active, Settled and Unread work as before inside it.
  const scope = projectScope(connection, profile);
  // Troubleshooting chats started from the Jobs screen, for this app run (troubleshoot.ts, ADR 0053). The store sees
  // every change in the chats, to tell when a troubleshooting reply has ended.
  const troubleshoots = useMemo(() => new TroubleshootStore(), [hermes]);
  useEffect(() => hermes.subscribe(() => troubleshoots.observe(hermes.getSnapshot())), [hermes, troubleshoots]);
  // Idle compaction (idleCompact.ts, ADR 0059): a chat open on Hermes here that has sat idle with its context window
  // past the owner's mark is compacted, one at a time. It sees every change in the chats, to time how long each has
  // been idle, and looks for one that is due every IDLE_COMPACT_CHECK_MS. Off unless turned on in Settings → Model.
  const compactor = useMemo(
    () =>
      new IdleCompactor(hermes, () => getUIPrefs().idleCompact, (c) => {
        const text = idleCompactionNote(c);
        if (text) setToast({ text, at: Date.now() });
      }),
    [hermes],
  );
  useEffect(() => {
    const look = () => {
      const snap = hermes.getSnapshot();
      void compactor.check(snap.chats, snap.status, Date.now());
    };
    const unsubscribe = hermes.subscribe(() => compactor.observe(hermes.getSnapshot().chats, Date.now()));
    compactor.observe(hermes.getSnapshot().chats, Date.now());
    const timer = setInterval(look, IDLE_COMPACT_CHECK_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [hermes, compactor]);
  // Keep the same store and request queue when returning to a profile: a write still finishing for that profile
  // must share ordering with its new reads and writes, rather than commit from an abandoned snapshot.
  const projectStores = useMemo(() => new Map<string, ProjectsStore>(), [hermes]);
  const projects = useMemo(() => {
    let store = projectStores.get(scope);
    if (!store) {
      store = new ProjectsStore(hermes.projects, savedProjects, scope, profile);
      projectStores.set(scope, store);
    }
    return store;
  }, [hermes, scope, projectStores]);
  const proj = useSyncExternalStore(projects.subscribe, projects.getSnapshot);
  // Another Hermes Chat window changed the projects, or another window or instance their defaults: show them here too.
  // Defaults are in a file every instance shares, so they are read again whenever the window comes back to the front.
  useEffect(() => {
    const changed = (e: StorageEvent) => e.key === PROJECTS_KEY && projects.reread();
    const back = () => void projects.readDefaults();
    window.addEventListener("storage", changed);
    window.addEventListener("focus", back);
    return () => {
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", back);
    };
  }, [projects]);
  // Tags and Saved filters: kept on this computer for each connection and profile, never sent to Hermes (tags.ts,
  // ADR 0026). Another Hermes Chat's changes show once this window is back in front.
  const tagsStore = useMemo(() => new TagsStore(savedTagsFile, scope), [scope]);
  const tagSnap = useSyncExternalStore(tagsStore.subscribe, tagsStore.getSnapshot);
  useEffect(() => {
    const back = () => void tagsStore.reread();
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, [tagsStore]);
  // Snoozes: kept on this computer for each connection and profile, never sent to Hermes (snooze.ts, ADR 0036).
  const snoozeStore = useMemo(() => new SnoozeStore(localStorage, scope), [scope]);
  const snoozes = useSyncExternalStore(snoozeStore.subscribe, snoozeStore.getSnapshot);
  // Renders again when the next snooze wakes, so a chat's header stops saying Snoozed then.
  const snoozeNow = useSnoozeClock(snoozes);
  const snoozedNow = (chatId: string) => ((snoozes[chatId] ?? 0) > snoozeNow ? snoozes[chatId] : undefined);
  useEffect(() => {
    const changed = (e: StorageEvent) => e.key === SNOOZE_KEY && snoozeStore.reread();
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [snoozeStore]);
  // Sending a message from this app wakes a snoozed chat, as it makes a Settled one active again (ADR 0002).
  useEffect(
    () => hermes.onSend((sentIn, chatId) => sentIn === profile && snoozeStore.isSnoozed(chatId) && snoozeStore.wake(chatId)),
    [hermes, profile, snoozeStore],
  );
  // When each chat last stopped working, so the list puts it at the top then (snooze.ts). Noted on every change.
  const attention = useMemo(() => new AttentionClock(), [scope]);
  // Pinned chats: kept on this computer for each connection and profile, like snoozes (ADR 0085).
  const pinStore = useMemo(() => new PinStore(localStorage, scope), [scope]);
  const pins = useSyncExternalStore(pinStore.subscribe, pinStore.getSnapshot);
  useEffect(() => {
    const changed = (e: StorageEvent) => e.key === PINS_KEY && pinStore.reread();
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [pinStore]);
  // A pinned chat the list doesn't reach (quiet for over a month) is looked up once and kept in the list; one Hermes no
  // longer has is unpinned.
  const pinsLookedUp = useMemo(() => new Set<string>(), [scope]);
  useEffect(() => {
    if (status !== "connected" || switching || !hermes.hasListed()) return;
    for (const id of Object.keys(pins)) {
      if (pinsLookedUp.has(id) || chats.some((c) => c.id === id)) continue;
      pinsLookedUp.add(id);
      hermes.findChat(id, profile).then(
        (found) => (found ? hermes.profile === profile && hermes.reveal(found) : pinStore.unpin(id)),
        () => pinsLookedUp.delete(id),
      );
    }
  }, [pins, chats, status, switching, pinStore]);
  attention.observe(chats, Date.now(), status === "connected");
  const tagChange = (fn: () => Promise<unknown>) =>
    fn().catch((e) => setToast({ text: (e as Error).message, at: Date.now() }));
  const openSearch = (start?: SavedFilter) => {
    setSearchStart(start);
    setSearchOpen(true);
  };
  const openSettings = () => {
    setProjectOpen(false);
    setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
    setRepoOpen(false);
    setOutputsOpen(false);
    setUsageOpen(false);
    setShowTextGeneration(undefined);
    setShowMemory(undefined);
    setShowDiagnostics(undefined);
    setShowVoice(undefined);
    setSettingsOpen(true);
  };
  openVoiceSettings.current = () => {
    openSettings();
    setShowVoice({});
  };
  /** Opens Settings → Diagnostics at capability `id`, from the note a screen shows when Hermes lacks it. */
  const openDiagnostics = (id: CapabilityId) => {
    openSettings();
    setShowDiagnostics({ id });
  };
  /** Opens a page of the compatibility guide in the owner's browser. */
  const openGuide = (url: string) =>
    void webPages.openInBrowser(url).catch((e: unknown) => setToast({ text: `Couldn't open the compatibility guide: ${messageOf(e)}`, at: Date.now() }));
  const listable = proj.projects.filter((p) => !p.archived);
  const shownProject = listable.find((p) => p.id === proj.selectedId);
  const projectScreenOpen = projectOpen && !!shownProject;
  const inShown = shownProject && new Set(proj.chats[shownProject.id] ?? []);
  // A Bot Chat opened from the Bots view is in `chats`, for its pane, but never in the list (ADR 0066).
  const inList = chats.filter((c) => !isBotChat(c));
  const listed = inShown ? inList.filter((c) => inShown.has(c.id)) : inList;
  const unreadChats = inList.filter((c) => c.unread && !c.archived);
  const projectUnread: ProjectUnread = {
    all: unreadChats.length,
    hidden: inShown ? unreadChats.filter((c) => !inShown.has(c.id)).length : 0,
    of: (id) => unreadChats.filter((c) => proj.chats[id]?.includes(c.id)).length,
  };
  const projectNames = (chatId: string) => listable.filter((p) => proj.chats[p.id]?.includes(chatId)).map((p) => p.name);

  // Outputs: one index for each connection and profile, like projects (outputs.ts, ADR 0016). Leaving a profile, or
  // signing out, stops its run and drops whatever it reads afterwards.
  const outputsIndex = useMemo(() => new OutputsIndex(hermes.outputsIo(profile), localStorage, scope), [hermes, scope]);
  useEffect(() => {
    outputsIndex.resume();
    return () => outputsIndex.cancel();
  }, [outputsIndex]);
  const outSnap = useSyncExternalStore(outputsIndex.subscribe, outputsIndex.getSnapshot);
  const outputsChatId = active.chatId && chats.some((c) => c.id === active.chatId) ? active.chatId : null;
  // A scope that has nothing to show (no chat open, no project picked) gives way to the next wider one.
  const shownOutputsScope: OutputsScope =
    outputsScope === "chat" && !outputsChatId ? (shownProject ? "project" : "profile") : outputsScope === "project" && !shownProject ? "profile" : outputsScope;
  const outputsChats = shownOutputsScope === "chat" ? chats.filter((c) => c.id === outputsChatId) : shownOutputsScope === "project" ? listed : chats;
  const outputsChatKey = outputsChats.map((c) => c.id).join("\n");
  const scopedOutputs = (snap: typeof outSnap): Output[] => {
    const ids = new Set(outputsChats.map((c) => c.id));
    // Every chat in the profile also takes in the files added without a chat; a chat deleted since isn't listed.
    return shownOutputsScope === "profile" ? outputsIn(snap).filter((o) => o.chatId === undefined || ids.has(o.chatId)) : outputsIn(snap, ids);
  };
  const shownOutputs = useMemo(() => scopedOutputs(outSnap), [outSnap, outputsChatKey, shownOutputsScope]);
  const outputsRefs = () => outputsChats.map((c) => ({ id: c.id, updatedAt: c.updatedAt }));
  // Reads the chats that changed, then checks where every file shown is now, so a file deleted since (a chat's own
  // `rm`, a scratch folder pruned) shows Missing before Edit or Preview is tried (#223, ADR 0064). A chat opened on its
  // own reads again the Outputs dropped to stay within the limit.
  const refreshOutputs = () => outputsIndex.refresh(outputsRefs(), shownOutputsScope === "chat", scopedOutputs);
  // The profile's list, once read from Hermes, is every chat it has: the records of the others go, whether or not
  // Outputs is open. A chat deleted, or no longer listed, keeps no record (outputs.ts `keepOnly`).
  const listedFromHermes = hermes.hasListed();
  // Clears from the Inbox were kept on this computer until clearing a chat settled it (ADR 0090). Once Hermes has
  // listed the profile's chats, the clears that still hold, the chats the old Unsettled section showed, are settled
  // once, as the Settle button would, and every clear of the connection and profile is dropped.
  const clearedStore = useMemo(() => new ClearedStore(localStorage, scope), [scope]);
  const cleared = useSyncExternalStore(clearedStore.subscribe, clearedStore.getSnapshot);
  useEffect(() => {
    if (!listedFromHermes || status !== "connected" || !Object.keys(cleared).length) return;
    for (const id of heldClears(chats, snoozes, Date.now(), attention.since, cleared, pins)) void hermes.settle(id);
    clearedStore.dropAll();
  }, [listedFromHermes, status, cleared, clearedStore]);
  const allChatsKey = chats.map((c) => c.id).join("\n");
  useEffect(() => {
    if (listedFromHermes) outputsIndex.keepOnly(new Set(chats.map((c) => c.id)));
  }, [outputsIndex, listedFromHermes, allChatsKey]);
  // Opening Outputs, or picking another scope, reads the chats in it that changed since they were last read. A chat
  // changing while it is open (a reply streaming) waits for Refresh, so a reply doesn't set off a read per word.
  // Then it checks where every file shown is (refreshOutputs).
  useEffect(() => {
    if (!outputsOpen || status !== "connected") return;
    void refreshOutputs();
  }, [outputsOpen, status, outputsIndex, shownOutputsScope, outputsChatKey]);
  const where = routeLabel(route) ?? addressLabel(connection);
  const inbox = inboxEntries({ profile, chats, connected: status === "connected", others, live, seen });
  const inboxShown = inbox.entries.filter((e) => !acks.isDismissed(e, dismissed));
  // Writes only when a resumed chat shows cards a dismissed waiting session covered.
  useEffect(() => acks.keepCovered(inbox.entries));
  useEffect(() => {
    if (inboxAutoDismissDays !== null) acks.expire(inbox.entries, inboxAutoDismissDays * 86_400_000);
  });
  const inboxCount = inboxShown.filter(needsOwner).length;
  // A restore reloads the app on what it wrote, so it waits for replies and Approvals, here or in another profile, and
  // for any draft or queue this computer couldn't keep (ADR 0038).
  const workingRef = useRef(false);
  const working = chats.some((c) => c.running || c.items.some(isWaiting)) || inbox.entries.some((e) => e.kind === "running" || (e.kind === "approval" && !e.ended));
  workingRef.current = working;
  // Read when the restore dialog renders and again just before it writes: sends and refused writes aren't React state.
  const restoreBusy = () => restoreBlocked({ working: workingRef.current, unsaved: unsaved.size, sending: sending.size });
  // Settings → Persona edits the SOUL.md of any profile on this connection, starting on the one in use; its edits are
  // kept apart per connection and profile.
  const persona: PersonaWiring = {
    api: hermes.persona,
    store: personaStore,
    keyOf: (p) => personaKey(connection, p),
    where: { server: route ? serverLabel(route) : connection.mode === "ssh" ? connection.sshTarget : serverLabel({ kind: "url", url: connection.url, addresses: [] }), route: where, profile },
  };

  const stillIn = (p: string) => hermes.profile === p;

  // A pane moving to another chat keeps its tabs in step (Tabs.tsx `navigateTabs`).
  const patchPane = (key: string, patch: Partial<Pane>) =>
    setPanes((ps) =>
      ps.map((p) => (p.key !== key ? p : { ...p, ...patch, view: newView(), ...(patch.chatId !== undefined && { tabs: navigateTabs(p.tabs, p.chatId, patch.chatId) }) })),
    );

  // The active pane's chat is the one kept as the profile's last open chat, so it reopens at the next launch.
  // Counts every move between chats, panes and profiles. A chat link that waited on Hermes checks it afterwards, so a
  // move made meanwhile, even one that came back to the same chat, wins over the link (ADR 0037).
  const navGen = useRef(0);

  const activate = (key: string) => {
    if (key === activeKeyRef.current) return;
    const pane = panes.find((p) => p.key === key);
    if (!pane) return;
    navGen.current++;
    activeKeyRef.current = key;
    setActiveKey(key);
    rememberChat(pane.chatId);
  };

  // Every move between chats is kept as the profile's last open chat, so it reopens at the next launch whether or not
  // the app closes cleanly. Going somewhere also ends the wait to reopen the last one. A chat opens in the active pane
  // unless another is named, and the pane it opens in becomes the active one.
  // `keepSettings`: the move isn't the owner's, so Settings stays on screen. `newTab`: the chat opens in a tab of its
  // own, rather than in place of the one showing.
  // A Bot Chat is reopened from its bot's row, found by its title, never by a stored id (ADR 0066): opening one leaves
  // the chat to reopen at the next launch as it was.
  const rememberChat = (id: string | null) => {
    const chat = id === null ? undefined : hermes.getSnapshot().chats.find((c) => c.id === id);
    if (!chat || !isBotChat(chat)) rememberOpenChat(pref, id);
  };
  const openChat = (
    id: string | null,
    {
      pane = active.key,
      remember = true,
      fresh = false,
      keepSettings = false,
      newTab = false,
      worktree,
      subagent,
    }: { pane?: string; remember?: boolean; fresh?: boolean; keepSettings?: boolean; newTab?: boolean; worktree?: WorktreeStart; subagent?: SubagentId } = {},
  ) => {
    const go = () => {
      navGen.current++;
      setPanelHidden(true);
      if (newTab) setPanes((ps) => ps.map((p) => (p.key === pane && !p.tabs.includes(id) ? { ...p, tabs: [...p.tabs, id] } : p)));
      patchPane(pane, { chatId: id, picked: undefined, jump: undefined, subagent: subagent && id ? { chatId: id, id: subagent, at: Date.now() } : undefined, worktree, ...(fresh && { draftError: undefined }) });
      activeKeyRef.current = pane;
      setActiveKey(pane);
      setReopening(undefined);
      if (!keepSettings) setSettingsOpen(false);
      setProjectOpen(false);
      setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
      setRepoOpen(false);
      setOutputsOpen(false);
      setUsageOpen(false);
      if (remember) rememberChat(id);
    };
    if (keepSettings) go();
    else guard(go);
  };

  const newChat = (remember = true) => openChat(null, { remember, fresh: true });

  /** Opens the Scheduled jobs screen on one job, as a troubleshooting chat's toast does (ADR 0053). */
  const openJobAt = (id: string) =>
    guard(() => {
      setProjectOpen(false);
      setSettingsOpen(false);
      setOutputsOpen(false);
      setUsageOpen(false);
      setRepoOpen(false);
      setAutomationsOpen(false);
      setOfficeOpen(false);
      setJobsAt((a) => ({ id, n: (a?.n ?? 0) + 1 }));
      setJobsOpen(true);
    });
  const openJobAtLatest = useRef(openJobAt);
  openJobAtLatest.current = openJobAt;
  // A troubleshooting reply that ends while the Jobs screen isn't showing is said in a toast, which opens the job: the
  // screen reads it again there and shows what changed. On the Jobs screen, the job's own panel says it.
  const jobsShowing = useRef(false);
  jobsShowing.current = jobsOpen && !settingsOpen;
  const troubleToasted = useRef(new Set<string>());
  useEffect(
    () =>
      troubleshoots.subscribe(() => {
        for (const t of troubleshoots.getSnapshot()) {
          if (t.phase !== "ended" || troubleToasted.current.has(t.id)) continue;
          troubleToasted.current.add(t.id);
          if (jobsShowing.current) continue;
          const here = hermes.profile === t.profile;
          setToast({
            text: `Troubleshooting “${t.jobName}”: Hermes's reply has ended.${here ? "" : ` Switch to ${t.profile} to see the job.`}`,
            at: Date.now(),
            ...(here && { action: { label: "See what changed", run: () => openJobAtLatest.current(t.jobId) } }),
          });
        }
      }),
    [troubleshoots],
  );

  /** Opens the Repository screen on a worktree's Worktrees view, as a chat's worktree label does (ADR 0043). */
  const openRepository = (at: { target: string; path: string; view: "worktrees" }) =>
    guard(() => {
      setProjectOpen(false);
      setSettingsOpen(false);
      setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
      setOutputsOpen(false);
      setUsageOpen(false);
      setRepoAt((was) => ({ ...at, n: (was?.n ?? 0) + 1 }));
      setRepoOpen(true);
    });

  const pick = (found: Found) => guard(() => {
    navGen.current++;
    setPanelHidden(true);
    hermes.reveal(found);
    patchPane(active.key, { chatId: found.chatId, picked: { found, at: Date.now() }, jump: undefined, subagent: undefined });
    setReopening(undefined);
    rememberChat(found.chatId);
    setSearchOpen(false);
    setSettingsOpen(false);
    setProjectOpen(false);
    setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
    setRepoOpen(false);
    setOutputsOpen(false);
    setUsageOpen(false);
  });

  // A second pane opens to the right and becomes the active one. Both panes may show the same chat: they are two views
  // of it, with one transcript, one draft and one reply, each scrolled and searched on its own.
  // `dir`: beside the first pane ("row") or below it ("column").
  const splitWith = (chatId: string | null, dir: SplitDir = splitDir) => guard(() => {
    if (split) return;
    navGen.current++;
    setPanelHidden(true);
    setSplitDir(dir);
    const key = newPaneKey();
    setPanes((ps) => (ps.length > 1 ? ps : [...ps, { key, view: newView(), chatId, tabs: [chatId] }]));
    activeKeyRef.current = key;
    setActiveKey(key);
    setReopening(undefined);
    setSettingsOpen(false);
    setProjectOpen(false);
    setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
    setRepoOpen(false);
    setOutputsOpen(false);
    setUsageOpen(false);
    rememberChat(chatId);
  });

  /** Opens a chat in the left (0) or right (1) pane, opening the right one if there's one pane. */
  const openIn = (id: string, side: number) => {
    const pane = panes[side];
    if (pane) openChat(id, { pane: pane.key });
    else splitWith(id);
  };

  // Screenshots go to the composer on screen. The desk lives as long as this signed-in window: signing out deletes any
  // capture not yet sent. Made in an effect, so StrictMode's second mount gets a desk of its own.
  const [desk, setDesk] = useState<ScreenshotDesk>();
  const screenshotsRef = useRef(screenshots);
  useEffect(() => {
    const d = new ScreenshotDesk(screenshotsRef.current.api, (remote) => remote && screenshotsRef.current.attached());
    setDesk(d);
    return () => d.dispose();
  }, []);
  // Reveal the composer when Search, Settings, Projects, Server files or a narrow preview covers it, so the capture can
  // be reviewed.
  const takeScreenshot = (remote = false) => guard(() => {
    if (!desk) return;
    flushSync(() => {
      setSettingsOpen(false);
      setProjectOpen(false);
      setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
      setRepoOpen(false);
      setOutputsOpen(false);
      setUsageOpen(false);
      setSearchOpen(false);
      if (!previewFits) setPanelHidden(true);
    });
    focusPane(active.key);
    void desk.capture({ remote });
  });
  const takeScreenshotRef = useRef(takeScreenshot);
  takeScreenshotRef.current = takeScreenshot;
  useEffect(() => (desk ? screenshotsRef.current.onDesktopShortcut(() => takeScreenshotRef.current(true)) : undefined), [desk]);

  // The pane left takes the whole width and becomes the active one.
  const closePane = (key: string) => {
    const rest = panes.filter((p) => p.key !== key);
    if (!rest.length || rest.length === panes.length) return;
    navGen.current++;
    setPanes(rest);
    activeKeyRef.current = rest[0].key;
    setActiveKey(rest[0].key);
    rememberChat(rest[0].chatId);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-pane="${CSS.escape(rest[0].key)}"] .composer textarea`)?.focus());
  };

  // A tab closing shows the one beside it. The last tab of a second pane closes the pane; the last of one pane leaves a
  // New chat tab.
  const closeTab = (key: string, id: string | null) => {
    const pane = panes.find((p) => p.key === key);
    if (!pane) return;
    const { rest, next } = closeTabIn(pane.tabs, id);
    if (!rest.length && split) return closePane(key);
    setPanes((ps) => ps.map((p) => (p.key === key ? { ...p, tabs: rest } : p)));
    if (pane.chatId === id) openChat(next ?? null, { pane: key, fresh: next === undefined });
  };

  /** Ctrl+Tab and Ctrl+Shift+Tab: the next or previous tab in the active pane. */
  const cycleTab = (step: number) => {
    const n = active.tabs.length;
    if (n < 2) return;
    openChat(active.tabs[(active.tabs.indexOf(active.chatId) + step + n) % n]);
  };

  // A chat dragged onto a pane, or moved by a tab's menu or the keyboard: `tabMoves.ts` says where it lands. A tab moves
  // and a chat from the list opens. A pane whose chat changes shows it afresh, as a chat opened there would.
  const layoutAfter = (moved: MovedChat, drop: TabDrop, newPane: (chatId: string) => Pane = (chatId) => ({ key: "pane-new", view: 0, chatId, tabs: [chatId] })) =>
    moveTab(panesRef.current, splitDir, moved, drop, newPane);
  /** What the hint says a drop would do, or null when it would do nothing. */
  const previewMove = (moved: MovedChat, drop: TabDrop) => {
    return layoutAfter(moved, drop) && dropLabel(panesRef.current, moved, drop);
  };
  const moveChat = (moved: MovedChat, drop: TabDrop) => guard(() => {
    const before = new Map(panesRef.current.map((p) => [p.key, p]));
    const out = layoutAfter(moved, drop, (chatId) => ({ key: newPaneKey(), view: newView(), chatId, tabs: [chatId] }));
    if (!out) return;
    navGen.current++;
    setPanelHidden(true);
    const panesNow = out.panes.map((p) => {
      const was = before.get(p.key);
      return was && was.chatId !== p.chatId ? { ...p, view: newView(), picked: undefined, jump: undefined, subagent: undefined, worktree: undefined } : p;
    });
    panesRef.current = panesNow;
    setPanes(panesNow);
    setSplitDir(out.dir);
    activeKeyRef.current = out.active;
    setActiveKey(out.active);
    setReopening(undefined);
    rememberChat(panesNow.find((p) => p.key === out.active)!.chatId);
  });
  const dropChat = (key: string, moved: MovedChat, zone: DropZone, index?: number) => moveChat(moved, { pane: key, zone, index });

  /** Ctrl+Shift+PageUp and PageDown: the tab shown in the active pane moves one place left or right along its strip.
   * Focus on a tab follows it. */
  const shiftTab = (step: number) => {
    const at = active.tabs.indexOf(active.chatId);
    const to = step < 0 ? at - 1 : at + 2;
    if (at < 0 || to < 0 || to > active.tabs.length) return;
    const focused = (document.activeElement as Element | null)?.closest(`[data-pane="${CSS.escape(active.key)}"] .tabs`);
    moveChat({ id: active.chatId, from: active.key }, { pane: active.key, zone: "tab", index: to });
    if (focused) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-pane="${CSS.escape(active.key)}"] .tab-open[aria-selected="true"]`)?.focus());
  };

  /** A tab's menu: the keyboard way to every drag of a tab (ADR 0052). Each item is the drop it stands for, said as
   * the drop's hint says it; of items that would do the same, the first is kept. */
  const tabMenu = (p: Pane, id: string | null): TabAction[] => {
    const moved = { id, from: p.key };
    const at = p.tabs.indexOf(id);
    const shown = p.chatId === id;
    const edgeIcons = { right: <PanelRight size={15} />, bottom: <PanelBottom size={15} />, left: <PanelLeft size={15} />, top: <PanelTop size={15} /> };
    const items = (list: { drop: TabDrop; label: string; icon: ReactNode; keys?: string }[]) => {
      const kept: { out: NonNullable<ReturnType<typeof layoutAfter>>; action: TabAction }[] = [];
      for (const { drop, label, icon, keys } of list) {
        const out = layoutAfter(moved, drop);
        if (out && !kept.some((k) => sameMove(k.out, out))) kept.push({ out, action: { label, icon, keys, run: () => moveChat(moved, drop) } });
      }
      return kept.map((k) => k.action);
    };
    const along = items([
      { drop: { pane: p.key, zone: "tab", index: at - 1 }, label: "Move tab left", icon: <ArrowLeft size={15} />, keys: shown ? "Ctrl+Shift+PgUp" : undefined },
      { drop: { pane: p.key, zone: "tab", index: at + 2 }, label: "Move tab right", icon: <ArrowRight size={15} />, keys: shown ? "Ctrl+Shift+PgDn" : undefined },
    ]);
    // Into the other pane's tabs first, as that is the plainest; then the edges of the tab's own pane.
    const elsewhere = items([
      ...panes
        .filter((o) => o.key !== p.key)
        .map((o) => ({
          drop: { pane: o.key, zone: "tab" as const },
          label: `${p.tabs.length === 1 ? "Merge into" : "Move to"} the ${paneNames(splitDir)[panes.indexOf(o)].toLowerCase()} pane`,
          icon: <Columns2 size={15} />,
        })),
      ...EDGES.map((zone) => ({ drop: { pane: p.key, zone }, label: dropLabel(panes, moved, { pane: p.key, zone }), icon: edgeIcons[zone] })),
      // The other pane's edges: the tab stays, and its pane goes to that side of the other one.
      ...panes
        .filter((o) => o.key !== p.key)
        .flatMap((o) =>
          EDGES.map((zone) => ({
            drop: { pane: o.key, zone },
            label: `Move this pane ${EDGE_SIDE[zone]} the ${paneNames(splitDir)[panes.indexOf(o)].toLowerCase()} pane`,
            icon: edgeIcons[zone],
          })),
        ),
    ]);
    const groups = [along, elsewhere, [{ label: "Close tab", icon: <X size={15} />, run: () => closeTab(p.key, id) }]].filter((g) => g.length);
    return groups.flatMap((g, i) => (i ? ["sep" as const, ...g] : g));
  };

  /** Ctrl+\: splits the chat on screen into a second pane, or closes the pane the owner isn't in. */
  const toggleSplit = () => (other ? closePane(other.key) : splitWith(active.chatId));

  // The panes showing a chat that leaves the list give way to the New chat pane. The active one does as New chat does.
  const clearChat = (id: string) => {
    if (!panes.some((p) => p.tabs.includes(id))) return;
    if (active.chatId === id) openChat(null, { fresh: true, keepSettings: true });
    setPanes((ps) =>
      ps.map((p) =>
        p.chatId === id
          ? { ...p, view: newView(), chatId: null, tabs: navigateTabs(p.tabs, id, null).filter((t) => t !== id), picked: undefined, draftError: undefined }
          : { ...p, tabs: p.tabs.filter((t) => t !== id) },
      ),
    );
  };

  // The other profile's chats replace the list, so one pane stays, on a fresh draft. The profile left keeps its last
  // open chat for the next launch.
  const switchProfileNow = (name: string) => {
    navGen.current++;
    const keep = activeKeyRef.current;
    setGoTo(undefined);
    setBotGo(undefined);
    setFocusItem(undefined);
    setPanes([{ key: keep, view: newView(), chatId: null, tabs: [null] }]);
    activeKeyRef.current = keep;
    setActiveKey(keep);
    setReopening(undefined);
    setSettingsOpen(false);
    setProjectOpen(false);
    setToast(null);
    // What the Preview showed was the old profile's; the Screen tab starts again for the new one.
    setPreview(null);
    if (panelTab === "preview") setPanelOpen(false);
    void hermes.switchProfile(name);
  };
  const switchProfile = (name: string) => guard(() => switchProfileNow(name), "profile");

  // Another saved connection (ADR 0049). Whatever is running or waiting here is named first, from the inbox's entries,
  // which cover every profile on this server; an unsaved persona or memory edit asks first too. Nothing is stopped:
  // Hermes keeps a running reply going after this connection closes, as it does when the profile switches.
  const [connectionAsk, setConnectionAsk] = useState<{ to: SavedConnection; notes: string[]; go: () => void; stay?: () => void }>();
  const [removeAsk, setRemoveAsk] = useState<SavedConnection>();
  const leavingConnection = (): string[] => {
    const named = (es: InboxEntry[]) =>
      es.slice(0, 3).map((e) => `“${e.title}” in ${e.profile}`).join(", ") + (es.length > 3 ? `, and ${es.length - 3} more` : "");
    const waiting = inbox.entries.filter((e) => e.kind === "approval" && !e.ended);
    const running = inbox.entries.filter((e) => e.kind === "running");
    const notes: string[] = [];
    if (waiting.length) notes.push(`${waiting.length === 1 ? "An Approval is" : `${waiting.length} Approvals are`} waiting for you: ${named(waiting)}.`);
    if (running.length) notes.push(`${running.length === 1 ? "A reply is" : `${running.length} replies are`} running: ${named(running)}.`);
    const here = leavingNote(profile, chats);
    if (!notes.length && here) notes.push(here);
    return notes;
  };
  const leaveConnection = (to: SavedConnection, go: () => void, stay?: () => void) =>
    guard(() => {
      const notes = leavingConnection();
      if (notes.length) setConnectionAsk({ to, notes, go, stay });
      else go();
    }, "connection", stay);
  if (connectionGuard) connectionGuard.current = (to) => new Promise((resolve) => leaveConnection(to, () => resolve(true), () => resolve(false)));
  const openConnections = () => guard(openSettings);
  const connectionManager = onSwitchConnection && (
    <ConnectionManager
      connections={saved}
      currentId={connection.id}
      unsaved={savedUnsaved}
      onTest={(c) => (onTestConnection ? onTestConnection(c) : Promise.reject(new Error("Testing isn't available here.")))}
      onConnect={(c) => leaveConnection(c, () => onSwitchConnection(c))}
      onEdit={(c) => (c.id === connection.id ? guard(() => onEditConnection?.(c)) : leaveConnection(c, () => onEditConnection?.(c)))}
      onRemove={(c) => (c.id === connection.id ? guard(() => setRemoveAsk(c), "signout") : setRemoveAsk(c))}
      onRename={(c, name) => onRenameConnection?.(c, name)}
      onAdd={() => onAddConnection?.()}
    />
  );

  // An inbox entry opens its chat, in its own profile, in the pane already showing it or else the active one. Another
  // profile is switched to first, the way the switcher does, and the chat opens once that profile's list has it.
  // An unsaved persona or memory edit asks first, as any other way of leaving Settings does.
  const openEntry = (e: InboxEntry) => {
    setInboxOpen(false);
    guard(() => {
      if (e.profile !== profile) switchProfile(e.profile);
      setGoTo({ entry: e, approval: e.kind === "approval" && !e.ended });
    }, e.profile !== profile ? "profile" : "leave");
  };

  // A reply's desk goes where its inbox entry goes. A subagent's desk is always in the profile shown (ADR 0077), and
  // opens in the pane already showing its chat, or else the active one.
  const openDesk = (room: Room, desk: Desk) => {
    setOfficeOpen(false);
    if (desk.agent.kind === "reply" && desk.agent.entry) return openEntry(desk.agent.entry);
    const pane = panes.find((p) => p.chatId === room.chatId)?.key ?? active.key;
    openChat(room.chatId, { pane, ...(desk.agent.kind === "subagent" && { subagent: desk.agent.id }) });
  };

  useEffect(() => {
    const e = goTo?.entry;
    if (!goTo || !e || e.profile !== profile) return;
    if (chats.some((c) => c.id === e.chatId)) {
      const pane = panes.find((p) => p.chatId === e.chatId)?.key ?? active.key;
      openChat(e.chatId, { pane });
      setFocusItem({ pane, chatId: e.chatId, itemId: e.itemId, approval: goTo.approval });
      setGoTo(undefined);
    } else if (!switching && hermes.hasListed()) {
      // The list holds the past month, so an older chat a check found is put in it the way a search result is. One
      // deleted meanwhile says so once it fails to load.
      hermes.reveal({ chatId: e.chatId, title: e.title, source: e.source ?? "app", settled: true, updatedAt: e.at || Date.now(), snippet: [] });
    }
  }, [goTo, profile, chats, switching]);

  // A bot's row opens its Bot Chat, in the bot's own profile (ADR 0066): another profile is switched to first, as the
  // switcher does, and once its list has loaded the Bot Chat is looked up by title and opened in the active pane. It isn't
  // remembered for the next launch: what reopens a Bot Chat is its bot's row. The pen starts an ordinary chat there.
  const loadBots = useCallback(() => hermes.bots(), [hermes]);
  const botAvatar = useCallback((p: string) => hermes.botAvatar(p), [hermes]);
  const activityOf = (b: Bot, roster: readonly Bot[]) => {
    const ids = b.botChat ? [b.botChat.id, b.botChat.resolvedId] : [];
    const open = b.profile === profile ? chats.find((c) => ids.includes(c.id)) : undefined;
    return botActivity(b, live?.sessions ?? [], open && { running: open.running, waiting: open.items.some(isWaiting) }, roster);
  };
  // A Bot Chat waiting on the owner in any profile: one shown here, or a live one known by its title or, for one
  // resumed here earlier, whose row says no title, by the ids the roster named.
  const botsNeedYou =
    chats.some((c) => isBotChat(c) && c.items.some(isWaiting)) ||
    (live?.sessions ?? []).some((s) => s.status === "waiting" && (isBotChatTitle(s.title) || hermes.isKnownBotChat(s.chatId, s.profile)));
  const openBot = (b: Bot, then: "open" | "new") => {
    setBotsOpen(false);
    guard(() => {
      if (b.profile !== profile) switchProfileNow(b.profile);
      // Anything the owner opens or switches to after this, before the Bot Chat opens, wins over it (`navGen`).
      setBotGo({ bot: b, then, nav: navGen.current });
    }, b.profile !== profile ? "profile" : "leave");
  };
  useEffect(() => {
    const go = botGo;
    if (!go) return;
    if (navGen.current !== go.nav) return setBotGo(undefined);
    if (go.bot.profile !== profile || switching || !hermes.hasListed()) return;
    setBotGo(undefined);
    if (go.then === "new") {
      newChat();
      return;
    }
    const still = () => navGen.current === go.nav && hermes.profile === go.bot.profile;
    hermes
      .openBotChat(go.bot)
      .then((id) => still() && openChat(id, { remember: false }))
      .catch((e: unknown) => still() && setToast({ text: (e as Error).message, at: Date.now() }));
  }, [botGo, profile, switching, chats]);

  // The Approval card or message an entry is about is scrolled to and focused once its chat shows it. Focus goes to
  // the card itself, never to one of its answers. An Approval in a chat this connection hadn't resumed shows once it
  // loads; if none is waiting by then, the chat is simply open.
  useEffect(() => {
    if (!focusItem) return;
    const pane = document.querySelector(`[data-pane="${CSS.escape(focusItem.pane)}"]`);
    const el = focusItem.itemId
      ? pane?.querySelector<HTMLElement>(`[data-item="${CSS.escape(focusItem.itemId)}"]`)
      : focusItem.approval
        ? pane?.querySelector<HTMLElement>(".approval:not(.answered)")
        : undefined;
    if (el) {
      el.scrollIntoView?.({ block: "center" });
      if (el.tabIndex < 0 && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus();
      setFocusItem(undefined);
      return;
    }
    const chat = chats.find((c) => c.id === focusItem.chatId);
    if (!focusItem.itemId && !focusItem.approval) setFocusItem(undefined);
    else if (chat?.runtimeId && !chat.loading) setFocusItem(undefined);
  }, [focusItem, chats]);

  // Undo sends the opposite change, not a stored copy, so it also works once the list has refreshed. Settling forgets
  // a snooze, which Undo puts back.
  const setSettled = (id: string, settled: boolean) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    const snoozedUntil = settled && snoozeStore.isSnoozed(id) ? snoozes[id] : undefined;
    const move = (s: boolean) => void (s ? hermes.settle(id) : hermes.unsettle(id));
    move(settled);
    if (settled) snoozeStore.wake(id);
    setToast({
      text: `${settled ? "Settled" : "Unsettled"}: ${title}`,
      undo: () => {
        move(!settled);
        if (snoozedUntil) snoozeStore.snooze(id, snoozedUntil);
      },
      at: Date.now(),
    });
  };

  // Snoozing is kept on this computer only; Undo puts back what the chat had.
  const snoozeChat = (id: string, until: number | undefined) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    const before = snoozeStore.isSnoozed(id) ? snoozes[id] : undefined;
    const put = (to: number | undefined) => (to ? snoozeStore.snooze(id, to) : snoozeStore.wake(id));
    // Unsnoozing wakes it now, so it comes to the top as a snooze that ran out would.
    put(until ?? Date.now());
    setToast({ text: `${until ? `Snoozed until ${wakeFull(until)}` : "Unsnoozed"}: ${title}`, undo: () => put(before), at: Date.now() });
  };

  // Pinning is kept on this computer only; Undo puts the chat back where it was, a pin back in its old place.
  const pinChat = (id: string, on: boolean) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    const before = pins[id];
    const put = (to: boolean, at?: number) => (to ? pinStore.pin(id, at) : pinStore.unpin(id));
    put(on);
    setToast({ text: `${on ? "Pinned" : "Unpinned"}: ${title}`, undo: () => put(!on, before), at: Date.now() });
  };

  // Putting a chat in a project, or taking it out: Hermes's once it keeps membership, waiting here until it confirms,
  // and this computer's otherwise (ADR 0033). Undo puts it back.
  const setInProject = (chatId: string, p: Project, inProject: boolean) => {
    const title = chats.find((c) => c.id === chatId)?.title ?? "";
    projects.setChat(p.id, chatId, inProject);
    setToast({
      text: `${inProject ? `Put in ${p.name}` : `Taken out of ${p.name}`}: ${title}`,
      undo: () => projects.setChat(p.id, chatId, !inProject),
      at: Date.now(),
    });
  };

  // Deleting can't be undone, so the row asked first. A pane showing the chat gives way to a fresh draft. A refused
  // delete says why in the list instead of the toast.
  const deleteChat = (id: string) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    clearChat(id);
    return hermes.delete(id).then((deleted) => {
      if (deleted) {
        projects.forgetChat(id);
        tagChange(() => tagsStore.forgetChat(id));
        snoozeStore.wake(id);
        pinStore.unpin(id);
        if (stillIn(profile)) setToast({ text: `Deleted: ${title}`, at: Date.now() });
      }
      return deleted;
    });
  };

  // Archiving hides the chat in every Hermes client and keeps its history; the toast shows once Hermes confirms it. A
  // pane showing the chat gives way to a fresh draft, as it leaves the list. A write that didn't go in says why in the
  // list.
  const setArchived = (id: string, archived: boolean) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    if (archived && !archivedListed) clearChat(id);
    const done = (ok: boolean) =>
      ok &&
      stillIn(profile) &&
      setToast({ text: `${archived ? "Archived" : "Restored"}: ${title}`, undo: archived ? () => setArchived(id, false) : undefined, at: Date.now() });
    void (archived ? hermes.archive(id) : hermes.restore(id)).then(done);
  };

  // The chat to reopen opens as soon as the list has it, the saved one at first, and stays open once the list read from
  // Hermes has it too. If that list doesn't, the chat was deleted, archived, or is older than the list reaches: the New
  // chat pane shows instead, and the chat isn't looked for at the next launch. Only the first pane reopens anything;
  // opening a second pane ends the wait.
  useEffect(() => {
    if (!reopening) return;
    const listed = hermes.hasListed();
    if (chats.some((c) => c.id === reopening)) {
      patchPane(firstPane.current, { chatId: reopening });
      if (!listed) return;
    } else if (listed) {
      patchPane(firstPane.current, { chatId: null });
      forgetOpenChat(pref, reopening);
    } else return;
    setReopening(undefined);
  }, [hermes, reopening, chats, pref]);

  useEffect(() => {
    if (!toast) return;
    // A toast that offers somewhere to go stays longer than one that only says something.
    const timer = setTimeout(() => setToast(null), toast.action ? ACTION_TOAST_MS : TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  // Out of focus, Hermes notifies instead of marking the chats on screen read (transport.ts `setFocused`).
  useEffect(() => {
    hermes.setFocused(document.hasFocus());
    const onFocus = () => hermes.setFocused(true);
    const onBlur = () => hermes.setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [hermes]);

  useEffect(() => {
    if (status === "connected") void projects.load();
  }, [projects, status]);

  // Back on the network: don't wait for the next retry, or for the owner if it gave up.
  useEffect(() => {
    const onOnline = () => void hermes.reconnect();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [hermes]);

  useEffect(() => {
    void hermes.sync();
    const timer = setInterval(() => void hermes.sync(), SYNC_EVERY_MS);
    return () => clearInterval(timer);
  }, [hermes]);

  // The models the profile offers, read once connected, and again for each profile.
  useEffect(() => {
    if (status === "connected") void hermes.loadModels();
  }, [hermes, status, profile]);

  // Switching profile restores its own pick, or seeds its default once the model list is read.
  useEffect(() => {
    const pick = getUIPrefs().modelPicker;
    if (catalog?.defaultPick && pick?.profile !== pref) setUIPrefs({ modelPicker: { ...(getUIPrefs().modelPicks[pref] ?? catalog.defaultPick), profile: pref } });
  }, [catalog, pref]);

  // The tray (ADR 0034). Its New chat and Open Inbox come here once Rust has shown the window; New chat asks first
  // about an unsaved edit, as the app's own New chat does. While a modal dialog is open (a Server file being edited,
  // a question), they only bring the window forward, as the app's shortcuts stop at a modal: the owner sees the dialog
  // and decides. The tray is told only how many Inbox entries need the owner, for its menu and the dot on its icon,
  // never what they say; signing out clears it.
  const trayCovered = () => covered || !!document.querySelector('[aria-modal="true"]');
  const trayNewChat = useRef(() => {});
  trayNewChat.current = () => trayCovered() || newChat();
  const trayInbox = useRef(() => {});
  trayInbox.current = () => trayCovered() || setInboxOpen(true);
  useEffect(() => tray.onNewChat(() => trayNewChat.current()), [tray]);
  useEffect(() => tray.onOpenInbox(() => trayInbox.current()), [tray]);
  useEffect(() => tray.reportInbox(inboxCount), [tray, inboxCount]);
  useEffect(() => () => tray.reportInbox(0), [tray]);
  // Hidden to the tray, the window shows no chat: replies arriving meanwhile leave their chats Unread.
  const windowHidden = useWindowHidden();
  const pageHidden = usePageHidden();
  // The office is drawn, and its rooms worked out, only while it can be seen: hidden to the tray or minimized, it isn't.
  const officeVisible = officeShown && !windowHidden && !pageHidden;

  // The inbox and the Bots view ask for fresh checks as they open, and keep asking while open: they show what is live.
  const liveWatched = inboxOpen || botsOpen;
  useEffect(() => {
    if (!liveWatched) return;
    void hermes.checkOtherProfiles();
    const timer = setInterval(() => void hermes.checkOtherProfiles(), INBOX_CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [hermes, liveWatched]);
  // The office keeps every profile's floor live from `session.active_list` alone, as often as the transport allows,
  // while it can be seen (ADR 0089). It leaves the heavier read of the other profiles' chat lists at CHECK_EVERY_MS.
  useEffect(() => {
    if (!officeVisible) return;
    void hermes.checkLive();
    const timer = setInterval(() => void hermes.checkLive(), LIVE_MIN_GAP_MS);
    return () => clearInterval(timer);
  }, [hermes, officeVisible]);

  // Unread chats in the other profiles are polled, so the switcher can be up to CHECK_EVERY_MS behind.
  useEffect(() => {
    void hermes.checkOtherProfiles();
    const timer = setInterval(() => void hermes.checkOtherProfiles(), CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [hermes]);

  /** Makes a pane the active one and puts the cursor in its composer, as Ctrl+1 and Ctrl+2 do. */
  const focusPane = (key: string) => {
    flushSync(() => activate(key));
    document.querySelector<HTMLTextAreaElement>(`[data-pane="${CSS.escape(key)}"] .composer textarea`)?.focus();
  };

  // Chat links (ADR 0037). Everything is checked before anything moves: the link's connection is this one, Hermes is
  // connected, the server has the profile and the profile has the chat. Only then does the app switch profile, asking
  // first as the switcher does, and open the chat. A link that can't open changes nothing on screen, so the composer
  // and its draft stay as they were. Nothing is ever sent. `attempt` tells a retry from the try it replaces, so an
  // answer that comes back late, or after Cancel, is dropped.
  type LinkJob = { link: ChatLink; at: number; attempt: number; stage: "check" | "wait" | "locate" | "confirm" | "switch"; found?: Found; from?: string; gen?: number };
  const [linkJob, setLinkJob] = useState<LinkJob>();
  const [linkError, setLinkError] = useState<LinkNoticeView>();
  const linkJobRef = useRef(linkJob);
  linkJobRef.current = linkJob;
  const linkRan = useRef("");
  const isCurrent = (job: LinkJob) => linkJobRef.current?.at === job.at && linkJobRef.current.attempt === job.attempt;
  const hereLabel = connectionLabel(connectionKey(connection));
  const failLink = (text: string, actions?: LinkNoticeView["actions"]) => {
    linkJobRef.current = undefined;
    setLinkJob(undefined);
    setLinkError({ kind: "error", text, actions });
  };
  const retryLink = (job: LinkJob) => {
    setLinkError(undefined);
    const next: LinkJob = { link: job.link, at: job.at, attempt: job.attempt + 1, stage: "check" };
    linkJobRef.current = next;
    setLinkJob(next);
  };

  useEffect(() => {
    if (!link) return;
    onLinkTaken?.(link.at);
    if (linkJobRef.current?.at === link.at) return;
    setLinkError(undefined);
    const job: LinkJob = { link: link.link, at: link.at, attempt: 0, stage: "check" };
    linkJobRef.current = job;
    setLinkJob(job);
  }, [link?.at]);

  // An unsaved edit in Settings asks first. Its answer may come after the link was cancelled or replaced, so the link
  // is checked again then; Keep editing drops the link.
  const stayed = (job: LinkJob) => () => {
    if (isCurrent(job)) closeLinkNotice();
  };

  useEffect(() => {
    if (linkSuperseded !== undefined) closeLinkNotice();
  }, [linkSuperseded]);

  const openLinked = (job: LinkJob, found: Found) => {
    if (!isCurrent(job)) return;
    guard(
      () => {
        if (!isCurrent(job) || hermes.profile !== job.link.profile) return;
        linkJobRef.current = undefined;
        setLinkJob(undefined);
        hermes.reveal(found);
        const pane = panesRef.current.find((p) => p.chatId === found.chatId)?.key ?? activeKeyRef.current;
        // Already asked, just above.
        openChat(found.chatId, { pane, keepSettings: true });
        setSettingsOpen(false);
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-pane="${CSS.escape(pane)}"] .composer textarea`)?.focus());
      },
      "leave",
      stayed(job),
    );
  };

  const switchForLink = (job: LinkJob, found: Found) => {
    if (!isCurrent(job)) return;
    const next: LinkJob = { ...job, stage: "switch", found, from: hermes.profile };
    linkJobRef.current = next;
    setLinkJob(next);
    guard(
      () => {
        if (!isCurrent(next) || hermes.profile !== next.from) return;
        switchProfileNow(job.link.profile);
        // The switch itself is a move; only the owner's moves after it drop the link.
        const switched: LinkJob = { ...next, gen: navGen.current };
        linkJobRef.current = switched;
        setLinkJob(switched);
      },
      "profile",
      stayed(next),
    );
  };

  const runLink = async (job: LinkJob) => {
    const key = `${job.at}/${job.attempt}`;
    if (linkRan.current === key || !isCurrent(job)) return;
    linkRan.current = key;
    const p = job.link.profile;
    const conn = checkConnection(job.link, connection, refs);
    if (conn.kind === "other")
      return failLink(
        `This link is for ${conn.label}, not the connection signed in now (${hereLabel}). To open it, connect to ${conn.label} in Setup, then open the link again.`,
        onSetUp ? [{ label: "Open Setup", onClick: () => (setLinkError(undefined), guard(onSetUp)) }] : undefined,
      );
    if (conn.kind === "unknown")
      return failLink(
        `This link is for a connection this computer doesn't know, perhaps one from another computer. Links carry no server address or sign-in, so Hermes Chat won't connect anywhere for it. If the chat is on ${hereLabel}, you can open it here.`,
        [{ label: "Open it here", onClick: () => (refs.alias(job.link.connection, connection), retryLink(job)) }],
      );
    if (hermes.getSnapshot().status !== "connected") {
      const next: LinkJob = { ...job, stage: "wait" };
      linkJobRef.current = next;
      return setLinkJob(next);
    }
    const looking: LinkJob = { ...job, stage: "locate" };
    linkJobRef.current = looking;
    setLinkJob(looking);
    // Going anywhere while the lookup runs, to another profile or chat, even back again, is newer than the link, so
    // its answer is dropped.
    const startedAt = navGen.current;
    const startedIn = hermes.profile;
    const movedOn = () => {
      if (navGen.current === startedAt && hermes.profile === startedIn) return false;
      if (isCurrent(job)) closeLinkNotice();
      return true;
    };
    let located: Awaited<ReturnType<typeof locateChat<Found>>>;
    try {
      located = await locateChat<Found>(job.link, hermes);
    } catch (e) {
      if (!isCurrent(job) || movedOn()) return;
      return failLink(`Hermes Chat couldn't look the linked chat up: ${messageOf(e)}`, [{ label: "Try again", onClick: () => retryLink(job) }]);
    }
    if (!isCurrent(job) || movedOn()) return;
    if (located.kind === "no-profile")
      return failLink(`This server has no profile named ${p} now. It may have been renamed or deleted, so the linked chat wasn't opened.`);
    if (located.kind === "no-chat")
      return failLink(`The ${p} profile has no chat with this link's id. It may have been deleted, so there's nothing to open.`);
    const found = located.found;
    if (p === hermes.profile) return openLinked(job, found);
    const snap = hermes.getSnapshot();
    if (leavingNote(snap.profile, snap.chats)) {
      const next: LinkJob = { ...job, stage: "confirm", found };
      linkJobRef.current = next;
      return setLinkJob(next);
    }
    switchForLink(job, found);
  };

  useEffect(() => {
    if (linkJob?.stage === "check") void runLink(linkJob);
    // Hermes connected (or came back) while the link waited.
    else if (linkJob?.stage === "wait" && status === "connected") retryLink(linkJob);
  }, [linkJob, status]);

  // The switch to the linked chat's profile: it opens once that profile's list has been read. The owner going to
  // a third profile meanwhile drops it; still in the first one, the switch may be waiting on an unsaved edit's question.
  useEffect(() => {
    if (linkJob?.stage !== "switch" || !linkJob.found) return;
    // The owner went somewhere while the profile loaded.
    if (linkJob.gen !== undefined && navGen.current !== linkJob.gen) return closeLinkNotice();
    if (profile !== linkJob.link.profile) {
      if (profile !== linkJob.from) closeLinkNotice();
      return;
    }
    if (switching?.error) return failLink(`Hermes Chat switched to ${profile} but couldn't load its chats: ${switching.error}`);
    if (!switching) openLinked(linkJob, linkJob.found);
  }, [linkJob, profile, switching]);

  const linkView: LinkNoticeView | undefined =
    linkError ??
    (linkJob &&
      (linkJob.stage === "confirm" && linkJob.found
        ? {
            kind: "confirm",
            text: `${leavingNote(profile, chats) ?? ""} Switch to ${linkJob.link.profile} to open the linked chat?`.trim(),
            actions: [{ label: `Switch to ${linkJob.link.profile}`, onClick: () => switchForLink(linkJob, linkJob.found!) }],
          }
        : {
            kind: "pending",
            text:
              linkJob.stage === "wait"
                ? `The linked chat opens once Hermes is connected. Nothing is sent.`
                : linkJob.stage === "switch"
                  ? `Switching to ${linkJob.link.profile} to open the linked chat…`
                  : `Opening the linked chat in ${linkJob.link.profile}…`,
          }));
  const closeLinkNotice = () => {
    linkJobRef.current = undefined;
    setLinkJob(undefined);
    setLinkError(undefined);
  };

  /** Copies a link that opens `chat`, in this connection and profile, in Hermes Chat on this computer. */
  const copyChatLink = (chat: Chat) => {
    const url = formatChatLink({ connection: refs.refFor(connection), profile, chatId: chat.id });
    const done = () => setToast({ text: "Chat link copied. It opens this chat in Hermes Chat on this computer.", at: Date.now() });
    const failed = (e?: unknown) => setToast({ text: `Couldn't copy the chat link${e ? `: ${messageOf(e)}` : "."}`, at: Date.now() });
    if (!navigator.clipboard?.writeText) return failed();
    navigator.clipboard.writeText(url).then(done, failed);
  };

  useEffect(() => {
    // Only Ctrl/Cmd chords and Alt+Up/Down, never mid-composition. No bare key does anything app-wide, so nothing
    // typed with focus outside an input can answer an Approval or stop a reply.
    const onKey = (e: KeyboardEvent) => {
      if (covered || composing(e)) return;
      if (screenshotShortcut && shortcutOf(e) === screenshotShortcut && !checkShortcut(screenshotShortcut).error) {
        e.preventDefault();
        if (!e.repeat) takeScreenshot();
        return;
      }
      // Alt+Up/Down: the chat above or below the one showing, in Pinned, the Inbox or Working, as the list orders
      // them. Only while the chat is on screen; a list that uses the same keys (the queue) takes them first, and a
      // select keeps Alt+Down to open.
      const onChat = !covering && !previewCovers && !projectScreenOpen && !searchOpen;
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        if (!onChat || e.defaultPrevented || (e.target as Element | null)?.tagName === "SELECT") return;
        const { pinned, inbox, working } = chatSections(listed, snoozes, Date.now(), attention.since, pins);
        const order = [...pinned, ...inbox, ...working];
        const at = order.findIndex((c) => c.id === active.chatId);
        const next = order[at < 0 ? 0 : at + (e.key === "ArrowDown" ? 1 : -1)];
        if (next) {
          e.preventDefault();
          openChat(next.id);
        }
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setSearchStart(undefined);
        setSearchOpen((o) => !o);
      } else if (k === "n") {
        e.preventDefault();
        newChat();
      } else if (e.key === "Tab" && onChat) {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
      } else if ((e.key === "PageUp" || e.key === "PageDown") && e.shiftKey && !e.altKey && onChat) {
        e.preventDefault();
        shiftTab(e.key === "PageUp" ? -1 : 1);
      } else if (k === "b") {
        e.preventDefault();
        setListOpen((o) => !o);
      } else if (k === ",") {
        e.preventDefault();
        openSettings();
      } else if (e.code === "Backslash" || k === "\\") {
        e.preventDefault();
        toggleSplit();
      } else if ((k === "1" || k === "2") && !e.shiftKey && !e.altKey && split && !settingsOpen && !jobsOpen && !automationsOpen && !outputsOpen && !repoOpen) {
        e.preventDefault();
        focusPane(panes[Number(k) - 1].key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Side by side when the chat keeps its minimum width beside the narrowest pane; otherwise the pane covers the chat.
  // Width 0 means it couldn't be measured, which counts as wide.
  const previewFits = !mainWidth || mainWidth >= CHAT_MIN_WIDTH + PANE_MIN_WIDTH;
  const paneMax = mainWidth ? mainWidth - CHAT_MIN_WIDTH : 1200;
  const paneWidth = Math.min(Math.max(dragWidth ?? previewWidth ?? PREVIEW_DEFAULT_WIDTH, PANE_MIN_WIDTH), Math.max(PANE_MIN_WIDTH, paneMax));
  // Settings covers the chat, and the side panel with it; so do the project screen, Scheduled jobs, Automations, Usage
  // and the Repository screen. Outputs covers the chat panes but keeps the side panel beside it, since its files
  // open there.
  const screenCovering = settingsOpen || projectScreenOpen || jobsOpen || automationsOpen || usageOpen || repoOpen || officeVisible;
  const covering = screenCovering || outputsOpen;
  const previewShown = panelOpen && !screenCovering && (previewFits || !panelHidden);
  const previewCovers = previewShown && !previewFits;

  // `hermes-chat --show`, `--toggle` or a second launch brought the window forward: the cursor goes back in the selected pane's
  // composer, its draft as it was. Settings or another screen over the chat stays as it was left, unsaved edits and all.
  const onSummonedRef = useRef(() => {});
  onSummonedRef.current = () => {
    if (covered || covering || previewCovers || searchOpen) return;
    focusPane(active.key);
  };
  useEffect(() => summon?.onSummoned(() => onSummonedRef.current()), [summon]);


  // Each pane's tab strip above its chat, and the pane as a place to drop a chat dragged from the list or a tab.
  const withTabs = (p: Pane, chatNode: ReactNode, controls: ReactNode) => (
    <>
      <TabStrip
        pane={p.key}
        tabs={p.tabs.map((id) => {
          const c = id === null ? undefined : chats.find((c) => c.id === id);
          return { id, title: c?.title ?? "New chat", running: c?.running, unread: c?.unread };
        })}
        current={p.chatId}
        onPick={(id) => openChat(id, { pane: p.key })}
        onClose={(id) => closeTab(p.key, id)}
        onNew={() => openChat(null, { pane: p.key, fresh: true, newTab: true })}
        preview={(moved, zone, index) => previewMove(moved, { pane: p.key, zone, index })}
        onDropChat={(moved, zone, index) => dropChat(p.key, moved, zone, index)}
        menu={(id) => tabMenu(p, id)}
        lastClosable={split}
        controls={controls}
      />
      <PaneDrop preview={(moved, zone) => previewMove(moved, { pane: p.key, zone })} onDropChat={(moved, zone) => dropChat(p.key, moved, zone)}>
        {chatNode}
      </PaneDrop>
    </>
  );

  const slots: PaneSlot[] = panes.map((p, i) => {
    const listed = p.chatId === null ? undefined : chats.find((c) => c.id === p.chatId);
    const chat = listed ?? draftChat(p.draftError);
    const isActive = p.key === active.key;
    return {
      key: p.key,
      title: chat.title,
      node: withTabs(
        p,
        <ChatView
          openGuide={openGuide}
          hermes={hermes}
          connection={connection}
          profile={profile}
          status={status}
          paneKey={p.key}
          chatId={p.chatId}
          chat={chat}
          started={!!listed}
          picked={p.picked}
          jump={p.jump}
          showSubagent={p.subagent?.chatId === p.chatId ? p.subagent : undefined}
          active={!covered && !covering && !previewCovers && (!split || isActive)}
          split={split}
          screenshots={desk}
          screenshotWiring={screenshots}
          screenshotKeys={screenshotShortcut ? shortcutLabel(screenshotShortcut) : undefined}
          voice={voice}
          catalog={catalog}
          sticky={sticky}
          favorites={modelFavorites}
          projects={projects}
          projectNames={listed ? projectNames(chat.id) : shownProject ? [shownProject.name] : undefined}
          snoozedUntil={snoozedNow(chat.id)}
          shownProject={shownProject && { name: shownProject.name, defaults: proj.defaults[shownProject.id], has: !!listed && !!proj.chats[shownProject.id]?.includes(chat.id) }}
          where={where}
          connectionName={hereLabel}
          repoApi={repoApi}
          scope={scope}
          worktree={p.worktree?.scope === scope ? p.worktree : undefined}
          onDropWorktree={() => patchPane(p.key, { worktree: undefined })}
          onOpenWorktree={(w) => openRepository({ target: w.target, path: w.path, view: "worktrees" })}
          onStarted={(id) => {
            // The chat started from this pane's New chat pane replaces it here, without taking the owner from the
            // other pane if they went there meanwhile.
            if (panesRef.current.find((now) => now.key === p.key)?.view !== p.view) return;
            const stillActive = activeKeyRef.current === p.key;
            patchPane(p.key, { chatId: id, picked: undefined, worktree: undefined });
            setReopening(undefined);
            if (stillActive) rememberChat(id);
          }}
          onDraftError={(reason) => {
            if (panesRef.current.find((now) => now.key === p.key)?.view === p.view) patchPane(p.key, { draftError: reason });
          }}
          onToast={(text) => setToast({ text, at: Date.now() })}
          onMemorySettings={
            hermes.memory
              ? () => {
                  setProjectOpen(false);
                  setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
                  setRepoOpen(false);
                  setOutputsOpen(false);
                  setUsageOpen(false);
                  setShowTextGeneration(undefined);
                  setShowDiagnostics(undefined);
                  setShowVoice(undefined);
                  setShowMemory({});
                  setSettingsOpen(true);
                }
              : undefined
          }
          pin={{ pinned: pins[chat.id] !== undefined, onPin: (on) => pinChat(chat.id, on) }}
          onSettle={(s) => setSettled(chat.id, s)}
          onExport={(text) => setToast({ text, at: Date.now() })}
          onCopyLink={() => copyChatLink(chat)}
          onArchive={(a) => setArchived(chat.id, a)}
          onNew={() => newChat()}
          onDelete={() => deleteChat(chat.id)}
          onOpenChat={(id) => openChat(id, { pane: p.key })}
          onOpenTurn={(id, turn) => {
            if (!chats.some((c) => c.id === id)) return setToast({ text: "That chat isn't in the chat list now.", at: Date.now() });
            guard(() => {
              openChat(id, { pane: p.key, keepSettings: true });
              patchPane(p.key, { jump: { turn, at: Date.now() } });
            });
          }}
          onShowAt={(link) => {
            if (!chats.some((c) => c.id === link.parentId)) return setToast({ text: "That chat isn't in the chat list now.", at: Date.now() });
            // Opened at the message's stored row, the one the branch ends with, whatever its words.
            guard(() => {
              // Already guarded here; Settings can't be open over a pane the owner clicks in.
              openChat(link.parentId, { pane: p.key, keepSettings: true });
              if (link.point.rowId !== undefined) patchPane(p.key, { jump: { rowId: link.point.rowId, at: Date.now() } });
            });
          }}
          previewControls={
            <button className={`icon-btn ${previewShown ? "on" : ""}`} title={!panelOpen ? "Open the side panel" : previewShown ? "Close the side panel" : "Show the side panel"} aria-pressed={previewShown}
              onClick={() => (!panelOpen ? openPanel(panelTab) : previewShown ? setPanelOpen(false) : setPanelHidden(false))}>
              <PanelRight size={16} />
            </button>
          }
        />,
        // Splitting is Ctrl+\, a tab's menu, or dragging a tab to an edge (ADR 0055); a split pane keeps its Close.
        split && (
          <button className="icon-btn" title={`Close the ${paneNames(splitDir)[i].toLowerCase()} pane${isActive ? "" : " (Ctrl+\\)"}`} aria-label={`Close the ${paneNames(splitDir)[i].toLowerCase()} pane`} onClick={() => closePane(p.key)}>
            <X size={16} />
          </button>
        )
      ),
    };
  });

  return (
    <LinksProvider preview={openPreview} web={webPages} onToast={(text) => setToast({ text, at: Date.now() })}>
    <div className="app" inert={covered || restarting}>
      <Rail
        status={status}
        route={route}
        connectionName={connection.name}
        unsecure={unsecure}
        closedReason={closedReason}
        onReconnect={() => void hermes.reconnect()}
        onToggleList={() => setListOpen((o) => !o)}
        onNew={() => newChat()}
        onSearch={() => openSearch()}
        onOutputs={() =>
          guard(() => {
            setSettingsOpen(false);
            setProjectOpen(false);
            setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
            setRepoOpen(false);
            setUsageOpen(false);
            setOutputsOpen((o) => !o);
          })
        }
        outputsOpen={outputsOpen && !settingsOpen && !projectScreenOpen}
        onInbox={() => {
          setBotsOpen(false);
          setOfficeOpen(false);
          setInboxOpen((o) => !o);
        }}
        inboxOpen={inboxOpen}
        inboxCount={inboxCount}
        // Hidden for a Hermes without Bot Mode, once the view that found out has closed.
        onBots={
          caps.caps.botMode.state === "unsupported" && !botsOpen
            ? undefined
            : () => {
                setInboxOpen(false);
                setOfficeOpen(false);
                setBotsOpen((o) => !o);
              }
        }
        botsOpen={botsOpen}
        botsNeedYou={botsNeedYou}
        onOffice={
          agentOffice === "off"
            ? undefined
            : () => {
                setInboxOpen(false);
                setBotsOpen(false);
                // Over Settings, it opens in Settings' place, as the rail's other screens do; otherwise it toggles.
                if (settingsOpen)
                  guard(() => {
                    setSettingsOpen(false);
                    setOfficeOpen(true);
                  });
                else setOfficeOpen((o) => !o);
              }
        }
        officeOpen={officeShown && !settingsOpen}
        onSettings={openSettings}
        settingsOpen={settingsOpen}
        onJobs={() =>
          guard(() => {
            setProjectOpen(false);
            setSettingsOpen(false);
            setOutputsOpen(false);
            setUsageOpen(false);
            setRepoOpen(false);
            setAutomationsOpen(false);
            setJobsAt(undefined);
            setJobsOpen(true);
          })
        }
        jobsOpen={jobsOpen && !settingsOpen}
        onAutomations={() =>
          guard(() => {
            setProjectOpen(false);
            setSettingsOpen(false);
            setOutputsOpen(false);
            setUsageOpen(false);
            setRepoOpen(false);
            setJobsOpen(false);
            setOfficeOpen(false);
            setAutomationsOpen(true);
          })
        }
        automationsOpen={automationsOpen && !settingsOpen}
        onRepo={() =>
          guard(() => {
            setProjectOpen(false);
            setSettingsOpen(false);
            setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
            setOutputsOpen(false);
            setUsageOpen(false);
            setRepoAt(undefined);
            setRepoOpen((o) => !o);
          })
        }
        repoOpen={repoOpen && !settingsOpen && !projectScreenOpen}
        onUsage={() =>
          guard(() => {
            setProjectOpen(false);
            setSettingsOpen(false);
            setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
            setRepoOpen(false);
            setOutputsOpen(false);
            setUsageOpen((o) => !o);
          })
        }
        usageOpen={usageOpen && !settingsOpen && !projectScreenOpen && !jobsOpen && !automationsOpen}
        updateWaiting={updateWaiting}
        connectionsMenu={
          onSwitchConnection && (
            <RailConnections
              connections={saved}
              currentId={connection.id}
              onSwitch={(c) => leaveConnection(c, () => onSwitchConnection(c))}
              onAdd={() => onAddConnection?.()}
              onManage={openConnections}
            />
          )
        }
      />
      {listOpen && (
        <ChatList
          profile={profile}
            projectSwitcher={
              <ProjectSwitcher
                projects={listable}
                selected={shownProject}
                unread={projectUnread}
                loading={proj.loading}
                error={proj.error}
                unsupported={caps.caps.projects.state === "unsupported" ? { onGuide: () => openGuide(guideUrl("projects")) } : undefined}
                connected={status === "connected"}
                onOpen={() => status === "connected" && void projects.load()}
                onSelect={(id) => {
                  projects.select(id);
                  if (!id) setProjectOpen(false);
                }}
                onCreate={async (name) => {
                  await projects.create(name);
                  guard(() => {
                    setSettingsOpen(false);
                    setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
                    setRepoOpen(false);
                    setOutputsOpen(false);
                    setUsageOpen(false);
                    setProjectOpen(true);
                  });
                }}
                onManage={() =>
                  guard(() => {
                    setSettingsOpen(false);
                    setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
                    setRepoOpen(false);
                    setOutputsOpen(false);
                    setUsageOpen(false);
                    setProjectOpen(true);
                    void projects.readDefaults();
                  })
                }
                attention={
                  !membershipNeedsOwner(proj.membership)
                    ? undefined
                    : proj.membership.state === "preview"
                      ? "Hermes can keep which chats are in each project"
                      : "A project change conflicts with another computer's"
                }
                onReview={() => setMembershipOpen(true)}
              />
            }
            savedFilters={
              <SavedFilters filters={tagSnap.filters} onOpen={(f) => openSearch(f)} onDelete={(id) => tagChange(() => tagsStore.deleteFilter(id))} />
            }
            tagsOf={(chatId) => ({
              list: tagSnap.tags,
              of: tagSnap.chats[chatId] ?? [],
              onToggle: (id, on) => tagChange(() => tagsStore.setTag([chatId], id, on)),
              onManage: () => openTags(document.querySelector<HTMLElement>(`.row-open[data-chat="${CSS.escape(chatId)}"]`)),
            })}
            projectsOf={(chatId) => {
              if (!listable.length) return undefined;
              const of = projects.projectsOf(chatId);
              const waiting = new Set(proj.membership.pending.filter((o) => o.chatId === chatId).map((o) => o.projectId));
              return { list: listable, of, waiting, onToggle: (id, on) => setInProject(chatId, listable.find((p) => p.id === id)!, on) };
            }}
          switching={switching}
          status={status}
          others={others}
          chats={listed}
          syncError={syncError}
          selectedId={covering ? null : active.chatId}
          alsoShownId={covering ? null : (other?.chatId ?? null)}
          split={split}
          onOpen={(id) => openChat(id)}
          onOpenIn={openIn}
          onOpenTab={(id) => openChat(id, { newTab: true })}
          onSettle={setSettled}
          snoozes={snoozes}
          attentionSince={attention.since}
          pins={pins}
          onPin={pinChat}
          onSnooze={(id, until) => snoozeChat(id, until)}
          onWake={(id) => snoozeChat(id, undefined)}
          onArchive={setArchived}
          onDelete={deleteChat}
          onRename={(id, title, from) => hermes.rename(id, title, from)}
          onRegenTitle={(id) => hermes.regenerateTitle(id)}
          onCopyLink={copyChatLink}
          onTextGenerationSettings={() => {
            setProjectOpen(false);
            setJobsOpen(false); setAutomationsOpen(false); setOfficeOpen(false);
            setRepoOpen(false);
            setOutputsOpen(false);
            setUsageOpen(false);
            // One destination at a time: an earlier Memory shortcut mustn't switch Settings away from this one.
            setShowMemory(undefined);
            setShowDiagnostics(undefined);
            setShowTextGeneration({});
            setSettingsOpen(true);
          }}
          onListProfiles={() => hermes.profiles()}
          onCheckOthers={() => void hermes.checkOtherProfiles()}
          onSwitchProfile={switchProfile}
          onRetrySwitch={() => void (status === "connected" ? hermes.sync() : hermes.reconnect())}
          profileClone={hermes.profileClone}
          onNew={() => newChat()}
          onSearch={() => openSearch()}
        />
      )}
      {botsOpen && (
        <Bots
          server={where ?? "the server"}
          profile={profile}
          connected={status === "connected"}
          load={loadBots}
          avatar={botAvatar}
          activity={activityOf}
          leaving={leavingNote(profile, chats)}
          onOpen={(b) => openBot(b, "open")}
          onNewChat={(b) => openBot(b, "new")}
          onRefresh={() => void hermes.checkOtherProfiles()}
          onClose={() => setBotsOpen(false)}
        />
      )}
      {inboxOpen && (
        <Inbox
          entries={inboxShown}
          unmatched={inbox.unmatched}
          server={where ?? "the server"}
          profile={profile}
          connected={status === "connected"}
          others={others}
          live={live}
          leaving={leavingNote(profile, chats)}
          onOpen={openEntry}
          onDismiss={(e) => acks.dismiss(e, inbox.entries)}
          onClearDone={(es) => acks.dismissAll(es, inbox.entries)}
          onRefresh={() => void hermes.checkOtherProfiles()}
          onClose={() => setInboxOpen(false)}
          onGuide={() => openGuide(guideUrl("liveSessions"))}
        />
      )}
      <main className="main" ref={mainRef}>
        <div className="main-chat" inert={previewCovers || undefined}>
            {officeVisible && !settingsOpen ? (
              <Office
                rooms={officeRooms({ entries: inbox.entries, shown: (e) => !acks.isDismissed(e, dismissed), chats, profile, connected: status === "connected" })}
                floorMemory={officeFloorMemory}
                view={agentOffice === "list" ? "list" : "building"}
                onView={(view) => setUIPrefs({ agentOffice: view })}
                server={where ?? "the server"}
                profile={profile}
                profiles={Object.keys(others.byName)}
                connected={status === "connected"}
                leaving={leavingNote(profile, chats)}
                onOpen={openDesk}
                onClose={() => {
                  flushSync(() => setOfficeOpen(false));
                  focusPane(active.key);
                }}
              />
            ) : automationsOpen && !settingsOpen ? (
              <CapabilityGate
                store={hermes.capabilities}
                id="automations"
                openGuide={openGuide}
                onDiagnostics={openDiagnostics}
                onClose={() => { flushSync(() => setAutomationsOpen(false)); focusPane(active.key); }}
              >
                <Automations
                  key={profile}
                  api={hermes.automations}
                  profile={profile}
                  connected={status === "connected"}
                  onClose={() => { flushSync(() => setAutomationsOpen(false)); focusPane(active.key); }}
                  onOpenChat={(id) => openChat(id)}
                />
              </CapabilityGate>
            ) : jobsOpen && !settingsOpen ? (
              <CapabilityGate
                store={hermes.capabilities}
                id="scheduledJobs"
                openGuide={openGuide}
                onDiagnostics={openDiagnostics}
                onClose={() => { flushSync(() => setJobsOpen(false)); focusPane(active.key); }}
              >
                <ScheduledJobs
                  key={`${profile}:${jobsAt?.n ?? 0}`}
                  api={hermes.cron}
                  profile={profile}
                  connected={status === "connected"}
                  onClose={() => { flushSync(() => setJobsOpen(false)); focusPane(active.key); }}
                  openJob={jobsAt?.id}
                  troubleshoot={{
                    store: troubleshoots,
                    scope,
                    start: (job, text) => startTroubleshoot(hermes, troubleshoots, scope, profile, job, text, (id) => openChat(id)),
                    openChat: (id) => openChat(id),
                  }}
                />
              </CapabilityGate>
            ) : projectScreenOpen && shownProject && !settingsOpen ? (
              <ProjectScreen
                key={shownProject.id}
                project={shownProject}
                profile={profile}
                connection={where}
                connected={status === "connected"}
                chats={listed.length}
                unlisted={(proj.chats[shownProject.id]?.length ?? 0) - listed.length}
                onRename={(name) => projects.rename(shownProject.id, name)}
                onDelete={async () => {
                  const { name } = shownProject;
                  await projects.delete(shownProject.id);
                  setProjectOpen(false);
                  if (stillIn(profile)) setToast({ text: `Deleted the project ${name}. Its chats and folders are kept.`, at: Date.now() });
                }}
                onAddFolder={(path) => projects.addFolder(shownProject.id, path)}
                onRemoveFolder={(path) => projects.removeFolder(shownProject.id, path)}
                readFolder={async (path) => {
                  const [problem, worktrees] = await Promise.all([
                    hermes.projects.checkFolder(profile, path).then(
                      () => undefined,
                      (e) => messageOf(e),
                    ),
                    hermes.projects.worktrees(path).catch(() => []),
                  ]);
                  return { problem, worktrees };
                }}
                onClose={() => { flushSync(() => setProjectOpen(false)); focusPane(active.key); }}
                membership={
                  <MembershipStatus
                    membership={proj.membership}
                    connected={status === "connected"}
                    onSync={() => void projects.syncNow()}
                    onReview={() => setMembershipOpen(true)}
                  />
                }
                defaults={{
                  saved: proj.defaults[shownProject.id],
                  catalog,
                  profilePick: catalog?.defaultPick,
                  profileEffort: catalog?.defaultEffort,
                  favorites: modelFavorites,
                  onToggleFavorite: toggleModelFavorite,
                  onSave: async (base, draft) => {
                    // Checked now when it can be; every chat start checks it again.
                    if (draft.folder && status === "connected") await hermes.projects.checkFolder(profile, draft.folder);
                    return projects.saveDefaults(shownProject.id, base, draft);
                  },
                }}
              />
            ) : settingsOpen ? (
          <SettingsScreen
            status={status}
            route={route}
            unsecure={unsecure}
            username={connection.username}
            signsInWith={connection.method}
            passwordSaved={kept.password}
            headersSaved={kept.headers}
            headers={route?.kind === "url" ? headers : []}
            profile={profile}
            olderPulled={olderPulled}
            cacheBytes={() => hermes.cacheBytes()}
            appearance={appearance}
            listFonts={systemFonts}
            modelSettings={hermes.modelSettings}
            toolsets={hermes.toolsets}
            mcp={hermes.mcp}
            gateways={hermes.gateways}
            openUrl={(url) => webPages.openInBrowser(url).then(() => undefined)}
            runningReplies={chats.filter((c) => c.running).length}
            openChat={(() => {
              const c = chats.find((x) => x.id === active.chatId);
              return c && { id: c.id, title: c.title, runtimeId: c.runtimeId, running: c.running };
            })()}
            memory={hermes.memory}
            memoryProviders={hermes.memoryProviders}
            onMemoryDirty={onMemoryDirty}
            memoryDiscards={memoryDiscards}
            skills={hermes.skills}
            onSkillDirty={onSkillDirty}
            skillDiscards={skillDiscards}
            checkScreenshots={screenshots.support}
            tray={tray}
            voiceSetup={voice.setup}
            voiceSettings={hermes.voiceSettings}
            onVoiceChange={voice.onChange}
            showVoice={showVoice}
            localStt={localStt}
            transcribe={(audio, mime, side, signal) => localStt.transcribe({ audio, mime, profile: hermes.profile, side, signal })}
            showTextGeneration={showTextGeneration}
            showMemory={showMemory}
            capabilities={hermes.capabilities}
            openGuide={openGuide}
            showDiagnostics={showDiagnostics}
            screen={hermes.screen}
            logs={logs}
            onClearCache={() => hermes.clearCache()}
            importer={{
              imports: hermes.imports,
              profile,
              scope,
              projects: proj.projects,
              shownProject: proj.selectedId,
              // The project store is the one for the profile the chats went to, even if the owner switched since.
              onImported: (to, imported, projectId) => {
                hermes.revealImported(to, imported);
                if (projectId) for (const c of imported) projects.setChat(projectId, c.id, true);
              },
              onOpen: (id) => openChat(id),
            }}
            backup={{
              env: backupEnv,
              connection: connOf(connection),
              profiles: listProfiles,
              profile,
              busy: restoreBusy,
              reload: () => location.reload(),
            }}
            onPullOlder={() => hermes.pullOlderHistory()}
            onSignOut={() =>
              new Promise<void>((done) =>
                guard(
                  () => {
                    // Nothing an artifact held is kept for another sign-in.
                    artifacts.clear();
                    void onSignOut().finally(done);
                  },
                  "signout",
                  done,
                ),
              )
            }
            onSetUp={onSetUp && (() => guard(onSetUp))}
            connectionManager={connectionManager}
            onClose={() =>
              guard(() => {
                flushSync(() => setSettingsOpen(false));
                focusPane(active.key);
              })
            }
            persona={persona}
            onPersonaDirty={onPersonaDirty}
            guard={guard}
            listProfiles={listProfiles}
          />
        ) : usageOpen ? (
          <UsageAnalytics
            key={profile}
            io={usageIo}
            profile={profile}
            listProfiles={listProfiles}
            projects={proj.projects}
            projectChats={proj.chats}
            connected={status === "connected"}
            onOpenChat={(c) =>
              pick({ chatId: c.id, title: c.title, source: toSource(c.source), settled: !c.pinned, archived: c.archived || undefined, updatedAt: c.startedAt, snippet: [] })
            }
            saveCsv={(csv, fileName) => invoke<string | null>("usage_export", { csv, fileName })}
            onClose={() => {
              flushSync(() => setUsageOpen(false));
              focusPane(active.key);
            }}
          />
        ) : outputsOpen ? (
          <CapabilityGate
            store={hermes.capabilities}
            id="outputs"
            openGuide={openGuide}
            onDiagnostics={openDiagnostics}
            onClose={() => {
              flushSync(() => setOutputsOpen(false));
              focusPane(active.key);
            }}
          >
          <OutputsScreen
            snapshot={outSnap}
            outputs={shownOutputs}
            scope={shownOutputsScope}
            scopes={{ chat: outputsChatId ? chats.find((c) => c.id === outputsChatId)?.title : undefined, project: shownProject?.name, profile }}
            unindexed={outSnap.indexing ? 0 : outputsChats.filter((c) => !outSnap.chats[c.id]).length}
            partialChats={outputsChats.filter((c) => outSnap.chats[c.id]?.partial).length}
            chatTitle={(id) => chats.find((c) => c.id === id)?.title}
            status={status}
            canAdd={shownOutputsScope !== "project"}
            onScope={setOutputsScope}
            onRefresh={refreshOutputs}
            onIndexMore={() => void outputsIndex.index(outputsRefs())}
            onAdd={(path) => outputsIndex.add(path, shownOutputsScope === "chat" ? (outputsChatId ?? undefined) : undefined)}
            onRemove={(key) => outputsIndex.remove(key)}
            onRecheck={(o) => void outputsIndex.check([o])}
            // Preview, Edit and the check all read the file the same way: where the tools run (or `host`), naming its chat.
            onPreview={(o) => openPreview({ kind: "server", path: o.path, ...(o.host && { host: true }), ...(sessionOf(o) && { session: sessionOf(o) }) })}
            onEdit={(o) =>
              openPreview({ kind: "artifact", ref: { scope, profile, path: o.path, host: !!o.host, ...(o.chatId && { chatId: o.chatId }), ...(sessionOf(o) && { session: sessionOf(o) }) } })
            }
            unsavedEdit={(o) => isDirty(artSnap.get(artifactKey({ scope, host: !!o.host, path: o.path, session: sessionOf(o) })))}
            onJump={(o) => {
              if (!o.chatId || !o.callId) return;
              if (!chats.some((c) => c.id === o.chatId)) {
                setToast({ text: "That chat isn't in the chat list now.", at: Date.now() });
                return;
              }
              openChat(o.chatId);
              patchPane(active.key, { jump: { callId: o.callId, at: Date.now() } });
            }}
            onShowFolder={(o) => {
              setFilesPath(splitPath(o.path).dir);
              setFilesKey((k) => k + 1);
              openPanel("files");
            }}
            onClose={() => {
              flushSync(() => setOutputsOpen(false));
              focusPane(active.key);
            }}
          />
          </CapabilityGate>
        ) : repoOpen ? (
          <RepositoryScreen
            key={repoAt ? `at-${repoAt.n}` : "repo"}
            api={repoApi}
            initialTarget={repoAt?.target ?? repoTarget(sshAddressOf(connection), localStorage.getItem(REPO_TARGET_KEY), localStorage.getItem(terminalTargetKey(connection)))}
            initialPath={repoAt?.path ?? localStorage.getItem(REPO_PATH_KEY) ?? ""}
            initialView={repoAt?.view}
            worktrees={{
              profile,
              connection: hereLabel,
              chatTitle: (id) => hermes.getSnapshot().chats.find((c) => c.id === id)?.title,
              hermesChatsIn: status === "connected" ? (path) => hermes.chatsWorkingIn(path) : undefined,
              onStartChat:
                status === "connected"
                  ? (w) => {
                      flushSync(() => setRepoOpen(false));
                      openChat(null, { fresh: true, worktree: { ...w, scope } });
                    }
                  : undefined,
            }}
            recent={readRecent(localStorage.getItem(REPO_RECENT_KEY))}
            suggestions={(shownProject?.folders ?? []).map((f) => ({ label: shownProject!.name, path: f.path }))}
            onOpened={rememberRepo}
            onTarget={(t) => localStorage.setItem(REPO_TARGET_KEY, t)}
            suggest={
              status === "connected"
                ? (instructions, input) => hermes.askForEdit({ profile, instructions, input, maxTokens: 400 }).then((r) => r.text)
                : undefined
            }
            suggestScope={scope}
            openUrl={(url) => void webPages.openInBrowser(url).catch(() => undefined)}
            onClose={() => {
              flushSync(() => setRepoOpen(false));
              focusPane(active.key);
            }}
          />
        ) : null}
        <Split panes={slots} dir={splitDir} activeKey={active.key} onActivate={activate} covered={covered || covering || previewCovers || windowHidden} />
        </div>
          {panelMounted && (
            <SidePanel
              tab={panelTab}
              onTab={setPanelTab}
              shown={previewShown}
              overlay={!previewFits}
              compact={(previewFits ? paneWidth : mainWidth || Infinity) < PANEL_COMPACT_WIDTH}
              width={paneWidth}
              maxWidth={paneMax}
              onResize={(w, done) => {
                setDragWidth(done ? null : w);
                if (done) setUIPrefs({ previewWidth: w });
              }}
              onHide={() => setPanelHidden(true)}
              onClose={() => setPanelOpen(false)}
              running={{ terminal: terminalRunning, screen: screenHeld && "(you're in control)" }}
              tabs={{
                // A page or file runs only while it is on screen: a hidden frame could keep playing or loading.
                preview: (shown) =>
                  shown && (
                  <PreviewPane
                    key={previewSeq}
                    target={preview ?? { kind: "start" }}
                    serverLabel={serverLabel(route)}
                    readServer={(path, host, session) => (host ? hermes.readHostFile(path) : hermes.readServerFile(path, session))}
                    local={localFiles}
                    web={webPages}
                    serverPages={serverPages}
                    onOpen={openPreview}
                    artifacts={artifacts}
                    connected={status === "connected"}
                  />
                  ),
                terminal: (shown) => (
                  <Suspense fallback={null}>
                    <TerminalTab
                      server={{
                        api: tauriTerminal,
                        initialTarget: terminalTarget(sshAddressOf(connection), localStorage.getItem(terminalTargetKey(connection))),
                        guessed: terminalTargetGuessed(sshAddressOf(connection), localStorage.getItem(terminalTargetKey(connection))),
                        onTarget: (t) => localStorage.setItem(terminalTargetKey(connection), t),
                      }}
                      local={{ api: tauriLocalTerminal }}
                      shown={shown}
                      kind={termKind}
                      onKind={(k) => setUIPrefs({ terminalKind: k })}
                      onRunning={setTermRunning}
                    />
                  </Suspense>
                ),
                // On a server without the managed-files routes, a note takes the browser's place (ADR 0044).
                files: () => (
                  <CapabilityGate store={hermes.capabilities} id="serverFiles" openGuide={openGuide} onDiagnostics={openDiagnostics}>
                    <FileBrowser key={filesKey} files={hermes.files} status={status} route={route} path={filesPath} onPath={setFilesPath} />
                  </CapabilityGate>
                ),
                // A profile's screen is its own; switching profile starts the tab again.
                screen: (shown) => <ScreenTab key={profile} api={hermes.screen} shown={shown} connected={status === "connected"} onHeld={setScreenHeld} />,
              }}
            />
          )}
      </main>
      {searchOpen && (
        <SearchPalette
          // A new profile gets a new palette: nothing found, previewed or picked in the old one carries over.
          key={`${scope}\n${searchStart?.id ?? "search"}`}
          profile={profile}
          tags={tagSnap}
          initial={searchStart?.filter}
          initialName={searchStart?.name}
          onRun={(f) => runFilter(f, hermes, { exists: tagsStore.exists, of: tagsStore.tagsOf })}
          onPick={pick}
          onClose={() => setSearchOpen(false)}
          onSave={(name, f) => tagsStore.saveFilter(name, f)}
          onBulk={(p) => tagsStore.applyBulk(p)}
          onManageTags={() => openTags()}
          // Ctrl+K closes the palette, and the screenshot shortcut closes it to take one.
          passKey={(e) =>
            ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") || (!!screenshotShortcut && shortcutOf(e.nativeEvent) === screenshotShortcut)
          }
        />
      )}
      {tagsOpen && <TagManager key={scope} store={tagsStore} profile={profile} returnTo={tagsReturn} onClose={() => setTagsOpen(false)} />}
      {membershipOpen && (
        <MembershipDialog
          key={scope}
          membership={proj.membership}
          projects={proj.projects}
          titleOf={(id) => chats.find((c) => c.id === id)?.title}
          connected={status === "connected"}
          onMigrate={() => projects.migrate()}
          onLater={() => projects.postponeMigration()}
          onKeepMine={(id) => projects.keepMine(id)}
          onUseHermes={(id) => projects.useHermes(id)}
          onClose={() => setMembershipOpen(false)}
        />
      )}
      {linkView && <ChatLinkNotice view={linkView} onClose={closeLinkNotice} />}
      {toast && (
        <div className="toast" key={toast.at} role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              Undo
            </button>
          )}
          {toast.action && (
            <button
              onClick={() => {
                toast.action?.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      {(leaving?.edit === "memory" || leaving?.edit === "skill") && (
        <LeaveMemoryEdit
          subject={leaving.edit}
          profile={profile}
          onStay={() => {
            leaving.stay?.();
            setLeaving(undefined);
          }}
          onDiscard={() => {
            setLeaving(undefined);
            if (leaving.edit === "memory") {
              onMemoryDirty(false);
              setMemoryDiscards((n) => n + 1);
            } else {
              onSkillDirty(false);
              setSkillDiscards((n) => n + 1);
            }
            leaving.go();
          }}
        />
      )}
      {leaving?.edit === "artifact" && (leaving.what === "signout" || leaving.what === "close") && (
        <LeaveArtifacts
          names={artifacts.unsaved().map((a) => a.name)}
          what={leaving.what}
          onStay={() => {
            leaving.stay?.();
            setLeaving(undefined);
          }}
          onDiscard={() => {
            setLeaving(undefined);
            artifacts.clear();
            leaving.go();
          }}
        />
      )}
      {leaving?.edit === "persona" && (
        <LeavePersona
          what={leaving.what}
          profile={personaProfile ?? profile}
          kept={personaKept}
          onStay={() => {
            leaving.stay?.();
            setLeaving(undefined);
          }}
          onGo={() => {
            setLeaving(undefined);
            personaDirty.current = false;
            leaving.go();
          }}
        />
      )}
      {connectionAsk && (
        <SwitchConnection
          from={connection}
          to={connectionAsk.to}
          notes={connectionAsk.notes}
          onStay={() => { connectionAsk.stay?.(); setConnectionAsk(undefined); }}
          onGo={() => {
            const { go } = connectionAsk;
            setConnectionAsk(undefined);
            go();
          }}
        />
      )}
      {removeAsk && onRemoveConnection && (
        <RemoveConnection
          c={removeAsk}
          inUse={removeAsk.id === connection.id}
          notes={removeAsk.id === connection.id ? leavingConnection() : []}
          onCancel={() => setRemoveAsk(undefined)}
          onRemove={async () => {
            await onRemoveConnection(removeAsk);
            setRemoveAsk(undefined);
          }}
        />
      )}
      {restarting &&
        // Outside the inert app, so it is announced.
        createPortal(
          <div className="restarting-overlay" role="status">
            Restarting into {update.to}…
          </div>,
          document.body,
        )}
    </div>
    </LinksProvider>
  );
}

/**
 * One pane's chat: its transcript and composer, and the draft kept for it. `chatId` null is the New chat pane; sending
 * there starts a chat (`onStarted`). `started`: the chat is in the list, so it can be settled, archived or exported.
 * `paneKey` tells Hermes which pane has the chat on screen, so a chat shown in both stays read until both leave it.
 */
function ChatView({
  openGuide,
  hermes,
  connection,
  profile,
  status,
  paneKey,
  chatId,
  chat,
  started,
  picked,
  jump,
  showSubagent,
  active,
  split,
  catalog,
  sticky,
  favorites,
  projects,
  projectNames,
  snoozedUntil,
  shownProject,
  where,
  connectionName,
  repoApi,
  scope,
  worktree,
  onDropWorktree,
  onOpenWorktree,
  onStarted,
  onDraftError,
  onToast,
  onMemorySettings,
  pin,
  onSettle,
  onExport,
  onCopyLink,
  onArchive,
  onNew,
  onDelete,
  onOpenChat,
  onShowAt,
  onOpenTurn,
  previewControls,
  screenshots,
  screenshotWiring,
  screenshotKeys,
  voice,
}: {
  hermes: Hermes;
  connection: SavedConnection;
  profile: string;
  status: ConnectionStatus;
  paneKey: string;
  chatId: string | null;
  chat: Chat;
  started: boolean;
  picked?: { found: Found; at: number };
  /** A tool call to go to, from Outputs. */
  jump?: JumpTarget;
  /** A subagent to open in the chat's Subagents panel, from the agent office. */
  showSubagent?: { id: SubagentId; at: number };
  active: boolean;
  split: boolean;
  catalog?: ModelCatalog;
  sticky?: ModelPick;
  favorites: string[];
  projects: ProjectsStore;
  projectNames?: string[];
  /** When the chat wakes, if it is snoozed. */
  snoozedUntil?: number;
  /** The project the list shows, its defaults for new chats, and whether this chat is in it. */
  shownProject?: { name: string; defaults?: ProjectDefaults; has: boolean };
  /** The connection, as a folder on the server is shown beside it. */
  where?: string;
  /** The connection's name, as a worktree's record names who started a chat in it. */
  connectionName: string;
  repoApi: RepoApi;
  /** The connection and profile, as this computer keys what it keeps for each. */
  scope: string;
  /** The worktree this New chat pane starts its chat in (ADR 0043). */
  worktree?: WorktreeStart;
  onDropWorktree: () => void;
  /** Opens the Repository screen's Worktrees view on the worktree a chat works in. */
  onOpenWorktree: (w: WorktreeChat) => void;
  onStarted: (id: string) => void;
  onDraftError: (reason: string) => void;
  /** Opens a page of the compatibility guide in the owner's browser. */
  openGuide: (url: string) => void;
  onToast: (text: string) => void;
  /** Opens Settings → Memory, when this Hermes can edit memory from here. */
  onMemorySettings?: () => void;
  pin: ChatPin;
  onSettle: (settled: boolean) => void;
  onExport: (notice: string) => void;
  onCopyLink: () => void;
  onArchive: (archived: boolean) => void;
  onNew: () => void;
  /** Deletes the chat once the owner has confirmed it; resolves with whether Hermes deleted it. */
  onDelete: () => Promise<boolean>;
  /** Opens another chat in this pane: a branch just made. */
  onOpenChat: (id: string) => void;
  /** Opens the chat a branch came from, at the message it was branched after. */
  onShowAt: (link: BranchLink) => void;
  /** Opens another version of a turn in this pane, at that turn (ADR 0035). */
  onOpenTurn: (chatId: string, turn: number) => void;
  previewControls: ReactNode;
  screenshots?: ScreenshotDesk;
  screenshotWiring: Screenshots;
  screenshotKeys?: string;
  voice: VoiceApi;
}) {
  // What the owner has typed and not sent, kept for each chat on this connection and profile. Two panes on one chat
  // share its draft.
  const draftOf = (id: string | null) => draftKey(connection, profile, id);
  const shownDraft = draftOf(chatId);
  const composerText = useSyncExternalStore(savedDrafts.subscribe, () => savedDrafts.get(shownDraft));
  const stillIn = () => hermes.profile === profile;

  // A new chat takes each value from what the owner chose for it here, then the shown project's defaults, then the
  // profile (projectDefaults.ts). A pick here also stays the composer's Model pick, as before.
  const [chosen, setChosen] = useState<ModelPick>();
  useEffect(() => setChosen(undefined), [chatId, profile]);
  // No default for `project`: an explicit undefined is "no project", never the one this pane last drew.
  const settingsFor = (project: { name: string; defaults?: ProjectDefaults } | undefined) =>
    resolveNewChat({ chosen, chosenFolder: worktree?.path, project, sticky, profilePick: catalog?.defaultPick, profileEffort: catalog?.defaultEffort });
  const startSettings = settingsFor(shownProject);
  const [applying, setApplying] = useState(false);
  useEffect(() => setApplying(false), [chatId]);

  const shownModel = (started && chat.model) || startSettings.model.value;
  // The worktree this chat was started in from this computer, if it was (ADR 0043).
  const inWorktreeKey = useSyncExternalStore(worktreeChats.subscribe, () => JSON.stringify(started ? (worktreeChats.get(scope, chat.id) ?? null) : null));
  const inWorktree = useMemo(() => JSON.parse(inWorktreeKey) as WorktreeChat | null, [inWorktreeKey]);
  const pickModel = (pick: ModelPick) => {
    setUIPrefs({ modelPicker: { ...pick, profile: prefScope(connection, profile) } });
    if (!started) return setChosen(pick);
    hermes.setModel(chat.id, pick).catch((e) => stillIn() && onToast(`Couldn't switch this chat's model: ${messageOf(e)}`));
  };

  const findTarget =
    picked?.found.chatId === chat.id && picked.found.find ? { query: picked.found.find, itemId: hermes.locate(picked.found), at: picked.at } : undefined;

  /** The chat to send in: the one in this pane, or a new one started now for the New chat pane. */
  const chatToSendIn = async (): Promise<{ id: string } | { delivery: Delivery }> => {
    if (chatId) return { id: chatId };
    // The project and its defaults as they are now, not as they were when the pane drew.
    projects.reread();
    const into = projects.getSnapshot().selectedId;
    try {
      const shown = projects.getSnapshot().projects.find((p) => p.id === into);
      const defaults = shown && (await projects.freshDefaults().catch((e) => Promise.reject(new Error(`Couldn't read the project's defaults on this computer: ${messageOf(e)}`))));
      const s = settingsFor(shown && { name: shown.name, defaults: defaults?.[shown.id] });
      const problem = modelProblem(s, catalog);
      if (problem) throw new Error(problem);
      // Hermes would run a chat in a folder it can't list, or quietly in its own; check it is there and allowed first.
      if (s.folder.value) await hermes.projects.checkFolder(profile, s.folder.value);
      // The owner may have switched profile, or another window the project shown, meanwhile: these were that one's.
      if (!stillIn()) throw new Error(`The profile changed to ${hermes.profile} before the chat started. Nothing was sent.`);
      projects.reread();
      if (projects.getSnapshot().selectedId !== into) throw new Error("The project shown changed before the chat started. Nothing was sent.");
      const instructions = s.instructions.value && instructionsMessage(s.project ?? "", s.instructions.value);
      let id: string;
      if (worktree) {
        // Its place in the worktree is held on the server before Hermes starts it, so the worktree can't be removed
        // meanwhile; the chat runs there only if Hermes says it took the folder (newChat). Each wait on the server is
        // a chance for the owner to switch profile: the chat must start in the profile it was written in, or not at all.
        const w = worktree;
        const begin = () => {
          if (!stillIn()) return Promise.reject(new Error(`The profile changed to ${hermes.profile} before the chat started. Nothing was sent.`));
          return hermes.newChat(s.model.value, { folder: s.folder.value, instructions });
        };
        const started = await startInWorktree(repoApi, w, { profile, connection: connectionName }, begin);
        id = started.chatId;
        worktreeChats.set(scope, id, { target: w.target, repo: w.repo, id: w.id, path: w.path, branch: w.branch, token: started.token });
        if (!stillIn())
          throw new Error(`The profile changed to ${hermes.profile} while the chat was starting in ${w.path}. It started empty in the ${profile} profile; your message wasn't sent.`);
        if (started.warning) onToast(started.warning);
      } else id = await hermes.newChat(s.model.value, { folder: s.folder.value, instructions });
      if (into && projects.getSnapshot().projects.some((p) => p.id === into)) projects.setChat(into, id, true);
      if (stillIn()) onStarted(id);
      return { id };
    } catch (e) {
      const reason = `Couldn't start a chat: ${e instanceof Error ? e.message : String(e)}`;
      if (stillIn()) onDraftError(reason);
      return { delivery: { delivery: "unsent", reason } };
    }
  };

  // A failed send stays in its chat's outbox. A failure to start a chat restores the New chat draft.
  const send = async (text: string, attachments: Attachment[], skill?: SkillCall) => {
    const paths = attachments.map((a) => a.path);
    screenshots?.hold(paths);
    const typed = savedDrafts.take(shownDraft);
    // In no outbox until its chat exists: an update's restart meanwhile keeps it as the draft (unsaved.ts).
    const held: Sending = { key: shownDraft, text: typed };
    sending.add(held);
    const to = await chatToSendIn().finally(() => sending.delete(held));
    if (held.captured) {
      // Saved as a draft for the restart, so it doesn't go. Should the restart fail, it is back in the composer.
      const now = savedDrafts.get(held.key);
      savedDrafts.set(held.key, now ? `${now}\n\n${typed}` : typed);
      screenshots?.sent(attachments, false);
      return;
    }
    if ("delivery" in to) {
      savedDrafts.putBack(draftOf(null), typed);
      screenshots?.sent(attachments, false);
      return;
    }
    try {
      await hermes.send(to.id, text, attachments, skill);
    } finally {
      try {
        await screenshotWiring.syncOutbox?.();
        screenshots?.finish(paths);
      } catch {
        // Retain ownership until Rust protects the outbox, as in the single-pane send path.
      }
    }
  };
  // The chat's queue, shared by every pane showing it (ADR 0018). A chat not started yet has none.
  const queue = useSyncExternalStore(hermes.subscribe, () => hermes.getSnapshot().queues[chat.id]);
  const queueApi: QueueApi | undefined = started
    ? {
        add: (text, attachments) => {
          const why = hermes.enqueue(chat.id, text, attachments);
          if (why) return why;
          // The queue keeps its screenshots now, until they go or the owner removes the message (chatCache.ts).
          screenshots?.hold(attachments.map((a) => a.path));
          savedDrafts.set(shownDraft, "");
          return undefined;
        },
        edit: (id, text) => hermes.editQueued(chat.id, id, text),
        remove: (id) => hermes.removeQueued(chat.id, id),
        moveTo: (id, index) => hermes.moveQueued(chat.id, id, index),
        pause: () => hermes.pauseQueue(chat.id),
        resume: () => hermes.resumeQueue(chat.id),
        hold: () => hermes.holdQueue(chat.id),
      }
    : undefined;
  const retry = (itemId: string) => void hermes.retry(chat.id, itemId);
  const edit = (itemId: string) => {
    const row = chat.items.find((i) => i.id === itemId);
    if (row?.kind !== "user") return;
    const typed = savedDrafts.get(shownDraft);
    savedDrafts.set(shownDraft, typed ? `${typed}\n\n${row.text}` : row.text);
    hermes.dismiss(chat.id, itemId);
  };

  const visible = usePaneVisible();

  // Branch from here (ADR 0027): the message the preview is open for, if any.
  const [branchFrom, setBranchFrom] = useState<string>();
  useEffect(() => setBranchFrom(undefined), [chatId, profile]);
  const link = useSyncExternalStore(hermes.subscribe, () => hermes.getSnapshot().branches.links[chat.id]);
  // Edit and Regenerate (ADR 0035): the message the dialog is open for, and the versions of this chat's turns.
  const [replayFrom, setReplayFrom] = useState<{ itemId: string; kind: ReplayKind }>();
  useEffect(() => setReplayFrom(undefined), [chatId, profile]);
  const links = useSyncExternalStore(hermes.subscribe, () => hermes.getSnapshot().branches.links);
  const listedChats = useSyncExternalStore(hermes.subscribe, () => hermes.getSnapshot().chats);
  const variants = useMemo(() => {
    const byTurn = variantsIn(links, chat.id, (id) => listedChats.some((c) => c.id === id));
    // Hermes keeps no model per reply: the original shows what its chat runs on now, when that's known here.
    for (const versions of byTurn.values())
      for (const v of versions) if (v.kind === "original") v.model = listedChats.find((c) => c.id === v.chatId)?.model;
    return byTurn;
  }, [links, listedChats, chat.id]);
  const [finishing, setFinishing] = useState(false);
  const parentListed = useSyncExternalStore(hermes.subscribe, () => !!link && hermes.getSnapshot().chats.some((c) => c.id === link.parentId));

  // Slash commands (commands.ts). Each empties the Draft it was typed in only once it has run, only if the owner hasn't
  // changed it meanwhile, and only while the composer it was typed in is still on the chat (`still`). An answer after
  // that does nothing: its Draft stays as typed. One command at a time per Draft, so two panes on one chat can't run it
  // twice.
  const serverCommands = useServerCommands(hermes, status === "connected", profile);
  const skillCommands = useSkillCommands(hermes, status === "connected", profile);
  const caps = useCapabilities(hermes.capabilities);
  const commands: CommandHost = {
    skills: status === "connected" ? skillCommands.skills : undefined,
    refreshSkills: skillCommands.refresh,
    guide: caps.caps.commands.state === "unsupported" ? () => openGuide(guideUrl("commands")) : undefined,
    why: (def) => {
      if (def.name === "help" || (def.name === "new" && !isBotChat(chat))) return undefined;
      // In a Bot Chat, /new compacts it, which needs the chat open on Hermes and no reply running.
      if (def.name === "new") {
        if (status !== "connected") return "Not connected to Hermes.";
        if (!chat.runtimeId) return "This chat is still loading from Hermes.";
        if (chat.running) return "A Bot Chat is one continuous conversation, so /new compacts it. Wait for the reply to finish.";
        return undefined;
      }
      if (!started) return "This chat hasn't started yet. Send a message first.";
      if (status !== "connected") return "Not connected to Hermes.";
      if (def.name === "delete" && chat.running) return "A chat with a reply running can't be deleted.";
      // A Bot Chat's title is its identity, and it is its bot's one chat (ADR 0066).
      if (def.name === "rename" && isBotChat(chat)) return "A Bot Chat's name is how Hermes finds it, so it can't be renamed.";
      if (def.name === "delete" && isBotChat(chat)) return "A Bot Chat is its bot's one continuous chat, so Hermes Chat doesn't delete it.";
      if (def.scope === "local") return undefined;
      if (serverCommands.state === "loading") return "Checking whether this Hermes has it…";
      if (serverCommands.state === "failed") return `Couldn't check whether this Hermes has it: ${serverCommands.reason}`;
      if (serverCommands.list.replaced.has(def.name))
        return `This Hermes has a quick or plugin command called /${def.name}, which it would run instead, so Hermes Chat doesn't run it.`;
      if (serverCommands.list.unsure.has(def.name))
        return `Hermes couldn't list its quick and plugin commands, so it can't tell whether one would run instead of /${def.name}.`;
      if (!serverCommands.list.listed.has(def.name)) return "This Hermes doesn't list it, so it may not have it. Updating Hermes may add it.";
      if (!chat.runtimeId) return "This chat is still loading from Hermes.";
      if (def.name === "steer" && !chat.running) return "No reply is running to steer. Send it as a message instead.";
      return undefined;
    },
    run: async (def, arg, still) => {
      const key = shownDraft;
      if (commandsRunning.has(key)) throw new Error("A command typed in this chat is still running.");
      commandsRunning.add(key);
      const typed = savedDrafts.get(key);
      const done = () => savedDrafts.get(key) === typed && savedDrafts.set(key, "");
      const here = () => still() && stillIn();
      try {
        if (def.name === "new") {
          // A Bot Chat is one continuous conversation: /new compacts it instead, as in Hermes's desktop (ADR 0066).
          if (isBotChat(chat)) {
            const res = await hermes.compact(chat.id);
            if (here()) done();
            return newInBotChatNote(res);
          }
          done();
          onNew();
          return undefined;
        }
        // The pane gives way at once; the Draft goes only once Hermes has deleted the chat, so a refusal keeps it.
        if (def.name === "delete") {
          if (await onDelete()) done();
          return undefined;
        }
        if (def.name === "rename") {
          try {
            await hermes.rename(chat.id, arg.replace(/\s+/g, " "), chat.title);
          } catch (e) {
            throw e instanceof RenameConflict ? new Error(`This chat was renamed in another Hermes client meanwhile, to "${e.title}". Rename again to replace it.`) : e;
          }
          if (here()) done();
          return undefined;
        }
        // Its answer in the transcript says how it went, Hermes's refusal included, so a refusal keeps the words typed.
        if (def.name === "btw") {
          if ((await hermes.askSideQuestion(chat.id, arg)) && here()) done();
          return undefined;
        }
        const res = await hermes.runCommand(chat.id, def, arg);
        if (!here()) return undefined;
        done();
        if (res.kind === "output") return res.text;
        // Hermes wants the words sent as the chat's next message instead, as for a /steer after the reply ended. It goes
        // straight to the chat, so whatever the owner has typed since stays in the composer; a failure is a Failed message.
        await hermes.send(chat.id, res.message);
        return res.notice;
      } finally {
        commandsRunning.delete(key);
      }
    },
  };

  // A message sent while the reply runs, by the Follow-up behavior setting (ADR 0057): queued (queueApi), or steered
  // into the reply through the same route as a typed /steer, and only when /steer could run now. The Draft empties only
  // once Hermes has taken the words, and only if the owner hasn't changed it meanwhile. If the reply ended, or Hermes
  // couldn't steer it yet, the words go to the end of the queue instead, so they never jump a message queued earlier.
  const followUpMode = useSyncExternalStore(subscribeUIPrefs, getUIPrefs).followUp;
  const followUp: FollowUpHost | undefined = queueApi && {
    mode: followUpMode,
    why: () => commands.why(STEER),
    steer: async (text) => {
      const key = shownDraft;
      const typed = savedDrafts.get(key);
      const done = () => savedDrafts.get(key) === typed && savedDrafts.set(key, "");
      if (await hermes.steer(chat.id, text) === "steered") {
        done();
        return undefined;
      }
      if (!stillIn()) throw new Error(`The profile changed to ${hermes.profile} meanwhile.`);
      const why = hermes.enqueue(chat.id, text);
      if (why) throw new Error(`Hermes couldn't steer the reply just then, and it couldn't be queued: ${why}`);
      done();
      return "Hermes couldn't steer the reply just then, so your message is queued instead.";
    },
  };

  // An opened chat shows its stored history and is marked read; a chat already open on this connection is left as it
  // is. Until connected it shows its Saved copy, and after a reconnect it loads again. Settings covers the panes, so
  // the chats aren't on screen meanwhile.
  useEffect(() => {
    if (!chatId || !visible) return;
    void hermes.open(chatId, paneKey);
    return () => hermes.leave(chatId, paneKey);
  }, [hermes, chatId, status, paneKey, visible, profile]);

  return (
    <>
    <ChatPane
      key={`${profile}/${chat.id}`}
      chat={chat}
      projects={projectNames}
      snoozedUntil={snoozedUntil}
      notice={
        !started && (shownProject || worktree) ? (
          <NewChatSettingsView
            settings={startSettings}
            where={where}
            profile={profile}
            problem={modelProblem(startSettings, catalog)}
            worktree={worktree && { branch: worktree.branch, path: worktree.path, onDrop: onDropWorktree }}
          />
        ) : undefined
      }
      banner={
        started && applying && shownProject?.defaults ? (
          <ApplyDefaults
            project={shownProject.name}
            defaults={shownProject.defaults}
            current={chat.model}
            where={where}
            running={!!chat.running}
            onApply={async ({ model, folder }) => {
              if (model) await hermes.setModel(chat.id, model);
              if (folder) await hermes.setFolder(chat.id, folder);
            }}
            onClose={(applied) => {
              setApplying(false);
              if (applied && stillIn()) onToast(applied);
            }}
          />
        ) : undefined
      }
      onUsage={started ? () => void hermes.refreshUsage(chat.id) : undefined}
      notLoaded={started && status !== "connected" && !chat.runtimeId && chat.items.every(isOutgoing)}
      findTarget={findTarget}
      jumpTo={jump}
      showSubagent={showSubagent}
      onJumpMissed={() =>
        onToast(jump?.rowId !== undefined ? "Couldn't find the message this branch was made from in the chat's history." : "Couldn't find the tool call that made this file in the chat's history.")
      }
      status={status}
      alsoPostsIn={hermes.alsoPostsIn(chat.id)}
      draft={composerText}
      onDraft={(text) => savedDrafts.set(shownDraft, text)}
      onRetry={retry}
      onEdit={edit}
      onDismiss={(itemId) => hermes.dismiss(chat.id, itemId)}
      onAttach={(paths) => hermes.checkAttachments(paths)}
      onSend={send}
      onStop={() => void hermes.stop(chat.id)}
      onAnswer={(approvalId, choice, confirmed) => void hermes.answerApproval(chat.id, approvalId, choice, confirmed)}
      pin={started ? pin : undefined}
      onSettle={started ? onSettle : undefined}
      onExport={started ? onExport : undefined}
      onCopyLink={started ? onCopyLink : undefined}
      onDelete={started ? () => void onDelete() : undefined}
      onArchive={started ? onArchive : undefined}
      active={active}
      visible={visible}
      split={split}
      screenshots={screenshots}
      screenshotKeys={screenshotKeys}
      voice={voice}
      // A Voice conversation's turn goes straight to the chat, as a slash command's message does: what the owner has
      // typed stays in the composer, and a failure is a Failed message (ADR 0041).
      voiceSend={started ? (text) => hermes.sendTracked(chat.id, text) : undefined}
      commands={commands}
      onDismissSideQuestion={(id) => hermes.dismissSideQuestion(chat.id, id)}
      followUp={followUp}
      headActions={
        <>
          {started && inWorktree && (
            <button
              className="chip wt-chip"
              title={`Works in the worktree ${inWorktree.path} on ${inWorktree.target}. Open it in the Repository screen.`}
              aria-label={`Works in the worktree ${inWorktree.path}, on the branch ${inWorktree.branch}. Open it in the Repository screen`}
              onClick={() => onOpenWorktree(inWorktree)}
            >
              <GitBranch size={13} aria-hidden /> <span className="mono">{inWorktree.branch}</span>
            </button>
          )}
          {started && shownProject?.has && shownProject.defaults && (
            <button className={`icon-btn ${applying ? "on" : ""}`} title={`Apply ${shownProject.name}'s defaults to this chat…`} aria-pressed={applying} onClick={() => setApplying((a) => !a)}>
              <FolderCog size={16} />
            </button>
          )}
          {previewControls}
        </>
      }
      queue={queue}
      queueApi={queueApi}
      subagents={
        started
          ? {
              refresh: () => hermes.refreshSubagents(chat.id),
              output: (id) => hermes.subagentOutput(chat.id, id),
              steer: (id, text) => hermes.steerSubagent(chat.id, id, text),
              stop: (id) => hermes.stopSubagent(chat.id, id),
              blocked:
                status !== "connected" || !chat.runtimeId
                  ? "Hermes isn't connected to this chat right now."
                  : hermes.capabilities.get("subagents").state === "unsupported"
                    ? "This Hermes can't steer or stop subagents."
                    : undefined,
            }
          : undefined
      }
      branch={started ? { blocked: branchBlocked(chat, status === "connected"), onBranch: setBranchFrom } : undefined}
      branchedFrom={
        link && (
          <BranchedFrom
            link={link}
            parentListed={parentListed}
            onOpen={() => onShowAt(link)}
            finish={
              link.variant?.pending
                ? {
                    busy: finishing,
                    blocked: replayBlocked(chat, status === "connected"),
                    run: () => {
                      setFinishing(true);
                      hermes.finishReplay(chat.id).then(
                        (warnings) => warnings.length && onToast(warnings.join(" ")),
                        (e) => onToast((e as Error).message),
                      ).finally(() => setFinishing(false));
                    },
                  }
                : undefined
            }
          />
        )
      }
      replay={
        started && chat.source !== "import"
          ? { blocked: replayBlocked(chat, status === "connected"), onReplay: (itemId, kind) => setReplayFrom({ itemId, kind }) }
          : undefined
      }
      variants={variants.size ? { byTurn: variants, onPick: (id, turn) => id !== chat.id && onOpenTurn(id, turn) } : undefined}
      footer={
        <StatusBar
          chat={chat}
          status={status}
          context={{
            inspect: () => hermes.inspectContext(chat.id),
            history: () => hermes.compactionHistory(chat.id),
            compact: () => hermes.compact(chat.id),
            cannotCompact: () => hermes.cannotCompact(),
            openMemory: onMemorySettings,
          }}
        />
      }
      modelControls={
        <ModelControls
          catalog={catalog}
          current={shownModel}
          defaultEffort={catalog?.defaultEffort}
          favorites={favorites}
          onPick={pickModel}
          onToggleFavorite={toggleModelFavorite}
        >
          {started && (
            <ApprovalsPill key={chat.id} approvals={chat.live?.approvals} connected={status === "connected"} profile={profile} onPick={(pick) => hermes.setApprovals(chat.id, pick)} />
          )}
        </ModelControls>
      }
    />
    {replayFrom && (
      <ReplayDialog
        key={`${chat.id}/${replayFrom.itemId}/${replayFrom.kind}`}
        kind={replayFrom.kind}
        api={{ preview: () => hermes.previewReplay(chat.id, replayFrom.itemId, replayFrom.kind), make: (p, words) => hermes.replay(p, words) }}
        onClose={() => setReplayFrom(undefined)}
        done={(id, warnings) => {
          setReplayFrom(undefined);
          if (!stillIn()) return;
          // The new version opens here; this chat, its Draft and its answer stay as they were.
          onOpenChat(id);
          if (warnings.length) onToast(warnings.join(" "));
        }}
      />
    )}
    {branchFrom && (
      <BranchDialog
        key={`${chat.id}/${branchFrom}`}
        api={{ preview: () => hermes.previewBranch(chat.id, branchFrom), make: (p, title) => hermes.branch(p, title) }}
        onClose={() => setBranchFrom(undefined)}
        done={(id, warnings) => {
          setBranchFrom(undefined);
          if (!stillIn()) return;
          // The branch opens here; this chat, and its Draft, stay as they were.
          onOpenChat(id);
          if (warnings.length) onToast(`Branch made. ${warnings.join(" ")}`);
        }}
      />
    )}
    </>
  );
}

/** The Drafts whose slash command is running, by draft key, across both panes. */
const commandsRunning = new Set<string>();

type ServerCommands = { state: "loading" } | { state: "ready"; list: ServerCommandList } | { state: "failed"; reason: string };

/**
 * The skills the composer offers for `profile` (`Hermes.skillCommands`), read once connected and again on `refresh` if
 * they may have changed. Undefined while unknown, or when this Hermes can't run skills from the composer.
 */
function useSkillCommands(hermes: Hermes, connected: boolean, profile: string): { skills?: SkillCommands; refresh: () => void } {
  const [read, setRead] = useState<{ profile: string; skills?: SkillCommands }>();
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const keep = (skills?: SkillCommands) => live && setRead((r) => (r?.profile === profile && r.skills === skills ? r : { profile, skills }));
    hermes.skillCommands().then(keep, () => keep(undefined));
    return () => void (live = false);
  }, [hermes, connected, profile, asked]);
  const refresh = useCallback(() => setAsked((n) => n + 1), []);
  return { skills: read?.profile === profile ? read.skills : undefined, refresh };
}

/** Which of the registry's server commands Hermes lists for `profile`, read once connected (`Hermes.serverCommands`). */
function useServerCommands(hermes: Hermes, connected: boolean, profile: string): ServerCommands {
  const [read, setRead] = useState<{ profile: string; value: ServerCommands }>();
  useEffect(() => {
    if (!connected) return;
    let live = true;
    hermes.serverCommands().then(
      (list) => live && setRead({ profile, value: { state: "ready", list } }),
      (e) => live && setRead({ profile, value: { state: "failed", reason: messageOf(e) } }),
    );
    return () => void (live = false);
  }, [hermes, connected, profile]);
  return read?.profile === profile ? read.value : { state: "loading" };
}
