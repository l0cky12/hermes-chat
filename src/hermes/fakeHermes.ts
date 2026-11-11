// A fake Hermes dashboard for tests: it sits where the Rust pipe does and speaks wire-shaped legacy
// JSON-RPC frames and dashboard REST bodies (shapes from the deployed contracts, see the research doc).
import { RestError, type LocalFile, type OpenPipe, type PipeEvent, type RestMethod, type Route, type Speech, type ToolsetGuards, type VoiceSetup } from "./pipe";
import type { SavedKey } from "./setup";
import type { ApprovalMode } from "./model";
import { FakeMemoryProviders } from "./fakeMemoryProviders";
import { FakeMcp } from "./fakeMcp";
import { FakeAccounts } from "./fakeAccounts";
import { FakeGateways } from "./fakeGateways";
import { FakeVoiceProviders } from "./fakeVoiceProviders";
import { FakeSkills } from "./fakeSkills";
import { FakeServerFiles } from "./fakeServerFiles";
import { FakeProjectContext } from "./fakeProjectContext";
import { ScheduleError, isoIn, parseSchedule, upcomingRuns } from "./schedule";
import { skillInvocationText } from "./skillCommands";

type Request = { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> };
/** The client's answer to a server→client request (`tui_gateway/server_requests.py`). */
type Response = { jsonrpc: "2.0"; id: string; result?: Record<string, unknown>; error?: { code: number; message: string } };
/** A server→client request still waiting for its answer. `stored`: its session, which outlives the connection. */
type OpenRequest = { sid: string; stored: string; method: string; params: Record<string, unknown> };
type Handler = (req: Request) => void;
export type RestRequest = { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> };
type RestHandler = (req: RestRequest) => unknown;

/** A `sessions` row as dashboard REST `GET /api/sessions` returns it (research doc §5). */
export type SessionRow = {
  id: string;
  source: string;
  title: string | null;
  preview: string;
  started_at: number;
  last_active: number | null;
  message_count: number;
  pinned: boolean;
  archived: boolean;
  /** The model the session last ran on (`sessions.model`). */
  model?: string | null;
  /** The surface that started a `source: "local"` session (`sessions.created_source`); list rows carry it, search rows don't. */
  created_source?: string | null;
  /** The read watermark: unread when activity postdates it. `null` = never tracked = read; 0 = marked unread. */
  last_read_at: number | null;
  /** Bumped by every session edit; an edit must name the current one. Missing means 0. */
  runtime_revision?: number;
  /** The session's runtime generation, which a delete must name (0 unless a test sets it). */
  runtime_generation?: number;
  /** The session a branch was made from (`session.branch` stores it). */
  parent_session_id?: string | null;
  /** The folder the session works in (`sessions.cwd`). */
  cwd?: string | null;
  /**
   * Hermes's stored usage for every model call in the session (`sessions` columns at the deployed `bf0203a`; both list
   * and detail rows carry them). Hermes's helper tasks are kept apart and aren't counted here.
   */
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  api_call_count?: number;
  estimated_cost_usd?: number | null;
  actual_cost_usd?: number | null;
  cost_status?: string | null;
  cost_source?: string | null;
  pricing_version?: string | null;
  /** Who billed the model the session used last. */
  billing_provider?: string | null;
  /**
   * A compressed chat's list row: its first segment's counts under its last segment's id, with every segment's id
   * (`_project_compression_tips` at the deployed `bf0203a`). The other segments are rows with `unlisted` set.
   */
  _lineage_root_id?: string;
  _lineage_ids?: string[];
  /** Not this fake's to send: a stored session no chat list shows (a later compression segment, a subagent run). */
  unlisted?: boolean;
  /** Hermes's generic `hidden` flag: out of every default list, still resumable and found by search. Bot Chats have it. */
  hidden?: boolean;
  /** Not this fake's to send: what the list shows instead for a compression root (its last segment's id, model, ...). */
  listedAs?: Partial<SessionRow>;
  /** A webhook session's platform identity (`webhook:v2:…`, `webhook:<route>`) and end. */
  chat_id?: string;
  user_id?: string;
  ended_at?: number | null;
  is_active?: boolean;
};

/**
 * One history row as legacy `session.resume` returns it (`tui_gateway/session_history.py` `_history_to_messages`
 * at the deployed `bf0203a`). Tool rows carry name, args and an 80-char `context`; only edit tools keep `content`.
 */
export type TranscriptMessage = {
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  content?: unknown;
  tool_call_id?: string;
  name?: string;
  context?: string;
  args?: Record<string, unknown>;
  timestamp?: number;
  display_kind?: string;
  reasoning?: string;
  row_id?: number;
  /** A tool row's whole result as Hermes stores it, which `session.resume` leaves out (`content` is only for edit tools). */
  result?: string;
  /** An assistant row's tool calls as stored: `[{id, type, function: {name, arguments}}]`, `arguments` JSON text. */
  tool_calls?: unknown;
  /**
   * Compaction, as stored rows carry it: a row compaction took out of what the model reads (`compacted`, and then not
   * `active`), a compaction's summary row (`_compressed_summary`), and the message a row holds (`message_uid`), which
   * the copies compaction keeps share. Only `include_compacted=true` reads compacted rows.
   */
  compacted?: boolean;
  summary?: boolean;
  message_uid?: string;
};

/** A file on the owner's disk: its bytes as a string, a size alone for a file too big to make, or a folder. */
export type FakeFile = string | { size: number } | { dir: true };

/** A stored project as `Project.to_dict` sends it (`hermes_cli/projects_db.py` at the deployed `bf0203a`). */
export type FakeProject = {
  id: string;
  slug: string;
  name: string;
  primary_path: string | null;
  archived: boolean;
  created_at: number;
  folders: { path: string; label: string | null; is_primary: boolean; added_at: number }[];
};

/** One worktree of a repository on the server, as `GET /api/git/worktrees` lists it (`web_git.worktree_list`). */
export type FakeWorktree = { path: string; branch?: string; detached?: boolean };

/** A session's model as `SessionLiveInfo` carries it (`session.info`, and `info` on create and resume). */
export type ModelInfo = { model: string; provider: string; reasoning_effort: string; fast: boolean };

/**
 * A `model.options` result (`ModelOptionsResult`, `tui_gateway/contracts/config_free_tier_control.py` at upstream
 * `c419cf7`): two signed-in providers. `gpt-4.1` has no reasoning control, and only Opus and GPT-5 take fast mode.
 */
export function modelOptions(): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    providers: [
      {
        slug: "anthropic",
        name: "Anthropic",
        models: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
        authenticated: true,
        is_current: true,
        capabilities: {
          "claude-opus-4-5": { fast: true, reasoning: true, can_disable_reasoning: true },
          "claude-sonnet-4-5": { fast: false, reasoning: true, can_disable_reasoning: true },
          "claude-haiku-4-5": { fast: false, reasoning: true, can_disable_reasoning: true },
        },
      },
      {
        slug: "openai",
        name: "OpenAI",
        models: ["gpt-5", "gpt-4.1"],
        authenticated: true,
        capabilities: {
          "gpt-5": { fast: true, reasoning: true, can_disable_reasoning: false },
          "gpt-4.1": { fast: false, reasoning: false },
        },
      },
    ],
  };
}

/** A profile's `GET /api/env`, trimmed: three provider keys (OpenRouter set), a shared key, and rows that aren't provider keys. */
export function fakeEnv(): Record<string, Record<string, unknown>> {
  const key = (provider: string, provider_label: string, url: string, over: Record<string, unknown> = {}) => ({
    is_set: false,
    redacted_value: null,
    url,
    is_password: true,
    channel_managed: false,
    provider,
    provider_label,
    provider_primary: true,
    provider_profiles: [],
    ...over,
  });
  return {
    OPENROUTER_API_KEY: key("openrouter", "OpenRouter", "https://openrouter.ai/keys", { is_set: true, redacted_value: "sk-…f3" }),
    ANTHROPIC_API_KEY: key("anthropic", "Anthropic", "https://console.anthropic.com/settings/keys"),
    ANTHROPIC_TOKEN: key("anthropic", "Anthropic", "", { provider_primary: false }),
    DEEPSEEK_API_KEY: key("deepseek", "DeepSeek", "https://platform.deepseek.com/api_keys"),
    DASHSCOPE_API_KEY: key("alibaba", "Alibaba Cloud (DashScope)", "", {
      provider_profiles: [{ provider: "alibaba-cn", provider_label: "Alibaba Cloud China", url: "", primary: true }],
    }),
    OPENAI_BASE_URL: key("openai-api", "OpenAI", "", { is_password: false }),
    TELEGRAM_BOT_TOKEN: { is_set: true, redacted_value: "12…9", is_password: true, channel_managed: true, provider: "", provider_label: "" },
    MY_CUSTOM_VAR: { is_set: true, redacted_value: "…", is_password: true, channel_managed: false, provider: "", custom: true },
  };
}

const DAY = 86_400;
const MiB = 1024 * 1024;
const now = () => Date.now() / 1000;
/** A faked failure: a dashboard answer is a `RestError` already, anything else the text Rust rejects with. */
const thrown = (e: string | Error) => (typeof e === "string" ? new Error(e) : e);

/**
 * A memory entry's fingerprint in its node id. Hermes's is the first 12 hex digits of the SHA-256 of the text
 * (`agent/learning_graph.memory_fingerprint`); the client never computes one, so the fake uses a stand-in digest.
 */
export function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")).slice(0, 12);
}

/** `_normalize_path`: absolute (a relative path is read from the server's home folder), no trailing slash. */
const serverPath = (path: string) => {
  const p = path.trim().startsWith("/") ? path.trim() : `/home/liam/${path.trim()}`;
  return p.replace(/\/+$/, "") || "/";
};

function setPrimary(p: FakeProject, path: string) {
  for (const f of p.folders) f.is_primary = f.path === path;
  p.primary_path = path;
}

/**
 * The sources whose stored rows the gateway takes a session edit on. A local client's row is owner history only with a
 * source the native resume adopts (`LEGACY_LOCAL_SOURCES` in `hermes_state_local_migration.py`, plus `import`;
 * `authorize_history` at the deployed `bf0203a`); a messaging platform's row is mounted by its route. Any other row,
 * such as one stamped with a custom source, can't be mounted, and the edit is answered 404 `not_found` though the row
 * exists (`restore_api_session`).
 */
const EDITABLE_SOURCES = new Set(["cli", "tui", "gui", "desktop", "oneshot", "tool", "acp", "import", "telegram", "discord", "slack", "whatsapp", "signal", "matrix"]);

/** A history as `session.resume` shows it: hidden rows, such as a project's instructions, aren't shown (`_history_to_messages`). */
/**
 * What `session.resume` shows: no hidden rows, and no model-switch marker, a `[System: …]` user row its
 * `_is_display_hidden_marker` sniff drops though REST still lists it.
 */
/** What `session.resume` shows of a stored history: hidden rows left out, and a skill's turn as its invocation. */
const shownHistory = (messages: TranscriptMessage[]) =>
  messages
    .filter((m) => m.display_kind !== "hidden" && !(m.role === "user" && m.display_kind === "model_switch"))
    .map((m) => {
      const shown = m.role === "user" && m.text ? skillInvocationText(m.text) : undefined;
      return shown ? { ...m, text: shown, display_kind: "skill_invocation" } : m;
    });

/** A stored session `daysAgo` days old, unpinned and from this app unless overridden. */
export function row(id: string, daysAgo: number, over: Partial<SessionRow> = {}): SessionRow {
  const at = now() - daysAgo * DAY;
  return { id, source: "gui", title: `Chat ${id}`, preview: "", started_at: at, last_active: at, message_count: 2, pinned: false, archived: false, last_read_at: null, ...over };
}

/** `row`, read up to its own last activity. A read mark taken from the clock separately could land a millisecond before
 * that activity, and leave the chat unread. */
export function readRow(id: string, daysAgo: number, over: Partial<SessionRow> = {}): SessionRow {
  const r = row(id, daysAgo, over);
  return { ...r, last_read_at: r.last_active };
}

/** A session edit's body without the request id and revision every edit carries. */
export function editFlags(body: Record<string, unknown> | undefined) {
  const { request_id: _id, expected_revision: _revision, ...flags } = body ?? {};
  return flags;
}

/** `hermes_cli/web_server_files.py` `SANDBOX_NOT_FOUND` at `f0d94882`: a container path the dashboard couldn't map to the host. */
export const SANDBOX_NOT_FOUND = "File not found on the gateway host: the path may live inside the agent sandbox";

/** Hermes's `_FS_PREVIEW_LANGUAGE_BY_EXT` and `_fs_mime_type` at `bf0203a`, as far as the tests need them. */
const FS_LANGUAGES: Record<string, string> = { py: "python", md: "markdown", html: "html", ts: "typescript", json: "json", txt: "text", sh: "shell" };
const FS_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", py: "text/x-python", md: "text/markdown", html: "text/html",
  txt: "text/plain", json: "application/json", pdf: "application/pdf", ts: "video/mp2t",
};

export class FakeHermes {
  /** Every request the client sent, in order. */
  readonly requests: Request[] = [];
  readonly restRequests: RestRequest[] = [];
  readyPayload: Record<string, unknown> = { skin: {}, change_events: true, heartbeat: true, replay_epoch: "e1" };
  /** How the pipe reaches this server, as the Rust side reports it. */
  route: Route = { kind: "ssh", target: "liam@hermes" };
  /** While set, opening a pipe fails with this message, as the Rust side does when the server can't be reached. */
  refuse?: string;
  /** While set, a frame sent rejects with this message and never arrives, as when the Rust side's outgoing queue has
   * closed (`TransportError::Closed`). */
  failSend?: string;
  /** How many pipes have been opened. */
  opened = 0;
  /** The `default` profile's stored sessions. A chat started over the WS gets a row on its first prompt. */
  sessions: SessionRow[] = [];
  /** Every other profile's stored sessions, by profile name. Each profile has its own store (research doc §5). */
  otherProfiles: Record<string, SessionRow[]> = {};
  /**
   * Bot Mode (research doc "Bot Mode"): `full` as at the deployed `f0d94882`; `no-canonical`, a Hermes whose
   * `profiles.list` rows don't report a Bot Chat; `none`, one without `profiles.list`.
   */
  botMode: "full" | "no-canonical" | "none" = "full";
  /** What each profile's `profile.yaml` says about it, for `profiles.list`. */
  profileMeta: Record<string, { description?: string; description_auto?: boolean; display_name?: string; ui_meta?: Record<string, unknown> }> = {};
  /** Each profile's avatar, as a data URL (`profiles.get_asset`). */
  botAvatars: Record<string, string> = {};
  /** Runs as each `session.list` arrives, with its profile, e.g. to make a Bot Chat as another client would meanwhile. */
  beforeTitleLookup?: (profile: string) => void;
  /** Answers each `session.list` by title with this JSON-RPC error. */
  titleLookupError?: { code: number; message: string };
  /**
   * Each profile's SOUL.md as the file holds it, by profile name; a profile left out has none. Read and written as
   * `GET`/`PUT /api/profiles/{name}/soul` do at the deployed `bf0203a` (persona.ts).
   */
  souls: Record<string, string> = {};
  /** False: the server is older than the persona routes, and answers them as `bf0203a` answers a path it hasn't. */
  soulRoutes = true;
  /** While set, `GET …/soul` fails with this message (e.g. a 500 for a file Hermes may not read). */
  soulReadError?: string | Error;
  /** While set, `PUT …/soul` fails with this message and writes nothing. */
  soulWriteError?: string | Error;
  /** While set, `PUT …/soul` writes the file, then fails with this message, as a connection lost before the answer. */
  soulWriteLost?: string | Error;
  /** Runs as a `PUT …/soul` arrives, before it writes: another client's write in the middle of a Save. */
  beforeSoulWrite?: () => void;
  /** Runs after a `PUT …/soul` wrote: another client writing again before the read-back. */
  afterSoulWrite?: () => void;
  /** Profile distributions, by profile name, as `GET /api/profiles` lists them (`distribution_name`). */
  distributions: Record<string, string> = {};
  /**
   * Each profile's `.env`, by profile name: the API keys a full copy (`clone_from`) carries and a fresh profile lacks.
   * Messaging bot tokens (`*_BOT_TOKEN`) are left out of a copy, as `strip_channel_settings` does.
   */
  profileEnv: Record<string, Record<string, string>> = {};
  /** While set, `POST /api/profiles` fails with this message and makes nothing (a refusal, or a 500 before the rename). */
  profileCreateError?: string | Error;
  /** Runs as a `POST /api/profiles` arrives, before anything else: another client making a profile meanwhile. */
  beforeProfileCreate?: () => void;
  /** While set, `POST /api/profiles` makes the profile, then fails with this message, as a connection lost before the answer. */
  profileCreateLost?: string;
  /** While set, `POST /api/profiles` makes the profile but not its model, and answers `model_error` with this. */
  profileModelError?: string;
  /** The profiles whose gateway runs, as `GET /api/profiles` reports them (`gateway_running`). */
  gatewaysRunning = new Set<string>();
  /**
   * Settings → Profiles' routes this server lacks, each answering FastAPI's own 404 (`Not Found`) or, for a path that
   * has another method, a 405: an older Hermes (ADR 0144).
   */
  profileRoutesMissing = new Set<"rename" | "describe" | "describeAuto" | "setModel" | "remove">();
  /** While set, `DELETE /api/profiles/{name}` removes the folder and answers `settlement_pending` with this `retry_command`. */
  profileSettlementPending?: string;
  /** While set, `PATCH`/`DELETE /api/profiles/{name}` wait for it before answering, as Hermes does stopping a gateway. */
  profileGatewayStop?: Promise<void>;
  /** What `POST /api/profiles/{name}/describe-auto` answers: a description it writes, or a failure's reason. */
  describeAuto: { ok: true; description: string } | { ok: false; reason: string } = { ok: true, description: "Writes and reviews code." };
  /** While set, `PATCH /api/profiles/{name}` fails with this, as a 500 or a lost answer, renaming nothing. */
  profileRenameError?: string | Error;
  /** While set, `PATCH /api/profiles/{name}` renames, then fails with this message, as a connection lost before the answer. */
  profileRenameLost?: string;
  /**
   * Scheduled jobs by profile, as `cron/jobs.json` holds them, and how the cron routes behave
   * (`hermes_cli/web_routers/cron.py` at the deployed `bf0203a`, as probed with a throwaway HERMES_HOME).
   */
  cron: FakeCron = new FakeCron(this);
  /** The kanban plugin's board and tasks (`plugins/kanban/dashboard/plugin_api.py` at Hermes 0.22.6), and the wakes its poller sends. */
  kanban: FakeKanban = new FakeKanban(this);
  webhooks: FakeWebhooks = new FakeWebhooks();
  /** The `?profile=` each `/api/ws` connection was opened with, in order. */
  readonly wsProfiles: string[] = [];
  /** Stored session id -> its history, as `session.resume` projects it (`_history_to_messages`). */
  transcripts: Record<string, TranscriptMessage[]> = {};
  /** The stored row id `prompt.submit` reports for the message (`user_row_id`, `tui_gateway/methods_prompt.py` at
   * `bf0203a`). Unset, it reports none, though the message is stored with a row of its own. */
  userRowId?: number;
  /** While set, `prompt.submit` is refused with this error and nothing is stored, as Hermes answers a busy session. */
  rejectPrompt?: { code: number; message: string };
  /**
   * The next `prompt.submit` drops the connection before Hermes answers it. `stored`: Hermes got the message and stored
   * it first, so its history has it. `lost`: the frame never reached Hermes. Applies once.
   */
  dropOnPrompt?: "stored" | "lost";
  /** What the model answers every `llm.oneshot` call with, unless `oneshotFailure` says why it failed. */
  oneshotAnswer = "A new title";
  /**
   * The profile's Bot Desktop (`display.*`, tui_gateway/methods_display.py at v2026.9.24; ADR 0039): its status and who
   * holds it. Undefined: a Hermes without it, which answers "method not found". `profiles`: fields that differ for the
   * profile named, such as its `browser` (each profile has its own `browser.executable_path`).
   */
  display?: {
    status: Record<string, unknown>;
    lease: { holder: "agent" | "human"; viewer_hash: string | null; since: number; epoch: number };
    minted: Set<string>;
    profiles?: Record<string, Record<string, unknown>>;
  };
  /** The server commands `commands.catalog` lists; undefined for a Hermes without the method. */
  commandCatalog: string[] | undefined = ["steer", "btw", "context", "compress", "help"];
  /** False: a Hermes with no `prompt.btw`, which answers "method not found". */
  sideQuestions = true;
  /**
   * How a side question is answered, once `prompt.btw` has replied with its task id: this text as its `btw.complete`.
   * Undefined: not until a test sends the event itself.
   */
  sideAnswer?: (question: string) => string;
  /** The profile's quick commands (`quick_commands` in config.yaml), by name, with their description. */
  quickCommands: Record<string, string> = {};
  /** False: `commands.catalog` answers with no `skills` field, as a Hermes that can't run skills as commands. */
  catalogSkills = true;
  /** Each live session's profile, for the skills `command.dispatch` finds. */
  readonly runtimeProfile = new Map<string, string>();
  /** A `/steer` is queued for the running turn; false answers as Hermes does with no turn running. */
  steerable = true;
  contextOutput = "Context window: 12,400 / 200,000 tokens (6%)\n  System prompt  3,100\n  Messages       9,300";
  /**
   * What `session.context_breakdown` answers (`SessionContextBreakdownResult` at the deployed `bf0203a`). Undefined
   * answers JSON-RPC "method not found", as a Hermes without the method would.
   */
  contextBreakdown?: Record<string, unknown> = {
    categories: [],
    context_max: 0,
    context_percent: 0,
    context_used: 0,
    estimated_total: 0,
    context_estimated: false,
    context_source: "provider_usage",
    model: "",
    context_files: [],
  };
  /** What `session.compress` answers; undefined answers "method not found". */
  compressResult?: Record<string, unknown> = { status: "compressed", removed: 0, before_messages: 0, after_messages: 0, before_tokens: 0, after_tokens: 0, summary: { noop: true, headline: "Nothing to compress" } };
  /** Set to make `GET /api/sessions/{id}/messages` fail with this. */
  messagesFailure?: string | Error;
  oneshotFailure?: string;
  /** The owner's local disk, by path, for attachments. */
  files: Record<string, FakeFile> = {};
  /**
   * The profile's voice set-up as the Rust side reads it (`Dashboard::voice_setup`). With `transcribe` or `speak`
   * false the server has no such route, and calling it fails as Rust reports that.
   */
  voice: VoiceSetup = { transcribe: true, speak: true, sttEnabled: true, sttProvider: "local", ttsProvider: "edge" };
  /** What Hermes hears in every recording (empty for no speech), or why transcribing fails. */
  heard: string | Error = "Check the backup logs";
  /** What reading aloud answers, or why it fails. */
  speech: Speech | Error = { mime: "audio/mpeg", audio: new Uint8Array([0x49, 0x44, 0x33, 4]), provider: "edge" };
  /** While set, transcribing and reading aloud wait for it before they answer. */
  voiceGate?: Promise<void>;
  /** While set, the next read of the voice set-up waits for it (once). */
  voiceSetupGate?: Promise<void>;
  /** While set, reading the voice set-up fails with this. */
  voiceSetupFailure?: string;
  /** Every recording sent to transcribe, and every text sent to read aloud, in order. */
  readonly recordings: { profile: string; audio: Uint8Array; mime: string }[] = [];
  readonly spoken: { profile: string; text: string }[] = [];
  /**
   * The server's disk, by path, for the preview pane's `GET /api/fs/read-text` and `read-data-url`. A string is the
   * file's text (or bytes, one char per byte); `{ dir: true }` is a folder.
   */
  serverFiles: Record<string, string | { dir: true }> = {};
  /** Every `POST /api/fs/write-text` that reached the server, in order (artifact saves, ADR 0029). `session`: the chat named. */
  readonly fsWrites: { profile: string; path: string; text: string; session?: string }[] = [];
  /**
   * A Docker terminal backend with `docker_mount_cwd_to_workspace` on, as probed live at `f0d94882` (ADR 0062): the
   * agent's `/workspace` is a host folder, the chat's own (`chats`, by stored session id) when a request names the chat
   * with `session_id`, else the profile's (`profile`). A container path that doesn't map to a file there is Hermes's
   * `SANDBOX_NOT_FOUND`. Unset: `/workspace` is an ordinary host path.
   */
  sandbox?: { profile?: string; chats: Record<string, string> };
  /** While set, an artifact save waits for it before Hermes writes. */
  fsWriteGate?: Promise<void>;
  /** Hermes's answer to the next artifact saves instead of writing: the Rust side's error text. */
  fsWriteFailure?: string | Error;
  /** Set: a read of that path through the agent fs routes fails with this error, as Rust reports it. */
  fsReadFailure?: (path: string) => string | Error | undefined;
  /** Runs right after an artifact save is written, before Hermes answers: to change the file meanwhile, say. */
  afterFsWrite?: (path: string) => void;
  /** The server's own disk, for the Server files screen (managed files: `GET /api/files`, `GET /api/files/read`). */
  readonly managedFiles = new FakeServerFiles();
  /** The Rust commands for a project's context files, over this server's disks (fakeProjectContext.ts, ADR 0135). */
  readonly context = new FakeProjectContext({
    managed: this.managedFiles,
    local: () => this.files,
    agentFiles: () => this.serverFiles,
    agentDirs: () => this.serverDirs,
    repos: () => this.repos,
  });
  /** Where each profile's tools run (`terminal.backend` in its config): `local` unless set, `ssh` for an SSH machine. */
  terminalBackend: Record<string, string> = {};
  /** The profiles' skills, as Settings → Skills reads and writes them (fakeSkills.ts). */
  readonly skills = new FakeSkills(this.managedFiles);
  /** The profiles' external memory providers, as Settings → Memory → External memory reads and writes them. */
  /** The profile's MCP servers (fakeMcp.ts, ADR 0121). */
  readonly mcp = new FakeMcp((p) => p === "default" || p in this.otherProfiles);
  /** The profile's Telegram and Discord gateways (fakeGateways.ts, ADR 0073). */
  readonly gateways = new FakeGateways((p) => p === "default" || p in this.otherProfiles);
  /** Settings → Providers' subscription sign-ins and custom endpoints (ADR 0133). */
  readonly accounts = new FakeAccounts((p) => p === "default" || p in this.otherProfiles);
  readonly memoryProviders = new FakeMemoryProviders((p) => p === "default" || p in this.otherProfiles || p in this.memory);
  /** The profiles' speech providers, for Settings → Voice (fakeVoiceProviders.ts). */
  readonly voiceProviders = new FakeVoiceProviders(
    (p) => p === "default" || p in this.otherProfiles,
    () => ({ stt: this.voice.sttProvider, tts: this.voice.ttsProvider }),
  );
  /** Whether this connection sent `client.capabilities {server_requests: true}`. */
  answersRequests = false;
  /** False: `client.capabilities` leaves out `declines_not_shown`, as Hermes before 0.21.6 (`e33f1a0faf`) does. */
  declinesNotShown = true;
  /** Server→client requests nobody has answered yet, by id. */
  readonly openRequests = new Map<string, OpenRequest>();
  /** The client's answers to server→client requests, in order. */
  readonly responses: Response[] = [];
  /**
   * False: a Hermes without `approval.respond`, which answers "method not found", so an Approval can be answered only
   * in a response frame to its request.
   */
  approvalRespond = true;
  /**
   * True: `dashboard.turn_isolation`. A turn's requests wait in a compute-host child that this process only mirrors
   * (`tui_gateway/compute_host_bridge.py`): `approval.received` and `approval.respond` find nothing in its own queue,
   * `session.active_list` lists the session as working, and only a response frame, relayed to the child, settles one.
   */
  turnIsolation = false;
  /** The Approvals this client answered, by either way: `approval.respond`, or a response frame to the request. */
  readonly approvalAnswers: { id: string; choice: unknown; via: "approval.respond" | "response" }[] = [];
  /**
   * What `model.options` answers. Undefined answers JSON-RPC "method not found", as a server without the method would.
   * `model` and `provider` in it are the profile's default.
   */
  modelOptionsResult?: Record<string, unknown> = modelOptions();
  /**
   * What dashboard REST `GET /api/model/options` answers. Undefined serves the catalog in `modelConfig`, as Hermes
   * does; null is a 404, as a dashboard without the route would answer.
   */
  restModelOptions?: Record<string, unknown> | null;
  /**
   * Each profile's default model, reasoning effort and fast mode, in its config.yaml. `config.set` writes here only
   * when sent without a session, as Hermes does (`tui_gateway/methods_config_set.py` at upstream `c419cf7`).
   */
  profileModel: Record<string, ModelInfo> = {};
  /** Stored session id -> the model it runs on, kept across resumes (`_persist_live_session_runtime`). */
  readonly sessionModel = new Map<string, ModelInfo>();
  /** runtime session id -> stored session id, for every session.create / session.resume. */
  readonly runtime = new Map<string, string>();
  /**
   * The live subagents Hermes's registry holds, by stored session (`tools/delegate_tool_registry.py` at the deployed
   * `f0d94882`). `subagent.list` shows a stored session's rows through any runtime session resumed on it; `owner`, the
   * runtime session that started it, is the only one `subagent.tail`, `.steer` and `.interrupt` act for. `tail`: its live
   * transcript. Tests fill it.
   */
  subagents: Record<string, (Record<string, unknown> & { subagent_id: string; owner: string; tail?: string })[]> = {};
  /** Recently failed background delegations, by stored session, as `subagent.list` returns them in `delegations`. */
  failedDelegations: Record<string, Record<string, unknown>[]> = {};
  /**
   * Running background processes, by the stored session that started them, which `subagent.roster` counts as
   * `background` (`process_registry`, any not exited, `notify_on_complete` or not). Tests fill it.
   */
  backgroundProcesses: Record<string, number> = {};
  /** What `subagent.steer` queued, by subagent id. */
  readonly steered: Record<string, string[]> = {};
  /** The subagents `subagent.interrupt` stopped. */
  readonly interrupted: string[] = [];
  private created = new Map<string, { source: string; profile?: string; hidden?: boolean; title?: string }>(); // runtime id, until the first prompt stores it
  /** Every stored key `session.create` minted, for a resume of one that never got a row. */
  private minted = new Map<string, { source: string; profile?: string }>();

