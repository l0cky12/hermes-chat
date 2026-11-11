// @vitest-environment jsdom
// Settings → Persona in the running app, against the fake dashboard: what it shows, Save/Cancel/Reload, a missing
// SOUL.md, conflicts and failed writes, earlier versions, and asking before an unsaved edit is left behind by going back
// to the chats, another tab, switching profile, signing out or closing the window.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { PersonaStore, personaKey } from "../hermes/personaStore";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { queryWords, searchText, textMatches } from "./settingsSearch";
import { RestError } from "../hermes/pipe";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

const SOUL = "# Persona\n\nYou are Hermes, a **terse** assistant.\n\n- Answer in `plain` words\n";
let launches = 0;

/** The app signed in, with a store and window-close hook of its own. `closeAsked`: the ask the window would make. */
async function launch({ souls = { default: SOUL, work: "# Work persona\n" } as Record<string, string>, storage = memoryStorage(), signOut = vi.fn(async () => {}) } = {}) {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  server.otherProfiles = { work: [] };
  server.souls = { ...souls };
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  const store = new PersonaStore(storage);
  const close = vi.fn();
  const window = { ask: undefined as undefined | ((close: () => void) => void), close, guarded: 0 };
  const connection = { mode: "ssh" as const, sshTarget: `liam@hermes-${++launches}`, url: "", username: "liam" };
  const view = render(
    <Main
      hermes={hermes}
      connection={connection}
      onSignOut={signOut}
      personaStore={store}
      guardClose={async (ask) => {
        window.guarded++;
        window.ask = ask;
        return () => {
          window.ask = undefined;
        };
      }}
    />,
  );
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  return { server, hermes, store, storage, connection, window, signOut, view, user: userEvent.setup() };
}

async function openPersona(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Settings/ }));
  await user.click(screen.getByRole("tab", { name: /Persona/ }));
}

/** A row of the Persona section's card, by its name: Server, Profile or File. */
const fact = (name: string) => [...document.querySelectorAll<HTMLElement>(".persona .set-row")].find((r) => r.querySelector(".set-name")?.textContent === name)!;
const editor = (profile = "default") => screen.findByRole<HTMLTextAreaElement>("textbox", { name: `SOUL.md for the ${profile} profile` });
const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "PUT" && r.path.endsWith("/soul")).map((r) => [r.path, r.body?.content]);

async function edit(user: ReturnType<typeof userEvent.setup>, text: string, profile = "default") {
  const box = await editor(profile);
  await user.clear(box);
  // `{` and `[` are userEvent key syntax; type the text as a paste.
  await user.click(box);
  await user.paste(text);
  return box;
}

