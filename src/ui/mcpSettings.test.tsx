// @vitest-environment jsdom
// Settings → MCP servers on screen (McpSettings.tsx, ADR 0121), against the fake dashboard's MCP routes and Rust's edit
// (fakeMcp.ts): the list with transport, switch and plugin, adding and editing in a dialog with write-only secrets,
// removing after asking, Test, OAuth sign-in followed to the end, the catalog, no_mcp, and answers for another profile
// dropped. Every server here is synthetic.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { appearanceStore } from "./appearance";
import { McpSettings } from "./McpSettings";
import { SettingsScreen } from "./Settings";

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

const SECRET = "s3cret-env-value-123";

function server() {
  const s = new FakeHermes();
  s.otherProfiles = { work: [] };
  s.mcp.servers.default = {
    fs: { command: "npx", args: ["-y", "@x/fs", "/srv"], env: { API_KEY: SECRET } },
    web: { url: "https://web.example/mcp", headers: { Authorization: "Bearer ${MCP_WEB_API_KEY}" } },
    notes: { url: "https://notes.example/mcp", auth: "oauth" },
  };
  s.mcp.env.default = { MCP_WEB_API_KEY: "old-token-value" };
  s.mcp.plugins.default = { kanban: { plugin: "kanban-plugin", cfg: { command: "kanban-mcp" } } };
  s.mcp.servers.work = { calendar: { command: "cal-mcp" } };
  return s;
}

async function shown({ s = server(), profile = "default", openUrl = vi.fn() } = {}) {
  const hermes = await connect(s.openPipe, "default");
  running.push(hermes);
  const user = userEvent.setup();
  // StrictMode, as the app runs in development: effects set up, clean up and set up again.
  const view = render(
    <StrictMode>
      <McpSettings api={hermes.mcp} profile={profile} connected openUrl={openUrl} pollMs={20} />
    </StrictMode>,
  );
  await screen.findByRole("button", { name: "Reload" });
  return { s, hermes, user, view, openUrl };
}

const rowOf = (name: string) => screen.getByText(name, { selector: ".mcp-name .mono" }).closest(".set-row") as HTMLElement;
const dialog = () => screen.getByRole("dialog");

