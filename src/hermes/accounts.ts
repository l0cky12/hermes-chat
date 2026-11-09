// Settings → Providers' subscription sign-ins and custom endpoints (ADR 0106), on Hermes's routes at the deployed
// `bf0203a` (`hermes_cli/web_routers/oauth.py`, `config_env.py`):
// - Both lists come from Rust (`Pipe.providerSignIns`, `Pipe.customEndpoints`), which drops Hermes's token and key
//   previews, so no part of a token or key reaches the window.
// - A device-code sign-in is `POST …/oauth/{id}/start`, then `GET …/oauth/{id}/poll/{session}?wait=` until it leaves
//   `pending`, or `DELETE …/oauth/sessions/{session}` to cancel. Signing out is `DELETE …/oauth/{id}`.
// - Saving an endpoint carries its key, so Rust checks and saves it (`Pipe.saveEndpoint`). Activating is `POST
//   …/custom-endpoints/{id}/activate`, removing `DELETE …/custom-endpoints/{id}`.
// Every change is confirmed by reading the list again: the screen shows what the list says, not what a write answered.
import { failureOf, isNoRoute } from "./capabilities";
import type { Pipe, RestMethod } from "./pipe";

export type ProviderSignIn = {
  id: string;
  name: string;
  /** `device_code`: the app drives the sign-in. `external`: it is done on the server's command line (`command`). */
  flow: "device_code" | "external";
  signedIn: boolean;
  canSignOut: boolean;
  command?: string;
  expiresAt?: string;
  /** Why Hermes can't sign it out from here, while it is signed in. */
  signOutHint?: string;
};

export type CustomEndpoint = { id: string; name: string; baseUrl: string; model: string; hasKey: boolean; current: boolean };

/** The Add an endpoint form. `model` blank: the first model Hermes finds there. `key` blank: the endpoint takes none. */
export type EndpointForm = { name: string; baseUrl: string; model: string; key?: string };

/** `checkFailed`: Hermes's check of the endpoint didn't pass, and nothing was saved. */
export type EndpointSave = { outcome: "saved"; id: string; checked: boolean } | { outcome: "checkFailed"; message: string };

/** A list, or, in `unsupported`, why this Hermes has no route for it. */
export type Listed<T> = { items: T[]; unsupported?: string };

/** A device-code sign-in under way: the code the owner types at `verificationUrl`. */
export type StartedSignIn = { session: string; userCode: string; verificationUrl: string; expiresIn: number };

export type SignInProgress = { state: "pending" } | { state: "approved" } | { state: "failed"; why: string };

/** How long one poll waits on Hermes for the sign-in to move. Hermes caps it at 25 seconds. */
export const SIGN_IN_WAIT_S = 20;

/** What is wrong with the form, the rules `Dashboard::save_endpoint` checks again; undefined when it can be sent. */
export function endpointFormProblem(form: EndpointForm): string | undefined {
  const line = (s: string, max: number) => s.length <= max && !/[\u0000-\u001f\u007f]/.test(s);
  const name = form.name.trim();
  if (!name || !line(name, 64)) return "Give the endpoint a name of up to 64 characters.";
  let url: URL | undefined;
  try {
    url = new URL(form.baseUrl.trim());
  } catch {
    url = undefined;
  }
  if (!url || !/^https?:$/.test(url.protocol) || !url.hostname || !line(form.baseUrl.trim(), 2048))
    return "Enter the endpoint's address, starting with http:// or https://, such as http://localhost:11434/v1.";
  if (!line(form.model.trim(), 256)) return "The model name is too long.";
  const key = form.key?.trim() ?? "";
  if (key && (!line(key, 4096) || key.includes(" "))) return "Paste the API key on one line, without spaces.";
  return undefined;
}

/** Hermes's poll answer as the screen reads it. Anything but `pending` and `approved` ends the sign-in. */
export function progressOf(answer: unknown): SignInProgress {
  const a = (answer ?? {}) as Record<string, unknown>;
  const said = typeof a.error_message === "string" && a.error_message.trim() ? a.error_message.trim() : undefined;
  switch (a.status) {
    case "pending":
      return { state: "pending" };
    case "approved":
      return { state: "approved" };
    case "denied":
      return { state: "failed", why: said ?? "The sign-in was turned down in the browser." };
    case "expired":
      return { state: "failed", why: "The code expired before the sign-in finished. Start again for a new one." };
    case "cancelled":
      return { state: "failed", why: "The sign-in was cancelled." };
    default:
      return { state: "failed", why: said ?? "Hermes couldn't finish the sign-in, and didn't say why." };
  }
}