  /**
   * The profile's `.env` rows as `GET /api/env` lists them (`hermes_cli/web_routers/config_env.py` at the deployed
   * `bf0203a`), trimmed. Undefined is a 404, as on a server without the route.
   */
  env?: Record<string, Record<string, unknown>> = fakeEnv();
  /** Provider keys saved through `saveProviderKey`, as (profile, env var, key). */
  readonly savedKeys: { profile: string; envVar: string; key: string }[] = [];
  /** Provider keys removed through `removeProviderKey`, as (profile, env var). */
  readonly removedKeys: { profile: string; envVar: string }[] = [];
  /** Set to make `removeProviderKey` fail with this message, as Hermes refusing or still listing the key does. */
  removeKeyFails?: string;
  /** What the provider says of a key: `sk-bad` is turned down, `sk-offline` can't be checked, anything else passes. */
  checkKey = (key: string): { ok: boolean; reachable: boolean; message: string } =>
    key === "sk-bad"
      ? { ok: false, reachable: true, message: "That API key was rejected. Double-check it and try again." }
      : key === "sk-offline"
        ? { ok: false, reachable: false, message: "Could not reach the provider to verify the key." }
        : { ok: true, reachable: true, message: "" };
  /** Each profile's projects (`projects.db`), by profile name; a profile the server has but that isn't here has none. */
  projects: Record<string, FakeProject[]> = {};
  /**
   * True: this server has the membership store ADR 0109 proposes (`projects.membership.*`). No Hermes has it yet, so
   * it is off by default, and the methods answer "method not found" as the deployed `bf0203a` does.
   */
  membershipStore = false;
  /** Each profile's project-chat links, by profile name, in the order they were made. */
  membership: Record<string, { project_id: string; session_id: string; added_at: number }[]> = {};
  /** Set: every membership call fails with this message, as a server that can't open its store would. */
  membershipFails?: string;
  /** Each profile's membership revision, bumped by every write. */
  private membershipRev: Record<string, number> = {};
  /** The revision of each link's last change, removals included, by `profile project_id session_id`. */
  private linkRevs = new Map<string, number>();
  /** The first result of every op id applied, by `profile op_id`, so a retried op is answered the same. */
  private membershipOps = new Map<string, unknown>();
  /**
   * More of the server's folders, by absolute path without a trailing slash, for `GET /api/fs/list`. That route lists
   * these and `serverFiles` together; a `{ dir: true }` entry there is a folder too.
   */
  serverDirs = new Set<string>();
  /** The server's git repositories, each one's worktrees with its own checkout first (`git worktree list`). */
  repos: FakeWorktree[][] = [];
  private projectSeq = 0;
  /** The `info` session.create and session.resume answer with (`server._session_info`); empty, as from a server
   * that reports none of it, unless a test sets it. */
  sessionInfo: Record<string, unknown> = {};
  /**
   * Each profile's `approvals.mode` (config.yaml), "smart" when a profile isn't here. Undefined: this server reports no
   * approvals, and `config.set` knows neither `yolo` nor `approvals.mode`. Set: `session.info` carries `approval_mode`
   * and `yolo` (the chat's flag, or the mode off), as the deployed `f0d94882` sends them once the session's agent is
   * built (`reportApprovals`), never in the create or resume answer.
   */
  approvalModes?: Record<string, ApprovalMode>;
  managedKeys = new Set<string>();
  /**
   * Around a `yolo` or `approvals.mode` write, also sends the written session a `session.info` from before the write,
   * after the fresh one and before the answer, as the deployed `f0d94882` was seen to (ADR 0091).
   */
  staleInfoOnWrite = false;
  private yoloFlags = new Set<string>();
  /**
   * Each runtime session's working folder. As live at the deployed `bf0203a` (probed 2026-11-02 against a throwaway
   * HERMES_HOME): `session.create` takes a `cwd` that is a folder on the server, and quietly runs in Hermes's own
   * folder (`hermesHome`) when it isn't one.
   */
  readonly sessionCwd = new Map<string, string>();
  hermesHome = "/home/hermes";

  /**
   * Each profile's built-in memory, by profile name: `memory` is MEMORY.md's entries and `profile` USER.md's, as
   * `MemoryStore._parse_entries` reads them (stripped, none empty). A profile not here has none.
   */
  memory: Record<string, { memory: string[]; profile: string[] }> = {};
  /** The profile the dashboard process runs as (`GET /api/profiles/active` → `current`), whose memory `learning.*` reach. */
  servedProfile = "default";
  /** Each memory file's limit in characters (`memory_char_limit`, `user_char_limit` defaults at `bf0203a`). */
  memoryLimit: Record<"memory" | "profile", number> = { memory: 2200, profile: 1375 };
  /** False: a server older than the `learning.*` methods, which answers them "method not found". */
  learningMethods = true;
  /**
   * True: the profile-scoped REST twins of `learning.*` that the deployed `f0d94882` has (`GET /api/learning/graph`,
   * `GET`/`PUT`/`DELETE /api/learning/node`, all `?profile=`). False, as at `bf0203a`: they answer 404.
   */
  learningRoutes = false;
  /** Answers the next `PUT` or `DELETE /api/learning/node` with this status and reason instead of writing. Applies once. */
  learningRestRefusal?: { status: number; detail: string };
  /** Runs as each `PUT` or `DELETE /api/learning/node` arrives, with the profile and body, before anything else. */
  beforeLearningRest?: (profile: string, body: { id?: string; content?: string }) => void;
  /** An external memory provider the profile uses (`GET /api/memory` → `active`); none when empty. */
  memoryProvider = "";
  /** Runs before each `learning.*` request is answered, e.g. to change memory as the agent would meanwhile. */
  beforeLearning?: (method: string, params: Record<string, unknown>) => void;
  /** Answers the next `learning.edit` or `learning.delete` with this JSON-RPC error instead of writing. Applies once. */
  learningError?: { code: number; message: string };
  /**
   * The next `learning.edit` or `learning.delete` drops the connection before Hermes answers. `applied`: Hermes wrote
   * it first. `lost`: the frame never reached Hermes. Applies once.
   */
  dropOnLearning?: "applied" | "lost";
  /**
   * What `session.active_list` lists: the sessions live in the dashboard's process, in every profile, as
   * `_session_live_item` renders them at the deployed `bf0203a` (`tui_gateway/session_registry.py`). Rows carry no
   * profile; `status` is `waiting` while a server→client request is open, else `starting`, `working` or `idle`.
   */
  liveSessions: { id: string; session_key: string; status: string; last_active: number; started_at?: number; title?: string; preview?: string }[] = [];

  /**
   * What `GET /api/health` answers (`hermes_cli/web_routers/status.py` at upstream `74b2ed6`). Hermes 0.16.0 has no such
   * route; `asOlderHermes` removes it.
   */
  health: Record<string, unknown> = { ok: true, version: "0.17.0", displayVersion: "0.17.0", commit: "74b2ed65e6c1d2a3b4c5d6e7f8091a2b3c4d5e6f", auth_required: true };
  /**
   * What `GET /api/status` answers, trimmed. Like Hermes's, it carries a path, a process id and an install id that the
   * app must not keep.
   */
  status: Record<string, unknown> = {
    version: "0.17.0",
    release_date: "2026-11-01",
    hermes_home: "/home/fixture/.hermes",
    gateway_pid: 4242,
    install_id: "install-1f2e3d4c5b6a",
    auth_required: true,
    auth_providers: ["basic"],
    auth_flows: ["cookie"],
  };

  /**
   * Makes this server answer as Hermes 0.16.0 (`3705625`, 2026-06-08) does, as read from its source: no `/api/health`,
   * no `client.capabilities` or `gateway.capabilities`, no `projects.*`, `learning.*` or `profiles.list` (Bot Mode), and no managed-files or agent
   * fs routes. Its `/api/status` has the version and the sign-in gate.
   */
  asOlderHermes() {
    const noMethod = (name: string) => (this.handlers[name] = (r) => this.fail(r.id, -32601, `unknown method: ${name}`));
    for (const m of ["client.capabilities", "gateway.capabilities", "projects.list", "projects.create", "learning.frames", "learning.detail", "learning.edit", "learning.delete", "subagent.list", "subagent.tail", "subagent.interrupt", "subagent.roster"]) noMethod(m);
    for (const r of ["GET /api/health", "GET /api/files", "GET /api/files/read", "GET /api/fs/list"]) delete this.rest[r];
    this.status = { version: "0.16.0", release_date: "2026.6.8", auth_required: true, auth_providers: ["basic"] };
    this.botMode = "none";
  }

