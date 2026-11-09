// A fake Hermes's subscription sign-ins and custom endpoints, for tests of Settings → Providers (ADR 0106): the
// `/api/providers/oauth` and `/api/providers/custom-endpoints` routes as the deployed `bf0203a` answers them
// (`hermes_cli/web_routers/oauth.py`, `config_env.py`), and the Rust side's reads and endpoint save, which drop the
// previews and check before saving (`Dashboard::provider_sign_ins`, `custom_endpoints`, `save_endpoint`). Each profile
// keeps its own sign-ins and endpoints.
import { endpointFormProblem, type CustomEndpoint, type EndpointForm, type EndpointSave, type ProviderSignIn } from "./accounts";
import type { RestRequest } from "./fakeHermes";

const answered = (status: number, detail: string) => new Error(`The dashboard answered ${status}: ${JSON.stringify({ detail })}`);
const NOT_FOUND = () => answered(404, "Not Found");

type Provider = { id: string; name: string; flow: "device_code" | "external"; cli_command: string };

/** `_OAUTH_PROVIDER_CATALOG` at `bf0203a`, trimmed. */
const CATALOG: Provider[] = [
  { id: "nous", name: "Nous Portal", flow: "device_code", cli_command: "hermes auth add nous" },
  { id: "openai-codex", name: "ChatGPT or Codex Subscription", flow: "device_code", cli_command: "hermes auth add openai-codex" },
  { id: "xai-oauth", name: "xAI Grok OAuth (SuperGrok / Premium+)", flow: "device_code", cli_command: "hermes auth add xai-oauth" },
  { id: "anthropic", name: "Anthropic Account", flow: "external", cli_command: "hermes auth add anthropic" },
];

type Session = { id: string; provider: string; profile: string; status: "pending" | "approved" | "denied" | "expired" | "error"; error?: string };
type Endpoint = { id: string; name: string; base_url: string; model: string; models: string[]; key?: string };

export class FakeAccounts {
  /** False: a server without these routes, which answers each with 404 Not Found. */
  routes = true;
  /** Signed-in providers by profile. `nous` starts signed in on `default`. */
  readonly signedIn: Record<string, Set<string>> = { default: new Set(["nous"]) };
  /** Sign-ins Hermes can't sign out from here, as when the token came from an env var. */
  readonly fromEnv = new Set<string>();
  readonly sessions = new Map<string, Session>();
  /** Endpoints by profile, and the one each profile uses as its default. */
  readonly endpoints: Record<string, Endpoint[]> = {};
  readonly current: Record<string, string | undefined> = {};
  /** What a check of an endpoint at an address finds: one with `offline` in it can't be reached. */
  check = (form: EndpointForm): { ok: boolean; message: string; models: string[] } =>
    form.baseUrl.includes("offline")
      ? { ok: false, message: `Could not reach ${form.baseUrl.trim()}/models.`, models: [] }
      : { ok: true, message: "", models: ["llama3.2", "qwen3:8b"] };
  private sessionCount = 0;

  constructor(private readonly knownProfile: (p: string) => boolean) {}

  /** Settles a sign-in as the provider would once the owner acts in the browser: Hermes saves the token on approval. */
  settle(session: string, status: "approved" | "denied" | "expired" | "error", error?: string) {
    const s = this.sessions.get(session);
    if (!s) throw new Error(`no sign-in ${session}`);
    Object.assign(s, { status, error });
    if (status === "approved") (this.signedIn[s.profile] ??= new Set()).add(s.provider);
  }

