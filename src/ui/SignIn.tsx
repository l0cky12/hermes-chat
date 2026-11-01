// Sign-in over SSH (ADR 0003) or straight to a dashboard URL, built from the prototype's first-run screen and its
// connection form.
import { useState } from "react";
import { Globe, KeyRound, Terminal } from "lucide-react";
import type { SignInDetails } from "../hermes/tauriPipe";

export function SignIn({
  initial,
  error,
  onSignIn,
}: {
  /** The saved sign-in; the password is filled in when launch couldn't sign in with it. */
  initial: SignInDetails;
  error?: string;
  onSignIn: (d: SignInDetails) => Promise<void>;
}) {
  const [d, setD] = useState<SignInDetails>(initial);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<SignInDetails>) => setD({ ...d, ...patch });
  const ready = (d.mode === "ssh" ? d.sshTarget : d.url).trim() && d.username.trim() && d.password;
  return (
    <div className="first-run">
      <div className="first-run-card">
        <div className="rail-brand big">H</div>
        <h1>Connect to Hermes</h1>
        <p className="muted">Sign in to your Hermes server's dashboard.</p>
        <form
          className="conn-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!ready || busy) return;
            setBusy(true);
            try {
              await onSignIn(d);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="seg" role="group" aria-label="Connect through">
            <button type="button" className={d.mode === "ssh" ? "on" : ""} onClick={() => set({ mode: "ssh" })}>
              SSH
            </button>
            <button type="button" className={d.mode === "url" ? "on" : ""} onClick={() => set({ mode: "url" })}>
              URL
            </button>
          </div>
          {d.mode === "ssh" ? (
            <label className="field">
              <span className="field-label">SSH target</span>
              <input value={d.sshTarget} onChange={(e) => set({ sshTarget: e.target.value })} placeholder="liam@hermes" />
              <span className="field-hint block">
                <Terminal size={12} /> Uses your <code>~/.ssh/config</code> and ssh-agent. The key must work without a prompt.
              </span>
            </label>
          ) : (
            <label className="field">
              <span className="field-label">Dashboard URL</span>
              <input value={d.url} onChange={(e) => set({ url: e.target.value })} placeholder="http://hermes:9119" />
              <span className="field-hint block">
                <Globe size={12} /> <code>http://</code> isn't encrypted unless it stays on this computer or on Tailscale.
              </span>
            </label>
          )}
          <label className="field">
            <span className="field-label">Dashboard username</span>
            <input value={d.username} onChange={(e) => set({ username: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Dashboard password</span>
            <input type="password" autoFocus value={d.password} onChange={(e) => set({ password: e.target.value })} />
            <span className="field-hint">
              <KeyRound size={12} /> {d.mode === "ssh" ? "Sent to the server through the SSH tunnel." : "Sent to the dashboard at this URL."} Saved
              in your system keyring.
            </span>
          </label>
          {error && <div className="sign-in-error" role="alert">{error}</div>}
          <button className="btn primary" type="submit" disabled={!ready || busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}
