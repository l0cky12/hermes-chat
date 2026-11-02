// The Settings screen, in three tabs. General, ported from the prototype: the connection and Sign out, what shows on
// launch, voice, screenshots, updates, the local cache, and older history. Appearance: how the app looks on this
// computer (AppearanceSettings.tsx). Model: the profile's models on Hermes (ModelSettings.tsx).
// Profiles are switched in the list's header, not here (ADR 0001).
import { useEffect, useState } from "react";
import { ArrowLeft, Cpu, Download, KeyRound, Lock, LogOut, Palette, Settings2, ShieldCheck, Trash2 } from "lucide-react";
import type { Chat, ConnectionStatus } from "../hermes/model";
import type { Route } from "../hermes/pipe";
import { TRANSCRIPT_LIMIT_BYTES } from "../hermes/chatCache";
import { STATUS_LABEL, arrowSelect, fmtSize, routeLabel } from "./bits";
import type { AppearanceStore, Fonts } from "./appearance";
import { AppearanceSettings } from "./AppearanceSettings";
import type { ModelSettingsApi } from "../hermes/modelSettings";
import { ModelSettings } from "./ModelSettings";
import { StartupSettings } from "./StartupSettings";
import { VoiceSettings } from "./Voice";
import type { VoiceSetup } from "../hermes/pipe";
import { ScreenshotSettings } from "./ScreenshotSettings";
import type { ScreenshotSupport } from "../hermes/tauriScreenshot";
import { UpdateSettings } from "./UpdateSettings";

