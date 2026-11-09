// The Settings screen, in twelve tabs. General, ported from the prototype: the connection and Sign out, what shows on
// launch, screenshots, updates, the local cache, older history, importing transcripts, and backups. Appearance: how the app looks on this
// computer (AppearanceSettings.tsx). Model: the profile's models on Hermes (ModelSettings.tsx), and Idle compaction on this computer
// (IdleCompactSettings.tsx). Providers: the profile's model provider API keys on Hermes, listed, added, replaced and removed
// (ProviderSettings.tsx, ADR 0095). Voice: Dictation, Read aloud and voice
// conversations, and the profile's speech providers on Hermes (VoiceProviderSettings.tsx). Toolsets: which tools
// Hermes offers the model in the profile (ToolsetSettings.tsx). Persona: the profile's SOUL.md on Hermes
// (PersonaSettings.tsx). Memory: what Hermes remembers for the profile (MemorySettings.tsx). Skills: the profile's
// skills, switched and edited on Hermes (SkillSettings.tsx). Diagnostics: what the connected Hermes is and what it
// supports (Diagnostics.tsx), and Logs, this app's and the profile's Hermes logs (Logs.tsx, ADR 0087); a tab whose
// feature Hermes lacks says so in its place.
// Profiles are switched in the list's header, not here (ADR 0001). The search box (Ctrl+F) shows the sections of every
// tab whose text holds what was typed (settingsSearch.ts).
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, AudioLines, Brain, Camera, Cpu, Database, Download, HardDrive, KeyRound, Lock, LogOut, MessagesSquare, NotebookPen, Palette, PlugZap, Power, Puzzle, RadioTower, ScrollText, Search, Server, Settings2, ShieldCheck, Sparkles, Stethoscope, Trash2, User, Wrench, X } from "lucide-react";
import type { MemorySource } from "../hermes/memory";
import { SubNav, type SubNavItem } from "./SubNav";
import { SettingRow, SettingsSearching, SettingsSection } from "./SettingRows";
import type { Chat, ConnectionStatus } from "../hermes/model";
import type { Route } from "../hermes/pipe";
import { viaLabel } from "../hermes/routes";
import { TRANSCRIPT_LIMIT_BYTES } from "../hermes/chatCache";
import { STATUS_LABEL, arrowSelect, fmtSize, routeLabel } from "./bits";
import type { AppearanceStore, Fonts } from "./appearance";
import { AppearanceSettings } from "./AppearanceSettings";
import type { ModelSettingsApi } from "../hermes/modelSettings";
import { ModelSettings } from "./ModelSettings";
import { IdleCompactSettings } from "./IdleCompactSettings";
import type { ToolsetsApi } from "../hermes/toolsets";
import { ToolsetSettings, type OpenChat } from "./ToolsetSettings";
import type { MemoryApi } from "../hermes/memory";
import { MemorySettings } from "./MemorySettings";
import type { MemoryProvidersApi } from "../hermes/memoryProviders";
import { MemoryProviderSettings } from "./MemoryProviderSettings";
import type { SkillsApi } from "../hermes/skills";
import { SkillSettings } from "./SkillSettings";
import { PersonaPage, type PersonaDirty, type PersonaWhere } from "./PersonaSettings";
import type { PersonaApi } from "../hermes/persona";
import type { PersonaStore } from "../hermes/personaStore";
import { StartupSettings } from "./StartupSettings";
import { ChatSectionSettings } from "./ChatSectionSettings";
import { InboxSettings } from "./InboxSettings";
import { OfficeSettings } from "./OfficeSettings";
import { FollowUpSettings } from "./FollowUpSettings";
import { VoiceSettings, useVoiceChanges } from "./Voice";
import type { VoiceSetup } from "../hermes/pipe";
import type { VoiceSettingsApi } from "../hermes/voiceSettings";
import { VoiceProviderSettings } from "./VoiceProviderSettings";
import { LocalSttSettings } from "./LocalSttSettings";
import type { LocalSttApi } from "../hermes/localStt";
import type { SttSide, HeardTranscript } from "../hermes/sttRoute";
import { ScreenshotSettings } from "./ScreenshotSettings";
import { TraySettings } from "./TraySettings";
import type { TrayWiring } from "../hermes/tauriTray";
import type { ScreenshotSupport } from "../hermes/tauriScreenshot";
import { UpdateSettings } from "./UpdateSettings";
import { ImportSection, type ImportWiring } from "./ImportTranscripts";
import { BackupSection, type BackupWiring } from "./Backup";
import { guideUrl, type CapabilityId, type CapabilityStore } from "../hermes/capabilities";
import { CapabilityGate, DiagnosticsSettings, type OpenGuide } from "./Diagnostics";
import { LogsPanel, type LogsWiring } from "./Logs";
import type { ScreenApi } from "../hermes/screen";
import { NAMED, applySearch, clearMarks, queryWords, textMatches } from "./settingsSearch";
import { ProfilePicker } from "./ProfilePicker";
import type { McpApi } from "../hermes/mcp";
import { McpSettings } from "./McpSettings";
import type { GatewaysApi } from "../hermes/gateways";
import { GatewaySettings } from "./GatewaySettings";
import { ProviderSettings, type ProviderKeysApi } from "./ProviderSettings";
import { useLocale } from "../i18n/locale";

