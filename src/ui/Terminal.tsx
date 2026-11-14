// The side panel's Terminal (ADR 0022, ADR 0039, ADR 0051): a shell on the Hermes server through the owner's own ssh,
// and a shell on this computer, each in a terminal of its own. It opens on the one picked last, the server's until then. Both stay alive while the owner is in another tab or the panel is
// hidden. Ending a session, or its shell exiting, keeps what was printed, with a way to start again. A folder a reply
// named gets a shell of its own beside them, started in that folder (a folder shell, ADR 0167).
import { useEffect, useRef, useState } from "react";
import { Folder, Laptop, Play, Plug, Server, X } from "lucide-react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalSession, endedText, type ShellId, type Shells, type TerminalApi, type TerminalKind, type TerminalState } from "../hermes/terminal";
import type { ServerPath } from "../hermes/paths";
import { withoutBidi } from "../hermes/preview";
import { Spinner } from "./bits";

/** The terminal's colours and font, from the app's theme (appearance.ts sets these on the root). */
function look(): { theme: ITheme; fontFamily: string; fontSize: number } {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    theme: {
      background: v("--code-bg", "#0d0d0f"),
      foreground: v("--text", "#e7e7ea"),
      cursor: v("--accent", "#d97757"),
      cursorAccent: v("--code-bg", "#0d0d0f"),
      selectionBackground: v("--accent-soft", "rgba(217, 119, 87, 0.3)"),
      scrollbarSliderBackground: v("--line-2", "rgba(255, 255, 255, 0.12)"),
      scrollbarSliderHoverBackground: v("--line-3", "rgba(255, 255, 255, 0.22)"),
      scrollbarSliderActiveBackground: v("--line-3", "rgba(255, 255, 255, 0.22)"),
    },
    fontFamily: v("--mono", "monospace"),
    fontSize: parseFloat(v("--mono-size", "13px")) || 13,
  };
}

/**
 * One terminal. `server`: ssh to `initialTarget`, or to one the owner types. `local`: the owner's own login shell on
 * this computer, which Rust picks; `initialTarget` only labels it. `folder`: the folder its shell starts in, each time
 * it starts.
 */
