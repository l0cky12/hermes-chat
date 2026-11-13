// Settings → Extensions (ADR 0126, sections 3, 4 and 7): each extension the app offers, its permissions, whether it is
// installed, enabled and running, why it stopped, and its commands. Until Delivery step 4 the app offers only the
// extensions bundled with it; install from a file is not here.
import { useEffect, useState } from "react";
import { offeredCommands, takenName, type ExtensionState, type Runtime } from "../hermes/extensions";
import type { SkillCommands } from "../hermes/skillCommands";
import type { Permission } from "../hermes/extensionPermissions";
import { SettingRow, SettingsSection } from "./SettingRows";
import { useExtensions } from "./extensionsContext";
import { HeadPart, MoreText, useInPage } from "./SettingsPage";

const MEANS: Record<Permission, string> = {
  "chat.read":
    "Read the messages of the chat you run it in, only while its command runs: who wrote each one, its text and its time. No attachments and no tool output. It sees whatever a message says, a secret Hermes printed included.",
  "chat.draft": "Add text to the Draft of the chat you run it in, only while its command runs. You send it, or don't.",
  "project.read": "Read the names and folders of the projects the chat you run it in belongs to, only while its command runs.",
  storage: "Keep up to 1 MB of its own data for each chat.",
};

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function runtimeText(r: Runtime): string {
  switch (r.kind) {
    case "stopped":
      return r.why ? `Stopped: ${r.why}.` : "Not running. It starts when you run one of its commands.";
    case "starting":
      return "Starting…";
    case "running":
      return "Running.";
    case "failed":
      return `Stopped at ${time(r.at)}: it ${r.reason}. It starts again the next time you run it.`;
  }
}

function statusText(s: ExtensionState): string {
  const status = s.installed?.status;
  if (!status) return "Not installed.";
  switch (status.kind) {
    case "usable":
      return runtimeText(s.runtime);
    case "incompatible":
      return `Incompatible: it needs extension API ${status.needsApi}, and this app runs ${status.runsApi}. It is kept, but never started.`;
    case "disabled":
      return status.why === "owner" ? "Disabled." : `Disabled after failing three times in 10 minutes${s.runtime.kind === "failed" ? `. Last: it ${s.runtime.reason}` : ""}.`;
  }
}

/** `skills` reads the skills offered in the profile shown, so a command a skill's name hides says so. */
export function ExtensionsSettings({ skills }: { skills?: () => Promise<SkillCommands | undefined> }) {
  const { store, states } = useExtensions();
  const [asking, setAsking] = useState<string>();
  const [offered, setOffered] = useState<SkillCommands>();
  useEffect(() => {
    let live = true;
    skills?.().then((s) => live && setOffered(s), () => {});
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once as the tab opens; a new loader each render isn't a new profile
  }, []);
  const { refused } = offeredCommands(states, takenName(offered?.offered));

  // Under Settings' page header (ADR 0159) the paragraph about extensions joins the page's description, its first
  // sentence shown and the rest behind More.
  const inPage = useInPage();
  const about = (
    <MoreText
      first={
        <>
          An extension adds commands to the <span className="mono">/</span> menu and a view to the Preview.
        </>
      }
      rest="Each one runs in a sandbox with no network, no files and no passwords. It reads a chat only with your permission, and only while a command you ran is running. For now only the extensions that come with Hermes Chat can be installed. Installing one from a file comes later."
    />
  );
  return (
    <>
      {inPage ? (
        <HeadPart at="desc"> {about}</HeadPart>
      ) : (
        <div className="set-intro">
          <p>{about}</p>
        </div>
      )}
      {states.map((s) => {
        const m = s.manifest;
        const installed = s.installed;
        const disabled = installed?.status.kind === "disabled";
        const headingId = `ext-${m.id}`;
        return (
          <SettingsSection key={m.id} title={m.name} titleId={headingId} intro={<p className="muted">Comes with Hermes Chat · version {m.version} · <span className="mono">{m.id}</span></p>}>
            <SettingRow
              name="Status"
              hint={statusText(s)}
              control={
                <div className="ext-actions">
                  {!installed && (
                    <button type="button" className="btn" onClick={() => setAsking(m.id)} aria-expanded={asking === m.id}>
                      Install…
                    </button>
                  )}
                  {installed && installed.status.kind !== "incompatible" && (
                    <button type="button" className="btn" onClick={() => store.setEnabled(m.id, disabled)}>
                      {disabled ? "Enable" : "Disable"}
                    </button>
                  )}
                  {installed && (
                    <button type="button" className="btn danger" onClick={() => store.uninstall(m.id)}>
                      Uninstall
                    </button>
                  )}
                </div>
              }
            />
            {asking === m.id && !installed && (
              <div className="ext-install" role="alertdialog" aria-label={`Install ${m.name}?`} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setAsking(undefined))}>
                <p>
                  <b>Install {m.name}?</b>{" "}
                  {m.permissions.length ? "It asks for:" : "It asks for no permissions: it gets only what you type after its command."}
                </p>
                {m.permissions.length > 0 && (
                  <ul>
                    {m.permissions.map((p) => (
                      <li key={p}>
                        <span className="mono">{p}</span>: {MEANS[p]}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="muted">You can withdraw any permission here later.</p>
                <div className="ext-actions">
                  <button type="button" className="btn primary" onClick={() => (store.install(m.id), setAsking(undefined))}>
                    Install
                  </button>
                  <button type="button" className="btn" autoFocus onClick={() => setAsking(undefined)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {m.permissions.map((p) => (
              <SettingRow
                key={p}
                name={<span className="mono">{p}</span>}
                hint={MEANS[p]}
                control={
                  installed ? (
                    <label className="check">
                      <input type="checkbox" checked={installed.grants.includes(p)} onChange={(e) => store.setGrant(m.id, p, e.target.checked)} /> Granted
                    </label>
                  ) : (
                    <span className="muted">Asked for</span>
                  )
                }
              />
            ))}
            <SettingRow
              name="Commands"
              hint={
                <>
                  {m.commands.map((c) => {
                    const why = refused.find((r) => r.id === m.id && r.name === c.name)?.why;
                    return (
                      <span key={c.name} className="ext-command">
                        <span className="mono">/{c.name}</span> {c.description}
                        {why && <span className="cmd-why"> Not offered: {why}</span>}
                      </span>
                    );
                  })}
                </>
              }
            />
          </SettingsSection>
        );
      })}
    </>
  );
}
