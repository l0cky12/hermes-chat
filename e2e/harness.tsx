import { afterEach, beforeEach, expect, type TestContext } from "vitest";
import { page, server as vitest } from "vitest/browser";
import { FakeHermes } from "../src/hermes/fakeHermes";
import type { Pipe, PipeEvent } from "../src/hermes/pipe";

type Command = (args: Record<string, any>) => unknown;
export type Commands = Record<string, Command>;

export type BootOptions = {
  seed?: (server: FakeHermes) => void;
  signedIn?: boolean;
  dashboardPassword?: string;
  commands?: Commands;
};

export type Rust = {
  calls: { cmd: string; args: Record<string, any> }[];
  unhandled: Set<string>;
  keyring: Map<string, string>;
};

const PASSWORD_ONLY_DASHBOARD = {
  status: { version: "0.22.6", auth_required: true, auth_providers: ["basic"] },
  methods: { methods: [{ method: "password", provider: "basic", label: "Password" }] },
};

export const SIGN_IN = { mode: "url", sshTarget: "", url: "https://hermes.example.net", username: "owner" } as const;

declare global {
  interface Window {
    e2eInvoke?: (cmd: string, args: unknown) => Promise<unknown>;
  }
}

let test: TestContext | undefined;

beforeEach((ctx) => {
  test = ctx;
});

afterEach(() => {
  test = undefined;
  window.e2eInvoke = undefined;
  document.body.replaceChildren();
  localStorage.clear();
});

const routeOf = (target: Record<string, any>) => (target.kind === "url" ? { kind: "url", url: target.url, addresses: [] } : { kind: "ssh", target: target.target });

export async function boot(opts: BootOptions = {}) {
  const ctx = test!;
  const server = new FakeHermes();
  opts.seed?.(server);
  const password = opts.dashboardPassword ?? "hunter2";
  const pipes = new Map<string, Pipe>();
  const rust: Rust = { calls: [], unhandled: new Set(), keyring: new Map() };
  const slot = (kind: string, args: Record<string, any>) => `${kind}:${args.connection ?? "legacy"}`;
  const heldPipe = (args: Record<string, any>) => {
    const held = pipes.get(args.attempt);
    if (!held) throw "The chat connection is closed.";
    return held;
  };

  const commands: Commands = {
    hermes_connect: async (args) => {
      if (args.credential.password !== password) throw { stage: "sign-in", message: "Wrong username or password.", status: null };
      const channel = args.onEvent as { onmessage: (e: PipeEvent) => void };
      pipes.set(args.attempt, await server.openPipe((e) => channel.onmessage(e), args.profile));
      return routeOf(args.target);
    },
    hermes_reach: (args) => ({
      route: routeOf(args.target),
      status: JSON.stringify(PASSWORD_ONLY_DASHBOARD.status),
      methods: args.methods ? PASSWORD_ONLY_DASHBOARD.methods : undefined,
    }),
    hermes_send: (args) => heldPipe(args).send(args.frame),
    hermes_request: (args) => heldPipe(args).request(args.method, args.path, args.body),
    hermes_get_limited: (args) => heldPipe(args).getLimited(args.path, args.maxBytes),
    hermes_voice_setup: (args) => heldPipe(args).voiceSetup(args.profile),
    hermes_toolset_guards: (args) => heldPipe(args).toolsetGuards(args.profile),
    hermes_disconnect: async (args) => {
      await pipes.get(args.attempt)?.close();
      pipes.delete(args.attempt);
    },
    password_load: (args) => rust.keyring.get(slot("password", args)) ?? null,
    headers_load: (args) => rust.keyring.get(slot("headers", args)) ?? null,
    password_save: (args) => void rust.keyring.set(slot("password", args), args.password),
    headers_save: (args) => void rust.keyring.set(slot("headers", args), args.headers),
    password_delete: (args) => void rust.keyring.delete(slot("password", args)),
    headers_delete: (args) => void rust.keyring.delete(slot("headers", args)),
    token_saved: () => null,
    token_delete: () => undefined,
    chat_link_take: () => null,
    connection_attempts_read: () => ({ attempts: [], unreadable: 0 }),
    connection_attempts_put: () => undefined,
    update_install_kind: () => ({ kind: "unmanaged", version: "0.0.0" }),
    local_stt_state: () => ({ onThisComputer: false }),
    tray_inbox: () => undefined,
    screenshot_pending_request: () => null,
    screenshot_sync_outbox: () => undefined,
    restart_drafts_read: () => ({ kind: "none" }),
    window_hidden: () => false,
    "plugin:window|is_focused": () => true,
    touch_keyboard_covered: () => 0,
    project_defaults_read: () => null,
    tags_read: () => null,
    ...opts.commands,
  };

  window.e2eInvoke = async (cmd, args) => {
    const a = (args ?? {}) as Record<string, any>;
    rust.calls.push({ cmd, args: a });
    const handler = commands[cmd];
    if (handler) return handler(a);
    if (!rust.unhandled.has(cmd)) {
      rust.unhandled.add(cmd);
      // A command invoked after the test ended can't be recorded on it.
      if (test === ctx) ctx.annotate(cmd, "unhandled-command").catch(() => {});
    }
    return undefined;
  };

  localStorage.setItem("hermes-chat.sign-in", JSON.stringify(SIGN_IN));
  if (opts.signedIn ?? true) rust.keyring.set("password:legacy", password);
  const frame = Object.assign(document.createElement("iframe"), { title: "Hermes Chat", src: "/e2e/app.html" });
  frame.style.cssText = "position: fixed; inset: 0; width: 100%; height: 100%; border: 0";
  document.body.replaceChildren(frame);
  return { server, rust, app: page.frameLocator(page.getByTitle("Hermes Chat")) };
}

export async function shot(name: string) {
  const ctx = test!;
  const feature = ctx.task.file.name.replace(/^.*\//, "").replace(/\.e2e\.tsx$/, "");
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const relative = `e2e/out/screenshots/${feature}/${slug(ctx.task.name)}--${slug(name)}.png`;
  await page.screenshot({ path: `${vitest.config.root}/${relative}` });
  await ctx.annotate(relative, "screenshot");
  return relative;
}

export async function sessionOfPrompt(server: FakeHermes, text: string): Promise<string> {
  await expect.poll(() => server.last("prompt.submit")?.params.text, { message: "the prompt Hermes got" }).toBe(text);
  return String(server.last("prompt.submit")!.params.session_id);
}