describe("Settings → MCP servers: the list", () => {
  it("shows each server's transport, switch and plugin, and never an env value", async () => {
    await shown();
    expect(within(rowOf("fs")).getByText("npx -y @x/fs /srv")).toBeTruthy();
    expect(within(rowOf("fs")).getByText("API_KEY")).toBeTruthy();
    expect(within(rowOf("web")).getByText("https://web.example/mcp")).toBeTruthy();
    expect(within(rowOf("web")).getByText("Bearer token, kept on the server")).toBeTruthy();
    expect(within(rowOf("fs")).getByRole("switch", { name: "fs" }).getAttribute("aria-checked")).toBe("true");
    // A plugin's server is read-only: no switch, no Edit or Remove.
    const kanban = rowOf("kanban");
    expect(within(kanban).getByText("from plugin kanban-plugin")).toBeTruthy();
    expect(within(kanban).queryByRole("switch")).toBeNull();
    expect(within(kanban).queryByRole("button", { name: /Edit|Remove/ })).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET.slice(0, 6));
    expect(document.body.textContent).not.toContain("old-token");
  });

  it("switches a server off once Hermes reads it back that way", async () => {
    const { s, user } = await shown();
    await user.click(within(rowOf("fs")).getByRole("switch", { name: "fs" }));
    await within(rowOf("fs")).findByText("Turned off: Hermes reads it back that way.");
    expect(s.mcp.servers.default.fs.enabled).toBe(false);
    expect(within(rowOf("fs")).getByRole("switch", { name: "fs" }).getAttribute("aria-checked")).toBe("false");
  });

  it("says when a switch doesn't read back as asked", async () => {
    const { s, user } = await shown();
    s.mcp.misapply = true;
    await user.click(within(rowOf("fs")).getByRole("switch", { name: "fs" }));
    await within(rowOf("fs")).findByText(/Hermes didn't confirm it/);
    expect(within(rowOf("fs")).getByRole("switch", { name: "fs" }).getAttribute("aria-checked")).toBe("true");
  });

  it("warns when the profile's Toolsets turn MCP off for this app's chats", async () => {
    const s = server();
    s.toolsetNoMcp.default = new Set(["cli", "discord"]);
    await shown({ s });
    await screen.findByText(/turn MCP servers off for this app's chats/);
    expect(screen.getByText(/turns them off for discord chats/)).toBeTruthy();
  });

  it("lists and switches servers whose names are also object property names", async () => {
    const s = server();
    s.mcp.servers.default = { constructor: { command: "a" }, toString: { url: "https://t.example/mcp", auth: "oauth" }, hasOwnProperty: { command: "c" } };
    const { user } = await shown({ s });
    expect(within(rowOf("toString")).getByRole("button", { name: "Sign in to toString" })).toBeTruthy();
    await user.click(within(rowOf("constructor")).getByRole("switch", { name: "constructor" }));
    await within(rowOf("constructor")).findByText("Turned off: Hermes reads it back that way.");
    const name: string = "constructor";
    expect(s.mcp.servers.default[name].enabled).toBe(false);
  });

  it("drops an answer for a profile no longer shown", async () => {
    const s = server();
    const hermes = await connect(s.openPipe, "default");
    running.push(hermes);
    let release!: () => void;
    s.mcp.listGate = new Promise((r) => (release = r));
    const view = render(<McpSettings api={hermes.mcp} profile="default" connected openUrl={() => {}} />);
    s.mcp.listGate = undefined;
    view.rerender(<McpSettings api={hermes.mcp} profile="work" connected openUrl={() => {}} />);
    await screen.findByText("calendar", { selector: ".mcp-name .mono" });
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("fs", { selector: ".mcp-name .mono" })).toBeNull();
  });
});

