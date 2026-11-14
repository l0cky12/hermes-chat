// The whole app, as the window starts it, with a fake Rust side in front of FakeHermes (ADR 0163).
import { afterEach, beforeEach, expect, type TestContext } from "vitest";
import { page, server as vitest } from "vitest/browser";
import { FakeHermes } from "../src/hermes/fakeHermes";
import type { Pipe, PipeEvent } from "../src/hermes/pipe";

/** One Rust command as the webview invokes it. */
type Command = (args: Record<string, any>) => unknown;
export type Commands = Record<string, Command>;

export type BootOptions = {
  /** Seeds the server before the app launches. */
  seed?: (server: FakeHermes) => void;
  /** False: no password is in the keyring, so launch shows the sign-in screen. */
  signedIn?: boolean;
  /** The dashboard password the server takes. */
  password?: string;
  /** Replace or add commands of the fake Rust side. */
  commands?: Commands;
};

export type Rust = {
  /** Every command the app invoked, in order, with its arguments. */
  calls: { cmd: string; args: Record<string, any> }[];
  /** Commands nothing here answers; each got `undefined`. */
  unhandled: Set<string>;
  keyring: Map<string, string>;
};

export const SIGN_IN = { mode: "url", sshTarget: "", url: "https://hermes.example.net", username: "owner" } as const;

declare global {
  interface Window {
    /** What the app frame's `invoke` calls (e2e/ipc.ts). */
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

/**
 * Starts the app in a frame of its own, from `src/main.tsx` as the window does, against a fresh FakeHermes. `app`
 * finds what is on its screen.
 */
export async function boot(opts: BootOptions = {}) {
  const ctx = test!;
  const server = new FakeHermes();
  opts.seed?.(server);
  const password = opts.password ?? "hunter2";
  const pipes = new Map<string, Pipe>();
  const rust: Rust = { calls: [], unhandled: new Set(), keyring: new Map() };
  const slot = (kind: string, args: Record<string, any>) => `${kind}:${args.connection ?? "legacy"}`;
  const pipe = (args: Record<string, any>) => {
    const held = pipes.get(args.attempt);
    // src-tauri live.rs: a command for an attempt no longer held.
    if (!held) throw "The connection is closed.";
    return held;
  };

  const commands: Commands = {
    hermes_connect: async (args) => {
      if (args.credential.password !== password) throw { stage: "sign-in", message: "Wrong username or password.", status: null };
      const channel = args.onEvent as { onmessage: (e: PipeEvent) => void };
      pipes.set(args.attempt, await server.openPipe((e) => channel.onmessage(e), args.profile));
      return routeOf(args.target);
    },
    // A dashboard that offers password sign-in only, as src-tauri `hermes_reach` reads it.
    hermes_reach: (args) => ({
      route: routeOf(args.target),
      status: JSON.stringify({ version: "0.22.6", auth_required: true, auth_providers: ["basic"] }),
      methods: args.methods ? { methods: [{ method: "password", provider: "basic", label: "Password" }] } : undefined,
    }),
    hermes_send: (args) => pipe(args).send(args.frame),
    hermes_request: (args) => pipe(args).request(args.method, args.path, args.body),
    hermes_get_limited: (args) => pipe(args).getLimited(args.path, args.maxBytes),
    hermes_voice_setup: (args) => pipe(args).voiceSetup(args.profile),
    hermes_toolset_guards: (args) => pipe(args).toolsetGuards(args.profile),
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
    ...opts.commands,
  };

  window.e2eInvoke = async (cmd, args) => {
    const a = (args ?? {}) as Record<string, any>;
    rust.calls.push({ cmd, args: a });
    const handler = commands[cmd];
    if (handler) return handler(a);
    if (!rust.unhandled.has(cmd)) {
      rust.unhandled.add(cmd);
      // The summary lists these. One invoked after the test ended can't be recorded on it.
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

/** Saves a screenshot as `e2e/out/screenshots/<feature>/<test>--<name>.png` and lists it in the summary. */
export async function shot(name: string) {
  const ctx = test!;
  const feature = ctx.task.file.name.replace(/^.*\//, "").replace(/\.e2e\.tsx$/, "");
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const relative = `e2e/out/screenshots/${feature}/${slug(ctx.task.name)}--${slug(name)}.png`;
  await page.screenshot({ path: `${vitest.config.root}/${relative}` });
  await ctx.annotate(relative, "screenshot");
  return relative;
}

/** Waits until Hermes got `text` as a prompt, and returns the runtime session it was sent in. */
export async function submitted(server: FakeHermes, text: string): Promise<string> {
  await expect.poll(() => server.last("prompt.submit")?.params.text, { message: "the prompt Hermes got" }).toBe(text);
  return String(server.last("prompt.submit")!.params.session_id);
}
