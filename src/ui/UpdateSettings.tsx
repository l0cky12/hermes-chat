// The Updates section of Settings: what's installed, what's newer and what changed, and the step the owner takes to
// install it. pacman installs a packaged copy; this app installs only a standalone AppImage. Restarting is the
// owner's call, and keeps drafts (updates.ts).
import { useState, useSyncExternalStore } from "react";
import { Copy, Download, RefreshCw, RotateCw } from "lucide-react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { appUpdates } from "../hermes/tauriUpdates";
import type { Found, Updater, UpdateState } from "../hermes/updates";
import { fmtSize } from "./bits";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function Notes({ found }: { found: Found }) {
  if (!found.notes.length) return <p className="muted small">No release notes came with this version.</p>;
  return (
    <>
      <h3 className="update-notes-title">What's new</h3>
      <ul className="update-notes">
        {found.notes.map((n, i) => (
          <li key={i}>{n.text}</li>
        ))}
        {found.more > 0 && <li className="muted">and {found.more} more</li>}
      </ul>
      {found.allUrl && (
        <p className="muted small">
          Every change: <span className="mono selectable">{found.allUrl}</span>
        </p>
      )}
    </>
  );
}

function PackageStep({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <p className="muted small">
        pacman manages this copy, so Hermes Chat doesn't replace its files. To update it, run this from your hermes-chat checkout:
      </p>
      <div className="update-command">
        <code className="mono selectable">{command}</code>
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText(command).then(() => setCopied(true));
          }}
        >
          <Copy size={14} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="muted small">Once pacman has installed it, Hermes Chat offers to restart into the new version.</p>
    </>
  );
}

const RESTART_NOTE = "Your drafts and unsent messages are kept. Files attached in the composer aren't, and replies keep running on Hermes.";

function Status({ s, updates }: { s: UpdateState; updates: Updater }) {
  switch (s.state) {
    case "idle":
      return <p className="muted">Not checked yet.</p>;
    case "checking":
      return <p className="muted">Checking for updates…</p>;
    case "upToDate":
      return (
        <p className="muted">
          Hermes Chat <span className="mono">{s.version}</span> is up to date. Checked at {time(s.checkedAt)}.{s.note && ` ${s.note}`}
        </p>
      );
    case "unsupported":
      return (
        <p className="muted">
          Hermes Chat <span className="mono">{s.version}</span>. {s.reason}
        </p>
      );
    case "available":
      return (
        <>
          <p>
            <strong>
              Version <span className="mono">{s.found.to}</span> is available.
            </strong>{" "}
            <span className="muted">
              You have <span className="mono">{s.found.from}</span>.
            </span>
          </p>
          {s.found.warning && <p className="update-warning small">{s.found.warning}</p>}
          <Notes found={s.found} />
          {s.found.command ? (
            <PackageStep command={s.found.command} />
          ) : s.found.via === "pacman" ? (
            <p className="muted small">pacman manages this copy, so Hermes Chat doesn't replace its files. Update it with your package manager.</p>
          ) : (
            <button className="btn primary" onClick={() => void updates.install()}>
              <Download size={14} /> Download and install
            </button>
          )}
        </>
      );
    case "installing":
      return (
        <>
          <p>
            {s.verifying ? "Checking the signature and installing" : "Downloading"} <span className="mono">{s.found.to}</span>…
          </p>
          <progress className="update-progress" aria-label="Update download" value={s.verifying ? undefined : s.downloaded} max={s.verifying ? undefined : s.total} />
          {!s.verifying && (
            <p className="muted small">
              {fmtSize(s.downloaded)}
              {s.total ? ` of ${fmtSize(s.total)}` : ""}
            </p>
          )}
        </>
      );
    case "restart":
    case "restarting":
      return (
        <>
          <p>
            <strong>
              Version <span className="mono">{s.to}</span> is installed.
            </strong>{" "}
            <span className="muted">
              Restart to use it; until then this window keeps running <span className="mono">{s.from}</span>.
            </span>
          </p>
          <p className="muted small">{RESTART_NOTE}</p>
          <button className="btn primary" disabled={s.state === "restarting"} onClick={() => void updates.restart()}>
            <RotateCw size={14} /> {s.state === "restarting" ? "Restarting…" : "Restart now"}
          </button>
        </>
      );
    case "error":
      return (
        <>
          <p className="sign-in-error selectable" role="alert">
            {s.message}
          </p>
          {/* Drafts set aside: nothing to try again, and the notice stays until the app closes. */}
          {!s.setAside && <button
            className="btn"
            onClick={() => void (s.restart ? updates.restart() : s.found?.via === "updater" ? updates.install() : updates.check())}
          >
            <RefreshCw size={14} /> Try again
          </button>}
        </>
      );
  }
}

export function UpdateSettings({ updates = appUpdates }: { updates?: Updater }) {
  const s = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const { checkUpdatesOnLaunch } = useSyncExternalStore(subscribe, getUIPrefs);
  const canCheck = ["idle", "upToDate", "available", "unsupported"].includes(s.state);
  return (
    <section>
      <div className="settings-row">
        <h2>Updates</h2>
        {canCheck && s.state !== "unsupported" && (
          <button className="btn" onClick={() => void updates.check()}>
            <RefreshCw size={14} /> Check for updates
          </button>
        )}
      </div>
      <div className="update-status" aria-live="polite">
        <Status s={s} updates={updates} />
      </div>
      <div className="appearance-row">
        <div className="appearance-label">
          <div className="appearance-title" id="check-updates-label">
            Check for updates on launch
          </div>
          <div className="muted small">Asks GitHub, or this build's update server, each time the app starts. Nothing installs without you.</div>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={checkUpdatesOnLaunch}
          aria-labelledby="check-updates-label"
          onClick={() => setUIPrefs({ checkUpdatesOnLaunch: !checkUpdatesOnLaunch })}
        >
          <span className="switch-knob" />
        </button>
      </div>
    </section>
  );
}