export function TerminalScreen({
  kind = "server",
  api,
  initialTarget,
  guessed = false,
  shown,
  folder,
  again,
  onTarget,
  onRunning,
  onOther,
}: {
  kind?: TerminalKind;
  api: TerminalApi;
  /** Where to connect: the target last used for the terminal, or the sign-in's. Empty asks the owner first. */
  initialTarget: string;
  /** `initialTarget` was worked out from the sign-in's web address (ADR 0055), so ssh failing may mean it's wrong. */
  guessed?: boolean;
  /** False while the owner is elsewhere: the session keeps running out of sight. */
  shown: boolean;
  folder?: ServerPath;
  /** Changes each time the owner asks for this shell again: one that has ended then starts again. */
  again?: number;
  /** A target the owner typed and connected to, to use next time. */
  onTarget?: (target: string) => void;
  /** Whether the shell is running, for the rail and the panel's tabs. */
  onRunning?: (running: boolean) => void;
  /** Show the other computer's shell instead: offered when the server has no SSH target. */
  onOther?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const targetField = useRef<HTMLInputElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm>(undefined);
  const fit = useRef<FitAddon>(undefined);
  const session = useRef<TerminalSession>(undefined);
  const [state, setState] = useState<TerminalState>({ kind: "idle" });
  const [target, setTarget] = useState(initialTarget);
  const onRunningRef = useRef(onRunning);
  onRunningRef.current = onRunning;
  // A `ServerPath` holds no control character, so the folder is only words to xterm too.
  const inFolder = folder === undefined ? "" : `, in ${withoutBidi(folder)}`;

  const connect = (to: string) => {
    const t = term.current;
    const s = session.current;
    if (!t || !s || !to.trim()) return;
    fit.current?.fit();
    if (s.state.kind !== "idle") t.write("\r\n");
    // The cursor shows only while a session runs.
    t.write(`\x1b[?25h\x1b[2m── ${kind === "local" ? "this computer" : `ssh ${to.trim()}`}${inFolder} ──\x1b[0m\r\n`);
    void s.start(to, t.cols, t.rows);
    t.focus();
  };

  useEffect(() => {
    const t = new XTerm({ ...look(), cursorBlink: true, scrollback: 5000, allowProposedApi: false });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    const s = new TerminalSession(
      api,
      (data) => t.write(data),
      (st) => {
        if (st.kind === "ended" || st.kind === "failed") t.write("\x1b[?25l");
        setState(st);
        onRunningRef.current?.(st.kind === "connecting" || st.kind === "open");
      },
      folder,
    );
    session.current = s;
    const typed = t.onData((d) => s.input(d));
    const resized = t.onResize(({ cols, rows }) => s.resize(cols, rows));
    // Copy and paste as other Linux terminals do; plain Ctrl+C and Ctrl+V go to the shell.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.altKey) return true;
      if (e.code === "KeyC") {
        if (t.hasSelection()) void navigator.clipboard?.writeText(t.getSelection()).catch(() => {});
        e.preventDefault();
        return false;
      }
      if (e.code === "KeyV") {
        void navigator.clipboard?.readText().then((text) => t.paste(text)).catch(() => {});
        e.preventDefault();
        return false;
      }
      return true;
    });
    // Follow the app's theme and font as Appearance changes them.
    const themed = new MutationObserver(() => {
      const l = look();
      t.options.theme = l.theme;
      t.options.fontFamily = l.fontFamily;
      t.options.fontSize = l.fontSize;
      f.fit();
    });
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-mode", "class"] });
    const sized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => host.current?.offsetParent && f.fit());
    sized?.observe(host.current!);
    // The app's own shortcuts (Ctrl+K, Ctrl+N, Ctrl+B, Ctrl+F…) listen on the window; in here those keys are the shell's.
    const screen = screenRef.current!;
    const keep = (e: KeyboardEvent) => {
      if (host.current?.contains(e.target as Node)) e.stopPropagation();
    };
    screen.addEventListener("keydown", keep);
    // A local shell starts at once, as any terminal does; the server's when there is a target to connect to.
    if (kind === "local") connect("this computer");
    else if (initialTarget.trim()) connect(initialTarget);
    else t.write("\x1b[?25l");
    return () => {
      screen.removeEventListener("keydown", keep);
      sized?.disconnect();
      themed.disconnect();
      typed.dispose();
      resized.dispose();
      s.dispose();
      onRunningRef.current?.(false);
      t.dispose();
    };
    // Made once for the life of the screen; `connect`, `initialTarget` and `folder` are read at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Asked for again: a shell still running is only shown, and one that ended or couldn't start starts again.
  const asked = useRef(again);
  useEffect(() => {
    if (asked.current === again) return;
    asked.current = again;
    if (session.current?.running) return;
    if (kind === "local") connect("this computer");
    else if (session.current?.state.kind !== "idle") connect(target);
    // Only `again` starts it; `connect` and `target` are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [again]);

  // Shown again: fit to the space it has now, and take the keys. With no target yet, the field to set one takes them.
  useEffect(() => {
    if (!shown) return;
    fit.current?.fit();
    if (kind === "server" && session.current?.state.kind === "idle" && !initialTarget.trim()) targetField.current?.focus();
    else term.current?.focus();
    // `initialTarget` is read once, as at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const running = state.kind === "connecting" || state.kind === "open";
  const submit = () => {
    if (!target.trim() || running) return;
    // Connecting again to the target worked out from the web address keeps it a guess, following the address.
    if (!(guessed && target.trim() === initialTarget.trim())) onTarget?.(target.trim());
    connect(target);
  };
  const what = `${kind === "local" ? "A shell on this computer" : "A shell on the Hermes server"}${inFolder}`;
  // No SSH target from the sign-in or its web address (ADR 0055), and none typed for this connection yet: say so, rather than a bare field.
  const noTarget = kind === "server" && state.kind === "idle" && !initialTarget.trim();
  // The guess from the web address didn't get in, and nothing else has been tried: say where it came from.
  const guessFailed = kind === "server" && guessed && target.trim() === initialTarget.trim() && ((state.kind === "ended" && !state.byOwner && state.code === 255) || state.kind === "failed");

  return (
    <div className="terminal-screen" ref={screenRef} hidden={!shown} data-kind={kind}>
      <div className="terminal-title">
        {state.kind !== "idle" && (
          <span className="mono muted terminal-where" title={folder === undefined ? undefined : withoutBidi(folder)}>
            {kind === "local" ? "your login shell" : `ssh ${state.target}`}
            {inFolder}
          </span>
        )}
        <span className={`terminal-status ${state.kind}`} role="status" aria-label={`${what}: ${statusWord(state)}`}>
          {state.kind === "connecting" ? (
            <>
              <Spinner /> {kind === "local" ? "Starting…" : "Connecting…"}
            </>
          ) : (
            statusWord(state)
          )}
        </span>
        <span className="terminal-spacer" />
        {running && (
          <button className="btn" onClick={() => session.current?.end()} title={kind === "local" ? "Ends the shell on this computer" : "Ends ssh and the shell on the server"}>
            <X size={14} /> End session
          </button>
        )}
      </div>
      {!running &&
        (kind === "local" ? (
          <div className="terminal-connect">
            <p className={state.kind === "failed" ? "bad" : "muted"}>
              {state.kind === "ended"
                ? endedText(state, kind)
                : state.kind === "failed"
                  ? state.message
                  : "Your own login shell on this computer, in your home folder. It runs as you, with everything you can do in any other terminal; Hermes never sees it."}
            </p>
            <div className="terminal-connect-row">
              <button className="btn primary" onClick={() => connect("this computer")}>
                <Play size={14} /> {state.kind === "idle" ? "Start" : "Start again"}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="terminal-connect"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {noTarget ? (
              <div className="terminal-no-target">
                <p>
                  <strong>No SSH target for the Hermes server.</strong>
                </p>
                <p className="muted">
                  This connection signs in with a web address that doesn't name the server (one on this computer, such as localhost), so the app can't tell how to reach it over ssh. Set an SSH target, such as liam@hermes, to open a shell there. The app keeps it for this connection. Your ~/.ssh/config, keys and agent apply.
                </p>
              </div>
            ) : (
              <p className={state.kind === "failed" ? "bad" : "muted"}>
                {state.kind === "ended"
                  ? endedText(state, kind)
                  : state.kind === "failed"
                    ? state.message
                    : "A shell on the Hermes server, through your own ssh: your ~/.ssh/config, keys and agent apply, and ssh asks here for anything it needs."}
              </p>
            )}
            {guessFailed && (
              <p className="muted terminal-guess">
                The app took <span className="mono">{initialTarget}</span> from the address you sign in with. If you sign in to the server as someone else, set the target as user@host here, or add a Host entry with a User line to ~/.ssh/config.
              </p>
            )}
            <div className="terminal-connect-row">
              <label>
                <span>SSH target</span>
                <input ref={targetField} className="mono" value={target} placeholder="liam@hermes" spellCheck={false} autoCapitalize="off" onChange={(e) => setTarget(e.target.value)} />
              </label>
              <button className="btn primary" type="submit" disabled={!target.trim()}>
                <Plug size={14} /> {noTarget ? "Set and connect" : state.kind === "idle" ? "Connect" : "Connect again"}
              </button>
              {noTarget && onOther && (
                <button className="btn" type="button" onClick={onOther}>
                  <Laptop size={14} /> Use this computer instead
                </button>
              )}
            </div>
          </form>
        ))}
      <div className="terminal-body">
        <div className="terminal-host" ref={host} aria-label={`${kind === "local" ? "Terminal on this computer" : "Terminal on the server"}${inFolder}`} />
      </div>
      <p className="terminal-foot faint">Ctrl+Shift+C copies the selection and Ctrl+Shift+V pastes. The session keeps running in other tabs.</p>
    </div>
  );
}

function statusWord(s: TerminalState) {
  return s.kind === "connecting" ? "Connecting" : s.kind === "open" ? "Connected" : s.kind === "ended" ? "Ended" : s.kind === "failed" ? "Couldn't start" : "Not connected";
}

/**
 * The Terminal tab: the Hermes server's shell and this computer's, then a shell for each folder opened from a reply
 * (ADR 0167), one shown at a time, switched at the top. `shells` says which there are and which is shown
 * (useShells.ts). The server's and this computer's are each made the first time they are shown, and a folder shell
 * when it is opened; each is kept from then on, so its session runs on while another is shown. Closing a folder shell
 * ends it.
 */
export function TerminalTab({
  server,
  local,
  shown,
  shells,
  onShow,
  onClose,
  onLocal,
  onRunning,
}: {
  server: { api: TerminalApi; initialTarget: string; guessed?: boolean; onTarget: (target: string) => void };
  local: { api: TerminalApi };
  shown: boolean;
  shells: Shells;
  onShow: (id: ShellId) => void;
  onClose: (id: ShellId) => void;
  /** Start folder shell `id` on this computer instead: offered when the server has no SSH target. */
  onLocal: (id: ShellId) => void;
  /** Which computers have a shell running, for the rail's dot. */
  onRunning?: (running: Record<TerminalKind, boolean>) => void;
}) {
  const at = shells.shown;
  const [made, setMade] = useState<Record<TerminalKind, boolean>>({ server: at === "server", local: at === "local" });
  const [running, setRunning] = useState<Partial<Record<ShellId, boolean>>>({});
  const onRunningRef = useRef(onRunning);
  onRunningRef.current = onRunning;
  useEffect(() => {
    if ((at === "server" || at === "local") && !made[at]) setMade((m) => ({ ...m, [at]: true }));
  }, [at, made]);
  useEffect(() => {
    const on = (kind: TerminalKind) => !!running[kind] || shells.folders.some((f) => f.kind === kind && running[f.id]);
    onRunningRef.current?.({ server: on("server"), local: on("local") });
  }, [running, shells.folders]);
  const ran = (id: ShellId) => (on: boolean) => setRunning((r) => (!!r[id] === on ? r : { ...r, [id]: on }));
  const dot = (id: ShellId) => running[id] && <span className="dot run-dot" role="img" aria-label="(running)" />;
  return (
    <div className="terminal-tab" hidden={!shown}>
      <div className="terminal-shells">
        <div className="segmented terminal-kinds" role="group" aria-label="Which computer">
          <button aria-pressed={at === "server"} onClick={() => onShow("server")} title="A shell on the Hermes server, through your ssh">
            <Server size={13} /> Hermes server {dot("server")}
          </button>
          <button aria-pressed={at === "local"} onClick={() => onShow("local")} title="A shell on this computer">
            <Laptop size={13} /> This computer {dot("local")}
          </button>
        </div>
        {shells.folders.map((f) => {
          const path = withoutBidi(f.folder);
          const name = path.split("/").filter(Boolean).pop() ?? path;
          return (
            <span className="terminal-folder" key={f.id} role="group" aria-label={`Shell in ${path}`}>
              <button aria-pressed={at === f.id} onClick={() => onShow(f.id)} title={`${path}\nA shell started in this folder ${f.kind === "local" ? "on this computer" : "on the Hermes server"}`}>
                <Folder size={13} /> <span>{name}</span> {dot(f.id)}
              </button>
              <button className="terminal-folder-close" aria-label={`Close the shell in ${name}`} title="Ends this shell and closes it" onClick={() => onClose(f.id)}>
                <X size={12} />
              </button>
            </span>
          );
        })}
      </div>
      {made.server && <TerminalScreen kind="server" api={server.api} initialTarget={server.initialTarget} guessed={server.guessed} onTarget={server.onTarget} shown={shown && at === "server"} onRunning={ran("server")} onOther={() => onShow("local")} />}
      {made.local && <TerminalScreen kind="local" api={local.api} initialTarget="" shown={shown && at === "local"} onRunning={ran("local")} />}
      {shells.folders.map((f) =>
        f.kind === "server" ? (
          <TerminalScreen key={f.id} kind="server" api={server.api} initialTarget={server.initialTarget} guessed={server.guessed} onTarget={server.onTarget} folder={f.folder} again={f.asked} shown={shown && at === f.id} onRunning={ran(f.id)} onOther={() => onLocal(f.id)} />
        ) : (
          <TerminalScreen key={f.id} kind="local" api={local.api} initialTarget="" folder={f.folder} again={f.asked} shown={shown && at === f.id} onRunning={ran(f.id)} />
        ),
      )}
    </div>
  );
}
