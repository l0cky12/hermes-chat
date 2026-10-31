// Sign-in over SSH (ADR 0003), built from the prototype's first-run screen and its SSH form.
import { useState } from "react";
import { KeyRound, Terminal } from "lucide-react";
import type { SignInDetails } from "../hermes/tauriPipe";

export function SignIn({
  initial,
  error,
  onSignIn,
}: {
  initial: Omit<SignInDetails, "password">;
  error?: string;
  onSignIn: (d: SignInDetails) => Promise<void>;
}) {
  const [d, setD] = useState<SignInDetails>({ ...initial, password: "" });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<SignInDetails>) => setD({ ...d, ...patch });
  const ready = d.sshTarget.trim() && d.username.trim() && d.password;
  return (
    <div className="first-run">
      <div className="first-run-card">
        <div className="rail-brand big">H</div>
        <h1>Connect to Hermes</h1>
        <p className="muted">Sign in to your Hermes server over SSH.</p>
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
          <label className="field">
            <span className="field-label">SSH target</span>
            <input value={d.sshTarget} onChange={(e) => set({ sshTarget: e.target.value })} placeholder="liam@hermes" />
            <span className="field-hint block">
              <Terminal size={12} /> Uses your <code>~/.ssh/config</code> and ssh-agent. The key must work without a prompt.
            </span>
          </label>
          <label className="field">
            <span className="field-label">Dashboard username</span>
            <input value={d.username} onChange={(e) => set({ username: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Dashboard password</span>
            <input type="password" autoFocus value={d.password} onChange={(e) => set({ password: e.target.value })} />
            <span className="field-hint">
              <KeyRound size={12} /> Sent to the server through the SSH tunnel. Not stored.
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
