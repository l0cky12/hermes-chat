import { type ReactNode, type RefObject, useCallback, useLayoutEffect, useMemo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal, flushSync } from "react-dom";
import { Columns2, PanelRight, X } from "lucide-react";
import { connect, readSaved, type Delivery, type Hermes } from "./hermes/transport";
import { CHECK_EVERY_MS } from "./hermes/otherProfiles";
import { type Account, type Kept, type SavedSignIn, launchSignIn, savedSignIn, signIn, signInForm, signOutToSignIn } from "./hermes/account";
import { localChatCache } from "./hermes/chatCache";
import { draftKey, drafts } from "./hermes/drafts";
import { PersonaStore, personaKey } from "./hermes/personaStore";
import { sending, type Sending } from "./hermes/unsaved";
import { chatToReopen, forgetOpenChat, rememberOpenChat } from "./hermes/uiPrefs";
import { exportChat } from "./hermes/exportChat";
import { projectLinks, projectScope } from "./hermes/projectLinks";
import { ProjectsStore, type Project } from "./hermes/projects";
import { systemHeaderKeyring, systemKeyring } from "./hermes/tauriKeyring";
import { appUpdates } from "./hermes/tauriUpdates";
import { needsAttention, type Updater } from "./hermes/updates";
import { desktopNotify } from "./hermes/tauriNotify";
import { ScreenshotDesk, type ScreenshotApi } from "./hermes/screenshots";
import { onDesktopScreenshot, screenshotSupport, showWindow, syncScreenshotOutbox, tauriScreenshots, type ScreenshotSupport } from "./hermes/tauriScreenshot";
import { checkShortcut, shortcutLabel, shortcutOf } from "./ui/shortcut";

import { tauriPipe, type SignInDetails } from "./hermes/tauriPipe";
import { isOutgoing, type Attachment, type Chat, type ConnectionStatus, type Found } from "./hermes/model";
import type { ModelCatalog, ModelPick } from "./hermes/models";
import { ChatList, Rail } from "./ui/Sidebar";
import { ChatPane } from "./ui/ChatPane";
import { PANE_NAMES, Split, usePaneVisible, type PaneSlot } from "./ui/Split";
import type { VoiceApi } from "./ui/Voice";
import { SearchPalette } from "./ui/Search";
import { SettingsScreen, type PersonaWiring } from "./ui/Settings";
import { LeavePersona, type LeaveWhat } from "./ui/LeavePersona";
import { tauriCloseGuard, type CloseGuard } from "./ui/tauriWindow";
import { FileBrowser } from "./ui/FileBrowser";
import { composing, routeLabel } from "./ui/bits";
import { ProjectScreen, ProjectSwitcher, type ProjectUnread } from "./ui/Projects";
import { appearanceStore } from "./ui/appearance";
import { StatusBar } from "./ui/StatusBar";
import { systemFonts } from "./ui/tauriFonts";
import { SignIn } from "./ui/SignIn";
import { ModelControls } from "./ui/ModelPicker";
import { PANE_MIN_WIDTH, PreviewPane } from "./ui/PreviewPane";
import { PreviewContext } from "./ui/previewContext";
import { tauriLocalFiles, tauriWebPages, type LocalFiles, type WebPages } from "./ui/tauriPreview";
import type { PreviewTarget } from "./hermes/preview";
import type { Route } from "./hermes/pipe";
import { getUIPrefs, setUIPrefs, subscribe as subscribeUIPrefs, toggleModelFavorite, type StickyModelPick } from "./hermes/uiPrefs";

const SAVED = "hermes-chat.sign-in"; // Everything but the password and extra headers, which are in the system keyring.
// Hermes also announces store changes over the socket; the poll catches anything it misses.
const SYNC_EVERY_MS = 60_000;
const TOAST_MS = 5_000;

/** A short notice above the composer; `undo` puts back what it reports. `at` restarts the timer for a repeat. */
type Toast = { text: string; undo?: () => void; at: number };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const withoutProfile = ({ profile: _profile, ...pick }: StickyModelPick): ModelPick => pick;

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

function loadSignIn(): SavedSignIn {
  const blank = { mode: "ssh" as const, sshTarget: "", url: "", username: "" };
  try {
    return { ...blank, ...JSON.parse(localStorage.getItem(SAVED) ?? "{}") };
  } catch {
    return blank;
  }
}

