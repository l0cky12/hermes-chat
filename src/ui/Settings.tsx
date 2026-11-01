// The Settings screen, ported from the prototype: the connection and Sign out, the local cache, and older history.
// Profiles are switched in the list's header, not here (ADR 0001).
import { useState } from "react";
import { ArrowLeft, Download, KeyRound, Lock, LogOut, Trash2 } from "lucide-react";
import type { Chat, ConnectionStatus } from "../hermes/model";
import type { Route } from "../hermes/pipe";
import { STATUS_LABEL, fmtSize, routeLabel } from "./bits";

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
  profile,
  olderPulled,
  cacheBytes,
  onClearCache,
  onPullOlder,
  onSignOut,
  onClose,
}: {
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  username: string;
  /** The keyring kept the password at sign-in. */
  passwordSaved: boolean;
  profile: string;
  olderPulled: boolean;
  /** The storage the saved chat lists take now. */
  cacheBytes: () => number;
  onClearCache: () => void;
  /** Resolves to the older chats added. */
  onPullOlder: () => Promise<Chat[]>;
  onSignOut: () => Promise<void>;
  onClose: () => void;
}) {
  const [bytes, setBytes] = useState(cacheBytes);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState<string>();
  const [pullError, setPullError] = useState<string>();
  const [signingOut, setSigningOut] = useState(false);

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
          <p className="muted small settings-note">Signing out deletes the saved password from the keyring. You type it again at the next sign-in.</p>
        </section>

        <section>
          <h2>Local cache</h2>
          <p className="muted">Hermes Chat keeps a copy of each profile's chat list on this computer, so the list shows as soon as you sign in.</p>
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
                  <Lock size={12} /> Only the copies on this computer are deleted. Nothing on your Hermes server is touched; the list is saved again
                  at the next refresh.
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
    </div>
  );
}
