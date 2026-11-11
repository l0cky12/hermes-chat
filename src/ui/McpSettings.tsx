// Settings → MCP servers (ADR 0121): the MCP servers Hermes connects one profile's agent to, picked with the same
// profile list as Skills and Memory (ADR 0118). Each server's row says how it runs (a command, or a URL), whether it's
// on, what its last Test found, and whether a plugin provides it. Servers are added from a blank form or Hermes's
// catalog, edited in a dialog, removed after asking, tested and signed in to (OAuth) on the server. Env values and
// bearer tokens are write-only: nothing fills them from Hermes, and a blank one keeps what Hermes has. Each change is
// called saved only once Hermes's list, read again, shows it (mcp.ts).
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, CircleAlert, Info, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { Spinner } from "./bits";
import { useModal } from "./modal";
import {
  type Auth,
  type Catalog,
  type CatalogEntry,
  type McpApi,
  type McpChange,
  type McpList,
  type McpServer,
  type McpTest,
  type OAuthFlow,
  type ServerForm,
  McpUnsupportedError,
  envKeyFor,
  formProblem,
} from "../hermes/mcp";
import { errorText } from "../hermes/values";

/** How often a sign-in under way is asked about, and for how long before giving up on it. */
export const SIGN_IN_POLL_MS = 2000;
export const SIGN_IN_LIMIT_MS = 5 * 60 * 1000;

type Note = { tone: "ok" | "warn" | "bad"; text: string };
type Busy = "toggle" | "remove" | "test" | "signin";
type SignIn = { flow: OAuthFlow; startedAt: number };
type Dialog = { kind: "add" } | { kind: "edit"; server: McpServer } | { kind: "catalog" };

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const toolsText = (n: number) => `${n} ${n === 1 ? "tool" : "tools"}`;

/** What a change came to, in words; `what` is what was done, such as "Saved" or "Removed". */
function changeNote(r: McpChange, what: string): Note {
  if (r.kind === "saved") return { tone: r.note ? "warn" : "ok", text: r.note ?? `${what}: Hermes reads it back that way.` };
  if (r.kind === "refused") return { tone: "bad", text: `Not changed: ${r.reason}` };
  return { tone: "warn", text: `Hermes didn't confirm it: ${r.reason} The list shows what Hermes has now.` };
}

/** How a server runs, in one line. */
function runsText(s: McpServer): string {
  if (s.transport === "stdio") return [s.command, ...s.args].join(" ");
  if (s.transport === "http") return s.url ?? "";
  return "Hermes didn't say how it runs";
}

const AUTH_TEXT: Record<Auth, string> = { none: "No sign-in", header: "Bearer token, kept on the server", oauth: "OAuth sign-in" };