type Tab = "general" | "appearance" | "model" | "providers" | "voice" | "toolsets" | "mcp" | "gateways" | "persona" | "memory" | "skills" | "diagnostics";
/**
 * General's five groups, shown one at a time beside a sub-nav (ADR 0051); a search shows every group's sections at once.
 * Voice moved to its own tab with the speech providers (ADR 0055), so the third group holds screenshots.
 */
type GenGroup = "connection" | "chats" | "launch" | "screenshots" | "storage";
const GEN_GROUPS: SubNavItem[] = [
  { id: "connection", label: "Connection", icon: <PlugZap size={14} /> },
  { id: "chats", label: "Chats", icon: <MessagesSquare size={14} /> },
  { id: "launch", label: "Launch, tray & updates", icon: <Power size={14} /> },
  { id: "screenshots", label: "Screenshots", icon: <Camera size={14} /> },
  { id: "storage", label: "Storage & data", icon: <HardDrive size={14} /> },
];
/** Diagnostics' two groups (ADR 0087): what the connected Hermes supports, and the logs. */
type DiagGroup = "server" | "logs";
/** What the Memory tab shows beside its list: one of the profile's two memory files, or one profile's external memory. */
type MemSel = { kind: "file"; source: MemorySource } | { kind: "profile"; name: string };
const memKey = (m: MemSel) => (m.kind === "file" ? `file:${m.source}` : `profile:${m.name}`);
const memSelOf = (id: string): MemSel => (id.startsWith("file:") ? { kind: "file", source: id.slice(5) as MemorySource } : { kind: "profile", name: id.slice(8) });
/** Each tab's label is the catalogue's `settings.tabs[id]`. */
const TABS = [
  { id: "general", Icon: Settings2 },
  { id: "appearance", Icon: Palette },
  { id: "model", Icon: Cpu },
  { id: "providers", Icon: KeyRound },
  { id: "voice", Icon: AudioLines },
  { id: "toolsets", Icon: Wrench },
  { id: "mcp", Icon: Server },
  { id: "gateways", Icon: RadioTower },
  { id: "persona", Icon: Sparkles },
  { id: "memory", Icon: Brain },
  { id: "skills", Icon: Puzzle },
  { id: "diagnostics", Icon: Stethoscope },
] as const;

/** The tabs whose sections a search shows in place. */
const SEARCHED: readonly Tab[] = ["general", "appearance", "model", "providers", "voice", "toolsets"];
/**
 * The tabs a search names instead: each edits one thing Hermes keeps (a file, a list of entries), so it's opened to
 * search rather than mounted beside the others with its unsaved edit.
 */
const ABOUT: Partial<Record<Tab, string>> = {
  mcp: "Tools from other programs and services Hermes connects to (MCP servers): add, edit, remove, switch, test and sign in, for each profile.",
  gateways: "Reach Hermes from Telegram or Discord: each profile's bot tokens, on/off switch, allowed users and connection status, kept on the server.",
  persona: "Who Hermes is and how it speaks in this profile's chats: the profile's SOUL.md, edited on the server.",
  memory: "What Hermes remembers about you and your work between chats, changed or removed entry by entry.",
  skills: "Instructions Hermes can load for a kind of task: turn each skill on or off for the profile, and edit its SKILL.md.",
  diagnostics:
    "The connected Hermes's version, protocol and sign-in, which features this server supports, and whether its Bot Desktop has a browser. Logs: this app's own diagnostics and the profile's Hermes logs, followed, filtered, exported, or saved as a support bundle.",
};

/** How the connection signs in, in words, for diagnostics: this app signs in only with the dashboard's username and password. */
export const signInText = (route?: Route) =>
  route?.kind === "ssh"
    ? "Dashboard username and password, through an SSH tunnel"
    : route
      ? "Dashboard username and password, at the dashboard's URL"
      : "Dashboard username and password";

/**
 * Settings → Persona's wiring: the API, where each profile's edits are kept on this computer (`keyOf`), and where it
 * starts: `where.profile` is the profile in use. Persona lists and picks profiles itself (ADR 0056), and copies the shown
 * SOUL.md to another profile (ADR 0057).
 */
export type PersonaWiring = { api: PersonaApi; store: PersonaStore; keyOf: (profile: string) => string; where: PersonaWhere };

const allow = (go: () => void) => go();

/** What a pull added: the older chats in Settled, and any pinned in another Hermes client, which are Active. */
function pulledText(added: Chat[]): string {
  if (!added.length) return "There were no older chats on the server.";
  const active = added.filter((c) => !c.settled).length;
  const settled = added.length - active;
  const chats = (n: number) => `${n} older ${n === 1 ? "chat" : "chats"}`;
  if (!active) return `Added ${chats(settled)} to Settled.`;
  if (!settled) return `Added ${chats(active)} to Active: ${active === 1 ? "it's" : "they're"} pinned in another Hermes client.`;
  return `Added ${chats(settled)} to Settled, and ${active} to Active: ${active === 1 ? "it's" : "they're"} pinned in another Hermes client.`;
}