const account: Account = {
  keyring: systemKeyring,
  headerKeyring: systemHeaderKeyring,
  store: { load: loadSignIn, save: (d) => localStorage.setItem(SAVED, JSON.stringify(d)) },
  connect: (d) => connect(tauriPipe(d), undefined, localChatCache(d), desktopNotify),
  readSaved: (d, reason) => readSaved(tauriPipe(d), reason, localChatCache(d), desktopNotify),
};

const savedDrafts = drafts(localStorage);
const savedProjects = projectLinks(localStorage);
const savedPersona = new PersonaStore(localStorage);
// Applied as the app loads, so the chosen fonts show from the first screen.
const appearance = appearanceStore(localStorage, document.documentElement);

/** The names of the extra request headers a sign-in sends; only a URL sends them. */
const headerNames = (d: SignInDetails) => (d.mode === "url" ? (d.headers ?? []).map((h) => h.name.trim()) : []);

/** What launch ends in: signed in with the saved password, or the sign-in screen and why. */
type Launch = { hermes: Hermes; headers: string[] } | { initial: SignInDetails; error?: string };
let launching: Promise<Launch> | undefined;

/**
 * Signs in with the saved password, if there is one; if Hermes can't be reached, what this computer saved opens to
 * read. If that fails the sign-in screen has it filled in, so Connect tries again. Runs once, though StrictMode runs
 * effects twice.
 */
function launch(): Promise<Launch> {
  return (launching ??= (async () => {
    const saved = await savedSignIn(account);
    if (!saved) return { initial: await signInForm(account) };
    try {
      return { hermes: await launchSignIn(saved, account), headers: headerNames(saved) };
    } catch (e) {
      return { initial: saved, error: messageOf(e) };
    }
  })());
}