  /** The sign-in under way for `provider`, if any. */
  pending(provider: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.provider === provider && s.status === "pending");
  }

  private profileOf(req: RestRequest): string {
    const p = req.query.get("profile") || "default";
    if (!this.knownProfile(p)) throw answered(404, `Profile '${p}' does not exist.`);
    return p;
  }

  /** `Dashboard::provider_sign_ins`: `GET /api/providers/oauth`, without token previews. */
  signIns(profile: string): ProviderSignIn[] {
    if (!this.routes) throw NOT_FOUND();
    return CATALOG.map((p) => {
      const signedIn = !!this.signedIn[profile]?.has(p.id);
      const disconnectable = p.flow === "device_code" && !this.fromEnv.has(p.id);
      return {
        id: p.id,
        name: p.name,
        flow: p.flow,
        signedIn,
        canSignOut: signedIn && disconnectable,
        ...(p.flow === "external" ? { command: p.cli_command } : {}),
        ...(signedIn && !disconnectable ? { signOutHint: "Remove the API key from Settings → Keys instead." } : {}),
      };
    });
  }

  /** `Dashboard::custom_endpoints`: `GET /api/providers/custom-endpoints`, without key previews. */
  list(profile: string): CustomEndpoint[] {
    if (!this.routes) throw NOT_FOUND();
    return (this.endpoints[profile] ?? []).map((e) => ({ id: e.id, name: e.name, baseUrl: e.base_url, model: e.model, hasKey: !!e.key, current: this.current[profile] === e.id }));
  }

  /** `Dashboard::save_endpoint`: the form checked, the endpoint checked, then saved with the models found. */
  save(profile: string, form: EndpointForm, anyway: boolean): EndpointSave {
    if (!this.routes) throw NOT_FOUND();
    const problem = endpointFormProblem(form);
    if (problem) throw new Error(problem);
    const checked = this.check(form);
    if (!checked.ok && !anyway) return { outcome: "checkFailed", message: checked.message };
    const model = form.model.trim() || checked.models[0];
    if (!model) throw new Error("Enter the model's name: Hermes found no models at that address.");
    const id = form.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const list = (this.endpoints[profile] ??= []);
    const key = form.key?.trim() || list.find((e) => e.id === id)?.key;
    const entry: Endpoint = { id, name: form.name.trim(), base_url: form.baseUrl.trim().replace(/\/+$/, ""), model, models: checked.models, key };
    this.endpoints[profile] = [...list.filter((e) => e.id !== id), entry];
    return { outcome: "saved", id, checked: checked.ok };
  }

  route(req: RestRequest): (() => Promise<unknown>) | undefined {
    const m = /^\/api\/providers\/(oauth|custom-endpoints)(?:\/(.*))?$/.exec(req.path);
    if (!m) return undefined;
    if (!this.routes) return async () => Promise.reject(NOT_FOUND());
    const parts = (m[2] ?? "").split("/").map(decodeURIComponent);
    return async () => (m[1] === "oauth" ? this.oauth(req, parts) : this.custom(req, parts));
  }

  private oauth(req: RestRequest, parts: string[]): unknown {
    const profile = this.profileOf(req);
    const [a, b, c] = parts;
    if (req.method === "POST" && b === "start" && parts.length === 2) {
      const p = CATALOG.find((x) => x.id === a);
      if (!p) throw answered(400, `Unknown provider ${a}`);
      if (p.flow === "external") throw answered(400, `${a} uses an external CLI; run \`${p.cli_command}\` manually`);
      const id = `sess-${++this.sessionCount}`;
      this.sessions.set(id, { id, provider: a, profile, status: "pending" });
      return { session_id: id, flow: "device_code", user_code: `WXYZ-${1000 + this.sessionCount}`, verification_url: "https://portal.example/device", expires_in: 900, poll_interval: 5 };
    }
    if (req.method === "GET" && b === "poll" && parts.length === 3) {
      const s = this.sessions.get(c);
      if (!s) throw answered(404, "Session not found or expired");
      if (s.provider !== a) throw answered(400, "Provider mismatch for session");
      if (s.profile !== profile) throw answered(400, "OAuth session profile mismatch");
      return { session_id: s.id, status: s.status, error_message: s.error ?? null };
    }
    if (req.method === "DELETE" && a === "sessions" && parts.length === 2) {
      const s = this.sessions.get(b);
      if (!s) return { ok: false, message: "session not found" };
      if (s.profile !== profile) throw answered(400, "OAuth session profile mismatch");
      this.sessions.delete(b);
      return { ok: true, session_id: b };
    }
    if (req.method === "DELETE" && parts.length === 1) {
      const p = CATALOG.find((x) => x.id === a);
      if (!p) throw answered(400, `Unknown provider: ${a}`);
      if (p.flow === "external" || this.fromEnv.has(a)) throw answered(400, `${p.name} cannot be disconnected automatically.`);
      if (!this.signedIn[profile]?.delete(a)) throw answered(409, `No stored credentials were removed for ${p.name}.`);
      return { ok: true, provider: a };
    }
    throw answered(405, "Method Not Allowed");
  }

  private custom(req: RestRequest, parts: string[]): unknown {
    const profile = this.profileOf(req);
    const list = this.endpoints[profile] ?? [];
    const [id, action] = parts;
    if (req.method === "POST" && action === "activate" && parts.length === 2) {
      const e = list.find((x) => x.id === id);
      if (!e) throw answered(404, "custom endpoint not found");
      this.current[profile] = id;
      return { ok: true, provider: id, model: e.model };
    }
    if (req.method === "DELETE" && parts.length === 1 && id) {
      if (!list.some((x) => x.id === id)) throw answered(404, "custom endpoint not found");
      this.endpoints[profile] = list.filter((x) => x.id !== id);
      if (this.current[profile] === id) this.current[profile] = undefined;
      return { ok: true };
    }
    // The list and the save are Rust's (`signIns`, `save`), and the window can't reach them through the relay.
    throw answered(405, "Method Not Allowed");
  }
}