describe("Settings → Persona", () => {
  it("names the server, profile and file, and shows SOUL.md exactly as Hermes has it", async () => {
    const { user } = await launch();
    await openPersona(user);
    const box = await editor();
    expect(box.value).toBe(SOUL);
    expect(fact("Server").textContent).toContain("liam@hermes");
    expect(within(fact("Profile")).getByRole<HTMLSelectElement>("combobox", { name: "Profile" }).value).toBe("default");
    expect(fact("File").textContent).toContain("/home/liam/.hermes/SOUL.md");
    expect(screen.getByText(/Hermes reads SOUL.md when a chat starts/).textContent).toMatch(/doesn't need to restart, and Hermes Chat never restarts it/);
    // Plain text, never rendered: the Markdown shows as typed.
    expect(document.querySelector(".persona strong")).toBeNull();
    expect(screen.getByRole("button", { name: /^Save$/ }).hasAttribute("disabled")).toBe(true);
  });

  it("saves, reads back, and keeps what it replaced to view and put back", async () => {
    const { server, user } = await launch();
    await openPersona(user);
    const edited = "# Persona\n\n## Tone\n\nWarm, *brief*.\n\n```\nkeep   spacing\n```\n";
    await edit(user, edited);
    expect(screen.getByText("Unsaved")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/Saved SOUL.md at .*read it back from Hermes/);
    expect(server.souls.default).toBe(edited);
    expect(writes(server)).toEqual([["/api/profiles/default/soul", edited]]);
    expect(screen.queryByText("Unsaved")).toBeNull();

    // The version replaced is kept, to view, copy or put back.
    const earlier = screen.getByRole("heading", { name: /Earlier versions/ }).closest("section")!;
    await user.click(within(earlier).getByRole("button", { name: "View" }));
    expect(within(earlier).getByRole<HTMLTextAreaElement>("textbox").value).toBe(SOUL);
    await user.click(within(earlier).getByRole("button", { name: "Put in the editor" }));
    expect((await editor()).value).toBe(SOUL);
    expect(server.souls.default).toBe(edited);
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/Saved SOUL.md/);
    expect(server.souls.default).toBe(SOUL);
  });

  it("Cancel sets the edit aside, Undo brings it back, and Reload asks before dropping it", async () => {
    const { server, user } = await launch();
    await openPersona(user);
    await edit(user, "# Draft\n");
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect((await editor()).value).toBe(SOUL);
    await user.click(screen.getByRole("button", { name: /Undo/ }));
    expect((await editor()).value).toBe("# Draft\n");

    // Undo after typing again swaps the two, so neither is lost.
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    await edit(user, "# Second draft\n");
    await user.click(screen.getByRole("button", { name: /Undo/ }));
    expect((await editor()).value).toBe("# Draft\n");
    await user.click(screen.getByRole("button", { name: /Undo/ }));
    expect((await editor()).value).toBe("# Second draft\n");
    await user.click(screen.getByRole("button", { name: /Undo/ }));
    expect((await editor()).value).toBe("# Draft\n");

    server.souls.default = "# Changed elsewhere\n";
    await user.click(screen.getByRole("button", { name: /Reload/ }));
    const ask = screen.getByRole("alertdialog", { name: "Reload SOUL.md?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect((await editor()).value).toBe("# Draft\n");
    await user.click(screen.getByRole("button", { name: /Reload/ }));
    await user.click(screen.getByRole("button", { name: "Reload anyway" }));
    await waitFor(async () => expect((await editor()).value).toBe("# Changed elsewhere\n"));
    expect(writes(server)).toEqual([]);
  });

  it("offers to create a missing SOUL.md, and writes nothing until Save", async () => {
    const { server, user } = await launch({ souls: {} });
    await openPersona(user);
    await screen.findByText(/has no SOUL.md, so Hermes uses its built-in identity/);
    await user.click(screen.getByRole("button", { name: /Create SOUL.md/ }));
    await edit(user, "# Brand new\n");
    expect(server.souls.default).toBeUndefined();
    await user.click(screen.getByRole("button", { name: /Create SOUL.md/ }));
    await screen.findByText(/Created SOUL.md at/);
    expect(server.souls).toEqual({ default: "# Brand new\n" });
  });

  it("asks before saving an empty SOUL.md", async () => {
    const { server, user } = await launch();
    await openPersona(user);
    await user.clear(await editor());
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    const ask = screen.getByRole("alertdialog", { name: "Save an empty SOUL.md?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(writes(server)).toEqual([]);
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await user.click(screen.getByRole("button", { name: "Save empty" }));
    await screen.findByText(/Saved SOUL.md/);
    expect(server.souls.default).toBe("");
  });

  it("doesn't overwrite a SOUL.md changed elsewhere, and lets the owner choose", async () => {
    const { server, user } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    server.souls.default = "# Theirs\n";
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/changed on the server since you started editing, so nothing was saved/);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "SOUL.md on the server now" }).value).toBe("# Theirs\n");
    expect(server.souls.default).toBe("# Theirs\n");
    expect((await editor()).value).toBe("# Mine\n");
    expect(screen.getByRole("button", { name: /^Save$/ }).hasAttribute("disabled")).toBe(true);

    // Saving mine over theirs asks first, and keeps theirs as an earlier version.
    await user.click(screen.getByRole("button", { name: "Save mine over it…" }));
    await user.click(screen.getByRole("button", { name: "Save mine over it" }));
    await screen.findByText(/Saved SOUL.md/);
    expect(server.souls.default).toBe("# Mine\n");
    const earlier = screen.getByRole("heading", { name: /Earlier versions/ }).closest("section")!;
    await user.click(within(earlier).getByRole("button", { name: "View" }));
    expect(within(earlier).getByRole<HTMLTextAreaElement>("textbox").value).toBe("# Theirs\n");
  });

  it("can take the server's version instead, keeping the edit to undo", async () => {
    const { server, user } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    server.souls.default = "# Theirs\n";
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/nothing was saved/);
    await user.click(screen.getByRole("button", { name: "Use the server's version" }));
    expect((await editor()).value).toBe("# Theirs\n");
    expect(screen.queryByText(/nothing was saved/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Undo/ }));
    expect((await editor()).value).toBe("# Mine\n");
    expect(writes(server)).toEqual([]);
    expect(server.souls.default).toBe("# Theirs\n");
  });

  it("keeps the edit, on screen and on this computer, when the write fails", async () => {
    const { server, user, store, connection } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    server.soulWriteError = new RestError(500, `{"detail":"Could not write SOUL.md: [Errno 13] Permission denied: '/home/liam/.hermes/SOUL.md'"}`);
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    const alert = await screen.findByText(/isn't allowed to save SOUL.md.*Permission denied.*still here, and kept on this computer/);
    expect(alert).toBeTruthy();
    expect((await editor()).value).toBe("# Mine\n");
    expect(server.souls.default).toBe(SOUL);
    expect(store.draft(personaKey(connection, "default"))).toMatchObject({ text: "# Mine\n", base: { exists: true, content: SOUL } });
    expect(screen.queryByRole("heading", { name: /Earlier versions/ })).toBeNull();
  });

  it("shows a server without the persona routes, and a file Hermes may not read", async () => {
    const { server, hermes, user } = await launch();
    server.soulRoutes = false;
    await openPersona(user);
    // The tab's own read finds no route, so the note saying what is missing takes the editor's place (ADR 0044).
    expect(await screen.findByRole("region", { name: /This Hermes server doesn't support Persona/ })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /SOUL.md for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Create SOUL.md/ })).toBeNull();

    await user.click(screen.getByRole("tab", { name: /General/ }));
    server.soulRoutes = true;
    // Hermes is updated in place: diagnostics' Check again finds the routes, and the tab opens again.
    await act(() => hermes.capabilities.refresh());
    server.soulReadError = new RestError(500, `{"detail":"Could not read SOUL.md: [Errno 13] Permission denied"}`);
    await user.click(screen.getByRole("tab", { name: /Persona/ }));
    await screen.findByText("Not allowed");
    server.soulReadError = undefined;
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    expect((await editor()).value).toBe(SOUL);
  });

  it("can't save while disconnected, keeps the edit, and saves once the connection is back", async () => {
    const { server, hermes, user } = await launch();
    await openPersona(user);
    await edit(user, "# Offline edit\n");
    server.refuse = "connection refused";
    await act(async () => server.drop());
    await screen.findByText(/Not connected to Hermes, so nothing can be saved or reloaded now. Your changes are kept on this computer/);
    expect(screen.getByRole("button", { name: /^Save$/ }).hasAttribute("disabled")).toBe(true);
    server.refuse = undefined;
    await act(async () => void (await hermes.reconnect()));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save$/ }).hasAttribute("disabled")).toBe(false));
    expect((await editor()).value).toBe("# Offline edit\n");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/Saved SOUL.md/);
    expect(server.souls.default).toBe("# Offline edit\n");
  });
});