describe("Settings → MCP servers: adding and editing", () => {
  it("adds a stdio server from the blank form; its secret goes to Hermes and isn't shown again", async () => {
    const { s, user } = await shown();
    await user.click(screen.getByRole("button", { name: "Add server" }));
    const d = dialog();
    await user.type(within(d).getByRole("textbox", { name: "Name" }), "search");
    await user.type(within(d).getByRole("textbox", { name: "Command" }), "uvx");
    await user.click(within(d).getByRole("button", { name: "Add an argument" }));
    await user.type(within(d).getByRole("textbox", { name: "Argument 1" }), "search-mcp");
    await user.click(within(d).getByRole("button", { name: "Add an argument" }));
    await user.type(within(d).getByRole("textbox", { name: "Argument 2" }), "--fast");
    await user.click(within(d).getByRole("button", { name: "Add a variable" }));
    await user.type(within(d).getByRole("textbox", { name: "Variable 1 name" }), "SEARCH_KEY");
    await user.type(within(d).getByLabelText("SEARCH_KEY value"), "typed-secret-999");
    await user.click(within(d).getByRole("button", { name: "Add" }));
    await screen.findByText("Added search: Hermes reads it back that way.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(s.mcp.servers.default.search).toEqual({ command: "uvx", args: ["search-mcp", "--fast"], env: { SEARCH_KEY: "typed-secret-999" } });
    expect(document.body.textContent).not.toContain("typed-secret");
    expect(within(rowOf("search")).getByText("SEARCH_KEY")).toBeTruthy();
  });

  it("refuses a form that isn't complete before sending, and shows Hermes's own refusal", async () => {
    const { s, user } = await shown();
    await user.click(screen.getByRole("button", { name: "Add server" }));
    const d = dialog();
    await user.type(within(d).getByRole("textbox", { name: "Name" }), "fs");
    await user.type(within(d).getByRole("textbox", { name: "Command" }), "npx");
    await user.click(within(d).getByRole("button", { name: "Add" }));
    expect(within(d).getByRole("alert").textContent).toMatch(/already has a server named fs/);
    await user.clear(within(d).getByRole("textbox", { name: "Name" }));
    await user.type(within(d).getByRole("textbox", { name: "Name" }), "fs2");
    s.mcp.refuse = { status: 400, detail: "Server 'fs2' rejected: suspicious command/args configuration" };
    await user.click(within(d).getByRole("button", { name: "Add" }));
    await within(d).findByText(/Not changed: Server 'fs2' rejected/);
    expect(s.mcp.servers.default.fs2).toBeUndefined();
  });

  it("edits a server without filling in its secrets, keeping the ones left blank", async () => {
    const { s, user } = await shown();
    await user.click(within(rowOf("fs")).getByRole("button", { name: "Edit fs" }));
    const d = dialog();
    expect((within(d).getByRole("textbox", { name: "Command" }) as HTMLInputElement).value).toBe("npx");
    expect([1, 2, 3].map((i) => (within(d).getByRole("textbox", { name: `Argument ${i}` }) as HTMLInputElement).value)).toEqual(["-y", "@x/fs", "/srv"]);
    const value = within(d).getByLabelText("API_KEY value") as HTMLInputElement;
    expect(value.value).toBe("");
    expect(value.placeholder).toMatch(/blank keeps it/);
    await user.clear(within(d).getByRole("textbox", { name: "Command" }));
    await user.type(within(d).getByRole("textbox", { name: "Command" }), "bunx");
    await user.click(within(d).getByRole("button", { name: "Save" }));
    await within(rowOf("fs")).findByText("Saved: Hermes reads it back that way.");
    expect(s.mcp.servers.default.fs).toEqual({ command: "bunx", args: ["-y", "@x/fs", "/srv"], env: { API_KEY: SECRET } });
    expect(s.mcp.servers.default.web).toEqual({ url: "https://web.example/mcp", headers: { Authorization: "Bearer ${MCP_WEB_API_KEY}" } });
  });

  it("keeps each argument as Hermes has it, an empty one and one with a line break too, when saved unchanged", async () => {
    const s = server();
    const args = ["--label", "", "--script", "first line\nsecond line"];
    s.mcp.servers.default.fs.args = [...args];
    const { user } = await shown({ s });
    await user.click(within(rowOf("fs")).getByRole("button", { name: "Edit fs" }));
    expect((within(dialog()).getByRole("textbox", { name: "Argument 4" }) as HTMLTextAreaElement).value).toBe("first line\nsecond line");
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    await within(rowOf("fs")).findByText("Saved: Hermes reads it back that way.");
    expect(s.mcp.servers.default.fs.args).toEqual(args);
  });

  it("says when an edit's new token was saved but Hermes refused the rest", async () => {
    const { s, user } = await shown();
    await user.click(within(rowOf("web")).getByRole("button", { name: "Edit web" }));
    await user.type(within(dialog()).getByLabelText("Bearer token"), "tok-partial");
    s.mcp.refuse = { status: 400, detail: "rejected" };
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    await within(dialog()).findByText(/Hermes didn't confirm it: Hermes saved the new bearer token, but not the rest/);
    // What reached Hermes isn't kept on screen.
    expect((within(dialog()).getByLabelText("Bearer token") as HTMLInputElement).value).toBe("");
  });

  it("replaces a bearer token only when one is typed, and never shows the saved one", async () => {
    const { s, user } = await shown();
    s.mcp.probes.web = { error: "401 Unauthorized" };
    await user.click(screen.getByRole("button", { name: "Test web" }));
    await within(rowOf("web")).findByText(/Couldn't connect/);
    await user.click(within(rowOf("web")).getByRole("button", { name: "Edit web" }));
    let token = within(dialog()).getByLabelText("Bearer token") as HTMLInputElement;
    expect(token.value).toBe("");
    await user.type(token, "fresh-token-42");
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    await within(rowOf("web")).findByText("Saved: Hermes reads it back that way.");
    expect(s.mcp.env.default.MCP_WEB_API_KEY).toBe("fresh-token-42");
    // The Test from before the edit is gone with it.
    expect(within(rowOf("web")).queryByText(/Couldn't connect/)).toBeNull();
    await user.click(within(rowOf("web")).getByRole("button", { name: "Edit web" }));
    token = within(dialog()).getByLabelText("Bearer token") as HTMLInputElement;
    expect(token.value).toBe("");
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says an edit was refused when another client removed the server meanwhile", async () => {
    const { s, user } = await shown();
    await user.click(within(rowOf("fs")).getByRole("button", { name: "Edit fs" }));
    delete s.mcp.servers.default.fs;
    await user.click(within(dialog()).getByRole("button", { name: "Save" }));
    await within(dialog()).findByText(/no server named fs now/);
  });
});

describe("Settings → MCP servers: remove, test and sign in", () => {
  it("asks before removing, and removes only on Remove", async () => {
    const { s, user } = await shown();
    await user.click(within(rowOf("fs")).getByRole("button", { name: "Remove fs" }));
    const ask = screen.getByRole("group", { name: "Remove fs?" });
    await user.click(within(ask).getByRole("button", { name: "Keep it" }));
    expect(s.mcp.servers.default.fs).toBeDefined();
    await user.click(within(rowOf("fs")).getByRole("button", { name: "Remove fs" }));
    await user.click(within(screen.getByRole("group", { name: "Remove fs?" })).getByRole("button", { name: "Remove" }));
    await screen.findByText("Removed fs: Hermes reads it back that way.");
    expect(s.mcp.servers.default.fs).toBeUndefined();
    expect(screen.queryByText("fs", { selector: ".mcp-name .mono" })).toBeNull();
  });

  it("tests a server and shows its tools, or why it couldn't connect", async () => {
    const s = server();
    s.mcp.probes.fs = { tools: [{ name: "read_file", description: "Read a file" }, { name: "list_dir", description: "" }] };
    s.mcp.probes.web = { error: "401 Unauthorized" };
    const { user } = await shown({ s });
    await user.click(screen.getByRole("button", { name: "Test fs" }));
    await within(rowOf("fs")).findByText(/Connected at .*: 2 tools/);
    expect(within(rowOf("fs")).getByText("read_file")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Test web" }));
    await within(rowOf("web")).findByText(/Couldn't connect at .*: 401 Unauthorized/);
  });

  it("signs in with OAuth: opens the page, follows the flow, and reads the list again", async () => {
    const { s, user, openUrl } = await shown();
    await user.click(screen.getByRole("button", { name: "Sign in to notes" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://auth.example/authorize?client=hermes&server=notes"));
    await within(rowOf("notes")).findByText(/Finish signing in in your browser/);
    s.mcp.approve(Object.keys(s.mcp.flows)[0], [{ name: "search_notes", description: "" }]);
    await within(rowOf("notes")).findByText("Signed in. Hermes found 1 tool.");
    expect(screen.queryByText(/Finish signing in/)).toBeNull();
  });

  it("stops a sign-in under way, and shows a failed one's reason", async () => {
    const { s, user } = await shown();
    await user.click(screen.getByRole("button", { name: "Sign in to notes" }));
    await within(rowOf("notes")).findByText(/Finish signing in/);
    await user.click(within(rowOf("notes")).getByRole("button", { name: "Stop" }));
    await within(rowOf("notes")).findByText("Sign-in stopped.");
    expect(Object.values(s.mcp.flows)[0].error).toBe("Cancelled by user");
    await user.click(screen.getByRole("button", { name: "Sign in to notes" }));
    await waitFor(() => expect(Object.keys(s.mcp.flows)).toHaveLength(2));
    s.mcp.fail(Object.keys(s.mcp.flows)[1], "access_denied");
    await within(rowOf("notes")).findByText("Sign-in didn't finish: access_denied");
  });

  it("stops a sign-in on Hermes when it can no longer be followed, so the next one can start", async () => {
    const { s, user } = await shown();
    s.mcp.flowReadsFail = true;
    await user.click(screen.getByRole("button", { name: "Sign in to notes" }));
    await within(rowOf("notes")).findByText(/Lost track of the sign-in, so it was stopped/);
    await waitFor(() => expect(Object.values(s.mcp.flows)[0].error).toBe("Cancelled by user"));
    s.mcp.flowReadsFail = false;
    await user.click(screen.getByRole("button", { name: "Sign in to notes" }));
    await within(rowOf("notes")).findByText(/Finish signing in/);
    expect(Object.keys(s.mcp.flows)).toHaveLength(2);
  });

  it("cancels a sign-in left waiting when the screen closes", async () => {
    const { s, user, view } = await shown();
    await user.click(screen.getByRole("button", { name: "Sign in to notes" }));
    await within(rowOf("notes")).findByText(/Finish signing in/);
    view.unmount();
    await waitFor(() => expect(Object.values(s.mcp.flows)[0].status).toBe("error"));
  });
});

describe("Settings → MCP servers: the catalog", () => {
  it("installs an entry with the value it asks for, showing what it runs first", async () => {
    const s = server();
    s.mcp.catalogEntries = [{ name: "github", description: "GitHub's MCP server", transport: "stdio", command: "github-mcp", args: ["stdio"], env: [{ name: "GITHUB_TOKEN", prompt: "GitHub token" }] }];
    const { user } = await shown({ s });
    await user.click(screen.getByRole("button", { name: "From catalog" }));
    await user.click(await within(dialog()).findByRole("button", { name: /github/ }));
    expect(within(dialog()).getByText("github-mcp stdio")).toBeTruthy();
    const install = within(dialog()).getByRole("button", { name: "Install" }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    await user.type(within(dialog()).getByLabelText(/GitHub token/), "ghp_typed");
    await user.click(install);
    await screen.findByText("Installed github: Hermes reads it back that way.");
    expect(s.mcp.env.default.GITHUB_TOKEN).toBe("ghp_typed");
    expect(s.mcp.servers.default.github).toEqual({ command: "github-mcp", args: ["stdio"] });
  });
});

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

describe("Settings → MCP servers: the tab", () => {
  it("has its own tab with a profile picker starting on the profile in use", async () => {
    const s = server();
    const hermes = await connect(s.openPipe, "default");
    running.push(hermes);
    const user = userEvent.setup();
    function Shell() {
      const [appearance] = useState(() => appearanceStore(memoryStorage(), document.createElement("html")));
      return (
        <SettingsScreen
          status="connected"
          unsecure={false}
          username="liam"
          passwordSaved
          profile="default"
          olderPulled={false}
          cacheBytes={() => 0}
          appearance={appearance}
          listFonts={async () => ({ all: [], mono: [] })}
          modelSettings={hermes.modelSettings}
          mcp={hermes.mcp}
          listProfiles={async () => ["default", "work"]}
          onClearCache={() => {}}
          onPullOlder={async () => []}
          onSignOut={async () => {}}
          onClose={() => {}}
        />
      );
    }
    render(<Shell />);
    await user.click(screen.getByRole("tab", { name: "MCP servers" }));
    await screen.findByText("fs", { selector: ".mcp-name .mono" });
    const pick = screen.getByRole("combobox", { name: "Profile whose MCP servers are shown" }) as HTMLSelectElement;
    expect(pick.value).toBe("default");
    await waitFor(() => expect(pick.disabled).toBe(false));
    await user.selectOptions(pick, "work");
    await screen.findByText("calendar", { selector: ".mcp-name .mono" });
    expect(screen.queryByText("fs", { selector: ".mcp-name .mono" })).toBeNull();
  });
});