type Tab = "general" | "appearance" | "model";
const TABS = [
  { id: "general", label: "General", Icon: Settings2 },
  { id: "appearance", label: "Appearance", Icon: Palette },
  { id: "model", label: "Model", Icon: Cpu },
] as const;

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
  passwordSaved,
  headers = [],
  headersSaved = true,
  profile,
  olderPulled,
  cacheBytes,
  appearance,
  listFonts,
  checkScreenshots,
  modelSettings,
  onClearCache,
  onPullOlder,
  onSignOut,
  onClose,
  voiceSetup,
  showTextGeneration,
}: {
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  username: string;
  /** The keyring kept the password at sign-in. */
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
  /** The profile's model setup on Hermes. */
  modelSettings: ModelSettingsApi;
  onClearCache: () => void;
  /** Resolves to the older chats added. */
  onPullOlder: () => Promise<Chat[]>;
  onSignOut: () => Promise<void>;
  onClose: () => void;
  /** The shown profile's voice set-up, for the Voice section. */
  voiceSetup?: () => Promise<VoiceSetup>;
  /** Set, each time anew, to show the Model tab at the Text generation model: from a title that couldn't be regenerated. */
  showTextGeneration?: object;
}) {
  const [bytes, setBytes] = useState(cacheBytes);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState<string>();
  const [pullError, setPullError] = useState<string>();
  const [signingOut, setSigningOut] = useState(false);
  const [tab, setTab] = useState<Tab>(showTextGeneration ? "model" : "general");
  useEffect(() => {
    if (showTextGeneration) setTab("model");
  }, [showTextGeneration]);

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

  return (
    <div className="settings">
      <div className="settings-inner">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <h1>Settings</h1>
        <div
          className="settings-tabs"
          role="tablist"
          aria-label="Settings"
          onKeyDown={(e) => arrowSelect(e, TABS.map((t) => t.id), tab, setTab)}
        >
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              id={`settings-tab-${id}`}
              className={`settings-tab ${tab === id ? "on" : ""}`}
              role="tab"
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              aria-controls={`settings-panel-${id}`}
              onClick={() => setTab(id)}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {tab === "appearance" ? (
          <div id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance">
            <AppearanceSettings store={appearance} listFonts={listFonts} />
          </div>
        ) : tab === "model" ? (
          <div id="settings-panel-model" role="tabpanel" aria-labelledby="settings-tab-model">
            {/* A draft lives only while this tab is open, and for one profile. */}
            <ModelSettings key={profile} api={modelSettings} profile={profile} connected={status === "connected"} showTextGeneration={showTextGeneration} />
          </div>
        ) : (
          <div id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general">
            <section>
              <h2>Connection</h2>
              <div className="settings-status">
                <span className={`conn-dot ${status} ${unsecure ? "unsecure" : ""}`} />
                <span>{STATUS_LABEL[status]}</span>
                {unsecure && <span className="badge warn">Unsecure</span>}
                <span className="muted mono">{routeLabel(route)}</span>
              </div>
              <div className="settings-row">
                <div className="muted small">
                  <KeyRound size={12} /> Signed in as <span className="mono">{username}</span>.{" "}
                  {passwordSaved ? "The password is saved in your system keyring." : "The system keyring couldn't save the password."}
                </div>
                <button
                  className="btn"
                  disabled={signingOut}
                  onClick={async () => {
                    setSigningOut(true);
                    await onSignOut();
                  }}
                >
                  <LogOut size={14} /> {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </div>
              {headers.length > 0 && (
                <div className="muted small settings-headers">
                  <ShieldCheck size={12} /> Sends {headers.length === 1 ? "an extra request header" : `${headers.length} extra request headers`}:{" "}
                  {headers.map((h, i) => (
                    <span key={i}>
                      {i > 0 && ", "}
                      <span className="mono">{h}</span>
                    </span>
                  ))}
                  .{" "}
                  {headersSaved
                    ? "Their values are saved in your system keyring and never shown."
                    : "Their values are never shown. The system keyring couldn't save them, so you type them again at the next sign-in."}
                </div>
              )}
              <p className="muted small settings-note">
                Signing out deletes the saved password from the keyring. You type it again at the next sign-in.
                {headers.length > 0 && headersSaved && " The extra request headers stay saved, to change or remove on the sign-in screen."}
              </p>
            </section>

            <StartupSettings />

            <VoiceSettings status={status} profile={profile} setup={voiceSetup} />
            <ScreenshotSettings checkSupport={checkScreenshots} />
            <UpdateSettings />

            <section>
              <h2>Local cache</h2>
              <p className="muted">
                Hermes Chat keeps a copy of each profile's chat list on this computer, so the list shows as soon as you sign in. It also keeps a
                Saved copy of the chats you opened most recently, up to {fmtSize(TRANSCRIPT_LIMIT_BYTES)}, so you can read them while Hermes can't be
                reached. The oldest copies are deleted first when that fills up. Clearing the cache keeps your display settings.
              </p>
              <div className="settings-row">
                <div>
                  <div className="big-num">{fmtSize(bytes)}</div>
                  <div className="muted small">{bytes ? "Stored on this computer" : "Nothing stored"}</div>
                </div>
                {!confirmClear ? (
                  <button className="btn" disabled={!bytes} onClick={() => setConfirmClear(true)}>
                    <Trash2 size={14} /> Clear local cache
                  </button>
                ) : (
                  <div className="confirm">
                    <span>
                      <Lock size={12} /> Only the chat copies on this computer are deleted; your display settings are kept. Nothing on your Hermes
                      server is touched; the list is saved again at the next refresh, and a chat's Saved copy when you next open it.
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
              </div>
            </section>

            <section>
              <h2>History</h2>
              <p className="muted">
                The list shows chats from the past month. Older chats stay on the server until you pull them for the{" "}
                <span className="mono">{profile}</span> profile.
              </p>
              <div className="settings-row">
                <div className={`small ${pullError ? "sign-in-error" : "muted"}`} role={pullError ? "alert" : undefined}>
                  {pullError ?? pulled ?? (olderPulled ? "All chats are listed, however old." : "Showing chats from the past month.")}
                </div>
                <button className="btn" disabled={pulling || olderPulled || status !== "connected"} onClick={pull}>
                  <Download size={14} /> {pulling ? "Pulling…" : olderPulled ? "Up to date" : "Pull older history"}
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