export default function App() {
  const [hermes, setHermes] = useState<Hermes | null>(null);
  // The sign-in screen's details; none while launch is signing in with the saved password.
  const [initial, setInitial] = useState<SignInDetails>();
  const [error, setError] = useState<string>();
  // Why the keyring couldn't save the password at sign-in, shown once signed in.
  const [notSaved, setNotSaved] = useState<string>();
  const [kept, setKept] = useState<Kept>({ password: true, headers: true });
  // Only the first sign-in after the app starts reopens the last chat; signing in again after Sign out starts fresh.
  const [coldStart, setColdStart] = useState(true);
  // The names of the extra request headers the connection sends, for Settings.
  const [headers, setHeaders] = useState<string[]>([]);

  useEffect(() => {
    void launch().then((l) => {
      if ("hermes" in l) {
        setHeaders(l.headers);
        return setHermes(l.hermes);
      }
      setInitial(l.initial);
      setError(l.error);
    });
  }, []);

  // Updates: checked once as the app starts, if the owner wants that. Back in the window, a package update waiting to be
  // installed looks again for pacman having installed it, which the owner does in a terminal.
  useEffect(() => {
    if (getUIPrefs().checkUpdatesOnLaunch && appUpdates.getSnapshot().state === "idle") void appUpdates.check();
    const onFocus = () => void appUpdates.check({ installedOnly: true });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (hermes)
    return (
      <Main
        hermes={hermes}
        connection={account.store.load()}
        headers={headers}
        notSaved={notSaved}
        kept={kept}
        reopenLast={coldStart}
        onSignOut={async () => {
          // Everything is read first, then shown at once: the sign-in screen keeps the details it mounts with.
          const { initial, error } = await signOutToSignIn(hermes, account);
          setHermes(null);
          setColdStart(false);
          setNotSaved(undefined);
          setKept({ password: true, headers: true });
          setInitial(initial);
          setError(error);
        }}
      />
    );
  if (!initial)
    return (
      <div className="first-run">
        <div className="first-run-card">
          <div className="rail-brand big">H</div>
          <p className="muted">Signing in…</p>
        </div>
      </div>
    );
  return (
    <SignIn
      initial={initial}
      error={error}
      onSignIn={async (d) => {
        setError(undefined);
        try {
          const { hermes: h, notSaved, kept } = await signIn(d, account);
          setNotSaved(notSaved);
          setKept(kept);
          setHeaders(headerNames(d));
          setHermes(h);
        } catch (e) {
          setError(messageOf(e));
        }
      }}
    />
  );
}

/**
 * One pane of the chat area. `chatId` null: the New chat pane. `draftError`: why the New chat pane couldn't start a
 * chat. `picked`: the search result its chat was opened from; `at` tells one pick from the next.
 */
type Pane = { key: string; chatId: string | null; draftError?: string; picked?: { found: Found; at: number } };

let panesMade = 0;
/** A pane's key, which is also its name to Hermes for what is on screen (transport.ts `open`). */
const newPaneKey = () => `pane-${++panesMade}`;

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
  connection,
  headers = [],
  notSaved,
  kept = { password: true, headers: true },
  reopenLast = false,
  localFiles = tauriLocalFiles,
  webPages = tauriWebPages,
  screenshots = tauriScreenshotWiring,
  personaStore = savedPersona,
  guardClose = tauriCloseGuard,
  onSignOut,
  updates = appUpdates,
}: {
  hermes: Hermes;
  connection: SavedSignIn;
  /** The names of the extra request headers the connection sends. */
  headers?: string[];
  notSaved?: string;
  /** What the keyring kept at sign-in. */
  kept?: Kept;
  /** This is the app starting: open the profile's last open chat, if the owner wants it reopened. */
  reopenLast?: boolean;
  localFiles?: LocalFiles;
  webPages?: WebPages;
  screenshots?: Screenshots;
  /** Where Settings → Persona keeps unsaved edits and replaced versions on this computer. */
  personaStore?: PersonaStore;
  /** Asks before the window closes; registered only while Settings → Persona holds an unsaved edit. */
  guardClose?: CloseGuard;
  onSignOut: () => Promise<void>;
  updates?: Updater;
}) {
  const { profile, chats, olderPulled, archivedListed, status, route, unsecure, closedReason, syncError, others, models, switching } = useSyncExternalStore(
    hermes.subscribe,
    hermes.getSnapshot,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Settings → Persona holds an edit Hermes doesn't have, or a save under way: leaving it asks first.
  const personaDirty = useRef(false);
  const [personaUnsaved, setPersonaUnsaved] = useState(false);
  // This computer could keep the unsaved edit, so leaving doesn't lose it.
  const [personaKept, setPersonaKept] = useState(true);
  const onPersonaDirty = useCallback((dirty: boolean, kept: boolean) => {
    personaDirty.current = dirty;
    setPersonaUnsaved(dirty);
    setPersonaKept(kept);
  }, []);
  const [leaving, setLeaving] = useState<{ what: LeaveWhat; go: () => void; stay?: () => void }>();
  /** Runs `go` now, or once the owner agrees to leave an unsaved persona edit behind. `stay` runs if they don't. */
  const guard = (go: () => void, what: LeaveWhat = "leave", stay?: () => void) => {
    if (!personaDirty.current) return go();
    setLeaving({ what, go, stay });
  };
  const guardRef = useRef(guard);
  guardRef.current = guard;
  // Closing the window asks too, only while there is something to lose.
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
  const voice = useMemo<VoiceApi>(
    () => ({ setup: () => hermes.voiceSetup(), transcribe: (audio, mime) => hermes.transcribe(audio, mime), speak: (text) => hermes.speak(text) }),
    [hermes],
  );
  // The project screen covers the chat pane, as Settings does.
  const [projectOpen, setProjectOpen] = useState(false);
  // Server files covers the chat panes too. The folder open last stays for this sign-in.
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesPath, setFilesPath] = useState<string>();
  const update = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const updateWaiting = needsAttention(update);
  // Drafts were saved for the restart; nothing typed after that would survive it.
  const restarting = update.state === "restarting";
  // The chat to reopen at launch, until Hermes's list shows it is there or gone, or the owner goes somewhere first.
  const [reopening, setReopening] = useState(() => (reopenLast ? chatToReopen(profile) : undefined));
  // One pane, or two side by side. The chat to reopen opens at once when the list saved on this computer has it, so the
  // New chat pane doesn't show first.
  const [panes, setPanes] = useState<Pane[]>(() => [
    { key: newPaneKey(), chatId: reopening && chats.some((c) => c.id === reopening) ? reopening : null },
  ]);
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
  const [searchOpen, setSearchOpen] = useState(false);

  // The model pick is sticky: new chats start on it, in this profile, until the owner picks another. It is kept on this
  // computer only and never becomes the profile's default. Picked in another profile, it gives way to this profile's
  // own model. A chat on screen shows the model it runs on, and a pick there switches that chat alone.
  const { modelPicker, modelFavorites, previewWidth, screenshotShortcut } = useSyncExternalStore(subscribeUIPrefs, getUIPrefs);
  const catalog = models?.profile === profile ? models : undefined;
  const sticky: ModelPick | undefined = modelPicker?.profile === profile ? withoutProfile(modelPicker) : catalog?.defaultPick;

  // What the preview pane beside the chat shows; null when it is closed. `previewHidden`: in a window too narrow for
  // both, the pane covers the chat, and the owner has gone back to the chat without closing it.
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [previewHidden, setPreviewHidden] = useState(false);
  // Counts what has been opened, so opening the same file again loads it again.
  const [previewSeq, setPreviewSeq] = useState(0);
  // The width while the owner drags the pane's edge; it is kept in the display preferences once they let go.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const openPreview = useCallback((t: PreviewTarget) => {
    setPreview(t);
    setPreviewHidden(false);
    setPreviewSeq((n) => n + 1);
  }, []);
  const mainRef = useRef<HTMLElement>(null);
  const mainWidth = useWidth(mainRef);

  // Projects are Hermes's, one store for each connection and profile; which chats are in each is kept on this computer.
  // A project picked in the switcher narrows the list to its chats. Active, Settled and Unread work as before inside it.
  const scope = projectScope(connection, profile);
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
  const listable = proj.projects.filter((p) => !p.archived);
  const shownProject = listable.find((p) => p.id === proj.selectedId);
  const projectScreenOpen = projectOpen && !!shownProject;
  const inShown = shownProject && new Set(proj.chats[shownProject.id] ?? []);
  const listed = inShown ? chats.filter((c) => inShown.has(c.id)) : chats;
  const unreadChats = chats.filter((c) => c.unread && !c.archived);
  const projectUnread: ProjectUnread = {
    all: unreadChats.length,
    hidden: inShown ? unreadChats.filter((c) => !inShown.has(c.id)).length : 0,
    of: (id) => unreadChats.filter((c) => proj.chats[id]?.includes(c.id)).length,
  };
  const projectNames = (chatId: string) => listable.filter((p) => proj.chats[p.id]?.includes(chatId)).map((p) => p.name);
  const where = routeLabel(route) ?? (connection.mode === "ssh" ? `ssh://${connection.sshTarget}` : connection.url) ?? undefined;
  // Settings → Persona edits this connection and profile's SOUL.md; its edits are kept apart per connection and profile.
  const persona: PersonaWiring = {
    api: hermes.persona,
    store: personaStore,
    storeKey: personaKey(connection, profile),
    where: { server: route ? serverLabel(route) : connection.mode === "ssh" ? connection.sshTarget : serverLabel({ kind: "url", url: connection.url, addresses: [] }), route: where, profile },
  };

  const stillIn = (p: string) => hermes.profile === p;

  const patchPane = (key: string, patch: Partial<Pane>) => setPanes((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  // The active pane's chat is the one kept as the profile's last open chat, so it reopens at the next launch.
  const activate = (key: string) => {
    if (key === activeKeyRef.current) return;
    const pane = panes.find((p) => p.key === key);
    if (!pane) return;
    activeKeyRef.current = key;
    setActiveKey(key);
    rememberOpenChat(profile, pane.chatId);
  };

  // Every move between chats is kept as the profile's last open chat, so it reopens at the next launch whether or not
  // the app closes cleanly. Going somewhere also ends the wait to reopen the last one. A chat opens in the active pane
  // unless another is named, and the pane it opens in becomes the active one.
  // `keepSettings`: the move isn't the owner's, so Settings stays on screen.
  const openChat = (id: string | null, { pane = active.key, remember = true, fresh = false, keepSettings = false } = {}) => {
    const go = () => {
      setPreviewHidden(true);
      patchPane(pane, { chatId: id, picked: undefined, ...(fresh && { draftError: undefined }) });
      activeKeyRef.current = pane;
      setActiveKey(pane);
      setReopening(undefined);
      if (!keepSettings) setSettingsOpen(false);
      setProjectOpen(false);
      setFilesOpen(false);
      if (remember) rememberOpenChat(profile, id);
    };
    if (keepSettings) go();
    else guard(go);
  };

  const newChat = (remember = true) => openChat(null, { remember, fresh: true });

  const pick = (found: Found) => guard(() => {
    setPreviewHidden(true);
    hermes.reveal(found);
    patchPane(active.key, { chatId: found.chatId, picked: { found, at: Date.now() } });
    setReopening(undefined);
    rememberOpenChat(profile, found.chatId);
    setSearchOpen(false);
    setSettingsOpen(false);
    setProjectOpen(false);
    setFilesOpen(false);
  });

  // A second pane opens to the right and becomes the active one. Both panes may show the same chat: they are two views
  // of it, with one transcript, one draft and one reply, each scrolled and searched on its own.
  const splitWith = (chatId: string | null) => guard(() => {
    if (split) return;
    setPreviewHidden(true);
    const key = newPaneKey();
    setPanes((ps) => (ps.length > 1 ? ps : [...ps, { key, chatId }]));
    activeKeyRef.current = key;
    setActiveKey(key);
    setReopening(undefined);
    setSettingsOpen(false);
    setProjectOpen(false);
    setFilesOpen(false);
    rememberOpenChat(profile, chatId);
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
      setFilesOpen(false);
      setSearchOpen(false);
      if (!previewFits) setPreviewHidden(true);
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
    setPanes(rest);
    activeKeyRef.current = rest[0].key;
    setActiveKey(rest[0].key);
    rememberOpenChat(profile, rest[0].chatId);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-pane="${CSS.escape(rest[0].key)}"] .composer textarea`)?.focus());
  };

  /** Ctrl+\: splits the chat on screen into a second pane, or closes the pane the owner isn't in. */
  const toggleSplit = () => (other ? closePane(other.key) : splitWith(active.chatId));

  // The panes showing a chat that leaves the list give way to the New chat pane. The active one does as New chat does.
  const clearChat = (id: string) => {
    if (!panes.some((p) => p.chatId === id)) return;
    if (active.chatId === id) openChat(null, { fresh: true, keepSettings: true });
    setPanes((ps) => ps.map((p) => (p.chatId === id ? { ...p, chatId: null, picked: undefined, draftError: undefined } : p)));
  };

  // The other profile's chats replace the list, so one pane stays, on a fresh draft. The profile left keeps its last
  // open chat for the next launch.
  const switchProfile = (name: string) => guard(() => {
    const keep = active.key;
    setPanes([{ key: keep, chatId: null }]);
    activeKeyRef.current = keep;
    setActiveKey(keep);
    setReopening(undefined);
    setSettingsOpen(false);
    setProjectOpen(false);
    setToast(null);
    setPreview(null);
    void hermes.switchProfile(name);
  }, "profile");

  // Undo sends the opposite change, not a stored copy, so it also works once the list has refreshed.
  const setSettled = (id: string, settled: boolean) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    const move = (s: boolean) => void (s ? hermes.settle(id) : hermes.unsettle(id));
    move(settled);
    setToast({ text: `${settled ? "Settled" : "Moved to Active"}: ${title}`, undo: () => move(!settled), at: Date.now() });
  };

  // Putting a chat in a project, or taking it out, is kept on this computer only; Undo puts it back.
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
    void hermes.delete(id).then((deleted) => {
      if (!deleted) return;
      projects.forgetChat(id);
      if (stillIn(profile)) setToast({ text: `Deleted: ${title}`, at: Date.now() });
    });
  };

  // One Save dialog at a time: a second click while it is open does nothing.
  const exporting = useRef(false);
  const exportChatOnScreen = (chat: Chat) => {
    if (exporting.current) return;
    exporting.current = true;
    void exportChat(chat)
      .then((text) => text && setToast({ text, at: Date.now() }))
      .finally(() => (exporting.current = false));
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
      forgetOpenChat(profile, reopening);
    } else return;
    setReopening(undefined);
  }, [hermes, reopening, chats, profile]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
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

  // Switching profile reseeds the pick to that profile's own model, once its list is read.
  useEffect(() => {
    const pick = getUIPrefs().modelPicker;
    if (catalog?.defaultPick && pick?.profile !== profile) setUIPrefs({ modelPicker: { ...catalog.defaultPick, profile } });
  }, [catalog, profile]);

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

  useEffect(() => {
    // Only Ctrl/Cmd chords, and never mid-composition. No bare key does anything app-wide, so nothing typed
    // with focus outside an input can answer an Approval or stop a reply.
    const onKey = (e: KeyboardEvent) => {
      if (composing(e)) return;
      if (screenshotShortcut && shortcutOf(e) === screenshotShortcut && !checkShortcut(screenshotShortcut).error) {
        e.preventDefault();
        if (!e.repeat) takeScreenshot();
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (k === "n") {
        e.preventDefault();
        newChat();
      } else if (k === "b") {
        e.preventDefault();
        setListOpen((o) => !o);
      } else if (e.code === "Backslash" || k === "\\") {
        e.preventDefault();
        toggleSplit();
      } else if ((k === "1" || k === "2") && !e.shiftKey && !e.altKey && split && !settingsOpen && !filesOpen) {
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
  // Settings covers the chat, and the pane with it; so do the project screen and Server files.
  const covering = settingsOpen || projectScreenOpen || filesOpen;
  const previewShown = !!preview && !covering && (previewFits || !previewHidden);
  const previewCovers = previewShown && !previewFits;


  const slots: PaneSlot[] = panes.map((p, i) => {
    const listed = p.chatId === null ? undefined : chats.find((c) => c.id === p.chatId);
    const chat = listed ?? draftChat(p.draftError);
    const isActive = p.key === active.key;
    return {
      key: p.key,
      title: chat.title,
      node: (
        <ChatView
          hermes={hermes}
          connection={connection}
          profile={profile}
          status={status}
          paneKey={p.key}
          chatId={p.chatId}
          chat={chat}
          started={!!listed}
          picked={p.picked}
          active={!covering && !previewCovers && (!split || isActive)}
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
          onStarted={(id) => {
            // The chat started from this pane's New chat pane replaces it here, without taking the owner from the
            // other pane if they went there meanwhile.
            if (panesRef.current.find((now) => now.key === p.key) !== p) return;
            const stillActive = activeKeyRef.current === p.key;
            patchPane(p.key, { chatId: id, picked: undefined });
            setReopening(undefined);
            if (stillActive) rememberOpenChat(profile, id);
          }}
          onDraftError={(reason) => {
            if (panesRef.current.find((now) => now.key === p.key) === p) patchPane(p.key, { draftError: reason });
          }}
          onToast={(text) => setToast({ text, at: Date.now() })}
          onSettle={(s) => setSettled(chat.id, s)}
          onExport={() => exportChatOnScreen(chat)}
          onArchive={(a) => setArchived(chat.id, a)}
          previewControls={
            <button className={`icon-btn ${previewShown ? "on" : ""}`} title={!preview ? "Open the preview" : previewShown ? "Close the preview" : "Show the preview"} aria-pressed={previewShown}
              onClick={() => (!preview ? openPreview({ kind: "start" }) : previewShown ? setPreview(null) : setPreviewHidden(false))}>
              <PanelRight size={16} />
            </button>
          }
          paneControls={
            split ? (
              <button className="icon-btn" title={`Close the ${PANE_NAMES[i].toLowerCase()} pane`} aria-label={`Close the ${PANE_NAMES[i].toLowerCase()} pane`} onClick={() => closePane(p.key)}>
                <X size={16} />
              </button>
            ) : (
              <button className="icon-btn" title="Split: open this chat in a second pane (Ctrl+\)" aria-label="Split into two panes" onClick={() => splitWith(p.chatId)}>
                <Columns2 size={16} />
              </button>
            )
          }
        />
      ),
    };
  });

  return (
    <PreviewContext.Provider value={openPreview}>
    <div className="app" inert={restarting}>
      <Rail
        status={status}
        route={route}
        unsecure={unsecure}
        closedReason={closedReason}
        onReconnect={() => void hermes.reconnect()}
        onToggleList={() => setListOpen((o) => !o)}
        onNew={() => newChat()}
        onSearch={() => setSearchOpen(true)}
        onFiles={() =>
          guard(() => {
            setSettingsOpen(false);
            setProjectOpen(false);
            setFilesOpen((o) => !o);
          })
        }
        filesOpen={filesOpen && !settingsOpen && !projectScreenOpen}
        onSettings={() => { setProjectOpen(false); setFilesOpen(false); setShowTextGeneration(undefined); setSettingsOpen(true); }}
        updateWaiting={updateWaiting}
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
                    setFilesOpen(false);
                    setProjectOpen(true);
                  });
                }}
                onManage={() =>
                  guard(() => {
                    setSettingsOpen(false);
                    setFilesOpen(false);
                    setProjectOpen(true);
                  })
                }
              />
            }
            projectsOf={(chatId) => {
              if (!listable.length) return undefined;
              const of = projects.projectsOf(chatId);
              return { list: listable, of, onToggle: (id, on) => setInProject(chatId, listable.find((p) => p.id === id)!, on) };
            }}
          switching={switching}
          status={status}
          others={others}
          chats={listed}
          archivedListed={archivedListed}
          syncError={syncError}
          selectedId={covering ? null : active.chatId}
          alsoShownId={covering ? null : (other?.chatId ?? null)}
          split={split}
          onOpen={(id) => openChat(id)}
          onOpenIn={openIn}
          onSettle={setSettled}
          onArchive={setArchived}
          onListArchived={(on) => void hermes.listArchived(on)}
          onDelete={deleteChat}
          onRename={(id, title, from) => hermes.rename(id, title, from)}
          onRegenTitle={(id) => hermes.regenerateTitle(id)}
          onTextGenerationSettings={() => {
            setProjectOpen(false);
            setFilesOpen(false);
            setShowTextGeneration({});
            setSettingsOpen(true);
          }}
          onListProfiles={() => hermes.profiles()}
          onCheckOthers={() => void hermes.checkOtherProfiles()}
          onSwitchProfile={switchProfile}
          onRetrySwitch={() => void (status === "connected" ? hermes.sync() : hermes.reconnect())}
        />
      )}
      <main className="main" ref={mainRef}>
        <div className="main-chat" inert={previewCovers || undefined}>
            {projectScreenOpen && shownProject && !settingsOpen ? (
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
              />
            ) : settingsOpen ? (
          <SettingsScreen
            status={status}
            route={route}
            unsecure={unsecure}
            username={connection.username}
            passwordSaved={kept.password}
            headersSaved={kept.headers}
            headers={route?.kind === "url" ? headers : []}
            profile={profile}
            olderPulled={olderPulled}
            cacheBytes={() => hermes.cacheBytes()}
            appearance={appearance}
            listFonts={systemFonts}
            modelSettings={hermes.modelSettings}
            checkScreenshots={screenshots.support}
            voiceSetup={voice.setup}
            showTextGeneration={showTextGeneration}
            onClearCache={() => hermes.clearCache()}
            onPullOlder={() => hermes.pullOlderHistory()}
            onSignOut={() => new Promise<void>((done) => guard(() => void onSignOut().finally(done), "signout", done))}
            onClose={() =>
              guard(() => {
                flushSync(() => setSettingsOpen(false));
                focusPane(active.key);
              })
            }
            persona={persona}
            onPersonaDirty={onPersonaDirty}
            guard={guard}
          />
        ) : filesOpen ? (
          <FileBrowser
            files={hermes.files}
            status={status}
            route={route}
            path={filesPath}
            onPath={setFilesPath}
            onClose={() => {
              flushSync(() => setFilesOpen(false));
              focusPane(active.key);
            }}
          />
        ) : null}
        <Split panes={slots} activeKey={active.key} onActivate={activate} covered={covering || previewCovers} />
        </div>
          {preview && previewShown && (
            <PreviewPane
              key={previewSeq}
              target={preview}
              serverLabel={serverLabel(route)}
              readServer={(path) => hermes.readServerFile(path)}
              local={localFiles}
              web={webPages}
              overlay={!previewFits}
              width={paneWidth}
              maxWidth={paneMax}
              onResize={(w, done) => {
                setDragWidth(done ? null : w);
                if (done) setUIPrefs({ previewWidth: w });
              }}
              onOpen={openPreview}
              onHide={() => setPreviewHidden(true)}
              onClose={() => setPreview(null)}
            />
          )}
      </main>
      {searchOpen && <SearchPalette onSearch={(q, archived) => hermes.search(q, { archived })} onPick={pick} onClose={() => setSearchOpen(false)} />}
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
        </div>
      )}
      {leaving && (
        <LeavePersona
          what={leaving.what}
          profile={profile}
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
      {restarting &&
        // Outside the inert app, so it is announced.
        createPortal(
          <div className="restarting-overlay" role="status">
            Restarting into {update.to}…
          </div>,
          document.body,
        )}
    </div>
    </PreviewContext.Provider>
  );
}

/**
 * One pane's chat: its transcript and composer, and the draft kept for it. `chatId` null is the New chat pane; sending
 * there starts a chat (`onStarted`). `started`: the chat is in the list, so it can be settled, archived or exported.
 * `paneKey` tells Hermes which pane has the chat on screen, so a chat shown in both stays read until both leave it.
 */
function ChatView({
  hermes,
  connection,
  profile,
  status,
  paneKey,
  chatId,
  chat,
  started,
  picked,
  active,
  split,
  catalog,
  sticky,
  favorites,
  projects,
  projectNames,
  onStarted,
  onDraftError,
  onToast,
  onSettle,
  onExport,
  onArchive,
  paneControls,
  previewControls,
  screenshots,
  screenshotWiring,
  screenshotKeys,
  voice,
}: {
  hermes: Hermes;
  connection: SavedSignIn;
  profile: string;
  status: ConnectionStatus;
  paneKey: string;
  chatId: string | null;
  chat: Chat;
  started: boolean;
  picked?: { found: Found; at: number };
  active: boolean;
  split: boolean;
  catalog?: ModelCatalog;
  sticky?: ModelPick;
  favorites: string[];
  projects: ProjectsStore;
  projectNames?: string[];
  onStarted: (id: string) => void;
  onDraftError: (reason: string) => void;
  onToast: (text: string) => void;
  onSettle: (settled: boolean) => void;
  onExport: () => void;
  onArchive: (archived: boolean) => void;
  paneControls: ReactNode;
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

  const shownModel = (started && chat.model) || sticky;
  const pickModel = (pick: ModelPick) => {
    setUIPrefs({ modelPicker: { ...pick, profile } });
    if (!started) return;
    hermes.setModel(chat.id, pick).catch((e) => stillIn() && onToast(`Couldn't switch this chat's model: ${messageOf(e)}`));
  };

  const findTarget =
    picked?.found.chatId === chat.id && picked.found.find ? { query: picked.found.find, itemId: hermes.locate(picked.found), at: picked.at } : undefined;

  /** The chat to send in: the one in this pane, or a new one started now for the New chat pane. */
  const chatToSendIn = async (): Promise<{ id: string } | { delivery: Delivery }> => {
    if (chatId) return { id: chatId };
    const into = projects.getSnapshot().selectedId;
    try {
      const id = await hermes.newChat(sticky);
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
  const send = async (text: string, attachments: Attachment[]) => {
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
      await hermes.send(to.id, text, attachments);
    } finally {
      try {
        await screenshotWiring.syncOutbox?.();
        screenshots?.finish(paths);
      } catch {
        // Retain ownership until Rust protects the outbox, as in the single-pane send path.
      }
    }
  };
  const retry = (itemId: string) => void hermes.retry(chat.id, itemId);
  const edit = (itemId: string) => {
    const row = chat.items.find((i) => i.id === itemId);
    if (row?.kind !== "user") return;
    const typed = savedDrafts.get(shownDraft);
    savedDrafts.set(shownDraft, typed ? `${typed}\n\n${row.text}` : row.text);
    hermes.dismiss(chat.id, itemId);
  };

  const visible = usePaneVisible();

  // An opened chat shows its stored history and is marked read; a chat already open on this connection is left as it
  // is. Until connected it shows its Saved copy, and after a reconnect it loads again. Settings covers the panes, so
  // the chats aren't on screen meanwhile.
  useEffect(() => {
    if (!chatId || !visible) return;
    void hermes.open(chatId, paneKey);
    return () => hermes.leave(chatId, paneKey);
  }, [hermes, chatId, status, paneKey, visible, profile]);

  return (
    <ChatPane
      key={`${profile}/${chat.id}`}
      chat={chat}
      projects={projectNames}
      onUsage={started ? () => void hermes.refreshUsage(chat.id) : undefined}
      notLoaded={started && status !== "connected" && !chat.runtimeId && chat.items.every(isOutgoing)}
      findTarget={findTarget}
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
      onSettle={started ? onSettle : undefined}
      onExport={started ? onExport : undefined}
      onArchive={started ? onArchive : undefined}
      active={active}
      visible={visible}
      split={split}
      screenshots={screenshots}
      screenshotKeys={screenshotKeys}
      voice={voice}
      paneControls={paneControls}
      headActions={previewControls}
      footer={<StatusBar chat={chat} status={status} onYolo={(on) => hermes.setYolo(chat.id, on)} onBreakdown={() => hermes.contextBreakdown(chat.id)} />}
      modelControls={
        <ModelControls
          catalog={catalog}
          current={shownModel}
          defaultEffort={catalog?.defaultEffort}
          favorites={favorites}
          onPick={pickModel}
          onToggleFavorite={toggleModelFavorite}
        />
      }
    />
  );
}
