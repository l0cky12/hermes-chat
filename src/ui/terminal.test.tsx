// @vitest-environment jsdom
// The Terminal screen: it connects at once to a known target and asks for one otherwise, keeps the shell's keys from
// the app's shortcuts, ends and reconnects, and closes ssh when it goes. xterm.js itself is stood in for: jsdom can't
// draw it.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellsAt, type TerminalApi, type TerminalEvent } from "../hermes/terminal";
import { resolvePath, type ServerPath } from "../hermes/paths";
import { getUIPrefs } from "../hermes/uiPrefs";
import { useShells } from "./useShells";

const xterms: FakeXTerm[] = [];
class FakeXTerm {
  cols = 100;
  rows = 30;
  written: string[] = [];
  options: Record<string, unknown> = {};
  data?: (d: string) => void;
  el?: HTMLElement;
  disposed = false;
  constructor() {
    xterms.push(this);
  }
  loadAddon() {}
  open(el: HTMLElement) {
    this.el = el;
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    el.appendChild(ta);
  }
  write(d: string | Uint8Array) {
    this.written.push(typeof d === "string" ? d : new TextDecoder().decode(d));
  }
  onData(f: (d: string) => void) {
    this.data = f;
    return { dispose() {} };
  }
  onResize() {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler() {}
  hasSelection() {
    return false;
  }
  getSelection() {
    return "";
  }
  paste() {}
  focus() {}
  dispose() {
    this.disposed = true;
  }
}
vi.mock("@xterm/xterm", () => ({ Terminal: FakeXTerm }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

const { TerminalScreen, TerminalTab } = await import("./Terminal");

class FakeTerminals implements TerminalApi {
  opened: { target: string; cols: number; rows: number; emit: (e: TerminalEvent) => void; folder?: string }[] = [];
  written: string[] = [];
  closed: number[] = [];
  /** Why `open` is refused, while set. */
  refuse?: string;
  open(target: string, cols: number, rows: number, emit: (e: TerminalEvent) => void, folder?: string) {
    if (this.refuse) return Promise.reject(new Error(this.refuse));
    this.opened.push({ target, cols, rows, emit, folder });
    return Promise.resolve(this.opened.length);
  }
  write(_id: number, data: string) {
    this.written.push(data);
    return Promise.resolve();
  }
  resize() {
    return Promise.resolve();
  }
  close(id: number) {
    this.closed.push(id);
  }
}

const out = (s: string) => ({ kind: "output" as const, data: new TextEncoder().encode(s) });

afterEach(() => {
  cleanup();
  xterms.length = 0;
});

function show(initialTarget: string, api = new FakeTerminals()) {
  const onTarget = vi.fn();
  const onRunning = vi.fn();
  const r = render(<TerminalScreen api={api} initialTarget={initialTarget} shown onTarget={onTarget} onRunning={onRunning} />);
  return { api, onTarget, onRunning, ...r };
}

describe("Terminal on the server", () => {
  it("connects straight away to the sign-in's SSH target, at the terminal's size", async () => {
    const { api, onRunning } = show("liam@hermes");
    await act(async () => {});
    expect(api.opened).toMatchObject([{ target: "liam@hermes", cols: 100, rows: 30 }]);
    expect(screen.getByRole("status").textContent?.trim()).toBe("Connecting…");
    expect(screen.queryByLabelText("SSH target")).toBeNull();
    act(() => api.opened[0].emit(out("Welcome to hermes\r\nliam@hermes:~$ ")));
    expect(screen.getByRole("status").textContent).toBe("Connected");
    expect(xterms[0].written.join("")).toContain("Welcome to hermes");
    expect(onRunning).toHaveBeenLastCalledWith(true);
    act(() => xterms[0].data!("uptime\r"));
    expect(api.written).toEqual(["uptime\r"]);
  });

  it("asks for a target when the sign-in has none, and remembers the one typed", async () => {
    const { api, onTarget } = show("");
    expect(api.opened).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("Not connected");
    const connect = screen.getByRole("button", { name: /connect/i }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("SSH target"), { target: { value: " root@hermes " } });
    await act(async () => fireEvent.click(connect));
    expect(onTarget).toHaveBeenCalledWith("root@hermes");
    expect(api.opened[0].target).toBe("root@hermes");
  });

  it("keeps the shell's keys from the app's own shortcuts", async () => {
    show("hermes");
    await act(async () => {});
    const appShortcut = vi.fn();
    window.addEventListener("keydown", appShortcut);
    try {
      fireEvent.keyDown(xterms[0].el!.querySelector("textarea")!, { key: "k", ctrlKey: true });
      expect(appShortcut).not.toHaveBeenCalled();
      // Outside the terminal itself, the app's keys still work.
      fireEvent.keyDown(screen.getByRole("button", { name: /end session/i }), { key: "k", ctrlKey: true });
      expect(appShortcut).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", appShortcut);
    }
  });

  it("ends the session, says so, and connects again below what was printed", async () => {
    const { api, onRunning } = show("hermes");
    await act(async () => {});
    act(() => api.opened[0].emit(out("$ ")));
    fireEvent.click(screen.getByRole("button", { name: /end session/i }));
    expect(api.closed).toEqual([1]);
    act(() => api.opened[0].emit({ kind: "exit", code: null }));
    expect(screen.getByText("You ended the session.")).toBeTruthy();
    expect(onRunning).toHaveBeenLastCalledWith(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /connect again/i })));
    expect(api.opened).toHaveLength(2);
    expect(xterms[0].written.join("")).toMatch(/\$ [^\n]*\r\n.*ssh hermes/);
  });

  it("shows ssh's own failure as it printed it", async () => {
    const { api } = show("nowhere");
    await act(async () => {});
    act(() => api.opened[0].emit(out("ssh: Could not resolve hostname nowhere\r\n")));
    act(() => api.opened[0].emit({ kind: "exit", code: 255 }));
    expect(screen.getByText(/ssh couldn't connect or lost the connection/)).toBeTruthy();
    expect(xterms[0].written.join("")).toContain("Could not resolve hostname");
  });

  it("closes ssh when the screen goes, as at sign out", async () => {
    const { api, unmount } = show("hermes");
    await act(async () => {});
    unmount();
    expect(api.closed).toEqual([1]);
    expect(xterms[0].disposed).toBe(true);
  });
});

describe("Terminal on this computer", () => {
  it("starts the owner's own shell at once, with no target to ask for, and starts again once it ends", async () => {
    const api = new FakeTerminals();
    render(<TerminalScreen kind="local" api={api} initialTarget="" shown />);
    await act(async () => {});
    expect(api.opened).toHaveLength(1);
    expect(screen.queryByLabelText("SSH target")).toBeNull();
    act(() => api.opened[0].emit(out("liam@laptop:~$ ")));
    expect(screen.getByRole("status").textContent).toBe("Connected");
    act(() => api.opened[0].emit({ kind: "exit", code: 255 }));
    // 255 is ssh's own failure; for a local shell it is only an exit status.
    expect(screen.getByText("The session ended with exit status 255.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /start again/i })));
    expect(api.opened).toHaveLength(2);
  });
});

describe("The Terminal tab", () => {
  it("keeps the server's and this computer's sessions both running while one is shown", async () => {
    const server = new FakeTerminals();
    const local = new FakeTerminals();
    const onRunning = vi.fn();
    const tab = (kind: "server" | "local") => (
      <TerminalTab server={{ api: server, initialTarget: "liam@hermes", onTarget: () => {} }} local={{ api: local }} shown shells={shellsAt(kind)} onShow={() => {}} onClose={() => {}} onLocal={() => {}} onRunning={onRunning} />
    );
    const { rerender } = render(tab("server"));
    await act(async () => {});
    expect(server.opened).toHaveLength(1);
    // This computer's shell isn't started until its tab is picked.
    expect(local.opened).toHaveLength(0);
    act(() => server.opened[0].emit(out("$ ")));
    rerender(tab("local"));
    await act(async () => {});
    expect(local.opened).toHaveLength(1);
    act(() => local.opened[0].emit(out("% ")));
    expect(onRunning).toHaveBeenLastCalledWith({ server: true, local: true });
    rerender(tab("server"));
    expect(server.closed).toEqual([]);
    expect(local.closed).toEqual([]);
    expect(screen.getByRole("button", { name: /This computer/ }).getAttribute("aria-pressed")).toBe("false");
    expect(xterms).toHaveLength(2);
  });
});

/** What `useShells` gives the app, for a test to open a folder shell as a click on a path does. */
type Held = { current?: ReturnType<typeof useShells> };

/** The Terminal tab as the app shows it: its shells are held above it, as App.tsx holds them (useShells.ts). */
function Panel({
  server,
  local,
  initialTarget,
  guessed,
  onTarget = () => {},
  held,
  onRunning,
}: {
  server: FakeTerminals;
  local: FakeTerminals;
  initialTarget: string;
  guessed?: boolean;
  onTarget?: (t: string) => void;
  held?: Held;
  onRunning?: (running: { server: boolean; local: boolean }) => void;
}) {
  const shells = useShells();
  if (held) held.current = shells;
  return (
    <TerminalTab
      server={{ api: server, initialTarget, guessed, onTarget }}
      local={{ api: local }}
      shown
      shells={shells.shells}
      onShow={shells.show}
      onClose={shells.close}
      onLocal={(id) => shells.move(id, "local")}
      onRunning={onRunning}
    />
  );
}
const pressed = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

describe("Which computer the Terminal opens on", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("opens on the Hermes server by default, over ssh to the sign-in's target, and starts nothing on this computer", async () => {
    const server = new FakeTerminals();
    const local = new FakeTerminals();
    render(<Panel server={server} local={local} initialTarget="liam@hermes" />);
    await act(async () => {});
    expect(pressed(/Hermes server/)).toBe("true");
    expect(pressed(/This computer/)).toBe("false");
    expect(server.opened.map((o) => o.target)).toEqual(["liam@hermes"]);
    expect(local.opened).toHaveLength(0);
    expect(screen.getByRole("group", { name: "Which computer" })).toBeTruthy();
  });

  it("remembers the computer picked last, and opens on it next time", async () => {
    const server = new FakeTerminals();
    const local = new FakeTerminals();
    const first = render(<Panel server={server} local={local} initialTarget="liam@hermes" />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /This computer/ })));
    expect(getUIPrefs().terminalKind).toBe("local");
    expect(JSON.parse(localStorage.getItem("hermes-ui-prefs")!).terminalKind).toBe("local");
    first.unmount();

    // The app again, later: this computer's shell is the one shown and started; the server's waits to be picked.
    const server2 = new FakeTerminals();
    const local2 = new FakeTerminals();
    render(<Panel server={server2} local={local2} initialTarget="liam@hermes" />);
    await act(async () => {});
    expect(pressed(/This computer/)).toBe("true");
    expect(local2.opened).toHaveLength(1);
    expect(server2.opened).toHaveLength(0);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Hermes server/ })));
    expect(getUIPrefs().terminalKind).toBe("server");
    expect(server2.opened.map((o) => o.target)).toEqual(["liam@hermes"]);
  });

  it("says plainly when there's no SSH target, and offers to set one", async () => {
    const server = new FakeTerminals();
    const local = new FakeTerminals();
    const onTarget = vi.fn();
    render(<Panel server={server} local={local} initialTarget="" onTarget={onTarget} />);
    await act(async () => {});
    expect(server.opened).toHaveLength(0);
    expect(screen.getByText("No SSH target for the Hermes server.")).toBeTruthy();
    expect(screen.getByText(/signs in with a web address/)).toBeTruthy();
    const field = screen.getByLabelText("SSH target");
    expect(document.activeElement).toBe(field);
    const set = screen.getByRole("button", { name: /Set and connect/ }) as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "liam@hermes" } });
    await act(async () => fireEvent.click(set));
    expect(onTarget).toHaveBeenCalledWith("liam@hermes");
    expect(server.opened.map((o) => o.target)).toEqual(["liam@hermes"]);
    expect(screen.queryByText("No SSH target for the Hermes server.")).toBeNull();
  });

  it("connects at once to a target worked out from the web address, and says where it came from if ssh can't get in", async () => {
    const server = new FakeTerminals();
    render(<Panel server={server} local={new FakeTerminals()} initialTarget="hermes" guessed />);
    await act(async () => {});
    expect(server.opened.map((o) => o.target)).toEqual(["hermes"]);
    expect(screen.queryByText("No SSH target for the Hermes server.")).toBeNull();
    act(() => server.opened[0].emit({ kind: "exit", code: 255 }));
    expect(screen.getByText(/took/).textContent).toMatch(/took hermes from the address you sign in with/);
    // Typing another target is the owner's own: the note goes.
    fireEvent.change(screen.getByLabelText("SSH target"), { target: { value: "liam@hermes" } });
    expect(screen.queryByText(/from the address you sign in with/)).toBeNull();
  });

  it("keeps a worked-out target a guess when connecting again to it, and saves one the owner types", async () => {
    const server = new FakeTerminals();
    const onTarget = vi.fn();
    render(<Panel server={server} local={new FakeTerminals()} initialTarget="hermes" guessed onTarget={onTarget} />);
    await act(async () => {});
    act(() => server.opened[0].emit({ kind: "exit", code: 0 }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Connect again/ })));
    expect(server.opened.map((o) => o.target)).toEqual(["hermes", "hermes"]);
    expect(onTarget).not.toHaveBeenCalled();
    act(() => server.opened[1].emit({ kind: "exit", code: 255 }));
    expect(screen.getByText(/from the address you sign in with/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("SSH target"), { target: { value: "liam@hermes" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Connect again/ })));
    expect(onTarget).toHaveBeenCalledWith("liam@hermes");
  });

  it("doesn't blame the guess when the owner ended the session", async () => {
    const server = new FakeTerminals();
    render(<Panel server={server} local={new FakeTerminals()} initialTarget="hermes" guessed />);
    await act(async () => {});
    act(() => server.opened[0].emit({ kind: "exit", code: 0 }));
    expect(screen.queryByText(/from the address you sign in with/)).toBeNull();
  });

  it("offers this computer instead when there's no SSH target", async () => {
    const server = new FakeTerminals();
    const local = new FakeTerminals();
    render(<Panel server={server} local={local} initialTarget="" />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Use this computer instead/ })));
    expect(pressed(/This computer/)).toBe("true");
    expect(local.opened).toHaveLength(1);
    expect(getUIPrefs().terminalKind).toBe("local");
  });

  it("doesn't say there's no target when the sign-in has one", async () => {
    render(<Panel server={new FakeTerminals()} local={new FakeTerminals()} initialTarget="liam@hermes" />);
    await act(async () => {});
    expect(screen.queryByText("No SSH target for the Hermes server.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Use this computer instead/ })).toBeNull();
  });

  it("keeps the other computer's shell running when the switch is used", async () => {
    const server = new FakeTerminals();
    const local = new FakeTerminals();
    render(<Panel server={server} local={local} initialTarget="liam@hermes" />);
    await act(async () => {});
    act(() => server.opened[0].emit(out("$ ")));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /This computer/ })));
    act(() => local.opened[0].emit(out("% ")));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Hermes server/ })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /This computer/ })));
    // One of each, both still open: switching shows and hides, it never ends or starts again.
    expect(server.opened).toHaveLength(1);
    expect(local.opened).toHaveLength(1);
    expect(server.closed).toEqual([]);
    expect(local.closed).toEqual([]);
    expect(screen.getAllByRole("img", { name: "(running)" })).toHaveLength(2);
    const [serverScreen, localScreen] = [...document.querySelectorAll<HTMLElement>(".terminal-screen")];
    expect(serverScreen.dataset.kind).toBe("server");
    expect(serverScreen.hidden).toBe(true);
    expect(localScreen.hidden).toBe(false);
  });
});

