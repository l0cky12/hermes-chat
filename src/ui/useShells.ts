// The Terminal tab's shells as the app holds them (terminal.ts `Shells`, ADR 0167), above the tab itself: a path in a
// reply opens a folder shell whether or not the tab has been shown yet.
import { useMemo, useRef, useState } from "react";
import { closeShell, moveShell, openShellIn, showShell, shellsAt, type ShellId, type Shells, type TerminalKind } from "../hermes/terminal";
import type { ServerPath } from "../hermes/paths";
import { getUIPrefs, setUIPrefs } from "../hermes/uiPrefs";

/**
 * `shells` opens on the computer picked last (uiPrefs `terminalKind`, ADR 0039), and picking the server's shell or
 * this computer's keeps that pick. `openIn` is false when the tab already holds as many folder shells as it takes.
 * The steps are the same functions on every render.
 */
export function useShells() {
  const [shells, setShells] = useState(() => shellsAt(getUIPrefs().terminalKind));
  // The newest value, so two steps before a render both build on it.
  const now = useRef(shells);
  const steps = useMemo(() => {
    const step = (next: Shells) => {
      now.current = next;
      setShells(next);
    };
    return {
      show(id: ShellId) {
        step(showShell(now.current, id));
        if (id === "server" || id === "local") setUIPrefs({ terminalKind: id });
      },
      close: (id: ShellId) => step(closeShell(now.current, id)),
      move: (id: ShellId, kind: TerminalKind) => step(moveShell(now.current, id, kind)),
      openIn(kind: TerminalKind, folder: ServerPath): boolean {
        const next = openShellIn(now.current, kind, folder);
        if (next !== "full") step(next);
        return next !== "full";
      },
    };
  }, []);
  return { shells, ...steps };
}