describe("edge cases an independent review found", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("makes the editor read-only while a reload is under way, so its answer can't replace new typing", async () => {
    const { server, user } = await launch();
    await openPersona(user);
    await editor();
    const gate = deferred<void>();
    server.rest["GET /api/profiles/default/soul"] = async () => {
      await gate.promise;
      return { content: "# Reloaded\n", exists: true };
    };
    await user.click(screen.getByRole("button", { name: /Reload/ }));
    expect((await editor()).readOnly).toBe(true);
    expect(screen.getByRole("button", { name: /^Save$/ }).hasAttribute("disabled")).toBe(true);
    await act(async () => gate.resolve());
    await waitFor(async () => expect((await editor()).value).toBe("# Reloaded\n"));
    expect((await editor()).readOnly).toBe(false);
  });

  it("keeps an edit it couldn't read back as unsaved: kept on this computer, and leaving still asks", async () => {
    const { server, user, store, connection } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    server.afterSoulWrite = () => (server.soulReadError = new RestError(500, `Internal Server Error`));
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/Hermes said it saved SOUL.md, but reading it back failed/);
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(store.draft(personaKey(connection, "default"))?.text).toBe("# Mine\n");
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    expect(screen.getByRole("alertdialog", { name: "Leave without saving the persona?" })).toBeTruthy();
  });

  it("keeps what a save replaced even when the owner left before it finished", async () => {
    const { server, user } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    const gate = deferred<void>();
    server.rest["PUT /api/profiles/default/soul"] = async ({ body }) => {
      await gate.promise;
      server.souls.default = body!.content as string;
      return { ok: true };
    };
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    await act(async () => gate.resolve());
    await waitFor(() => expect(server.souls.default).toBe("# Mine\n"));
    await openPersona(user);
    expect((await editor()).value).toBe("# Mine\n");
    expect(screen.queryByText(/Changes you didn't save/)).toBeNull();
    const earlier = screen.getByRole("heading", { name: /Earlier versions/ }).closest("section")!;
    await user.click(within(earlier).getByRole("button", { name: "View" }));
    expect(within(earlier).getByRole<HTMLTextAreaElement>("textbox").value).toBe(SOUL);
  });

  it("says when this computer's storage can't keep the edit, and so does leaving", async () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const { user } = await launch({ storage });
    await openPersona(user);
    await edit(user, "# Mine\n");
    await screen.findByText(/couldn't write your changes to this computer's storage/);
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    const ask = screen.getByRole("alertdialog", { name: "Leave without saving the persona?" });
    expect(ask.textContent).toMatch(/last only until the app closes/);
  });
});