function startedOf(answer: unknown): StartedSignIn {
  const a = (answer ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const started = { session: text(a.session_id), userCode: text(a.user_code), verificationUrl: text(a.verification_url), expiresIn: typeof a.expires_in === "number" ? a.expires_in : 0 };
  if (!started.session || !started.userCode || !/^https:\/\//.test(started.verificationUrl)) throw new Error("Hermes started the sign-in, but its answer had no code or no https:// page to enter it at.");
  return started;
}

const q = (profile: string, more: Record<string, string> = {}) => new URLSearchParams({ profile, ...more }).toString();
const seg = encodeURIComponent;

/** A read that says `unsupported` for a route Hermes doesn't have, and throws for any other failure. */
async function listed<T>(read: () => Promise<T[]>): Promise<Listed<T>> {
  try {
    return { items: await read() };
  } catch (e) {
    const f = failureOf(e);
    if (isNoRoute(f)) return { items: [], unsupported: `Hermes has no such route (it answered ${f.status})` };
    throw e;
  }
}

/** Rejects with Hermes's own reason, without the relay's "The dashboard answered n:" wrapping. */
async function plainly<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw new Error(failureOf(e).reason);
  }
}

export type AccountsDeps = {
  rest: (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>;
  /** The connected pipe, or a rejection when there is none. */
  pipe: () => Pipe;
  /**
   * Runs a change after every provider change sent before it for `profile` has settled, then has the models read
   * again, so the model picker follows (`Hermes.oneProviderChangeAtATime`).
   */
  change: <T>(profile: string, run: () => Promise<T>) => Promise<T>;
  /** Resolves once every change sent for `profile` has settled, so a list read after it isn't stale. */
  settled: (profile: string) => Promise<void>;
};

export class AccountsApi {
  constructor(private readonly deps: AccountsDeps) {}

  async signIns(profile: string): Promise<Listed<ProviderSignIn>> {
    await this.deps.settled(profile);
    return listed(() => this.deps.pipe().providerSignIns(profile));
  }

  async endpoints(profile: string): Promise<Listed<CustomEndpoint>> {
    await this.deps.settled(profile);
    return listed(() => this.deps.pipe().customEndpoints(profile));
  }

  /** Starts a device-code sign-in. Hermes refuses a provider whose flow is `external`. */
  startSignIn(profile: string, provider: string): Promise<StartedSignIn> {
    return plainly(this.deps.rest("POST", `api/providers/oauth/${seg(provider)}/start?${q(profile)}`).then(startedOf));
  }

  /** Waits up to `SIGN_IN_WAIT_S` for the sign-in to move. A session Hermes no longer has has ended. */
  async waitSignIn(profile: string, provider: string, session: string): Promise<SignInProgress> {
    try {
      return progressOf(await this.deps.rest("GET", `api/providers/oauth/${seg(provider)}/poll/${seg(session)}?${q(profile, { wait: String(SIGN_IN_WAIT_S) })}`));
    } catch (e) {
      const f = failureOf(e);
      if (f.status === 404) return { state: "failed", why: "Hermes no longer has this sign-in: it may have restarted, or the code expired. Start again." };
      throw new Error(f.reason);
    }
  }

  /** Stops a sign-in under way, so Hermes doesn't finish it after the owner gave up. Never fails. */
  async cancelSignIn(profile: string, session: string): Promise<void> {
    await this.deps.rest("DELETE", `api/providers/oauth/sessions/${seg(session)}?${q(profile)}`).catch(() => undefined);
  }

  /** Tells the model picker a sign-in finished, so it reads the models again. */
  signedIn(profile: string): Promise<void> {
    return this.deps.change(profile, async () => undefined);
  }

  /** Signs out. Hermes's 409, nothing stored to remove, is left for the list to settle. */
  signOut(profile: string, provider: string): Promise<void> {
    return this.deps.change(profile, () => plainly(this.deps.rest("DELETE", `api/providers/oauth/${seg(provider)}?${q(profile)}`)).then(() => undefined));
  }

  saveEndpoint(profile: string, form: EndpointForm, anyway: boolean): Promise<EndpointSave> {
    const problem = endpointFormProblem(form);
    if (problem) return Promise.reject(new Error(problem));
    return this.deps.change(profile, () => this.deps.pipe().saveEndpoint(profile, form, anyway));
  }

  activateEndpoint(profile: string, id: string): Promise<void> {
    return this.deps.change(profile, () => plainly(this.deps.rest("POST", `api/providers/custom-endpoints/${seg(id)}/activate?${q(profile)}`)).then(() => undefined));
  }

  /** Removes an endpoint, and Hermes removes its key with it. One Hermes no longer has counts as removed. */
  removeEndpoint(profile: string, id: string): Promise<void> {
    return this.deps.change(profile, async () => {
      try {
        await this.deps.rest("DELETE", `api/providers/custom-endpoints/${seg(id)}?${q(profile)}`);
      } catch (e) {
        const f = failureOf(e);
        if (f.status !== 404 || isNoRoute(f)) throw new Error(f.reason);
      }
    });
  }
}