  /** Per-method behaviour; tests override entries. Unhandled methods get no answer. */
  readonly handlers: Record<string, Handler> = {
    // `tui_gateway/contracts/liveness.py` at upstream `74b2ed6`: what this build enforces, as flags.
    "gateway.capabilities": (r) => this.respond(r.id, { per_session_exclusive_submit: true }),
    "session.active_list": (r) => this.respond(r.id, { sessions: this.liveRows().map((l) => ({ current: false, message_count: 0, model: "", preview: "", title: "", started_at: l.last_active, ...l })) }),
    // Bot Mode at the deployed `f0d94882` (research doc "Bot Mode", probed live on 2026-11-04).
    "profiles.list": (r) => {
      if (this.botMode === "none") return this.fail(r.id, -32601, "unknown method: profiles.list");
      this.respond(r.id, { profiles: this.profileNames().map((name) => this.profileRow(name)), bot_mode_protocol: true, install_id: "install-1f2e3d4c5b6a" });
    },
    // `session.list {profile, title?, include_hidden?, limit?}`: with `title`, the exact-title lookup (`resolved_id` the
    // lineage tip); without, the newest visible rows. Never archived ones.
    "session.list": (r) => {
      const store = this.store(r.params.profile as string | undefined);
      if (!store) return this.fail(r.id, 4064, `profile '${String(r.params.profile)}' not found`);
      this.beforeTitleLookup?.(String(r.params.profile ?? "default"));
      const title = typeof r.params.title === "string" ? r.params.title : undefined;
      if (title && this.titleLookupError) return this.fail(r.id, this.titleLookupError.code, this.titleLookupError.message);
      const rows = store
        .filter((s) => !s.archived && !s.unlisted && (r.params.include_hidden === true || !s.hidden) && (title === undefined || s.title === title))
        .sort((a, b) => b.started_at - a.started_at)
        .slice(0, typeof r.params.limit === "number" ? r.params.limit : 20);
      this.respond(r.id, {
        sessions: rows.map((s) => ({ id: s.id, ...(title !== undefined && { resolved_id: s.listedAs?.id ?? s.id }), title: s.title ?? "", preview: s.preview, started_at: s.started_at, message_count: s.message_count, source: s.source })),
      });
    },
    // `session.title {session_id, title}` on a live session: a title another row of the profile holds is refused with
    // 4022; on a session with no row yet, it stores the row now (`{pending: false}`).
    "session.title": (r) => {
      const runtimeId = String(r.params.session_id);
      const stored = this.runtime.get(runtimeId);
      if (!stored) return this.fail(r.id, 4001, "session not found");
      const title = String(r.params.title ?? "");
      const created = this.created.get(runtimeId);
      const store = this.store(created ? created.profile : (this.runtimeProfile.get(runtimeId) ?? "default"))!;
      const holder = store.find((s) => s.title === title && s.id !== stored);
      if (holder) return this.fail(r.id, 4022, `Title '${title}' is already in use by session ${holder.id}`);
      if (created) {
        this.created.delete(runtimeId);
        store.push(row(stored, 0, { source: created.source, title, preview: "", message_count: 0, ...(created.hidden && { hidden: true }) }));
      } else {
        const s = store.find((x) => x.id === stored);
        if (s) s.title = title;
      }
      this.respond(r.id, { title, pending: false });
    },
    "profiles.get_asset": (r) => {
      const data = this.botAvatars[String(r.params.name ?? "")];
      this.respond(r.id, data ? { found: true, mime: data.slice(5, data.indexOf(";")), size: data.length, data } : { found: false });
    },
    "session.create": (r) => {
      const n = this.requests.filter((q) => q.method === "session.create").length;
      const runtimeId = `rt-${n}`;
      const stored = `20261031_12000${n}_abc123`;
      this.runtime.set(runtimeId, stored);
      this.runtimeProfile.set(runtimeId, (r.params.profile as string | undefined) || "default");
      this.minted.set(stored, { source: String(r.params.source ?? "tui"), profile: r.params.profile as string | undefined });
      this.created.set(runtimeId, {
        source: String(r.params.source ?? "tui"),
        profile: r.params.profile as string | undefined,
        ...(r.params.hidden === true && { hidden: true }),
        ...(typeof r.params.title === "string" && { title: r.params.title }),
      });
      this.agentTools.set(runtimeId, this.offeredTools((r.params.profile as string | undefined) ?? "default"));
      // `SessionCreateParams` `model` / `provider` / `reasoning_effort` / `fast`: the session's own overrides.
      const base = this.defaultModel(r.params.profile as string | undefined);
      const p = r.params;
      const info: ModelInfo = {
        model: typeof p.model === "string" ? p.model : base.model,
        provider: typeof p.provider === "string" ? p.provider : base.provider,
        reasoning_effort: typeof p.reasoning_effort === "string" ? p.reasoning_effort : base.reasoning_effort,
        fast: typeof p.fast === "boolean" ? p.fast : base.fast,
      };
      this.sessionModel.set(stored, info);
      const cwd = typeof p.cwd === "string" && this.serverDirs.has(p.cwd) ? p.cwd : this.hermesHome;
      this.sessionCwd.set(runtimeId, cwd);
      this.respond(r.id, { session_id: runtimeId, stored_session_id: stored, message_count: 0, messages: [], info: { ...this.sessionInfo, ...info, cwd } });
    },
    "session.resume": (r) => {
      const stored = String(r.params.session_id);
      // A key `session.create` minted that never got a row (its first prompt never went in) gets one now, and resumes
      // with no history (`_resume_materialize_minted` at the deployed `bf0203a`).
      const minted = this.minted.get(stored);
      if (minted && /^\d{8}_\d{6}_[0-9a-f]{6}$/.test(stored) && !this.store(minted.profile)?.some((s) => s.id === stored)) {
        this.minted.delete(stored);
        this.store(minted.profile)?.push(row(stored, 0, { source: minted.source, title: null, preview: "", message_count: 0 }));
      }
      if (!this.store(r.params.profile as string | undefined)?.some((s) => s.id === stored)) return this.fail(r.id, 4007, `session not found: ${stored}`);
      // A session waiting on the owner is still live after its connection dropped: the resume reattaches it, with
      // the requests still open (`_resume_reuse_live`, `_live_session_payload` at the deployed `bf0203a`).
      const open = [...this.openRequests].filter(([, q]) => q.stored === stored);
      if (open.length) {
        const sid = open[0][1].sid;
        this.runtime.set(sid, stored);
        const messages = this.transcripts[stored] ?? [];
        const open_requests = open.map(([id, q]) => ({ id, method: q.method, params: { session_id: sid, ...q.params } }));
        return this.respond(r.id, { session_id: sid, stored_session_id: stored, message_count: messages.length, messages, info: this.sessionInfo, running: true, open_requests });
      }
      const runtimeId = `rt-r${++this.resumed}`;
      this.runtime.set(runtimeId, stored);
      this.runtimeProfile.set(runtimeId, (r.params.profile as string | undefined) || "default");
      this.agentTools.set(runtimeId, this.offeredTools((r.params.profile as string | undefined) ?? "default"));
      const messages = shownHistory(this.transcripts[stored] ?? []);
      const info = { ...this.sessionInfo, ...this.sessionModel.get(stored) };
      this.respond(r.id, { session_id: runtimeId, stored_session_id: stored, message_count: messages.length, messages, info, running: false });
    },
    // `tui_gateway/methods_session_branch.py` `_branch_live` at the deployed `bf0203a`, as probed live on 2026-11-03: the
    // first `count` rows of the parent's spine (user and assistant rows with text, hidden ones too) are copied to a new
    // stored session whose `parent_session_id` is the parent and whose source is the live record's (`tui` after a
    // sourceless resume). Tool rows and tool calls aren't copied. The title is the parent's next in its lineage.
    "session.branch": (r) => {
      if (!this.branchMethod) return this.fail(r.id, -32601, "Method not found: session.branch");
      const drop = this.dropOnBranch;
      this.dropOnBranch = undefined;
      if (drop === "lost") return this.drop();
      const parent = this.runtime.get(String(r.params.session_id ?? ""));
      if (!parent) return this.fail(r.id, 4001, "session not found");
      const key = typeof r.params.idempotency_key === "string" ? r.params.idempotency_key : undefined;
      const known = key && this.branchKeys.get(key);
      if (known) return this.respond(r.id, this.branchAnswer(known.stored, known.runtimeId, parent));
      this.beforeBranch?.();
      const spine = (this.transcripts[parent] ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && (m.text ?? "").trim());
      if (!spine.length) return this.fail(r.id, 4008, "nothing to branch — send a message first");
      const count = typeof r.params.count === "number" && r.params.count > 0 ? r.params.count : spine.length;
      const store = [this.sessions, ...Object.values(this.otherProfiles)].find((s) => s.some((x) => x.id === parent))!;
      const base = store.find((x) => x.id === parent)!.title ?? "branch";
      const n = ++this.branched;
      const titles = new Set(store.map((x) => x.title));
      let k = 2;
      while (titles.has(`${base} #${k}`)) k++;
      const stored = `${parent}-b${n}`;
      const runtimeId = `rt-b${n}`;
      const kept = spine.slice(0, count);
      store.push(row(stored, 0, { source: "tui", title: typeof r.params.name === "string" && r.params.name ? r.params.name : `${base} #${k}`, parent_session_id: parent, message_count: kept.length, preview: kept.find((m) => m.display_kind !== "hidden")?.text ?? "" }));
      for (const m of kept) this.storeMessage(stored, { role: m.role, text: m.text, ...(m.display_kind && { display_kind: m.display_kind }), ...(m.reasoning && { reasoning: m.reasoning }) });
      this.runtime.set(runtimeId, stored);
      if (key) this.branchKeys.set(key, { stored, runtimeId });
      if (drop === "stored") return this.drop();
      if (this.branchError) return this.fail(r.id, this.branchError.code, this.branchError.message);
      this.respond(r.id, this.branchAnswer(stored, runtimeId, parent));
    },
    // `session.undo` (`tui_gateway/methods_session.py` at the deployed `bf0203a`, probed live on 2026-11-03): takes the
    // session's last user turn and everything after it out of its history, and answers how many rows went (0 when
    // there's no user turn). A row with a `display_kind` other than `steer`, such as a project's hidden instructions or a
    // model-switch marker, isn't a user turn; a `/steer` row is (`split_user_originated_turn`,
    // `agent/context_compressor.py`). A marker after the turn goes with it. Refused with 4009 while a turn runs. The rows are soft-deleted: stored rows read back without them.
    "session.undo": (r) => {
      if (!this.undoMethod) return this.fail(r.id, -32601, "Method not found: session.undo");
      const stored = this.runtime.get(String(r.params.session_id ?? ""));
      if (!stored) return this.fail(r.id, 4001, "session not found");
      this.undoCalls.push(stored);
      if (this.undoBusy) return this.fail(r.id, 4009, "session busy — Hermes is still replying. Stop the current reply first (Stop button, or Ctrl+C in a terminal), then run /undo.");
      if (this.undoError) return this.fail(r.id, this.undoError.code, this.undoError.message);
      const rows = this.transcripts[stored] ?? [];
      const at = rows.map((m) => m.role === "user" && (!m.display_kind || m.display_kind === "steer")).lastIndexOf(true);
      if (at < 0) return this.respond(r.id, { removed: 0 });
      const removed = rows.length - at - (this.undoShort ? 1 : 0);
      this.transcripts[stored] = rows.slice(0, rows.length - removed);
      this.respond(r.id, { removed });
    },
    // The message is stored as its turn starts (`user_row_id` is the staged row), so the history read back has it.
    "prompt.submit": (r) => {
      const drop = this.dropOnPrompt;
      this.dropOnPrompt = undefined;
      if (drop === "lost") return this.drop();
      if (this.rejectPrompt) return this.fail(r.id, this.rejectPrompt.code, this.rejectPrompt.message);
      const runtimeId = String(r.params.session_id);
      const created = this.created.get(runtimeId);
      if (created) {
        this.created.delete(runtimeId);
        const stored = row(this.runtime.get(runtimeId)!, 0, { source: created.source, title: null, preview: String(r.params.text), message_count: 1, ...(created.hidden && { hidden: true }) });
        this.store(created.profile)?.push(stored);
      }
      const stored = this.runtime.get(runtimeId);
      if (stored) this.storeMessage(stored, { role: "user", text: String(r.params.text), row_id: this.userRowId });
      if (drop === "stored") return this.drop();
      this.turns.add(runtimeId);
      this.stopped.delete(runtimeId);
      this.respond(r.id, { status: "streaming", ...(this.userRowId !== undefined && { user_row_id: this.userRowId }) });
      const prompt = String(r.params.text ?? "");
      if (stored && /dispatch/i.test(prompt)) queueMicrotask(() => this.kanban.dispatchReply(runtimeId, stored, prompt));
      else if (stored && /background/i.test(prompt)) queueMicrotask(() => this.backgroundReply(runtimeId, stored));
    },
    // Attachments stage server-side for the session's next turn (research doc §7; `tui_gateway/methods_prompt.py`
    // at the deployed `bf0203a`). Images join `attached_images`; other files land in the session's
    // `attachments/` and the client puts the `@file:` ref in the prompt text.
    "image.attach_bytes": (r) => {
      const n = ++this.imagesStaged;
      const name = `upload_${n}.png`;
      const bytes = atob(String(r.params.content_base64)).length;
      this.respond(r.id, { attached: true, path: `/hermes/images/${name}`, name, count: n, remainder: "", text: `[User attached image: ${name}]`, bytes });
    },
    "file.attach": (r) => {
      const name = String(r.params.name);
      const refPath = `attachments/${name}`;
      this.respond(r.id, { attached: true, name, path: `/hermes/workspace/${refPath}`, ref_path: refPath, ref_text: `@file:${formatRefValue(refPath)}`, uploaded: true });
    },
    "display.status": (r) => this.displayAnswer(r.id, r.params.profile),
    "display.start": (r) => {
      if (this.display) this.display.status.running = true;
      this.displayAnswer(r.id, r.params.profile);
    },
    "display.observe": (r) => {
      const d = this.display;
      if (!d) return this.fail(r.id, -32601, "unknown method: display.observe");
      if (!d.status.running) return this.fail(r.id, 5300, "this profile's Bot Desktop is not running; call display.start first");
      const asked = String(r.params.viewer_id ?? "");
      const viewer = d.minted.has(asked) ? asked : `viewer-${d.minted.size + 1}`;
      d.minted.add(viewer);
      this.respond(r.id, { ...d.status, lease: d.lease, profile_key: "/home/liam/.hermes", ticket: `ticket-${viewer}`, path: "/api/display/ws", viewer_id: viewer });
    },
    "display.lease.acquire": async (r) => {
      const d = this.display;
      const viewer = String(r.params.viewer_id ?? "");
      if (!d) return this.fail(r.id, -32601, "unknown method: display.lease.acquire");
      if (!d.minted.has(viewer)) return this.fail(r.id, 5300, "viewer_id was not minted for this connection; call display.observe first");
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(viewer))), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
      d.lease = { holder: "human", viewer_hash: hash, since: 2, epoch: d.lease.epoch + 1 };
      this.broadcast("display.lease", { profile_key: "/home/liam/.hermes", lease: d.lease });
      this.respond(r.id, { lease: d.lease });
    },
    "display.lease.release": (r) => {
      const d = this.display;
      if (!d) return this.fail(r.id, -32601, "unknown method: display.lease.release");
      d.lease = { holder: "agent", viewer_hash: null, since: 3, epoch: d.lease.epoch + 1 };
      this.broadcast("display.lease", { profile_key: "/home/liam/.hermes", lease: d.lease });
      this.respond(r.id, { lease: d.lease });
    },
    "image.detach": (r) => {
      this.imagesStaged--;
      this.respond(r.id, { detached: true, count: this.imagesStaged });
    },
    // `commands.catalog` (tui_gateway/methods_tools.py, `command_discovery.command_catalog`) at the deployed `bf0203a`:
    // `canon` maps every listed name and alias to the command's own name. Older servers have no such method.
    "commands.catalog": (r) => {
      if (!this.commandCatalog) return this.fail(r.id, -32601, "unknown method: commands.catalog");
      const canon = Object.fromEntries(this.commandCatalog.flatMap((n) => [[`/${n}`, `/${n}`], ...(n === "steer" ? [["/s", "/steer"]] : [])]));
      const user = Object.keys(this.quickCommands).map((n) => [`/${n}`, this.quickCommands[n]]);
      // Skills are listed in `pairs` and `skills`, not in a category (`_catalog_skills`).
      const skills = this.catalogSkills ? this.skills.commandSkills(String(r.params.profile || "default")) : [];
      this.respond(r.id, {
        pairs: [...this.commandCatalog.map((n) => [`/${n}`, n]), ...user, ...skills.map((k) => [`/${k.slug}`, k.description])], canon, commands: {},
        categories: [{ name: "Session", pairs: this.commandCatalog.map((n) => [`/${n}`, n]) }, ...(user.length ? [{ name: "User commands", pairs: user }] : [])],
        ...(this.catalogSkills && { skills: Object.fromEntries(skills.map((k) => [`/${k.slug}`, { usage: 0, origin: "local" }])), skill_count: skills.length }),
        warning: "", plugin_discovery_error: "", plugin_commands: {},
      });
    },
    // `command.dispatch` `_cmd_steer`: queued for a running turn; with none, Hermes asks for it to be sent as a message.
    "command.dispatch": (r) => {
      const sid = String(r.params.session_id);
      if (!this.runtime.has(sid)) return this.fail(r.id, 4001, "session not found");
      const skill = this.skillMessage(this.runtimeProfile.get(sid) ?? "default", String(r.params.name), String(r.params.arg ?? ""));
      if (skill) return this.respond(r.id, skill);
      if (r.params.name !== "steer") return this.fail(r.id, 4018, `not a quick/plugin/bundle/skill command: ${r.params.name}`);
      const arg = String(r.params.arg ?? "");
      if (!arg) return this.fail(r.id, 4004, "usage: /steer <prompt>");
      if (!this.steerable) return this.respond(r.id, { type: "send", message: arg, notice: `No agent running; sent as next turn: ${arg}` });
      this.respond(r.id, { type: "exec", output: `⏩ Steer queued — arrives after the next tool call: ${arg}` });
    },
    // `prompt.btw` (tui_gateway/methods_prompt.py at the deployed `f0d94882`): replies with a task id at once, and the
    // answer comes later as `btw.complete` on the asking session, `error: <why>` as its text when it failed.
    "prompt.btw": (r) => {
      if (!this.sideQuestions) return this.fail(r.id, -32601, "unknown method: prompt.btw");
      const sid = String(r.params.session_id ?? "");
      if (!this.runtime.has(sid)) return this.fail(r.id, 4001, "session not found");
      const question = String(r.params.text ?? "");
      if (!question) return this.fail(r.id, 4012, "text required");
      const task_id = `btw_${String(this.requests.filter((q) => q.method === "prompt.btw").length).padStart(6, "0")}`;
      this.respond(r.id, { task_id });
      const answer = this.sideAnswer;
      if (answer) setTimeout(() => this.event(sid, "btw.complete", { task_id, question, text: answer(question) }), 0);
    },
    // `slash.exec` for `/context`, answered from the live session.
    "slash.exec": (r) => {
      if (!this.runtime.has(String(r.params.session_id))) return this.fail(r.id, 4001, "session not found");
      this.respond(r.id, { output: this.contextOutput });
    },
    // Legacy `session.interrupt` (tui_gateway/methods_session_interrupt.py). The turn then ends with a
    // `message.complete` whose status is "interrupted"; tests send that themselves.
    "session.context_breakdown": (r) =>
      this.contextBreakdown ? this.respond(r.id, structuredClone(this.contextBreakdown)) : this.fail(r.id, -32601, "method not found: session.context_breakdown"),
    "session.compress": (r) => (this.compressResult ? this.respond(r.id, structuredClone(this.compressResult)) : this.fail(r.id, -32601, "method not found: session.compress")),
    "session.interrupt": (r) => {
      const sid = String(r.params.session_id);
      if (!this.runtime.has(sid)) return this.fail(r.id, 4001, "session not found");
      this.respond(r.id, { status: "interrupted" });
      this.stopped.add(sid);
      // The interrupt withdraws whatever the session was waiting on.
      for (const [id, q] of this.openRequests) if (q.sid === sid) this.cancelRequest(id, "interrupted");
    },
    // `tui_gateway/methods_subagents.py` and `methods_session.py` (`subagent.steer`) at the deployed `f0d94882`.
    "subagent.list": (r) => {
      const sid = String(r.params.session_id ?? "");
      const stored = this.runtime.get(sid);
      if (!stored) return this.fail(r.id, 4001, "session not found or not owned by this transport");
      const fields = ["subagent_id", "parent_id", "depth", "goal", "delegation_id", "model", "started_at", "status", "tool_count", "last_tool", "accepting_steer"];
      const rows = (this.subagents[stored] ?? []).map((row) => Object.fromEntries(fields.map((k) => [k, row[k] ?? null])));
      this.respond(r.id, { subagents: rows, delegations: structuredClone(this.failedDelegations[stored] ?? []) });
    },
    // `subagent.roster {profile?}` at the deployed `f0d94882` (`methods_subagents.py:114-138`): every stored session of
    // the profile with top-level subagents live in the registry or background processes running, with no session open.
    "subagent.roster": (r) => {
      const store = this.store(r.params.profile as string | undefined);
      if (!store) return this.respond(r.id, { sessions: [] });
      const ours = (id: string) => store.some((row) => row.id === id || !!row._lineage_ids?.includes(id));
      const counts = new Map<string, { subagents: number; background: number }>();
      const count = (id: string) => counts.get(id) ?? counts.set(id, { subagents: 0, background: 0 }).get(id)!;
      for (const [id, rows] of Object.entries(this.subagents)) {
        const live = rows.filter((row) => !row.depth && (row.status === undefined || row.status === "running" || row.status === "queued")).length;
        if (live && ours(id)) count(id).subagents += live;
      }
      for (const [id, n] of Object.entries(this.backgroundProcesses)) if (n > 0 && ours(id)) count(id).background += n;
      this.respond(r.id, { sessions: [...counts].map(([session_id, c]) => ({ session_id, ...c })) });
    },
    "subagent.tail": (r) => {
      const id = String(r.params.subagent_id ?? "");
      if (!id) return this.fail(r.id, 4000, "subagent_id required");
      const row = this.ownedSubagent(r);
      if (row === null) return this.fail(r.id, 4001, "session not found or not owned by this transport");
      const tail = row?.tail;
      this.respond(r.id, tail === undefined ? { subagent_id: id, available: false, text: "", truncated: false } : { subagent_id: id, available: true, text: tail.slice(-16384), truncated: tail.length > 16384 });
    },
    "subagent.steer": (r) => {
      const id = String(r.params.subagent_id ?? "");
      if (!id) return this.fail(r.id, 4000, "subagent_id required");
      const text = String(r.params.text ?? "").trim();
      if (!text) return this.fail(r.id, 4002, "text is required");
      const row = this.ownedSubagent(r);
      const queued = !!row && row.accepting_steer === true;
      if (queued) (this.steered[id] ??= []).push(text);
      this.respond(r.id, { status: queued ? "queued" : "rejected", subagent_id: id, text });
    },
    "subagent.interrupt": (r) => {
      const id = String(r.params.subagent_id ?? "");
      if (!id) return this.fail(r.id, 4000, "subagent_id required");
      const row = this.ownedSubagent(r);
      if (row === null) return this.fail(r.id, 4001, "session not found or not owned by this transport");
      if (row) this.interrupted.push(id);
      this.respond(r.id, { found: !!row, subagent_id: id });
    },
    // `tui_gateway/methods_voice.py` at the deployed `bf0203a`: lists the server→client request kinds it knows.
    "client.capabilities": (r) => {
      if ("server_requests" in r.params) this.answersRequests = !!r.params.server_requests;
      this.respond(r.id, { server_requests: ["approval", "clarify", "secret", "sudo"], ...(this.declinesNotShown && { declines_not_shown: true }) });
    },
    // `tui_gateway/methods_prompt.py` at the deployed `bf0203a`: settles the Approval in Hermes's queue, whose settle
    // hook then withdraws the request from every client on the session, this one too (`request.cancel`, `resolved`).
    // Answers how many it settled: 0 when nothing waits under that request id, as once another client has answered.
    "approval.respond": (r) => {
      if (!this.approvalRespond) return this.fail(r.id, -32601, "unknown method: approval.respond");
      const sid = String(r.params.session_id ?? "");
      if (!this.runtime.has(sid)) return this.fail(r.id, 4001, "session not found");
      const open = [...this.openRequests].filter(([, q]) => q.sid === sid && q.method === "approval" && !this.turnIsolation);
      const settled = r.params.request_id ? open.filter(([, q]) => q.params.request_id === r.params.request_id) : open.slice(0, 1);
      for (const [id] of settled) {
        this.approvalAnswers.push({ id, choice: r.params.choice, via: "approval.respond" });
        this.cancelRequest(id, "resolved");
      }
      this.respond(r.id, { resolved: settled.length });
    },
    // `tui_gateway/methods_prompt.py` at the deployed `bf0203a`: records that a client has the card on screen.
    "approval.received": (r) => {
      const pending = !this.turnIsolation && [...this.openRequests.values()].some((q) => q.sid === r.params.session_id && q.params.request_id === r.params.request_id);
      this.respond(r.id, { acknowledged: pending });
    },
    // `tui_gateway/methods_session.py` at the deployed `bf0203a`: a stateless model call (default task
    // `title_generation`) that answers `{text}`, or fails 5030 `one-shot generation failed: <why>`.
    "llm.oneshot": (r) => {
      if (!String(r.params.instructions ?? "").trim() && !String(r.params.input ?? "").trim())
        return this.fail(r.id, 4030, "llm.oneshot requires a template or instructions/input");
      if (this.oneshotFailure !== undefined) return this.fail(r.id, 5030, `one-shot generation failed: ${this.oneshotFailure}`);
      this.respond(r.id, { text: this.oneshotAnswer });
    },
    "model.options": (r) => {
      if (!this.modelOptionsResult) return this.fail(r.id, -32601, "Method not found: model.options");
      // Without a session, `model` and `provider` are the profile's own.
      const { model, provider } = this.defaultModel(r.params.profile as string | undefined);
      this.respond(r.id, { ...this.modelOptionsResult, model, provider });
    },
    // `_cfg_get_reasoning`: the session's effort, else the profile's.
    "config.get": (r) => {
      if (r.params.key !== "reasoning") return this.fail(r.id, 4002, `unknown config key: ${r.params.key}`);
      const stored = this.runtime.get(String(r.params.session_id ?? ""));
      const info = (stored && this.sessionModel.get(stored)) || this.defaultModel(r.params.profile as string | undefined);
      this.respond(r.id, { value: info.reasoning_effort || "medium", display: "show" });
    },
    // `config.set` for `model`, `reasoning` and `fast` (`tui_gateway/methods_config_set.py` at upstream `c419cf7`).
    // With a session they change only that session, and `session.info` reports it; a session id the server doesn't
    // hold is refused (4001). Without one they write the profile's config.
    "config.set": (r) => {
      const { key, value, session_id: sid } = r.params as { key: string; value: string; session_id?: string };
      if (this.approvalModes && (key === "yolo" || key === "approvals.mode")) return this.setApprovals(r.id, key, value, sid, r.params.profile as string | undefined);
      if (!["model", "reasoning", "fast"].includes(key)) return this.fail(r.id, 4002, `unknown config key: ${key}`);
      const stored = sid ? this.runtime.get(sid) : undefined;
      if (sid && !stored) return this.fail(r.id, 4001, "session not found");
      const profile = (r.params.profile as string | undefined) ?? "default";
      const info = stored ? { ...(this.sessionModel.get(stored) ?? this.defaultModel(profile)) } : { ...this.defaultModel(profile) };
      if (key === "model") {
        if (!stored) return this.fail(r.id, 4001, "session not found");
        const [model, ...flags] = String(value).split(/\s+/);
        const at = flags.indexOf("--provider");
        info.model = model;
        if (at >= 0) info.provider = flags[at + 1];
      } else if (key === "reasoning") info.reasoning_effort = String(value);
      else info.fast = value === "fast";
      if (stored) {
        this.sessionModel.set(stored, info);
        // A live model switch stores a marker row for the model at once, keeping only the newest
        // (`_append_model_switch_marker`, `tui_gateway/server.py` at the deployed `bf0203a`).
        if (key === "model" && this.transcripts[stored]?.length) {
          this.transcripts[stored] = this.transcripts[stored].filter((m) => m.display_kind !== "model_switch");
          this.storeMessage(stored, { role: "user", text: `[System: The active model for this chat has changed to ${info.model}.]`, display_kind: "model_switch" });
        }
        this.event(sid!, "session.info", { ...info, ...this.approvalInfo(sid!) });
      } else this.profileModel[profile] = info;
      this.respond(r.id, { key, value });
    },
    // `tui_gateway/methods_projects.py` at the deployed `bf0203a`, checked live against a throwaway HERMES_HOME
    // (research doc "Projects"): 5062 for an id that resolves to nothing, 5063 for an invalid argument, 4064 for a
    // profile the server doesn't have. Writes answer with the refreshed project; delete with every project.
    "projects.list": (r) => this.projectsOp(r, (list) => ({ projects: list, active_id: null })),
    "projects.create": (r) =>
      this.projectsOp(r, (list) => {
        const name = String(r.params.name ?? "").trim();
        if (!name) throw [5063, "project name must not be empty"];
        const at = Math.floor(now());
        const folders = ((r.params.folders as string[] | undefined) ?? []).map(serverPath);
        const p: FakeProject = {
          id: `p_${(++this.projectSeq).toString(16).padStart(8, "0")}`,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project",
          name,
          primary_path: folders[0] ?? null,
          archived: false,
          created_at: at,
          folders: folders.map((path, i) => ({ path, label: null, is_primary: i === 0, added_at: at })),
        };
        list.push(p);
        return { project: p };
      }),
    "projects.update": (r) =>
      this.projectOp(r, (p) => {
        if (r.params.name !== undefined && r.params.name !== null) {
          const name = String(r.params.name).trim();
          if (!name) throw [5063, "project name must not be empty"];
          p.name = name;
        }
      }),
    "projects.add_folder": (r) =>
      this.projectOp(r, (p) => {
        const path = serverPath(String(r.params.path ?? ""));
        if (!p.folders.some((f) => f.path === path)) p.folders.push({ path, label: null, is_primary: false, added_at: Math.floor(now()) });
        if (!p.folders.some((f) => f.is_primary)) setPrimary(p, path);
      }),
    "projects.remove_folder": (r) =>
      this.projectOp(r, (p) => {
        const path = serverPath(String(r.params.path ?? ""));
        const was = p.folders.find((f) => f.path === path);
        p.folders = p.folders.filter((f) => f.path !== path);
        if (was?.is_primary) {
          if (p.folders[0]) setPrimary(p, p.folders[0].path);
          else p.primary_path = null;
        }
      }),
    "projects.delete": (r) =>
      this.projectsOp(r, (list) => {
        const at = list.findIndex((p) => p.id === r.params.id);
        if (at < 0) throw [5062, "no such project"];
        list.splice(at, 1);
        // The contract's `project_sessions` rows go with the project (`ON DELETE CASCADE`); the chats stay.
        const profile = (r.params.profile as string | undefined) || "default";
        const links = this.membership[profile];
        if (links) this.membership[profile] = links.filter((l) => l.project_id !== r.params.id);
        return { projects: list, active_id: null };
      }),
    // The membership store ADR 0109 proposes. `apply` runs each op in order: refused for a project or (when adding) a
    // chat the profile doesn't have; "unchanged" when the link already is as asked; a conflict when another write
    // changed the link after the op's `base_revision`; otherwise written. A retried op id gets its first answer.
    "projects.membership.list": (r) =>
      this.membershipOp(r, (profile, links) => ({ revision: this.membershipRev[profile] ?? 0, links })),
    "projects.membership.apply": (r) =>
      this.membershipOp(r, (profile, links) => {
        const ops = Array.isArray(r.params.ops) ? (r.params.ops as Record<string, unknown>[]) : [];
        if (ops.length > 200) throw [5063, "at most 200 ops per call"];
        const results = ops.map((op) => {
          const key = `${profile} ${String(op.op_id)}`;
          const seen = this.membershipOps.get(key);
          if (seen) return seen;
          const project_id = String(op.project_id ?? "");
          const session_id = String(op.session_id ?? "");
          const member = op.member === true;
          const base = Number(op.base_revision) || 0;
          const linkKey = `${profile} ${project_id} ${session_id}`;
          const at = links.findIndex((l) => l.project_id === project_id && l.session_id === session_id);
          const current = at >= 0;
          let status: string;
          if (!(this.projects[profile] ?? []).some((p) => p.id === project_id)) status = "no_project";
          else if (member && !this.store(profile)!.some((s) => s.id === session_id)) status = "no_session";
          else if (current === member) status = "unchanged";
          else if ((this.linkRevs.get(linkKey) ?? 0) > base) status = "conflict";
          else {
            status = "applied";
            if (member) links.push({ project_id, session_id, added_at: Math.floor(now()) });
            else links.splice(at, 1);
            this.membershipRev[profile] = (this.membershipRev[profile] ?? 0) + 1;
            this.linkRevs.set(linkKey, this.membershipRev[profile]);
          }
          const result = { op_id: op.op_id, status, member: status === "applied" ? member : current, rev: this.linkRevs.get(linkKey) ?? 0 };
          this.membershipOps.set(key, result);
          return result;
        });
        return { revision: this.membershipRev[profile] ?? 0, results };
      }),
    // Keepalive, answered by the WS layer in either protocol generation (research doc §1).
    "gateway.ping": (r) => this.respond(r.id, { ok: true }),
    // Memory (`tui_gateway/methods_tools.py` and `agent/learning_mutations.py` at the deployed `bf0203a`). The calls take
    // no profile and act on the served profile's memory; their contracts refuse any extra param.
    "learning.frames": (r) => this.learning(r, ["cols", "rows", "frames"], () => this.memoryFrames()),
    "learning.detail": (r) =>
      this.learning(r, ["id"], () => {
        const found = this.memoryEntry(String(r.params.id ?? ""));
        if (typeof found === "string") return { ok: false, message: found };
        return { ok: true, kind: "memory", id: r.params.id, label: found.text.split("\n")[0].slice(0, 80), content: found.text };
      }),
    "learning.edit": (r) => this.learning(r, ["id", "content"], () => this.memoryWrite(r, String(r.params.content ?? ""))),
    "learning.delete": (r) => this.learning(r, ["id"], () => this.memoryWrite(r, null)),
    // `session.cwd.set` (`tui_gateway/methods_session.py` at `bf0203a`): only an idle session, only a folder that's there.
    "session.cwd.set": (r) => {
      const sid = String(r.params.session_id);
      if (!this.runtime.has(sid)) return this.fail(r.id, 4001, "session not found");
      const cwd = String(r.params.cwd ?? "");
      if (!this.serverDirs.has(cwd)) return this.fail(r.id, 4017, `working directory does not exist: ${cwd}`);
      this.sessionCwd.set(sid, cwd);
      this.respond(r.id, { ...this.sessionInfo, cwd });
    },
    "session.close": (r) => this.respond(r.id, { closed: true }),
    // `tui_gateway/methods_tools.py` `tools.show`: the session's agent's tools grouped by toolset. An id it doesn't hold
    // falls back to the launch profile's config (`_session_toolsets(None)`), with no error.
    "tools.show": (r) => {
      if (!this.toolsShowMethod) return this.fail(r.id, -32601, "Method not found: tools.show");
      const tools = this.agentTools.get(String(r.params.session_id ?? "")) ?? this.offeredTools("default");
      const sections = this.toolsetCatalog
        .map((t) => ({ name: t.name, tools: t.tools.filter((n) => tools.has(n)).map((name) => ({ name, description: "" })) }))
        .filter((x) => x.tools.length);
      this.respond(r.id, { sections, total: tools.size });
    },
    // `_session_method`: 4001 for a runtime id the gateway doesn't hold (`_sess_nowait`).
    "session.status": (r) => (this.runtime.has(String(r.params.session_id ?? "")) ? this.respond(r.id, { output: "Hermes TUI Status" }) : this.fail(r.id, 4001, "session not found")),
  };

  /** Per-route REST behaviour, keyed `METHOD /path`. A handler throws to fail the request. */
  readonly rest: Record<string, RestHandler> = {
    "GET /api/health": () => this.health,
    "GET /api/status": () => this.status,
    // `fs_list` (`hermes_cli/web_routers/files.py` at the deployed `bf0203a`): a folder's entries, or none and why.
    "GET /api/fs/list": ({ query }) => {
      // `fs_list` takes no `session_id`: a container path lists the profile's own `/workspace`.
      const path = this.sandboxPath(query.get("path") ?? "") ?? query.get("path") ?? "";
      const all = new Set([...this.serverDirs, ...Object.keys(this.serverFiles)]);
      // A folder holding a file or folder is there too, as on a real disk.
      const isDir = (p: string) => this.serverDirs.has(p) || typeof this.serverFiles[p] === "object" || [...all].some((q) => q.startsWith(`${p}/`));
      if (typeof this.serverFiles[path] === "string") return { entries: [], error: "ENOTDIR" };
      if (!isDir(path)) return { entries: [], error: "ENOENT" };
      const inside = [...all].filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"));
      return { entries: inside.map((p) => ({ name: p.split("/").pop(), path: p, isDirectory: isDir(p) })) };
    },
    // `git_worktrees_route`: every worktree of the repository the path is in, its own checkout first; none outside one.
    "GET /api/git/worktrees": ({ query }) => {
      const path = query.get("path") ?? "";
      const repo = this.repos.find((trees) => trees.some((t) => path === t.path || path.startsWith(`${t.path}/`)));
      return { worktrees: (repo ?? []).map((t, i) => ({ path: t.path, branch: t.branch ?? null, isMain: i === 0, detached: !!t.detached, locked: false })) };
    },
    "GET /api/sessions": ({ query }) => {
      // order=recent, archived=exclude|only|include, then every pinned row not already on the page, archived or not
      // (list_sessions_rich).
      const excluded = (query.get("exclude_sources") ?? "").split(",").filter(Boolean);
      const only = (query.get("sources") ?? query.get("source") ?? "").split(",").filter(Boolean);
      // `cwd_prefix` (`_cwd_prefix_clause`): the folder itself or anything under it, never a sibling that shares a prefix.
      const prefix = (query.get("cwd_prefix") ?? "").replace(/\/+$/, "");
      const inFolder = (s: SessionRow) => !prefix || (!!s.cwd && (s.cwd === prefix || s.cwd.startsWith(`${prefix}/`)));
      const visible = this.storeOrFail(query.get("profile")).filter(
        (s) => !excluded.includes(s.source) && !s.unlisted && (!only.length || only.includes(s.source)) && inFolder(s),
      );
      const archived = query.get("archived") ?? "exclude";
      // order=created (the default): newest started first; order=recent: latest activity first.
      const at = (s: SessionRow) => (query.get("order") === "recent" ? (s.last_active ?? s.started_at) : s.started_at);
      // Hidden rows are out of every list but the archived-only one, the recovery view (`list_sessions_rich`).
      const recent = visible
        .filter((s) => (archived === "include" || s.archived === (archived === "only")) && (!s.hidden || archived === "only"))
        .sort((a, b) => at(b) - at(a));
      const offset = Number(query.get("offset") ?? 0);
      const limit = Number(query.get("limit") ?? 20);
      const page = recent.slice(offset, offset + limit);
      const pinned = visible.filter((s) => s.pinned && !page.includes(s) && (!s.hidden || archived === "only"));
      // A compression root lists as its last segment, with its own counts and every segment's id.
      const listed = (s: SessionRow) => {
        const { listedAs, ...stored } = s;
        return listedAs ? { ...stored, ...listedAs, _lineage_root_id: s.id } : stored;
      };
      return { sessions: [...page, ...pinned].map((s) => ({ ...listed(s), unread: unread(s) })), total: recent.length, limit, offset, storage: {} };
    },
    // `_get_usage_analytics` (`hermes_cli/web_routers/analytics.py` at the deployed `bf0203a`): sums over every stored
    // session started in the last `days` days, unlisted ones too, and the helper tasks' usage, which no session carries.
    "GET /api/analytics/usage": ({ query }) => {
      if (this.analyticsRefused) throw new RestError(this.analyticsRefused.status, JSON.stringify({ detail: this.analyticsRefused.detail }));
      const days = Number(query.get("days") ?? 30);
      const cutoff = now() - days * DAY;
      const rows = this.storeOrFail(query.get("profile")).filter((s) => s.started_at > cutoff);
      const sum = (k: keyof SessionRow) => rows.reduce((n, s) => n + (Number(s[k]) || 0), 0);
      return {
        totals: {
          total_input: sum("input_tokens"), total_output: sum("output_tokens"), total_cache_read: sum("cache_read_tokens"),
          total_reasoning: sum("reasoning_tokens"), total_estimated_cost: sum("estimated_cost_usd"), total_actual_cost: sum("actual_cost_usd"),
          total_sessions: rows.length, total_api_calls: sum("api_call_count"),
        },
        by_task: this.helperUsage[query.get("profile") ?? "default"] ?? [],
        daily: [], by_model: [], period_days: days, skills: [], tools: [],
      };
    },
    // `search_sessions` in `hermes_cli/web_routers/sessions.py` at the deployed `bf0203a`: one row per chat, archived
    // ones too. Message hits come first, then title matches. FTS5 matches a message holding every word of the query,
    // each as a prefix; its `snippet()` marks the matched words between `>>>` and `<<<`. Message hits carry the
    // message's `role`.
    "GET /api/sessions/search": ({ query }) => {
      const q = (query.get("q") ?? "").trim();
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return { results: [] };
      const limit = Math.min(Number(query.get("limit") ?? 20), 100);
      const excluded = (query.get("exclude_sources") ?? "").split(",").filter(Boolean);
      const only = (query.get("sources") ?? "").split(",").filter(Boolean);
      const store = this.storeOrFail(query.get("profile")).filter((s) => !excluded.includes(s.source) && (!only.length || only.includes(s.source)));
      const hits = (token: string) => words.some((w) => token.toLowerCase().startsWith(w));
      const results = new Map<string, Record<string, unknown>>();
      // A hit in a compressed chat is reported at its lineage's tip, with the tip's title (`add_lineage_result`).
      const add = (s: SessionRow, snippet: string, role: string | null) =>
        results.size < limit && !results.has(s.id) && results.set(s.id, {
          snippet, role, source: s.source, model: s.model ?? null, session_started: s.started_at, session_id: s.listedAs?.id ?? s.id, lineage_root: s.id,
          profile: query.get("profile") ?? "default", id: s.listedAs?.id ?? s.id, title: s.listedAs?.title ?? s.title, started_at: s.started_at,
          last_active: s.last_active ?? s.started_at, message_count: s.message_count, preview: s.preview, archived: s.archived,
        });
      for (const s of store)
        for (const m of this.transcripts[s.id] ?? []) {
          const text = m.text ?? (typeof m.content === "string" ? m.content : "");
          // Odd entries are FTS5 tokens (unicode61: runs of letters and digits), even ones what lies between.
          const parts = text.split(/([\p{L}\p{N}]+)/u);
          const tokens = parts.filter((_, i) => i % 2);
          if (!words.every((w) => tokens.some((t) => t.toLowerCase().startsWith(w)))) continue;
          // snippet(..., '>>>', '<<<', '...', 40): up to 40 tokens from a little before the first match.
          const first = parts.findIndex((t, i) => i % 2 && hits(t));
          const start = Math.max(1, first - 20);
          const end = Math.min(parts.length, start + 79);
          const body = parts.slice(start, end).map((t, i) => (i % 2 === 0 && hits(t) ? `>>>${t}<<<` : t)).join("");
          add(s, `${start > 1 ? "..." : parts[0]}${body}${end < parts.length - 1 ? "..." : (parts[end] ?? "")}`, m.role);
          break;
        }
      for (const s of store) if (s.title?.toLowerCase().includes(q.toLowerCase())) add(s, s.preview || `Session title matched: ${q}`, null);
      return { results: [...results.values()] };
    },
    // `hermes_cli/web_routers/files.py` `fs_read_text` at the deployed `bf0203a`, as probed live: the first 512 KB,
    // binary judged by `_fs_looks_binary`, credential files refused.
    "GET /api/fs/read-text": ({ query }) => {
      const { path, data } = this.serverFile(query);
      const head = data.slice(0, 4096);
      const control = [...head].filter((c) => c.charCodeAt(0) < 32 && !"\t\n\r".includes(c)).length;
      const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? "";
      return {
        binary: head.includes("\0") || (head.length > 0 && control / head.length > 0.12),
        byteSize: data.length,
        language: FS_LANGUAGES[ext] ?? "text",
        mimeType: FS_MIME[ext] ?? "application/octet-stream",
        path,
        text: data.slice(0, 512 * 1024),
        truncated: data.length > 512 * 1024,
      };
    },
    // `fs_read_data_url`: any regular file as a data URL, up to 16 MB; the MIME type goes by its extension.
    "GET /api/fs/read-data-url": ({ query }) => {
      const { path, data } = this.serverFile(query);
      if (data.length > 16 * 1024 * 1024) throw new RestError(413, `{"detail":"File too large"}`);
      const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? "";
      return { dataUrl: `data:${FS_MIME[ext] ?? "application/octet-stream"};base64,${btoa(data)}` };
    },
    "GET /api/env": () => {
      if (!this.env) throw new RestError(404, `{"detail":"Not Found"}`);
      return this.env;
    },
    // `get_active_profile_endpoint`: the sticky profile, and the one this dashboard process runs as.
    "GET /api/profiles/active": () => ({ active: "default", current: this.servedProfile }),
    // `get_memory_status` (`hermes_cli/web_routers/ops.py`): the provider and the built-in files' sizes in bytes.
    "GET /api/memory": ({ query }) => {
      const profile = query.get("profile") || this.servedProfile;
      if (profile !== "default" && !(profile in this.otherProfiles) && !(profile in this.memory))
        throw new RestError(404, `{"detail":"Profile '${profile}' does not exist."}`);
      const m = this.memory[profile] ?? { memory: [], profile: [] };
      const bytes = (entries: string[]) => new TextEncoder().encode(entries.join("\n§\n")).length;
      if (!this.memoryProviders.routes) throw new RestError(404, `{"detail":"Not Found"}`);
      return { ...this.memoryProviders.memory(profile, this.memoryProvider), builtin_files: { memory: bytes(m.memory), user: bytes(m.profile) } };
    },
    "GET /api/files": ({ query }) => this.managedFiles.list(query),
    "GET /api/files/read": ({ query }) => this.managedFiles.read(query),
    // `hermes_cli/web_routers/profiles.py` `_profile_to_dict` at the deployed `bf0203a`, trimmed to what matters here.
    "GET /api/profiles": () => ({
      profiles: ["default", ...Object.keys(this.otherProfiles)].map((name) => ({
        name,
        path: name === "default" ? "/home/liam/.hermes" : `/home/liam/.hermes/profiles/${name}`,
        is_default: name === "default",
        model: this.profileModel[name]?.model ?? null,
        provider: this.profileModel[name]?.provider ?? null,
        description: this.profileMeta[name]?.description ?? "",
        description_auto: this.profileMeta[name]?.description_auto ?? false,
        display_name: this.profileMeta[name]?.display_name ?? "",
        skill_count: (this.skills.folders[name] ?? []).length,
        gateway_running: this.gatewaysRunning.has(name),
        has_env: name in this.profileEnv,
        distribution_name: this.distributions[name] ?? null,
      })),
    }),
    // Settings → Model (hermes_cli/web_routers/models.py, config_env.py, delegation.py at the deployed `bf0203a`).
    // `get_model_options` is also the REST twin of `model.options`, which the composer's picker falls back to.
    "GET /api/model/options": () => {
      if (this.restModelOptions === null) throw new RestError(404, `{"detail":"Not Found"}`);
      return (
        this.restModelOptions ?? {
          model: this.modelConfig.model.default,
          provider: this.modelConfig.model.provider,
          providers: this.modelConfig.catalog.map((p) => ({ ...p, is_current: p.slug === this.modelConfig.model.provider, authenticated: true })),
        }
      );
    },
    "GET /api/model/auxiliary": () => ({
      tasks: Object.entries(this.modelConfig.auxiliary).map(([task, a]) => ({
        task,
        provider: a.provider || "auto",
        model: a.model,
        base_url: a.base_url ?? "",
        reasoning_effort: a.reasoning_effort || null,
        local_endpoint: /^https?:\/\/(127\.|10\.|192\.168\.|localhost)/.test(a.base_url ?? ""),
      })),
      main: { provider: this.modelConfig.model.provider, model: this.modelConfig.model.default },
    }),
    "GET /api/config": ({ query }) => ({
      model: this.modelConfig.model.default,
      skills: this.skills.config(query.get("profile") || "default"),
      agent: { ...this.modelConfig.agent },
      delegation: { ...this.modelConfig.delegation },
      terminal: { backend: this.terminalBackend[query.get("profile") || "default"] ?? "local" },
      ...(this.cron.zoneSetting(query.get("profile") || "default") && { timezone: this.cron.zoneSetting(query.get("profile") || "default") }),
      // The raw map, as `include_defaults=false` reads it: what Rust's MCP edit starts from (fakeMcp.ts).
      ...(this.mcp.servers[query.get("profile") || "default"] && { mcp_servers: this.mcp.servers[query.get("profile") || "default"] }),
    }),
    // `PUT /api/env` for an MCP server's bearer token, which Rust's edit saves first (`Dashboard::mcp_edit`).
    "PUT /api/env": ({ body, query }) => this.mcp.saveEnv(query.get("profile") || "default", String(body?.key ?? ""), String(body?.value ?? "")),
    "GET /api/delegation/routing": () => ({
      configured: "default",
      blocked_reason: null,
      backends: [],
      model_map: { options: this.modelConfig.modelMap, default: null },
      profile_routes: { profiles: [], default: null },
      profiles: ["default"],
    }),
    "POST /api/model/set": ({ body }) => this.setModel(body ?? {}),
    "POST /api/profiles": ({ body }) => this.createProfile(body ?? {}),
    "PUT /api/config": async ({ body, query }) => {
      // `ConfigUpdate` needs `config`; the rest deep-merges over the stored file (`update_config`).
      const config = body?.config;
      if (!config || typeof config !== "object")
        throw new RestError(422, `{"detail":[{"type":"missing","loc":["body","config"],"msg":"Field required"}]}`);
      const c = config as { agent?: Record<string, string>; delegation?: Record<string, unknown> };
      Object.assign(this.modelConfig.agent, c.agent ?? {});
      Object.assign(this.modelConfig.delegation, c.delegation ?? {});
      await this.voiceProviders.mergeConfig(query.get("profile") || "default", config as Record<string, unknown>);
      return { ok: true };
    },
  };

  /** The profile's model setup, as `config.yaml` holds it, and the catalog `model.options` lists. */
  modelConfig: FakeModelConfig = fakeModelConfig();

  /** Runtime session id -> the tool names its agent was built with, from its profile's list then (`tools.show`). */
  readonly agentTools = new Map<string, Set<string>>();
  /** Whether the socket has `tools.show`. */
  toolsShowMethod = true;
  /** Platforms whose toolset list each profile has saved; any other inherits Hermes's default. A change saves it. */
  toolsetSavedLists: Record<string, Set<string>> = {};
  /** The tool names a chat built now in `profile` is offered: its enabled toolsets' tools, `cli` platform only. */
  offeredTools(profile: string): Set<string> {
    const on = this.enabledToolsets(profile);
    const off = (n: string) => this.toolsetSuppressed.has(n) || !!this.toolsetDisabledEverywhere[profile]?.includes(n);
    return new Set(this.toolsetCatalog.filter((t) => t.platform === "cli" && on.has(t.name) && !off(t.name)).flatMap((t) => t.tools));
  }

  /** The toolsets every profile lists (plugins aside, the catalog is the same for each). */
  toolsetCatalog: FakeToolset[] = fakeToolsets();
  /** Each profile's enabled toolsets, as its config.yaml resolves them; a profile not here has the defaults. */
  toolsetsOn: Record<string, Set<string>> = {};
  /**
   * Which toolset routes this server has: all, `read-only` (a list but no toggle route) or `none` (neither), each
   * missing one answering FastAPI's own 404.
   */
  toolsetRoutes: "all" | "read-only" | "none" = "all";
  /** While set, the toggle route refuses every change with this status and reason, writing nothing. */
  toolsetRefusal?: { status: number; detail: string };
  /** Names `agent.disabled_toolsets` strips through a composite: saving them on still reads back off. */
  toolsetSuppressed = new Set<string>();
  /** While set, the toggle route waits for it after writing and before it answers. */
  toolsetGate?: Promise<void>;
  /** While set, the toggle route waits for it before it writes. */
  toolsetGateBeforeWrite?: Promise<void>;
  /** Platforms whose saved toolset list names `no_mcp`, per profile. Any toggle for that platform clears it. */
  toolsetNoMcp: Record<string, Set<string>> = {};
  /** Platforms whose saved toolset list Rust can't read for certain, per profile. */
  toolsetNoMcpUnclear: Record<string, string[]> = {};
  /** `agent.coding_context` is focus, per profile. */
  codingFocus: Record<string, boolean> = {};
  /** `agent.disabled_toolsets`, per profile: off on every platform. Turning one of these on removes it, as Hermes does. */
  toolsetDisabledEverywhere: Record<string, string[]> = {};
  /** `agent.disabled_toolsets` saved in a form Rust can't read for certain, per profile. */
  toolsetDisabledUnclear: Record<string, boolean> = {};
  /** While set, reading the config for the toolset guards fails with this. */
  toolsetGuardsFailure?: string | Error;
  /**
   * Each toolset's provider rows, as `GET /api/tools/toolsets/{name}/config` answers them (`provider_readiness_status`).
   * A toolset not here has no provider category. Checked live: web's keyless Exa row is ready and its ddgs row isn't.
   */
  toolsetProviders: Record<string, { name: string; post_setup?: string; status: string; is_active: boolean }[]> = {
    web: [
      { name: "Exa · Free (keyless)", status: "ready", is_active: false },
      { name: "DuckDuckGo (ddgs)", post_setup: "ddgs", status: "needs_setup", is_active: false },
    ],
    computer_use: [{ name: "cua-driver (background)", post_setup: "cua_driver", status: "needs_setup", is_active: false }],
    // `stt` and `tts` answer from `voiceProviders` unless a test sets them here.
  };
  /** While set, the next toolset list read waits for it (once). */
  toolsetListGateOnce?: Promise<void>;
  /** While set, `GET /api/tools/toolsets/{name}/config` for that name waits for it. */
  toolsetConfigGate: Record<string, Promise<void>> = {};
  /** While set, `GET /api/tools/toolsets/{name}/config` fails with this. */
  toolsetConfigFailure?: string | Error;
  /** The next toggle writes, then answers with this error anyway (a failure after the save, such as a 500). */
  failAfterToolsetWrite?: { status: number; detail: string };
  /** After the next toggle, every toolset list read fails with a 500. */
  toolsetReadsFailAfterWrite = false;
  private toolsetReadsFailing = false;
  /** The next toggle drops the connection before Hermes answers: `stored` wrote it first, `lost` never arrived. */
  dropOnToolsetWrite?: "stored" | "lost";
  /** Every toggle the route took, after validation: profile, name and value. */
  readonly toolsetWrites: { profile: string; name: string; enabled: boolean }[] = [];
  /** `GET /api/analytics/usage` `by_task`, by profile: Hermes's helper tasks' usage. */
  helperUsage: Record<string, Record<string, unknown>[]> = {};
  /** While set, `GET /api/analytics/usage` answers with this status, as a Hermes without the route answers 404. */
  analyticsRefused?: { status: number; detail: unknown };

  private onEvent?: (e: PipeEvent) => void;
  private imagesStaged = 0;
  private resumed = 0;
  /** False: a server without `session.undo`, which answers it "method not found". */
  undoMethod = true;
  /** While set, `session.undo` is refused as busy, as when a turn is running. */
  undoBusy = false;
  /** While set, `session.undo` fails with this error. */
  undoError?: { code: number; message: string };
  /** `session.undo` leaves the last row behind, as if Hermes took back a different part than asked. */
  undoShort = false;
  /** The stored sessions `session.undo` was asked of, in order. */
  undoCalls: string[] = [];
  /** False: a server older than `session.branch`, which answers it "method not found". */
  branchMethod = true;
  /** The next `session.branch` drops the connection before Hermes answers: `stored` made the branch first, `lost` never arrived. */
  dropOnBranch?: "stored" | "lost";
  /** While set, `session.branch` fails with this error. `stored`: Hermes stored the branch first, as when its agent can't be built. */
  branchError?: { code: number; message: string; stored?: boolean };
  /** Runs as a `session.branch` arrives, before Hermes copies anything: another client adding to the parent meanwhile. */
  beforeBranch?: () => void;
  /** Each branch Hermes made, by its idempotency key (`_idempotency_keys`): a retry with the key answers the same branch. */
  private branchKeys = new Map<string, { stored: string; runtimeId: string }>();
  private branched = 0;
  private asked = 0;
  closed = false;

  /**
   * `command.dispatch`'s `_dispatch_skill` for `profile`: the skill named, and any leading `/skill` words of `arg` (up to
   * five in all), wrapped as Hermes wraps them (`build_skill_invocation_message`, `build_stacked_skill_invocation_message`),
   * with the invocation Hermes's history shows for it. Undefined when `name` is no skill's command.
   */
  skillMessage(profile: string, name: string, arg: string) {
    const skills = this.catalogSkills ? this.skills.commandSkills(profile) : [];
    const find = (word: string) => skills.find((k) => k.slug === word.toLowerCase()) ?? skills.find((k) => k.slug === word.toLowerCase().replace(/_/g, "-"));
    const first = skills.find((k) => k.slug === name.toLowerCase());
    if (!first) return undefined;
    const extra: typeof skills = [];
    let rest = arg;
    while (extra.length < 4) {
      const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(rest.trimStart());
      const k = m && find(m[1]);
      if (!m || !k || extra.includes(k)) break;
      extra.push(k);
      rest = m[2] ?? "";
    }
    const instruction = rest.trim();
    const block = (k: (typeof skills)[number], note: string) => `${note}\n\n${k.body}\n\n[Skill directory: /home/liam/.hermes/skills/${k.name}]`;
    let message: string;
    let display: string;
    if (!extra.length) {
      const note = `[IMPORTANT: The user has invoked the "${first.name}" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]`;
      message = block(first, note) + (instruction ? `\nThe user has provided the following instruction alongside the skill invocation: ${instruction}` : "");
      display = `/${first.name}${instruction ? ` ${instruction.split(/\s+/).join(" ")}` : ""}`;
    } else {
      const loaded = [...new Set([first, ...extra])];
      const typed = [first, ...extra].map((k) => `/${k.slug}`).join(" ");
      const header = [
        `[IMPORTANT: The user has invoked the "${typed}" stacked skill bundle, loading ${loaded.length} skills together. Treat every skill below as active guidance for this turn.]`,
        "",
        `Skills loaded: ${loaded.map((k) => k.name).join(", ")}`,
        ...(instruction ? ["", `User instruction: ${instruction}`] : []),
      ].join("\n");
      message = [header, ...loaded.map((k) => block(k, `[Loaded as part of the "${typed}" stacked skill invocation.]`))].join("\n\n");
      display = `${typed}${instruction ? ` ${instruction.split(/\s+/).join(" ")}` : ""}`;
    }
    return { type: "skill", message, name: first.name, display };
  }

  openPipe: OpenPipe = async (onEvent, profile) => {
    if (this.refuse !== undefined) throw new Error(this.refuse);
    this.opened++;
    this.wsProfiles.push(profile);
    this.closed = false;
    // Runtime sessions belong to the connection that started them; closing it detaches them (research doc §5).
    this.runtime.clear();
    this.onEvent = onEvent;
    // The server writes gateway.ready as soon as the socket is accepted.
    this.frame({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: this.readyPayload } });
    // A new connection hasn't said yet whether it answers server→client requests.
    this.answersRequests = false;
    const restCall = (method: RestMethod, pathAndQuery: string, body?: string) => this.restCall(method, pathAndQuery, body);
    const send = async (text: string) => {
      if (this.failSend !== undefined) throw new Error(this.failSend);
      const req = JSON.parse(text) as Request | Response;
      if (!("method" in req)) {
        this.responses.push(req);
        if (this.openRequests.get(req.id)?.method === "approval" && req.result) this.approvalAnswers.push({ id: req.id, choice: req.result.choice, via: "response" });
        this.openRequests.delete(req.id);
        return;
      }
      this.requests.push(req);
      this.handlers[req.method]?.(req);
    };
    return {
      route: this.route,
      send,
      // Mirrors the Rust side (src-tauri/src/transport.rs): sizes from the disk, and a size check before sending.
      statFiles: async (paths) => paths.map((path) => this.stat(path)),
      sendFile: async (head, path, tail, maxBytes) => {
        const f = this.stat(path);
        if (f.error) throw new Error(f.error);
        if (f.size! > maxBytes) throw new Error(`it's ${(f.size! / MiB).toFixed(1)} MB now, over the ${maxBytes / MiB} MB limit`);
        const bytes = this.files[path];
        if (typeof bytes !== "string") throw new Error(`the fake has only a size for ${path}, no bytes to send`);
        await send(head + btoa(bytes) + tail);
      },
      // Mirror `Dashboard::transcribe`, `speak` and `voice_setup` in src-tauri/src/transport.rs.
      transcribe: async (profile, audio, mime) => {
        this.recordings.push({ profile, audio, mime });
        await this.voiceGate;
        if (!this.voice.transcribe) throw new Error("This Hermes server can't transcribe recordings: it has no /api/audio/transcribe route. Updating Hermes adds it.");
        if (this.heard instanceof Error) throw this.heard;
        return { text: this.heard.trim(), provider: this.voice.sttProvider };
      },
      speak: async (profile, text) => {
        this.spoken.push({ profile, text });
        await this.voiceGate;
        if (!this.voice.speak) throw new Error("This Hermes server can't read replies aloud: it has no /api/audio/speak route. Updating Hermes adds it.");
        if (this.speech instanceof Error) throw this.speech;
        return this.speech;
      },
      voiceSetup: async (profile) => {
        const gate = this.voiceSetupGate;
        this.voiceSetupGate = undefined;
        await gate;
        if (this.voiceSetupFailure) throw new Error(this.voiceSetupFailure);
        return { ...this.voice, ...this.voiceProviders.setup(profile) };
      },
      download: (id, path, name, onProgress) => this.managedFiles.download(id, path, name, onProgress),
      pickUpload: async () => this.managedFiles.pickUpload(),
      discardUpload: async (token) => void this.managedFiles.discardPick(token),
      upload: (id, token, path, overwrite, onProgress) => this.managedFiles.upload(id, token, path, overwrite, onProgress),
      saveText: (id, path, text, overwrite) => this.managedFiles.saveText(path, text, overwrite),
      fsSaveText: (_id, profile, path, text, session) => this.fsWriteText(profile, path, text, session),
      cancelTransfer: async (id) => this.managedFiles.cancel(id),
      context: this.context.pipe(),
      // Mirrors `Dashboard::toolset_guards`: only these two facts of the config.
      toolsetGuards: async (profile): Promise<ToolsetGuards> => {
        if (this.toolsetGuardsFailure) throw thrown(this.toolsetGuardsFailure);
        return {
          noMcp: [...(this.toolsetNoMcp[profile] ?? [])].sort(),
          noMcpUnclear: [...(this.toolsetNoMcpUnclear[profile] ?? [])],
          savedLists: [...(this.toolsetSavedLists[profile] ?? [])].sort(),
          codingFocus: !!this.codingFocus[profile],
          disabledEverywhere: [...(this.toolsetDisabledEverywhere[profile] ?? [])],
          disabledUnclear: !!this.toolsetDisabledUnclear[profile],
        };
      },
      request: (method, pathAndQuery, body) => restCall(method, pathAndQuery, body),
      // Mirrors `Dashboard::mcp_edit`: the raw map read, one server changed, the map written.
      mcpEdit: (profile, edit) => this.mcp.edit(profile, edit),
      // Mirrors the Rust side's `Dashboard::save_provider_key`: only a listed provider secret, checked, then saved.
      saveProviderKey: async (profile, envVar, key) => this.saveProviderKey(profile, envVar, key),
      // Mirrors `Dashboard::remove_provider_key`: only a listed provider secret, then it reads unset.
      removeProviderKey: async (profile, envVar) => this.removeProviderKey(profile, envVar),
      // Mirror `Dashboard::provider_sign_ins`, `custom_endpoints` and `save_endpoint`.
      providerSignIns: async (profile) => this.accounts.signIns(profile),
      customEndpoints: async (profile) => this.accounts.list(profile),
      saveEndpoint: async (profile, form, anyway) => this.accounts.save(profile, form, anyway),
      // Mirrors `Dashboard::get_limited`: any GET the relay takes, refused once the answer passes the limit.
      getLimited: async (pathAndQuery, maxBytes) => {
        const body = await restCall("GET", pathAndQuery);
        if (body.length > maxBytes) throw new Error(`it's ${(body.length / MiB).toFixed(1)} MB now, over the ${Math.floor(maxBytes / MiB)} MB limit`);
        return body;
      },
      close: async () => {
        this.closed = true;
        this.managedFiles.stopAll();
      },
    };
  };

  /** One dashboard REST call as the Rust relay makes it: the answer's body on 2xx, or an error worded as Rust words it. */
  private async restCall(method: RestMethod, pathAndQuery: string, body?: string): Promise<string> {
    const url = new URL(pathAndQuery, "http://dashboard/");
    const req: RestRequest = { method, path: url.pathname, query: url.searchParams, body: body === undefined ? undefined : JSON.parse(body) };
    this.restRequests.push(req);
    const patch = /^\/api\/sessions\/([^/]+)$/.exec(req.path);
    const snapshot = /^\/api\/sessions\/([^/]+)\/mutation-snapshot$/.exec(req.path);
    const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(req.path);
    const soul = /^\/api\/profiles\/([^/]+)\/soul$/.exec(req.path);
    const profilePath = /^\/api\/profiles\/([^/]+)$/.exec(req.path);
    const profileField = /^\/api\/profiles\/([^/]+)\/(description|model|describe-auto)$/.exec(req.path);
    const handler =
      this.rest[`${method} ${req.path}`] ??
      (method === "POST" && req.path === "/api/sessions/import" ? () => this.importSessions(req.body!) : undefined) ??
      (method === "PATCH" && patch ? () => this.patchSession(patch[1], req.body!) : undefined) ??
      (method === "GET" && patch ? () => this.sessionDetail(decodeURIComponent(patch[1]), req.query.get("profile")) : undefined) ??
      (method === "DELETE" && patch ? () => this.deleteSession(decodeURIComponent(patch[1]), req.query) : undefined) ??
      (method === "GET" && snapshot ? () => this.mutationSnapshot(snapshot[1], req.query.get("profile")) : undefined) ??
      (method === "GET" && messages ? () => this.storedMessages(decodeURIComponent(messages[1]), req.query) : undefined) ??
      (soul && this.soulRoutes && (method === "GET" || method === "PUT") ? () => this.soul(method, decodeURIComponent(soul[1]), req.body) : undefined) ??
      (method === "DELETE" && profilePath && !this.profileRoutesMissing.has("remove") ? () => this.deleteProfile(decodeURIComponent(profilePath[1])) : undefined) ??
      (method === "PATCH" && profilePath && !this.profileRoutesMissing.has("rename") ? () => this.renameProfile(decodeURIComponent(profilePath[1]), req.body ?? {}) : undefined) ??
      (profileField ? this.profileFieldRoute(method, decodeURIComponent(profileField[1]), profileField[2], req.body ?? {}) : undefined) ??
      this.webhooks.route(req) ??
      this.cron.route(req) ??
      this.kanban.route(req) ??
      this.skills.route(req) ??
      this.learningRoute(req) ??
      this.memoryProviders.route(req) ??
      this.mcp.route(req) ??
      this.gateways.route(req) ??
      this.accounts.route(req) ??
      this.voiceProviders.route(req);
    const toolset = /^\/api\/tools\/toolsets(?:\/([^/]+)(\/config)?)?$/.exec(req.path);
    if (!handler && toolset) return JSON.stringify(await this.toolsetRoute(req, toolset[1], !!toolset[2]));
    if (soul && this.soulRoutes && method !== "GET" && method !== "PUT") throw new RestError(405, `{"detail":"Method Not Allowed"}`);
    // A path Hermes routes for another method: FastAPI answers 405.
    if (!handler && profilePath && (method === "PATCH" || method === "DELETE") && !(this.profileRoutesMissing.has("rename") && this.profileRoutesMissing.has("remove")))
      throw new RestError(405, `{"detail":"Method Not Allowed"}`);
    if (soul && !this.soulRoutes) throw new RestError(404, `{"detail":"No such API endpoint: ${req.path}"}`);
    if (!handler) throw new RestError(404, `{"detail":"Not Found"}`);
    return JSON.stringify(await handler(req));
  }

  /** A profile's enabled toolsets, its defaults when it has saved none: every listed one but `discord` and `image_gen`. */
  enabledToolsets(profile: string): Set<string> {
    return (this.toolsetsOn[profile] ??= new Set(this.toolsetCatalog.filter((t) => !["discord", "image_gen", "computer_use"].includes(t.name)).map((t) => t.name)));
  }

  /** `hermes_cli/web_routers/tools.py` at the deployed `bf0203a`: the list, one toolset's config, and the toggle. */
  private async toolsetRoute(req: RestRequest, rawName: string | undefined, config: boolean): Promise<unknown> {
    const notFound = () => new RestError(404, `{"detail":"Not Found"}`);
    if (this.toolsetRoutes === "none") throw notFound();
    const profile = req.query.get("profile") ?? "default";
    if (profile !== "default" && !(profile in this.otherProfiles))
      throw new RestError(404, `{"detail":"Profile '${profile}' does not exist"}`);
    const name = rawName === undefined ? undefined : decodeURIComponent(rawName);
    const on = this.enabledToolsets(profile);
    const known = (n: string) => this.toolsetCatalog.find((t) => t.name === n);
    if (req.method === "GET" && name === undefined && this.toolsetListGateOnce) {
      const gate = this.toolsetListGateOnce;
      this.toolsetListGateOnce = undefined;
      await gate;
    }
    if (req.method === "GET" && name === undefined && this.toolsetReadsFailing)
      throw new RestError(500, `{"detail":"Internal Server Error"}`);
    if (req.method === "GET" && name === undefined)
      return this.toolsetCatalog.map(({ installs: _i, ...t }) => {
        const enabled = on.has(t.name) && !this.toolsetSuppressed.has(t.name) && !this.toolsetDisabledEverywhere[profile]?.includes(t.name);
        return { ...t, enabled, available: enabled };
      });
    if (req.method === "GET" && name !== undefined && config) {
      // `stt` and `tts` answer from the speech providers' fake unless a test set their rows here.
      const voiceNow = name in this.toolsetProviders ? undefined : await this.voiceProviders.configRoute(profile, name);
      const t = voiceNow ? true : known(name);
      if (!t) throw new RestError(400, `{"detail":"Unknown toolset: ${name}"}`);
      if (this.toolsetConfigFailure) throw thrown(this.toolsetConfigFailure);
      const gate = this.toolsetConfigGate[name];
      const providersNow = (this.toolsetProviders[name] ?? []).map((p) => ({ ...p }));
      if (gate) {
        delete this.toolsetConfigGate[name];
        await gate;
        if (voiceNow) return voiceNow;
        const providers = providersNow.map((p) => ({ env_vars: [], post_setup: null, ...p }));
        return { name, has_category: providers.length > 0, providers, active_provider: providers.find((p) => p.is_active)?.name ?? null };
      }
      if (voiceNow) return voiceNow;
      const providers = (this.toolsetProviders[name] ?? []).map((p) => ({ env_vars: [], post_setup: null, ...p }));
      const active = providers.find((p) => p.is_active)?.name ?? null;
      return { name, has_category: providers.length > 0, providers, active_provider: active };
    }
    if (req.method === "PUT" && name !== undefined && !config) {
      if (this.toolsetRoutes === "read-only") throw notFound();
      // `ToolsetToggle`: FastAPI checks the body before the route runs.
      if (typeof req.body?.enabled !== "boolean")
        throw new RestError(422, `{"detail":[{"type":"bool_parsing","loc":["body","enabled"],"msg":"Input should be a valid boolean"}]}`);
      if (!known(name)) throw new RestError(400, `{"detail":"Unknown toolset: ${name}"}`);
      if (this.toolsetRefusal) throw new RestError(this.toolsetRefusal.status, JSON.stringify({ detail: this.toolsetRefusal.detail }));
      await this.toolsetGateBeforeWrite;
      const drop = this.dropOnToolsetWrite;
      this.dropOnToolsetWrite = undefined;
      if (drop === "lost") throw new Error("Can't reach the Hermes dashboard: connection reset");
      const enabled = req.body.enabled;
      this.toolsetWrites.push({ profile, name, enabled });
      if (enabled) on.add(name);
      else on.delete(name);
      // `_save_platform_tools` drops the `no_mcp` sentinel from the platform's list, and saves the whole list into the
      // profile; `stt` writes its own section.
      if (name !== "stt") this.toolsetNoMcp[profile]?.delete(known(name)!.platform);
      if (name !== "stt") (this.toolsetSavedLists[profile] ??= new Set()).add(known(name)!.platform);
      // And clears a toolset just turned on from `agent.disabled_toolsets`, on every platform (#49995).
      const everywhere = this.toolsetDisabledEverywhere[profile];
      if (enabled && name !== "stt" && everywhere) this.toolsetDisabledEverywhere[profile] = everywhere.filter((n) => n !== name);
      if (drop === "stored") throw new Error("Can't reach the Hermes dashboard: connection reset");
      if (this.toolsetReadsFailAfterWrite) this.toolsetReadsFailing = true;
      const late = this.failAfterToolsetWrite;
      this.failAfterToolsetWrite = undefined;
      if (late) throw new RestError(late.status, JSON.stringify({ detail: late.detail }));
      await this.toolsetGate;
      const installs = enabled && this.toolsetProviders[name]?.some((p) => p.post_setup === known(name)?.installs && p.status === "needs_setup") ? known(name)?.installs : undefined;
      return { ok: true, name, platform: known(name)!.platform, enabled, post_setup_started: installs ?? null };
    }
    throw notFound();
  }

  private saveProviderKey(profile: string, envVar: string, key: string): SavedKey {
    const row = this.env?.[envVar];
    if (!row || !row.provider || row.is_password !== true || row.channel_managed === true)
      throw new Error(`Hermes Chat doesn't relay ${envVar}: Hermes doesn't list it as a model provider's key.`);
    const value = key.trim();
    if (!value || /[\u0000-\u001f]/.test(value)) throw new Error("Paste the key on one line, without spaces around it.");
    const checked = this.checkKey(value);
    // As Rust does, the provider's own message isn't passed on: it can quote part of the key.
    if (!checked.ok && checked.reachable) throw new Error("The provider turned the key down. Check that you copied all of it, and that it's for this provider.");
    this.savedKeys.push({ profile, envVar, key: value });
    this.env![envVar] = { ...row, is_set: true, redacted_value: `${value.slice(0, 3)}…${value.slice(-2)}` };
    return { verified: checked.ok && checked.reachable };
  }

  private removeProviderKey(profile: string, envVar: string) {
    const row = this.env?.[envVar];
    if (!row || !row.provider || row.is_password !== true || row.channel_managed === true)
      throw new Error(`Hermes Chat doesn't relay ${envVar}: Hermes doesn't list it as a model provider's key.`);
    if (this.removeKeyFails) throw new Error(this.removeKeyFails);
    this.removedKeys.push({ profile, envVar });
    this.env![envVar] = { ...row, is_set: false, redacted_value: null };
  }

  /**
   * One `learning.*` request: "method not found" on a server without them, 4000 for a param the contract doesn't
   * have (pydantic `extra="forbid"`), else `answer`'s result.
   */
  private learning(r: Request, allowed: string[], answer: () => unknown) {
    if (!this.learningMethods) return this.fail(r.id, -32601, `unknown method: ${r.method}`);
    const extra = Object.keys(r.params ?? {}).find((k) => !allowed.includes(k));
    if (extra) return this.fail(r.id, 4000, `invalid params for ${r.method}: ${extra}: Extra inputs are not permitted`);
    this.beforeLearning?.(r.method, r.params);
    const result = answer();
    if (result !== undefined) this.respond(r.id, result);
  }

  /** A profile's memory cards, the served profile's by default, MEMORY.md's first (`agent/learning_graph._memory_cards`). */
  private memoryCards(profile = this.servedProfile): { source: "memory" | "profile"; text: string; id: string }[] {
    const m = this.memory[profile] ?? { memory: [], profile: [] };
    const cards = [...m.memory.map((text) => ({ source: "memory" as const, text })), ...m.profile.map((text) => ({ source: "profile" as const, text }))];
    return cards.map((c, i) => ({ ...c, id: `memory:${c.source}:${i}:${fingerprint(c.text)}` }));
  }

  /** `learning.frames`, trimmed to the parts that carry nodes: every card in one day's bucket. */
  private memoryFrames() {
    const cards = this.memoryCards();
    const nodes = cards.map((c) => ({ id: c.id, glyph: "◆", label: c.text.slice(0, 40), fullLabel: c.text.split("\n")[0], meta: "memory", body: c.text.slice(0, 1200), style: "memory" }));
    return {
      frames: [],
      legend: [],
      categories: [],
      buckets: cards.length ? [{ index: 0, label: "2 Nov", date: "2 Nov 2026", skills: 0, memories: cards.length, total: cards.length, nodes }] : [],
      summary: [],
      axis: { start: "", end: "" },
      count: cards.length,
      cols: 20,
      rows: 10,
    };
  }

  /** The entry a memory node id names, found by its fingerprint as `_locate_memory` does, or why it can't be. */
  private memoryEntry(id: string, profile = this.servedProfile): { source: "memory" | "profile"; text: string } | string {
    const parts = id.split(":");
    if (parts.length !== 4 || parts[0] !== "memory" || (parts[1] !== "memory" && parts[1] !== "profile")) return `bad memory node id: '${id}'`;
    const found = this.memoryCards(profile).find((c) => c.source === parts[1] && fingerprint(c.text) === parts[3]);
    return found ?? "memory node id is stale — refresh the graph";
  }

  /** `learning.edit` (`content`) or `learning.delete` (null), under the same refusals as `_mutate_memory`. */
  private memoryWrite(r: Request, content: string | null): unknown {
    if (this.learningError) {
      const { code, message } = this.learningError;
      this.learningError = undefined;
      return this.fail(r.id, code, message);
    }
    const answer = this.memoryMutate(this.servedProfile, String(r.params.id ?? ""), content);
    if (answer !== "drop") return answer;
    this.drop();
    return undefined;
  }

  /**
   * `_mutate_memory` on `profile`'s memory: `content` replaces the entry the id names, or null removes it. "drop": the
   * connection is to drop now (`dropOnLearning`), after writing if that says `applied`.
   */
  private memoryMutate(profile: string, id: string, content: string | null): { ok: boolean; message: string } | "drop" {
    const found = this.memoryEntry(id, profile);
    const body = content?.trim();
    if (content !== null && !body) return { ok: false, message: "empty memory — use delete to remove it" };
    if (typeof found === "string") return { ok: false, message: found };
    const m = (this.memory[profile] ??= { memory: [], profile: [] });
    const entries = m[found.source];
    const next = entries.flatMap((e) => (e === found.text ? (body === undefined ? [] : [body]) : [e]));
    const total = [...next.join("\n§\n")].length;
    const limit = this.memoryLimit[found.source];
    if (body !== undefined && total > limit)
      return { ok: false, message: `Replacement would put memory at ${total.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars. Shorten the new content.` };
    const drop = this.dropOnLearning;
    this.dropOnLearning = undefined;
    if (drop !== "lost") m[found.source] = [...new Set(next)];
    if (drop) return "drop";
    const name = found.source === "memory" ? "MEMORY.md" : "USER.md";
    return { ok: true, message: body === undefined ? `deleted memory from ${name}` : `updated memory in ${name}` };
  }

  /** Every profile this fake server has, for routes that refuse an unknown `?profile=` (`_profile_scope`'s 404). */
  private knownProfile(profile: string | null): string {
    const p = profile || this.servedProfile;
    if (p === "default" || p in this.otherProfiles || p in this.memory || this.skills.profiles.has(p)) return p;
    throw new RestError(404, JSON.stringify({ detail: `Profile '${p}' does not exist.` }));
  }

  /**
   * `/api/learning/graph` and `/api/learning/node` (`hermes_cli/web_routers/status.py` at `f0d94882`), each under
   * `?profile=`: the graph's memory nodes (its skill nodes left out, as this app doesn't read them), one node's
   * detail (404 with Hermes's reason when it isn't there), and the edit and delete. A delete of an id that isn't a
   * memory node archives the skill of that name (`learning_mutations._delete_skill`).
   */
  private learningRoute(req: RestRequest): (() => unknown) | undefined {
    if (req.path !== "/api/learning/graph" && req.path !== "/api/learning/node") return undefined;
    const notHere = () => Promise.reject(new RestError(404, JSON.stringify({ detail: `No such API endpoint: ${req.path}` })));
    if (!this.learningRoutes) return notHere;
    const refuse = (status: number, detail: string) => new RestError(status, JSON.stringify({ detail }));
    const at = `${req.method} ${req.path}`;
    if (at === "GET /api/learning/graph")
      return () => {
        const profile = this.knownProfile(req.query.get("profile"));
        const cards = this.memoryCards(profile);
        return {
          nodes: cards.map((c) => ({ id: c.id, label: c.text.split("\n")[0].slice(0, 80), kind: "memory", memorySource: c.source, timestamp: null, category: "memory" })),
          edges: [],
          memory: cards.map((c) => ({ source: c.source, title: c.text.split("\n")[0].slice(0, 80), body: c.text.slice(0, 1200), fingerprint: fingerprint(c.text) })),
        };
      };
    if (at === "GET /api/learning/node")
      return () => {
        const profile = this.knownProfile(req.query.get("profile"));
        const id = req.query.get("id") ?? "";
        const found = this.memoryEntry(id, profile);
        if (typeof found === "string") throw refuse(404, found);
        return { ok: true, kind: "memory", id, label: found.text.split("\n")[0].slice(0, 80), content: found.text };
      };
    if (at === "PUT /api/learning/node" || at === "DELETE /api/learning/node")
      return () => {
        const profile = this.knownProfile(req.query.get("profile"));
        const { id, content } = (req.body ?? {}) as { id?: string; content?: string };
        this.beforeLearningRest?.(profile, { id, content });
        if (this.learningRestRefusal) {
          const { status, detail } = this.learningRestRefusal;
          this.learningRestRefusal = undefined;
          throw refuse(status, detail);
        }
        if (req.method === "DELETE" && !String(id).startsWith("memory:")) {
          const res = this.skills.archive(profile, String(id ?? ""));
          if (!res.ok) throw refuse(400, res.message);
          return res;
        }
        const res = this.memoryMutate(profile, String(id ?? ""), req.method === "PUT" ? String(content ?? "") : null);
        if (res === "drop") throw new Error("Can't reach the Hermes dashboard: the connection was reset.");
        if (!res.ok) throw refuse(400, res.message);
        return res;
      };
    return () => Promise.reject(refuse(405, "Method Not Allowed"));
  }

  /**
   * `POST /api/profiles` at `f0d94882` (`create_profile_endpoint`, `profiles.create_profile`): refuses an invalid, reserved
   * or taken name and an unknown source (400), then makes the whole profile at once. Fresh, it has an empty `.env`, the
   * body's SOUL.md (else Hermes's default) and its model if Hermes's check takes it. `clone_from` copies the source's
   * `.env` without bot tokens, SOUL.md, model, skill folders and memory. Chats and scheduled jobs are never copied.
   */
  private createProfile(body: Record<string, unknown>): unknown {
    const refuse = (detail: string) => new RestError(400, JSON.stringify({ detail }));
    this.beforeProfileCreate?.();
    if (this.profileCreateError) throw thrown(this.profileCreateError);
    const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
    const known = (p: string) => p === "default" || p in this.otherProfiles;
    if (name === "default") throw refuse("Cannot create a profile named 'default' — it is the built-in profile (~/.hermes).");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw refuse(`'${name}' is not a valid profile name.`);
    if (["hermes", "test", "tmp", "root", "sudo"].includes(name))
      throw refuse(`Profile name '${name}' is reserved — it collides with either the Hermes installation itself or a common system binary.  Pick a different name.`);
    if (known(name)) throw refuse(`A profile named '${name}' already exists. Switch to it with \`hermes profile use ${name}\`, or choose a different name.`);
    const source = typeof body.clone_from === "string" ? body.clone_from : undefined;
    if (source !== undefined && !known(source)) throw refuse(`Source profile '${source}' does not exist at /home/liam/.hermes/profiles/${source}`);
    this.otherProfiles[name] = [];
    this.skills.profiles.add(name);
    let modelSet = false;
    let modelError = "";
    if (source !== undefined) {
      this.profileEnv[name] = Object.fromEntries(Object.entries(this.profileEnv[source] ?? {}).filter(([k]) => !/_BOT_TOKEN$/.test(k)));
      if (source in this.souls) this.souls[name] = this.souls[source];
      if (this.profileModel[source]) this.profileModel[name] = { ...this.profileModel[source] };
      for (const skill of this.skills.folders[source] ?? []) {
        const dir = `${FakeSkills.home(name)}${skill.dir.slice(FakeSkills.home(source).length)}`;
        this.skills.add(name, { ...skill, dir }, this.skills.file(skill.dir));
      }
      if (this.memory[source]) this.memory[name] = { memory: [...this.memory[source].memory], profile: [...this.memory[source].profile] };
    } else {
      this.profileEnv[name] = {};
      this.souls[name] = typeof body.soul === "string" ? body.soul : "You are Hermes, a helpful assistant.\n";
      const provider = typeof body.provider === "string" ? body.provider.trim() : "";
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (provider && model) {
        if (this.profileModelError) modelError = this.profileModelError;
        else {
          this.profileModel[name] = { model, provider, reasoning_effort: "medium", fast: false };
          modelSet = true;
        }
      }
    }
    if (typeof body.description === "string" && body.description.trim()) this.profileMeta[name] = { ...this.profileMeta[name], description: body.description.trim() };
    if (this.profileCreateLost) throw new Error(this.profileCreateLost);
    return {
      ok: true,
      name,
      path: `/home/liam/.hermes/profiles/${name}`,
      model_set: modelSet,
      model_error: modelError,
      mcp_written: 0,
      skills_disabled: 0,
      hub_installs: [],
      soul_set: typeof body.soul === "string",
    };
  }

  /** `DELETE /api/profiles/{name}` at `f0d94882`: removes the profile's folder; the default profile can't be deleted. */
  /**
   * `PATCH /api/profiles/{name}` `{new_name}` at `f0d94882` (`rename_profile`): for `default`, a display name only
   * (empty or over 64 characters refused); otherwise the new id is lowercased and checked as a create checks it, the
   * gateway stopped, and the profile's folder moved with everything in it.
   */
  private async renameProfile(name: string, body: Record<string, unknown>): Promise<unknown> {
    const refuse = (detail: string) => new RestError(400, JSON.stringify({ detail }));
    const known = (p: string) => p === "default" || p in this.otherProfiles;
    if (typeof body.new_name !== "string")
      throw new RestError(422, `{"detail":[{"type":"missing","loc":["body","new_name"],"msg":"Field required"}]}`);
    if (name !== "default" && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw refuse(`'${name}' is not a valid profile name.`);
    if (!known(name)) throw new RestError(404, JSON.stringify({ detail: `Profile '${name}' does not exist.` }));
    if (name === "default") {
      const display = body.new_name.trim();
      if (!display) throw refuse("Display name cannot be empty.");
      if (display.length > 64) throw refuse(`Display name too long (${display.length} chars, max 64).`);
      this.profileMeta.default = { ...this.profileMeta.default, display_name: display };
      return { ok: true, name: "default", display_name: display, path: "/home/liam/.hermes" };
    }
    const to = body.new_name.trim().toLowerCase();
    if (to === "default") throw refuse("Cannot rename to 'default' — it is reserved.");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(to)) throw refuse(`'${to}' is not a valid profile name.`);
    if (["hermes", "test", "tmp", "root", "sudo"].includes(to)) throw refuse(`Profile name '${to}' is reserved.`);
    if (known(to)) throw refuse(`Profile '${to}' already exists.`);
    if (this.profileGatewayStop) await this.profileGatewayStop;
    if (this.profileRenameError) throw thrown(this.profileRenameError);
    const move = <T,>(m: Record<string, T>) => {
      if (name in m) {
        m[to] = m[name];
        delete m[name];
      }
    };
    move(this.otherProfiles);
    move(this.souls);
    move(this.profileEnv);
    move(this.profileModel);
    move(this.profileMeta);
    move(this.memory);
    move(this.distributions);
    move(this.skills.folders);
    if (this.skills.profiles.delete(name)) this.skills.profiles.add(to);
    if (this.gatewaysRunning.delete(name)) this.gatewaysRunning.add(to);
    if (this.profileRenameLost) throw new Error(this.profileRenameLost);
    return { ok: true, name: to, path: `/home/liam/.hermes/profiles/${to}` };
  }

  /** `PUT …/description`, `PUT …/model` and `POST …/describe-auto` at `f0d94882`, each after `_resolve_profile_dir`. */
  private profileFieldRoute(method: string, name: string, field: string, body: Record<string, unknown>): ((req: RestRequest) => unknown) | undefined {
    const route = field === "description" ? "describe" : field === "model" ? "setModel" : "describeAuto";
    if (this.profileRoutesMissing.has(route)) return undefined;
    if ((field === "describe-auto") !== (method === "POST") || (field !== "describe-auto" && method !== "PUT")) return undefined;
    return () => {
      if (name !== "default" && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new RestError(400, JSON.stringify({ detail: `'${name}' is not a valid profile name.` }));
      if (name !== "default" && !(name in this.otherProfiles)) throw new RestError(404, JSON.stringify({ detail: `Profile '${name}' does not exist.` }));
      if (field === "description") {
        const text = typeof body.description === "string" ? body.description.trim() : "";
        this.profileMeta[name] = { ...this.profileMeta[name], description: text, description_auto: false };
        return { ok: true, description: text, description_auto: false };
      }
      if (field === "model") {
        const provider = typeof body.provider === "string" ? body.provider.trim() : "";
        const model = typeof body.model === "string" ? body.model.trim() : "";
        if (!provider || !model) throw new RestError(400, JSON.stringify({ detail: "provider and model are required" }));
        this.profileModel[name] = { ...(this.profileModel[name] ?? { reasoning_effort: "medium", fast: false }), model, provider };
        return { ok: true, provider, model };
      }
      const outcome = this.describeAuto;
      if (outcome.ok) this.profileMeta[name] = { ...this.profileMeta[name], description: outcome.description, description_auto: true };
      return { ok: outcome.ok, reason: outcome.ok ? "" : outcome.reason, description: outcome.ok ? outcome.description : "", description_auto: outcome.ok };
    };
  }

  private async deleteProfile(name: string): Promise<unknown> {
    if (name === "default") throw new RestError(400, JSON.stringify({ detail: "Cannot delete the default profile." }));
    if (!(name in this.otherProfiles)) throw new RestError(404, JSON.stringify({ detail: `Profile '${name}' does not exist.` }));
    if (this.profileGatewayStop) await this.profileGatewayStop;
    this.gatewaysRunning.delete(name);
    delete this.otherProfiles[name];
    delete this.souls[name];
    delete this.profileEnv[name];
    delete this.profileModel[name];
    delete this.profileMeta[name];
    delete this.memory[name];
    delete this.skills.folders[name];
    this.skills.profiles.delete(name);
    if (this.profileSettlementPending !== undefined)
      return { ok: true, path: `/home/liam/.hermes/profiles/${name}`, identity_settled: false, settlement_pending: true, retry_command: this.profileSettlementPending };
    return { ok: true, path: `/home/liam/.hermes/profiles/${name}` };
  }

  /**
   * `GET`/`PUT /api/profiles/{name}/soul` at `bf0203a`: `_resolve_profile_dir` (400 bad name, 404 no profile), then a
   * read with `encoding="utf-8-sig"` and universal newlines, or an unconditional whole-file write that creates it.
   */
  private soul(method: string, name: string, body?: Record<string, unknown>): unknown {
    if (name !== "default" && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new RestError(400, `{"detail":"Invalid profile name '${name}'"}`);
    if (name !== "default" && !(name in this.otherProfiles)) throw new RestError(404, `{"detail":"Profile '${name}' does not exist."}`);
    if (method === "GET") {
      if (this.soulReadError) throw thrown(this.soulReadError);
      const file = this.souls[name];
      return file === undefined ? { content: "", exists: false } : { content: file.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"), exists: true };
    }
    if (typeof body?.content !== "string")
      throw new RestError(422, `{"detail":[{"type":"missing","loc":["body","content"],"msg":"Field required"}]}`);
    this.beforeSoulWrite?.();
    if (this.soulWriteError) throw thrown(this.soulWriteError);
    this.souls[name] = body.content;
    this.afterSoulWrite?.();
    if (this.soulWriteLost) throw thrown(this.soulWriteLost);
    return { ok: true };
  }

  /** A Server file for `/api/fs/*`, failing the way `_fs_regular_file` and `_is_sensitive_path` do at `bf0203a`. */
/**
   * `fs_write_text` at `bf0203a` for a host-local profile: the parent must be a folder, only a regular file is replaced,
   * the text is stored as UTF-8 (one char per byte here, as `serverFiles` holds bytes). The Rust side refuses
   * credential paths before anything is sent (`write_agent_text`).
   */
  private async fsWriteText(profile: string, asked: string, text: string, session?: string): Promise<string> {
    if (/(^|\/)(\.env(\..*)?|auth\.json|config\.yaml)$/i.test(asked)) throw new Error(`Hermes Chat doesn't relay writes to ${asked}, a credential file Hermes keeps out of reach`);
    await this.fsWriteGate;
    if (this.fsWriteFailure !== undefined) throw thrown(this.fsWriteFailure);
    this.ownedSession(profile, session);
    // `fs_write_text` resolves the target as `read-text` does, `session_id` included.
    const path = this.sandboxPath(asked, session) ?? asked;
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    const all = [...this.serverDirs, ...Object.keys(this.serverFiles)];
    const parentIsDir = this.serverDirs.has(parent) || typeof this.serverFiles[parent] === "object" || all.some((p) => p.startsWith(`${parent}/`));
    if (typeof this.serverFiles[path] === "object") throw new RestError(400, `{"detail":"Path points to a directory"}`);
    if (!parentIsDir) throw new RestError(400, `{"detail":"Parent directory does not exist"}`);
    const bytes = new TextEncoder().encode(text);
    this.serverFiles[path] = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    this.fsWrites.push({ profile, path: asked, text, ...(session && { session }) });
    this.afterFsWrite?.(path);
    return JSON.stringify({ ok: true, path, byteSize: bytes.length });
  }

    private serverFile(query: URLSearchParams): { path: string; data: string } {
    const profile = query.get("profile");
    if (profile && profile !== "default" && !(profile in this.otherProfiles))
      throw new RestError(404, `{"detail":"Profile '${profile}' does not exist."}`);
    const asked = query.get("path") ?? "";
    const failure = this.fsReadFailure?.(asked);
    if (failure) throw thrown(failure);
    const session = query.get("session_id") ?? undefined;
    this.ownedSession(profile, session);
    const mapped = this.sandboxPath(asked, session);
    // A container path that maps to no file in the sandbox it names (`_fs_sandbox_not_found_detail`).
    if (mapped !== undefined && typeof this.serverFiles[mapped] !== "string" && this.serverFiles[mapped] === undefined)
      throw new RestError(404, `{"detail":"${SANDBOX_NOT_FOUND}"}`);
    const path = mapped ?? asked;
    const name = path.split("/").pop() ?? "";
    if (/^\.env(\..*)?$|^auth\.json$|^config\.yaml$/i.test(name))
      throw new RestError(403, `{"detail":"Access to sensitive files is not allowed"}`);
    const f = this.serverFiles[path];
    if (f === undefined) throw new RestError(404, `{"detail":"File not found"}`);
    if (typeof f !== "string") throw new RestError(400, `{"detail":"Path points to a directory"}`);
    return { path, data: f };
  }

  /**
   * Where a container path is on the host under `sandbox`: `/workspace/…` in the folder of the chat `session` names, or
   * of the profile. Undefined for any other path, or with no sandbox.
   */
  private sandboxPath(path: string, session?: string): string | undefined {
    if (!this.sandbox || !(path === "/workspace" || path.startsWith("/workspace/"))) return undefined;
    const root = (session && this.sandbox.chats[session]) || this.sandbox.profile;
    return root ? root + path.slice("/workspace".length) : `/nonexistent-sandbox${path}`;
  }

  /** `_fs_owned_session`: a `session_id` the profile doesn't own (or a blank one) is 404 before anything is read. */
  private ownedSession(profile: string | null | undefined, session: string | undefined) {
    if (session === undefined) return;
    if (!session.trim() || !(this.store(profile) ?? []).some((s) => s.id === session)) throw new RestError(404, `{"detail":"Session not found"}`);
  }

  /** The subagent a control names, if the session asking started it; null when the session isn't open. */
  private ownedSubagent(r: Request) {
    const sid = String(r.params.session_id ?? "");
    const stored = this.runtime.get(sid);
    if (!stored) return null;
    return (this.subagents[stored] ?? []).find((row) => row.subagent_id === r.params.subagent_id && row.owner === sid);
  }

  respond(id: number, result: unknown) {
    this.frame({ jsonrpc: "2.0", id, result });
  }

  fail(id: number, code: number, message: string) {
    this.frame({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** The runtime sessions with a turn running, as far as this fake has heard: started by a prompt or `message.start`, ended by `message.complete` or `error`. */
  readonly turns = new Set<string>();
  /** The runtime sessions the owner stopped, until their next prompt: the poller starts no wake turn in them (`_notif_claim_turn`). */
  readonly stopped = new Set<string>();

  event(sessionId: string, type: string, payload: Record<string, unknown> = {}) {
    if (type === "message.start") this.turns.add(sessionId);
    if (type === "message.complete" || type === "error") this.turns.delete(sessionId);
    this.frame({ jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, payload } });
  }

  /** A reply that starts two background subagents, as `delegate_task` in background mode reports them, and ends its turn while they run. */
  private backgroundReply(runtimeId: string, stored: string) {
    this.event(runtimeId, "message.start");
    const ids: string[] = [];
    for (const goal of ["Read the auth code", "Read the tests"]) {
      const subagent_id = `sa-${++this.subagentSeq}`;
      ids.push(subagent_id);
      const payload = { subagent_id, goal, task_index: ids.length - 1, task_count: 2, depth: 0, delegation_id: `dlg-${runtimeId}`, model: "stand-in-model" };
      (this.subagents[stored] ??= []).push({ ...payload, owner: runtimeId, status: "running", accepting_steer: true, started_at: now() });
      this.event(runtimeId, "subagent.start", payload);
    }
    const text = `Two subagents are on it in the background (${ids.join(", ")}). I'll report when they finish.`;
    this.event(runtimeId, "message.delta", { text });
    this.storeMessage(stored, { role: "assistant", text });
    this.event(runtimeId, "message.complete", { text, status: "complete" });
  }
  private subagentSeq = 0;

  approvalInfo(sid: string): Record<string, unknown> {
    if (!this.approvalModes) return {};
    const mode = this.approvalModes[this.runtimeProfile.get(sid) ?? "default"] ?? "smart";
    return { approval_mode: mode, yolo: this.yoloFlags.has(sid) || mode === "off" };
  }

  reportApprovals(sid: string, approvals = this.approvalInfo(sid)) {
    this.event(sid, "session.info", { ...this.sessionModel.get(this.runtime.get(sid) ?? ""), ...approvals });
  }

  private setApprovals(id: number, key: "yolo" | "approvals.mode", value: string, sid: string | undefined, profile = "default") {
    if (this.managedKeys.has(key)) return this.fail(id, 4030, `${key} is managed by your administrator`);
    if (key === "yolo" && (!sid || !this.runtime.has(sid))) return this.fail(id, 4001, "session not found");
    if (key === "approvals.mode" && !["smart", "manual", "off"].includes(value)) return this.fail(id, 4002, `invalid approvals.mode: ${value}`);
    const before = sid ? this.approvalInfo(sid) : undefined;
    if (key === "yolo") {
      if (value === "on") this.yoloFlags.add(sid!);
      else this.yoloFlags.delete(sid!);
      this.reportApprovals(sid!);
    } else {
      this.approvalModes![profile] = value as ApprovalMode;
      for (const [rt, p] of this.runtimeProfile) if (p === profile) this.reportApprovals(rt);
    }
    if (this.staleInfoOnWrite && sid && before) this.reportApprovals(sid, before);
    this.respond(id, key === "yolo" ? { key, value: this.yoloFlags.has(sid!) ? "1" : "0", scope: "session" } : { key, value });
  }

  private displayAnswer(id: number, profile: unknown) {
    if (!this.display) return this.fail(id, -32601, "unknown method: display.status");
    const own = typeof profile === "string" ? this.display.profiles?.[profile] : undefined;
    this.respond(id, { ...this.display.status, ...own, lease: this.display.lease, profile_key: "/home/liam/.hermes" });
  }

  /** A session-less broadcast such as `sessions.changed` (tui_gateway `_broadcast_global_event`). */
  broadcast(type: string, payload: Record<string, unknown> = {}) {
    this.event("", type, payload);
  }

  /**
   * Asks the client something (`server_requests.send_async`) and returns the request's id. A connection that never
   * said it answers such requests is sent nothing, and the request fails at once. A request asked while the
   * connection is down stays open for the next resume.
   */
  ask(sid: string, method: string, params: Record<string, unknown>): string | undefined {
    if (!this.answersRequests) return undefined;
    const id = `srq-${(++this.asked).toString(16).padStart(12, "0")}`;
    this.openRequests.set(id, { sid, stored: this.runtime.get(sid)!, method, params });
    this.frame({ jsonrpc: "2.0", id, method, params: { session_id: sid, ...params } });
    return id;
  }

  /** An `approval` request as `server._approval_request_payload` renders it: the command redacted, the choices set. */
  askApproval(sid: string, over: Record<string, unknown> = {}) {
    const params = {
      request_id: `apr-${this.asked + 1}`,
      command: "rm -rf /var/log/old",
      description: "recursive delete",
      allow_session: true,
      allow_permanent: true,
      tool_name: "terminal",
      choices: ["once", "session", "always", "deny"],
      ...over,
    };
    return { id: this.ask(sid, "approval", params), requestId: params.request_id };
  }

  /** Hermes stops waiting for an answer (timeout, interrupt, answered elsewhere) and withdraws the request. */
  cancelRequest(id: string, reason: string) {
    const q = this.openRequests.get(id);
    if (!q) return;
    this.openRequests.delete(id);
    this.event(q.sid, "request.cancel", { id, method: q.method, reason });
  }

  /**
   * `liveSessions`, with every session that has a server→client request open listed as `waiting`, as
   * `_session_live_status` reports it, this connection's own sessions too; as `working` with `turnIsolation`.
   */
  private liveRows() {
    const asking = new Map([...this.openRequests.values()].map((q) => [q.sid, q.stored]));
    const status = this.turnIsolation ? "working" : "waiting";
    const rows = this.liveSessions.map((l) => (asking.has(l.id) ? { ...l, status } : l));
    for (const [sid, stored] of asking) if (!rows.some((l) => l.id === sid)) rows.push({ id: sid, session_key: stored, status, last_active: Date.now() / 1000 });
    return rows;
  }

  /**
   * Another Hermes client answers an open request. One that answers with `approval.respond` gets every client a
   * `request.cancel`; one that answers in a response frame, as an older client does, removes the request first, so
   * Hermes tells no other client (`server_requests.resolve_response`).
   */
  answerElsewhere(id: string, via: "approval.respond" | "response") {
    if (via === "approval.respond") return this.cancelRequest(id, "resolved");
    this.openRequests.delete(id);
  }

  drop(reason = "closed by the server (1006 )") {
    this.onEvent?.({ kind: "closed", reason });
  }

  last(method: string) {
    return [...this.requests].reverse().find((r) => r.method === method);
  }

  /** A profile's model, effort and fast mode as its config has them: Sonnet at medium effort unless a test set one. */
  /** What `session.branch` answers for a branch it made: on the profile's model, whatever the parent ran on. */
  private branchAnswer(stored: string, runtimeId: string, parent: string) {
    const history = this.transcripts[stored] ?? [];
    const title = [this.sessions, ...Object.values(this.otherProfiles)].flat().find((s) => s.id === stored)?.title ?? "";
    return { session_id: runtimeId, stored_session_id: stored, title, parent, message_count: history.length, messages: shownHistory(history), info: { ...this.sessionInfo, ...this.defaultModel() } };
  }

  defaultModel(profile?: string | null): ModelInfo {
    return this.profileModel[profile || "default"] ?? { model: "claude-sonnet-4-5", provider: "anthropic", reasoning_effort: "medium", fast: false };
  }

  /**
   * Stores a message in a session's history, as `session.resume` and the stored rows read it back. It gets the next
   * row id unless it brings one, and the time now.
   */
  storeMessage(stored: string, m: TranscriptMessage) {
    const row_id = m.row_id ?? Math.max(0, ...Object.values(this.transcripts).flat().map((t) => t.row_id ?? 0)) + 1;
    (this.transcripts[stored] ??= []).push({ timestamp: Math.floor(now()), ...m, row_id });
  }

  /** The runtime session id the server handed out for a stored session. */
  runtimeIdOf(stored: string) {
    return [...this.runtime].reverse().find(([, s]) => s === stored)?.[0];
  }

  /** Runs a projects method on the profile's projects; `fn` throws `[code, message]` to fail it. */
  private projectsOp(r: Request, fn: (list: FakeProject[]) => unknown) {
    const profile = (r.params.profile as string | undefined) || "default";
    if (!this.store(profile)) return this.fail(r.id, 4064, `Profile '${profile}' does not exist.`);
    try {
      this.respond(r.id, structuredClone(fn((this.projects[profile] ??= []))));
    } catch (e) {
      if (!Array.isArray(e)) throw e;
      this.fail(r.id, e[0], e[1]);
    }
  }

  /** A membership method on the profile's links; "method not found" on a server without the store. */
  private membershipOp(r: Request, fn: (profile: string, links: { project_id: string; session_id: string; added_at: number }[]) => unknown) {
    if (!this.membershipStore) return this.fail(r.id, -32601, `unknown method: ${r.method}`);
    if (this.membershipFails) return this.fail(r.id, 5061, this.membershipFails);
    this.projectsOp(r, () => {
      const profile = (r.params.profile as string | undefined) || "default";
      return fn(profile, (this.membership[profile] ??= []));
    });
  }

  /** A projects method on the one project `params.id` names, answering with it refreshed. */
  private projectOp(r: Request, fn: (p: FakeProject) => void) {
    this.projectsOp(r, (list) => {
      const p = list.find((q) => q.id === r.params.id || q.slug === r.params.id);
      if (!p) throw [5062, "no such project"];
      fn(p);
      return { project: p };
    });
  }

  private stat(path: string): LocalFile {
    const name = path.split("/").pop()!;
    const f = this.files[path];
    if (f === undefined) return { path, name, error: "No such file or directory (os error 2)" };
    if (typeof f === "object" && "dir" in f) return { path, name, error: "it's a folder" };
    return { path, name, size: typeof f === "string" ? f.length : f.size };
  }

  /** Every profile, default first. */
  private profileNames(): string[] {
    return ["default", ...Object.keys(this.otherProfiles)];
  }

  /**
   * One `profiles.list` row (`tui_gateway/methods_profiles.py` at `f0d94882`): `canonical_session` is the profile's row
   * titled "Bot Chat", found by title, null when none or when it is archived; `last_session` the newest visible one.
   */
  private profileRow(name: string): Record<string, unknown> {
    const meta = this.profileMeta[name] ?? {};
    const store = this.store(name) ?? [];
    const recent = (s: SessionRow) => s.last_active ?? s.started_at;
    const bot = store.find((s) => s.title === "Bot Chat" && !s.archived && !s.unlisted);
    const last = store.filter((s) => !s.hidden && !s.archived && !s.unlisted).sort((a, b) => recent(b) - recent(a))[0];
    const tip = bot?.listedAs?.id ?? bot?.id;
    // The preview is the tip's newest user or assistant message (`_latest_message_preview` on the tip).
    const transcript = bot ? (this.transcripts[tip!] ?? this.transcripts[bot.id] ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && (m.text ?? "").trim()) : [];
    const newest = transcript[transcript.length - 1]?.text?.replace(/\s+/g, " ").trim() ?? bot?.preview ?? "";
    const canonical = bot
      ? { id: bot.id, resolved_id: tip, root_title: "Bot Chat", title: bot.listedAs?.title ?? "Bot Chat", preview: newest.length > 80 ? `${newest.slice(0, 80)}...` : newest, started_at: bot.started_at, last_active: recent(bot), message_count: bot.message_count, live_message_count: transcript.length || bot.message_count }
      : null;
    return {
      name,
      path: name === "default" ? "/home/liam/.hermes" : `/home/liam/.hermes/profiles/${name}`,
      is_default: name === "default",
      model: null,
      provider: null,
      description: meta.description ?? "",
      display_name: meta.display_name ?? "",
      skill_count: 0,
      previous_names: [],
      last_session: last ? { id: last.id, title: last.title ?? "", preview: last.preview, started_at: last.started_at, last_active: recent(last), message_count: last.message_count } : null,
      worker_session: null,
      ...(this.botMode === "full" && { canonical_session: canonical }),
      ui_meta_revisions: meta.ui_meta ? { "hermes-bots": 1 } : {},
      ...(meta.ui_meta && { ui_meta: structuredClone(meta.ui_meta) }),
      has_avatar: name in this.botAvatars,
    };
  }

  /** A profile's stored sessions; no profile means the default one. Undefined for a profile the server doesn't have. */
  store(profile?: string | null): SessionRow[] | undefined {
    return !profile || profile === "default" ? this.sessions : this.otherProfiles[profile];
  }

  private storeOrFail(profile?: string | null): SessionRow[] {
    const store = this.store(profile);
    if (!store) throw new RestError(404, `{"detail":"Profile '${profile}' not found"}`);
    return store;
  }

  /**
   * `GET /api/sessions/{id}/messages` (`hermes_cli/web_routers/sessions.py` at the deployed `bf0203a`): stored rows,
   * `SELECT *` from `messages`, oldest first or `order=latest` newest first, a page of `limit` from `offset`. Only rows
   * with a stored id are there: a live session's unstored tail isn't.
   */
  private storedMessages(id: string, query: URLSearchParams) {
    if (this.messagesFailure) throw thrown(this.messagesFailure);
    const rows = (this.transcripts[id] ?? [])
      .filter((m) => m.row_id !== undefined && (!m.compacted || query.get("include_compacted") === "true"))
      .map((m) => ({
        id: m.row_id!,
        session_id: id,
        role: m.role,
        content: m.role === "tool" ? (m.result ?? m.content ?? null) : (m.text ?? m.content ?? null),
        tool_name: m.role === "tool" ? (m.name ?? null) : null,
        tool_call_id: m.tool_call_id ?? null,
        tool_calls: m.tool_calls === undefined ? null : JSON.stringify(m.tool_calls),
        timestamp: m.timestamp ?? null,
        display_kind: m.display_kind ?? null,
        active: m.compacted ? 0 : 1,
        compacted: m.compacted ? 1 : 0,
        _compressed_summary: m.summary ? 1 : null,
        message_uid: m.message_uid ?? `uid-${m.row_id}`,
      }));
    if (query.get("order") === "latest") rows.reverse();
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 100);
    return { session_id: id, profile: query.get("profile") ?? "default", messages: rows.slice(offset, offset + limit), pagination: {} };
  }

  /** `GET /api/sessions/{id}/mutation-snapshot` (`hermes_cli/web_routers/sessions.py` at the deployed `bf0203a`). */
  private mutationSnapshot(id: string, profile: string | null) {
    const s = this.storeOrFail(profile).find((r) => r.id === id);
    return { session_id: id, exists: !!s, runtime_revision: s?.runtime_revision ?? 0, runtime_generation: s ? (s.runtime_generation ?? 0) : null };
  }

  /** `GET /api/sessions/{id}` (`get_session_detail` at the deployed `bf0203a`): the raw row, its flags stored as 0/1. */
  private sessionDetail(id: string, profile: string | null) {
    const s = this.storeOrFail(profile).find((r) => r.id === id);
    if (!s) throw new RestError(404, `{"detail":"Session not found"}`);
    return { ...s, archived: s.archived ? 1 : 0, pinned: s.pinned ? 1 : 0, runtime_revision: s.runtime_revision ?? 0, profile: profile ?? "default" };
  }

  /**
   * `PATCH /api/sessions/{id}`, fenced like the deployed `bf0203a` (`_mutate_session_request`, `mutate_runtime_session`):
   * an edit without `request_id` and `expected_revision` is refused, and so is one naming an old revision.
   */
  private patchSession(id: string, body: Record<string, unknown>) {
    if (body.request_id === undefined && body.expected_revision === undefined)
      throw new RestError(409, `{"detail":"client_upgrade_required: this app is out of sync (different versions) with the Hermes backend; update the app to edit sessions"}`);
    if (body.request_id === undefined || body.expected_revision === undefined)
      throw new RestError(409, `{"detail":"mutation_identity_required"}`);
    const s = this.storeOrFail(body.profile as string | undefined).find((r) => r.id === id);
    if (!s || !EDITABLE_SOURCES.has(s.source)) throw new RestError(404, `{"detail":"not_found"}`);
    if (body.expected_revision !== (s.runtime_revision ?? 0)) throw new RestError(409, `{"detail":"revision_conflict"}`);
    s.runtime_revision = (s.runtime_revision ?? 0) + 1;
    if (typeof body.pinned === "boolean") s.pinned = body.pinned;
    if (typeof body.archived === "boolean") s.archived = body.archived;
    if (typeof body.unread === "boolean") s.last_read_at = body.unread ? 0 : now();
    if (typeof body.title === "string") {
      // `set_session_title`: titles are unique in a profile, and a clash is a 400 (`_mutate_session_request`).
      const title = body.title.trim();
      if (title && this.storeOrFail(body.profile as string | undefined).some((r) => r !== s && r.title === title))
        throw new RestError(400, `{"detail":"Title '${title}' is already in use by session ${id}"}`);
      s.title = title || null;
    }
    return { ok: true };
  }

  /** The answer to the next import is lost after Hermes wrote it, as when the connection drops (`sendImport`). */
  loseImportAnswer: boolean | number = false;

  /**
   * `POST /api/sessions/import`, as probed on the deployed `bf0203a` (ADR 0031): fenced on the first session's revision,
   * every session checked before anything is written (400 with each error), ids Hermes has skipped, and one receipt
   * per request id, so a retried request answers as the first did.
   */
  private importReceipts = new Map<string, unknown>();
  private importSessions(body: Record<string, unknown>) {
    if (body.request_id === undefined && body.expected_revision === undefined)
      throw new RestError(409, `{"detail":"client_upgrade_required: this app is out of sync (different versions) with the Hermes backend; update the app to edit sessions"}`);
    if (body.request_id === undefined || body.expected_revision === undefined) throw new RestError(409, `{"detail":"mutation_identity_required"}`);
    const store = this.storeOrFail(body.profile as string | undefined);
    const lose = () => {
      if (!this.loseImportAnswer) return;
      this.loseImportAnswer = typeof this.loseImportAnswer === "number" && this.loseImportAnswer > 1 ? this.loseImportAnswer - 1 : false;
      throw new Error("The connection to Hermes closed before it answered.");
    };
    const receipt = this.importReceipts.get(String(body.request_id));
    if (receipt) {
      lose();
      return receipt;
    }
    const sessions = body.sessions as Record<string, unknown>[];
    const errors = sessions.flatMap((raw, index) => {
      const bad = (raw.messages as Record<string, unknown>[]).findIndex((m) => typeof m.role !== "string" || !m.role);
      return bad < 0 ? [] : [{ index, error: `messages[${bad}].role must be a non-empty string`, session_id: raw.id }];
    });
    if (errors.length) throw new RestError(400, JSON.stringify({ detail: { errors } }));
    const anchor = store.find((r) => r.id === sessions[0]?.id);
    if (body.expected_revision !== (anchor?.runtime_revision ?? 0)) throw new RestError(409, `{"detail":"revision_conflict"}`);
    const imported: string[] = [];
    const skipped: string[] = [];
    // Titles are UNIQUE in a profile; an insert that breaks it rolls the whole import back as 503 (probed live).
    const fresh = sessions.filter((raw) => !store.some((r) => r.id === raw.id));
    const titles = fresh.map((raw) => raw.title).filter((t): t is string => typeof t === "string" && !!t);
    if (titles.some((t, i) => titles.indexOf(t) !== i || store.some((r) => r.title === t)))
      throw new RestError(503, `{"detail":"storage_unavailable"}`);
    for (const raw of sessions) {
      const id = String(raw.id);
      if (store.some((r) => r.id === id)) {
        skipped.push(id);
        continue;
      }
      const rows = raw.messages as Record<string, unknown>[];
      const started = typeof raw.started_at === "number" ? raw.started_at : now();
      const times = rows.map((m) => (typeof m.timestamp === "number" ? m.timestamp : now()));
      store.push(
        row(id, 0, {
          source: String(raw.source ?? "import"),
          title: typeof raw.title === "string" ? raw.title : null,
          started_at: started,
          last_active: Math.max(started, ...times),
          message_count: rows.length,
          runtime_revision: id === sessions[0].id ? 1 : 0,
        }),
      );
      // As `_history_to_messages` shows them: a tool row named by its call; stored output kept as `result`.
      const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
      this.transcripts[id] = rows.map((m, i): TranscriptMessage => {
        for (const c of (m.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined) ?? [])
          calls.set(c.id, { name: c.function.name, args: JSON.parse(c.function.arguments || "{}") });
        const call = calls.get(String(m.tool_call_id));
        const base = { timestamp: times[i], row_id: 10_000 + Object.keys(this.transcripts).length * 100 + i };
        return m.role === "tool"
          ? { ...base, role: "tool", tool_call_id: String(m.tool_call_id), name: call?.name ?? String(m.tool_name ?? "tool"), args: call?.args, result: String(m.content ?? "") }
          : {
              ...base,
              role: m.role as TranscriptMessage["role"],
              text: typeof m.content === "string" ? m.content : "",
              ...(typeof m.reasoning === "string" && { reasoning: m.reasoning }),
              ...(m.tool_calls !== undefined && { tool_calls: m.tool_calls }),
            };
      });
      imported.push(id);
    }
    const answer = { ok: true, session_id: sessions[0]?.id, revision: 1, operation: "import", imported: imported.length, skipped: skipped.length, imported_ids: imported, skipped_ids: skipped, detached: 0, errors: [] };
    this.importReceipts.set(String(body.request_id), answer);
    lose();
    return answer;
  }

  /**
   * `DELETE /api/sessions/{id}` (`delete_session_endpoint`), fenced like the deployed v0.22.6 `f0d9488` and checked
   * against a throwaway dashboard there: the query must name `request_id`, `expected_revision` and
   * `expected_generation`, or it is refused, each way as that dashboard refuses it. The row and its messages go for
   * good. A session already gone counts as deleted.
   */
  private deleteSession(id: string, query: URLSearchParams) {
    const [requestId, revision, generation] = ["request_id", "expected_revision", "expected_generation"].map((k) => query.get(k));
    if (requestId === null && revision === null && generation === null)
      throw new RestError(409, `{"detail":"client_upgrade_required: this app is out of sync (different versions) with the Hermes backend; update the app to edit sessions"}`);
    if (requestId === null || revision === null) throw new RestError(409, `{"detail":"mutation_identity_required"}`);
    if (generation === null) throw new RestError(400, `{"detail":"invalid_params"}`);
    const profile = query.get("profile");
    const store = this.storeOrFail(profile);
    const i = store.findIndex((r) => r.id === id);
    if (i < 0) return { ok: true, already_absent: true };
    if (Number(revision) !== (store[i].runtime_revision ?? 0)) throw new RestError(409, `{"detail":"revision_conflict"}`);
    if (Number(generation) !== (store[i].runtime_generation ?? 0)) throw new RestError(409, `{"detail":"stale_generation"}`);
    store.splice(i, 1);
    delete this.transcripts[id];
    // The contract removes a deleted chat's project links with it.
    const p = profile || "default";
    if (this.membership[p]) this.membership[p] = this.membership[p].filter((l) => l.session_id !== id);
    return { ok: true, deleted_ids: [id] };
  }

  /**
   * `POST /api/model/set` (`set_model_assignment`, `_apply_model_assignment_sync` at the deployed `bf0203a`). A main
   * model Hermes prices above its safety threshold isn't written: it answers `confirm_required` until the request
   * carries `confirm_expensive_model`.
   */
  private setModel(body: Record<string, unknown>) {
    const text = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
    const [scope, provider, model, task] = [text("scope").toLowerCase(), text("provider"), text("model"), text("task")];
    if (scope !== "main" && scope !== "auxiliary") throw new RestError(400, `{"detail":"scope must be 'main' or 'auxiliary'"}`);
    const priced = this.modelConfig.expensive[`${provider}/${model}`];
    if (model && priced && body.confirm_expensive_model !== true)
      return {
        ok: false,
        scope,
        provider,
        model,
        confirm_required: true,
        confirm_message: [`${model} has known pricing above Hermes' safety threshold.`, `Input tokens: $${priced[0].toFixed(2)}/M`, `Output tokens: $${priced[1].toFixed(2)}/M`, "Pricing source: models.dev."].join("\n"),
      };
    if (scope === "main") {
      if (!provider || !model) throw new RestError(400, `{"detail":"provider and model required for main"}`);
      this.modelConfig.model = { provider, default: model };
      return { ok: true, scope, provider, model, base_url: "", gateway_tools: [], stale_aux: [] };
    }
    if (!provider) throw new RestError(400, `{"detail":"provider required for auxiliary"}`);
    const slot = this.modelConfig.auxiliary[task];
    if (!slot) throw new RestError(400, `{"detail":"unknown auxiliary task: ${task}"}`);
    const effort = body.reasoning_effort;
    if (typeof effort === "string" && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort))
      throw new RestError(400, `{"detail":"reasoning_effort must be one of: none, minimal, low, medium, high, xhigh, max, ultra"}`);
    if (provider.toLowerCase() !== slot.provider.toLowerCase()) delete slot.base_url;
    slot.provider = provider;
    slot.model = model;
    if (effort === null) delete slot.reasoning_effort;
    else if (typeof effort === "string") slot.reasoning_effort = effort;
    return { ok: true, scope, tasks: [task], provider, model, ...("reasoning_effort" in body ? { reasoning_effort: effort } : {}) };
  }

  private frame(f: unknown) {
    this.raw(JSON.stringify(f));
  }

  /** Sends the client one frame as it is, so a test can send a malformed or out-of-spec one. */
  raw(text: string) {
    this.onEvent?.({ kind: "frame", text });
  }
}

/** A model catalog row (`model.options` → `providers[]`), trimmed to what Settings → Model reads. */
export type FakeProvider = { slug: string; name: string; models: string[]; capabilities: Record<string, { fast: boolean; reasoning: boolean }>; api_url?: string };
export type FakeAuxSlot = { provider: string; model: string; base_url?: string; reasoning_effort?: string };
export type FakeModelConfig = {
  model: { provider: string; default: string };
  agent: { reasoning_effort: string; service_tier: string };
  /** `delegation` as `GET /api/config` returns it, defaults filled in. */
  delegation: Record<string, unknown>;
  auxiliary: Record<string, FakeAuxSlot>;
  catalog: FakeProvider[];
  /** "provider/model" -> [input, output] $ per million tokens, for models priced above Hermes's threshold. */
  expensive: Record<string, [number, number]>;
  /** `delegation.backends.model_map.options`. */
  modelMap: Record<string, unknown>[];
};

const caps = (models: string[], fast: string[] = []) => Object.fromEntries(models.map((m) => [m, { fast: fast.includes(m), reasoning: true }]));

/** A profile set up like the owner's: OpenRouter for the main model, helper tasks pinned to cheap OpenRouter models. */
export function fakeModelConfig(): FakeModelConfig {
  const openrouter = ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "google/gemini-3.7-flash", "anthropic/claude-fable-5.1"];
  const nous = ["hermes-5-405b", "hermes-5-70b", "anthropic/claude-fable-5.1"];
  const codex = ["gpt-6.1-sol", "gpt-6.1-mini"];
  return {
    model: { provider: "openrouter", default: "z-ai/glm-5.3-flash" },
    agent: { reasoning_effort: "high", service_tier: "normal" },
    delegation: { provider: "", model: "", base_url: "", max_iterations: 50, max_concurrent_children: 3, child_timeout_seconds: 0, reasoning_effort: "" },
    auxiliary: {
      title_generation: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
      compression: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
      vision: { provider: "openrouter", model: "google/gemini-3.7-flash" },
      approval: { provider: "auto", model: "", reasoning_effort: "none" },
      review: { provider: "auto", model: "" },
    },
    catalog: [
      { slug: "openrouter", name: "OpenRouter", models: openrouter, capabilities: caps(openrouter) },
      { slug: "nous", name: "Nous Portal", models: nous, capabilities: caps(nous) },
      { slug: "openai-codex", name: "ChatGPT or Codex Subscription", models: codex, capabilities: caps(codex, ["gpt-6.1-sol"]) },
    ],
    expensive: { "openrouter/anthropic/claude-fable-5.1": [30, 150], "nous/anthropic/claude-fable-5.1": [30, 150] },
    modelMap: [],
  };
}

/** `SessionDB.session_unread`: activity postdates the read watermark, and `null` means read. */
export function unread(s: SessionRow): boolean {
  return s.last_read_at !== null && (s.last_active ?? s.started_at) > s.last_read_at;
}

/** `tui_gateway/prompt_attachments.py::_format_ref_value`: quote a ref with whitespace, brackets or quotes. */
function formatRefValue(value: string): string {
  if (!/[\s()[\]{}<>"'`]/.test(value)) return value;
  const q = ["`", '"', "'"].find((q) => !value.includes(q));
  return q ? `${q}${value}${q}` : value;
}

/**
 * A configurable toolset as `GET /api/tools/toolsets` lists it at the deployed `bf0203a` (`CONFIGURABLE_TOOLSETS`,
 * labels through `gui_toolset_label`). `installs`: a provider `post_setup` the toolset still needs, which turning it on
 * starts in the background (`toggle_toolset`'s install-on-enable).
 */
export type FakeToolset = {
  name: string;
  label: string;
  description: string;
  platform: string;
  platform_label: string;
  configured: boolean;
  tools: string[];
  installs?: string;
};

export function fakeToolsets(): FakeToolset[] {
  const cli = { platform: "cli", platform_label: "CLI", configured: true };
  return [
    { name: "web", label: "Web Search & Scraping", description: "web_search, web_extract", ...cli, tools: ["web_extract", "web_search"] },
    { name: "terminal", label: "Terminal & Processes", description: "terminal, process", ...cli, tools: ["process", "terminal"] },
    { name: "file", label: "File Operations", description: "read, write, patch, search", ...cli, tools: ["patch", "read_file", "search_files", "write_file"] },
    { name: "image_gen", label: "Image Generation", description: "image_generate", ...cli, configured: false, tools: ["image_generate"] },
    { name: "stt", label: "Speech-to-Text", description: "voice transcription (gateway voice messages + voice mode)", ...cli, tools: [] },
    { name: "discord", label: "Discord (read/participate)", description: "fetch messages, search members, create thread", platform: "discord", platform_label: "Discord", configured: true, tools: ["discord_fetch"] },
    { name: "computer_use", label: "Computer Use (macOS/Windows/Linux)", description: "background desktop control via cua-driver", ...cli, tools: ["computer_use"], installs: "cua_driver" },
  ];
}

/** A job row in a fake `jobs.json`, in the shape the dashboard sends. */
export type CronRow = Record<string, unknown> & { id: string; enabled: boolean; state: string };

/**
 * The fake's scheduled jobs. Like Hermes, a per-job route given a profile that doesn't hold the job acts on the
 * profile that does (`_job_owner_profile`), a paused job keeps its stale `next_run_at`, and running a paused job
 * resumes it. `failNext` makes the next matching write fail the way a lost answer does: before Hermes saw it, or after
 * it saved.
 */
export class FakeCron {
  jobs: Record<string, CronRow[]> = { default: [] };
  timezone = "America/Chicago";
  targets = [
    { id: "local", name: "Local (save only)", home_target_set: true, home_env_var: null },
    { id: "telegram", name: "Telegram", home_target_set: true, home_env_var: "TELEGRAM_HOME_CHANNEL" },
    { id: "discord", name: "Discord", home_target_set: false, home_env_var: "DISCORD_HOME_CHANNEL" },
  ];
  runs: Record<string, Record<string, unknown>[]> = {};
  /** The newest `executions` row per job id, which the list stamps as `latest_execution` (null when none). */
  executions: Record<string, Record<string, unknown>> = {};
  /** No session store yet: the runs route answers 503, as on a profile whose gateway never started. */
  runsUnavailable = false;
  heartbeat: number | null = 14;
  /** `last_status` a manual run ends with. */
  runStatus = "ok";
  /** No `/api/cron/*` routes at all, as on an old server. */
  missing = false;
  now = () => Date.now();
  /** The next write whose "METHOD /path" matches fails: `before` it reaches Hermes, or `after` Hermes saved it. */
  failNext?: { match: RegExp; when: "before" | "after"; message?: string | Error };
  /** Reads of the job list that fail from now on, as a dropped connection does. */
  failLists = 0;
  /** Calls the next write waits for before it is handled. */
  gate?: Promise<void>;
  /** Reads of the job list wait for this before they are answered, as a slow server does. */
  listGate?: Promise<void>;
  private seq = 0;

  constructor(private server: FakeHermes) {}

  /** A job in `profile`, made the way `create_job` does from these fields. */
  add(profile: string, fields: Record<string, unknown> & { schedule: string }): CronRow {
    const zone = this.zoneOf(profile);
    const now = this.now();
    const s = parseSchedule(fields.schedule, zone, now);
    const paused = fields.paused === true;
    const id = (fields.id as string) ?? `${(++this.seq).toString(16).padStart(4, "0")}feed0000`.slice(0, 12);
    const stamp = isoIn(zone, now);
    const row: CronRow = {
      id,
      name: (fields.name as string) || String(fields.prompt ?? "").slice(0, 50).trim(),
      prompt: fields.prompt ?? "",
      skills: [],
      skill: null,
      model: null,
      provider: null,
      script: fields.script ?? null,
      no_agent: fields.no_agent === true,
      schedule: s.kind === "cron" ? { kind: "cron", expr: s.expr, display: s.display } : s.kind === "interval" ? { kind: "interval", minutes: s.minutes, display: s.display } : { kind: "once", run_at: isoIn(zone, s.runAt), display: s.display },
      schedule_display: s.display,
      repeat: { times: typeof fields.repeat === "number" ? fields.repeat : s.kind === "once" ? 1 : null, completed: 0 },
      enabled: !paused,
      state: paused ? "paused" : "scheduled",
      paused_at: paused ? stamp : null,
      paused_reason: paused ? "Created paused; awaiting operator approval." : null,
      created_at: stamp,
      next_run_at: paused ? null : this.next(s, zone, now),
      last_run_at: null,
      last_status: null,
      last_error: null,
      last_delivery_error: null,
      deliver: (fields.deliver as string) || "local",
      origin: null,
      enabled_toolsets: null,
      workdir: fields.workdir ?? null,
      ...Object.fromEntries(Object.entries(fields).filter(([k]) => ["model", "provider", "skills"].includes(k))),
    };
    (this.jobs[profile] ??= []).push(row);
    return row;
  }

  /** A profile's own `timezone` setting, where it differs from `timezone` ("" for none). */
  timezones: Record<string, string> = {};

  /** The profile's `timezone` in its config.yaml, "" when it has none. */
  zoneSetting(profile: string): string {
    return profile in this.timezones ? this.timezones[profile] : this.timezone;
  }

  private zoneOf(profile: string) {
    return this.zoneSetting(profile) || "UTC";
  }

  private next(s: ReturnType<typeof parseSchedule>, zone: string, from: number): string | null {
    const at = upcomingRuns(s, zone, from, 1)?.[0];
    return at === undefined ? null : isoIn(zone, at);
  }

  private stamp(profile: string, row: CronRow) {
    return { ...structuredClone(row), profile, profile_name: profile, hermes_home: `/home/liam/.hermes${profile === "default" ? "" : `/profiles/${profile}`}`, is_default_profile: profile === "default", scheduler_heartbeat_age_s: this.heartbeat, latest_execution: this.executions[row.id] ?? null };
  }

  private refuse(status: number, detail: unknown): never {
    throw new RestError(status, JSON.stringify({ detail }));
  }

  private profile(query: URLSearchParams): string {
    const p = query.get("profile") ?? "default";
    if (!(p in this.jobs) && p !== "default" && !(p in this.server.otherProfiles)) this.refuse(404, `Profile '${p}' does not exist.`);
    return p;
  }

  /** `_job_owner_profile`: the named profile if it holds the job, else whichever profile does. */
  private owner(id: string, hint: string): [string, CronRow] {
    for (const p of [hint, ...Object.keys(this.jobs)]) {
      const row = this.jobs[p]?.find((j) => j.id === id);
      if (row) return [p, row];
    }
    this.refuse(404, "Job not found");
  }

  /** A cron route's handler for `req`, or undefined if it isn't one. */
  route(req: RestRequest): (() => unknown) | undefined {
    const m = /^\/api\/cron\/(jobs|delivery-targets)(?:\/([^/]+))?(?:\/(runs|pause|resume|trigger))?$/.exec(req.path);
    if (!m) return undefined;
    if (this.missing) return () => this.refuse(404, "Not Found");
    const [, what, rawId, action] = m;
    const id = rawId && decodeURIComponent(rawId);
    const key = `${req.method} ${what}${id ? "/:id" : ""}${action ? `/${action}` : ""}`;
    const write = req.method !== "GET";
    return async () => {
      if (write) await this.gate;
      if (!write && what === "jobs" && !id) await this.listGate;
      const fail = write && this.failNext?.match.test(`${req.method} ${req.path}`) ? this.failNext : undefined;
      if (fail) this.failNext = undefined;
      if (fail?.when === "before") throw thrown(fail.message ?? "Can't reach the Hermes dashboard: error sending request");
      if (!write && what === "jobs" && !id && this.failLists > 0) {
        this.failLists--;
        throw new Error("Can't reach the Hermes dashboard: connection reset");
      }
      const answer = this.handle(key, req, id);
      if (fail) throw thrown(fail.message ?? "Can't reach the Hermes dashboard: connection closed before message completed");
      return answer;
    };
  }

  private handle(key: string, req: RestRequest, id?: string): unknown {
    const profile = this.profile(req.query);
    const zone = this.zoneOf(profile);
    const now = this.now();
    switch (key) {
      case "GET jobs":
        return (this.jobs[profile] ?? []).map((j) => this.stamp(profile, j));
      case "GET delivery-targets":
        return { targets: this.targets };
      case "POST jobs": {
        const body = req.body ?? {};
        if (typeof body.schedule !== "string") this.refuse(422, [{ msg: "Field required" }]);
        if (!String(body.prompt ?? "").trim() && !body.script) this.refuse(400, "A cron job needs a prompt, a script or a skill.");
        try {
          return this.stamp(profile, this.add(profile, body as { schedule: string }));
        } catch (e) {
          if (e instanceof ScheduleError) this.refuse(400, e.message);
          throw e;
        }
      }
    }
    const [owner, row] = this.owner(id!, profile);
    switch (key) {
      case "GET jobs/:id":
        return this.stamp(owner, row);
      case "GET jobs/:id/runs":
        if (this.runsUnavailable) this.refuse(503, "Session store is not initialized. Start this profile's gateway to initialize it.");
      {
        // `_list_cron_job_runs_sync`: the newest `limit` (1 to 100, else 20), and no offset.
        const asked = Number(req.query.get("limit") ?? 20);
        const limit = Number.isFinite(asked) ? Math.max(1, Math.min(Math.trunc(asked), 100)) : 20;
        return { runs: (this.runs[row.id] ?? []).slice(0, limit), limit };
      }
      case "PUT jobs/:id": {
        const updates = (req.body?.updates ?? {}) as Record<string, unknown>;
        if ("schedule" in updates) {
          let s;
          try {
            s = parseSchedule(String(updates.schedule), zone, now);
          } catch (e) {
            this.refuse(400, (e as Error).message);
          }
          row.schedule = s.kind === "cron" ? { kind: "cron", expr: s.expr, display: s.display } : s.kind === "interval" ? { kind: "interval", minutes: s.minutes, display: s.display } : { kind: "once", run_at: isoIn(zone, s.runAt), display: s.display };
          row.schedule_display = s.display;
          if (row.state !== "paused") row.next_run_at = this.next(s, zone, now);
        }
        for (const k of ["name", "prompt", "deliver"]) if (k in updates) row[k] = updates[k];
        if ("repeat" in updates) row.repeat = { times: updates.repeat === "forever" ? null : Number(updates.repeat), completed: (row.repeat as { completed: number }).completed };
        return this.stamp(owner, row);
      }
      case "POST jobs/:id/pause":
        Object.assign(row, { enabled: false, state: "paused", paused_at: isoIn(zone, now) });
        return this.stamp(owner, row);
      case "POST jobs/:id/resume": {
        const s = parseSchedule(String(row.schedule_display), zone, now);
        Object.assign(row, { enabled: true, state: "scheduled", paused_at: null, paused_reason: null, next_run_at: this.next(s, zone, now) });
        return this.stamp(owner, row);
      }
      case "POST jobs/:id/trigger": {
        const stamp = isoIn(zone, now);
        Object.assign(row, { enabled: true, state: "scheduled", paused_at: null, last_run_at: stamp, last_status: this.runStatus, last_error: this.runStatus === "error" ? "The fixture failed." : null });
        return this.stamp(owner, row);
      }
      case "DELETE jobs/:id":
        this.jobs[owner] = this.jobs[owner].filter((j) => j !== row);
        return { ok: true };
    }
    this.refuse(405, "Method Not Allowed");
  }
}

/** A webhook route as Hermes keeps it in `webhook_subscriptions.json`. */
export type WebhookRoute = Record<string, unknown> & { secret?: string; secret_env?: string; enabled?: boolean };

/**
 * Hermes's `/api/webhooks*` routes (`hermes_cli/web_routers/ops.py`): as the deployed `bf0203a` has them when
 * `contract` is false, and with the `webhooks/1` additions (docs/design/webhook-automations.md) when it is true.
 */
export class FakeWebhooks {
  contract = true;
  platformEnabled = true;
  baseUrl = "http://127.0.0.1:8644";
  routes: Record<string, Record<string, WebhookRoute>> = { default: {} };
  /** Ledger rows per profile and route, newest first, in the wire shape of `GET …/deliveries`. */
  deliveries: Record<string, Record<string, Record<string, unknown>[]>> = {};
  rejections: Record<string, Record<string, Record<string, { count: number; last_at: number }>>> = {};
  /** Every retry Hermes took: the key and whether side effects were confirmed. */
  retries: { profile: string; name: string; deliveryId: string; key: string; confirmed: boolean }[] = [];
  /** The next write whose "METHOD /path" matches fails: `before` it reaches Hermes, or `after` Hermes did it. */
  failNext?: { match: RegExp; when: "before" | "after"; message?: string | Error };
  /** Answers waiting on this before a write is handled. */
  gate?: Promise<void>;
  private secrets = 0;
  private now = () => Date.now() / 1000;

  private refuse(status: number, detail: unknown): never {
    throw new RestError(status, JSON.stringify({ detail }));
  }

  revision(r: WebhookRoute): string {
    const { secret, ...rest } = r;
    return `r${Array.from(JSON.stringify({ ...rest, s: secret ?? "" })).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;
  }

  summary(profile: string, name: string, r: WebhookRoute): Record<string, unknown> {
    const base = {
      name, description: r.description ?? "", events: r.events ?? [], deliver: r.deliver ?? "log", deliver_only: !!r.deliver_only, prompt: r.prompt ?? "",
      script: r.script ?? "", skills: r.skills ?? [], created_at: r.created_at ?? null, url: `${this.baseUrl}/webhooks/${name}`,
      secret_set: !!r.secret || !!r.secret_env, enabled: r.enabled !== false,
    };
    if (!this.contract) return base;
    const rows = this.deliveries[profile]?.[name] ?? [];
    return {
      ...base, provider: r.provider ?? "", filters: r.filters ?? [], coalesce: r.coalesce ?? null, profile: "default",
      secret_ref: r.secret_env ? `env:${r.secret_env}` : r.secret ? "stored" : "", secret_env_set: r.secret_env ? r.secret_env === "GITHUB_WEBHOOK_SECRET" : null,
      deliver_chat_id: (r.deliver_extra as Record<string, unknown> | undefined)?.chat_id ?? null, kind: r.cron_job ? "cron_job" : r.deliver_only ? "deliver_only" : "agent",
      revision: this.revision(r), last_received_at: rows[0]?.received_at ?? null, rejections: this.rejections[profile]?.[name] ?? {},
    };
  }

  /** A route made as Hermes's create makes one; returns its secret. */
  add(profile: string, name: string, fields: Record<string, unknown> = {}): string {
    const secret = `fixture-secret-${++this.secrets}`;
    (this.routes[profile] ??= {})[name] = { description: "Dashboard-created subscription", events: [], prompt: "", skills: [], deliver: "log", created_at: "2026-11-03T15:58:24Z", secret, ...fields };
    return secret;
  }

  /** A delivery in the ledger, newest first. */
  addDelivery(profile: string, name: string, row: Record<string, unknown>) {
    const rows = ((this.deliveries[profile] ??= {})[name] ??= []);
    rows.unshift({ event: "issues", action: "opened", received_at: this.now(), updated_at: this.now(), state: "queued", reason: null, session_id: null, outcome: null, duplicates: 0, retry_of: null, excerpt: {}, retryable: false, retry_needs_confirmation: false, ...row });
  }

  route(req: RestRequest): (() => unknown) | undefined {
    const m = /^\/api\/webhooks(?:\/([^/]+))?(?:\/(enabled|deliveries))?(?:\/([^/]+)\/retry)?$/.exec(req.path);
    if (!m) return undefined;
    const [, rawName, sub, rawDelivery] = m;
    const name = rawName && decodeURIComponent(rawName);
    const delivery = rawDelivery && decodeURIComponent(rawDelivery);
    const profile = req.query.get("profile") ?? "default";
    const write = req.method !== "GET";
    return async () => {
      if (write) await this.gate;
      const fail = write && this.failNext?.match.test(`${req.method} ${req.path}`) ? this.failNext : undefined;
      if (fail) this.failNext = undefined;
      if (fail?.when === "before") throw thrown(fail.message ?? "Can't reach the Hermes dashboard: error sending request");
      const answer = this.handle(req, profile, name, sub, delivery);
      if (fail) throw thrown(fail.message ?? "Can't reach the Hermes dashboard: connection closed before message completed");
      return answer;
    };
  }

  private handle(req: RestRequest, profile: string, name?: string, sub?: string, delivery?: string): unknown {
    const routes = (this.routes[profile] ??= {});
    const body = req.body ?? {};
    const notFound = () => this.refuse(404, "Not Found");
    const known = () => (name && routes[name] ? routes[name] : this.refuse(404, `No subscription named '${name}'`));
    if (req.method === "GET" && !name)
      return {
        enabled: this.platformEnabled, base_url: this.baseUrl,
        ...(this.contract && { contract: "webhooks/1", providers: ["github"], limits: { retention_seconds: 604800, max_rows_per_route: 1000, max_body_bytes: 1048576, rate_limit_per_minute: 30, signed_timestamp_window_seconds: 300 } }),
        subscriptions: Object.entries(routes).map(([n, r]) => this.summary(profile, n, r)),
      };
    if (req.method === "POST" && !name) {
      if (!this.platformEnabled) this.refuse(400, "Webhook platform is not enabled. Enable it from the Webhooks page first.");
      const n = String(body.name ?? "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(n)) this.refuse(400, "Invalid name. Use lowercase alphanumeric with hyphens/underscores.");
      if (this.contract && body.create_only && routes[n]) this.refuse(409, `A route named '${n}' already exists.`);
      const secret = this.contract && body.secret_env ? undefined : `fixture-secret-${++this.secrets}`;
      const was = routes[n];
      const r: WebhookRoute = {
        description: body.description ?? `Dashboard-created subscription: ${n}`, events: body.events ?? [], prompt: body.prompt ?? "", skills: body.skills ?? [],
        deliver: body.deliver ?? "log", created_at: "2026-11-03T16:00:00Z",
        ...(secret ? { secret } : { secret_env: body.secret_env as string }),
        ...(body.script ? { script: body.script } : {}),
        ...(body.deliver_chat_id ? { deliver_extra: { chat_id: body.deliver_chat_id } } : {}),
        ...(this.contract && body.provider ? { provider: body.provider } : {}),
        ...(this.contract && Array.isArray(body.filters) && body.filters.length ? { filters: body.filters } : {}),
        ...(this.contract && body.coalesce ? { coalesce: body.coalesce } : {}),
        ...((this.contract && body.enabled === false) || was?.enabled === false ? { enabled: false } : {}),
      };
      routes[n] = r;
      return { ...this.summary(profile, n, r), ...(secret && { secret }) };
    }
    if (req.method === "PUT" && name && !sub) {
      if (!this.contract) this.refuse(405, "Method Not Allowed");
      const r = known();
      if (body.revision !== this.revision(r)) this.refuse(409, { message: "This route was changed since it was read.", current: this.summary(profile, name, r) });
      const next: WebhookRoute = { ...r };
      for (const k of ["description", "prompt", "deliver", "events", "skills", "provider"]) if (body[k] !== undefined && body[k] !== null) next[k] = body[k];
      for (const k of ["filters", "coalesce"]) if (body[k] !== undefined && body[k] !== null) (Array.isArray(body[k]) ? (body[k] as unknown[]).length : Object.keys(body[k] as object).length) ? (next[k] = body[k]) : delete next[k];
      let secret: string | undefined;
      if (body.secret_env) {
        next.secret_env = body.secret_env as string;
        delete next.secret;
      } else if (body.secret_env === "" && next.secret_env) {
        delete next.secret_env;
        secret = next.secret = `fixture-secret-${++this.secrets}`;
      } else if (body.rotate_secret && !next.secret_env) secret = next.secret = `fixture-secret-${++this.secrets}`;
      routes[name] = next;
      return { ...this.summary(profile, name, next), ...(secret && { secret }) };
    }
    if (req.method === "PUT" && sub === "enabled") {
      known().enabled = body.enabled === true;
      return { ok: true, name, enabled: body.enabled === true };
    }
    if (req.method === "DELETE" && name && !sub) {
      known();
      delete routes[name];
      if (this.deliveries[profile]) delete this.deliveries[profile][name];
      return { ok: true };
    }
    if (req.method === "GET" && sub === "deliveries" && !delivery) {
      if (!this.contract) notFound();
      known();
      const limit = Number(req.query.get("limit") ?? 50);
      const before = Number(req.query.get("before") ?? Infinity);
      const rows = (this.deliveries[profile]?.[name!] ?? []).filter((d) => (d.received_at as number) < before).slice(0, limit);
      return { route: name, contract: "webhooks/1", enabled: routes[name!].enabled !== false, deliveries: rows, rejections: this.rejections[profile]?.[name!] ?? {}, next_before: rows.length >= limit ? rows.at(-1)!.received_at : null, limits: { retention_seconds: 604800, max_rows_per_route: 1000, max_body_bytes: 1048576, rate_limit_per_minute: 30, signed_timestamp_window_seconds: 300 } };
    }
    if (req.method === "POST" && sub === "deliveries" && delivery) {
      if (!this.contract) notFound();
      const r = known();
      const key = String(body.idempotency_key ?? "");
      const rows = this.deliveries[profile]?.[name!] ?? [];
      const same = rows.find((d) => d.idempotency_key === key);
      if (same) return { status: "already_sent", delivery_id: same.delivery_id };
      const row = rows.find((d) => d.delivery_id === delivery);
      if (!row) this.refuse(404, "No such delivery in this route's history.");
      if (r.enabled === false) this.refuse(409, { code: "paused", message: "The route is paused. Resume it to retry." });
      if (!row.retryable) this.refuse(409, { code: "not_retryable", message: `Only a failed delivery can be retried; this one is ${row.state}.` });
      if (row.retry_needs_confirmation && body.confirm_side_effects !== true) this.refuse(409, { code: "needs_confirmation", message: "The failed attempt had started, so its tools may have acted. Confirm to run it again." });
      const id = `${row.retry_of ?? row.delivery_id}~retry~${key}`;
      this.retries.push({ profile, name: name!, deliveryId: delivery, key, confirmed: body.confirm_side_effects === true });
      this.addDelivery(profile, name!, { delivery_id: id, retry_of: row.retry_of ?? row.delivery_id, idempotency_key: key, event: row.event, action: row.action, excerpt: row.excerpt, state: "queued" });
      row.retryable = false;
      return { status: "accepted", delivery_id: id, route: name, gateway_status: 202 };
    }
    return notFound();
  }
}

/** A task row as the kanban plugin stores and lists it, as far as this app reads it. Times are Unix seconds. */
export type KanbanRow = {
  id: string;
  board: string;
  status: string;
  title: string;
  assignee: string | null;
  session_id: string | null;
  created_at: number;
  started_at: number | null;
  current_run_id: string | null;
  subscribed: boolean;
  runs: { id: string; status: string }[];
};

const KANBAN_COLUMNS = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];
/**
 * The notice Hermes's poller sends for a task's move, after `[board] @assignee Kanban <id>`, by the status it moved to
 * (`_KANBAN_EVENT_FORMATTERS` in `tui_gateway/session_notifications.py` at v0.22.7). Archiving sends none, so no wake.
 */
const KANBAN_NOTICES: Record<string, (t: KanbanRow) => [glyph: string, said: string]> = {
  done: (t) => ["✔", `done — ${t.title}`],
  blocked: () => ["⏸", "blocked"],
  review: () => ["🔄", "→ review"],
};

/**
 * The kanban plugin's REST (`GET /api/plugins/kanban/boards`, `board?board=`, `tasks/{id}?board=`) over in-memory
 * boards, and its poller's wakes: `move` changes a task's status as a worker or the owner would, and the chat that
 * created it, when live and subscribed, hears a `status.update` and then a new turn, as Hermes starts one when no
 * turn is running. `dispatchReply` is the reply a `kanban_create` prompt gets.
 */
export class FakeKanban {
  boards: Record<string, { name: string; tasks: KanbanRow[] }> = { default: { name: "Default", tasks: [] } };
  current = "default";
  /** No kanban plugin: every route answers 404 Not Found. */
  missing = false;
  /** How long after a task moves the poller wakes its chat. */
  wakeDelayMs = 0;
  /** How the wake turn is sent: at once in one go unless set, as the stand-in streams it (bridge.ts). `userRowId`: the stored notice that began it. */
  wakeWith?: (runtimeId: string, stored: string, text: string, userRowId: number) => void;
  private seq = 0;
  private runSeq = 0;

  constructor(private server: FakeHermes) {}

  /** A task on `board`, made the way `kanban_create` makes one. */
  add(board: string, fields: Partial<KanbanRow> & { title: string }): KanbanRow {
    const row: KanbanRow = { id: `t_${(++this.seq).toString(16).padStart(8, "0")}`, board, status: "ready", assignee: null, session_id: null, created_at: Math.floor(now()), started_at: null, current_run_id: null, subscribed: true, runs: [], ...fields };
    (this.boards[board] ??= { name: board, tasks: [] }).tasks.push(row);
    return row;
  }

  find(id: string): KanbanRow | undefined {
    return Object.values(this.boards).flatMap((b) => b.tasks).find((t) => t.id === id);
  }

  /** Deletes the task, as the owner would on the board. */
  remove(id: string) {
    for (const b of Object.values(this.boards)) b.tasks = b.tasks.filter((t) => t.id !== id);
  }

  /** Moves the task to `status`, with a run when a worker picks it up, and wakes its chat as Hermes's poller does. */
  move(id: string, status: string): boolean {
    const t = this.find(id);
    if (!t) return false;
    t.status = status;
    if (status === "running" && !t.started_at) {
      t.started_at = Math.floor(now());
      t.current_run_id = `run_${++this.runSeq}`;
      t.runs.push({ id: t.current_run_id, status: "running" });
    }
    if (status === "done" || status === "blocked" || status === "review" || status === "archived") t.current_run_id = null;
    const notice = KANBAN_NOTICES[status]?.(t);
    const runtime = t.session_id ? this.server.runtimeIdOf(t.session_id) : undefined;
    if (!notice || !runtime) return true;
    const [glyph, said] = notice;
    const noticeText = `${glyph} [${t.board}] ${t.assignee ? `@${t.assignee} ` : ""}Kanban ${t.id} ${said}`;
    this.server.event(runtime, "status.update", { kind: "process", text: noticeText });
    // The wake turn's prompt is the notice itself, stored as a user row as its turn starts; its `message.start` carries
    // only the turn's id (`_notif_poll_kanban_scoped` → `_run_prompt_submit`).
    const wake = () => {
      if (!t.subscribed || this.server.turns.has(runtime) || this.server.stopped.has(runtime) || !t.session_id) return;
      this.server.storeMessage(t.session_id, { role: "user", text: noticeText });
      const user_row_id = this.server.transcripts[t.session_id].at(-1)!.row_id!;
      const text = `Results are in for ${t.id} (${status}): ${t.title}. Here is the synthesis.`;
      if (this.wakeWith) return this.wakeWith(runtime, t.session_id, text, user_row_id);
      this.server.event(runtime, "message.start", { turn_id: `wake-${t.id}` });
      this.server.event(runtime, "message.delta", { text });
      this.server.storeMessage(t.session_id, { role: "assistant", text });
      this.server.event(runtime, "message.complete", { text, status: "complete", persisted_turn: { user_row_id } });
    };
    setTimeout(wake, this.wakeDelayMs);
    return true;
  }

  /** The reply to a prompt that dispatches: a `kanban_create` call with Hermes's result shape, a word about it, and the turn's end. */
  dispatchReply(runtimeId: string, stored: string, prompt: string) {
    const title = prompt.replace(/dispatch/i, "").trim() || "Research task";
    const task = this.add(this.current, { title, assignee: "researcher", session_id: stored });
    const tool_id = `kc-${task.id}`;
    const args = { title, assignee: "researcher" };
    this.server.event(runtimeId, "message.start");
    this.server.event(runtimeId, "tool.start", { tool_id, name: "kanban_create", args, preview: title });
    const result = { ok: true, task_id: task.id, status: task.status, workspace_kind: "project", workspace_path: "/srv/work", project_id: "p_1", gated: false, subscribed: true };
    this.server.event(runtimeId, "tool.complete", { tool_id, name: "kanban_create", duration_s: 0.1, result: JSON.stringify(result) });
    const text = `Research task dispatched (${task.id}). I'll synthesize the findings when it returns.`;
    this.server.event(runtimeId, "message.delta", { text });
    this.server.storeMessage(stored, { role: "assistant", text });
    this.server.event(runtimeId, "message.complete", { text, status: "complete" });
  }

  route(req: RestRequest): (() => unknown) | undefined {
    const m = /^\/api\/plugins\/kanban\/(boards|board|tasks)(?:\/([^/]+))?$/.exec(req.path);
    if (!m || req.method !== "GET" || this.missing) return undefined;
    const [, what, rawId] = m;
    return () => {
      if (what === "boards")
        return {
          boards: Object.entries(this.boards).map(([slug, b]) => ({ slug, name: b.name, archived: false, is_current: slug === this.current, counts: {}, total: b.tasks.length })),
          current: this.current,
        };
      const slug = req.query.get("board") ?? this.current;
      const board = this.boards[slug];
      if (!board) this.refuse(404, `board '${slug}' does not exist`);
      if (what === "board") return { columns: KANBAN_COLUMNS.map((name) => ({ name, tasks: board.tasks.filter((t) => t.status === name).map(listed) })), assignees: [], tenants: [], latest_event_id: 0, now: now() };
      const task = board.tasks.find((t) => t.id === decodeURIComponent(rawId ?? ""));
      if (!task) this.refuse(404, `task '${rawId}' does not exist`);
      return { task: listed(task), events: [], runs: task.runs, comments: [], links: [] };
    };
  }

  private refuse(status: number, detail: unknown): never {
    throw new RestError(status, JSON.stringify({ detail }));
  }
}

/** A task as the routes list it: the stored row less what the plugin keeps to itself. */
function listed({ subscribed: _, ...t }: KanbanRow) {
  return t;
}