export function SettingsScreen({
  status,
  route,
  unsecure,
  username,
  signsInWith,
  passwordSaved,
  headers = [],
  headersSaved = true,
  profile,
  olderPulled,
  cacheBytes,
  appearance,
  listFonts,
  checkScreenshots,
  tray,
  modelSettings,
  toolsets,
  mcp,
  gateways,
  providers,
  openUrl = () => {},
  runningReplies = 0,
  openChat,
  memory,
  memoryProviders,
  onMemoryDirty = () => {},
  memoryDiscards = 0,
  skills,
  onSkillDirty = () => {},
  skillDiscards = 0,
  onClearCache,
  onPullOlder,
  onSignOut,
  onSetUp,
  onClose,
  voiceSetup,
  voiceSettings,
  onVoiceChange,
  localStt,
  transcribe,
  showVoice,
  persona,
  onPersonaDirty = () => {},
  guard = allow,
  showTextGeneration,
  importer,
  backup,
  showMemory,
  capabilities,
  openGuide = () => {},
  showDiagnostics,
  screen,
  logs,
  connectionManager,
  listProfiles,
}: {
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  username: string;
  /** `token`: the connection signs in with the dashboard's session token (ADR 0058); absent, with a password. */
  signsInWith?: "token";
  /** The keyring kept the password, or the token, at sign-in. */
  passwordSaved: boolean;
  /** The names of the extra request headers the connection sends; their values are never shown. */
  headers?: string[];
  /** The keyring kept the extra headers at sign-in. */
  headersSaved?: boolean;
  profile: string;
  olderPulled: boolean;
  /** The storage the saved chat lists and Saved copies take now. */
  cacheBytes: () => number;
  appearance: AppearanceStore;
  /** The installed font families, for the font pickers. */
  listFonts: () => Promise<Fonts>;
  /** How screenshots are taken on this desktop; left out where there is no desktop app to ask. */
  checkScreenshots?: () => Promise<ScreenshotSupport>;
  /** The tray icon and Close to tray; left out where there is no desktop app to ask. */
  tray?: TrayWiring;
  /** The profile's model setup on Hermes. */
  modelSettings: ModelSettingsApi;
  /** The profile's toolsets on Hermes; without it there is no Toolsets tab. */
  toolsets?: ToolsetsApi;
  /** Each profile's MCP servers on Hermes (ADR 0068); without it there is no MCP servers tab. */
  mcp?: McpApi;
  /** Each profile's Telegram and Discord gateways on Hermes (ADR 0073); without it there is no Gateways tab. */
  gateways?: GatewaysApi;
  /** The shown profile's provider API keys on Hermes (ADR 0095); without it there is no Providers tab. */
  providers?: ProviderKeysApi;
  /** Opens a page in the browser: an MCP server's OAuth sign-in. */
  openUrl?: (url: string) => Promise<void> | void;
  /** Chats of the shown profile with a reply running now. */
  runningReplies?: number;
  /** The chat in the active pane, for Toolsets' read of what it has. */
  openChat?: OpenChat;
  /** The profile's memory on Hermes; the Memory tab shows only with it. */
  memory?: MemoryApi;
  /** Each profile's external memory provider on Hermes, shown in the Memory tab under the profile's own memory. */
  memoryProviders?: MemoryProvidersApi;
  /** Called with whether the Memory tab has an unsaved edit. */
  onMemoryDirty?: (dirty: boolean) => void;
  /** Changes each time the owner discards the unsaved memory edit from App's question. */
  memoryDiscards?: number;
  /** The profile's skills on Hermes; the Skills tab shows only with it. */
  skills?: SkillsApi;
  /** Called with whether the Skills tab has an unsaved edit. */
  onSkillDirty?: (dirty: boolean) => void;
  /** Changes each time the owner discards the unsaved skill edit from App's question. */
  skillDiscards?: number;
  onClearCache: () => void;
  /** Importing transcripts into the profile shown; without it there is no Import section. */
  importer?: ImportWiring;
  /** Export and restore of what this computer keeps; without it there is no Backup section. */
  backup?: BackupWiring;
  /** Resolves to the older chats added. */
  onPullOlder: () => Promise<Chat[]>;
  onSignOut: () => Promise<void>;
  /** Opens setup again, to change the connection or give Hermes a model provider's key. */
  onSetUp?: () => void;
  onClose: () => void;
  /** The shown profile's voice set-up, for the Voice tab. */
  voiceSetup?: () => Promise<VoiceSetup>;
  /** The profile's speech providers on Hermes, picked and set up in the Voice tab. */
  voiceSettings?: VoiceSettingsApi;
  /** Calls `fn` whenever the voice set-up may have changed on Hermes; returns its unsubscribe. */
  onVoiceChange?: (fn: () => void) => () => void;
  /** Where speech to text runs, and this computer's engine and models (ADR 0065, 0067), in the Voice tab. */
  localStt?: LocalSttApi;
  /** Transcribes a recording the way Dictation does, or on one side alone, for the Voice tab's Test. */
  transcribe?: (audio: Uint8Array, mime: string, side?: SttSide, signal?: AbortSignal) => Promise<HeardTranscript>;
  /** Set, each time anew, to show the Voice tab: from a voice conversation's "Change voice settings". */
  showVoice?: object;
  /** Settings → Persona; the tab is left out without it. */
  persona?: PersonaWiring;
  /** Says whether the Persona tab holds an edit Hermes doesn't have yet. */
  onPersonaDirty?: PersonaDirty;
  /**
   * Every profile on the server (`GET /api/profiles`). With it, Skills and Memory each pick which profile they show, and
   * skills can be copied between profiles (ADR 0057). Persona lists them itself (ADR 0056).
   */
  listProfiles?: () => Promise<string[]>;
  /** Runs `go`, once the owner agrees to leave an unsaved persona, memory or skill edit behind, if there is one. */
  guard?: (go: () => void) => void;
  /** Set, each time anew, to show the Model tab at the Text generation model: from a title that couldn't be regenerated. */
  showTextGeneration?: object;
  /** The saved connections (Connections.tsx `ConnectionManager`), shown first in General. */
  connectionManager?: ReactNode;
  /** Set (to a new object each time) to show the Memory tab. */
  showMemory?: object;
  /** What the connected Hermes supports; without it no tab is held back, and Diagnostics shows only Logs, if anything. */
  capabilities?: CapabilityStore;
  /** Opens a compatibility guide page in the browser. */
  openGuide?: OpenGuide;
  /** Set, each time anew, to show the Diagnostics tab, at a capability if it names one: from a screen's note. */
  showDiagnostics?: { id?: CapabilityId };
  /** The profile's Bot Desktop, for Diagnostics' browser check. */
  screen?: Pick<ScreenApi, "status">;
  /** Diagnostics → Logs (ADR 0033, 0087); without it Diagnostics has no Logs. */
  logs?: LogsWiring;
}) {
  const tabLabels = useLocale().settings.tabs;
  const [bytes, setBytes] = useState(cacheBytes);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState<string>();
  const [pullError, setPullError] = useState<string>();
  const [signingOut, setSigningOut] = useState(false);
  /** What's typed in the search box; Settings shows search results while it holds a word. */
  const [query, setQuery] = useState("");
  // The Memory tab's two parts each say whether they hold an unsaved change; the tab has one while either does.
  const memoryParts = useRef({ entries: false, providers: false });
  const memoryPart = (part: "entries" | "providers") => (dirty: boolean) => {
    memoryParts.current[part] = dirty;
    onMemoryDirty(memoryParts.current.entries || memoryParts.current.providers);
  };
  const onEntriesDirty = useCallback(memoryPart("entries"), [onMemoryDirty]);
  const onProvidersDirty = useCallback(memoryPart("providers"), [onMemoryDirty]);
  const [tab, setTabNow] = useState<Tab>(
    showTextGeneration ? "model" : showMemory && memory ? "memory" : showDiagnostics && capabilities ? "diagnostics" : showVoice ? "voice" : "general",
  );
  const [diagGroup, setDiagGroup] = useState<DiagGroup>("server");
  // The Voice tab's set-up rows read again after a save there (or a Toolsets speech-to-text switch).
  const voiceChanges = useVoiceChanges(onVoiceChange ? { onChange: onVoiceChange } : undefined);
  // A new object each time a note asks for a capability, so the row is focused again even for the same one.
  const [diagFocus, setDiagFocus] = useState<{ id: CapabilityId } | undefined>(showDiagnostics?.id ? { id: showDiagnostics.id } : undefined);
  const [genGroup, setGenGroup] = useState<GenGroup>("connection");
  const [memSel, setMemSel] = useState<MemSel>({ kind: "file", source: "memory" });
  /** Every profile's name, once the Memory tab's provider overview has read them; until then only the shown profile. */
  const [memProfiles, setMemProfiles] = useState<string[]>();
  /** Picking a memory file or profile leaves any unsaved memory edit, so it asks first, as switching tabs does. */
  const pickMem = (id: string) => memKey(memSel) !== id && guard(() => setMemSel(memSelOf(id)));
  // Which profile Skills and Memory each show (ADR 0057): the app's own until the owner picks another, and the app's own
  // again when the app switches profile. Picking one leaves an unsaved edit, so it asks first. Persona picks its own
  // (PersonaPage, ADR 0056).
  const [profiles, setProfiles] = useState<string[]>();
  const [shownIn, setShownIn] = useState({ skills: profile, memory: profile, mcp: profile, gateways: profile, of: profile });
  const tabProfile = shownIn.of === profile ? shownIn : { skills: profile, memory: profile, mcp: profile, gateways: profile, of: profile };
  useEffect(() => setShownIn({ skills: profile, memory: profile, mcp: profile, gateways: profile, of: profile }), [profile]);
  const connected = status === "connected";
  useEffect(() => {
    if (!listProfiles || !connected) return;
    let live = true;
    listProfiles().then(
      (names) => live && setProfiles(names),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [listProfiles, connected]);
  const pickProfile = (which: "skills" | "memory" | "mcp" | "gateways", p: string) =>
    p !== tabProfile[which] && guard(() => setShownIn((cur) => ({ ...(cur.of === profile ? cur : tabProfile), [which]: p })));
  const picker = (which: "skills" | "memory" | "mcp" | "gateways", label: string) =>
    listProfiles && <ProfilePicker value={tabProfile[which]} shown={profile} profiles={profiles} label={label} onPick={(p) => pickProfile(which, p)} />;
  const tabs = TABS.filter(
    (t) =>
      (t.id !== "toolsets" || toolsets) &&
      (t.id !== "mcp" || mcp) &&
      (t.id !== "gateways" || gateways) &&
      (t.id !== "providers" || providers) &&
      (t.id !== "voice" || voiceSetup || voiceSettings || localStt) &&
      (t.id !== "persona" || persona) &&
      (t.id !== "memory" || memory) &&
      (t.id !== "skills" || skills) &&
      (t.id !== "diagnostics" || capabilities || logs),
  ).map((t) => ({ ...t, label: tabLabels[t.id] }));
  // Leaving the Persona, Memory or Skills tab asks first while it holds an unsaved edit.
  const setTab = (t: Tab) => t !== tab && guard(() => setTabNow(t));
  // Asked from elsewhere in the app, these end a search too.
  useEffect(() => {
    if (!showTextGeneration) return;
    setQuery("");
    setTab("model");
  }, [showTextGeneration]);
  useEffect(() => {
    if (!showMemory || !memory) return;
    setQuery("");
    setTab("memory");
  }, [showMemory]);
  useEffect(() => {
    if (!showVoice) return;
    setQuery("");
    setTab("voice");
  }, [showVoice]);
  useEffect(() => {
    if (!showDiagnostics || !capabilities) return;
    setQuery("");
    setDiagFocus(showDiagnostics.id ? { id: showDiagnostics.id } : undefined);
    setDiagGroup("server");
    setTab("diagnostics");
  }, [showDiagnostics]);
  /** A tab's note about a feature Hermes lacks opens Diagnostics at it. */
  const toDiagnostics = (id: CapabilityId) =>
    guard(() => {
      setQuery("");
      setDiagFocus({ id });
      setDiagGroup("server");
      setTabNow("diagnostics");
    });
  /** `body`, unless the connected Hermes lacks capability `id`; then the note saying so, and nothing of `body` runs. */
  const gated = (id: CapabilityId, body: ReactNode) =>
    capabilities ? (
      <CapabilityGate store={capabilities} id={id} openGuide={openGuide} onDiagnostics={toDiagnostics}>
        {body}
      </CapabilityGate>
    ) : (
      body
    );

  const pull = async () => {
    setPulling(true);
    setPullError(undefined);
    try {
      setPulled(pulledText(await onPullOlder()));
    } catch (e) {
      setPullError(`Couldn't pull older history: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPulling(false);
    }
  };

  const searchBox = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const words = queryWords(query);
  const searching = words.length > 0;
  const wordsKey = words.join(" ");
  const [found, setFound] = useState(0);
  // The shown sections follow the text as it changes: a tab reading from Hermes fills in after the search starts.
  useLayoutEffect(() => {
    const root = results.current;
    if (!root || !wordsKey) return;
    const w = wordsKey.split(" ");
    const run = () => {
      setFound(applySearch(root, w));
      // A match inside a <details> fold would be counted but unseen: open them. Settings' own (i) folds open through SettingsSearching.
      for (const d of root.querySelectorAll<HTMLDetailsElement>("details")) d.open = true;
    };
    run();
    const seen = new MutationObserver(run);
    seen.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: NAMED });
    return () => {
      seen.disconnect();
      clearMarks();
    };
  }, [wordsKey]);
  // Ctrl+F finds in Settings; the chat panes it covers aren't active, so theirs doesn't open. A dialog keeps its focus, and a
  // shortcut recorder keeps the keys it takes.
  // Escape ends a search from anywhere in Settings, not only the box: the focus is often on a result by then.
  const searchingRef = useRef(false);
  searchingRef.current = searching;
  const screenRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchBox.current?.focus();
        searchBox.current?.select();
      } else if (e.key === "Escape" && searchingRef.current) {
        const at = document.activeElement;
        if (at && at !== document.body && !screenRef.current?.contains(at)) return;
        e.preventDefault();
        setQuery("");
        searchBox.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  /** Starting a search leaves the tab shown, so it asks first, as switching tabs does, while that tab holds an unsaved edit. */
  const typed = (v: string) => (!searching && queryWords(v).length ? guard(() => setQuery(v)) : setQuery(v));
  /** A tab picked while searching ends the search there. */
  const pick = (t: Tab) => {
    if (!searching) return setTab(t);
    setQuery("");
    setTabNow(t);
  };
  const elsewhere = tabs.filter((t) => ABOUT[t.id] && textMatches(`${t.label} ${ABOUT[t.id]}`, words));

  const generalGroups: Record<GenGroup, ReactNode> = {
    connection: (
      <>
        {connectionManager}
        <SettingsSection title="Connection in use">
          <SettingRow
            name={
              <>
                <span className={`conn-dot ${status} ${unsecure ? "unsecure" : ""}`} /> {STATUS_LABEL[status]}
              </>
            }
            hint={<span className="mono">{routeLabel(route) ?? "No address yet"}</span>}
            control={
              (unsecure || route?.via) && (
                <>
                  {unsecure && <span className="badge warn">Unsecure</span>}
                  {route?.via && (
                    <span className="badge" title={route.via.index > 0 ? "A route earlier in the list didn't answer. It's checked again now and then." : "The first route in the list"}>
                      {viaLabel(route.via)}
                      {route.via.index > 0 ? " (fallback)" : ""}
                    </span>
                  )}
                </>
              )
            }
          />
          <SettingRow
            name={
              signsInWith === "token" ? (
                "Signed in with the dashboard's session token"
              ) : (
                <>
                  Signed in as <span className="mono">{username}</span>
                </>
              )
            }
            about="signing out"
            hint={
              <>
                <KeyRound size={12} aria-hidden />{" "}
                {signsInWith === "token"
                  ? passwordSaved
                    ? "The token is saved in your system keyring. Signing out deletes it from this computer."
                    : "The system keyring couldn't save the token."
                  : passwordSaved
                    ? "The password is saved in your system keyring. Signing out deletes it."
                    : "The system keyring couldn't save the password."}
              </>
            }
            more={
              <>
                {signsInWith === "token" ? (
                  <p>
                    Signing out deletes the saved token from this computer's keyring. The token itself keeps working on the server: to revoke it, replace{" "}
                    <span className="mono">HERMES_DASHBOARD_SESSION_TOKEN</span> on the server.
                  </p>
                ) : (
                  <p>Signing out deletes the saved password from the keyring. You type it again at the next sign-in.</p>
                )}
                {headers.length > 0 && headersSaved && (
                  <p>
                    The extra request headers' values are saved in your system keyring and never shown. They stay saved when you sign out, to change or
                    remove on the sign-in screen.
                  </p>
                )}
              </>
            }
            control={
              <button
                className="btn"
                disabled={signingOut}
                onClick={async () => {
                  setSigningOut(true);
                  // Resolves without signing out when the owner chose to stay with an unsaved persona edit.
                  await onSignOut().finally(() => setSigningOut(false));
                }}
              >
                <LogOut size={14} /> {signingOut ? "Signing out…" : "Sign out"}
              </button>
            }
          >
            {headers.length > 0 && (
              <div className="set-hint">
                <ShieldCheck size={12} aria-hidden /> Sends {headers.length === 1 ? "an extra request header" : `${headers.length} extra request headers`}:{" "}
                {headers.map((h, i) => (
                  <span key={i}>
                    {i > 0 && ", "}
                    <span className="mono">{h}</span>
                  </span>
                ))}
                . {!headersSaved && "Their values are never shown. The system keyring couldn't save them, so you type them again at the next sign-in."}
              </div>
            )}
          </SettingRow>
          {capabilities && (
            <SettingRow
              name="Server details"
              hint="The Hermes version, protocol and sign-in, and which features this server supports."
              control={
                <button
                  className="btn"
                  onClick={() => {
                    // Server details are Diagnostics' Server group, whichever group was shown last.
                    setDiagGroup("server");
                    pick("diagnostics");
                  }}
                >
                  <Stethoscope size={14} aria-hidden /> Connection diagnostics
                </button>
              }
            />
          )}
          {onSetUp && (
            <SettingRow
              name="Setup"
              hint="Change this connection's address or sign-in, or give Hermes a model provider's API key."
              more="The connection stays as it is until the change is tested and saved. To keep it and use another server too, add a connection above."
              control={
                <button className="btn" onClick={onSetUp}>
                  <PlugZap size={14} /> Run setup again
                </button>
              }
            />
          )}
        </SettingsSection>
      </>
    ),
    chats: (
      <>
        <ChatSectionSettings />
        <FollowUpSettings />
        <OfficeSettings />
        <InboxSettings />
      </>
    ),
    launch: (
      <>
        <StartupSettings />
        <TraySettings tray={tray} />
        <UpdateSettings />
      </>
    ),
    screenshots: (
      <>
        <ScreenshotSettings checkSupport={checkScreenshots} />
      </>
    ),
    storage: (
      <>
        <SettingsSection title="Local cache">
          <SettingRow
            name="Chat lists and Saved copies"
            hint="Lets the chat list show at once, and recent chats open while Hermes can't be reached."
            more={
              <p>
                Hermes Chat keeps a copy of each profile's chat list on this computer. It also keeps a Saved copy of the chats you opened most recently,
                up to {fmtSize(TRANSCRIPT_LIMIT_BYTES)}; the oldest copies are deleted first when that fills up. Clearing the cache keeps your display
                settings.
              </p>
            }
            control={
              !confirmClear && (
                <>
                  <span className="set-value">{bytes ? `${fmtSize(bytes)} stored` : "Nothing stored"}</span>
                  <button className="btn" disabled={!bytes} onClick={() => setConfirmClear(true)}>
                    <Trash2 size={14} /> Clear local cache
                  </button>
                </>
              )
            }
          >
            {confirmClear && (
              <div className="confirm set-confirm">
                <span>
                  <Lock size={12} /> Only the chat copies on this computer are deleted; your display settings are kept. Nothing on your Hermes server is
                  touched; the list is saved again at the next refresh, and a chat's Saved copy when you next open it.
                </span>
                <div className="confirm-actions">
                  <button className="btn" onClick={() => setConfirmClear(false)}>
                    Cancel
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => {
                      onClearCache();
                      setBytes(cacheBytes());
                      setConfirmClear(false);
                    }}
                  >
                    Clear {fmtSize(bytes)}
                  </button>
                </div>
              </div>
            )}
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="History">
          <SettingRow
            name="Older chats"
            hint={
              <>
                The list shows the past month. Older <span className="mono">{profile}</span> chats stay on the server until you pull them.
              </>
            }
            control={
              <button className="btn" disabled={pulling || olderPulled || status !== "connected"} onClick={pull}>
                <Download size={14} /> {pulling ? "Pulling…" : olderPulled ? "Up to date" : "Pull older history"}
              </button>
            }
          >
            {(pullError || pulled || olderPulled) && (
              <div className={`small ${pullError ? "sign-in-error" : "muted"}`} role={pullError ? "alert" : undefined}>
                {pullError ?? pulled ?? "All chats are listed, however old."}
              </div>
            )}
          </SettingRow>
        </SettingsSection>
        {importer && <ImportSection wiring={importer} connected={status === "connected"} />}
        {backup && <BackupSection wiring={backup} />}
      </>
    ),
  };
  // A search shows every group's sections together, so what's typed can be found in any of them.
  const general = searching ? (
    <>
      {generalGroups.connection}
      {generalGroups.chats}
      {generalGroups.launch}
      {generalGroups.screenshots}
      {generalGroups.storage}
    </>
  ) : (
    <div className="settings-split">
      <SubNav label="General" items={GEN_GROUPS} selected={genGroup} onPick={(id) => setGenGroup(id as GenGroup)} compact />
      <div className="settings-split-body">{generalGroups[genGroup]}</div>
    </div>
  );

  /** The content of a tab: the same whether it's shown alone or with others in a search. */
  const panel = (id: Tab): ReactNode => {
    switch (id) {
      case "persona":
        return (
          persona &&
          // An edit is for one connection and profile: another profile is another editor. The picker starts again on the
          // profile in use when that or the connection changes.
          gated(
            "persona",
            <PersonaPage
              key={persona.keyOf(persona.where.profile)}
              api={persona.api}
              store={persona.store}
              keyOf={persona.keyOf}
              where={persona.where}
              connected={status === "connected"}
              onDirty={onPersonaDirty}
            />,
          )
        );
      case "memory": {
        if (!memory) return null;
        const items: SubNavItem[] = [
          { id: "file:memory", label: "Agent notes", icon: <NotebookPen size={14} />, under: "Built-in" },
          { id: "file:profile", label: "User profile", icon: <User size={14} /> },
          ...(memoryProviders ? (memProfiles ?? [profile]).map((p, i) => ({ id: `profile:${p}`, label: p, mono: true, icon: <Database size={14} />, under: i === 0 ? "External memory" : undefined })) : []),
        ];
        // Both parts stay mounted whichever is shown, so an unsaved edit in either is kept, and guarded, as before.
        return (
          <div className="settings-split">
            <SubNav label="Memory" items={items} selected={memKey(memSel)} onPick={pickMem} />
            <div className="settings-split-body">
              <div hidden={memSel.kind !== "file"}>
                {gated(
                  "memory",
                  <MemorySettings
                    key={tabProfile.memory}
                    api={memory}
                    profile={tabProfile.memory}
                    status={status}
                    server={routeLabel(route) ?? "not known until connected"}
                    onDirtyChange={onEntriesDirty}
                    discardSignal={memoryDiscards}
                    source={memSel.kind === "file" ? memSel.source : undefined}
                    files={false}
                    picker={picker("memory", "Profile whose memory is shown")}
                  />,
                )}
              </div>
              {memoryProviders && (
                <div hidden={memSel.kind !== "profile"}>
                  <MemoryProviderSettings
                    key={`providers-${profile}`}
                    api={memoryProviders}
                    profile={profile}
                    connected={status === "connected"}
                    onDirtyChange={onProvidersDirty}
                    discardSignal={memoryDiscards}
                    target={memSel.kind === "profile" ? memSel.name : undefined}
                    onProfiles={setMemProfiles}
                    onPick={(p) => pickMem(`profile:${p}`)}
                    overview="folded"
                  />
                </div>
              )}
            </div>
          </div>
        );
      }
      case "skills":
        // An edit lives only while this tab is open, and for one profile; leaving with one asks first.
        return (
          skills &&
          gated(
            "skills",
            <SkillSettings
              key={tabProfile.skills}
              api={skills}
              profile={tabProfile.skills}
              status={status}
              server={routeLabel(route) ?? "not known until connected"}
              onDirtyChange={onSkillDirty}
              discardSignal={skillDiscards}
              picker={picker("skills", "Profile whose skills are shown")}
              profiles={profiles}
            />,
          )
        );
      case "appearance":
        return <AppearanceSettings store={appearance} listFonts={listFonts} />;
      case "model":
        // A draft lives only while this tab is open, and for one profile. Idle compaction is this computer's, and shows
        // whether or not Hermes is reachable.
        return (
          <>
            <ModelSettings key={profile} api={modelSettings} profile={profile} connected={status === "connected"} showTextGeneration={searching ? undefined : showTextGeneration} />
            <IdleCompactSettings />
          </>
        );
      case "providers":
        // Read for one profile and connection; another starts afresh, with nothing typed kept.
        return providers && <ProviderSettings key={profile} hermes={providers} profile={profile} connected={status === "connected"} openModel={() => pick("model")} />;
      case "voice":
        return (
          <>
            <VoiceSettings status={status} profile={profile} setup={voiceSetup} changes={voiceChanges} />
            {localStt && <LocalSttSettings api={localStt} transcribe={transcribe} status={status} setup={voiceSetup} changes={voiceChanges} />}
            {voiceSettings && (
              // Read for one profile and connection; another starts afresh, with nothing typed kept.
              <VoiceProviderSettings key={profile} api={voiceSettings} profile={profile} connected={status === "connected"} />
            )}
          </>
        );
      case "toolsets":
        // Read for one profile; switching profile reads the new one's afresh.
        return (
          toolsets &&
          gated("toolsets", <ToolsetSettings key={profile} api={toolsets} profile={profile} connected={status === "connected"} runningReplies={runningReplies} chat={openChat} onGuide={() => openGuide(guideUrl("toolsetSwitches"))} />)
        );
      case "mcp":
        // Read for one profile; picking another reads it afresh, and a dialog left open goes with it.
        return (
          mcp && (
            <McpSettings
              key={tabProfile.mcp}
              api={mcp}
              profile={tabProfile.mcp}
              connected={status === "connected"}
              picker={picker("mcp", "Profile whose MCP servers are shown")}
              openUrl={openUrl}
            />
          )
        );
      case "gateways":
        // Read for one profile; picking another reads it afresh, and anything typed goes with it.
        return (
          gateways && (
            <GatewaySettings
              key={tabProfile.gateways}
              api={gateways}
              profile={tabProfile.gateways}
              connected={status === "connected"}
              picker={picker("gateways", "Profile whose gateways are shown")}
              openUrl={openUrl}
            />
          )
        );
      case "diagnostics": {
        // Server and Logs, one at a time beside a sub-nav, as General's groups are (ADR 0051, 0087). Logs reads Hermes
        // only while it's shown; what it read goes when another group, tab or profile is shown.
        const group: DiagGroup = !capabilities || (diagGroup === "logs" && logs) ? "logs" : "server";
        const body =
          group === "server" ? (
            capabilities && (
              <DiagnosticsSettings
                store={capabilities}
                connected={status === "connected"}
                server={routeLabel(route)}
                signIn={signInText(route)}
                headers={headers.length}
                unsecure={unsecure}
                profile={profile}
                openGuide={openGuide}
                focus={diagFocus}
                screen={screen}
              />
            )
          ) : (
            logs && <LogsPanel key={profile} {...logs} profile={profile} connected={status === "connected"} />
          );
        if (!capabilities || !logs) return body;
        const items: SubNavItem[] = [
          { id: "server", label: "Server", icon: <Stethoscope size={14} /> },
          { id: "logs", label: "Logs", icon: <ScrollText size={14} /> },
        ];
        return (
          <div className="settings-split">
            <SubNav label="Diagnostics" items={items} selected={group} onPick={(id) => setDiagGroup(id as DiagGroup)} compact />
            <div className="settings-split-body">{body}</div>
          </div>
        );
      }
      case "general":
        return general;
    }
  };
  const shownTab = tabs.some((t) => t.id === tab) ? tab : "general";
  const total = found + elsewhere.length;

  return (
    <SettingsSearching.Provider value={searching}>
    <div className="settings" ref={screenRef}>
      <div className="settings-inner">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <div className="settings-head">
          <h1>Settings</h1>
          <div className="settings-search" role="search">
            <Search size={14} aria-hidden />
            <input
              ref={searchBox}
              type="search"
              aria-label="Search settings"
              placeholder="Search settings"
              value={query}
              onChange={(e) => typed(e.target.value)}
            />
            {query && (
              <button className="icon-btn" aria-label="Clear search" title="Clear search" onClick={() => (setQuery(""), searchBox.current?.focus())}>
                <X size={14} />
              </button>
            )}
          </div>
        </div>
        <div
          className="settings-tabs"
          role="tablist"
          aria-label="Settings"
          // While searching no tab is selected, so the arrows move on from the tab that has the focus.
          onKeyDown={(e) => {
            const ids = tabs.map((t) => t.id);
            const focused = ids.find((id) => (e.target as HTMLElement).id === `settings-tab-${id}`);
            arrowSelect(e, ids, searching && focused ? focused : tab, pick);
          }}
        >
          {tabs.map(({ id, label, Icon }) => {
            const on = !searching && shownTab === id;
            return (
              <button
                key={id}
                id={`settings-tab-${id}`}
                className={`settings-tab ${on ? "on" : ""}`}
                role="tab"
                aria-selected={on}
                tabIndex={on || (searching && id === tabs[0].id) ? 0 : -1}
                aria-controls={searching ? undefined : `settings-panel-${id}`}
                // In a narrow window only the shown tab keeps its label (#154); the others are named here and by a tip.
                aria-label={label}
                title={label}
                onClick={() => pick(id)}
              >
                <Icon size={14} aria-hidden /> <span className="settings-tab-label">{label}</span>
              </button>
            );
          })}
        </div>

        {searching ? (
          <div className="settings-results">
            <p className="muted small settings-search-count" role="status">
              {total ? `${total} ${total === 1 ? "match" : "matches"} for “${query.trim()}”` : `No settings match “${query.trim()}”.`}
            </p>
            <div ref={results}>
            {elsewhere.map(({ id, label, Icon }) => (
              <div key={id} className="settings-row settings-search-elsewhere" data-search-mark>
                <div>
                  <div className="settings-search-tab">
                    <Icon size={13} /> {label}
                  </div>
                  <div className="muted small">{ABOUT[id]}</div>
                </div>
                <button className="btn" onClick={() => pick(id)}>
                  Open {label}
                </button>
              </div>
            ))}
              {tabs
                .filter((t) => SEARCHED.includes(t.id))
                .map(({ id, label, Icon }) => (
                  <div key={id} data-search-group={id} role="group" aria-label={label}>
                    <div className="settings-search-tab">
                      <Icon size={13} /> {label}
                    </div>
                    {panel(id)}
                  </div>
                ))}
            </div>
          </div>
        ) : (
          <div id={`settings-panel-${shownTab}`} role="tabpanel" aria-labelledby={`settings-tab-${shownTab}`}>
            {panel(shownTab)}
          </div>
        )}
      </div>
    </div>
    </SettingsSearching.Provider>
  );
}