export function McpSettings({
  api,
  profile,
  connected,
  picker,
  openUrl,
  pollMs = SIGN_IN_POLL_MS,
}: {
  api: McpApi;
  /** The profile shown; every read and write names it, and answers for another are dropped. */
  profile: string;
  connected: boolean;
  /** Settings' profile picker (ADR 0118). */
  picker?: ReactNode;
  /** Opens an OAuth sign-in page in the browser. */
  openUrl: (url: string) => Promise<void> | void;
  /** How often a sign-in under way is asked about; shorter in tests. */
  pollMs?: number;
}) {
  const [list, setList] = useState<McpList>();
  const [problem, setProblem] = useState<{ unsupported: boolean; text: string }>();
  const [loading, setLoading] = useState(false);
  const [noMcp, setNoMcp] = useState<string[]>();
  // Maps keyed by server name: Hermes takes any name, `constructor` and `__proto__` included.
  const [busy, setBusy] = useState<Map<string, Busy>>(new Map());
  const [notes, setNotes] = useState<Map<string, Note>>(new Map());
  const [tests, setTests] = useState<Map<string, McpTest>>(new Map());
  const [signIns, setSignIns] = useState<Map<string, SignIn>>(new Map());
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [dialog, setDialog] = useState<Dialog>();
  const [listNote, setListNote] = useState<Note>();
  const live = useRef(true);
  // Every answer is for the profile asked; one that comes back after a switch is dropped.
  const shown = useRef(profile);
  shown.current = profile;
  const mine = (p: string) => live.current && shown.current === p;
  const flowsRef = useRef<Map<string, SignIn>>(new Map());
  flowsRef.current = signIns;

  const load = useCallback(async () => {
    const p = profile;
    setLoading(true);
    try {
      const l = await api.list(p);
      if (!mine(p)) return;
      setList(l);
      setProblem(undefined);
    } catch (e) {
      if (mine(p)) setProblem({ unsupported: e instanceof McpUnsupportedError, text: errorText(e) });
    } finally {
      if (mine(p)) setLoading(false);
    }
    api.noMcp(p).then(
      (platforms) => mine(p) && setNoMcp(platforms),
      () => mine(p) && setNoMcp(undefined),
    );
  }, [api, profile]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      // A sign-in left waiting would hold Hermes's slot for the server until it times out.
      for (const s of flowsRef.current.values()) if (s.flow.status === "starting" || s.flow.status === "authorization_required") void api.cancelSignIn(s.flow.flowId);
    };
  }, [api]);
  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const setOne = <T,>(set: (f: (m: Map<string, T>) => Map<string, T>) => void, name: string, v: T | undefined) =>
    set((m) => {
      const next = new Map(m);
      if (v === undefined) next.delete(name);
      else next.set(name, v);
      return next;
    });

  /** Takes a change's outcome for the profile it was asked for: the list Hermes has now, and what to say. */
  const settle = (p: string, name: string | undefined, r: McpChange, what: string) => {
    if (!mine(p)) return;
    if (r.list) setList(r.list);
    // A Test from before the change no longer says how the server is.
    if (name) setOne(setTests, name, undefined);
    const note = changeNote(r, what);
    if (name && r.list?.servers.some((s) => s.name === name)) setOne(setNotes, name, note);
    else setListNote(note);
  };

  const run = async (name: string, kind: Busy, go: () => Promise<McpChange>, what: string) => {
    const p = profile;
    setOne(setBusy, name, kind);
    setOne(setNotes, name, undefined);
    setListNote(undefined);
    try {
      settle(p, name, await go(), what);
    } finally {
      if (mine(p)) setOne(setBusy, name, undefined);
    }
  };

  const toggle = (s: McpServer) => void run(s.name, "toggle", () => api.setEnabled(profile, s.name, !s.enabled), s.enabled ? "Turned off" : "Turned on");
  const remove = (s: McpServer) => {
    setConfirmRemove(undefined);
    void run(s.name, "remove", () => api.remove(profile, s.name), `Removed ${s.name}`);
  };

  const test = async (s: McpServer) => {
    const p = profile;
    setOne(setBusy, s.name, "test");
    setOne(setNotes, s.name, undefined);
    const r = await api.test(p, s.name);
    if (!mine(p)) return;
    setOne(setTests, s.name, r);
    setOne(setBusy, s.name, undefined);
  };

  // Each sign-in under way is asked about every SIGN_IN_POLL_MS until Hermes says it's approved or failed.
  useEffect(() => {
    const waiting = [...signIns].filter(([, s]) => s.flow.status === "starting" || s.flow.status === "authorization_required");
    if (!waiting.length) return;
    const p = profile;
    const timer = setTimeout(() => {
      for (const [name, s] of waiting) {
        if (Date.now() - s.startedAt > SIGN_IN_LIMIT_MS) {
          void api.cancelSignIn(s.flow.flowId);
          setOne(setSignIns, name, undefined);
          setOne(setNotes, name, { tone: "warn", text: "Gave up waiting for the sign-in after 5 minutes. Sign in again to try once more." });
          continue;
        }
        api.signInStatus(s.flow.flowId).then(
          (flow) => {
            if (!mine(p) || flowsRef.current.get(name)?.flow.flowId !== flow.flowId) return;
            // An answer about another server's flow isn't this one's.
            if (flow.server && flow.server !== name) return;
            if (flow.status === "approved") {
              setOne(setSignIns, name, undefined);
              const found = flow.tools?.length;
              setOne(setNotes, name, { tone: "ok", text: `Signed in.${found !== undefined ? ` Hermes found ${toolsText(found)}.` : ""}` });
              void load();
            } else if (flow.status === "error") {
              setOne(setSignIns, name, undefined);
              setOne(setNotes, name, { tone: "bad", text: `Sign-in didn't finish: ${flow.error}` });
            } else {
              const opened = s.flow.authorizationUrl;
              setOne(setSignIns, name, { ...s, flow });
              if (!opened && flow.authorizationUrl) void Promise.resolve(openUrl(flow.authorizationUrl)).catch(() => undefined);
            }
          },
          (e) => {
            if (!mine(p) || flowsRef.current.get(name)?.flow.flowId !== s.flow.flowId) return;
            // Dropped here, so stopped on Hermes too: a flow left waiting there refuses the next sign-in until it times out.
            void api.cancelSignIn(s.flow.flowId);
            setOne(setSignIns, name, undefined);
            setOne(setNotes, name, { tone: "bad", text: `Lost track of the sign-in, so it was stopped: ${errorText(e)}. Sign in again to try once more.` });
          },
        );
      }
    }, pollMs);
    return () => clearTimeout(timer);
  }, [signIns]);

  const signIn = async (s: McpServer) => {
    const p = profile;
    setOne(setBusy, s.name, "signin");
    setOne(setNotes, s.name, undefined);
    try {
      const flow = await api.startSignIn(p, s.name);
      if (!mine(p)) {
        void api.cancelSignIn(flow.flowId);
        return;
      }
      if (flow.status === "error") {
        setOne(setNotes, s.name, { tone: "bad", text: `Hermes couldn't start the sign-in: ${flow.error}` });
        return;
      }
      setOne(setSignIns, s.name, { flow, startedAt: Date.now() });
      if (flow.authorizationUrl) await Promise.resolve(openUrl(flow.authorizationUrl)).catch((e) => setOne(setNotes, s.name, { tone: "warn", text: `Couldn't open your browser: ${errorText(e)}` }));
    } catch (e) {
      if (mine(p)) setOne(setNotes, s.name, { tone: "bad", text: `Hermes couldn't start the sign-in: ${errorText(e)}` });
    } finally {
      if (mine(p)) setOne(setBusy, s.name, undefined);
    }
  };

  const cancelSignIn = (name: string) => {
    const s = signIns.get(name);
    if (!s) return;
    void api.cancelSignIn(s.flow.flowId);
    setOne(setSignIns, name, undefined);
    setOne(setNotes, name, { tone: "warn", text: "Sign-in stopped." });
  };

  const names = list?.servers.map((s) => s.name) ?? [];
  const cliOff = noMcp?.includes("cli");
  const otherOff = noMcp?.filter((p) => p !== "cli") ?? [];

  const row = (s: McpServer) => {
    const id = `mcp-${s.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const b = busy.get(s.name);
    const t = tests.get(s.name);
    const flow = signIns.get(s.name);
    const locked = !connected || !!b || !s.changeable;
    const note = notes.get(s.name);
    return (
      <SettingRow
        key={s.name}
        className="mcp-row"
        name={
          <span className="mcp-name">
            <span className="mono" id={`${id}-label`}>
              {s.name}
            </span>
            {s.plugin && <span className="badge">from plugin {s.plugin}</span>}
            {!s.enabled && <span className="badge off">Off</span>}
          </span>
        }
        about={s.name}
        hint={
          <span id={`${id}-desc`}>
            <span className="mcp-kind">{s.transport === "stdio" ? "Command" : s.transport === "http" ? "URL" : "Unknown"}</span>{" "}
            <span className="mono mcp-runs" title={runsText(s)}>
              {runsText(s)}
            </span>
          </span>
        }
        control={
          s.changeable ? (
            <button
              className="switch"
              role="switch"
              aria-checked={s.enabled}
              aria-labelledby={`${id}-label`}
              aria-describedby={`${id}-desc`}
              aria-busy={b === "toggle" ? true : undefined}
              disabled={locked}
              onClick={() => toggle(s)}
            >
              <span className="switch-knob" />
            </button>
          ) : (
            <span className={`badge ${s.enabled ? "" : "off"}`} aria-label={`${s.name} is ${s.enabled ? "on" : "off"}`}>
              {s.enabled ? "On" : "Off"}
            </span>
          )
        }
      >
        <div className="mcp-facts muted">
          {s.transport === "http" && <span>{AUTH_TEXT[s.auth]}</span>}
          {s.envKeys.length > 0 && (
            <span>
              Environment: <span className="mono">{s.envKeys.join(", ")}</span> (values stay on the server)
            </span>
          )}
          {s.toolFilter && <span>Hermes offers only some of its tools: its config has a tools filter.</span>}
          {s.plugin && <span>The plugin {s.plugin} provides it, so it can't be changed or removed here.</span>}
          {!s.plugin && !s.changeable && <span>Its name has characters this app doesn't send in a request, so it can only be changed on the server.</span>}
        </div>
        {t && (
          <div className={`mcp-test ${t.ok ? "ok" : "bad"}`} role="status">
            {t.ok ? (
              <details>
                <summary>
                  <CheckCircle2 size={13} aria-hidden /> Connected at {clock(t.at)}: {toolsText(t.tools.length)}
                  {t.prompts ? `, ${t.prompts} prompts` : ""}
                  {t.resources ? `, ${t.resources} resources` : ""}.
                </summary>
                <ul className="mcp-tools">
                  {t.tools.map((x) => (
                    <li key={x.name}>
                      <span className="mono">{x.name}</span>
                      {x.description && <span className="muted"> — {x.description}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <span>
                <CircleAlert size={13} aria-hidden /> Couldn't connect at {clock(t.at)}: {t.error}
              </span>
            )}
          </div>
        )}
        {flow && (
          <div className="mcp-signin" role="status">
            <Spinner /> {flow.flow.authorizationUrl ? "Finish signing in in your browser. This updates once Hermes has the sign-in." : "Hermes is starting the sign-in…"}
            {flow.flow.authorizationUrl && (
              <button className="link" onClick={() => void Promise.resolve(openUrl(flow.flow.authorizationUrl!)).catch(() => undefined)}>
                Open the page again
              </button>
            )}
            <button className="link" onClick={() => cancelSignIn(s.name)}>
              Stop
            </button>
          </div>
        )}
        {note && (
          <div className={`mcp-note ${note.tone}`} role={note.tone === "bad" ? "alert" : "status"}>
            {note.text}
          </div>
        )}
        {confirmRemove === s.name ? (
          <div className="mcp-confirm" role="group" aria-label={`Remove ${s.name}?`}>
            <span>
              Remove <span className="mono">{s.name}</span> from {profile}'s config? New chats won't have its tools. Its env values go with it; a bearer token or OAuth sign-in Hermes saved stays on the server.
            </span>
            <span className="mcp-actions">
              <button className="btn danger" autoFocus disabled={!connected} onClick={() => remove(s)}>
                Remove
              </button>
              <button className="btn" onClick={() => setConfirmRemove(undefined)}>
                Keep it
              </button>
            </span>
          </div>
        ) : (
          <div className="mcp-actions">
            <button className="btn" disabled={!connected || !!b} aria-label={`Test ${s.name}`} onClick={() => void test(s)}>
              {b === "test" ? <Spinner /> : null} {b === "test" ? "Testing…" : "Test"}
            </button>
            {s.transport === "http" && s.auth === "oauth" && !s.plugin && s.changeable && (
              <button className="btn" disabled={!connected || !!b || !!flow} aria-label={`Sign in to ${s.name}`} onClick={() => void signIn(s)}>
                Sign in
              </button>
            )}
            {s.changeable && (
              <>
                <button className="btn" disabled={locked} aria-label={`Edit ${s.name}`} onClick={() => setDialog({ kind: "edit", server: s })}>
                  <Pencil size={13} aria-hidden /> Edit
                </button>
                <button className="btn" disabled={locked} aria-label={`Remove ${s.name}`} onClick={() => setConfirmRemove(s.name)}>
                  <Trash2 size={13} aria-hidden /> Remove
                </button>
              </>
            )}
          </div>
        )}
      </SettingRow>
    );
  };

  return (
    <>
      <SettingsSection
        title="MCP servers"
        titleId="mcp-heading"
        intro="Tools from other programs and services that Hermes offers the model, set up for each profile on the server."
        more={
          <p>
            An MCP server is a program Hermes starts on the server (a command) or a service it connects to (a URL). Hermes keeps the list in the profile's config.yaml, and its secrets in the profile's .env. Changes here are made on the server, for
            every Hermes client using the profile.
          </p>
        }
        action={
          <span className="mcp-head-actions">
            <button className="btn" disabled={!connected || !list} onClick={() => setDialog({ kind: "catalog" })}>
              <BookOpen size={13} aria-hidden /> From catalog
            </button>
            <button className="btn primary" disabled={!connected || !list} onClick={() => setDialog({ kind: "add" })}>
              <Plus size={13} aria-hidden /> Add server
            </button>
          </span>
        }
      >
        <SettingRow name="Profile" control={picker ?? <span className="set-value mono">{profile}</span>} />
        {cliOff && (
          <SettingNote tone="warn" role="status">
            <AlertTriangle size={14} />
            <span>
              This profile's Toolsets turn MCP servers off for this app's chats (<span className="mono">no_mcp</span>): new chats get none of these tools, whatever their switches say. Hermes clears it when Settings → Toolsets saves a change.
            </span>
          </SettingNote>
        )}
        {otherOff.length > 0 && (
          <SettingNote role="status">
            <Info size={14} />
            <span>
              <span className="mono">no_mcp</span> turns them off for {otherOff.join(", ")} chats in this profile.
            </span>
          </SettingNote>
        )}
        {problem ? (
          <SettingNote tone={problem.unsupported ? "muted" : "bad"} role="alert">
            {problem.unsupported ? <Info size={14} /> : <AlertTriangle size={14} />}
            <span>{problem.unsupported ? problem.text : `Couldn't read MCP servers: ${problem.text}`}</span>
            {!problem.unsupported && (
              <button className="btn" disabled={!connected || loading} onClick={() => void load()}>
                <RefreshCw size={14} /> {loading ? "Trying…" : "Try again"}
              </button>
            )}
          </SettingNote>
        ) : !list ? (
          <SettingNote role="status">{connected ? "Reading MCP servers from Hermes…" : "Not connected to Hermes. MCP servers show once it's connected."}</SettingNote>
        ) : (
          <>
            {!connected && (
              <SettingNote tone="warn" role="status">
                <AlertTriangle size={14} />
                <span>Not connected to Hermes. This is the list as read at {clock(list.readAt)}; reconnect to change it.</span>
              </SettingNote>
            )}
            {listNote && (
              <SettingNote tone={listNote.tone === "ok" ? "muted" : listNote.tone === "warn" ? "warn" : "bad"} role={listNote.tone === "bad" ? "alert" : "status"}>
                <span>{listNote.text}</span>
                <button className="icon-btn" aria-label="Dismiss" onClick={() => setListNote(undefined)}>
                  <X size={13} />
                </button>
              </SettingNote>
            )}
            {list.servers.length ? list.servers.map(row) : <SettingNote role="status">This profile has no MCP servers yet.</SettingNote>}
            <SettingRow
              name="Read again"
              hint={`As read at ${clock(list.readAt)}. Another client may have changed it since.`}
              control={
                <button className="btn" disabled={!connected || loading} onClick={() => void load()}>
                  <RefreshCw size={13} aria-hidden /> {loading ? "Reading…" : "Read again"}
                </button>
              }
            />
          </>
        )}
      </SettingsSection>

      <SettingsSection title="When changes take effect" intro="Hermes connects a chat to the profile's MCP servers when it starts the chat.">
        <SettingRow
          name="Adding, editing, removing or switching"
          hint="Chats started from now on get the change. A chat already going keeps the tools it started with."
          more={<p>Hermes builds a chat's tools once. A server turned off stays in the config, so turning it on again needs nothing retyped.</p>}
        />
        <SettingRow
          name="Turned off for a platform"
          hint="Settings → Toolsets' no_mcp turns every MCP server off for one platform's chats in the profile."
          more={
            <p>
              <span className="mono">no_mcp</span> sits in the profile's toolset list for a platform, such as <span className="mono">cli</span> for this app's chats. Hermes takes it out whenever Settings → Toolsets saves a change for that platform.
            </p>
          }
        />
        <SettingRow name="Secrets" hint="Env values and bearer tokens are write-only. Hermes keeps them on the server; this screen never shows them, and a blank one keeps what's saved." />
        <SettingRow
          name="Signing in"
          hint="OAuth sign-in opens the service's page in your browser, which then returns to the Hermes dashboard."
          more={<p>The page returns to the dashboard at the address Hermes Chat uses for it, so finish signing in on this computer while Hermes Chat is connected. Test says whether Hermes has a sign-in for the server.</p>}
        />
      </SettingsSection>

      {dialog?.kind === "add" || dialog?.kind === "edit" ? (
        <ServerDialog
          editing={dialog.kind === "edit" ? dialog.server : undefined}
          taken={names.filter((n) => dialog.kind !== "edit" || n !== dialog.server.name)}
          profile={profile}
          connected={connected}
          save={(form) => (dialog.kind === "edit" ? api.edit(profile, dialog.server.name, form) : api.add(profile, form))}
          onDone={(form, r) => {
            setDialog(undefined);
            settle(profile, form.name, r, dialog.kind === "edit" ? "Saved" : `Added ${form.name}`);
          }}
          onClose={() => setDialog(undefined)}
        />
      ) : dialog?.kind === "catalog" ? (
        <CatalogDialog
          api={api}
          profile={profile}
          connected={connected}
          installed={names}
          onDone={(entry, r) => {
            setDialog(undefined);
            settle(profile, entry.name, r, `Installed ${entry.name}`);
          }}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </>
  );
}

type EnvRow = { key: string; value: string; saved: boolean };

/** The blank form, or `editing`'s fields as Hermes lists them; secrets are never filled in. */
function ServerDialog({
  editing,
  taken,
  profile,
  connected,
  save,
  onDone,
  onClose,
}: {
  editing?: McpServer;
  taken: string[];
  profile: string;
  connected: boolean;
  save: (form: ServerForm) => Promise<McpChange>;
  onDone: (form: ServerForm, r: McpChange) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const titleId = useId();
  const [name, setName] = useState(editing?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">(editing?.transport === "http" ? "http" : "stdio");
  const [command, setCommand] = useState(editing?.command ?? "");
  // One field per argument, as Hermes keeps them: an empty one, or one holding a line break, stays exactly as it is.
  const [args, setArgs] = useState<string[]>(editing?.args ?? []);
  const [env, setEnv] = useState<EnvRow[]>((editing?.envKeys ?? []).map((key) => ({ key, value: "", saved: true })));
  const [url, setUrl] = useState(editing?.url ?? "");
  const [auth, setAuth] = useState<Auth>(editing?.auth ?? "none");
  const [token, setToken] = useState("");
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<McpChange>();
  const open = useRef(true);
  // Set again on each setup: StrictMode runs a cleanup and a setup while the dialog stays open.
  useEffect(() => {
    open.current = true;
    return () => void (open.current = false);
  }, []);

  const form: ServerForm =
    transport === "stdio"
      ? {
          transport,
          name: name.trim(),
          command,
          args,
          // A saved variable left blank keeps Hermes's value; a new one sends what's typed.
          env: env.map((e) => (e.saved && e.value === "" ? { key: e.key.trim() } : { key: e.key.trim(), value: e.value })),
        }
      : { transport, name: name.trim(), url, auth, ...(auth === "header" && token.trim() && { bearerToken: token }) };
  const savedHeader = editing?.transport === "http" && editing.auth === "header";
  const problem = formProblem(form, !!editing, taken) ?? (transport === "http" && auth === "header" && !token.trim() && !savedHeader ? "Paste the bearer token." : undefined);
  const renamedOAuth = editing && editing.name !== form.name && editing.auth === "oauth";

  const submit = async () => {
    setTouched(true);
    if (problem || sending) return;
    setSending(true);
    setOutcome(undefined);
    const r = await save(form);
    if (!open.current) return;
    setSending(false);
    if (r.kind === "saved") return onDone(form, r);
    // Whatever reached Hermes, the secrets typed don't stay on screen.
    if (r.kind === "unconfirmed") {
      setToken("");
      setEnv((rows) => rows.map((e) => ({ ...e, value: "", saved: e.saved || r.list?.servers.find((s) => s.name === form.name)?.envKeys.includes(e.key) === true })));
    }
    setOutcome(r);
  };

  const close = () => !sending && onClose();
  return (
    <div className="leave-overlay">
      <div
        ref={box}
        className="leave-dialog mcp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={sending}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title mcp-title">
          {editing ? (
            <>
              Edit <span className="mono">{editing.name}</span>
            </>
          ) : (
            "Add an MCP server"
          )}{" "}
          <span className="muted small">in {profile}</span>
        </h2>
        <form
          className="mcp-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label className="field-label" htmlFor={`${titleId}-name`}>
              Name
            </label>
            <input id={`${titleId}-name`} aria-describedby={`${titleId}-name-hint`} autoFocus value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoComplete="off" />
            <span className="field-hint" id={`${titleId}-name-hint`}>
              Its tools are named after it, such as mcp_{name.trim() || "github"}_….
            </span>
          </div>
          {renamedOAuth && <p className="field-hint block">Hermes keeps its OAuth sign-in under the old name: sign in again after renaming it.</p>}
          <fieldset className="mcp-transport">
            <legend className="field-label">How Hermes reaches it</legend>
            <label>
              <input type="radio" name="mcp-transport" checked={transport === "stdio"} onChange={() => setTransport("stdio")} /> Runs a command on the server (stdio)
            </label>
            <label>
              <input type="radio" name="mcp-transport" checked={transport === "http"} onChange={() => setTransport("http")} /> Connects to a URL (HTTP or SSE)
            </label>
          </fieldset>
          {transport === "stdio" ? (
            <>
              <label className="field">
                <span className="field-label">Command</span>
                <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" spellCheck={false} autoComplete="off" />
              </label>
              <div className="field">
                <span className="field-label">Arguments</span>
                {args.map((a, i) => (
                  <div className="mcp-arg-row" key={i}>
                    {a.includes("\n") ? (
                      // An argument with a line break (an inline script) keeps it.
                      <textarea className="mcp-args mono" rows={Math.min(6, a.split("\n").length)} aria-label={`Argument ${i + 1}`} value={a} onChange={(e) => setArgs((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} spellCheck={false} />
                    ) : (
                      <input className="mono" aria-label={`Argument ${i + 1}`} value={a} onChange={(e) => setArgs((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} placeholder={i === 0 ? "-y" : ""} spellCheck={false} autoComplete="off" />
                    )}
                    <button type="button" className="icon-btn" aria-label={`Remove argument ${i + 1}`} onClick={() => setArgs((xs) => xs.filter((_, j) => j !== i))}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
                <button type="button" className="link mcp-add-env" onClick={() => setArgs((xs) => [...xs, ""])}>
                  Add an argument
                </button>
              </div>
              <div className="field">
                <span className="field-label">Environment variables</span>
                {env.map((e, i) => (
                  <div className="mcp-env-row" key={i}>
                    <input
                      className="mono"
                      aria-label={`Variable ${i + 1} name`}
                      value={e.key}
                      disabled={e.saved}
                      onChange={(ev) => setEnv((rows) => rows.map((r, j) => (j === i ? { ...r, key: ev.target.value } : r)))}
                      placeholder="API_KEY"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <input
                      type="password"
                      aria-label={`${e.key || `Variable ${i + 1}`} value`}
                      value={e.value}
                      onChange={(ev) => setEnv((rows) => rows.map((r, j) => (j === i ? { ...r, value: ev.target.value } : r)))}
                      placeholder={e.saved ? "Saved on the server; blank keeps it" : "Value"}
                      autoComplete="new-password"
                    />
                    <button type="button" className="icon-btn" aria-label={`Remove ${e.key || `variable ${i + 1}`}`} onClick={() => setEnv((rows) => rows.filter((_, j) => j !== i))}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
                <button type="button" className="link mcp-add-env" onClick={() => setEnv((rows) => [...rows, { key: "", value: "", saved: false }])}>
                  Add a variable
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="field">
                <span className="field-label">URL</span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} autoComplete="off" />
              </label>
              <label className="field">
                <span className="field-label">Sign-in</span>
                <select value={auth} onChange={(e) => setAuth(e.target.value as Auth)}>
                  <option value="none">None</option>
                  <option value="header">Bearer token</option>
                  <option value="oauth">OAuth (sign in from the list after saving)</option>
                </select>
              </label>
              {auth === "header" && (
                <div className="field">
                  <label className="field-label" htmlFor={`${titleId}-token`}>
                    Bearer token
                  </label>
                  <input
                    id={`${titleId}-token`}
                    aria-describedby={`${titleId}-token-hint`}
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={savedHeader ? "Saved on the server; blank keeps it" : "Paste the token"}
                    autoComplete="new-password"
                  />
                  <span className="field-hint" id={`${titleId}-token-hint`}>
                    Hermes keeps it in the profile's .env, as {envKeyFor(name.trim() || "name")}.
                  </span>
                </div>
              )}
            </>
          )}
          {touched && problem && (
            <p className="field-hint err" role="alert">
              {problem}
            </p>
          )}
          {outcome && outcome.kind !== "saved" && (
            <p className={`mcp-note ${outcome.kind === "refused" ? "bad" : "warn"}`} role="alert">
              {changeNote(outcome, "Saved").text}
            </p>
          )}
          <div className="mcp-actions mcp-dialog-actions">
            <button type="button" className="btn" disabled={sending} onClick={close}>
              {outcome?.kind === "unconfirmed" ? "Close" : "Cancel"}
            </button>
            <button type="submit" className="btn primary" disabled={!connected || sending || (touched && !!problem)}>
              {sending ? (
                <>
                  <Spinner /> Saving…
                </>
              ) : editing ? (
                "Save"
              ) : (
                "Add"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Hermes's catalog of known servers: pick one, see what it runs, give the values it asks for, install it. */
function CatalogDialog({
  api,
  profile,
  connected,
  installed,
  onDone,
  onClose,
}: {
  api: McpApi;
  profile: string;
  connected: boolean;
  installed: string[];
  onDone: (entry: CatalogEntry, r: McpChange) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const titleId = useId();
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<CatalogEntry>();
  const [env, setEnv] = useState<Map<string, string>>(new Map());
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<McpChange>();
  const open = useRef(true);
  useEffect(() => {
    // Set again on each setup: StrictMode runs a cleanup and a setup while the dialog stays open.
    open.current = true;
    api.catalog(profile).then(
      (c) => open.current && setCatalog(c),
      (e) => open.current && setError(errorText(e)),
    );
    return () => void (open.current = false);
  }, []);

  const missing = picked?.requiredEnv.filter((v) => v.required && !env.get(v.name)?.trim()) ?? [];
  const install = async () => {
    if (!picked || missing.length || sending) return;
    setSending(true);
    setOutcome(undefined);
    const r = await api.install(profile, picked, Object.fromEntries(env));
    if (!open.current) return;
    setSending(false);
    setEnv(new Map());
    if (r.kind === "saved") return onDone(picked, r);
    setOutcome(r);
  };
  const close = () => !sending && onClose();

  return (
    <div className="leave-overlay">
      <div
        ref={box}
        className="leave-dialog mcp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={sending || (!catalog && !error)}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title mcp-title">
          Add from Hermes's catalog <span className="muted small">in {profile}</span>
        </h2>
        {error && (
          <p className="mcp-note bad" role="alert">
            Couldn't read the catalog: {error}
          </p>
        )}
        {!catalog && !error && (
          <p role="status">
            <Spinner /> Reading the catalog from Hermes…
          </p>
        )}
        {catalog && !picked && (
          <>
            {catalog.entries.length ? (
              <ul className="mcp-catalog" aria-label="Catalog">
                {catalog.entries.map((e) => (
                  <li key={e.name}>
                    <button
                      className="mcp-catalog-item"
                      autoFocus={e === catalog.entries[0]}
                      disabled={e.installed || installed.includes(e.name)}
                      onClick={() => {
                        setPicked(e);
                        setEnv(new Map());
                      }}
                    >
                      <span className="mono">{e.name}</span>
                      {(e.installed || installed.includes(e.name)) && <span className="badge">Added</span>}
                      <span className="muted">{e.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Hermes's catalog is empty on this server.</p>
            )}
            {catalog.problems.length > 0 && <p className="field-hint block">Hermes couldn't read some entries: {catalog.problems.join("; ")}</p>}
          </>
        )}
        {picked && (
          <div className="mcp-form">
            <p>
              <span className="mono">{picked.name}</span>: {picked.description}
            </p>
            <dl className="mcp-identity">
              <div>
                <dt>{picked.url ? "URL" : "Runs"}</dt>
                <dd className="mono">{picked.url ?? [picked.command, ...picked.args].join(" ")}</dd>
              </div>
              {picked.needsInstall && (
                <div>
                  <dt>Builds from</dt>
                  <dd className="mono">
                    {picked.installUrl}
                    {picked.bootstrap.length > 0 && ` then ${picked.bootstrap.join(" && ")}`}
                  </dd>
                </div>
              )}
              {picked.authType === "oauth" && (
                <div>
                  <dt>Sign-in</dt>
                  <dd>OAuth: sign in from the list once it's added.</dd>
                </div>
              )}
            </dl>
            {picked.needsInstall && <p className="field-hint block">Hermes clones and builds it on the server, in the background, before it's added.</p>}
            {picked.requiredEnv.map((v) => (
              <label className="field" key={v.name}>
                <span className="field-label">
                  {v.prompt || v.name} <span className="mono muted">{v.name}</span>
                  {!v.required && <span className="muted">(optional)</span>}
                </span>
                <input type="password" value={env.get(v.name) ?? ""} onChange={(e) => setEnv((m) => new Map(m).set(v.name, e.target.value))} autoComplete="new-password" />
              </label>
            ))}
            {outcome && outcome.kind !== "saved" && (
              <p className={`mcp-note ${outcome.kind === "refused" ? "bad" : "warn"}`} role="alert">
                {changeNote(outcome, "Installed").text}
              </p>
            )}
          </div>
        )}
        <div className="mcp-actions mcp-dialog-actions">
          {picked && (
            <button className="btn" disabled={sending} onClick={() => (setPicked(undefined), setOutcome(undefined))}>
              Back
            </button>
          )}
          <button className="btn" disabled={sending} onClick={close}>
            Cancel
          </button>
          {picked && (
            <button className="btn primary" disabled={!connected || sending || missing.length > 0} onClick={() => void install()}>
              {sending ? (
                <>
                  <Spinner /> Installing…
                </>
              ) : (
                "Install"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