describe("edge cases the second review round found", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("can't restore, undo or put back text while a reload is under way", async () => {
    const { server, user } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    await openPersona(user);
    await screen.findByRole("button", { name: "Restore them" });
    const gate = deferred<void>();
    server.rest["GET /api/profiles/default/soul"] = async () => {
      await gate.promise;
      return { content: SOUL, exists: true };
    };
    await user.click(screen.getByRole("button", { name: /Reload/ }));
    expect(screen.getByRole("button", { name: "Restore them" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Discard them" }).hasAttribute("disabled")).toBe(true);
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore them" }).hasAttribute("disabled")).toBe(false));
  });

  it("keeps an unverified overwrite unsaved even when its text matches what it started from", async () => {
    const { server, user, store, connection } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    server.souls.default = "# Theirs\n";
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/nothing was saved/);
    await edit(user, SOUL);
    server.afterSoulWrite = () => (server.soulReadError = new RestError(500, `Internal Server Error`));
    await user.click(screen.getByRole("button", { name: "Save mine over it…" }));
    await user.click(screen.getByRole("button", { name: "Save mine over it" }));
    await screen.findByText(/reading it back failed/);
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(store.draft(personaKey(connection, "default"))).toMatchObject({ text: SOUL, base: { exists: true, content: "# Theirs\n" } });
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    expect(screen.getByRole("alertdialog", { name: "Leave without saving the persona?" })).toBeTruthy();
  });

  it("warns, and guards closing, when a kept edit waiting to be restored is only in memory", async () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const { user, window } = await launch({ storage });
    await openPersona(user);
    await edit(user, "# Mine\n");
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    await openPersona(user);
    await screen.findByText(/are kept in this app until it closes/);
    expect(screen.getByText(/storage couldn't take them, so they last only until the app closes/)).toBeTruthy();
    await waitFor(() => expect(window.ask).toBeDefined());
  });
});

describe("edge cases the third review round found", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  async function conflictWithTheirs(server: FakeHermes, user: ReturnType<typeof userEvent.setup>) {
    await openPersona(user);
    await edit(user, "# Mine\n");
    server.souls.default = "# Theirs\n";
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/nothing was saved/);
  }

  it("keeps the text of a save the owner left, even when it matches where editing started, if the save fails", async () => {
    const { server, user, store, connection } = await launch();
    await conflictWithTheirs(server, user);
    await edit(user, SOUL);
    const gate = deferred<void>();
    server.rest["PUT /api/profiles/default/soul"] = async () => {
      await gate.promise;
      throw new RestError(500, `{"detail":"Could not write SOUL.md: [Errno 28] No space left on device"}`);
    };
    await user.click(screen.getByRole("button", { name: "Save mine over it…" }));
    await user.click(screen.getByRole("button", { name: "Save mine over it" }));
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    await act(async () => gate.resolve());
    expect(store.draft(personaKey(connection, "default"))).toMatchObject({ text: SOUL, base: { exists: true, content: "# Theirs\n" } });
    expect(server.souls.default).toBe("# Theirs\n");
  });

  it("keeps an unverified overwrite of a file deleted meanwhile in the editor, unsaved", async () => {
    const { server, user, store, connection } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    delete server.souls.default;
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/nothing was saved/);
    server.afterSoulWrite = () => (server.soulReadError = new RestError(500, `Internal Server Error`));
    await user.click(screen.getByRole("button", { name: "Save mine over it…" }));
    await user.click(screen.getByRole("button", { name: "Save mine over it" }));
    await screen.findByText(/reading it back failed/);
    expect((await editor()).value).toBe("# Mine\n");
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(store.draft(personaKey(connection, "default"))).toMatchObject({ text: "# Mine\n", base: { exists: false } });
  });

  it("waits for a save started before leaving before it lets the reopened editor change anything", async () => {
    const { server, user } = await launch();
    await openPersona(user);
    await edit(user, "# B\n");
    const gate = deferred<void>();
    server.rest["PUT /api/profiles/default/soul"] = async ({ body }) => {
      await gate.promise;
      server.souls.default = body!.content as string;
      return { ok: true };
    };
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    await openPersona(user);
    await screen.findByText(/A save you started before leaving Persona is still under way/);
    expect(screen.getByRole("button", { name: "Restore them" }).hasAttribute("disabled")).toBe(true);
    expect((await editor()).readOnly).toBe(true);
    await act(async () => gate.resolve());
    await waitFor(async () => expect((await editor()).value).toBe("# B\n"));
    expect(screen.queryByText(/still under way/)).toBeNull();
    expect(screen.queryByText(/Changes you didn't save/)).toBeNull();
  });
});

describe("leaving an unsaved persona edit", () => {
  it("asks before going back to the chats or to another tab, and stays when told", async () => {
    const { user } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    let ask = screen.getByRole("alertdialog", { name: "Leave without saving the persona?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect((await editor()).value).toBe("# Mine\n");

    await user.click(screen.getByRole("tab", { name: /Model/ }));
    ask = screen.getByRole("alertdialog", { name: "Leave without saving the persona?" });
    await user.keyboard("{Escape}");
    expect((await editor()).value).toBe("# Mine\n");

    // The Outputs button on the rail asks too.
    await user.click(screen.getByRole("button", { name: "Outputs" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Keep editing" }));
    expect((await editor()).value).toBe("# Mine\n");

    // So does Scheduled jobs.
    await user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Keep editing" }));
    expect((await editor()).value).toBe("# Mine\n");

    // Opening a chat from the list asks too.
    await user.click(screen.getByText("Nightly backup"));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Leave" }));
    expect(screen.queryByRole("tab", { name: /Persona/ })).toBeNull();
  });

  it("keeps a left edit on this computer and offers it back, checked against Hermes", async () => {
    const { server, user } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(server.souls.default).toBe(SOUL);

    await openPersona(user);
    await screen.findByText(/Changes you didn't save, from today at .*, are kept on this computer/);
    expect((await editor()).value).toBe(SOUL);
    expect((await editor()).readOnly).toBe(true);
    await user.click(screen.getByRole("button", { name: "Restore them" }));
    expect((await editor()).value).toBe("# Mine\n");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/Saved SOUL.md/);
    expect(server.souls.default).toBe("# Mine\n");
  });

  it("restores a kept edit into a conflict when SOUL.md changed on the server meanwhile", async () => {
    const { server, user } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    server.souls.default = "# Theirs\n";
    await openPersona(user);
    await screen.findByText(/SOUL.md has changed on the server since you made them/);
    await user.click(screen.getByRole("button", { name: "Restore them" }));
    expect(screen.getByText(/changed on the server since you started editing/)).toBeTruthy();
    expect(server.souls.default).toBe("# Theirs\n");
  });

  it("asks before switching profile, and the other profile's persona is its own", async () => {
    const { server, hermes, user } = await launch();
    await openPersona(user);
    await edit(user, "# Default, edited\n");
    await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await user.click(within(await screen.findByRole("listbox", { name: "Profiles" })).getByRole("option", { name: /work/ }));
    const ask = screen.getByRole("alertdialog", { name: "Switch profile without saving the persona?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(hermes.profile).toBe("default");

    await user.click(document.querySelector<HTMLElement>(".profile-btn")!);
    await user.click(within(await screen.findByRole("listbox", { name: "Profiles" })).getByRole("option", { name: /work/ }));
    await user.click(screen.getByRole("button", { name: "Switch anyway" }));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" }));
    await waitFor(() => expect(hermes.getSnapshot().switching).toBeUndefined());

    await openPersona(user);
    const work = await editor("work");
    expect(work.value).toBe("# Work persona\n");
    // The default profile's kept edit isn't offered here.
    expect(screen.queryByText(/Changes you didn't save/)).toBeNull();
    expect(fact("File").textContent).toContain("/home/liam/.hermes/profiles/work/SOUL.md");
    await edit(user, "# Work, edited\n", "work");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/Saved SOUL.md/);
    expect(server.souls).toEqual({ default: SOUL, work: "# Work, edited\n" });
    expect(writes(server)).toEqual([["/api/profiles/work/soul", "# Work, edited\n"]]);
  });

  it("starts on the profile in use again after the app switches profile, and offers every profile", async () => {
    const { hermes, user } = await launch();
    await act(async () => void (await hermes.switchProfile("work")));
    await waitFor(() => expect(hermes.getSnapshot()).toMatchObject({ profile: "work", status: "connected" }));
    await openPersona(user);
    expect((await editor("work")).value).toBe("# Work persona\n");
    const picker = screen.getByRole<HTMLSelectElement>("combobox", { name: "Profile" });
    expect(picker.value).toBe("work");
    await waitFor(() => expect([...picker.options].map((o) => o.text)).toEqual(["work (in use)", "default"]));
  });

  it("asks before leaving Persona for Sign out, and keeps the edit for the next sign-in", async () => {
    const { signOut, user, store, connection } = await launch();
    await openPersona(user);
    await edit(user, "# Mine\n");
    // Sign out is on General: going there asks first.
    await user.click(screen.getByRole("tab", { name: /General/ }));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(signOut).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /General/ }));
    await user.click(screen.getByRole("button", { name: "Leave" }));
    await user.click(screen.getByRole("button", { name: /Sign out/ }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(store.draft(personaKey(connection, "default"))?.text).toBe("# Mine\n");
  });

  it("asks before the window closes, only while there is an unsaved edit", async () => {
    const { user, window } = await launch();
    await openPersona(user);
    await editor();
    expect(window.ask).toBeUndefined();
    await edit(user, "# Mine\n");
    await waitFor(() => expect(window.ask).toBeDefined());

    act(() => window.ask!(window.close));
    const ask = screen.getByRole("alertdialog", { name: "Close Hermes Chat without saving the persona?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(window.close).not.toHaveBeenCalled();
    act(() => window.ask!(window.close));
    await user.click(screen.getByRole("button", { name: "Close anyway" }));
    expect(window.close).toHaveBeenCalledTimes(1);

    // Once saved, closing no longer asks.
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/Saved SOUL.md/);
    await waitFor(() => expect(window.ask).toBeUndefined());
  });

  it("doesn't ask when nothing is unsaved", async () => {
    const { user } = await launch();
    await openPersona(user);
    await editor();
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("tab", { name: /Persona/ })).toBeNull();
  });
});

describe("editing another profile's persona (#190)", () => {
  const picker = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Profile" });

  it("lists every profile, starting on the one in use, and edits the picked one's SOUL.md without switching the app", async () => {
    const { server, hermes, user, store, connection } = await launch();
    server.otherProfiles.research = [];
    server.distributions = { work: "acme-agents" };
    await openPersona(user);
    await editor();
    expect(picker().value).toBe("default");
    await waitFor(() => expect([...picker().options].map((o) => o.text)).toEqual(["default (in use)", "work", "research"]));

    await user.selectOptions(picker(), "work");
    const work = await editor("work");
    expect(work.value).toBe("# Work persona\n");
    // The notes are the picked profile's: its file, its distribution, and that the app is using another profile.
    expect(fact("File").textContent).toContain("/home/liam/.hermes/profiles/work/SOUL.md");
    expect(await screen.findByText(/installed from the/)).toBeTruthy();
    expect(screen.getByText(/profile distribution/).textContent).toContain("acme-agents");
    expect(screen.getByText(/Hermes Chat is using the/).textContent).toMatch(/using the default profile.*chats on the work profile/s);
    expect(screen.getByText(/Hermes reads SOUL.md when a chat starts/).textContent).toContain("use the work profile");

    await edit(user, "# Work, edited\n", "work");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/Saved SOUL.md/);
    expect(server.souls).toEqual({ default: SOUL, work: "# Work, edited\n" });
    // The same checks as for the profile in use: read first, write, read back.
    const soul = server.restRequests.filter((r) => r.path.endsWith("/soul")).map((r) => `${r.method} ${r.path}`);
    expect(soul.slice(-3)).toEqual(["GET /api/profiles/work/soul", "PUT /api/profiles/work/soul", "GET /api/profiles/work/soul"]);
    expect(hermes.profile).toBe("default");
    // What the save replaced is kept for the work profile, not the default one.
    expect(store.earlier(personaKey(connection, "work")).map((v) => v.content)).toEqual(["# Work persona\n"]);
    expect(store.earlier(personaKey(connection, "default"))).toEqual([]);
  });

  it("asks before picking another profile while an edit is unsaved, and keeps each profile's edit apart", async () => {
    const { server, user, store, connection } = await launch();
    await openPersona(user);
    await edit(user, "# Default, edited\n");

    await user.selectOptions(picker(), "work");
    let ask = screen.getByRole("alertdialog", { name: "Open another profile's persona without saving?" });
    expect(ask.textContent).toContain("offers them back when you pick default again");
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(picker().value).toBe("default");
    expect((await editor()).value).toBe("# Default, edited\n");

    await user.selectOptions(picker(), "work");
    ask = screen.getByRole("alertdialog", { name: "Open another profile's persona without saving?" });
    await user.click(within(ask).getByRole("button", { name: "Open it anyway" }));
    expect((await editor("work")).value).toBe("# Work persona\n");
    // The default profile's edit is kept on this computer, and isn't offered for work.
    expect(screen.queryByText(/Changes you didn't save/)).toBeNull();
    expect(store.draft(personaKey(connection, "default"))?.text).toBe("# Default, edited\n");
    expect(store.draft(personaKey(connection, "work"))).toBeUndefined();

    // An unsaved edit on work too: leaving Settings asks about the work profile's persona.
    await edit(user, "# Work, edited\n", "work");
    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    ask = screen.getByRole("alertdialog", { name: "Leave without saving the persona?" });
    expect(ask.textContent).toContain("SOUL.md for the work profile");
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));

    // Back on default (asked first), its own edit is offered back, and work's stays apart.
    await user.selectOptions(picker(), "default");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Open it anyway" }));
    await screen.findByText(/Changes you didn't save/);
    await user.click(screen.getByRole("button", { name: "Restore them" }));
    expect((await editor()).value).toBe("# Default, edited\n");
    expect(store.draft(personaKey(connection, "work"))?.text).toBe("# Work, edited\n");
    expect(writes(server)).toEqual([]);
  });

  it("doesn't ask when the picked profile has nothing unsaved", async () => {
    const { user } = await launch();
    await openPersona(user);
    await editor();
    await user.selectOptions(picker(), "work");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((await editor("work")).value).toBe("# Work persona\n");
  });

  it("shows a profile with no SOUL.md as empty, and creates it on Save", async () => {
    const { server, user } = await launch();
    server.otherProfiles.research = [];
    await openPersona(user);
    await editor();
    await waitFor(() => expect([...picker().options].map((o) => o.value)).toContain("research"));
    await user.selectOptions(picker(), "research");
    await screen.findByText(/The research profile has no SOUL.md/);
    await user.click(screen.getByRole("button", { name: /Create SOUL.md/ }));
    await edit(user, "# Research\n", "research");
    await user.click(screen.getByRole("button", { name: /Create SOUL.md/ }));
    await screen.findByText(/Created SOUL.md/);
    expect(server.souls.research).toBe("# Research\n");
    expect(writes(server)).toEqual([["/api/profiles/research/soul", "# Research\n"]]);
  });

  it("still edits the profile in use when the profiles can't be listed, and says so", async () => {
    const { server, user } = await launch();
    const list = server.rest["GET /api/profiles"];
    server.rest["GET /api/profiles"] = () => {
      throw new RestError(500, "boom");
    };
    await openPersona(user);
    expect((await editor()).value).toBe(SOUL);
    await screen.findByText(/Couldn't list the server's profiles/);
    expect([...picker().options].map((o) => o.value)).toEqual(["default"]);
    server.rest["GET /api/profiles"] = list;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect([...picker().options].map((o) => o.value)).toEqual(["default", "work"]));
    expect(screen.queryByText(/Couldn't list the server's profiles/)).toBeNull();
  });
});

describe("the row layout (#174, ADR 0059)", () => {
  const section = (heading: string) => screen.getByRole("heading", { name: heading, level: 2 }).closest("section")!;

  it("draws each section as a heading and a card of rows, with the editor and its buttons in a block of the card", async () => {
    const { user } = await launch();
    await openPersona(user);
    await edit(user, "# Edited\n");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/Saved SOUL.md/);

    const persona = section("Persona");
    expect(persona.classList).toContain("set-section");
    const card = persona.querySelector(":scope > .set-card")!;
    expect([...card.querySelectorAll(":scope > .set-row .set-name")].map((n) => n.textContent)).toEqual(["Server", "Profile", "File"]);
    expect(within(fact("Profile")).getByRole("combobox", { name: "Profile" })).toBeTruthy();
    // SOUL.md's editor, and Save, Cancel and Reload under it, are free-form content in the same card.
    const block = card.querySelector<HTMLElement>(":scope > .set-block")!;
    expect(within(block).getByRole("textbox", { name: "SOUL.md for the default profile" })).toBeTruthy();
    for (const name of [/^Save$/, /Cancel/, /Reload/]) expect(within(block).getByRole("button", { name })).toBeTruthy();

    // Copying is a row: its picker, still named "To profile", and Copy… beside it.
    const copy = screen.getByRole("region", { name: "Copy to another profile" });
    const to = within(copy).getByRole<HTMLSelectElement>("combobox", { name: "To profile" });
    expect(to.closest(".set-row")).toBe(within(copy).getByRole("button", { name: /Copy…/ }).closest(".set-row"));

    // Each earlier version is a row, with View as its control.
    const earlier = section("Earlier versions");
    const rows = earlier.querySelectorAll(".set-card > .set-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".set-name")!.textContent).toMatch(/^Replaced today at /);
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "View" })).toBeTruthy();
  });

  it("folds when a saved persona takes effect behind the section's (i), where search still finds it", async () => {
    const { user } = await launch();
    await openPersona(user);
    await editor();
    const about = screen.getByRole("button", { name: "About Persona" });
    const help = document.getElementById(about.getAttribute("aria-controls")!)!;
    expect(about.getAttribute("aria-expanded")).toBe("false");
    expect(help.hidden).toBe(true);
    expect(help.textContent).toMatch(/Hermes reads SOUL.md when a chat starts/);
    // The heading's name is its title alone.
    expect(screen.getByRole("heading", { name: "Persona", level: 2 })).toBeTruthy();
    // The folded words are still the section's text, which Settings' search matches.
    expect(textMatches(searchText(section("Persona")), queryWords("rebuilds its instructions"))).toBe(true);
    await user.click(about);
    expect(about.getAttribute("aria-expanded")).toBe("true");
    expect(help.hidden).toBe(false);
  });

  const unfolded = (el: Element) => expect(el.closest(".set-more, [hidden]")).toBeNull();

  it("never folds a warning, a state or a question", async () => {
    const { server, user } = await launch();
    server.distributions = { default: "acme-agents" };
    await openPersona(user);
    await user.clear(await editor());
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    unfolded(await screen.findByText(/installed from the/));
    unfolded(screen.getByText("Unsaved"));
    unfolded(screen.getByRole("alertdialog", { name: "Save an empty SOUL.md?" }));
    expect(document.querySelector(".persona .set-more :is([role=alert], [role=status], [role=alertdialog])")).toBeNull();
  });

  it("shows under the picker, unfolded, that the profiles couldn't be listed", async () => {
    const { server, user } = await launch();
    server.rest["GET /api/profiles"] = () => {
      throw new RestError(500, "boom");
    };
    await openPersona(user);
    const problem = await screen.findByText(/Couldn't list the server's profiles/);
    unfolded(problem);
    expect(problem.closest(".set-row")).toBe(fact("Profile"));
  });
});