describe("A folder shell (ADR 0167)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  async function panel(initialTarget = "liam@hermes") {
    const server = new FakeTerminals();
    const local = new FakeTerminals();
    const held: Held = {};
    const onRunning = vi.fn();
    render(<Panel server={server} local={local} initialTarget={initialTarget} held={held} onRunning={onRunning} />);
    await act(async () => {});
    const openIn = async (folder: string) => {
      let opened = false;
      await act(async () => void (opened = held.current!.openIn("server", resolvePath(folder, undefined) as ServerPath)));
      return opened;
    };
    return { server, local, openIn, onRunning };
  }
  const chip = (name: RegExp) => screen.getByRole("button", { name });

  it("is an ssh of its own started in the folder, shown beside the owner's shell, which is left as it was", async () => {
    const { server, openIn, onRunning } = await panel();
    act(() => server.opened[0].emit(out("liam@hermes:~$ vim notes")));
    await openIn("/srv/app/docs");
    expect(server.opened.map((o) => [o.target, o.folder])).toEqual([
      ["liam@hermes", undefined],
      ["liam@hermes", "/srv/app/docs"],
    ]);
    expect(chip(/^docs/).getAttribute("aria-pressed")).toBe("true");
    expect(chip(/^docs/).title).toBe("/srv/app/docs\nA shell started in this folder on the Hermes server");
    expect(pressed(/Hermes server/)).toBe("false");
    expect(xterms[1].written.join("")).toContain("── ssh liam@hermes, in /srv/app/docs ──");
    expect(screen.getByLabelText("Terminal on the server, in /srv/app/docs")).toBeTruthy();
    act(() => server.opened[1].emit(out("liam@hermes:/srv/app/docs$ ")));
    expect(onRunning).toHaveBeenLastCalledWith({ server: true, local: false });
    expect(screen.getAllByRole("img", { name: "(running)" })).toHaveLength(2);
    // Nothing was typed into either shell, and the owner's is still running.
    expect(server.written).toEqual([]);
    expect(server.closed).toEqual([]);
    // Its computer isn't a pick: the tab still opens on the server's own shell next time.
    expect(getUIPrefs().terminalKind).toBe("server");
  });

  it("is shown again, not started again, when its folder is opened again while it runs", async () => {
    const { server, openIn } = await panel();
    await openIn("/srv/app/docs");
    act(() => server.opened[1].emit(out("$ ")));
    await act(async () => fireEvent.click(chip(/Hermes server/)));
    expect(chip(/^docs/).getAttribute("aria-pressed")).toBe("false");
    await openIn("/srv/app/docs");
    expect(chip(/^docs/).getAttribute("aria-pressed")).toBe("true");
    expect(server.opened).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^docs/ })).toHaveLength(1);
  });

  it("starts again in its folder when the folder is opened again after it ended", async () => {
    const { server, openIn } = await panel();
    await openIn("/srv/app/docs");
    act(() => server.opened[1].emit(out("$ ")));
    act(() => server.opened[1].emit({ kind: "exit", code: 0 }));
    await openIn("/srv/app/docs");
    expect(server.opened.map((o) => o.folder)).toEqual([undefined, "/srv/app/docs", "/srv/app/docs"]);
    expect(screen.getAllByRole("button", { name: /^docs/ })).toHaveLength(1);
  });

  it("ends its own ssh when it is closed, and no other", async () => {
    const { server, openIn } = await panel();
    await openIn("/srv/app/docs");
    await openIn("~/notes");
    act(() => server.opened.forEach((o) => o.emit(out("$ "))));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close the shell in notes" })));
    expect(server.closed).toEqual([3]);
    expect(screen.queryByRole("button", { name: /^notes/ })).toBeNull();
    // The one on screen was closed, so its computer's own shell shows.
    expect(pressed(/Hermes server/)).toBe("true");
    expect(chip(/^docs/)).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "(running)" })).toHaveLength(2);
  });

  it("says why when its folder is one a shell can't start in, and keeps its place to be closed", async () => {
    const { server, openIn } = await panel();
    server.refuse = "A shell can't start in this folder on the server: its path can't have a quote (') in it.";
    await openIn("/srv/it's");
    expect(screen.getByRole("status", { name: /in \/srv\/it's: Couldn't start/ })).toBeTruthy();
    expect(screen.getByText(server.refuse)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close the shell in it's" })));
    expect(screen.queryByText(server.refuse)).toBeNull();
  });

  it("with no SSH target, asks for one, and offers the same folder on this computer", async () => {
    const { server, local, openIn } = await panel("");
    await openIn("/srv/app/docs");
    expect(server.opened).toHaveLength(0);
    const offers = screen.getAllByRole("button", { name: /Use this computer instead/ });
    await act(async () => fireEvent.click(offers[offers.length - 1]));
    expect(local.opened.map((o) => o.folder)).toEqual(["/srv/app/docs"]);
    expect(chip(/^docs/).title).toBe("/srv/app/docs\nA shell started in this folder on this computer");
    expect(screen.getAllByRole("button", { name: /^docs/ })).toHaveLength(1);
    expect(server.opened).toHaveLength(0);
  });

  it("holds eight, and opens no ninth until one is closed", async () => {
    const { server, openIn } = await panel();
    for (let i = 1; i <= 8; i++) expect(await openIn(`/srv/app/f${i}`)).toBe(true);
    expect(await openIn("/srv/app/f9")).toBe(false);
    expect(server.opened).toHaveLength(9);
    expect(await openIn("/srv/app/f3")).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close the shell in f1" })));
    expect(await openIn("/srv/app/f9")).toBe(true);
    expect(server.opened.at(-1)!.folder).toBe("/srv/app/f9");
  });

  it("shows a folder's name with nothing in it that could reverse its words", async () => {
    const { openIn } = await panel();
    await openIn("/srv/app/\u202Ecod");
    expect(chip(/^\uFFFDcod/).title.startsWith("/srv/app/\uFFFDcod\n")).toBe(true);
  });
});
