// Frontend Hermes transport: speaks the legacy JSON-RPC generation of `/api/ws` over a Pipe and folds
// the server's frames into Chats. Wire shapes: docs/research/hermes-gateway-api.md §3d, §4, §5 and
// "SSH tunnel, Host header and protocol generation". Only the legacy verbs are used (ADR 0003).
// The chat list comes from dashboard REST, because the legacy `session.list` has no last-activity field.
// Attachments: research doc §7. A dropped connection is reconnected on its own; keepalive: research doc §1.
// One profile's chats show at a time; switching opens the connection again for the new profile.
// Search runs on dashboard REST: research doc "Searching chats".
// Approvals come as legacy server→client requests, answered with a response frame: research doc §6 and
// "Approvals on the legacy generation".
// The list holds the past month's chats until the owner pulls older history for the profile; from then on it holds
// them all. Archived chats are read only while the archived view is open (research doc "Session flags").
// While the window is out of focus, a reply finishing or an Approval arriving shows a desktop notification, and the chat
// on screen isn't marked read.
// Each chat opened lately keeps a Saved copy of its transcript on this computer, shown while Hermes can't be reached
// or the history is on the way; when the first connection at launch fails, the saved list and copies still open.
// Unread chats in the other profiles are polled over dashboard REST (otherProfiles.ts).
// Settings → Model reads and writes the profile's models over dashboard REST (modelSettings.ts).
// Settings → Memory reads and edits the memory of the profile the dashboard runs as, over legacy `learning.*` (memory.ts).
// The composer's model picker lists what `model.options` offers (models.ts) and switches one chat at a time with
// The preview pane reads Server files over dashboard REST `GET /api/fs/*` (preview.ts).
// session-scoped `config.set`; it never writes the profile's default model, reasoning or fast mode (Settings → Model does).
// A message sent from here is marked in the transcript until Hermes confirms it (`Outgoing`). One Hermes didn't take,
// or may not have, stays there with Retry, kept beside the cache so it outlives a restart, and never in a Saved copy.
// Whether one Hermes may have got did arrive is settled by reading the chat's history back (ADR 0006).
// Each chat's context fullness and YOLO come from its session's `info` and `usage`: research doc "Status bar".
// Token usage and cost (usage.ts, ADR 0008): each reply's usage is how far its session's live counters moved during
// its turn; each chat's totals and cost are Hermes's stored ones, read with the chat list and after each turn.
import { McpApi } from "./mcp";
import { GatewaysApi } from "./gateways";
import { PersonaApi } from "./persona";
import { ProfileCloneApi } from "./profileClone";
import { APPROVAL_CHOICES, isBroadGrant, isOutgoing, isWaiting, offeredChoices, turnStart, type ApprovalChoice, type ApprovalItem, type AttachCheck, type Attachment, type Chat, type ChatQueue, type ConnectionStatus, type ContextUse, type Found, type Item, type ListedChat, type LiveSession, type LiveSessions, type OtherProfiles, type Outgoing, type OutgoingItem, type Queued, type SavedSend, type SeenFailure, type SessionLive, type SideQuestion, type Source, QUEUE_LIMIT } from "./model";
import { catalogFromServer, fallbackCatalog, isEffort, modelKey, pickFromInfo, type ModelCatalog, type ModelPick } from "./models";
import { approvalsOf, isApprovalMode, writesFor, type ApprovalPick } from "./approvals";
import { noOthers, OtherProfilesCheck } from "./otherProfiles";
import { failureMark } from "./inbox";
// Projects are Hermes's own, read and written with legacy `projects.*` (projects.ts, research doc "Projects").
import { projectsApi, type ProjectsApi } from "./projects";
import { STEER, askSideQuestion, listServerCommands, runServerCommand, sideAnswer, type CommandDef, type CommandResult, type ServerCommandList } from "./commands";
import { callText, offeredSkills, runSkill, skillInvocationText, type SkillCall, type SkillCommands } from "./skillCommands";
import { CronApi } from "./cronJobs";
import { followsSession, nextRoster, parseKanbanCreate, sameTask, type DispatchedTask } from "./dispatched";
import { KanbanApi, KanbanWatch } from "./kanban";
import { AutomationsApi } from "./automations";
import { ModelSettingsApi } from "./modelSettings";
import { ToolsetsApi } from "./toolsets";
import { VoiceSettingsApi } from "./voiceSettings";
import { readBack, sendImport, type PlannedChat } from "./importTranscripts";
import { memoryApi, type MemoryApi } from "./memory";
import { MemoryProvidersApi } from "./memoryProviders";
import { SkillsApi } from "./skills";
import { CapabilityStore, CapabilityUnsupportedError, failureOf, isNoRoute, sharesChats, type ServerFacts } from "./capabilities";
import { BOT_CHAT_TITLE, BotChats, BotModeUnsupportedError, isBotChat, isBotChatTitle, rosterOf, type Bot } from "./bots";
import type { OpenPipe, Pipe, PipeEvent, RestMethod, Route, Speech, Transcript, VoiceSetup } from "./pipe";
import { RemoteFilesError, SANDBOX_MISSING, SANDBOX_NOT_FOUND_PREFIX, SESSION_GONE, previewSupport, remoteFiles, type EditIo, type RemoteFiles } from "./remoteFiles";
import { isUnsecure } from "./unsecure";
import { TOKEN_REFUSED } from "./routes";
import { WRONG_PASSWORD } from "./account";
import { AccountsApi } from "./accounts";
import { providerKeys, readyProviders, type ProviderSetup, type SavedKey } from "./setup";
import { restartHold } from "./unsaved";
import { hostFileView, readServerFile, type FileView } from "./preview";
import type { DisplayLease, DisplayObserve, DisplayStatus, ScreenApi } from "./screen";
import { agentFsEditIo } from "./artifacts";
import { splitPath, type OutputsIo, type StoredRow as StoredOutputRow } from "./outputs";
import type { UsageIo } from "./usageAnalytics";
import { compactResultOf, compactionsOf, readingOf, type CompactResult, type CompactionHistory, type CompactionRow, type ContextReading } from "./contextInspect";
import { chatUsageOf, countersOf, newerChatUsage, replyUsage, ZERO_COUNTERS, type ReplyUsage, type UsageCounters } from "./usage";
import { toolResultText } from "./toolResult";
import { onLost, onRoster, onSubagentEvent, onUnchecked, parseOutput, type SubagentId, type SubagentOutput } from "./subagents";
import {
  BRANCH_KEY_TTL_MS,
  NO_BRANCHES,
  branchBlocked,
  excerpt,
  locate,
  previewOf,
  spineKey,
  spineOf,
  type BranchAttempt,
  type BranchLink,
  type BranchPreview,
  type BranchStore,
  type BranchVariant,
  type SpineRow,
  type StoredBranchRow,
} from "./branch";
import { cannotResend, laterOf, replayBlocked, resendText, replayTarget, splitRefs, turnAt, variantRoot, withRefs, withoutMarkers, type ReplayKind, type ReplayPreview } from "./replay";

/**
 * The `source` this app stamps on chats it starts. Legacy `session.create` stores any string as-is, but the gateway
 * takes an edit (rename, pin, archive, read) only on a local client's row whose source it knows (`LEGACY_LOCAL_SOURCES`,
 * `authorize_history` at the deployed `bf0203a`): every edit of a `hermes-chat` row was answered 404 `not_found`.
 */
export const APP_SOURCE = "gui";

/** Why a Bot Chat can't be renamed here (ADR 0066). */
const BOT_CHAT_RENAME = "A Bot Chat's name is how Hermes finds it, so it can't be renamed.";
/** What this app stamped before, still shown as this app's. Hermes won't edit these chats. */
const OLD_APP_SOURCE = "hermes-chat";
const READY_TIMEOUT_MS = 15_000;
/** How long leaving a connection waits for Hermes to take back the screen the owner held. */
const SCREEN_RELEASE_MS = 1_500;
/** Waits before each try to reconnect a dropped connection. When the last try fails the app is Offline until the
 * owner asks to reconnect, so a wrong password isn't retried for ever. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
/** After a launch that couldn't connect, once those tries are spent, how often the app tries again while it is open,
 * Offline in between, until it connects or Hermes turns the password down (#269). */
const LAUNCH_RETRY_MS = 60_000;
/** A `gateway.ping` goes out this often. A connection that has sent nothing for longer than the official client's
 * heartbeat deadline is dropped. */
const PING_EVERY_MS = 15_000;
const SILENCE_LIMIT_MS = 45_000;
/** The list shows chats active in the past month. */
const LIST_WINDOW_MS = 30 * 86_400_000;
/** Dashboard REST caps `GET /api/sessions` pages at 100. */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
/** How long the model list may take: Hermes may first fetch model metadata, which it bounds at 15 seconds. */
const MODELS_TIMEOUT_MS = 30_000;
/** Checking another profile for Unread chats reads one page of its most recent ones. */
const OTHER_PAGE_SIZE = 50;
/**
 * A `session.active_list` check asked for sooner than this after the last one, on the same connection, is skipped. The
 * office asks this often.
 */
export const LIVE_MIN_GAP_MS = 15_000;
/** A check asked for on a LIVE_MIN_GAP_MS timer can come a little early by the clock; it isn't skipped for that. */
const LIVE_SLACK_MS = 1_000;
/** The most live sessions of unknown profile one check looks up, and the profiles it asks at once for each. */
const LOOKUPS_PER_CHECK = 3;
const LOOKUP_AT_ONCE = 4;
/** The most chats one search lists; dashboard REST caps it at 100. */
const SEARCH_LIMIT = 50;
export const SEARCH_MAX = 100;
/** How long the skills the composer offers are used before they are read again (`skillCommands`). */
export const SKILL_COMMANDS_FRESH_MS = 60_000;
/** The most side questions a chat shows; a newer one takes the oldest one's place (ADR 0070). */
export const SIDE_QUESTIONS_KEPT = 3;

/** A side question with Hermes's answer to it, or why there is none (`commands.sideAnswer`). */
const answered = (q: SideQuestion, text: unknown): SideQuestion => {
  const res = sideAnswer(text);
  const { id, question, after, taskId } = q;
  return "answer" in res ? { id, question, after, taskId, state: "answered", answer: res.answer } : { id, question, after, taskId, state: "failed", error: res.error };
};

/** Hermes sends a side question's answer on the connection it was asked on, so a dropped one never brings it. */
const lostSide = (q: SideQuestion): SideQuestion =>
  q.state === "asking" ? { id: q.id, question: q.question, after: q.after, taskId: q.taskId, state: "failed", error: "The connection to Hermes dropped before it answered." } : q;

const MiB = 1024 * 1024;
/** The most legacy `image.attach_bytes` and `file.attach` take (research doc §7). PDFs go as files: `pdf.attach`
 * needs `pdftoppm`, which the live server doesn't have. */
export const LIMITS = { image: { bytes: 25 * MiB, what: "images" }, file: { bytes: 256 * MiB, what: "files" } };
/** What the owner is told about a file over its limit. */
export const overLimitNote = (name: string, size: number, limit: (typeof LIMITS)[keyof typeof LIMITS]) =>
  `${name} is ${(size / MiB).toFixed(1)} MB. Hermes takes ${limit.what} up to ${limit.bytes / MiB} MB.`;
/** The images Hermes looks at (`cli._IMAGE_EXTENSIONS`); anything else is staged as a file. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** What the official desktop app asks when an image is sent with no text. */
const IMAGE_ONLY_PROMPT = "What do you see in this image?";
/** Stands in for a file's base64 in a frame; the pipe swaps the bytes in. JSON can't hold a raw NUL. */
const FILE_MARK = "\u0000file\u0000";

/** A chat's Saved copy: its transcript when this computer last saved it, and when that was. */
export type SavedTranscript = { items: Item[]; savedAt: number };

/**
 * Where each profile's last synced chat list, the Saved copies of the chats opened lately, the profile shown last, and
 * the profiles whose older history was pulled are kept between launches. `saveTranscript` lets go of the least
 * recently saved copies past the cache's storage limit. `bytes`: the storage the chat lists and Saved copies take;
 * `clear` deletes them, and only them. The outbox, each chat's messages sent from here that Hermes hasn't confirmed,
 * is kept here too but isn't part of the cache: `clear` keeps it, as it keeps drafts.
 */
export type ChatCache = {
  load(profile: string): Chat[];
  save(profile: string, chats: Chat[]): void;
  loadTranscript(profile: string, chatId: string): SavedTranscript | undefined;
  saveTranscript(profile: string, chatId: string, items: Item[]): void;
  deleteTranscript(profile: string, chatId: string): void;
  lastProfile(): string | undefined;
  rememberProfile(profile: string): void;
  bytes(): number;
  clear(): void;
  olderPulled(profile: string): boolean;
  rememberOlderPulled(profile: string): void;
  /** The profile's outbox, by chat. */
  loadOutbox(profile: string): Record<string, OutgoingItem[]>;
  /** Keeps a chat's outbox; none deletes it. */
  /** False: storage refused it, so it lasts until the app closes. */
  saveOutbox(profile: string, chatId: string, items: OutgoingItem[]): boolean | void;
  /** Each chat's queue (ADR 0018), by chat id; chats with an empty queue are left out. */
  loadQueues(profile: string): Record<string, ChatQueue>;
  /** Keeps the chat's queue; none, or an empty one, deletes it. False: storage refused it, so it lasts until the app closes. */
  saveQueue(profile: string, chatId: string, queue: ChatQueue | undefined): boolean;
  /** The branches this app made in the profile, and those asked for whose answer was lost (ADR 0027). */
  loadBranches(profile: string): BranchStore;
  /** False: storage refused it, so it lasts until the app closes. */
  saveBranches(profile: string, store: BranchStore): boolean;
};
/** Shows a desktop notification; rejects if it can't. */
export type Notify = (n: { title: string; body: string }) => Promise<void>;
/** What notifications say. They never quote a chat's title or messages, or an Approval's command. */
export const NOTICES = {
  finished: { title: "Hermes finished a reply", body: "Open Hermes Chat to read it." },
  approval: { title: "Hermes is asking for approval", body: "A command is waiting for your answer in Hermes Chat." },
};

const noCache: ChatCache = {
  load: () => [],
  save: () => {},
  loadTranscript: () => undefined,
  saveTranscript: () => {},
  deleteTranscript: () => {},
  lastProfile: () => undefined,
  rememberProfile: () => {},
  bytes: () => 0,
  clear: () => {},
  olderPulled: () => false,
  rememberOlderPulled: () => {},
  loadOutbox: () => ({}),
  saveOutbox: () => {},
  loadQueues: () => ({}),
  saveQueue: () => true,
  loadBranches: () => NO_BRANCHES,
  saveBranches: () => true,
};

/** A row of dashboard REST `GET /api/sessions`; times are Unix seconds. */
type SessionRow = {
  id: string;
  source?: string;
  title?: string | null;
  preview?: string;
  started_at?: number;
  last_active?: number | null;
  pinned?: boolean;
  archived?: boolean;
  /** Activity postdates the session's shared read watermark (`SessionDB.session_unread`). */
  unread?: boolean;
  /** The model the session last ran on, as Hermes stored it; list and search rows both carry it. */
  model?: string | null;
  /**
   * The surface that started a chat Hermes stores with `source: "local"` (its canonical CLI, TUI and desktop chats).
   * List rows carry it; search rows don't.
   */
  created_source?: string | null;
  /** The session it was branched (or compressed) from. */
  parent_session_id?: string | null;
  message_count?: number;
  /** The folder it works in, as Hermes stored it. */
  cwd?: string | null;
  /** Running now, or active lately, as the dashboard decides (`_is_active`). */
  is_active?: boolean;
  /** A compressed chat's row: every segment's id (ADR 0026). */
  _lineage_ids?: unknown;
};
type SessionPage = { sessions: SessionRow[]; total: number };
/** Dashboard REST `GET /api/sessions/{id}`, as far as this app reads it. Flags come as stored, 0 or 1. */
type SessionDetail = { archived?: boolean | number };
/** Dashboard REST `GET /api/sessions/{id}/mutation-snapshot`: the revision a session edit must name. */
type MutationSnapshot = { exists: boolean; runtime_revision: number; runtime_generation: number | null };
/**
 * A row of dashboard REST `GET /api/sessions/search` (research doc "Searching chats"): one per chat, archived ones
 * too. `snippet` is FTS5's, with each matched word `>>>marked<<<`; `role` is the matched message's, and null when the
 * chat's id or title matched instead.
 */
type SearchRow = Pick<SessionRow, "id" | "source" | "title" | "preview" | "started_at" | "last_active" | "archived" | "model" | "created_source"> & {
  snippet?: string;
  role?: string | null;
  /** The compression lineage's first session, for a hit in a compressed chat. */
  lineage_root?: string;
};
/** Dashboard REST `GET /api/profiles` (`web_routers/profiles.py`), as far as this app reads it. */
type ProfileList = { profiles: { name: string; model?: string | null; provider?: string | null }[] };

/** Legacy `config.set` result for `model` (`ConfigSetResult`): an expensive model is applied only once confirmed. */
type ConfigSet = { value?: unknown; confirm_required?: boolean; confirm_message?: string; deferred?: boolean; warning?: string };

/** A history row from legacy `session.resume` (research doc §5, `TranscriptMessage`). Tool rows carry the call's
 * name, args and an 80-char `context`; Hermes keeps the result (`content`) only for edit tools. `timestamp`: when the
 * row was stored, Unix seconds, sent only when positive (`session_history._history_to_messages` at `bf0203a`). */
type TranscriptMessage = {
  role: string;
  text?: string | null;
  reasoning?: string | null;
  content?: unknown;
  name?: string | null;
  context?: string | null;
  args?: Record<string, unknown> | null;
  /** A tool row's call (`tool_call_id`). */
  tool_call_id?: string | null;
  timestamp?: number | null;
  /** The stored row (`messages.id`); a live session's not-yet-stored tail has none. */
  row_id?: number | null;
  /** How Hermes shows the row: `steer` for a message that went into a running reply (`session_history.py`). */
  display_kind?: string | null;
};

/** Legacy `prompt.submit` result. `user_row_id`: the stored row of the message, when its turn started at once
 * (`tui_gateway/methods_prompt.py` at `bf0203a`). */
/** `status` `queued`: Hermes holds the message until a turn it is running ends (research doc). */
type Submitted = { status?: string; user_row_id?: number | null };

/** `message.complete` `persisted_turn`: the stored rows of the turn that ended (`agent/persisted_turn_receipt.py` at
 * `bf0203a`). `final_assistant_row_id` is there only for a turn that completed with a stored final reply. */
type PersistedTurn = { user_row_id?: number | null; final_assistant_row_id?: number | null; row_ids?: unknown };

/** A row of dashboard REST `GET /api/sessions/{id}/messages` (`SELECT *` from `messages`), as far as this app reads it. */
type StoredRow = { id: number; timestamp?: number | null };

/** Legacy `image.attach_bytes` and `file.attach` results (research doc §7), as far as this app reads them. */
type ImageAttached = { path: string };
type FileAttached = { ref_text: string };

/** Legacy `session.interrupt` result (research doc §8). `not_interrupted` needs `expected_hosted_task_id`. */
type InterruptResult = { status: "interrupted" | "not_interrupted" };

/**
 * A server→client request (`tui_gateway/server_requests.py`), as it arrives or as `session.resume` lists it in
 * `open_requests`. An `approval` one carries `{request_id, command, description, choices, ...}` (research doc §6).
 */
type ServerRequest = { id: string; method: string; params: Record<string, unknown> };

/** JSON-RPC "method not found": what Hermes expects from a client that can't handle a request. */
const NO_SUCH_METHOD = -32601;
/** "No window here shows this chat" (`NOT_SHOWN_CODE`, `tui_gateway/server_requests.py`): one client declining. */
const NOT_SHOWN = 4404;
/** Requests only the window showing the chat answers (the official app's `WINDOW_OWNED_REQUESTS` at `bf0203a`). */
const WINDOW_OWNED = new Set(["preview.act", "preview.read", "terminal.read", "theme.apply", "window.read", "tour"]);

/**
 * The answer to a server request this app doesn't show, or none. On a Hermes that shares chats, the first answer
 * settles a request for every client attached, an error included, so a refusal would end a question the official app
 * is showing (#313). There, only a window-owned request is declined, and only where Hermes counts that as a decline.
 * Unanswered, a request ends at Hermes's own deadline or when the owner stops the reply.
 */
function unshownAnswer(method: string, facts: ServerFacts): { code: number; message: string } | undefined {
  if (!sharesChats(facts)) return { code: NO_SUCH_METHOD, message: `Hermes Chat can't answer ${method} requests yet.` };
  if (facts.declinesNotShown && WINDOW_OWNED.has(method)) return { code: NOT_SHOWN, message: "No Hermes Chat window shows this chat's preview, terminal or tour." };
  return undefined;
}
const NO_SUBAGENT_LIST = "This Hermes has no subagent.list, so it can't say what they did while the app was disconnected.";

/** Why an Edit or Regenerate made nothing: the chat isn't as the owner saw it in the dialog. */
const REPLAY_CHANGED = "This chat changed since this opened, here or in another Hermes client. Nothing was made; open it again to see the chat as it is now.";

/** Dashboard REST caps a page of stored messages at 500. The compaction history reads at most `COMPACTION_ROWS`. */
const COMPACTION_PAGE = 500;
const COMPACTION_ROWS = 10_000;

type RpcFrame = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: { type?: string; session_id?: string; payload?: Record<string, unknown> } & Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

export class ProtocolMismatchError extends Error {
  constructor() {
    super("This Hermes server speaks the canonical session protocol, which Hermes Chat doesn't support yet.");
  }
}

/**
 * A rename that would have overwritten another edit of the chat, made in another Hermes client since the owner
 * started. `title`: the chat's title on the server now, which the app shows instead.
 */
export class RenameConflict extends Error {
  constructor(readonly title: string) {
    super(`This chat changed in another Hermes client and is now called "${title}". Save again to rename it anyway.`);
  }
}

/**
 * Regenerate title failed because Hermes has no working sign-in or key on the server for the provider of the
 * profile's Text generation model. Hermes picks that model, not this app: `llm.oneshot` with no `task` runs the
 * profile's `title_generation` helper task (`auxiliary.title_generation`). So the owner either signs Hermes in on the
 * server, or picks another Text generation model in Settings → Model. Nothing switches provider on its own.
 * `provider`: the provider's slug. `detail`: what Hermes said, word for word.
 */
export class TitleModelUnavailable extends Error {
  constructor(
    readonly provider: string,
    readonly detail: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The `TitleModelUnavailable` a failed `llm.oneshot` stands for, if it failed for want of the provider's credentials.
 * The texts are Hermes's own at `c419cf7` (`agent/auxiliary_client.py` `_resolve_call_client`,
 * `agent/auxiliary_unavailable.py`): a pin to Nous Portal reports `Nous Portal runtime credentials unavailable: <why>`,
 * any other pinned provider `Provider '<slug>' is set in config.yaml but no API key was found` or `no credentials were
 * found`. A rate limit, a timeout or a busy provider isn't a sign-in problem, so it keeps Hermes's words.
 */
export function titleModelUnavailable(why: string, profile: string): TitleModelUnavailable | undefined {
  const detail = why.replace(/^one-shot generation failed:\s*/, "");
  const otherSettings = "or pick another Text generation model in Settings → Model.";
  const hermes = `hermes ${profile && profile !== "default" ? `-p ${profile} ` : ""}`;
  if (/Nous Portal runtime credentials unavailable/i.test(detail) && !/rate.?limit|quota|temporarily|retry/i.test(detail))
    return new TitleModelUnavailable(
      "nous",
      detail,
      `Text generation runs on Nous Portal, and Hermes on the server isn't signed in to Nous Portal. Sign it in there with ` +
        `\`${hermes}auth add nous\`, ${otherSettings}`,
    );
  const pinned = /Provider '([^']+)' is set in config\.yaml but no (?:API key|credentials) (?:was|were) found/.exec(detail);
  if (pinned)
    return new TitleModelUnavailable(
      pinned[1],
      detail,
      `Text generation runs on ${pinned[1]}, and Hermes on the server has no API key or sign-in for it. Add one there, ${otherSettings}`,
    );
}

/**
 * The connection dropped before Hermes answered a branch, so whether it made one can't be known yet. The chat list
 * read once connected again settles it (`Hermes.branch`).
 */
export class BranchUnconfirmed extends Error {
  constructor() {
    super("The connection dropped before Hermes answered, so it isn't known yet whether it made the branch. Hermes Chat checks the chat list once it's connected again.");
  }
}

/** Why a branch wasn't asked for after all; nothing went to Hermes. */
class BranchNotSent extends Error {}

/** Legacy `session.branch` result (`SessionBranchResult` at `bf0203a`): the branch's live and stored ids, its title,
 * its parent, the rows it copied, and its history as `session.resume` shows it. */
type BranchAnswer = { session_id: string; stored_session_id: string; title: string; parent?: string; message_count: number; messages?: TranscriptMessage[]; info?: unknown };

/** Stored rows are read for a branch this many at a time (dashboard REST's page cap), up to this many pages. */
const BRANCH_PAGE_ROWS = 500;
const BRANCH_MAX_PAGES = 20;
/** Looking for a branch whose answer was lost reads at most this many pages of the chat list. */
const BRANCH_LIST_PAGES = 10;

/** A key no other attempt has. */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

/**
 * The connection dropped after a request went out and before Hermes answered it, so whether Hermes got it can't be
 * known. A JSON-RPC id means nothing on the next connection, so asking again there isn't safe.
 */
export class ConnectionLostError extends Error {}

/**
 * Hermes has the session but won't edit it, and answers as if it weren't there. At `bf0203a` the gateway takes edits
 * only for sessions it has a route for (Telegram, CLI, API), so every chat a WS client started is refused with 404
 * `not_found` (`gateway/session_authority.py` `authorize`, `gateway/session_api.py` `restore_api_session`).
 */
class EditRefusedError extends Error {}

/**
 * What became of a message `send` sent. `accepted`: Hermes answered that it took it. `unsent`: it never went out, or
 * Hermes answered that it didn't take it. `unknown`: it went out and the connection dropped before Hermes answered,
 * so Hermes may be running it, tools and all.
 */
export type Delivery = { delivery: "accepted" } | { delivery: "unsent" | "unknown"; reason: string };

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `profile`: the profile whose chats are shown. `route`: how the latest connection reached the dashboard. `unsecure`:
 * its traffic isn't encrypted (unsecure.ts). `closedReason`: why the connection dropped, or why the last try to
 * reconnect failed. `olderPulled`: the list holds the profile's chats older than a month too (`pullOlderHistory`).
 * `others`: Unread chats in the profiles not shown, as last checked (`checkOtherProfiles`).
 */
export type Snapshot = {
  profile: string;
  chats: Chat[];
  olderPulled: boolean;
  /** The list also holds the profile's archived chats, however old (`listArchived`). */
  archivedListed: boolean;
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  closedReason?: string;
  syncError?: string;
  others: OtherProfiles;
  /** What is working or waiting on the owner across the server's profiles, as last checked (`checkOtherProfiles`). */
  live?: LiveSessions;
  /** The shown profile's queues of messages waiting to go after a reply, by chat id (ADR 0018). */
  queues: Record<string, ChatQueue>;
  /** The models the shown profile can switch to (`loadModels`); none until read. */
  models?: ModelCatalog;
  /** The switch to `profile` from `from`, until the new profile's list has been read. `error`: why it hasn't yet. */
  switching?: { from: string; error?: string };
  /** The shown profile's branches made here, and those asked for whose answer was lost (ADR 0027). */
  branches: BranchStore;
  /**
   * What became of a branch whose answer was lost, once the chat list said: made after all (`chatId`), or never made.
   * `at` tells one from the next.
   */
  branchNews?: { text: string; chatId?: string; at: number };
};

/** Why `connect` rejected when its `signal` stopped it. */
export const CONNECT_STOPPED = "Connecting was stopped. Nothing was saved.";

/**
 * Connects to Hermes for `profile`, by default the one shown last; rejects if the first connection fails. Later drops
 * are reconnected by the returned Hermes. `signal` stops the first connection while it opens: the Hermes is closed,
 * which stops Rust opening it too (`hermes_connect_cancel`), and this rejects with `CONNECT_STOPPED`. A stop that
 * comes after Hermes answered changes nothing.
 */
export async function connect(openPipe: OpenPipe, profile?: string, cache: ChatCache = noCache, notify?: Notify, signal?: AbortSignal): Promise<Hermes> {
  if (signal?.aborted) throw new Error(CONNECT_STOPPED);
  const hermes = new Hermes(openPipe, profile ?? cache.lastProfile() ?? "default", cache, notify);
  let closing: Promise<void> | undefined;
  const stop = () => void (closing = hermes.close().catch(() => {}));
  signal?.addEventListener("abort", stop, { once: true });
  let failed: unknown;
  try {
    await hermes.dial();
  } catch (e) {
    failed = e;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  // Stopped, even if the dial got through before the close reached it: wait until whatever the dial opened is closed
  // too, so the next connection finds Rust's one free.
  if (signal?.aborted) {
    await closing;
    throw new Error(CONNECT_STOPPED);
  }
  if (failed !== undefined) throw failed;
  return hermes;
}

/**
 * At launch, when the first connection has failed for `reason`: a Hermes showing what this computer saved for the
 * profile shown last, its chat list and the Saved copies of the chats opened lately, which keeps trying to connect as
 * after a drop. Undefined when no chat list is saved, so there is nothing to read.
 */
export function readSaved(openPipe: OpenPipe, reason: string, cache: ChatCache, notify?: Notify): Hermes | undefined {
  return Hermes.readSaved(openPipe, reason, cache, notify);
}

/**
 * At launch, before anything is reached: a Hermes showing what this computer saved for the profile shown last, as
 * `readSaved` does, that starts connecting at once, its status Connecting (ADR 0089). `firstTry` resolves once that
 * first try has ended: to undefined if it connected or the Hermes was closed meanwhile, or to why it failed. After a
 * failure it keeps trying as after a drop. Undefined when no chat list is saved, so there is nothing to show.
 */
export function openSaved(openPipe: OpenPipe, cache: ChatCache, notify?: Notify): { hermes: Hermes; firstTry: Promise<string | undefined> } | undefined {
  return Hermes.openSaved(openPipe, cache, notify);
}

export class Hermes {
  private pipe?: Pipe;
  /** The profile the pipe's `/api/ws` was opened for. */
  private pipeProfile?: string;
  /** Counts pipes opened; events from an older pipe than the current one are ignored. */
  private generation = 0;
  /** The connection whose Hermes has no `subagent.list`. */
  private noSubagentList?: number;
  /** The connections (by generation) whose Hermes answered that it has no `session.compress`. */
  private noCompact = new Set<number>();
  /** Compactions asked of Hermes and not yet answered, by chat. A message sent meanwhile waits for it (`deliver`). */
  private compacting = new Map<string, Promise<unknown>>();
  /** The pipe being opened is waiting for `gateway.ready`. */
  private onReady?: (payload: Record<string, unknown>) => void;
  /** Ends the dial under way with this error. */
  private abortDial?: (e: Error) => void;
  /** The dropped pipe, until the Rust side has closed it. Opening the next one waits, because Rust holds a single
   * connection and closing drops whichever it holds. */
  private droppedClosing?: Promise<void>;
  private redialing?: Promise<void>;
  private failedTries = 0;
  /** Opened by a launch on what this computer saved (`readSaved`, `openSaved`), and not connected since: once its quick
   * tries are spent it keeps trying (`LAUNCH_RETRY_MS`). */
  private launchFailed = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastHeard = 0;
  private closing = false;
  /** Chats resumed on a connection that has since dropped: how many of their items the next resume replaces with the
   * stored history. */
  private staleItems = new Map<string, number>();
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<() => void>();
  private sendListeners = new Set<(profile: string, chatId: string) => void>();
  private snapshot: Snapshot;
  /** Chats this app moved between Active and Settled that Hermes hasn't stored yet: the `pinned` flag each should
   * have (ADR 0002). While a chat is here, this flag beats the one the server lists. */
  private pinWanted = new Map<string, boolean>();
  /** The latest write of each chat's pinned flag, so a chat's writes go out one at a time, in order. */
  private pinWrites = new Map<string, Promise<boolean>>();
  /** Chats whose pinned flag was written since the list sync under way read the list, which may predate the write. */
  private pinnedSinceListRead = new Set<string>();
  /** Chats renamed since the list sync under way read the list, which may predate the rename. */
  private retitledSinceListRead = new Set<string>();
  /** The chats on screen, by the pane showing each (`open`). They are kept read: new activity in them doesn't show the
   * dot. Two panes may show the same chat. */
  private viewing = new Map<string, string>();
  /** The app's window has the owner's focus (`setFocused`). */
  private focused = true;
  /** Chats on screen that had something new while the window was out of focus, so they are marked read once it's back. */
  private readWhenBack = new Set<string>();
  /** Approvals already notified, or that arrived in focus, by runtime session and request id. Hermes lists one again
   * after a reconnect. */
  private notified = new Set<string>();
  /** The latest write marking each chat read, while it is under way. */
  private readWrites = new Map<string, Promise<void>>();
  /** Chats marked read since the list sync under way read the list, which may predate the write. */
  private readSinceListRead = new Set<string>();
  /** Resumes in flight, so opening a chat and replying in it share one. */
  private resuming = new Map<string, Promise<string>>();
  /** Chats that had a reply running or an Approval waiting when the owner switched away from their profile, by
   * profile. Switching back resumes them once the list is read, which brings back what Hermes is still waiting on. */
  private busyIn = new Map<string, string[]>();
  /** Chats the owner picked from a search though the list doesn't hold them; they stay in it until the profile changes. */
  private revealed = new Set<string>();
  /** Finds and creates Bot Chats, by title every time (bots.ts). */
  private botChats = new BotChats((method, params) => this.request(method, params), APP_SOURCE);
  /** The Bot Chats the latest roster named, by profile: registry rows and lineage tips, which search leaves out. */
  private botChatIds = new Map<string, Set<string>>();
  /** The roster read for the Bot Chats' ids on a connection (`knownBotChats`). */
  private botChatsRead?: { gen: number; done: Promise<void> };
  /** Chats archived or restored here whose flag Hermes hasn't confirmed yet: the `archived` flag each should have.
   * While a chat is here, this flag beats the one the server lists. */
  private archiveWanted = new Map<string, boolean>();
  /** The latest archive or restore of each chat, so a chat's writes go out one at a time, in order. */
  private archiveWrites = new Map<string, Promise<boolean>>();
  /** Archives and restores whose outcome couldn't be read back, and the profile and title of each. The next refresh
   * reads them back before saying how they went. */
  private archiveUnsure = new Map<string, { profile: string; title: string }>();
  /** Chats the owner deleted here, or is deleting. A list read before the delete can't bring one back. */
  private deleted = new Set<string>();
  /** Chats that had a turn running, or an Approval waiting, when the connection dropped. Reconnecting resumes them,
   * which brings back what Hermes is still waiting on. */
  private resumeOnReconnect = new Set<string>();
  /** Requests for a session no chat holds yet: the resume that reattaches it can answer after Hermes writes them. */
  private earlyRequests = new Map<string, ServerRequest[]>();
  /** Closed Approval cards, answered here or that Hermes stopped waiting on, by request id. A resume replaces the
   * chat's cards with what Hermes lists, so this keeps one it lists again from coming back. */
  private closedApprovals = new Map<string, ApprovalItem>();
  /** Approvals Hermes has been told are on screen (`approval.received`), by request id. */
  private shownApprovals = new Set<string>();
  /**
   * Of those, the ones Hermes said wait in its own approval queue (`acknowledged`). Only for these does
   * `approval.respond` settle the request and `session.active_list` tell whether it still waits. With turn isolation
   * (`dashboard.turn_isolation`) the request waits in a child process that neither sees, and only a response frame
   * reaches it.
   */
  private queuedApprovals = new Set<string>();
  /**
   * Approval mode picks run one at a time on the connection: each starts from what the one before settled, and Smart
   * and Manual write the profile every chat on it shares (`setApprovals`).
   */
  private approvalPicks: Promise<unknown> = Promise.resolve();
  /** The runtime session whose pick is under way. */
  private approvalPickFor?: string;
  /** Hermes answered that it has no `approval.received`. */
  private noApprovalReceived = false;
  /** Messages Hermes hasn't accepted yet, so a Stop waits for the turn it stops. */
  private submitting = new Map<string, Promise<unknown>>();
  /** Each chat's last message sent from here, until a turn ends, with the stored row Hermes gave it, if any. */
  private turns = new Map<string, { userId: string; rowId: Promise<number | undefined> }>();
  /**
   * Each live session's usage counters as its next turn starts, by runtime id: what that turn's reply is measured from.
   * `unknown` when they can't be known, such as after reattaching mid-turn, so that reply shows no usage.
   */
  private usageFrom = new Map<string, UsageCounters | "unknown">();
  /** Last item before a running turn, by stable id; null for an empty transcript. Older Failed messages can go away. */
  private turnStart = new Map<string, string | null>();
  /** Chats whose running turn no message sent from here began: Hermes started it, or another Hermes client did. */
  private unprompted = new Set<string>();
  /** Side questions asked on this connection, so each card has its own id (ADR 0070). */
  private sideAsked = 0;
  /**
   * Side question answers that came before `prompt.btw` said which question they answer, by runtime session and task
   * id. Hermes answers on another thread, so with a quick model the event can beat the reply.
   */
  private earlySideAnswers = new Map<string, unknown>();
  /** How many `prompt.btw` calls on each runtime session wait for their task id. Answers are held only meanwhile. */
  private sideAwaiting = new Map<string, number>();
  /** The newest stored row each chat is known to have, from its history and the turns sent from here. A message that
   * may have reached Hermes is looked for only past the row its chat had when it went out. */
  private knownRow = new Map<string, number>();
  private syncing?: Promise<Error | undefined>;
  private syncAgain = false;
  private background = new Set<Promise<unknown>>();
  /** When the shown profile's list last synced on this connection. */
  private listedAt?: number;
  /** The server commands listed for a connection and profile (`serverCommands`). */
  private commandsRead?: { key: string; done: Promise<ServerCommandList> };
  /** The skills the composer offers, read for a connection and profile at `at` (`skillCommands`). */
  private skillsRead?: { key: string; at: number; done: Promise<SkillCommands | undefined> };
  /** The voice set-up read for a connection and profile (`voiceSetup`). */
  private voiceRead?: { key: string; done: Promise<VoiceSetup> };
  /** The model list being read, and for which profile. */
  private modelsLoading?: { profile: string; done: Promise<void> };
  /** A chat and model Hermes asked to confirm as expensive: picking it again for that chat confirms it. */
  private confirmModel?: string;
  /** How many queued messages of each chat the owner is editing: none of the chat's queue goes meanwhile. */
  private queueHolds = new Map<string, number>();
  /** A look at the queues is due once the current change is done (`pumpSoon`). */
  private pumpDue = false;
  /** The frame and timeout that will tell listeners of streamed deltas already in the snapshot (`notifySoon`). */
  private notifyDue?: { frame?: number; timer: ReturnType<typeof setTimeout> };

  /** Hermes's projects, each call naming its profile (projects.ts). Folders are read, never created. */
  readonly projects: ProjectsApi = projectsApi({
    rpc: (method, params) => this.request(method, params),
    get: (pathAndQuery) => this.rest("GET", pathAndQuery),
  });
  /** The titles chats had when the owner switched away from their profile, by `profile chatId`, for the inbox. */
  private titlesSeen = new Map<string, string>();
  /**
   * The profile each live session is in, by `runtimeId storedId`, from looking its stored id up in every profile: the
   * one profile that has it, or null when more than one does (a copied profile keeps the ids). A runtime session
   * doesn't change profile, so an answer is kept while it stays live; the same chat started again, perhaps in a
   * profile copied since, is looked up afresh.
   */
  private sessionOwners = new Map<string, { profile: string; title: string; source: Source } | null>();
  /** When each live session not yet placed was last looked up, by the same key, so every one gets its turn. */
  private ownerTried = new Map<string, number>();
  /** The profile and chat of each runtime session this app started or resumed, for as long as it runs. */
  private runtimeOwners = new Map<string, { profile: string; chatId: string }>();
  /** The latest `session.active_list` read: its connection, when it started, and the read while under way. */
  private liveCheck?: { gen: number; at: number; done?: Promise<void> };
  /** The latest `subagent.roster` read, for the profile and connection it answered for (`placeRoster`). */
  private roster?: { gen: number; profile: string; counts: ReadonlyMap<string, number> };
  /** This Hermes has no `subagent.roster`, so it is asked no more. */
  private rosterUnsupported = false;
  /** The next check while a chat waits on roster work, sooner than the app's own timers ask. */
  private rosterTimer?: ReturnType<typeof setTimeout>;
  private others = new OtherProfilesCheck({
    scope: () => (this.pipe && this.snapshot.status === "connected" && !this.closing ? { connection: this.generation, profile: this.profile } : undefined),
    profiles: () => this.profiles(),
    unreadIn: (profile) => this.unreadIn(profile),
    sendsIn: (profile) => this.sendsIn(profile),
    publish: (others) => this.update({ others }),
  });

  /** Lease changes Hermes broadcasts for the Bot Desktop (`display.lease`). */
  private leaseListeners = new Set<(profileKey: string, lease: DisplayLease) => void>();
  /** The viewer the owner holds the screen as, with the connection that minted it (`releaseScreen`). */
  private heldScreen: { viewerId: string; pipe: Pipe } | undefined;
  /** Counts profile picks, so the latest wins over one still handing back the screen. */
  private switchPick = 0;
  /** The hand-back under way, if any. */
  private screenRelease: Promise<void> | undefined;

  /**
   * The profile's Bot Desktop, the side panel's Screen (screen.ts, ADR 0039). `display.*` is scoped to the profile
   * shown, and a viewer id is good only on the connection that minted it.
   */
  readonly screen: ScreenApi = {
    status: () => this.request("display.status", { profile: this.profile }) as Promise<DisplayStatus>,
    start: () => this.request("display.start", { profile: this.profile }) as Promise<DisplayStatus>,
    observe: (viewerId) => this.request("display.observe", { profile: this.profile, ...(viewerId && { viewer_id: viewerId }) }) as Promise<DisplayObserve>,
    takeOver: async (viewerId) => ((await this.request("display.lease.acquire", { profile: this.profile, viewer_id: viewerId })) as { lease: DisplayLease }).lease,
    handBack: async (viewerId) => ((await this.request("display.lease.release", { profile: this.profile, viewer_id: viewerId })) as { lease: DisplayLease }).lease,
    noteHeld: (viewerId) => {
      this.heldScreen = viewerId && this.pipe ? { viewerId, pipe: this.pipe } : undefined;
    },
    onLease: (listener) => {
      this.leaseListeners.add(listener);
      return () => void this.leaseListeners.delete(listener);
    },
    openSocket: (ticket, onData, onClose) => {
      const pipe = this.pipe;
      if (!pipe || this.closing || this.snapshot.status !== "connected") return Promise.reject(new Error("Not connected to Hermes."));
      if (!pipe.openDisplay) return Promise.reject(new Error("This connection can't show the screen."));
      return pipe.openDisplay(ticket, onData, onClose);
    },
  };

  /**
   * Before leaving the connection on purpose, gives back the screen the owner holds, as a viewer that closes does. Its
   * stream may already be gone, and with it the normal close that would have done this. Only the connection that
   * minted the viewer can, so a dropped connection keeps the owner in control, as Hermes intends (ADR 0039).
   */
  /** Undefined when nothing is held or being handed back, so leaving waits for nothing then. */
  private releaseScreen(): Promise<void> | undefined {
    const held = this.heldScreen;
    this.heldScreen = undefined;
    if (held && held.pipe === this.pipe) {
      const releasing: Promise<void> = Promise.race([
        this.screen.handBack(held.viewerId).then(
          () => {},
          () => {},
        ),
        new Promise<void>((done) => setTimeout(done, SCREEN_RELEASE_MS)),
      ]).finally(() => {
        if (this.screenRelease === releasing) this.screenRelease = undefined;
      });
      this.screenRelease = releasing;
    }
    // A leave that comes while an earlier one hands back waits for it too, rather than closing the connection under it.
    return this.screenRelease;
  }

  /**
   * The files on the machine the dashboard runs on (remoteFiles.ts). They are the same for every profile, and can only
   * be read while connected. A transfer starts only while connected, and Rust stops it when the connection closes or
   * is replaced, so it never reaches another sign-in's server (ADR 0023).
   */
  readonly files: RemoteFiles = remoteFiles((pathAndQuery, maxBytes) => this.restGet(pathAndQuery, maxBytes), {
    download: (id, path, name, onProgress) => {
      const pipe = this.pipe;
      if (!pipe || this.closing || this.snapshot.status !== "connected") return Promise.reject(new Error("Not connected to Hermes."));
      return pipe.download(id, path, name, onProgress);
    },
    pickUpload: () => this.pipe?.pickUpload() ?? Promise.reject(new Error("Not connected to Hermes.")),
    discardUpload: (token) => this.pipe?.discardUpload(token) ?? Promise.resolve(),
    upload: (id, token, path, overwrite, onProgress) => {
      const pipe = this.pipe;
      if (!pipe || this.closing || this.snapshot.status !== "connected") return Promise.reject(new Error("Not connected to Hermes."));
      const refused = this.capabilities.refuses({ rest: "POST", path: "api/files/upload-stream" });
      if (refused) return Promise.reject(new CapabilityUnsupportedError(refused));
      return pipe.upload(id, token, path, overwrite, onProgress);
    },
    saveText: (id, path, text, overwrite) => {
      const pipe = this.pipe;
      if (!pipe || this.closing || this.snapshot.status !== "connected") return Promise.reject(new Error("Not connected to Hermes."));
      const refused = this.capabilities.refuses({ rest: "POST", path: "api/files/write" });
      if (refused) return Promise.reject(new CapabilityUnsupportedError(refused));
      return pipe.saveText(id, path, text, overwrite);
    },
    cancel: (id) => this.pipe?.cancelTransfer(id) ?? Promise.resolve(),
  });

  /**
   * How an artifact on the machine where `profile`'s tools run is read and saved (artifacts.ts `agentFsEditIo`, ADR
   * 0027). A save starts only while connected, and Rust stops it when the connection closes or is replaced.
   */
  artifactFs(profile: string, session?: string): EditIo {
    return agentFsEditIo((pathAndQuery, maxBytes) => this.restGet(pathAndQuery, maxBytes), {
      saveText: (id, p, path, text, chat) => {
        const pipe = this.pipe;
        if (!pipe || this.closing || this.snapshot.status !== "connected") return Promise.reject(new Error("Not connected to Hermes."));
        return pipe.fsSaveText(id, p, path, text, chat);
      },
      cancel: (id) => this.pipe?.cancelTransfer(id) ?? Promise.resolve(),
    }, profile, session);
  }

  /**
   * Asks Hermes for an edit of an artifact with legacy `llm.oneshot` (research doc, "Artifacts"): a stateless model call
   * with no tools, which adds nothing to any chat. When the chat that made the file is live in this app, its runtime
   * session lends its own model (`lent`); otherwise Hermes uses the profile's Text generation model, as Regenerate
   * title does. A missing sign-in for that model's provider is a `TitleModelUnavailable`.
   */
  async askForEdit(o: { profile: string; chatId?: string; instructions: string; input: string; maxTokens: number }): Promise<{ text: string; lent: boolean }> {
    const sid = o.chatId && o.profile === this.profile ? this.snapshot.chats.find((c) => c.id === o.chatId)?.runtimeId : undefined;
    const params = { profile: o.profile, instructions: o.instructions, input: o.input, max_tokens: o.maxTokens, temperature: 0.2, ...(sid && { session_id: sid }) };
    const { text } = (await this.request("llm.oneshot", params).catch((e) => {
      throw (e instanceof RpcError && titleModelUnavailable(e.message, o.profile)) || e;
    })) as { text?: unknown };
    if (typeof text !== "string") throw new Error("Hermes didn't answer with text.");
    return { text, lent: !!sid };
  }

  constructor(
    private openPipe: OpenPipe,
    profile: string,
    private cache: ChatCache = noCache,
    private notify: Notify = () => Promise.resolve(),
  ) {
    this.snapshot = {
      profile,
      chats: withOutbox(cache.load(profile), loadOutbox(cache, profile)),
      olderPulled: cache.olderPulled(profile),
      archivedListed: false,
      status: "offline",
      unsecure: false,
      others: noOthers,
      queues: loadQueues(cache, profile),
      branches: cache.loadBranches(profile),
    };
  }

  /** See `readSaved`. */
  static readSaved(openPipe: OpenPipe, reason: string, cache: ChatCache, notify?: Notify): Hermes | undefined {
    const hermes = new Hermes(openPipe, cache.lastProfile() ?? "default", cache, notify);
    if (!hermes.snapshot.chats.length) return undefined;
    hermes.launchFailed = true;
    hermes.dropped(reason);
    return hermes;
  }

  /** See `openSaved`. */
  static openSaved(openPipe: OpenPipe, cache: ChatCache, notify?: Notify): { hermes: Hermes; firstTry: Promise<string | undefined> } | undefined {
    const hermes = new Hermes(openPipe, cache.lastProfile() ?? "default", cache, notify);
    if (!hermes.snapshot.chats.length) return undefined;
    hermes.launchFailed = true;
    hermes.update({ status: "connecting" });
    const firstTry = hermes.reconnect().then(() => {
      const { status, closedReason } = hermes.snapshot;
      return hermes.closing || status === "connected" ? undefined : closedReason;
    });
    return { hermes, firstTry };
  }

  /** Hermes's scheduled jobs, each call naming its profile (cronJobs.ts). Hermes runs them; this only manages them. */
  readonly cron = new CronApi((method, pathAndQuery, body) => this.rest(method, pathAndQuery, body));

  /** Hermes's webhook routes, each call naming its profile (automations.ts). Hermes receives and runs the events. */
  readonly automations = new AutomationsApi((method, pathAndQuery, body) => this.rest(method, pathAndQuery, body));

  /** Hermes's kanban board, read for the tasks the shown profile's chats dispatched (kanban.ts, issue #287). */
  readonly kanban = new KanbanApi((method, pathAndQuery, body) => this.rest(method, pathAndQuery, body));
  private readonly kanbanWatch = new KanbanWatch({
    api: this.kanban,
    sessions: () => new Set(this.snapshot.chats.flatMap((c) => [c.id, ...(c.lineage ?? [])])),
    publish: (by) => this.placeTasks(by),
  });

  /**
   * Settings → Providers' subscription sign-ins and custom endpoints (accounts.ts, ADR 0133). Their changes queue with
   * the key changes, and the model list is read again after each.
   */
  readonly accounts = new AccountsApi({
    rest: (method, pathAndQuery, body) => this.rest(method, pathAndQuery, body),
    pipe: () => {
      if (!this.pipe || this.closing) throw new Error("Not connected to Hermes.");
      return this.pipe;
    },
    change: (profile, run) => this.oneProviderChangeAtATime(profile, run),
    settled: async (profile) => {
      await this.keyChanges.get(profile);
    },
  });

  /** Settings → Model's reads and writes, for the profile shown (modelSettings.ts). */
  readonly modelSettings = new ModelSettingsApi(
    (method, pathAndQuery, body) => this.rest(method, pathAndQuery, body),
    () => this.profile,
  );

  /**
   * Settings → Toolsets' reads and writes (toolsets.ts). Each call names its profile. Turning speech-to-text on or off
   * changes what the Voice section reads, so its cached read is dropped.
   */
  readonly toolsets = new ToolsetsApi(
    // Only over a connection that is up: never a closed or dropped pipe.
    async (method, pathAndQuery, body) => {
      const pipe = this.closing ? undefined : this.connectedPipe();
      if (!pipe) throw new Error("Not connected to Hermes.");
      return JSON.parse(await this.relay(pipe, method, pathAndQuery, body));
    },
    async (profile) => {
      const pipe = this.closing ? undefined : this.connectedPipe();
      if (!pipe) throw new Error("Not connected to Hermes.");
      return pipe.toolsetGuards(profile);
    },
    (_profile, name) => {
      if (name === "stt") this.voiceChanged();
    },
    (method, params) => this.request(method, params),
    // What its write check found, which only Settings → Toolsets can learn (capabilities.ts `toolsetSwitches`).
    () => {
      const gen = this.generation;
      return (state, why) => this.capabilities.report(gen, "toolsetSwitches", state, why);
    },
  );
  /**
   * Settings → Voice's reads and writes (voiceSettings.ts, ADR 0115). Each call names its profile, and goes only over a
   * connection that is up. Its read of the voice set-up is always fresh; a save drops the chat panes' cached one.
   */
  readonly voiceSettings = new VoiceSettingsApi(
    (method, pathAndQuery, body) => this.connectedRest(method, pathAndQuery, body),
    (profile) => {
      const pipe = this.closing ? undefined : this.connectedPipe();
      if (!pipe) return Promise.reject(new Error("Not connected to Hermes."));
      return pipe.voiceSetup(profile);
    },
    () => this.voiceChanged(),
  );
  private voiceListeners = new Set<() => void>();
  /** Drops the cached voice set-up, and tells whoever shows it to read it again. */
  private voiceChanged() {
    this.voiceRead = undefined;
    for (const fn of this.voiceListeners) fn();
  }
  /** Called whenever the voice set-up may have changed on Hermes (a Voice or Toolsets save). */
  readonly onVoiceChange = (fn: () => void) => {
    this.voiceListeners.add(fn);
    return () => void this.voiceListeners.delete(fn);
  };
  /** Settings → Memory's reads and writes (memory.ts). Each call names the profile it is for. */
  readonly memory: MemoryApi = memoryApi({
    rpc: (method, params) => this.request(method, params),
    get: (pathAndQuery) => this.rest("GET", pathAndQuery),
    send: (method, pathAndQuery, body) => this.rest(method, pathAndQuery, body),
  });
  /**
   * Settings → Memory's external memory (memoryProviders.ts, ADR 0045). Each call names its profile, and goes only over a
   * connection that is up.
   */
  readonly memoryProviders = new MemoryProvidersApi((method, pathAndQuery, body) => this.connectedRest(method, pathAndQuery, body));
  /**
   * Importing transcripts (importTranscripts.ts, ADR 0031). Each call names its profile, and goes only over a
   * connection that is up, so a call made before a sign-out or profile switch never reaches another server or profile.
   */
  readonly imports = {
    send: (profile: string, chats: PlannedChat[]) => sendImport(this.connectedRest, profile, chats),
    onServer: (profile: string, ids: string[]) => readBack(this.connectedRest, profile, ids),
  };

  private connectedRest = async (method: RestMethod, pathAndQuery: string, body?: unknown): Promise<unknown> => {
    const pipe = this.closing ? undefined : this.connectedPipe();
    if (!pipe) throw new Error("Not connected to Hermes.");
    return JSON.parse(await this.relay(pipe, method, pathAndQuery, body));
  };

  /**
   * Puts chats just imported into the list, as Settled (their Source is a transcript file), even if they are older than
   * the month the list shows, so they can be opened (`reveal`). Only for the profile they went to.
   */
  revealImported(profile: string, chats: { id: string; title: string; startedAt?: number }[]) {
    if (profile !== this.profile) return;
    for (const c of chats)
      this.reveal({ chatId: c.id, title: c.title, source: "import", settled: true, updatedAt: (c.startedAt ?? Date.now() / 1000) * 1000, snippet: [] });
  }

  /**
   * Settings → MCP servers' reads and writes (mcp.ts, ADR 0121). Each call names its profile, and goes only over a
   * connection that is up. An edit goes to Rust, which writes Hermes's whole map; `no_mcp` comes from Rust's toolset
   * guards.
   */
  readonly mcp = new McpApi(
    (method, pathAndQuery, body) => this.connectedRest(method, pathAndQuery, body),
    async (profile, edit) => {
      const pipe = this.closing ? undefined : this.connectedPipe();
      if (!pipe) throw new Error("Not connected to Hermes.");
      if (!pipe.mcpEdit) throw new Error("Hermes Chat can't edit MCP servers over this connection. Remove the server and add it again instead.");
      return pipe.mcpEdit(profile, edit);
    },
    async (profile) => {
      const pipe = this.closing ? undefined : this.connectedPipe();
      if (!pipe) throw new Error("Not connected to Hermes.");
      return (await pipe.toolsetGuards(profile)).noMcp;
    },
  );

  /**
   * Settings → Gateways' reads and writes (gateways.ts, ADR 0073): a profile's Telegram and Discord settings. Each call
   * names its profile, and goes only over a connection that is up.
   */
  readonly gateways = new GatewaysApi((method, pathAndQuery, body) => this.connectedRest(method, pathAndQuery, body));

  /** Settings → Persona's reads and writes of a profile's SOUL.md (persona.ts). Each call names its profile. */
  readonly persona = new PersonaApi((method, pathAndQuery, body) => this.rest(method, pathAndQuery, body));
  /** Settings → Skills' reads and writes of a profile's skills (skills.ts). Each call names its profile. */
  readonly skills = new SkillsApi((method, pathAndQuery, body) => {
    // A switch or an edit can change which skills the composer offers, and their descriptions: read them again.
    if (method !== "GET") this.skillsRead = undefined;
    return this.rest(method, pathAndQuery, body);
  });
  /** The Clone profile dialog's profile list, create and delete (profileClone.ts, ADR 0074). Each call names its profiles. */
  readonly profileClone = new ProfileCloneApi((method, pathAndQuery, body) => this.rest(method, pathAndQuery, body), this.persona, this.skills);

  /**
   * What this Hermes server can do, for Connection diagnostics and the screens that depend on it (capabilities.ts,
   * ADR 0044). Its checks only read, through the connection in use, and it is kept in memory for this sign-in only. A
   * write whose capability Hermes lacks is refused here, before it is sent.
   */
  readonly capabilities = new CapabilityStore(
    {
      get: (pathAndQuery, maxBytes) => this.restGet(pathAndQuery, maxBytes, false),
      rpc: (method, params) => this.request(method, params, undefined, false),
    },
    () => this.generation,
  );

  /** The profile whose chats are shown. */
  get profile(): string {
    return this.snapshot.profile;
  }

  /**
   * Opens a pipe and waits for `gateway.ready`. Used by `connect` and to reconnect; on failure the pipe is closed and
   * the error thrown.
   */
  async dial(): Promise<void> {
    await this.droppedClosing;
    // Closed meanwhile: from here to the opening below runs at once, so a later close finds `abortDial` set.
    if (this.closing) throw new Error("Closed by the app.");
    const gen = ++this.generation;
    const ready = new Promise<Record<string, unknown>>((resolve) => (this.onReady = resolve));
    // Set as soon as the pipe closes or the app gives up, even after gateway.ready has arrived.
    let failure: Error | undefined;
    // Giving up also stops Rust opening the connection, which has no other way to end early.
    const stop = new AbortController();
    const failed = new Promise<never>(
      (_, reject) =>
        (this.abortDial = (e) => {
          stop.abort();
          reject((failure ??= e));
        }),
    );
    failed.catch(() => {}); // Raced below, once the pipe is open.
    let up = false;
    let pipe: Pipe | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let readyPayload: Record<string, unknown> = {};
    const profile = this.profile;
    try {
      pipe = await this.openPipe((e) => {
        if (gen !== this.generation) return;
        if (e.kind === "closed" && !up) this.abortDial?.(new Error(`The connection closed before Hermes was ready: ${e.reason}`));
        else this.handle(e);
      }, profile, stop.signal);
      pipe.attempt?.ready();
      const payload = await Promise.race([
        ready,
        failed,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("Hermes didn't send gateway.ready in time.")), READY_TIMEOUT_MS);
        }),
      ]);
      if (failure) throw failure;
      if (payload.session_authority) throw new ProtocolMismatchError();
      readyPayload = payload;
      pipe.attempt?.connected();
    } catch (e) {
      // `close()` gives up a dial on purpose: a stop, not a failure.
      if (this.closing) pipe?.attempt?.stopped();
      else pipe?.attempt?.failed(e);
      this.generation++;
      await pipe?.close().catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
      this.onReady = this.abortDial = undefined;
    }
    up = true;
    this.pipe = pipe;
    this.pipeProfile = profile;
    this.lastHeard = Date.now();
    this.heartbeat = setInterval(() => this.beat(), PING_EVERY_MS);
    this.update({ status: "connected", closedReason: undefined, route: pipe.route, unsecure: isUnsecure(pipe.route) });
    this.kanbanWatch.start();
    // Without this, Hermes never sends this connection an Approval (research doc §6). Its answer lists the requests
    // Hermes may send, which is how diagnostics knows Approvals are there.
    const told = this.request("client.capabilities", { server_requests: true });
    this.track(told);
    // Checks start a little later, once the chat list has loaded (capabilities.ts).
    this.capabilities.connected(gen, profile, readyPayload, told);
  }

  /** Tries to connect again now, after a drop or from Offline, and keeps retrying on its own if that fails. */
  reconnect(): Promise<void> {
    if (!this.redialing) this.failedTries = 0;
    return this.redial();
  }

  /**
   * Closes the connection and opens it again, as a drop would but on purpose, so a connection with several routes can
   * go back to a preferred one (routes.ts `PreferredRoutes`, ADR 0120). Only while connected and quiet: no reply
   * running, no Approval waiting, no message sending or queued, no chat loading. A Failed message, which waits on the owner, doesn't hold it. Resolves to whether it moved.
   */
  async reroute(reason: string): Promise<boolean> {
    if (this.closing || this.snapshot.status !== "connected" || this.redialing) return false;
    const busy =
      this.submitting.size > 0 ||
      this.resuming.size > 0 ||
      this.snapshot.chats.some((c) => c.running || c.loading || c.items.some((i) => (isOutgoing(i) && i.outgoing.state === "sending") || isWaiting(i))) ||
      Object.values(this.snapshot.queues).some((q) => q.items.length > 0);
    if (busy) return false;
    this.detach(reason);
    await this.reconnect();
    return true;
  }

  /**
   * The model providers the shown profile's Hermes can use now, and those it can take an API key for (setup.ts).
   * A server without `GET /api/env` says so in `unsupported`, and the keys are set on the server instead.
   */
  async providerSetup(): Promise<ProviderSetup> {
    const profile = this.profile;
    const query = new URLSearchParams({ profile });
    // Each read is bounded, so setup never waits on a Hermes that stopped answering.
    const options = await timeLimit(this.request("model.options", { profile }), MODELS_TIMEOUT_MS)
      .catch(() => timeLimit(this.rest("GET", `api/model/options?${query}`), MODELS_TIMEOUT_MS))
      .catch(() => undefined);
    const ready = readyProviders(options);
    let answered = false;
    const env = this.rest("GET", `api/env?${query}`).finally(() => (answered = true));
    env.catch(() => {});
    let rows: unknown;
    try {
      rows = await timeLimit(env, PROVIDERS_TIMEOUT_MS);
    } catch (e) {
      // Only a route the server doesn't have means it can't take keys from here; any other failure is worth trying again.
      if (!answered || !isNoRoute(failureOf(e))) throw e;
      return { keys: [], ready, unsupported: (e as Error).message };
    }
    return { keys: providerKeys(rows), ready };
  }

  /**
   * Gives the shown profile's Hermes a model provider's API key (`Pipe.saveProviderKey`), then reads its model list
   * again, so the new provider's models can be picked.
   */
  async saveProviderKey(envVar: string, key: string): Promise<SavedKey> {
    const profile = this.profile;
    return this.oneProviderChangeAtATime(profile, (pipe) => pipe.saveProviderKey(profile, envVar, key));
  }

  /**
   * Removes a model provider's API key from the shown profile's Hermes (`Pipe.removeProviderKey`), then reads its model
   * list again, so the model picker stops offering that provider.
   */
  async removeProviderKey(envVar: string): Promise<void> {
    const profile = this.profile;
    return this.oneProviderChangeAtATime(profile, (pipe) => pipe.removeProviderKey(profile, envVar));
  }

  /**
   * Resolves once every key change sent for the shown profile has settled. Settings → Providers can close and open
   * again while one still runs in Rust, and a list read before it lands would show the key as it was (ADR 0095).
   */
  async keyChangesSettled(): Promise<void> {
    await this.keyChanges.get(this.profile);
  }

  /** Per profile, the last provider change sent (a key, a sign-out, an endpoint), settled or not. */
  private readonly keyChanges = new Map<string, Promise<void>>();

  /**
   * Runs `change` once every provider change sent before it for `profile` has settled, so a save and a removal from two
   * openings of the screen reach Hermes in the order they were made, never interleaved. Then the models are read again.
   */
  private oneProviderChangeAtATime<T>(profile: string, change: (pipe: Pipe) => Promise<T>): Promise<T> {
    const run = async () => {
      if (!this.pipe) throw new Error("Not connected to Hermes.");
      try {
        return await change(this.pipe);
      } finally {
        // Also after a failure: one that timed out may have changed the key on the server anyway.
        if (this.snapshot.models?.profile === profile) this.update({ models: undefined });
        void this.loadModels();
      }
    };
    const before = this.keyChanges.get(profile) ?? Promise.resolve();
    const next = before.then(run, run);
    const settled = next.then(
      () => {},
      () => {},
    );
    this.keyChanges.set(profile, settled);
    void settled.then(() => this.keyChanges.get(profile) === settled && this.keyChanges.delete(profile));
    return next;
  }

  /** The server's profiles by name, as dashboard REST lists them. One sign-in covers them all (research doc). */
  async profiles(): Promise<string[]> {
    const res = (await this.rest("GET", "api/profiles")) as ProfileList;
    return res.profiles.map((p) => p.name);
  }

  /**
   * The shown profile's voice set-up: whether the server can transcribe and read aloud, and with which providers. Read
   * once per connection and profile; a failed read is tried again on the next call.
   */
  voiceSetup(): Promise<VoiceSetup> {
    const pipe = this.connectedPipe();
    if (!pipe) return Promise.reject(new Error("Not connected to Hermes."));
    const key = `${this.generation}/${this.profile}`;
    if (this.voiceRead?.key !== key) {
      const done = pipe.voiceSetup(this.profile);
      this.voiceRead = { key, done };
      done.catch(() => {
        if (this.voiceRead?.done === done) this.voiceRead = undefined;
      });
    }
    return this.voiceRead.done;
  }

  /**
   * The registry's server commands this Hermes lists for the shown profile (commands.ts). Read once per connection and
   * profile; a failed read is tried again on the next call.
   */
  serverCommands(): Promise<ServerCommandList> {
    if (!this.connectedPipe()) return Promise.reject(new Error("Not connected to Hermes."));
    const key = `${this.generation}/${this.profile}`;
    if (this.commandsRead?.key !== key) {
      const done = listServerCommands((method, params) => this.request(method, params), this.profile);
      this.commandsRead = { key, done };
      done.catch(() => {
        if (this.commandsRead?.done === done) this.commandsRead = undefined;
      });
    }
    return this.commandsRead.done;
  }

  /**
   * The skills the composer offers for the shown profile (skillCommands.ts): those Hermes's `commands.catalog` lists
   * that Settings → Skills shows as on for the profile and this app's chats. Undefined when Hermes can't list skills that
   * way, or it can't be told which are on. Read again after `SKILL_COMMANDS_FRESH_MS`, after a change from Settings →
   * Skills, or on a new connection or profile; a failed read is tried again on the next call.
   */
  skillCommands(): Promise<SkillCommands | undefined> {
    if (!this.connectedPipe()) return Promise.reject(new Error("Not connected to Hermes."));
    const key = `${this.generation}/${this.profile}`;
    const read = this.skillsRead;
    if (read?.key !== key || Date.now() - read.at > SKILL_COMMANDS_FRESH_MS) {
      const profile = this.profile;
      const done = Promise.all([listServerCommands((method, params) => this.request(method, params), profile), this.skills.list(profile)]).then(
        ([catalog, view]) => (catalog.skills ? offeredSkills(catalog.skills, view) : undefined),
      );
      const entry = { key, at: Date.now(), done };
      this.skillsRead = entry;
      done.catch(() => {
        if (this.skillsRead === entry) this.skillsRead = undefined;
      });
    }
    return this.skillsRead!.done;
  }

  /** Runs a server command in the chat's live session (commands.ts). Rejects if the chat isn't open on Hermes. */
  runCommand(chatId: string, def: CommandDef, arg: string): Promise<CommandResult> {
    const runtimeId = this.snapshot.chats.find((c) => c.id === chatId)?.runtimeId;
    if (!runtimeId) return Promise.reject(new Error("This chat isn't open on Hermes."));
    return runServerCommand((method, params) => this.request(method, params), runtimeId, def, arg);
  }

  /**
   * Sends `text` into the chat's running reply without stopping it, through the same `command.dispatch` as `/steer`
   * (ADR 0057). Once Hermes has taken it, it shows at the end of the chat marked as a steer: `"steered"`. `"not
   * running"`: Hermes had no reply to steer, or couldn't steer this one yet, and wants the words sent as a message
   * instead; nothing went. Rejects saying why Hermes didn't take it.
   */
  async steer(chatId: string, text: string): Promise<"steered" | "not running"> {
    const profile = this.profile;
    const res = await this.runCommand(chatId, STEER, text);
    if (res.kind === "send") return "not running";
    if (this.profile === profile)
      this.patchChat(chatId, (c) => ({ ...c, items: [...c.items, { kind: "user", id: nextId(c.items, "s"), text, steer: true }] }));
    return "steered";
  }

  /**
   * Asks Hermes a side question about the chat (`/btw`, ADR 0070). It shows at once, waiting, after the chat's items so
   * far, and gets the answer or why there is none; the chat's items and any reply running are left alone. Resolves
   * whether Hermes took it.
   */
  async askSideQuestion(chatId: string, question: string): Promise<boolean> {
    const id = `btw-${++this.sideAsked}`;
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    const runtimeId = chat?.runtimeId;
    const after = chat?.items.at(-1)?.id;
    this.patchSide(chatId, (qs) => [...qs, { id, question, after, state: "asking" as const }].slice(-SIDE_QUESTIONS_KEPT));
    if (!runtimeId) {
      this.patchSide(chatId, (qs) => qs.map((q) => (q.id === id ? { id, question, after, state: "failed", error: "This chat isn't open on Hermes." } : q)));
      return false;
    }
    const generation = this.generation;
    this.sideAwaiting.set(runtimeId, (this.sideAwaiting.get(runtimeId) ?? 0) + 1);
    try {
      const taskId = await askSideQuestion((method, params) => this.request(method, params), runtimeId, question);
      const early = this.earlySideAnswers.get(`${runtimeId} ${taskId}`);
      this.patchSide(chatId, (qs) => qs.map((q) => (q.id !== id ? q : early === undefined || q.state !== "asking" ? { ...q, taskId } : answered({ ...q, taskId }, early))));
      return true;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.patchSide(chatId, (qs) => qs.map((q) => (q.id === id && q.state === "asking" ? { id, question, after, state: "failed", error } : q)));
      return false;
    } finally {
      // Once no question on the session waits for its task id, no answer held for one can be claimed. `detach` has
      // already cleared both for a connection that dropped meanwhile.
      const left = (this.sideAwaiting.get(runtimeId) ?? 0) - 1;
      if (generation === this.generation && left > 0) this.sideAwaiting.set(runtimeId, left);
      else if (generation === this.generation) {
        this.sideAwaiting.delete(runtimeId);
        for (const key of this.earlySideAnswers.keys()) if (key.startsWith(`${runtimeId} `)) this.earlySideAnswers.delete(key);
      }
    }
  }

  /** Takes a side question out of view. An answer still to come for it is dropped. */
  dismissSideQuestion(chatId: string, id: string) {
    this.patchSide(chatId, (qs) => qs.filter((q) => q.id !== id));
  }

  private patchSide(chatId: string, fn: (qs: SideQuestion[]) => SideQuestion[]) {
    this.patchChat(chatId, (c) => {
      const sideQuestions = fn(c.sideQuestions ?? []);
      return { ...c, sideQuestions: sideQuestions.length ? sideQuestions : undefined };
    });
  }

  /** A `btw.complete`: the answer to the chat's side question with that task id, or one whose id is still on the way. */
  private sideAnswered(chat: Chat, taskId: string, text: unknown) {
    const qs = chat.sideQuestions ?? [];
    if (qs.some((q) => q.taskId === taskId)) this.patchSide(chat.id, (all) => all.map((q) => (q.taskId === taskId && q.state === "asking" ? answered(q, text) : q)));
    else if (this.sideAwaiting.has(chat.runtimeId!)) this.earlySideAnswers.set(`${chat.runtimeId} ${taskId}`, text);
  }

  /** Has Hermes transcribe a Dictation recording with the shown profile's speech-to-text provider. */
  transcribe(audio: Uint8Array, mime: string): Promise<Transcript> {
    const pipe = this.connectedPipe();
    return pipe ? pipe.transcribe(this.profile, audio, mime) : Promise.reject(new Error("Not connected to Hermes."));
  }

  /** Has Hermes read `text` aloud with the shown profile's text-to-speech provider. */
  speak(text: string): Promise<Speech> {
    const pipe = this.connectedPipe();
    return pipe ? pipe.speak(this.profile, text) : Promise.reject(new Error("Not connected to Hermes."));
  }

  private connectedPipe(): Pipe | undefined {
    return this.snapshot.status === "connected" ? this.pipe : undefined;
  }

  /**
   * Shows another profile's chats: its last synced list at once, then a fresh one once the connection is open again
   * for that profile. `switching` says so until that list is read, or why it can't be; only then is the profile
   * remembered for the next sign-in. Nothing the old profile's socket sends after the switch shows; requests on it
   * fail as in a drop. Hermes keeps running the old profile's replies, and switching back resumes
   * them with any Approval still waiting. Settling or marking read that the owner did in the old profile still goes
   * to it.
   */
  async switchProfile(name: string): Promise<void> {
    // Handing back the screen may take a moment; a profile picked meanwhile wins, even the one already shown.
    const pick = ++this.switchPick;
    if (name === this.profile) return;
    const releasing = this.releaseScreen();
    if (releasing) await releasing;
    if (pick !== this.switchPick || name === this.profile) return;
    const from = this.profile;
    // Busy now, still to be resumed after a drop or an earlier switch back, or being resumed.
    const busy = new Set([
      ...(this.busyIn.get(from) ?? []),
      ...this.resumeOnReconnect,
      ...this.resuming.keys(),
      ...this.snapshot.chats.filter((c) => c.running || c.items.some(isWaiting)).map((c) => c.id),
    ]);
    if (busy.size) this.busyIn.set(from, [...busy]);
    // Nothing the old profile's socket still sends shows in the new one. It is let go below, once writes already
    // started for the old profile have gone out, and isn't used again, even if the owner comes straight back.
    if (this.pipe && this.pipeProfile !== name) {
      this.generation++;
      this.pipeProfile = undefined;
      // Nothing checked for the old profile's connection lands now; the new one checks again.
      this.capabilities.disconnected();
    }
    const unread = this.snapshot.chats.filter((c) => c.unread).length;
    const chats = this.snapshot.chats.filter((c) => !c.archived).map((c): ListedChat => ({ id: c.id, title: c.title, at: c.updatedAt, unread: !!c.unread, source: c.source }));
    // A chat started here may not be in the saved list yet, so its Failed messages keep the title it had.
    for (const c of this.snapshot.chats) this.titlesSeen.set(`${from} ${c.id}`, c.title);
    const failures = this.snapshot.chats.flatMap((c) =>
      c.items.flatMap((i): SeenFailure[] => (i.kind === "error" && i.id !== LOAD_ERROR_ID ? [{ chatId: c.id, title: c.title, itemId: i.id, mark: failureMark(i.text) }] : [])),
    );
    this.others.switched(from, name, this.listedAt === undefined ? undefined : { unread, listedAt: this.listedAt, chats }, failures);
    this.listedAt = undefined;
    this.viewing.clear();
    this.readWhenBack.clear();
    this.staleItems.clear();
    this.resumeOnReconnect.clear();
    this.revealed.clear();
    this.kanbanWatch.reset();
    this.update({
      profile: name,
      chats: withOutbox(this.cache.load(name), loadOutbox(this.cache, name)),
      olderPulled: this.cache.olderPulled(name),
      archivedListed: false,
      syncError: undefined,
      models: undefined,
      switching: { from },
      queues: loadQueues(this.cache, name),
      branches: this.cache.loadBranches(name),
      branchNews: undefined,
    });
    // A reconnect under way may be opening the old profile's socket.
    await this.redialing;
    if (this.profile !== name || this.closing) return;
    if (this.pipe && this.pipeProfile === name) return void this.sync();
    if (this.pipe) this.detach(`Switching to the ${name} profile.`);
    await this.reconnect();
  }

  /**
   * Checks the profiles not shown for Unread chats, over dashboard REST and without switching the socket, and asks
   * Hermes which sessions are working or waiting in any profile (`session.active_list`). Only reads: nothing is marked
   * read, resumed or answered. Runs at most every 15 seconds; the app calls it every `CHECK_EVERY_MS`, and more often
   * while the inbox is open. Results land in the snapshot's `others` and `live`.
   */
  checkOtherProfiles(): Promise<void> {
    return Promise.all([this.others.check(), this.checkLive()]).then(() => {});
  }

  /**
   * Reads the sessions live in the dashboard's process, in every profile, with what each is doing, and the shown
   * profile's background subagents (`subagent.roster`). A check for the same connection under way is joined; one asked
   * for within 15 seconds of the last is skipped. A server without either method is asked no more for it. An answer
   * from a connection since dropped is dropped too.
   */
  checkLive(): Promise<void> {
    const gen = this.generation;
    if (!this.connectedPipe() || (this.snapshot.live?.unsupported && this.rosterUnsupported)) return Promise.resolve();
    if (this.liveCheck?.gen === gen && (this.liveCheck.done || Date.now() - this.liveCheck.at < LIVE_MIN_GAP_MS - LIVE_SLACK_MS)) return this.liveCheck.done ?? Promise.resolve();
    const roster = this.readRoster(gen);
    const shown = this.waitingCards();
    const done = (async () => {
      try {
        if (this.snapshot.live?.unsupported) return;
        const res = obj(await this.request("session.active_list", {}));
        if (gen !== this.generation) return;
        this.closeUnwaited(shown, Array.isArray(res?.sessions) ? res.sessions : []);
        const sessions = (Array.isArray(res?.sessions) ? res.sessions : []).flatMap((r): (LiveSession & { key: string })[] => {
          const row = obj(r);
          const status = row?.status === "waiting" ? "waiting" : row?.status === "working" || row?.status === "starting" ? "working" : undefined;
          const chatId = typeof row?.session_key === "string" ? row.session_key : "";
          // A session this app started or resumed is known by its runtime id, which names its profile for sure.
          const mine = typeof row?.id === "string" ? this.runtimeOwners.get(row.id) : undefined;
          const at = typeof row?.last_active === "number" ? row.last_active * 1000 : 0;
          const key = `${typeof row?.id === "string" ? row.id : ""} ${chatId}`;
          return status && chatId ? [{ chatId, status, at, key, ...(mine?.chatId === chatId && { profile: mine.profile }) }] : [];
        });
        // Answers about sessions no longer live are dropped.
        const live = new Set(sessions.map((s) => s.key));
        for (const m of [this.sessionOwners, this.ownerTried]) for (const k of m.keys()) if (!live.has(k)) m.delete(k);
        // Rows don't say their profile. Each other session is looked up by its id in every profile, a few per check,
        // the ones tried longest ago first.
        const unknown = sessions
          .filter((s) => !s.profile && !this.sessionOwners.has(s.key))
          .sort((a, b) => (this.ownerTried.get(a.key) ?? 0) - (this.ownerTried.get(b.key) ?? 0))
          .slice(0, LOOKUPS_PER_CHECK);
        const profiles = unknown.length ? await this.profiles().catch(() => undefined) : undefined;
        for (const s of profiles ? unknown : []) {
          this.ownerTried.set(s.key, Date.now());
          const owner = await this.ownerOf(s.chatId, profiles!);
          if (owner !== undefined) this.sessionOwners.set(s.key, owner);
        }
        if (gen !== this.generation) return;
        const placed = sessions.map(({ key, ...s }): LiveSession => {
          const owner = s.profile ? undefined : this.sessionOwners.get(key);
          return owner ? { ...s, ...owner } : s;
        });
        this.update({ live: { sessions: placed, checkedAt: Date.now() } });
      } catch (e) {
        if (gen !== this.generation) return;
        if (e instanceof RpcError && e.code === NO_SUCH_METHOD) this.update({ live: { sessions: [], unsupported: true } });
        else this.update({ live: { sessions: this.snapshot.live?.sessions ?? [], checkedAt: this.snapshot.live?.checkedAt, error: (e as Error).message } });
      } finally {
        // The roster is placed against what the same check found live, so a wake turn under way is seen with it.
        await roster;
        this.placeRoster();
        if (this.liveCheck?.gen === gen) this.liveCheck.done = undefined;
      }
    })();
    this.liveCheck = { gen, at: Date.now(), done };
    return done;
  }

  /** The waiting Approval cards in Hermes's own approval queue (`queuedApprovals`), by their chat's runtime session. */
  private waitingCards(): Map<string, Set<string>> {
    const shown = new Map<string, Set<string>>();
    for (const c of this.snapshot.chats) {
      const ids = c.items.filter((i) => isWaiting(i) && this.queuedApprovals.has(i.requestId)).map((i) => i.id);
      if (c.runtimeId && ids.length) shown.set(c.runtimeId, new Set(ids));
    }
    return shown;
  }

  /**
   * Closes the cards in `shown` whose session `session.active_list` doesn't list as `waiting`: Hermes has no request
   * open for it, so none of its Approvals waits. Hermes withdraws a card with `request.cancel`, but not one another
   * Hermes app answered in a response frame (#318). `shown` is from before the list was asked for, so a card that
   * arrived since stays.
   */
  private closeUnwaited(shown: Map<string, Set<string>>, rows: unknown[]) {
    const waiting = new Set(rows.map(obj).flatMap((r) => (r?.status === "waiting" ? [r.id] : [])));
    for (const [runtimeId, ids] of shown) {
      const chat = this.snapshot.chats.find((c) => c.runtimeId === runtimeId);
      if (chat && !waiting.has(runtimeId)) this.patchChat(chat.id, (c) => ({ ...c, items: endWaitingApprovals(c.items, "not waiting", (i) => ids.has(i.id)) }));
    }
  }

  /**
   * Reads which of the shown profile's chats have background subagents running (`subagent.roster`), by stored session
   * id, into `roster`. A read that fails or takes longer than `LIVE_MIN_GAP_MS` keeps the one before; a Hermes without
   * the method is asked no more.
   */
  private async readRoster(gen: number): Promise<void> {
    if (this.rosterUnsupported) return;
    const profile = this.profile;
    try {
      // Bounded, as the check waits for it: a slow store on Hermes's side would otherwise hold every later check.
      const res = obj(await timeLimit(this.request("subagent.roster", { profile }), LIVE_MIN_GAP_MS));
      if (gen !== this.generation || profile !== this.profile) return;
      const counts = new Map<string, number>();
      for (const r of Array.isArray(res?.sessions) ? res.sessions : []) {
        const row = obj(r);
        if (typeof row?.session_id === "string" && typeof row.subagents === "number" && row.subagents > 0) counts.set(row.session_id, row.subagents);
      }
      this.roster = { gen, profile, counts };
    } catch (e) {
      if (e instanceof RpcError && e.code === NO_SUCH_METHOD) this.rosterUnsupported = true;
    }
  }

  /**
   * Gives each chat with no Subagents tree here the roster work Hermes counts for its id or any segment of its lineage
   * (`nextRoster`), with whether a live session shows it on a turn. While any chat has some, the next check comes
   * `LIVE_MIN_GAP_MS` after the last one started, so the work ending and the wake turn are seen promptly, and placing
   * it again after a chat list read doesn't put that check off.
   */
  private placeRoster() {
    const r = this.roster;
    if (!r || r.gen !== this.generation || r.profile !== this.profile) return;
    const now = Date.now();
    const working = new Set((this.snapshot.live?.sessions ?? []).filter((l) => l.status === "working").map((l) => l.chatId));
    let changed = false;
    const chats = this.snapshot.chats.map((c) => {
      const ids = [c.id, ...(c.lineage ?? [])];
      const count = ids.reduce((n, id) => n + (r.counts.get(id) ?? 0), 0);
      const roster = c.subagents ? undefined : nextRoster(c.roster, count, ids.some((id) => working.has(id)), now);
      if (roster === c.roster) return c;
      changed = true;
      return { ...c, roster };
    });
    if (changed) this.update({ chats });
    clearTimeout(this.rosterTimer);
    const due = (this.liveCheck?.at ?? now) + LIVE_MIN_GAP_MS;
    this.rosterTimer = this.snapshot.chats.some((c) => c.roster) ? setTimeout(() => void this.checkLive(), Math.max(0, due - now)) : undefined;
  }

  /**
   * The one profile that has a stored session, by asking each for it (`GET /api/sessions/{id}?profile=`): its row's
   * title and source with it, null when more than one profile has it, and undefined when none does yet (a new chat is
   * stored with its first message) or a profile couldn't be asked, so it is looked up again later.
   */
  private async ownerOf(chatId: string, profiles: string[]): Promise<{ profile: string; title: string; source: Source } | null | undefined> {
    const found: { profile: string; title: string; source: Source }[] = [];
    let unsure = false;
    for (let i = 0; i < profiles.length; i += LOOKUP_AT_ONCE)
      await Promise.all(
        profiles.slice(i, i + LOOKUP_AT_ONCE).map(async (profile) => {
          try {
            const row = (await this.rest("GET", `${sessionPath(chatId)}?${new URLSearchParams({ profile })}`)) as SessionRow;
            found.push({ profile, title: listTitle(row), source: toSource(row.source) });
          } catch (e) {
            if (!(e as Error).message.includes("answered 404")) unsure = true;
          }
        }),
      );
    if (found.length > 1) return null;
    return unsure || !found.length ? undefined : found[0];
  }

  /**
   * Searches the words and titles of every chat in the profile, Active and Settled, however old. Archived chats are
   * left out, as they are from the list, unless `archived` asks for them too.
   */
  async search(text: string, opts: { archived?: boolean } = {}): Promise<Found[]> {
    return (await this.searchPage(text, opts)).found;
  }

  /**
   * `search`, for chat filters (chatFilter.ts): `sources` narrows it on the server, and `limit` is how many chats
   * Hermes is asked for. `capped`: Hermes answered as many as asked, so more chats may match.
   */
  async searchPage(text: string, { archived = false, sources, limit = SEARCH_LIMIT }: { archived?: boolean; sources?: Source[]; limit?: number } = {}): Promise<{ found: Found[]; capped: boolean }> {
    const q = text.trim();
    if (!q) return { found: [], capped: false };
    const profile = this.profile;
    const raw = rawSources(sources);
    const query = new URLSearchParams({ q, profile, limit: String(limit), exclude_sources: "cron", ...(raw && { sources: raw }) });
    const [res] = (await Promise.all([this.rest("GET", `api/sessions/search?${query}`), this.knownBotChats()])) as [{ results: SearchRow[] }, void];
    if (this.profile !== profile) throw new Error(`Switched to the ${this.profile} profile before the results came.`);
    const listed = new Map(this.snapshot.chats.map((c) => [c.id, c]));
    // Search rows don't say whether a chat is pinned, and the list leaves out pinned chats older than its month.
    const pinned = res.results.some((r) => !listed.has(r.id)) ? await this.pinnedIds(profile) : new Set<string>();
    const found = res.results
      .filter((r) => (archived || !this.isArchived(r)) && !this.deleted.has(r.id) && !this.isBotChatRow(profile, r))
      .map((r): Found => {
        const snippet = snippetParts(r.snippet ?? "");
        const role = r.role === "user" || r.role === "assistant" ? r.role : undefined;
        return { ...this.toFound(r, listed.get(r.id), !pinned.has(r.id)), snippet, ...(role && { role, find: findTerm(q, snippet) }) };
      });
    return { found, capped: res.results.length >= limit };
  }

  /**
   * Every pinned (Active) chat in the profile, archived or not, however old: each `GET /api/sessions` page carries all
   * of them (`include_pinned`), so one page of one row is enough.
   */
  private async pinnedIds(profile: string): Promise<Set<string>> {
    const query = new URLSearchParams({ profile, order: "recent", limit: "1", offset: "0", archived: "include", exclude_sources: "cron" });
    const res = (await this.rest("GET", `api/sessions?${query}`)) as SessionPage;
    if (this.profile !== profile) throw new Error(`Switched to the ${this.profile} profile before the results came.`);
    return new Set(res.sessions.filter((r) => r.pinned).map((r) => r.id));
  }

  /**
   * Every chat in the profile, however old, as dashboard REST lists them, most recent first, for a chat filter with
   * no words to search (chatFilter.ts). `capped`: the profile has more than the most pages read.
   */
  async browse({ archived, sources }: { archived: "exclude" | "only" | "include"; sources?: Source[] }): Promise<{ found: Found[]; capped: boolean }> {
    const profile = this.profile;
    await this.knownBotChats();
    const { rows, more } = await this.readList(profile, archived, -Infinity, rawSources(sources));
    if (this.profile !== profile) throw new Error(`Switched to the ${this.profile} profile before the chats came.`);
    const listed = new Map(this.snapshot.chats.map((c) => [c.id, c]));
    const seen = new Set<string>();
    const found = rows.flatMap((r): Found[] => {
      // Every page carries the pinned rows too, archived or not.
      if (seen.has(r.id) || this.deleted.has(r.id)) return [];
      seen.add(r.id);
      const archivedNow = this.isArchived(r);
      if (archived === "exclude" ? archivedNow : archived === "only" ? !archivedNow : false) return [];
      return [{ ...this.toFound(r, listed.get(r.id), !r.pinned), snippet: [] }];
    });
    return { found, capped: more };
  }

  /** A row of a search or a list as a found chat; the list's own copy, when it has the chat, says what it is called and whether it is Settled. */
  private toFound(r: SearchRow, c: Chat | undefined, settled: boolean): Omit<Found, "snippet"> {
    return {
      chatId: r.id,
      // The list's title, so a chat is called the same in both while the search index catches up with a rename.
      title: c?.title ?? listTitle(r),
      source: toSource(r.source, r.created_source),
      // A canonical local chat whose starting surface the row doesn't name can't be placed by source.
      ...(r.source === "local" && !localSurface(r.created_source) && { sourceUnknown: true }),
      settled: c?.settled ?? settled,
      ...(this.isArchived(r) && { archived: true }),
      updatedAt: Math.max(c?.updatedAt ?? 0, lastActive(r)),
      ...(r.model && { model: r.model }),
    };
  }

  /**
   * A chat in `profile` by its id, as Hermes stores it now (`GET /api/sessions/{id}?profile=`), to open from a chat
   * link (chatLinks.ts); the list's own copy says what it is called and whether it is Settled. Null when Hermes
   * answers that the profile has no such chat (deleted, or never there). Rejects when Hermes can't be asked.
   */
  async findChat(chatId: string, profile: string): Promise<Found | null> {
    let row: SessionRow & { pinned?: boolean | number; archived?: boolean | number };
    try {
      row = (await this.rest("GET", `${sessionPath(chatId)}?${new URLSearchParams({ profile })}`)) as typeof row;
    } catch (e) {
      if ((e as Error).message.includes("answered 404")) return null;
      throw e;
    }
    if (row?.id !== chatId) return null;
    const listed = profile === this.profile ? this.snapshot.chats.find((c) => c.id === chatId) : undefined;
    return { ...this.toFound({ ...row, archived: !!row.archived } as SearchRow, listed, !row.pinned), snippet: [] };
  }

  /**
   * The chats Hermes has working in `path` or a folder inside it, in every profile, from any Hermes client
   * (`GET /api/sessions?cwd_prefix=`, archived ones included). Only rows whose own `cwd` is inside `path` count. Rejects
   * when a profile can't be asked: a removal must not go ahead on a partial answer (ADR 0043).
   */
  async chatsWorkingIn(path: string): Promise<{ id: string; title: string; profile: string; cwd: string; active: boolean }[]> {
    const root = path.replace(/\/+$/, "");
    const within = (cwd: string) => cwd === root || cwd.startsWith(`${root}/`);
    const PAGE = 100;
    // A removal must not go ahead on part of the list: every page is read, and too many to read is a refusal.
    const MAX_PAGES = 50;
    const profiles = await this.profiles();
    const pages = await Promise.all(
      profiles.map(async (profile) => {
        const rows = new Map<string, SessionRow>();
        for (let offset = 0, n = 0; ; offset += PAGE, n++) {
          if (n >= MAX_PAGES) throw new Error(`The ${profile} profile has more than ${MAX_PAGES * PAGE} chats in this folder, too many to check.`);
          const q = new URLSearchParams({ cwd_prefix: root, archived: "include", limit: String(PAGE), offset: String(offset), profile });
          const page = (await this.rest("GET", `api/sessions?${q}`)) as SessionPage;
          if (!Array.isArray(page?.sessions) || typeof page.total !== "number") throw new Error(`Hermes's answer for the ${profile} profile wasn't a list of chats.`);
          // Pinned rows come with every page: each chat counts once.
          for (const r of page.sessions) rows.set(r.id, r);
          if (offset + PAGE >= page.total) break;
        }
        return [...rows.values()].flatMap((r) =>
          typeof r.cwd === "string" && within(r.cwd) ? [{ id: r.id, title: r.title || r.preview || "Untitled chat", profile, cwd: r.cwd, active: !!r.is_active }] : [],
        );
      }),
    );
    return pages.flat();
  }

  /** Puts a found chat in the list, if it isn't there yet, so it can be opened (`open`). */
  /**
   * The server's bots, one per profile, with each one's Bot Chat as `profiles.list` reports it, found by title on the
   * server (bots.ts, ADR 0066). Rejects with `BotModeUnsupportedError`, and Connection diagnostics says so, when this
   * Hermes has no Bot Mode.
   */
  async bots(): Promise<Bot[]> {
    const gen = this.generation;
    try {
      const bots = rosterOf(await this.request("profiles.list", {}));
      if (gen === this.generation) this.botChatIds = new Map(bots.map((b) => [b.profile, new Set(b.botChat ? [b.botChat.id, b.botChat.resolvedId] : [])]));
      return bots;
    } catch (e) {
      const unsupported =
        e instanceof BotModeUnsupportedError ? e : e instanceof RpcError && e.code === NO_SUCH_METHOD ? new BotModeUnsupportedError("This Hermes has no profiles.list, so it has no Bot Mode.") : undefined;
      if (!unsupported) throw e;
      this.capabilities.report(gen, "botMode", "unsupported", unsupported.message);
      throw unsupported;
    }
  }

  /**
   * Whether a stored session is a Bot Chat the roster named, or one opened here: in `profile`, or in any profile when
   * that isn't known. For what is live in another profile, whose rows the shown list doesn't hold.
   */
  isKnownBotChat(chatId: string, profile?: string): boolean {
    if (profile) return !!this.botChatIds.get(profile)?.has(chatId);
    for (const ids of this.botChatIds.values()) if (ids.has(chatId)) return true;
    return false;
  }

  /** A bot's picture, as a data URL, or none when it has none or Hermes sent something that isn't an image. */
  async botAvatar(profile: string): Promise<string | undefined> {
    const res = obj(await this.request("profiles.get_asset", { name: profile, asset: "avatar" }));
    const data = res?.found === true && typeof res.data === "string" ? res.data : "";
    return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data) ? data : undefined;
  }

  /**
   * Opens the shown profile's Bot Chat for `bot`: the one Hermes finds by title, or a new one only when it has none
   * (bots.ts `BotChats.open`). The chat is put beside the list, marked as a Bot Chat so the list and search leave it
   * out, and its stored id is returned for a pane to open. Nothing about it is kept for later opens.
   */
  async openBotChat(bot: Bot): Promise<string> {
    const profile = this.profile;
    if (bot.profile !== profile) throw new Error(`Switch to ${bot.profile} first.`);
    const { openId, registryId } = await this.botChats.open(profile, bot.name, !!bot.botChat);
    this.botChatIds.set(profile, new Set([...(this.botChatIds.get(profile) ?? []), registryId, openId]));
    if (this.profile !== profile) throw new Error(`Switched to the ${this.profile} profile before ${bot.name}'s Bot Chat opened.`);
    const listed = this.snapshot.chats.find((c) => c.id === openId);
    if (listed) {
      if (!listed.bot) this.patchChat(openId, (c) => ({ ...c, bot: true }));
    } else {
      this.revealed.add(openId);
      const updatedAt = bot.botChat?.lastActive || Date.now();
      this.update({ chats: [...this.snapshot.chats, { id: openId, title: BOT_CHAT_TITLE, source: "app", settled: true, bot: true, updatedAt, items: [] }] });
    }
    return openId;
  }

  /**
   * A listed row or search hit in one of the profile's Bot Chats. By its title: Hermes carries the title to a compressed
   * chat's newest segment, which is the row it lists and the hit it reports (research doc "Bot Mode"). And by the ids
   * the latest roster named, the registry row and its tip, for the lineage's other segments.
   */
  private isBotChatRow(profile: string, r: { id: string; title?: string | null; lineage_root?: string; _lineage_root_id?: string | null }): boolean {
    if (isBotChatTitle(r.title)) return true;
    const ids = this.botChatIds.get(profile);
    const root = r.lineage_root ?? r._lineage_root_id ?? undefined;
    return !!ids && (ids.has(r.id) || (!!root && ids.has(root)));
  }

  /**
   * Reads the roster once per connection, for the Bot Chats' ids, so search can leave them out before the Bots view
   * has ever opened. A Hermes without Bot Mode, or a read that fails, leaves only the title to go by.
   */
  private knownBotChats(): Promise<void> {
    const gen = this.generation;
    if (this.capabilities.get("botMode").state === "unsupported") return Promise.resolve();
    if (this.botChatsRead?.gen !== gen) this.botChatsRead = { gen, done: this.bots().then(() => {}, () => {}) };
    return this.botChatsRead.done;
  }

  reveal(found: Found) {
    if (this.snapshot.chats.some((c) => c.id === found.chatId)) return;
    const { chatId: id, title, source, settled, archived, updatedAt } = found;
    this.revealed.add(id);
    // A Bot Chat reached from the inbox stays out of the list, as one opened from its bot's row does (ADR 0066).
    this.update({ chats: [...this.snapshot.chats, { id, title, source, settled, archived, updatedAt, items: [], ...(isBotChatTitle(title) && { bot: true }) }] });
  }

  /**
   * The id of the message a search matched in a found chat, once its history has loaded. FTS5 cuts the snippet out of
   * the stored message and puts "..." where it cut, so the longest piece between cuts picks the message out; failing
   * that, the first message of its kind holding the `find` text.
   */
  locate(found: Found): string | undefined {
    const chat = this.snapshot.chats.find((c) => c.id === found.chatId);
    if (!chat || !found.role) return undefined;
    const flat = (t: string) => t.replace(/\s+/g, " ").toLowerCase();
    const pieces = flat(found.snippet.map((p) => p.text).join("")).split("...").map((t) => t.trim());
    const longest = pieces.reduce((a, b) => (b.length > a.length ? b : a), "");
    const messages = chat.items.flatMap((i) => (i.kind === found.role ? [{ id: i.id, text: flat(i.text) }] : []));
    const holding = (t: string) => t && messages.find((m) => m.text.includes(t));
    return (holding(longest) || holding(flat(found.find ?? "")) || undefined)?.id;
  }

  /**
   * Whether the app's window has the owner's focus. Out of focus, a reply finishing or an Approval arriving shows a
   * desktop notification, and the chat on screen isn't marked read; once the window is back in focus, it is.
   */
  setFocused(focused: boolean) {
    this.focused = focused;
    if (!focused) return;
    const back = [...this.readWhenBack];
    this.readWhenBack.clear();
    for (const chatId of back) if (this.isViewing(chatId)) this.markRead(chatId);
  }

  /** The chat is on screen in some pane. */
  private isViewing(chatId: string): boolean {
    for (const id of this.viewing.values()) if (id === chatId) return true;
    return false;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  /**
   * Calls `fn` each time the owner sends a message from this app (the composer, the queue, or Retry), with the profile
   * and chat it goes to, as it starts on its way. Returns a function that stops it.
   */
  onSend = (fn: (profile: string, chatId: string) => void) => {
    this.sendListeners.add(fn);
    return () => void this.sendListeners.delete(fn);
  };

  /**
   * Starts a Chat in this app. It is Active from the start, and pinned once Hermes has stored it (ADR 0002). `model`:
   * what it runs on, for this chat only; left out, it runs on the profile's model. `folder`: the server folder it
   * works in (its session `cwd`), checked by the caller first; Hermes quietly runs a chat in its own folder when it
   * can't use the one asked for, so the chat is refused unless Hermes says it took it. `instructions`: one hidden
   * message seeded before the owner's first, which the model reads and no Hermes client shows (ADR 0017).
   */
  async newChat(model?: ModelPick, start: { folder?: string; instructions?: string } = {}): Promise<string> {
    const { folder, instructions } = start;
    const profile = this.profile;
    const res = (await this.request("session.create", {
      profile,
      source: APP_SOURCE,
      // `cwd_explicit`: a deliberate pick, which beats a profile's configured `terminal.cwd` (`_completion_cwd`).
      ...(folder && { cwd: folder, cwd_explicit: true }),
      ...(instructions && { messages: [{ role: "user", content: instructions, display_kind: "hidden" }] }),
      // `SessionCreateParams`: each is this session's own override. `fast` left out keeps the profile's.
      ...(model && {
        model: model.model,
        provider: model.provider,
        ...(model.effort && { reasoning_effort: model.effort }),
        ...(model.fast !== undefined && { fast: model.fast }),
      }),
    })) as {
      session_id: string;
      stored_session_id: string;
      info?: unknown;
    };
    const cwd = (res.info as { cwd?: unknown } | undefined)?.cwd;
    if (folder && cwd !== folder) {
      // Not this chat: drop the session, and the hidden message Hermes stored with it, so nothing is left behind.
      void this.request("session.close", { session_id: res.session_id }).catch(() => {});
      if (instructions)
        void this.fencedDelete(res.stored_session_id, profile).catch(() => {});
      throw new Error(`Hermes didn't start it in ${folder}${typeof cwd === "string" && cwd ? `: it would have worked in ${cwd}` : ""}. Nothing was sent.`);
    }
    const chat: Chat = {
      model: pickFromInfo(res.info) ?? model,
      id: res.stored_session_id,
      runtimeId: res.session_id,
      title: "New chat",
      source: "app",
      settled: false,
      updatedAt: Date.now(),
      items: [],
      live: withLive(undefined, res.info),
    };
    // A new session's agent starts its counters from zero.
    this.usageFrom.set(res.session_id, countersOf((res.info as { usage?: unknown } | undefined)?.usage) ?? ZERO_COUNTERS);
    this.runtimeOwners.set(res.session_id, { profile: this.profile, chatId: chat.id });
    this.pinWanted.set(chat.id, true);
    this.update({ chats: [chat, ...this.snapshot.chats] });
    return chat.id;
  }

  /**
   * Opens a chat: one this connection hasn't resumed yet is resumed now and shows its stored history, and its Saved
   * copy meanwhile. If that fails the chat shows why, and the next open tries again. The chat is on screen until
   * `leave`: it is marked read on the server, and stays read while the owner is in it. Hermes counts a chat no client
   * has marked as read, and only marking it lets later activity show the dot. Out of focus, marking it waits until the
   * window is back. While not connected, the chat shows its Saved copy only; the app opens it again once connected.
   * `pane`: which pane shows it, when the app shows two chats side by side. Opening a chat in a pane takes the place
   * of the chat that pane showed before; the same chat may be open in both panes.
   */
  async open(chatId: string, pane = "main"): Promise<void> {
    if (!this.snapshot.chats.some((c) => c.id === chatId)) return;
    const before = this.viewing.get(pane);
    this.viewing.set(pane, chatId);
    if (before !== undefined && before !== chatId && !this.isViewing(before)) this.readWhenBack.delete(before);
    this.showSaved(chatId);
    if (this.snapshot.status !== "connected") return;
    this.seen(chatId);
    // A chat the list didn't bring totals for, such as an older one opened from a search, reads its own.
    if (!this.snapshot.chats.find((c) => c.id === chatId)?.usage) this.track(this.refreshUsage(chatId));
    try {
      await this.resume(chatId);
      if (this.isViewing(chatId)) this.tellShown(chatId);
    } catch (e) {
      // A reply sent meanwhile shares this resume and reports the failure itself.
      this.patchChat(chatId, (c) =>
        c.running ? c : { ...c, items: [...withoutLoadError(c.items), { kind: "error", id: LOAD_ERROR_ID, text: `Couldn't load this chat: ${(e as Error).message}` }] },
      );
    }
  }

  /**
   * Reads the models the profile can switch to into the snapshot's `models`: Hermes's own list over the socket
   * (`model.options`), else over dashboard REST, else a fallback list built around the model in use, which says why.
   * Hermes's list is read once per profile; a fallback is tried again on the next call. Only read on a connection open
   * for the profile shown, and dropped if that connection goes meanwhile: the app asks again once connected.
   */
  loadModels(): Promise<void> {
    const profile = this.profile;
    if (this.snapshot.models?.profile === profile && this.snapshot.models.source === "server") return Promise.resolve();
    if (!this.pipe || this.pipeProfile !== profile || this.snapshot.status !== "connected") return Promise.resolve();
    if (this.modelsLoading?.profile === profile) return this.modelsLoading.done;
    const gen = this.generation;
    const done: Promise<void> = this.readModels(profile)
      .then((models) => void (this.profile === profile && this.generation === gen && this.update({ models })))
      .finally(() => {
        if (this.modelsLoading?.done === done) this.modelsLoading = undefined;
      });
    this.modelsLoading = { profile, done };
    return done;
  }

  /**
   * Switches a chat to `pick`, for that chat only: the profile's default model, reasoning and fast mode stay as they
   * are. A chat not open on this connection is resumed first. During a reply Hermes applies it from the next turn.
   * Rejects if Hermes refuses, and the chat shows its model as before. An expensive model Hermes asks to confirm is
   * refused with its message; picking it again for the same chat confirms it.
   */
  async setModel(chatId: string, pick: ModelPick): Promise<void> {
    const before = this.snapshot.chats.find((c) => c.id === chatId)?.model;
    if (!this.snapshot.chats.some((c) => c.id === chatId)) throw new Error("This chat isn't in the list.");
    this.patchChat(chatId, (c) => ({ ...c, model: pick }));
    try {
      const sid = await this.resume(chatId);
      // Every write names the chat's session: without one, Hermes writes these keys to the profile's config. Given a
      // session it no longer holds, it refuses rather than falling back (`_SESSION_SCOPED_KEYS`).
      const set = (key: string, value: string, extra: Record<string, unknown> = {}) =>
        this.request("config.set", { session_id: sid, profile: this.profile, key, value, ...extra }) as Promise<ConfigSet>;
      if (before?.provider !== pick.provider || before?.model !== pick.model) {
        const confirmKey = `${chatId} ${modelKey(pick)}`;
        const confirmed = this.confirmModel === confirmKey;
        const res = await set("model", `${pick.model} --provider ${pick.provider} --session`, confirmed ? { confirm_expensive_model: true } : {});
        this.confirmModel = undefined;
        if (res?.confirm_required) {
          this.confirmModel = confirmKey;
          throw new Error(`${withoutStop(res.confirm_message || "Hermes asks to confirm this model, which costs more")}. Pick it again to use it.`);
        }
      }
      if (pick.effort && pick.effort !== before?.effort) await set("reasoning", pick.effort, { scope: "session" });
      if (pick.fast !== undefined && pick.fast !== before?.fast) await set("fast", pick.fast ? "fast" : "normal");
    } catch (e) {
      this.patchChat(chatId, (c) => (c.model === pick ? { ...c, model: before } : c));
      throw e;
    }
  }

  /**
   * Moves a chat's work to `folder` on the server (`session.cwd.set`), for that chat only. Hermes changes it only
   * while no reply is running, and only to a folder it can find; it says it worked only once Hermes answers with it.
   */
  async setFolder(chatId: string, folder: string): Promise<void> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("This chat isn't in the list.");
    if (chat.running) throw new Error("Wait for the reply to finish: Hermes changes the folder only between replies.");
    const sid = await this.resume(chatId);
    const res = (await this.request("session.cwd.set", { session_id: sid, profile: this.profile, cwd: folder })) as { cwd?: unknown } | undefined;
    if (res?.cwd !== folder) throw new Error(`Hermes didn't move it to ${folder}${typeof res?.cwd === "string" ? `: it works in ${res.cwd}` : ""}.`);
  }

  /**
   * What a branch from the message `itemId` would hold, read from the chat's stored rows (ADR 0027): the messages it
   * copies, the tool calls whose results it leaves out, the Server files those messages refer to and whether each is
   * still there, and the model it will run on. Rejects with why no branch can be made from there now.
   */
  async previewBranch(chatId: string, itemId: string): Promise<BranchPreview> {
    const profile = this.profile;
    const { chat, rows, spine, index } = await this.branchBoundary(chatId, itemId, profile);
    const { refs, ...preview } = previewOf(chat, itemId, rows, spine, index);
    const files = await Promise.all(refs.map(async (path) => ({ path, state: await this.serverFileState(path, profile) })));
    if (this.profile !== profile) throw new Error("The profile changed before the preview was ready.");
    return { ...preview, files };
  }

  /**
   * Makes the branch `preview` describes: Hermes forks the chat into a new one holding its history up to that message
   * (`session.branch`), and the chat it branched from stays as it is. Nothing on the server is undone. The branch is
   * Active, runs on the parent's model, and is called `title` if the owner gave one (a Rename, once it's made), else
   * what Hermes names it. Resolves to the branch's chat id once Hermes has it and it holds what the preview said, with
   * what couldn't be set on it. If the connection drops before Hermes answers, it rejects with a
   * `BranchUnconfirmed`, and the chat list read once connected again settles it, by the idempotency key it went
   * with; branching from the same message again meanwhile returns the same branch.
   */
  async branch(preview: BranchPreview, title?: string, variant?: BranchVariant, whole?: string): Promise<{ chatId: string; warnings: string[] }> {
    const profile = this.profile;
    const { chat, spine, index } = await this.branchBoundary(preview.chatId, preview.itemId, profile);
    const count = index + 1;
    // An Edit or Regenerate checks the whole chat at this, the last read before the branch is made: a message another
    // client added after the point changes what the branch leaves out.
    if (whole !== undefined && spineKey(spine) !== whole) throw new Error(REPLAY_CHANGED);
    // Every row the preview showed, as it showed it: a message changed or removed anywhere before the point counts.
    if (count !== preview.count || spineKey(spine.slice(0, count)) !== preview.fingerprint)
      throw new Error("This chat changed since the preview opened. Open it again to see what the branch would hold.");
    // An earlier branch from this same point whose answer was lost: if Hermes made it, it's the one. Lost attempts
    // from other messages of the chat are left as they are.
    // An Edit or Regenerate is told apart from a plain branch from the same message, and from another edit of it.
    const earlier = this.snapshot.branches.attempts.find(
      (a) => a.parentId === chat.id && a.count === count && a.fingerprint === preview.fingerprint && a.variant?.kind === variant?.kind && a.variant?.pending?.text === variant?.pending?.text,
    );
    if (earlier) {
      const { found } = await this.findBranch(earlier, profile);
      if (found) return { chatId: await this.adoptListed(found, earlier, profile), warnings: ["Hermes had made the branch asked for before the connection dropped, so that one is open now."] };
    }
    const sid = await this.resume(chat.id);
    const generation = this.generation;
    const before = earlier ? earlier.before : (await this.listedSince(profile)).rows.filter((r) => r.parent_session_id === chat.id).map((r) => r.id);
    const attempt: BranchAttempt = {
      // The same key as the lost attempt from this point: Hermes answers it with the branch it made, if it did.
      key: earlier ? earlier.key : `branch-${newKey()}`,
      parentId: chat.id,
      parentTitle: chat.title,
      point: preview.point,
      count,
      fingerprint: preview.fingerprint,
      before,
      startedAt: Date.now(),
      ...(title?.trim() && { title: title.trim() }),
      ...(chat.model && { model: chat.model }),
      ...(variant && { variant }),
    };
    // Checked again just as the call goes: a reply may have started, or the connection or profile changed, while the
    // list was read. A runtime id means nothing on another connection.
    const now = this.snapshot.chats.find((c) => c.id === chat.id);
    const blocked =
      this.profile !== profile
        ? "The profile changed meanwhile. Nothing was sent."
        : this.generation !== generation || now?.runtimeId !== sid
          ? "The connection to Hermes changed meanwhile. Nothing was sent; branch again."
          : now
            ? branchBlocked(now, this.snapshot.status === "connected")
            : "This chat isn't in the list.";
    if (blocked) throw new Error(blocked);
    // Kept before it goes, so a restart or a dropped connection can still find what it made.
    this.updateBranches(profile, (b) => ({ ...b, attempts: [...b.attempts.filter((a) => a.key !== attempt.key), attempt] }));
    let res: BranchAnswer;
    try {
      res = (await this.request("session.branch", { session_id: sid, count, idempotency_key: attempt.key })) as BranchAnswer;
    } catch (e) {
      if (e instanceof ConnectionLostError) throw new BranchUnconfirmed();
      // Refused before Hermes stored anything: no such method, or nothing to branch.
      if (e instanceof RpcError && (e.code === NO_SUCH_METHOD || e.code === 4008)) {
        this.dropAttempt(profile, attempt.key);
        if (e.code === NO_SUCH_METHOD) throw new Error("This Hermes server can't branch chats: it has no session.branch. Updating Hermes may add it.");
        throw e;
      }
      // Other failures can come after Hermes stored the branch, as `agent init failed on branch` does.
      const why = (e as Error).message;
      let result: { found?: SessionRow; sure: boolean } = { sure: false };
      if (this.profile === profile) result = await this.findBranch(attempt, profile).catch(() => ({ sure: false }));
      if (result.found) return { chatId: await this.adoptListed(result.found, attempt, profile), warnings: [`Hermes made the branch but said: ${why}`] };
      if (result.sure) {
        this.dropAttempt(profile, attempt.key);
        throw e;
      }
      // Kept, so the chat list settles it later, and branching from here again asks with the same key.
      throw new Error(`Hermes said: ${why}. Hermes Chat couldn't tell whether it made the branch anyway; it checks the chat list again, and branching from here again won't make a second one.`);
    }
    const generation2 = this.generation;
    // Read back as stored, the same way the parent was read: the branch must hold exactly the rows the preview showed.
    let check: SpineRow[] | Error;
    try {
      check = spineOf(await this.storedRows(res.stored_session_id, profile));
    } catch (e) {
      check = e as Error;
    }
    if (this.profile !== profile) {
      // Kept with its profile; listed as made here once the owner is back.
      if (!(check instanceof Error) && check.length === count && spineKey(check) === attempt.fingerprint) this.keepElsewhere(res.stored_session_id, attempt, profile);
      throw new Error("The profile changed before Hermes answered. The branch is in that profile's list.");
    }
    if (!(check instanceof Error) && (check.length !== count || spineKey(check) !== attempt.fingerprint)) {
      // Not the branch the owner looked at: it goes again, so nothing is left that the owner didn't ask for.
      this.dropAttempt(profile, attempt.key);
      void this.request("session.close", { session_id: res.session_id }).catch(() => {});
      const gone = await this.fencedDelete(res.stored_session_id, profile).then(
        () => true,
        () => false,
      );
      throw new Error(
        gone
          ? "Hermes copied a different part of this chat than the preview showed, so Hermes Chat deleted that branch again. Nothing else changed."
          : `Hermes copied a different part of this chat than the preview showed, and the branch it made, "${res.title}", couldn't be deleted. Delete it from the list.`,
      );
    }
    // The connection changed while the branch was read back: its runtime id means nothing now, so it opens afresh.
    const made =
      this.generation !== generation2 || this.snapshot.status !== "connected"
        ? { chatId: await this.adoptListed({ id: res.stored_session_id, title: res.title }, attempt, profile), warnings: [] as string[] }
        : await this.adopt(res, attempt, profile);
    if (check instanceof Error) made.warnings.unshift(`Hermes Chat couldn't read the branch back to check what it holds (${check.message}).`);
    return made;
  }

  /** The chat, its stored rows and branch spine, and where the spine has the message: the branch's boundary now. */
  private async branchBoundary(chatId: string, itemId: string, profile: string) {
    const before = this.snapshot.chats.find((c) => c.id === chatId);
    if (!before) throw new Error("This chat isn't in the list.");
    const blocked = branchBlocked(before, this.snapshot.status === "connected");
    if (blocked) throw new Error(blocked);
    const rows = await this.storedRows(chatId, profile);
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (this.profile !== profile || !chat) throw new Error("The profile changed meanwhile.");
    // A reply may have started meanwhile, in this app or another client.
    const still = branchBlocked(chat, this.snapshot.status === "connected");
    if (still) throw new Error(still);
    const spine = spineOf(rows);
    const at = locate(chat.items, itemId, spine);
    if ("error" in at) throw new Error(at.error);
    return { chat, rows, spine, index: at.index };
  }

  /**
   * What an Edit or Regenerate under the message `itemId` would make (ADR 0035): a branch through the owner's message
   * (the message itself for Edit, the one the reply answers for Regenerate), read as Branch from here reads it, with
   * the words to start from and what the branch leaves out. Rejects with why it can't be made now.
   */
  async previewReplay(chatId: string, itemId: string, kind: ReplayKind): Promise<ReplayPreview> {
    const profile = this.profile;
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("This chat isn't in the list.");
    const blocked = replayBlocked(chat, this.snapshot.status === "connected");
    if (blocked) throw new Error(blocked);
    const target = replayTarget(chat.items, itemId, kind);
    if ("error" in target) throw new Error(target.error);
    const { chat: now, rows, spine, index } = await this.branchBoundary(chatId, target.userId, profile);
    const stored = spine[index].text;
    const cannot = cannotResend(stored, kind);
    if (cannot) throw new Error(cannot);
    const { refs, ...branch } = previewOf(now, target.userId, rows, spine, index);
    const files = await Promise.all(refs.map(async (path) => ({ path, state: await this.serverFileState(path, profile) })));
    if (this.profile !== profile) throw new Error("The profile changed before the preview was ready.");
    const turn = turnAt(spine, index);
    const answer = target.replyId && now.items.find((i) => i.id === target.replyId);
    return {
      kind,
      branch: { ...branch, files },
      stored,
      ...splitRefs(stored),
      later: laterOf(spine, index),
      laterTools: rows.filter((r) => r.role === "tool" && r.id > spine[index].id).length,
      ...(answer && answer.kind === "assistant" && { answer: excerpt(answer.text, 160) }),
      spine: spineKey(spine),
      turn,
      rootId: variantRoot(this.snapshot.branches.links, chatId, turn),
    };
  }

  /**
   * Makes the Edit or Regenerate `preview` describes. The chat it was asked from stays as it is. Hermes branches it
   * through the owner's message; the branch's copy of that message is taken back (`session.undo` on the branch), and
   * the message goes into the branch again: `words` with the message's files for an Edit, the message as stored for a
   * Regenerate. Rejects, and makes nothing, if the chat changed since the preview was read, here or in another client.
   * Resolves to the branch and what went wrong after it was made; a branch whose message didn't go yet says so at its
   * top, with a way to finish it.
   */
  async replay(preview: ReplayPreview, words?: string): Promise<{ chatId: string; warnings: string[] }> {
    const profile = this.profile;
    const text = preview.kind === "edit" ? withRefs(preview.refs, words ?? "") : resendText(preview.stored);
    if (preview.kind === "edit" && !words?.trim()) throw new Error("The edited message is empty. Type what to send, or Cancel.");
    const chat = this.snapshot.chats.find((c) => c.id === preview.branch.chatId);
    if (!chat) throw new Error("This chat isn't in the list.");
    const blocked = replayBlocked(chat, this.snapshot.status === "connected");
    if (blocked) throw new Error(blocked);
    // The whole chat, not only the part copied: a message added after it by another client changes what's left out.
    // `branch` checks it again at its own last read, just before the branch is made.
    const { spine } = await this.branchBoundary(chat.id, preview.branch.itemId, profile);
    if (spineKey(spine) !== preview.spine) throw new Error(REPLAY_CHANGED);
    const count = preview.branch.count;
    // What the branch must hold before and after its copy is taken back, without model-switch markers: switching the
    // branch to the chat's model as it's made changes those (`withoutMarkers`).
    const variant: BranchVariant = {
      kind: preview.kind,
      rootId: preview.rootId,
      turn: preview.turn,
      pending: { text, prefix: spineKey(withoutMarkers(spine.slice(0, count - 1))), through: spineKey(withoutMarkers(spine.slice(0, count))) },
    };
    const made = await this.branch(preview.branch, undefined, variant, preview.spine);
    if (this.profile !== profile) return made;
    try {
      made.warnings.push(...(await this.finishReplay(made.chatId)));
    } catch (e) {
      made.warnings.push((e as Error).message);
    }
    return made;
  }

  /**
   * Sends the message an Edit or Regenerate is for into its branch, if it hasn't gone: the branch's copy of the
   * original is taken back first, if it's still there. Read from Hermes each time, so it can be asked again after a
   * dropped connection without sending twice. Resolves to what the owner should know; rejects with why it couldn't.
   */
  finishReplay(chatId: string): Promise<string[]> {
    // One at a time per branch: two panes asking at once would otherwise both take a message back.
    const running = this.finishing.get(chatId);
    if (running) return running;
    const p = this.finishReplayNow(chatId).finally(() => this.finishing.delete(chatId));
    this.finishing.set(chatId, p);
    return p;
  }

  private finishing = new Map<string, Promise<string[]>>();

  private async finishReplayNow(chatId: string): Promise<string[]> {
    const profile = this.profile;
    const pending = this.snapshot.branches.links[chatId]?.variant?.pending;
    if (!pending) return [];
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("This branch isn't in the list.");
    const blocked = replayBlocked(chat, this.snapshot.status === "connected");
    if (blocked) throw new Error(blocked);
    const keep = Number.parseInt(pending.prefix, 10);
    const sid = await this.resume(chatId);
    const generation = this.generation;
    // Without model-switch markers, as `pending` was worked out: the one stored after the copy goes with it.
    const read = async () => withoutMarkers(spineOf(await this.storedRows(chatId, profile)));
    // Checked after every wait, before anything is changed: the owner may have switched profile, the connection may
    // have changed, or a reply or another message may have started in the branch meanwhile. The words stay pending.
    const stillMine = () => {
      if (this.profile !== profile) throw new Error("The profile changed meanwhile. Nothing was sent; finish it from the top of the branch once you're back.");
      const now = this.snapshot.chats.find((c) => c.id === chatId);
      if (!now) throw new Error("This branch isn't in the list.");
      if (this.generation !== generation || now.runtimeId !== sid) throw new Error("The connection to Hermes changed meanwhile. Nothing was sent; finish it from the top of the branch.");
      const why =
        replayBlocked(now, this.snapshot.status === "connected") ??
        (this.submitting.has(chatId) ? "A message to this branch is on its way. Nothing else was sent; look at the branch before you finish it." : undefined);
      if (why) throw new Error(why);
    };
    let spine = await read();
    stillMine();
    const kept = (s: SpineRow[]) => s.length === keep && spineKey(s) === pending.prefix;
    if (spine.length === keep + 1 && spineKey(spine.slice(0, keep)) === pending.prefix) {
      // Only the very message the branch was made through is taken back: one another client changed stays.
      if (spineKey(spine) !== pending.through) {
        this.setVariant(profile, chatId, ({ pending: _, ...v }) => v);
        throw new Error("The branch's last message isn't the one it was made with any more, so Hermes Chat didn't take it back or send anything. Look at the branch before you go on.");
      }
      // The branch still holds its copy of the original message: take it back, in the branch only.
      try {
        await this.request("session.undo", { session_id: sid });
      } catch (e) {
        if (e instanceof RpcError && e.code === NO_SUCH_METHOD) {
          // A Hermes that can branch but not take a message back: the branch isn't what the owner asked for.
          const gone = await this.fencedDelete(chatId, profile).then(
            () => true,
            () => false,
          );
          if (gone) {
            this.updateBranches(profile, (b) => {
              const { [chatId]: _, ...links } = b.links;
              return { ...b, links };
            });
            this.update({ chats: this.snapshot.chats.filter((c) => c.id !== chatId) });
            this.saveList(profile, this.snapshot.chats);
          }
          throw new Error(
            `This Hermes server can't take a message back (it has no session.undo), so it can't edit or regenerate. ${gone ? "Hermes Chat deleted the branch it had made. Nothing else changed." : "Delete the branch it made from the list."}`,
          );
        }
        throw new Error(`Hermes didn't take back the branch's copy of your message (${(e as Error).message}). Nothing was sent; finish it from the top of the branch.`);
      }
      spine = await read();
      stillMine();
      if (!kept(spine)) {
        this.setVariant(profile, chatId, ({ pending: _, ...v }) => v);
        throw new Error("Hermes took back a different part of the branch than the one asked for, so Hermes Chat didn't send anything. Look at the branch before you go on.");
      }
    } else if (!kept(spine)) {
      // More is in it than when it was made: the message went already, or the owner went on in the branch.
      this.setVariant(profile, chatId, ({ pending: _, ...v }) => v);
      return ["The branch already has more in it than when it was made, so the message wasn't sent again."];
    }
    // Read once more just before it goes: nothing may have been added to the branch since it was checked.
    spine = await read();
    stillMine();
    if (!kept(spine)) throw new Error("Something was added to the branch meanwhile, so Hermes Chat didn't send anything. Look at the branch before you finish it.");
    // What the branch shows: its history before the message, whether the copy was taken back now or by an earlier try
    // whose answer was lost. The owner's messages kept are the ones before it; the copy and anything after it go.
    const shown = spine.filter((r) => r.role === "user" && !r.hidden).length;
    this.patchChat(chatId, (c) => {
      const at = c.items.map((i) => i.kind === "user" && !i.outgoing).reduce<number[]>((a, u, i) => (u ? [...a, i] : a), [])[shown];
      return at === undefined ? c : { ...c, items: c.items.slice(0, at) };
    });
    // A branch left with no messages has no Saved copy: the one kept would show the message taken back.
    const left = this.snapshot.chats.find((c) => c.id === chatId)?.items.some((i) => i.kind !== "error" && i.kind !== "approval" && !isOutgoing(i));
    if (left) this.saveTranscript(chatId);
    else this.cache.deleteTranscript(profile, chatId);
    // From here the message is the outbox's: a failed send shows in the branch with Retry, as any message does.
    this.setVariant(profile, chatId, ({ pending: _, ...v }) => v);
    const sent = await this.send(chatId, pending.text);
    return sent.delivery === "unsent" ? ["The message didn't go to the branch. It's in the branch, marked Not sent, with Retry."] : [];
  }

  /** Every stored row of a chat, oldest first, as dashboard REST pages them. */
  private async storedRows(chatId: string, profile: string): Promise<StoredBranchRow[]> {
    const rows: StoredBranchRow[] = [];
    for (let page = 0; page < BRANCH_MAX_PAGES; page++) {
      const query = new URLSearchParams({ profile, order: "oldest", limit: String(BRANCH_PAGE_ROWS), offset: String(page * BRANCH_PAGE_ROWS), inline_images: "false" });
      const got = ((await this.rest("GET", `${sessionPath(chatId)}/messages?${query}`)) as { messages?: StoredBranchRow[] }).messages ?? [];
      rows.push(...got.filter((r) => Number.isSafeInteger(r?.id)));
      if (got.length < BRANCH_PAGE_ROWS) return rows;
    }
    throw new Error(`This chat has more than ${(BRANCH_MAX_PAGES * BRANCH_PAGE_ROWS).toLocaleString("en")} stored rows, too many for Hermes Chat to check where a branch would start.`);
  }

  /** Whether a Server file a message refers to is still there, by listing its folder. A relative path can't be checked. */
  private async serverFileState(path: string, profile: string): Promise<"there" | "missing" | "unknown"> {
    const cut = path.lastIndexOf("/");
    if (!path.startsWith("/") || cut < 0) return "unknown";
    try {
      const res = obj(await this.rest("GET", `api/fs/list?${new URLSearchParams({ path: path.slice(0, cut) || "/", profile })}`));
      if (res?.error === "ENOENT" || res?.error === "ENOTDIR") return "missing";
      if (res?.error || !Array.isArray(res?.entries)) return "unknown";
      return (res.entries as { name?: unknown; isDirectory?: unknown }[]).some((e) => e.name === path.slice(cut + 1) && !e.isDirectory) ? "there" : "missing";
    } catch {
      return "unknown";
    }
  }

  /**
   * The profile's sessions, archived ones too, newest made first, back to `since` (Unix ms, this computer's clock, less
   * an hour for the server's), at most `BRANCH_LIST_PAGES` pages. `complete`: the list reached back that far, or ended.
   */
  private async listedSince(profile: string, since = Date.now()): Promise<{ rows: SessionRow[]; complete: boolean }> {
    const rows: SessionRow[] = [];
    const cutoff = since / 1000 - 3600;
    for (let page = 0; page < BRANCH_LIST_PAGES; page++) {
      const query = new URLSearchParams({ profile, order: "created", archived: "include", limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), exclude_sources: "cron" });
      const res = (await this.rest("GET", `api/sessions?${query}`)) as SessionPage;
      rows.push(...res.sessions);
      // Every page ends with the pinned rows, out of order; only the others say how far back the list has reached.
      if (res.sessions.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= res.total || res.sessions.some((r) => !r.pinned && (r.started_at ?? Infinity) < cutoff))
        return { rows, complete: true };
    }
    return { rows, complete: false };
  }

  /**
   * The branch an attempt made, if Hermes lists one: a branch of the parent it didn't list before whose first `count`
   * rows are the ones the preview showed. Another client's branch of the same chat from elsewhere doesn't match. `sure`:
   * the list was read far enough back, and no more than one matched, so none found means none was made.
   */
  private async findBranch(a: BranchAttempt, profile: string): Promise<{ found?: SessionRow; sure: boolean }> {
    const links = this.profile === profile ? this.snapshot.branches.links : this.cache.loadBranches(profile).links;
    const { rows, complete } = await this.listedSince(profile, a.startedAt);
    const fresh = [...new Map(rows.map((r) => [r.id, r])).values()].filter(
      (r) => r.parent_session_id === a.parentId && !a.before.includes(r.id) && !links[r.id] && !this.deleted.has(r.id),
    );
    // Exactly the rows asked for, and no more: a longer branch from a later message shares the same first rows.
    const exact: SessionRow[] = [];
    let possible = 0;
    for (const r of fresh) {
      const spine = spineOf(await this.storedRows(r.id, profile));
      if (spine.length < a.count || spineKey(spine.slice(0, a.count)) !== a.fingerprint) continue;
      if (spine.length === a.count) exact.push(r);
      else possible++;
    }
    // Only a search that reached back far enough can say a match is the only one, or that there is none.
    if (complete && exact.length === 1 && !possible) return { found: exact[0], sure: true };
    return { sure: complete && !exact.length && !possible };
  }

  /**
   * Settles the branches asked for whose answer was lost, from the chat list: the one Hermes lists is the branch, kept
   * as one made here. Once Hermes has forgotten the key, one not listed was never made; when the list can't say for
   * sure, the owner is told to look.
   */
  private async checkBranchAttempts(profile: string) {
    for (const a of this.snapshot.branches.attempts) {
      let result: { found?: SessionRow; sure: boolean };
      try {
        result = await this.findBranch(a, profile);
      } catch {
        continue;
      }
      if (this.profile !== profile) return;
      if (result.found) {
        const chatId = await this.adoptListed(result.found, a, profile);
        this.update({ branchNews: { text: `Hermes made the branch of "${a.parentTitle}" before the connection dropped. It's in the list.`, chatId, at: Date.now() } });
      } else if (Date.now() - a.startedAt > BRANCH_KEY_TTL_MS) {
        this.dropAttempt(profile, a.key);
        this.update({
          branchNews: {
            text: result.sure
              ? `Hermes didn't make the branch of "${a.parentTitle}". Nothing changed; branch again to try.`
              : `Hermes Chat couldn't tell whether Hermes made the branch of "${a.parentTitle}". Look for it in the list before branching again.`,
            at: Date.now(),
          },
        });
      }
    }
  }

  /** Keeps a branch Hermes answered with, opened on this connection, with the attempt's title and model. */
  private async adopt(res: BranchAnswer, a: BranchAttempt, profile: string): Promise<{ chatId: string; warnings: string[] }> {
    const chat: Chat = {
      id: res.stored_session_id,
      runtimeId: res.session_id,
      title: res.title || "Branch",
      source: "app",
      settled: false,
      updatedAt: Date.now(),
      items: historyItems(Array.isArray(res.messages) ? res.messages : []),
      model: pickFromInfo(res.info),
      live: withLive(undefined, res.info),
    };
    this.usageFrom.set(res.session_id, countersOf((res.info as { usage?: unknown } | undefined)?.usage) ?? ZERO_COUNTERS);
    this.runtimeOwners.set(res.session_id, { profile, chatId: chat.id });
    return { chatId: chat.id, warnings: await this.keepBranch(chat, a, profile) };
  }

  /** Keeps a branch found in the chat list, made by an attempt whose answer was lost. */
  private async adoptListed(row: Pick<SessionRow, "id" | "title" | "preview">, a: BranchAttempt, profile: string): Promise<string> {
    const chat: Chat = { id: row.id, title: listTitle(row), source: "app", settled: false, updatedAt: Date.now(), items: [] };
    await this.keepBranch(chat, a, profile);
    return chat.id;
  }

  /** Lists a branch as made here and Active, then gives it the attempt's model and title. Resolves to what failed. */
  private async keepBranch(chat: Chat, a: BranchAttempt, profile: string): Promise<string[]> {
    const link: BranchLink = { parentId: a.parentId, parentTitle: a.parentTitle, point: a.point, at: Date.now(), ...(a.variant && { variant: a.variant }) };
    // The owner switched profile meanwhile: the branch is kept as made here, Active, and listed when they're back.
    if (this.profile !== profile) {
      this.keepElsewhere(chat.id, a, profile);
      return [];
    }
    this.updateBranches(profile, (b) => ({ links: { ...b.links, [chat.id]: link }, attempts: b.attempts.filter((x) => x.key !== a.key) }));
    this.pinWanted.set(chat.id, true);
    this.revealed.add(chat.id);
    this.update({ chats: [chat, ...this.snapshot.chats.filter((c) => c.id !== chat.id)] });
    this.saveList(profile, this.snapshot.chats);
    // Both are fenced edits of the same session: the rename goes after the pin, or it would name a stale revision.
    const pinned = this.writePin(chat.id, profile);
    this.track(pinned);
    const warnings: string[] = [];
    // Hermes starts a branch on the profile's model, not the parent's.
    if (a.model && (a.model.model !== chat.model?.model || a.model.provider !== chat.model?.provider || (a.model.effort && a.model.effort !== chat.model?.effort) || (a.model.fast !== undefined && a.model.fast !== chat.model?.fast)))
      await this.setModel(chat.id, a.model).catch((e) => warnings.push(`It runs on the profile's model: Hermes didn't switch it to ${a.model!.model} (${(e as Error).message})`));
    if (a.title && a.title !== chat.title) await pinned;
    if (a.title && a.title !== chat.title)
      await this.rename(chat.id, a.title, this.snapshot.chats.find((c) => c.id === chat.id)?.title ?? chat.title).catch((e) =>
        warnings.push(`It keeps the name Hermes gave it: renaming it failed (${(e as Error).message})`),
      );
    // An Edit or Regenerate shows what its answer runs on: the model Hermes reports for the branch now.
    const model = this.snapshot.chats.find((c) => c.id === chat.id)?.model;
    if (a.variant && model && this.profile === profile) this.setVariant(profile, chat.id, (v) => ({ ...v, model }));
    return warnings;
  }

  /** A branch made for a profile no longer shown: kept as made here and Active, listed when the owner is back. */
  private keepElsewhere(chatId: string, a: BranchAttempt, profile: string) {
    const link: BranchLink = { parentId: a.parentId, parentTitle: a.parentTitle, point: a.point, at: Date.now(), ...(a.variant && { variant: a.variant }) };
    this.updateBranches(profile, (b) => ({ links: { ...b.links, [chatId]: link }, attempts: b.attempts.filter((x) => x.key !== a.key) }));
    this.pinWanted.set(chatId, true);
    this.track(this.writePin(chatId, profile));
  }

  /** Changes what a branch made by an Edit or Regenerate keeps about itself. */
  private setVariant(profile: string, chatId: string, change: (v: BranchVariant) => BranchVariant) {
    this.updateBranches(profile, (b) => {
      const l = b.links[chatId];
      return l?.variant ? { ...b, links: { ...b.links, [chatId]: { ...l, variant: change(l.variant) } } } : b;
    });
  }

  private dropAttempt(profile: string, key: string) {
    this.updateBranches(profile, (b) => ({ ...b, attempts: b.attempts.filter((a) => a.key !== key) }));
  }

  /**
   * Changes `profile`'s branches: the snapshot's while it is shown, else what this computer keeps for it, since the
   * owner may have switched profile while a branch was on its way.
   */
  private updateBranches(profile: string, change: (b: BranchStore) => BranchStore) {
    const store = change(this.profile === profile ? this.snapshot.branches : this.cache.loadBranches(profile));
    this.cache.saveBranches(profile, store);
    if (this.profile === profile) this.update({ branches: store });
  }

  /**
   * Reads the chat's tokens and cost from Hermes's stored session into its `usage`; on failure `usageError` says why. A
   * chat Hermes hasn't stored yet (one started here, before its first message) has none, and that isn't a failure.
   */
  async refreshUsage(chatId: string): Promise<void> {
    const profile = this.profile;
    if (this.snapshot.status !== "connected" || !this.snapshot.chats.some((c) => c.id === chatId)) return;
    try {
      const row = await this.rest("GET", `api/sessions/${encodeURIComponent(chatId)}?${new URLSearchParams({ profile })}`);
      if (this.profile !== profile) return;
      const read = chatUsageOf(row, Date.now());
      this.patchChat(chatId, (c) => ({ ...c, usage: newerChatUsage(c.usage, read), usageError: undefined }));
    } catch (e) {
      if (this.profile !== profile || (e as Error).message.includes("answered 404")) return;
      this.patchChat(chatId, (c) => ({ ...c, usageError: `Couldn't read usage from Hermes: ${(e as Error).message}` }));
    }
  }

  /** The owner has moved `pane` off the chat; unless another pane shows it, new activity in it shows the dot again. */
  leave(chatId: string, pane = "main") {
    if (this.viewing.get(pane) !== chatId) return;
    this.viewing.delete(pane);
    if (!this.isViewing(chatId)) this.readWhenBack.delete(chatId);
  }

  /** Checks local files the owner wants to attach: images up to 25 MB, other files up to 256 MB. */
  async checkAttachments(paths: string[]): Promise<AttachCheck> {
    if (!this.pipe) throw new Error("Not connected to Hermes.");
    const attachments: Attachment[] = [];
    const refused: string[] = [];
    for (const f of await this.pipe.statFiles(paths)) {
      if (f.size === undefined) {
        refused.push(`Couldn't attach ${f.name}: ${f.error}`);
        continue;
      }
      const kind = IMAGE_EXTENSIONS.test(f.name) ? "image" : "file";
      const limit = LIMITS[kind];
      if (f.size > limit.bytes) refused.push(overLimitNote(f.name, f.size, limit));
      else attachments.push({ path: f.path, name: f.name, size: f.size, kind });
    }
    return { attachments, refused };
  }

  /**
   * Sends a message and its attachments. A chat not yet open on this connection is resumed first; a Settled one
   * becomes Active. The message shows in the chat at once, marked as sending until Hermes answers. Resolves to what
   * became of it (`Delivery`): if Hermes didn't take it, or may not have, it stays in the chat marked so, with why, until
   * the owner retries or dismisses it, or reading the history back settles it. Nothing here ever sends it again.
   */
  async send(chatId: string, text: string, attachments: Attachment[] = [], skill?: SkillCall): Promise<Delivery> {
    return (await this.deliver(chatId, text, attachments, undefined, skill)).delivery;
  }

  /**
   * Sends a message as `send` does, and also says which item in the chat it is, so a Voice conversation can follow the
   * reply to that message and no other (ADR 0111). `itemId` is missing only when the chat isn't in the list.
   */
  sendTracked(chatId: string, text: string): Promise<{ delivery: Delivery; itemId?: string }> {
    return this.deliver(chatId, text, []);
  }

  /**
   * Sends a message Hermes didn't take, or may not have, again: the same text and attachments, as a new message, never
   * as a continuation of the first. The first goes from the chat. If the retry can't go out at all, a first that Hermes
   * may have stays as it was. Does nothing while the chat has a reply running, or for a message still sending.
   */
  async retry(chatId: string, itemId: string): Promise<Delivery | undefined> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    const first = chat?.items.find((i): i is OutgoingItem => i.id === itemId && isOutgoing(i));
    if (!chat || !first || first.outgoing.state === "sending" || chat.running || this.submitting.has(chatId)) return undefined;
    const profile = this.profile;
    this.setOutgoing(profile, chatId, itemId, () => null);
    const { delivery, itemId: again } = await this.deliver(chatId, first.text, first.outgoing.attachments ?? [], undefined, first.outgoing.skill);
    if (delivery.delivery === "unsent" && first.outgoing.state === "unknown" && again) this.setOutgoing(profile, chatId, again, () => first);
    return delivery;
  }

  /** The owner lets go of a message Hermes didn't take, or may not have. One still sending stays. */
  dismiss(chatId: string, itemId: string) {
    this.setOutgoing(this.profile, chatId, itemId, (r) => (r.outgoing.state === "sending" ? r : null));
  }

  /**
   * Adds a message to the end of the chat's queue (ADR 0018). This app sends it, the next in line, once the chat's
   * reply has ended and nothing in the chat waits on the owner: no Approval, and no message Hermes didn't take or may
   * have. It goes only while this app runs, is connected, and shows the chat's profile. Returns why it wasn't queued.
   */
  enqueue(chatId: string, text: string, attachments: Attachment[] = []): string | undefined {
    if (!this.snapshot.chats.some((c) => c.id === chatId)) return "This chat isn't in the list.";
    if (!text.trim() && !attachments.length) return "There's nothing to queue.";
    const q = this.snapshot.queues[chatId] ?? { items: [] };
    if (q.items.length >= QUEUE_LIMIT) return `A chat can queue up to ${QUEUE_LIMIT} messages. Remove one, or wait for one to go.`;
    const item: Queued = { id: crypto.randomUUID(), text, ...(attachments.length && { attachments }) };
    this.setQueue(chatId, { ...q, items: [...q.items, item] });
    return undefined;
  }

  /** Changes a queued message's words. False: it isn't queued any more, having gone or been removed. */
  editQueued(chatId: string, id: string, text: string): boolean {
    const q = this.snapshot.queues[chatId];
    const item = q?.items.find((i) => i.id === id);
    if (!q || !item || (!text.trim() && !item.attachments?.length)) return false;
    this.setQueue(chatId, { ...q, items: q.items.map((i) => (i.id === id ? { ...i, text } : i)) });
    return true;
  }

  /** Takes a message out of the queue; its files go with it. */
  removeQueued(chatId: string, id: string) {
    const q = this.snapshot.queues[chatId];
    if (q?.items.some((i) => i.id === id)) this.setQueue(chatId, { ...q, items: q.items.filter((i) => i.id !== id) });
  }

  /** Moves a queued message to place `index` in the queue, 0 first; past either end, to that end. One that has gone
   * stays gone. */
  moveQueued(chatId: string, id: string, index: number) {
    const q = this.snapshot.queues[chatId];
    const from = q?.items.findIndex((i) => i.id === id) ?? -1;
    if (!q || from < 0) return;
    const to = Math.max(0, Math.min(q.items.length - 1, index));
    if (to === from) return;
    const items = [...q.items];
    items.splice(to, 0, ...items.splice(from, 1));
    this.setQueue(chatId, { ...q, items });
  }

  /** Pauses the chat's queue: nothing in it goes until `resumeQueue`. */
  pauseQueue(chatId: string) {
    this.pauseQueueFor(chatId, PAUSED.owner);
  }

  /** Lets the chat's queue go again, the next message once the chat is ready for it. */
  resumeQueue(chatId: string) {
    const q = this.snapshot.queues[chatId];
    if (q?.paused !== undefined) this.setQueue(chatId, { items: q.items });
  }

  /** The owner is editing a queued message: none of the chat's queue goes until the returned function is called. */
  holdQueue(chatId: string): () => void {
    this.queueHolds.set(chatId, (this.queueHolds.get(chatId) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const n = (this.queueHolds.get(chatId) ?? 1) - 1;
      if (n > 0) this.queueHolds.set(chatId, n);
      else this.queueHolds.delete(chatId);
      this.pumpSoon();
    };
  }

  /**
   * Pauses a queue that has messages, unless it is paused already, saying `why`. `evenEmpty`: an empty one too, so the
   * messages queued next wait for the owner's Resume.
   */
  private pauseQueueFor(chatId: string, why: string, evenEmpty = false) {
    const q = this.snapshot.queues[chatId] ?? { items: [] };
    if ((q.items.length || evenEmpty) && q.paused === undefined) this.setQueue(chatId, { ...q, paused: why });
  }

  /** The one way a queue of the shown profile changes: in the snapshot, and kept on this computer. */
  private setQueue(chatId: string, next: ChatQueue): boolean {
    const kept = this.cache.saveQueue(this.profile, chatId, next);
    const queues = { ...this.snapshot.queues };
    // An empty queue is kept only while paused (`pauseQueueFor`), and only here: a restart forgets it.
    if (next.items.length || next.paused !== undefined) queues[chatId] = { items: next.items, ...(next.paused !== undefined && { paused: next.paused }), ...(!kept && { unsaved: true }) };
    else delete queues[chatId];
    this.update({ queues });
    return kept;
  }

  /** Looks at the queues once the change under way is done, so a send never starts inside another change. */
  private pumpSoon() {
    if (this.pumpDue) return;
    this.pumpDue = true;
    queueMicrotask(() => {
      this.pumpDue = false;
      this.pump();
    });
  }

  /**
   * Sends the next queued message of each chat that is ready for it: connected, its queue not paused or being edited,
   * no reply running, nothing loading or sending, no Approval waiting, and no message Hermes didn't take or may have.
   * One Hermes may have is settled first by reading the chat's history back (ADR 0006), which loading the chat does.
   */
  private pump() {
    if (this.closing || this.snapshot.status !== "connected" || restartHold.on) return;
    for (const [chatId, q] of Object.entries(this.snapshot.queues)) {
      if (!q.items.length || q.paused !== undefined || this.queueHolds.has(chatId)) continue;
      const chat = this.snapshot.chats.find((c) => c.id === chatId);
      if (!chat || chat.running || chat.loading || this.resuming.has(chatId) || this.submitting.has(chatId)) continue;
      if (chat.items.some((i) => isOutgoing(i) || isWaiting(i))) continue;
      const profile = this.profile;
      if (!chat.runtimeId) {
        // Loaded first: that reads whether a reply is running, and settles any message Hermes may have.
        this.resume(chatId).catch((e) => this.profile === profile && this.pauseQueueFor(chatId, `Couldn't load the chat: ${withoutStop((e as Error).message)}.`));
        continue;
      }
      const [next, ...rest] = q.items;
      // It enters the outbox and leaves the queue in one step, before anything goes. The outbox is written first, and
      // must be kept on this computer: if storage refuses it, nothing is sent and the queue, untouched, keeps it.
      let kept = true;
      const going = this.deliver(chatId, next.text, next.attachments ?? [], {
        kept: (ok) => (kept = ok),
        // Hermes holds it behind a turn this app didn't start, whose end can't be told from its own: the owner says
        // when. Paused before anything else can look at the queue, and even with nothing left in it.
        held: () => this.profile === profile && this.pauseQueueFor(chatId, PAUSED.held, true),
      });
      if (!kept) {
        this.pauseQueueFor(chatId, PAUSED.unsaved);
        continue;
      }
      // ponytail: a full store refusing even this smaller write leaves the message in both the stored queue and the
      // outbox; the queue shows it unsaved, and a crash before a later write lands brings it back paused. Tag outbox rows
      // with the queued id and reconcile on load if that ever matters.
      this.setQueue(chatId, { ...q, items: rest });
      void going.then(({ delivery }) => {
        if (this.profile === profile && delivery.delivery !== "accepted") this.pauseQueueFor(chatId, PAUSED.notSent);
      });
    }
  }

  /**
   * `send`, also giving the id of the message in the chat. The message is in the chat's outbox before this returns its
   * promise. `queued`: it comes from the chat's queue, so Hermes is asked to hold it should a turn still be running
   * there, rather than redirect or interrupt that turn (`prompt.submit {queued}`, research doc).
   */
  private async deliver(
    chatId: string,
    text: string,
    attachments: Attachment[],
    queued?: { kept: (ok: boolean) => void; held: () => void },
    skill?: SkillCall,
  ): Promise<{ delivery: Delivery; itemId?: string }> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat) return { delivery: { delivery: "unsent", reason: "This chat isn't in the list." } };
    // A message that runs skills shows as Hermes will show it, `/name` and the words, never the skill's own text.
    if (skill) text = callText(skill);
    const profile = this.profile;
    const activating = chat.settled;
    const wantedBefore = this.pinWanted.get(chatId);
    if (activating) this.pinWanted.set(chatId, true);
    const user: OutgoingItem = {
      kind: "user",
      id: nextId(chat.items, "u"),
      text,
      ...(attachments.length && { attachments: attachments.map((a) => a.name) }),
      outgoing: { state: "sending", ...(attachments.length && { attachments }), ...(skill && { skill }) },
    };
    this.patchChat(chatId, (c) => ({
      ...c,
      settled: false,
      running: true,
      updatedAt: Date.now(),
      // A new chat is named by its first message until Hermes titles it; a Bot Chat keeps its title, its identity.
      title: c.items.length === 0 && c.runtimeId && !isBotChat(c) ? (text || attachments[0]?.name || c.title).slice(0, 48) : c.title,
      items: [...c.items, user],
    }));
    for (const fn of this.sendListeners) fn(profile, chatId);
    // Kept from the start, so a message on its way when the app closes isn't lost.
    const kept = this.saveOutbox(chatId);
    queued?.kept(kept);
    if (queued && !kept) {
      // Not sent: its queue keeps it instead.
      if (activating) {
        if (wantedBefore === undefined) this.pinWanted.delete(chatId);
        else this.pinWanted.set(chatId, wantedBefore);
      }
      this.patchChat(chatId, (c) => ({ ...c, running: false, settled: activating || c.settled, items: c.items.filter((i) => i.id !== user.id) }));
      this.saveOutbox(chatId);
      return { delivery: { delivery: "unsent", reason: PAUSED.unsaved } };
    }
    try {
      // From here Hermes may have it: what went out, and the newest row the chat had, find it in the history later.
      // A message that runs skills is found in the history by what Hermes shows for it, not the skill text that went.
      let shown: string | undefined;
      const goingOut = (prompt: string) =>
        this.setOutgoing(profile, chatId, user.id, (r) =>
          withOutgoing(r, { sent: { prompt: shown ?? prompt, ...(this.knownRow.has(chatId) && { after: this.knownRow.get(chatId) }) } }),
        );
      // A compaction Hermes hasn't answered yet goes first: the message mustn't land while it rewrites the context.
      const submitting = this.resume(chatId).then((runtimeId) => {
        const go = async () => {
          if (!skill) return this.submit(runtimeId, text, attachments, goingOut, !!queued);
          // Hermes builds the skill's text for this session; nothing reaches the chat until it is sent below.
          const ran = await runSkill((method, params) => this.request(method, params), runtimeId, skill);
          shown = ran.display;
          this.setOutgoing(profile, chatId, user.id, (r) => ({ ...r, text: ran.display }));
          return this.submit(runtimeId, ran.message, attachments, goingOut, !!queued);
        };
        const compacting = this.compacting.get(chatId);
        return compacting ? compacting.then(go) : go();
      });
      this.submitting.set(chatId, submitting);
      const rowId = submitting.then(
        (r) => (typeof r.user_row_id === "number" ? r.user_row_id : undefined),
        () => undefined,
      );
      this.turns.set(chatId, { userId: user.id, rowId });
      let res: Submitted;
      try {
        res = await submitting;
        if (res.status === "queued") queued?.held();
      } finally {
        if (this.submitting.get(chatId) === submitting) this.submitting.delete(chatId);
      }
      this.setOutgoing(profile, chatId, user.id, confirmed);
      this.noteRows(chatId, [res.user_row_id]);
      // Pin now if Hermes has stored the session; a new chat may not have its row yet, so the end of the turn
      // tries again.
      if (this.pinWanted.get(chatId)) this.track(this.writePin(chatId, profile));
      return { delivery: { delivery: "accepted" }, itemId: user.id };
    } catch (e) {
      const unknown = e instanceof PromptUnconfirmedError;
      const reason = unknown ? `The connection dropped before Hermes confirmed it (${(e as Error).message}).` : (e as Error).message;
      if (activating) {
        if (wantedBefore === undefined) this.pinWanted.delete(chatId);
        else this.pinWanted.set(chatId, wantedBefore);
      }
      this.setOutgoing(profile, chatId, user.id, (r) => withOutgoing(r, { state: unknown ? "unknown" : "failed", reason }));
      // A message Hermes turned down begins no turn, so the next turn there isn't taken for its.
      if (!unknown && this.turns.get(chatId)?.userId === user.id) this.turns.delete(chatId);
      this.patchChat(chatId, (c) => ({ ...c, running: false, settled: activating || c.settled }));
      return { delivery: { delivery: unknown ? "unknown" : "unsent", reason }, itemId: user.id };
    }
  }

  /** Moves a chat to Settled here at once, and unpins it on the server (ADR 0002). `unsettle` undoes it. */
  settle(chatId: string): Promise<void> {
    return this.setSettled(chatId, true).then(() => undefined);
  }

  /**
   * Settles each chat at once, all writes going out together, and resolves to the ids whose write didn't go in. Such a
   * chat is back in Active and isn't written again, unless the owner moved it meanwhile. A chat already Settled or gone
   * counts as settled.
   */
  async settleAll(chatIds: string[]): Promise<string[]> {
    const wrote = await Promise.all(
      chatIds.map(async (id) => {
        if (await this.setSettled(id, true)) return true;
        if (this.pinWanted.get(id) === false) {
          this.pinWanted.delete(id);
          this.patchChat(id, (c) => ({ ...c, settled: false }));
        }
        return false;
      }),
    );
    return chatIds.filter((_, i) => !wrote[i]);
  }

  /** Moves a chat to Active here at once, and pins it on the server. `settle` undoes it. */
  unsettle(chatId: string): Promise<void> {
    return this.setSettled(chatId, false).then(() => undefined);
  }

  /**
   * Archives a chat in Hermes: it leaves the list here and in every Hermes client at once, and its history stays.
   * Whether it is Active or Settled is kept for when it is restored. A chat with a reply running isn't archived.
   * Resolves to whether Hermes has it archived, read back after the write (`writeArchived`).
   */
  archive(chatId: string): Promise<boolean> {
    return this.setArchived(chatId, true);
  }

  /** Restores an archived chat: it is back in the list, Active or Settled as it was. `archive` undoes it. */
  restore(chatId: string): Promise<boolean> {
    return this.setArchived(chatId, false);
  }

  /** Puts the profile's archived chats in the list too, or takes them out, and refreshes it. */
  listArchived(on: boolean): Promise<void> {
    if (on === this.snapshot.archivedListed) return Promise.resolve();
    this.update({ archivedListed: on });
    return this.sync();
  }

  /**
   * Deletes a chat from Hermes for good, in every Hermes client (`DELETE /api/sessions/{id}`). It leaves the list here
   * at once; if Hermes refuses, it comes back and the list says why. A chat with a reply running isn't deleted: stop
   * the reply first. `profile` is the chat's, which the owner may switch away from while the delete is under way.
   * Resolves to whether Hermes deleted it.
   */
  async delete(chatId: string): Promise<boolean> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat || chat.running) return false;
    const profile = this.profile;
    this.deleted.add(chatId);
    this.pinWanted.delete(chatId);
    this.archiveWanted.delete(chatId);

    this.archiveUnsure.delete(chatId);
    this.revealed.delete(chatId);
    this.staleItems.delete(chatId);
    this.resumeOnReconnect.delete(chatId);
    for (const [pane, id] of [...this.viewing]) if (id === chatId) this.viewing.delete(pane);
    this.readWhenBack.delete(chatId);
    this.update({ chats: this.snapshot.chats.filter((c) => c.id !== chatId) });
    this.saveList(profile, this.snapshot.chats);
    // Deleted for good, so no copy of it stays on this computer either, even if Hermes refuses: it reloads when opened.
    this.cache.deleteTranscript(profile, chatId);
    try {
      // A pin or archive write still under way would otherwise land on a deleted session and report a failure.
      const writes = [this.pinWrites.get(chatId), this.archiveWrites.get(chatId)].filter((w) => w);
      if (writes.length) await Promise.all(writes);
      await this.fencedDelete(chatId, profile);
      this.cache.saveOutbox(profile, chatId, []);
      // A branch's link back goes only once Hermes has deleted it.
      this.updateBranches(profile, (b) => {
        if (!b.links[chatId]) return b;
        const { [chatId]: _gone, ...links } = b.links;
        return { ...b, links };
      });
      // Its queue had nowhere left to go.
      if (this.profile === profile && this.snapshot.queues[chatId]) this.setQueue(chatId, { items: [] });
      else this.cache.saveQueue(profile, chatId, undefined);
      return true;
    } catch (e) {
      this.deleted.delete(chatId);
      if (this.profile !== profile) return false;
      const chats = this.snapshot.chats.some((c) => c.id === chatId) ? this.snapshot.chats : [...this.snapshot.chats, chat];
      this.update({ chats, syncError: `Couldn't delete "${chat.title}": ${(e as Error).message}` });
      this.saveList(profile, chats);
      return false;
    }
  }

  /**
   * Renames a chat in every Hermes client (`PATCH {title}`). `from` is the title the owner was looking at when they
   * started; the edit names the session's revision, so it can't overwrite a rename made elsewhere meanwhile. The
   * title shown here changes only once Hermes reads it back, and resolves to it. Rejects, leaving the old title, if
   * the title is empty, Hermes refuses it, or it's unclear whether it was saved; with a `RenameConflict` if the chat
   * changed elsewhere first. Nothing is retried on its own.
   */
  async rename(chatId: string, proposed: string, from: string): Promise<string> {
    const title = proposed.trim();
    if (!title) throw new Error("A chat needs a title.");
    if (title === from) return from;
    // A Bot Chat's title is how Hermes finds it, and a chat renamed to the title would become a bot's one chat (ADR 0066).
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (chat && isBotChat(chat)) throw new Error(BOT_CHAT_RENAME);
    if (isBotChatTitle(title)) throw new Error(`“${BOT_CHAT_TITLE}” is the name Hermes gives each bot's one chat. Pick another name.`);
    const profile = this.profile;
    // Read in this order, a rename elsewhere either shows in the title or makes the revision stale.
    const revision = await this.revision(chatId, profile);
    const current = await this.readTitle(chatId, profile);
    // An earlier try whose answer was lost may have saved it already.
    if (current === title) return this.retitled(chatId, current);
    if (current !== from) throw new RenameConflict(this.retitled(chatId, current));
    try {
      await this.fencedPatch(chatId, profile, { title }, revision);
    } catch (e) {
      const why = (e as Error).message;
      const conflict = why.includes("revision_conflict");
      if (!conflict && /^The dashboard answered 4/.test(why)) throw e;
      // The edit may have landed though its answer was lost, so the title as stored now decides.
      const now = await this.readTitle(chatId, profile).catch(() => {
        throw new Error(`Couldn't tell whether Hermes saved the new title: ${why}`);
      });
      if (now === title) return this.retitled(chatId, now);
      if (conflict) throw new RenameConflict(this.retitled(chatId, now));
      throw e;
    }
    const saved = await this.readTitle(chatId, profile).catch((e) => {
      throw new Error(`Couldn't tell whether Hermes saved the new title: ${(e as Error).message}`);
    });
    return this.retitled(chatId, saved);
  }

  /**
   * Asks Hermes for a new title made from the chat's last few stored messages, then renames the chat to it like
   * `rename` does. The messages are read with dashboard REST; the title comes from legacy `llm.oneshot`, a separate
   * model call on Hermes's title model that adds nothing to the chat. Rejects, leaving the old title, if the chat has
   * no messages, Hermes gives no usable title, the profile changes meanwhile, or the rename fails; with a
   * `TitleModelUnavailable` if Hermes has no credentials for the title model's provider.
   */
  async regenerateTitle(chatId: string): Promise<string> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("This chat isn't in the list.");
    if (isBotChat(chat)) throw new Error(BOT_CHAT_RENAME);
    const from = chat.title;
    const profile = this.profile;
    // Tool rows count toward each page, so older pages are read until the last messages are all in.
    let rows: StoredMessage[] = [];
    for (let offset = 0; offset < TITLE_MAX_ROWS; offset += TITLE_PAGE_ROWS) {
      const query = new URLSearchParams({ profile, order: "latest", limit: String(TITLE_PAGE_ROWS), offset: String(offset), inline_images: "false" });
      const page = ((await this.rest("GET", `${sessionPath(chatId)}/messages?${query}`)) as { messages?: StoredMessage[] }).messages ?? [];
      rows = [...page, ...rows];
      if (page.length < TITLE_PAGE_ROWS || saidIn(rows).length >= TITLE_FROM_MESSAGES) break;
    }
    const input = titleInput(rows);
    if (!input) throw new Error("This chat has no messages to make a title from.");
    const { text } = (await this.request("llm.oneshot", { profile, instructions: TITLE_INSTRUCTIONS, input, max_tokens: 512 }).catch((e) => {
      throw (e instanceof RpcError && titleModelUnavailable(e.message, profile)) || e;
    })) as { text?: string };
    const title = cleanTitle(text ?? "");
    if (!title) throw new Error("Hermes didn't answer with a title.");
    if (this.profile !== profile) throw new Error("The profile changed before the title was ready.");
    return this.rename(chatId, title, from);
  }

  /**
   * Where else Hermes posts its replies in this chat, besides Hermes clients. On the canonical protocol, a reply in a
   * chat started in Telegram or Discord also goes to that platform chat, unless the platform chat has since moved to
   * another session. This app speaks only the legacy protocol, where replies stay in Hermes clients (research doc
   * §5), so there is nowhere else yet.
   */
  alsoPostsIn(_chatId: string): Source | undefined {
    return undefined;
  }

  /**
   * Stops the chat's reply with legacy `session.interrupt`, once Hermes has accepted the message it answers. Hermes
   * answers before the agent has stopped, so the chat is `stopping` until the turn's `message.complete`, which
   * marks the reply interrupted and its running tool calls stopped. If Hermes can't stop it, the chat says so and
   * the reply keeps running.
   */
  async stop(chatId: string): Promise<void> {
    const stoppable = () => {
      const c = this.snapshot.chats.find((c) => c.id === chatId);
      return c?.running && !c.stopping ? c : undefined;
    };
    if (!stoppable()) return;
    try {
      await this.submitting.get(chatId);
    } catch {
      return; // send() has shown why the message didn't go.
    }
    const chat = stoppable();
    if (!chat?.runtimeId) return;
    this.patchChat(chatId, (c) => ({ ...c, stopping: true }));
    try {
      const res = (await this.request("session.interrupt", { session_id: chat.runtimeId })) as InterruptResult;
      if (res.status !== "interrupted") this.patchChat(chatId, (c) => ({ ...c, stopping: false }));
    } catch (e) {
      // A turn that has already ended, or a dropped connection, needs no error.
      this.patchChat(chatId, (c) =>
        c.stopping ? { ...c, stopping: false, items: [...c.items, errorItem(c, `Couldn't stop the reply: ${(e as Error).message}`)] } : c,
      );
    }
  }

  /**
   * Answers an Approval with the owner's choice (`settleApproval`). One already answered, or that Hermes stopped
   * waiting for, is left alone, and so is a choice Hermes didn't offer, or a broader grant (`isBroadGrant`) the owner
   * hasn't `confirmed`. So is a card from before a drop until its chat is loaded again, which tells whether Hermes still
   * waits on it. A card Hermes says nothing waits on any more was answered in another Hermes app, and says so. If the
   * answer can't go, the chat says so and the card stays waiting.
   */
  async answerApproval(chatId: string, approvalId: string, choice: ApprovalChoice, confirmed = false): Promise<void> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    const card = chat?.items.find((i) => i.id === approvalId);
    if (!card || !isWaiting(card) || !offeredChoices(card).includes(choice) || (isBroadGrant(choice) && !confirmed)) return;
    if (this.snapshot.status === "connected" && !chat?.runtimeId) return;
    const close = (change: Partial<ApprovalItem>) =>
      this.patchChat(chatId, (c) => ({ ...c, items: c.items.map((i) => (i.id === approvalId && i.kind === "approval" ? { ...i, ...change } : i)) }));
    close({ answer: choice });
    try {
      if (!this.pipe || this.snapshot.status !== "connected" || !chat?.runtimeId) throw new Error("Not connected to Hermes.");
      if (!(await this.settleApproval(chat.runtimeId, card, choice))) close({ answer: undefined, ended: "resolved" });
    } catch (e) {
      close({ answer: undefined });
      this.patchChat(chatId, (c) => ({ ...c, items: [...c.items, errorItem(c, `Couldn't answer Hermes: ${(e as Error).message}`)] }));
    }
  }

  /**
   * Sends an Approval's answer: `approval.respond`, which settles it in Hermes's approval queue, so Hermes withdraws
   * the card from every other app with the chat open (`request.cancel`). A response frame to the request settles it
   * first, and no other app hears (#318). A Hermes without `approval.respond`, or a card without a request id, still
   * gets one (research doc §6), and so does a card Hermes never said was in its own queue (`queuedApprovals`) when
   * `approval.respond` settles nothing. Resolves false when Hermes had nothing waiting under that request id.
   */
  private async settleApproval(runtimeId: string, card: ApprovalItem, choice: ApprovalChoice): Promise<boolean> {
    if (card.requestId)
      try {
        const res = obj(await this.request("approval.respond", { session_id: runtimeId, choice, request_id: card.requestId }));
        if (res?.resolved !== 0) return true;
        if (this.queuedApprovals.has(card.requestId)) return false;
      } catch (e) {
        if (!(e instanceof CapabilityUnsupportedError) && !(e instanceof RpcError && e.code === NO_SUCH_METHOD)) throw e;
      }
    if (!this.pipe) throw new Error("Not connected to Hermes.");
    await this.pipe.send(JSON.stringify({ jsonrpc: "2.0", id: card.id, result: { choice, all: false } }));
    return true;
  }

  /**
   * Changes the chat's approval mode (ADR 0091). Smart and Manual set the profile's `approvals.mode`, for every session
   * on the profile from Hermes's next command; YOLO sets this chat's own flag (`config.set yolo`, session scope).
   * Hermes sends `session.info` around each write, and one of those frames may be stale, so while the pick is under way
   * they leave `approvals` alone; afterwards it is Hermes's own formula over its answers, minus the `--yolo` launch flag
   * no answer reveals. A refused write rejects with Hermes's message, after settling from the writes it did answer.
   * Rejects if the chat isn't open on Hermes or Hermes hasn't reported its approvals yet.
   */
  setApprovals(chatId: string, pick: ApprovalPick): Promise<void> {
    const run = this.approvalPicks.then(() => this.pickApprovals(chatId, pick));
    this.approvalPicks = run.catch(() => {});
    return run;
  }

  private async pickApprovals(chatId: string, pick: ApprovalPick): Promise<void> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    const runtimeId = chat?.runtimeId;
    if (!runtimeId) throw new Error("This chat isn't open on Hermes.");
    const before = chat.live?.approvals;
    if (!before) throw new Error("Hermes hasn't reported approvals for this chat yet.");
    let answered = false;
    let flag = false;
    let mode = before.mode;
    this.approvalPickFor = runtimeId;
    try {
      for (const w of writesFor(pick, before)) {
        const res = (await this.request("config.set", { session_id: runtimeId, profile: this.profile, key: w.key, value: w.value })) as { value?: unknown };
        answered = true;
        if (w.key === "yolo") flag = res.value === "1";
        else mode = isApprovalMode(res.value) ? res.value : w.value;
      }
    } finally {
      this.approvalPickFor = undefined;
      const approvals = { mode, yolo: flag || mode === "off" };
      if (answered) this.patchChat(chatId, (c) => (c.runtimeId === runtimeId ? { ...c, live: { ...c.live, approvals } } : c));
    }
  }

  /**
   * What fills the chat's context window now, as Hermes measures it (`session.context_breakdown`, ADR 0025): its total
   * with how Hermes counted it, its estimate by category, and the instruction files it considered. Rejects when the
   * chat isn't open on Hermes on this connection, when this Hermes has no breakdown (saying so), or when the
   * connection, profile or chat's session changed before Hermes answered: an answer for another session is never shown.
   */
  async inspectContext(chatId: string): Promise<ContextReading> {
    const { runtimeId, still } = this.liveScope(chatId);
    const res = await this.request("session.context_breakdown", { session_id: runtimeId }).catch((e: unknown) => {
      throw e instanceof RpcError && e.code === NO_SUCH_METHOD ? new Error("This Hermes doesn't report what fills the context window.") : e;
    });
    still();
    return readingOf(res, Date.now());
  }

  /**
   * The compactions Hermes stored for the chat (ADR 0025), from its stored rows with the compacted ones
   * (`GET /api/sessions/{id}/messages?include_compacted=true`), read a page at a time, oldest first, up to
   * `COMPACTION_ROWS`. Only reads. Rejects if a page can't be read, or the profile or connection changed meanwhile. A
   * chat Hermes hasn't stored yet has none.
   */
  async compactionHistory(chatId: string): Promise<CompactionHistory> {
    const profile = this.profile;
    const gen = this.generation;
    if (this.snapshot.status !== "connected") throw new Error("Connect to Hermes to read this chat's compactions.");
    const rows: CompactionRow[] = [];
    let truncated = false;
    for (let offset = 0; ; offset += COMPACTION_PAGE) {
      const query = new URLSearchParams({ profile, include_compacted: "true", order: "oldest", limit: String(COMPACTION_PAGE), offset: String(offset), inline_images: "false" });
      let page: CompactionRow[];
      try {
        const res = (await this.rest("GET", `${sessionPath(chatId)}/messages?${query}`)) as { messages?: unknown };
        page = Array.isArray(res?.messages) ? (res.messages as CompactionRow[]).filter((r) => typeof r?.id === "number") : [];
      } catch (e) {
        if (offset === 0 && (e as Error).message.includes("answered 404")) {
          page = [];
        } else throw e;
      }
      if (this.profile !== profile || this.generation !== gen) throw new Error("The profile or connection changed before Hermes answered.");
      rows.push(...page);
      if (page.length < COMPACTION_PAGE) break;
      if (rows.length >= COMPACTION_ROWS) {
        truncated = true;
        break;
      }
    }
    return compactionsOf(rows, truncated, Date.now());
  }

  /**
   * Has Hermes compact the chat now (`session.compress`, Hermes's `/compress`): it summarizes the older messages into
   * one summary the model reads in their place. Hermes refuses while a reply runs. The chat's usage is read again
   * afterwards. Rejects when the chat isn't open on Hermes here, when Hermes refuses, or when this Hermes can't
   * compact (and then the chat isn't offered it again on this connection). One compaction at a time for a chat: asked
   * again before Hermes answers, it is busy. A message sent meanwhile goes once Hermes has answered (`deliver`), so it
   * never lands while Hermes rewrites what the model reads (Idle compaction, ADR 0119).
   */
  async compact(chatId: string): Promise<CompactResult> {
    const { runtimeId, still } = this.liveScope(chatId);
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (chat?.running || this.submitting.has(chatId)) throw new Error("Wait for the reply to finish: Hermes compacts only between replies.");
    if (this.compacting.has(chatId)) return { kind: "busy", message: "Hermes is already compacting this chat." };
    const asked = this.request("session.compress", { session_id: runtimeId });
    const settled = asked.catch(() => undefined);
    this.compacting.set(chatId, settled);
    void settled.then(() => this.compacting.get(chatId) === settled && this.compacting.delete(chatId));
    const res = await asked.catch((e: unknown) => {
      if (e instanceof RpcError && e.code === NO_SUCH_METHOD) {
        this.noCompact.add(this.generation);
        this.update({});
        throw new Error("This Hermes can't compact a chat from here.");
      }
      throw e;
    });
    still();
    this.track(this.refreshUsage(chatId));
    return compactResultOf(res);
  }

  /** Whether this connection's Hermes answered that it can't compact a chat (`compact`). */
  cannotCompact(): boolean {
    return this.noCompact.has(this.generation);
  }

  /**
   * Reads Hermes's roster of the chat's subagents (`subagent.list`) into its tree: when the chat is resumed on a
   * connection, for what ran or ended while the app wasn't listening, and when a subagent is opened. A roster that arrives for a session the chat no longer
   * has is dropped. A Hermes without the method is asked no more on this connection.
   */
  private async listSubagents(chatId: string, runtimeId: string): Promise<void> {
    const gen = this.generation;
    const current = () => this.generation === gen && this.snapshot.chats.find((c) => c.id === chatId)?.runtimeId === runtimeId;
    const unchecked = (why: string) => this.patchChat(chatId, (c) => (c.subagents ? { ...c, subagents: onUnchecked(c.subagents, why) } : c));
    if (this.noSubagentList === gen) return unchecked(NO_SUBAGENT_LIST);
    try {
      const askedAt = Date.now();
      const res = await this.request("subagent.list", { session_id: runtimeId });
      if (current()) this.patchChat(chatId, (c) => ({ ...c, subagents: onRoster(c.subagents, res, Date.now(), askedAt) }));
    } catch (e) {
      const missing = e instanceof RpcError && e.code === NO_SUCH_METHOD;
      if (missing) this.noSubagentList = gen;
      if (current()) unchecked(missing ? NO_SUBAGENT_LIST : `Hermes couldn't list them: ${(e as Error).message}`);
    }
  }

  /** Reads the chat's subagent roster again, while it's open on Hermes; nothing otherwise. */
  refreshSubagents(chatId: string): Promise<void> {
    const runtimeId = this.snapshot.chats.find((c) => c.id === chatId)?.runtimeId;
    if (!runtimeId || this.snapshot.status !== "connected") return Promise.resolve();
    return this.listSubagents(chatId, runtimeId);
  }

  /**
   * The end of a subagent's live transcript (`subagent.tail`, the last 16 KB). Hermes shares it only for a running
   * subagent, and only with the chat session that started it; otherwise it isn't available.
   */
  async subagentOutput(chatId: string, id: SubagentId): Promise<SubagentOutput> {
    const { runtimeId, still } = this.liveScope(chatId);
    const res = await this.request("subagent.tail", { session_id: runtimeId, subagent_id: id });
    still();
    return parseOutput(res);
  }

  /**
   * Steers one subagent (`subagent.steer`): Hermes adds the words to its work after its current tool call, and no other
   * subagent or the chat's reply gets them. `"rejected"`: Hermes didn't take them, as when it isn't taking steers now.
   */
  async steerSubagent(chatId: string, id: SubagentId, text: string): Promise<"queued" | "rejected"> {
    const { runtimeId, still } = this.liveScope(chatId);
    const res = (await this.request("subagent.steer", { session_id: runtimeId, subagent_id: id, text })) as { status?: unknown };
    still();
    return res?.status === "queued" ? "queued" : "rejected";
  }

  /**
   * Stops one subagent (`subagent.interrupt`), and with it the subagents it started; the chat's reply and the other
   * subagents keep going. Resolves whether Hermes found it to stop. Its `subagent.complete` then says it was stopped.
   */
  async stopSubagent(chatId: string, id: SubagentId): Promise<boolean> {
    const { runtimeId, still } = this.liveScope(chatId);
    const res = (await this.request("subagent.interrupt", { session_id: runtimeId, subagent_id: id })) as { found?: unknown };
    still();
    return res?.found === true;
  }

  /**
   * The chat's runtime session on this connection, and a check that throws if, by the time Hermes answers, the
   * connection, profile or the chat's session is another.
   */
  private liveScope(chatId: string): { runtimeId: string; still: () => void } {
    const runtimeId = this.snapshot.chats.find((c) => c.id === chatId)?.runtimeId;
    if (!runtimeId || this.snapshot.status !== "connected") throw new Error("This chat isn't open on Hermes.");
    const profile = this.profile;
    const gen = this.generation;
    return {
      runtimeId,
      still: () => {
        if (this.profile !== profile || this.generation !== gen || this.snapshot.chats.find((c) => c.id === chatId)?.runtimeId !== runtimeId)
          throw new Error("The chat's session changed before Hermes answered.");
      },
    };
  }

  /**
   * Refreshes the chat list from dashboard REST: the profile's chats active in the past month, or all of them once
   * older history is pulled, Active when pinned. A call while a sync is running asks for one more pass and resolves
   * with it.
   */
  async sync(): Promise<void> {
    await this.syncList();
  }

  /**
   * Pulls the profile's chats older than a month into the list: from now on it holds all of them, Settled unless
   * pinned (ADR 0002), and the profile remembers it. Resolves to the older chats added. Only reads from Hermes. If
   * the list can't be read, or the owner switches profile first, rejects and leaves the list a month long.
   */
  async pullOlderHistory(): Promise<Chat[]> {
    const profile = this.profile;
    const cutoff = Date.now() - LIST_WINDOW_MS;
    const before = new Set(this.snapshot.chats.map((c) => c.id));
    this.update({ olderPulled: true });
    const failure = await this.syncList();
    // The switch shows the new profile's flag, and this profile's list wasn't read.
    if (this.profile !== profile) throw new Error(`Switched to the ${this.profile} profile before the older chats arrived.`);
    if (failure) {
      this.update({ olderPulled: false });
      throw failure;
    }
    this.cache.rememberOlderPulled(profile);
    return this.snapshot.chats.filter((c) => !before.has(c.id) && c.updatedAt < cutoff);
  }

  /**
   * The shown profile's list has been read from Hermes on this connection, so a chat missing from it is gone (deleted,
   * archived, or older than the list reaches), not just not yet synced.
   */
  hasListed(): boolean {
    return this.listedAt !== undefined;
  }

  /** The storage the chat lists and Saved copies kept on this computer take, in bytes. */
  cacheBytes(): number {
    return this.cache.bytes();
  }

  /**
   * Deletes the chat lists and Saved copies kept on this computer. Nothing is sent to Hermes. What is on screen
   * stays; the next refresh saves the list again, and opening a chat saves its copy again.
   */
  clearCache() {
    this.cache.clear();
  }

  /** `sync`, resolving to why the last pass failed, if it did. */
  private syncList(): Promise<Error | undefined> {
    if (this.snapshot.status !== "connected") return Promise.resolve(new Error("Not connected to Hermes.")); // Reconnecting syncs again.
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    const passes = async (): Promise<Error | undefined> => {
      try {
        let failure: Error | undefined;
        do {
          this.syncAgain = false;
          failure = await this.syncOnce(() => this.syncing === syncing);
        } while (this.syncAgain && this.syncing === syncing);
        return failure;
      } finally {
        if (this.syncing === syncing) this.syncing = undefined;
      }
    };
    const syncing = passes();
    this.syncing = syncing;
    this.track(syncing);
    return syncing;
  }

  /** Resolves once background work (list syncs, pinning) has finished. Tests wait on it; the app doesn't need to. */
  async idle() {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  /**
   * Closes the connection for good. Rust holds one connection and routes every command to it, so from here on this
   * Hermes sends nothing: later calls find no connection rather than using the one that replaces it. Requests in
   * flight are left unanswered, as when the app quits, so a message being sent is kept as one the app closed on.
   * Resolves once a reconnect under way has been stopped and closed what it opened, if anything, and a dropped pipe
   * has closed, so no late close from this Hermes can end the replacement either.
   */
  async close() {
    const releasing = this.releaseScreen();
    if (releasing) await releasing;
    this.closing = true;
    this.abortDial?.(new Error("Closed by the app."));
    this.generation++;
    this.capabilities.disconnected();
    this.kanbanWatch.stop();
    clearTimeout(this.rosterTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    this.cancelNotify();
    const pipe = this.takePipe();
    await this.redialing?.catch(() => {});
    await this.droppedClosing;
    await pipe?.close();
    // Anything a dial opened after all.
    await this.takePipe()?.close();
  }

  /** The pipe in use, now no longer this Hermes's to send on. */
  private takePipe(): Pipe | undefined {
    const pipe = this.pipe;
    this.pipe = undefined;
    return pipe;
  }

  private handle(e: PipeEvent) {
    if (e.kind === "closed") return this.dropped(e.reason);
    this.lastHeard = Date.now();
    let frame: RpcFrame;
    try {
      frame = JSON.parse(e.text);
    } catch {
      return;
    }
    if (frame.method === undefined && typeof frame.id === "number") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.error) p.reject(new RpcError(frame.error.code, frame.error.message));
      else p.resolve(frame.result);
      return;
    }
    if (typeof frame.id === "string" && frame.method) return this.onServerRequest({ id: frame.id, method: frame.method, params: frame.params ?? {} });
    if (frame.method !== "event" || !frame.params?.type) return;
    const { type, session_id, payload = {} } = frame.params;
    if (type === "gateway.ready") {
      this.onReady?.(payload);
      return;
    }
    if (type === "display.lease") {
      const { profile_key, lease } = payload as { profile_key?: unknown; lease?: DisplayLease };
      if (typeof profile_key === "string" && lease && typeof lease.epoch === "number") for (const l of this.leaseListeners) l(profile_key, lease);
      return;
    }
    // Broadcast when any process changes the session store (tui_gateway/change_watcher.py).
    if (type === "sessions.changed") {
      void this.sync();
      return;
    }
    if (type === "status.update") {
      if (payload.kind === "process" && typeof payload.text === "string") this.kanbanWatch.nudge(payload.text);
      return;
    }
    const chat = session_id ? this.snapshot.chats.find((c) => c.runtimeId === session_id) : undefined;
    if (!chat) return;
    // A side question's answer is no part of the chat or of a turn running in it.
    if (type === "btw.complete") return this.sideAnswered(chat, String(payload.task_id ?? ""), payload.text);
    // Sent when the chat's model, reasoning, fast mode or YOLO changes, here or in another Hermes client.
    if (type === "session.info") {
      const model = pickFromInfo(payload);
      const picking = this.approvalPickFor === session_id;
      this.patchChat(chat.id, (c) => {
        const live = withLive(c.live, payload);
        return { ...c, ...(model && { model }), live: picking && live ? { ...live, approvals: c.live?.approvals } : live };
      });
      // Between turns its usage is where the next turn starts; one sent during a turn is part of the way through it.
      const counters = countersOf(payload.usage);
      if (counters && !chat.running) this.usageFrom.set(session_id!, counters);
      return;
    }
    // Subagents are kept apart from the transcript, in the chat's own tree (ADR 0072).
    if (type.startsWith("subagent.")) {
      const at = Date.now();
      this.patchChat(chat.id, (c) => ({ ...c, subagents: onSubagentEvent(c.subagents, type, payload, at) }));
      return;
    }
    if (type === "message.start") {
      this.turnStart.set(chat.id, chat.items.at(-1)?.id ?? null);
      if (this.turns.has(chat.id)) this.unprompted.delete(chat.id);
      else this.unprompted.add(chat.id);
      this.kanbanWatch.turnStarted([chat.id, ...(chat.lineage ?? [])]);
    }
    if (type === "tool.complete") {
      const call = chat.items.find((i) => i.kind === "tool" && i.id === String(payload.tool_id));
      const task = call?.kind === "tool" && call.name === "kanban_create" ? parseKanbanCreate(call.args, payload.result, Date.now(), this.kanbanWatch.currentBoard()) : undefined;
      if (task) this.kanbanWatch.add(task, chat.id);
    }
    const usage = type === "message.complete" ? this.turnUsage(session_id!, payload.usage) : undefined;
    const from = this.turnStart.get(chat.id);
    const unprompted = this.unprompted.has(chat.id);
    if (type === "message.complete" || type === "error") {
      this.turnStart.delete(chat.id);
      this.unprompted.delete(chat.id);
    }
    // A turn that failed without a `message.complete` ends without counters, so the next one can't be measured.
    if (type === "error") this.usageFrom.set(session_id!, "unknown");
    // A streamed delta is in the snapshot at once, so the reply's text is always whole and in order, but the app hears of
    // it once a frame: Hermes can send many in one frame, and each would render the reply again (ADR 0068).
    const delta = type === "message.delta" || type === "reasoning.delta";
    this.patchChat(
      chat.id,
      (c) => {
        const next = applyEvent(c, type, payload, from);
        return usage ? { ...next, items: withReplyUsage(next.items, usage, from) } : next;
      },
      delta,
    );
    if (type === "message.complete") {
      const receipt = (payload.persisted_turn ?? {}) as PersistedTurn;
      this.noteRows(chat.id, [receipt.user_row_id, receipt.final_assistant_row_id, ...(Array.isArray(receipt.row_ids) ? receipt.row_ids : [])]);
      // Such a turn leaves alone a message sent from here meanwhile, which Hermes holds until the turn ends.
      if (unprompted) this.track(this.showUnsentPrompt(chat.id, receipt, from));
      else this.stampTurn(chat.id, receipt);
    }
    if (type === "message.complete") this.track(this.refreshUsage(chat.id));
    // By the end of a turn Hermes has stored the session, so a pin that failed earlier can succeed.
    if (type === "message.complete" && this.pinWanted.has(chat.id)) this.track(this.writePin(chat.id));
    // The finished reply is newer than the read watermark, though the owner watched it come in.
    if (type === "message.complete" && this.isViewing(chat.id)) this.seen(chat.id);
    // A turn ends once; a repeated end finds the chat no longer running.
    if ((type === "message.complete" || type === "error") && chat.running) this.alert(NOTICES.finished);
    if (type === "message.complete") this.saveTranscript(chat.id);
    if (type === "message.complete" || type === "error") {
      const why = pauseAfter(type, payload, this.snapshot.chats.find((c) => c.id === chat.id)?.items ?? []);
      if (why) this.pauseQueueFor(chat.id, why);
    }
  }

  /**
   * The usage of the turn a `message.complete` ends, from the counters it carries (`usage.ts`). Those counters are where
   * the session's next turn starts. Undefined when this turn's start isn't known, or it made no model call.
   */
  private turnUsage(runtimeId: string, raw: unknown): ReplyUsage | undefined {
    const end = countersOf(raw);
    const start = this.usageFrom.get(runtimeId);
    this.usageFrom.set(runtimeId, end ?? "unknown");
    return end && start && start !== "unknown" ? replyUsage(start, end) : undefined;
  }

  /**
   * Shows the chat's Saved copy, if it has one and nothing but its outbox is on screen for it: it stands in until the
   * next resume replaces it with the stored history.
   */
  private showSaved(chatId: string) {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat || chat.runtimeId || chat.items.some((i) => !isOutgoing(i))) return;
    const saved = this.cache.loadTranscript(this.profile, chatId);
    if (!saved?.items.length) return;
    this.staleItems.set(chatId, saved.items.length);
    this.patchChat(chatId, (c) => ({ ...c, items: withRows(saved.items, c.items.filter(isOutgoing)), savedAt: saved.savedAt }));
  }

  /**
   * Saves the chat's transcript as its Saved copy. Only what Hermes stores goes in: messages, thinking and tool calls,
   * not Approvals or errors, which belong to this connection, nor a message Hermes hasn't confirmed, which the outbox
   * keeps.
   */
  private saveTranscript(chatId: string) {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    const items = chat?.items.filter((i) => (i.kind === "user" && !i.outgoing) || i.kind === "assistant" || i.kind === "thinking" || i.kind === "tool") ?? [];
    if (items.length) this.cache.saveTranscript(this.profile, chatId, items);
  }

  /**
   * At the end of a turn, shows when Hermes stored the message sent from here and its final reply. Both are found by
   * stored row id, never by their words: the message's comes from `prompt.submit`; the reply's from the turn's
   * `persisted_turn`, which counts only when it names that same message. The times are then read from those rows.
   * Anything not found that way keeps no time; reopening the chat after a reconnect reads every time from history.
   */
  private stampTurn(chatId: string, receipt: PersistedTurn) {
    const turn = this.turns.get(chatId);
    this.turns.delete(chatId);
    const items = this.snapshot.chats.find((c) => c.id === chatId)?.items ?? [];
    const from = turn ? items.findIndex((i) => i.id === turn.userId) : -1;
    if (!turn || from < 0) return;
    const reply = items.slice(from + 1).filter((i) => i.kind === "assistant").pop();
    const profile = this.profile;
    this.track(
      (async () => {
        const userRow = await turn.rowId;
        if (userRow === undefined) return;
        // The message keeps its stored row too, which finds it in Hermes's history, as when branching from it.
        this.patchChat(chatId, (c) => ({ ...c, items: c.items.map((i) => (i.id === turn.userId && i.kind === "user" && !i.outgoing ? { ...i, rowId: userRow } : i)) }));
        const wanted = new Map<number, string>([[userRow, turn.userId]]);
        const replyRow = reply && receipt.user_row_id === userRow && typeof receipt.final_assistant_row_id === "number" ? receipt.final_assistant_row_id : undefined;
        if (reply?.kind === "assistant" && replyRow !== undefined) {
          // The reply keeps its stored row from now, saved at once: its usage is found again by it after a reload,
          // even one before its time is read, or when that read fails.
          const withRow: Item = { ...reply, rowId: replyRow };
          this.patchChat(chatId, (c) => ({ ...c, items: c.items.map((i) => (i === reply ? withRow : i)) }));
          if (this.snapshot.chats.find((c) => c.id === chatId)?.items.includes(withRow)) {
            this.saveTranscript(chatId);
            wanted.set(replyRow, withRow.id);
          }
        }
        // The newest 100 rows: a turn with more tool rows than that leaves its message without a time.
        const query = new URLSearchParams({ profile, order: "latest", limit: "100", inline_images: "false" });
        const res = (await this.rest("GET", `api/sessions/${encodeURIComponent(chatId)}/messages?${query}`)) as { messages?: StoredRow[] };
        const at = new Map<string, number>();
        for (const m of res.messages ?? []) {
          const id = wanted.get(m.id);
          const t = storedAt(m.timestamp);
          if (id && t) at.set(id, t);
        }
        if (at.size)
          this.patchChat(chatId, (c) => ({
            ...c,
            items: c.items.map((i): Item => ((i.kind === "user" || i.kind === "assistant") && at.has(i.id) ? { ...i, at: at.get(i.id) } : i)),
          }));
        // The Saved copy was taken when the turn ended, before the times arrived.
        if (at.size) this.saveTranscript(chatId);
      })(),
    );
  }

  /**
   * At the end of a turn not started from here, shows the message that began it where the history shows it after a
   * reload: just before the turn. Hermes starts such a turn itself when work a chat dispatched comes back
   * (`tui_gateway/session_notifications.py`), and its `message.start` carries no text, so the stored row the turn's
   * `persisted_turn` names is read back. Rows the history leaves out stay out (`session_history._history_to_messages`).
   */
  private async showUnsentPrompt(chatId: string, receipt: PersistedTurn, from: string | null | undefined) {
    const rowId = receipt.user_row_id;
    if (typeof rowId !== "number" || from === undefined) return;
    const query = new URLSearchParams({ profile: this.profile, order: "latest", limit: "100", inline_images: "false" });
    const res = (await this.rest("GET", `${sessionPath(chatId)}/messages?${query}`)) as { messages?: (StoredRow & StoredMessage)[] };
    const row = res.messages?.find((m) => m.id === rowId);
    const text = storedText(row?.content);
    if (row?.role !== "user" || row.display_kind === "hidden" || !text.trim() || text.trimStart().startsWith("[System:")) return;
    const at = storedAt(row.timestamp);
    this.patchChat(chatId, (c) => {
      const start = turnFrom(c.items, from);
      if (start < 0 || c.items.some((i) => (i.kind === "user" || i.kind === "assistant") && i.rowId === rowId)) return c;
      const user: Item = { kind: "user", id: nextId(c.items, "w"), text, rowId, ...(at && { at }) };
      return { ...c, items: [...c.items.slice(0, start), user, ...c.items.slice(start)] };
    });
    this.saveTranscript(chatId);
  }

  /** A question from Hermes. An Approval shows as a card in its chat. Other kinds this app can't show yet get `unshownAnswer`. */
  private onServerRequest(req: ServerRequest) {
    if (req.method !== "approval") {
      const error = unshownAnswer(req.method, this.capabilities.getSnapshot().facts);
      if (error) void this.pipe?.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, error })).catch(() => {});
      return;
    }
    const sid = String(req.params.session_id ?? "");
    const chat = this.snapshot.chats.find((c) => c.runtimeId === sid);
    if (chat) this.showApprovals(chat.id, [req]);
    else this.earlyRequests.set(sid, [...(this.earlyRequests.get(sid) ?? []), req]);
  }

  /**
   * Adds a card for each Approval request the chat doesn't show yet. A request can be listed more than once. One whose
   * card was closed stays closed; if the owner had answered it, the answer never reached Hermes, and the chat says so.
   */
  private showApprovals(chatId: string, reqs: ServerRequest[]) {
    const runtimeId = this.snapshot.chats.find((c) => c.id === chatId)?.runtimeId;
    const fresh = reqs.filter((r) => r.method === "approval" && !this.notified.has(`${runtimeId} ${r.id}`));
    for (const r of fresh) this.notified.add(`${runtimeId} ${r.id}`);
    if (fresh.length) this.alert(NOTICES.approval);
    this.patchChat(chatId, (c) => {
      const shown = new Set(c.items.map((i) => i.id));
      const items = [...c.items];
      for (const r of reqs.filter((r) => r.method === "approval" && !shown.has(r.id) && shown.add(r.id))) {
        const closed = this.closedApprovals.get(r.id);
        if (!closed) items.push(approvalItem(r));
        else if (closed.answer)
          items.push(
            errorItem(
              { ...c, items },
              `Your answer to “${closed.command}” didn't reach Hermes before the connection dropped. Hermes stops waiting on its own.`,
            ),
          );
      }
      return items.length > c.items.length ? { ...c, items } : c;
    });
    if (this.isViewing(chatId)) this.tellShown(chatId);
  }

  /**
   * Tells Hermes that the chat's waiting Approvals are on screen (`approval.received`), once each. A server
   * without that method is asked no more.
   */
  private tellShown(chatId: string) {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat?.runtimeId || this.noApprovalReceived) return;
    for (const i of chat.items) {
      if (i.kind !== "approval" || !isWaiting(i) || this.shownApprovals.has(i.requestId)) continue;
      this.shownApprovals.add(i.requestId);
      const told = this.request("approval.received", { session_id: chat.runtimeId, request_id: i.requestId }).then(
        (res) => void (obj(res)?.acknowledged === true && this.queuedApprovals.add(i.requestId)),
        (e) => {
          this.shownApprovals.delete(i.requestId);
          if (e instanceof RpcError && e.code === NO_SUCH_METHOD) this.noApprovalReceived = true;
        },
      );
      this.track(told);
    }
  }

  /**
   * Resumes the chats that were busy when the connection dropped, so the Approvals Hermes is still waiting on come
   * back, asked before the drop or during it. A waiting card whose chat can't be loaded again is closed.
   */
  private resumeBusyChats() {
    const ids = [...this.resumeOnReconnect].filter((id) => this.snapshot.chats.some((c) => c.id === id));
    this.resumeOnReconnect.clear();
    for (const id of ids)
      this.track(this.resume(id).catch(() => this.patchChat(id, (c) => ({ ...c, items: endWaitingApprovals(c.items, "lost") }))));
  }

  /** The connection has dropped, and reconnecting starts. */
  private dropped(reason: string) {
    this.detach(reason);
    this.retryLater();
  }

  /**
   * Lets go of the connection: requests in flight fail and replies stop running. Closing a connection detaches its
   * runtime sessions, so each chat resumed on it resumes again when next opened.
   */
  private detach(reason: string) {
    const pipe = this.pipe;
    this.pipe = undefined;
    this.heldScreen = undefined;
    this.generation++;
    this.capabilities.disconnected();
    this.kanbanWatch.stop();
    clearTimeout(this.rosterTimer);
    clearInterval(this.heartbeat);
    // A list read on this connection may never answer; the reconnect syncs again without waiting for it.
    this.syncing = undefined;
    this.syncAgain = false;
    // Lets the Rust side end the tunnel.
    if (pipe) this.droppedClosing = pipe.close().catch(() => {}).finally(() => (this.droppedClosing = undefined));
    for (const p of this.pending.values()) p.reject(new ConnectionLostError(`Connection closed: ${reason}`));
    this.pending.clear();
    this.earlyRequests.clear();
    // Runtime sessions end with the connection.
    this.usageFrom.clear();
    this.turnStart.clear();
    this.unprompted.clear();
    this.earlySideAnswers.clear();
    this.sideAwaiting.clear();
    for (const c of this.snapshot.chats) {
      if (c.runtimeId) this.staleItems.set(c.id, c.items.length);
      // So is a chat whose subagents work or whose wake turn is due, so the reconnect hears them (dispatched.ts).
      if (c.running || c.items.some(isWaiting) || followsSession(c, Date.now())) this.resumeOnReconnect.add(c.id);
    }
    // What the dropped connection last heard about the shown profile's sessions is older than its chats' own state,
    // which the reconnect resumes; the next check, once connected, reads it again.
    const live = this.snapshot.live && { ...this.snapshot.live, sessions: this.snapshot.live.sessions.filter((s) => s.profile !== this.profile) };
    // Whatever the turns did meanwhile goes unseen, so the queues wait for the owner to look.
    for (const id of Object.keys(this.snapshot.queues)) this.pauseQueueFor(id, PAUSED.dropped);
    this.update({
      live,
      status: "reconnecting",
      closedReason: reason,
      chats: this.snapshot.chats.map((c) => {
        const subagents = onLost(c.subagents, Date.now());
        const left = subagents === c.subagents ? c : { ...c, subagents };
        return c.runtimeId || c.running
          ? { ...left, runtimeId: undefined, live: undefined, running: false, stopping: false, sideQuestions: c.sideQuestions?.map(lostSide) }
          : left;
      }),
    });
  }

  /** A switch under way, with why it hasn't finished. */
  private switchFailed(e: Error): Pick<Snapshot, "switching"> {
    const switching = this.snapshot.switching;
    return switching ? { switching: { from: switching.from, error: e.message } } : {};
  }

  private retryLater() {
    const wait = RETRY_DELAYS_MS[this.failedTries];
    if (wait !== undefined) this.retryTimer = setTimeout(() => void this.redial(), wait);
    else {
      this.update({ status: "offline" });
      if (this.launchFailed) this.retryTimer = setTimeout(() => void this.redial(), LAUNCH_RETRY_MS);
    }
  }

  private redial(): Promise<void> {
    if (this.closing || this.snapshot.status === "connected") return Promise.resolve();
    this.redialing ??= (async () => {
      clearTimeout(this.retryTimer);
      const switching = this.snapshot.switching;
      // The first try at launch stays Connecting until it has failed once (`openSaved`).
      const status = this.snapshot.status === "connecting" ? "connecting" : "reconnecting";
      this.update({ status, ...(switching && { switching: { from: switching.from } }) });
      try {
        await this.dial();
        this.failedTries = 0;
        this.launchFailed = false;
        this.resumeBusyChats();
        void this.sync();
        // What was live before may have ended meanwhile, so it is asked again at once.
        void this.checkLive();
      } catch (e) {
        if (this.closing) return;
        this.failedTries++;
        this.update({ status: "reconnecting", closedReason: (e as Error).message, ...this.switchFailed(e as Error) });
        // A server that changed protocol won't change back on its own, nor will a token it turned down (ADR 0058).
        if (e instanceof ProtocolMismatchError || TOKEN_REFUSED.test((e as Error).message)) this.update({ status: "offline" });
        else {
          // Retrying a password Hermes turned down would only spend sign-in attempts.
          if ((e as Error).message === WRONG_PASSWORD) this.launchFailed = false;
          this.retryLater();
        }
      } finally {
        this.redialing = undefined;
      }
    })();
    return this.redialing;
  }

  /** Pings Hermes, or drops the connection if it has gone quiet; any frame counts as an answer. */
  private beat() {
    if (Date.now() - this.lastHeard > SILENCE_LIMIT_MS) return this.dropped("Hermes stopped answering.");
    this.request("gateway.ping", {}).catch(() => {});
  }

  /**
   * Stages the attachments for the session's next turn, then submits the message. Images are queued server-side;
   * other files are staged in the session's workspace and their `@file:` refs go before the text, as the official
   * desktop app does. If anything fails the message isn't sent, and images already queued are taken back so they
   * don't ride along with the next one. `goingOut` hears the prompt just before it goes. `hold`: should a turn still be
   * running there, Hermes holds the message until it ends, instead of redirecting or interrupting it (research doc).
   */
  private async submit(runtimeId: string, text: string, attachments: Attachment[], goingOut: (prompt: string) => void, hold = false) {
    const queued: string[] = [];
    const refs: string[] = [];
    try {
      for (const a of attachments) {
        const file = { path: a.path, maxBytes: LIMITS[a.kind].bytes };
        try {
          if (a.kind === "image") {
            const params = { session_id: runtimeId, filename: a.name, content_base64: FILE_MARK };
            queued.push(((await this.request("image.attach_bytes", params, file)) as ImageAttached).path);
          } else {
            const params = { session_id: runtimeId, name: a.name, data_url: `data:application/octet-stream;base64,${FILE_MARK}` };
            refs.push(((await this.request("file.attach", params, file)) as FileAttached).ref_text);
          }
        } catch (e) {
          throw new Error(`Couldn't attach ${a.name}: ${(e as Error).message}`);
        }
      }
      const prompt = [refs.join("\n"), text].filter(Boolean).join("\n\n") || (queued.length ? IMAGE_ONLY_PROMPT : "");
      goingOut(prompt);
      return (await this.request("prompt.submit", { session_id: runtimeId, profile: this.profile, text: prompt, ...(hold && { queued: true }) }).catch((e) => {
        throw e instanceof ConnectionLostError ? new PromptUnconfirmedError(e.message) : e;
      })) as Submitted;
    } catch (e) {
      for (const path of queued) this.track(this.request("image.detach", { session_id: runtimeId, path }));
      throw e;
    }
  }

  /** The chat's runtime id on this connection, resuming it first if needed. The history goes before anything sent
   * meanwhile. */
  private resume(chatId: string): Promise<string> {
    const known = this.snapshot.chats.find((c) => c.id === chatId)?.runtimeId;
    if (known) return Promise.resolve(known);
    let resuming = this.resuming.get(chatId);
    if (resuming) return resuming;
    this.patchChat(chatId, (c) => ({ ...c, loading: true }));
    resuming = (async () => {
      try {
        const profile = this.profile;
        const res = (await this.request("session.resume", { session_id: chatId, profile, inline_images: false })) as {
          session_id: string;
          messages?: TranscriptMessage[];
          /** A live session's turn is still going. */
          running?: boolean;
          /** What a live session is still waiting on, oldest first. */
          open_requests?: ServerRequest[];
          info?: unknown;
          usage?: unknown;
        };
        this.runtimeOwners.set(res.session_id, { profile, chatId });
        // A session reattached mid-turn has counters part of the way through it; a cold one has no agent yet, so its
        // counters start from zero once one is built (`_lazy_resume_info` carries no usage).
        const counters = countersOf((res.info as { usage?: unknown } | undefined)?.usage);
        this.usageFrom.set(res.session_id, res.running ? "unknown" : (counters ?? ZERO_COUNTERS));
        // Hermes stores no usage per reply, so the replies this app measured keep theirs by stored row.
        const measured = new Map<number, ReplyUsage>();
        for (const i of this.snapshot.chats.find((c) => c.id === chatId)?.items ?? [])
          if (i.kind === "assistant" && i.rowId !== undefined && i.usage) measured.set(i.rowId, i.usage);
        const history = historyItems(res.messages ?? []).map((i): Item =>
          i.kind === "assistant" && i.rowId !== undefined && measured.has(i.rowId) ? { ...i, usage: measured.get(i.rowId) } : i,
        );
        const readBack = (res.messages ?? []).map((m) => ({ role: m.role, text: m.text ?? "", rowId: typeof m.row_id === "number" ? m.row_id : undefined }));
        this.noteRows(chatId, readBack.map((m) => m.rowId));
        const stale = this.staleItems.get(chatId) ?? 0;
        this.staleItems.delete(chatId);
        const early = this.earlyRequests.get(res.session_id) ?? [];
        this.earlyRequests.delete(res.session_id);
        const asking = [...(res.open_requests ?? []), ...early];
        // History has no cards. A card that was waiting when the connection dropped either comes back below, or
        // Hermes let go of the session meanwhile and the card stays, closed.
        const lost = (items: Item[]) => endWaitingApprovals(items.filter((i) => isWaiting(i) && !asking.some((r) => r.id === i.id)), "lost");
        for (const i of this.snapshot.chats.find((c) => c.id === chatId)?.items ?? [])
          if (i.kind === "approval" && (i.answer || i.ended)) this.closedApprovals.set(i.id, i);
        // The Saved copy, if shown, is among the stale items. Messages sent from here that Hermes hasn't confirmed go
        // last, and the history settles any that may have reached it (`reconcile`): read back, it wins.
        this.patchChat(chatId, (c) => ({
          ...c,
          runtimeId: res.session_id,
          model: pickFromInfo(res.info) ?? c.model,
          live: withLive(undefined, res.info, res.usage),
          running: c.running || !!res.running,
          savedAt: undefined,
          items: withRows(
            [...history, ...lost(c.items.slice(0, stale)), ...withoutLoadError(c.items.slice(stale)).filter((i) => !isOutgoing(i))],
            reconcile(c.items.filter(isOutgoing), readBack),
          ),
        }));
        this.saveOutbox(chatId);
        this.saveTranscript(chatId);
        this.showApprovals(chatId, asking);
        this.track(this.listSubagents(chatId, res.session_id));
        return res.session_id;
      } finally {
        this.resuming.delete(chatId);
        this.patchChat(chatId, (c) => ({ ...c, loading: false }));
      }
    })();
    this.resuming.set(chatId, resuming);
    return resuming;
  }

  private setArchived(chatId: string, archived: boolean): Promise<boolean> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat || chat.running || !!chat.archived === archived) return Promise.resolve(false);
    const profile = this.profile;
    this.archiveWanted.set(chatId, archived);
    this.archiveUnsure.delete(chatId);
    // A restored chat older than the list's month stays in it.
    if (!archived) this.revealed.add(chatId);
    this.patchChat(chatId, (c) => ({ ...c, archived }));
    this.saveList(profile, this.snapshot.chats);
    const write = (this.archiveWrites.get(chatId) ?? Promise.resolve(false)).then(() => this.writeArchived(chatId, chat.title, profile));
    this.archiveWrites.set(chatId, write);
    void write.finally(() => this.archiveWrites.get(chatId) === write && this.archiveWrites.delete(chatId));
    return write;
  }

  /**
   * Writes the chat's wanted archived flag, then reads the chat back, so only Hermes's answer says how it went. A write
   * that loses to another edit goes again only while Hermes still has the flag as the owner saw it, so a newer archive
   * or restore from another Hermes client isn't overwritten. When the answer is lost and the chat can't be read back,
   * the chat stays where the owner put it and the next refresh reads it back. Resolves to whether Hermes has the chat
   * as the owner wanted it.
   */
  private async writeArchived(chatId: string, title: string, profile: string): Promise<boolean> {
    const archived = this.archiveWanted.get(chatId);
    if (archived === undefined) return false;
    let failure: Error | undefined;
    try {
      await this.patchSession(chatId, profile, { archived }, async () => (await this.readArchived(chatId, profile)) === !archived);
    } catch (e) {
      failure = e as Error;
    }
    let now: boolean | undefined;
    try {
      now = await this.readArchived(chatId, profile);
    } catch (e) {
      // The owner has changed their mind meanwhile; the next write reads back the chat.
      if (this.archiveWanted.get(chatId) !== archived) return false;
      this.archiveUnsure.set(chatId, { profile, title });
      if (this.profile === profile) this.update({ syncError: unsureMessage(title, archived, e as Error) });
      return false;
    }
    if (this.archiveWanted.get(chatId) === archived) this.showArchived(chatId, title, profile, archived, now, failure);
    return now === archived;
  }

  /**
   * Shows the chat as Hermes has it, read back after an archive or restore (`now`: whether it's archived, undefined
   * when it's gone), and says why when that isn't what the owner asked for.
   */
  private showArchived(chatId: string, title: string, profile: string, wanted: boolean, now: boolean | undefined, failure?: Error) {
    this.archiveWanted.delete(chatId);
    this.archiveUnsure.delete(chatId);
    if (this.profile !== profile) return;
    if (now === undefined) {
      this.deleted.add(chatId);
      this.update({
        chats: this.snapshot.chats.filter((c) => c.id !== chatId),
        syncError: `"${title}" is no longer in Hermes: another Hermes client deleted it.`,
      });
    } else {
      this.patchChat(chatId, (c) => ({ ...c, archived: now }));
      const why = failure ? withoutStop(failure.message) : "another Hermes client changed it";
      if (now !== wanted) this.update({ syncError: `Couldn't ${wanted ? "archive" : "restore"} "${title}": ${why}. It's shown as Hermes has it now.` });
    }
    this.saveList(profile, this.snapshot.chats);
  }

  /** Whether Hermes has the chat archived, from its stored row; undefined when the session is gone. */
  private async readArchived(chatId: string, profile: string): Promise<boolean | undefined> {
    try {
      const row = (await this.rest("GET", `api/sessions/${encodeURIComponent(chatId)}?${new URLSearchParams({ profile })}`)) as SessionDetail;
      return !!row.archived;
    } catch (e) {
      if ((e as Error).message.includes("answered 404")) return undefined;
      throw e;
    }
  }

  /** Reads back the archives and restores of the profile whose outcome wasn't known. */
  private async checkUnsureArchives(profile: string) {
    for (const [chatId, unsure] of this.archiveUnsure) {
      const wanted = this.archiveWanted.get(chatId);
      if (unsure.profile !== profile || wanted === undefined) continue;
      try {
        const now = await this.readArchived(chatId, profile);
        if (this.archiveUnsure.get(chatId) === unsure) this.showArchived(chatId, unsure.title, profile, wanted, now);
      } catch (e) {
        if (this.profile === profile) this.update({ syncError: unsureMessage(unsure.title, wanted, e as Error) });
      }
    }
  }

  /** Whether a listed or found chat is archived: as the owner wants it while that isn't confirmed, else as Hermes has it. */
  private isArchived(r: Pick<SessionRow, "id" | "archived">): boolean {
    return this.archiveWanted.get(r.id) ?? !!r.archived;
  }

  /** Resolves to false only when the write to Hermes failed. */
  private setSettled(chatId: string, settled: boolean): Promise<boolean> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat || chat.settled === settled) return Promise.resolve(true);
    this.pinWanted.set(chatId, !settled);
    this.patchChat(chatId, (c) => ({ ...c, settled }));
    return this.writePin(chatId);
  }

  /**
   * Writes the chat's wanted pinned flag once any earlier write for it is done. Each write reads the flag as it goes
   * out, so a quick Undo leaves the server where the owner left the chat. A failed write stays wanted: the chat stays
   * where the owner put it here, and the next finished turn or refresh tries again. A chat with a turn running may
   * not be stored yet, so its failure isn't reported until the end of the turn. `profile` is the chat's, which the
   * owner may have switched away from by the time the write goes out. Resolves to false when the write failed; a refused
   * edit, kept on this computer instead, resolves to true.
   */
  private writePin(chatId: string, profile = this.profile): Promise<boolean> {
    const write = (this.pinWrites.get(chatId) ?? Promise.resolve(true)).then(async () => {
      const pinned = this.pinWanted.get(chatId);
      if (pinned === undefined) return true;
      const running = this.snapshot.chats.find((c) => c.id === chatId)?.running;
      try {
        await this.patchSession(chatId, profile, { pinned });
        this.pinnedSinceListRead.add(chatId);
        if (this.pinWanted.get(chatId) === pinned) this.pinWanted.delete(chatId);
        this.patchChat(chatId, (c) => (c.settledHere ? { ...c, settledHere: undefined } : c));
        return true;
      } catch (e) {
        if (e instanceof EditRefusedError) {
          this.keepSettledHere(chatId, profile, pinned);
          return true;
        }
        if (!running) this.update({ syncError: `Couldn't keep a chat ${pinned ? "Active" : "Settled"} on the server: ${(e as Error).message}` });
        return false;
      }
    });
    this.pinWrites.set(chatId, write);
    void write.finally(() => this.pinWrites.get(chatId) === write && this.pinWrites.delete(chatId));
    return write;
  }

  /**
   * Hermes won't store the chat's pinned flag, so whether it is Active or Settled is kept in this computer's list
   * instead, and not written again until the owner moves it. Off the chat's profile it stays wanted, and is written
   * when the owner comes back to it.
   */
  private keepSettledHere(chatId: string, profile: string, pinned: boolean) {
    if (this.profile !== profile) return;
    if (this.pinWanted.get(chatId) === pinned) this.pinWanted.delete(chatId);
    this.patchChat(chatId, (c) => ({ ...c, settledHere: true }));
    this.saveList(profile, this.snapshot.chats);
  }

  /** Marks a chat on screen read, or once the window is back in focus. */
  private seen(chatId: string) {
    if (this.focused) this.markRead(chatId);
    else this.readWhenBack.add(chatId);
  }

  /** A desktop notification, out of focus only. A missing notification service, or one that refuses, changes nothing. */
  private alert(n: { title: string; body: string }) {
    if (!this.focused) this.track(Promise.resolve().then(() => this.notify(n)));
  }

  /**
   * Clears the chat's dot here at once and moves its shared read watermark to now (`PATCH {unread: false}`), so
   * opening it here clears the dot in every Hermes client. A failed write isn't reported: the next refresh shows
   * the dot again.
   */
  private markRead(chatId: string) {
    this.patchChat(chatId, (c) => (c.unread ? { ...c, unread: false } : c));
    const write: Promise<void> = this.patchSession(chatId, this.profile, { unread: false })
      .then(() => void this.readSinceListRead.add(chatId))
      .catch(() => {})
      .finally(() => this.readWrites.get(chatId) === write && this.readWrites.delete(chatId));
    this.readWrites.set(chatId, write);
    this.track(write);
  }

  /** Shows the title Hermes read back for a renamed chat. */
  private retitled(chatId: string, title: string): string {
    this.retitledSinceListRead.add(chatId);
    this.patchChat(chatId, (c) => ({ ...c, title }));
    return title;
  }

  /** One pass of `syncList`. `current`: whether the pass is still the list's sync, which `detach` ends. */
  private async syncOnce(current: () => boolean): Promise<Error | undefined> {
    const profile = this.profile;
    const cutoff = this.snapshot.olderPulled ? -Infinity : Date.now() - LIST_WINDOW_MS;
    this.pinnedSinceListRead.clear();
    this.readSinceListRead.clear();
    this.retitledSinceListRead.clear();
    const archivedListed = this.snapshot.archivedListed;
    const rows = new Map<string, SessionRow>();
    const botChats = new Set<string>();
    try {
      const recent = await this.readList(profile, "exclude", cutoff);
      for (const r of recent.rows) rows.set(r.id, r);
      for (const id of recent.botChats) botChats.add(id);
      // Every page also carries the pinned chats that aren't archived; the list has them already.
      if (archivedListed) {
        const old = await this.readList(profile, "only", -Infinity);
        for (const r of old.rows) if (r.archived) rows.set(r.id, r);
        for (const id of old.botChats) botChats.add(id);
      }
    } catch (e) {
      if (this.profile === profile && current())
        this.update({ syncError: `Couldn't refresh the chat list: ${(e as Error).message}`, ...this.switchFailed(e as Error) });
      return e as Error;
    }
    // The owner switched profile meanwhile, or the connection dropped; the switch or the reconnect syncs again.
    if (this.profile !== profile || !current()) return undefined;

    const known = new Map(this.snapshot.chats.map((c) => [c.id, c]));
    // A chat new to the list brings its outbox, kept on this computer.
    const outbox = loadOutbox(this.cache, profile);
    const readOnScreen = new Set<string>();
    const listed = [...rows.values()]
      .filter((r) => (this.isArchived(r) ? archivedListed : lastActive(r) >= cutoff) && !this.deleted.has(r.id))
      .map((r): Chat => {
        const c = known.get(r.id);
        // A row read before this app's latest write is stale; the chat stays where the owner put it until the next sync.
        // So is the flag of a chat whose state is kept here.
        const wanted = this.pinWanted.get(r.id) ?? (c && (c.settledHere || this.pinnedSinceListRead.has(r.id)) ? !c.settled : undefined);
        // A write under way may still change the flag, so only an idle chat's flag can confirm it or need a retry. A
        // message still on the way may fail, and the chat then goes back to Settled, so it isn't pinned before then.
        if (this.pinWanted.has(r.id) && !this.pinWrites.has(r.id) && !this.pinnedSinceListRead.has(r.id)) {
          if (wanted === !!r.pinned) this.pinWanted.delete(r.id);
          else if (!this.submitting.has(r.id)) this.track(this.writePin(r.id));
        }
        // A row read before this app marked the chat read is stale too.
        const readHere = this.readWrites.has(r.id) || this.readSinceListRead.has(r.id);
        const onScreen = this.isViewing(r.id);
        if (onScreen && r.unread && !readHere) readOnScreen.add(r.id);
        return {
          items: outbox[r.id] ?? [],
          ...c,
          id: r.id,
          // A row read before this app's latest rename is stale too.
          title: c && this.retitledSinceListRead.has(r.id) ? c.title : listTitle(r, c?.title),
          // A branch made here is this app's, though Hermes stores it with the source the parent was resumed as.
          source: this.snapshot.branches.links[r.id] ? "app" : toSource(r.source, r.created_source),
          settled: !(wanted ?? r.pinned),
          archived: this.isArchived(r) || undefined,
          updatedAt: Math.max(c?.updatedAt ?? 0, lastActive(r)),
          unread: !!r.unread && !readHere && !onScreen,
          // List rows carry the stored token and cost totals too.
          usage: newerChatUsage(c?.usage, chatUsageOf(r, Date.now())),
          ...(Array.isArray(r._lineage_ids) && { lineage: r._lineage_ids.filter((x): x is string => typeof x === "string") }),
        };
      });
    // Chats started or resumed on this connection stay even before Hermes stores them (a new chat has no row
    // until its first prompt), and so do chats picked from a search and chats being archived or restored.
    const listedIds = new Set(listed.map((c) => c.id));
    // One Hermes now lists as a Bot Chat, such as an ordinary chat renamed to the title in another client, stays out
    // of the list from now on, and is marked so every Bot Chat rule applies to it (ADR 0066).
    const onThisConnection = this.snapshot.chats
      .filter((c) => (c.runtimeId || this.revealed.has(c.id) || this.archiveWanted.has(c.id)) && !listedIds.has(c.id))
      .map((c) => (botChats.has(c.id) && !c.bot ? { ...c, bot: true, title: BOT_CHAT_TITLE } : c));
    const chats = [...onThisConnection, ...listed];
    this.listedAt = Date.now();
    const switched = !!this.snapshot.switching;
    this.update({ chats, syncError: undefined, switching: undefined });
    this.kanbanWatch.chatsListed();
    this.placeRoster();
    for (const chatId of readOnScreen) this.seen(chatId);
    this.saveList(profile, chats);
    if (switched) this.cache.rememberProfile(profile);
    const busy = this.busyIn.get(profile);
    this.busyIn.delete(profile);
    for (const id of busy ?? []) this.resumeOnReconnect.add(id);
    if (busy) this.resumeBusyChats();
    await this.checkUnsureArchives(profile);
    await this.checkUnknownSends(profile);
    await this.checkBranchAttempts(profile);
    return undefined;
  }

  /**
   * Reads the profile's chats from dashboard REST, most recent first, `archived` ones excluded or only those, until
   * the list passes `cutoff`. Every page also carries all pinned rows, archived or not, out of order; the unpinned
   * ones follow recency. `sources`: only chats from these, as Hermes stores them. `more`: the list goes on past the
   * most pages read.
   */
  private async readList(profile: string, archived: "exclude" | "only" | "include", cutoff: number, sources?: string): Promise<{ rows: SessionRow[]; more: boolean; botChats: Set<string> }> {
    const rows: SessionRow[] = [];
    /** The Bot Chats the pages held, which the list leaves out (`isBotChatRow`). */
    const botChats = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const query = new URLSearchParams({
        profile,
        order: "recent",
        limit: String(PAGE_SIZE),
        offset: String(offset),
        exclude_sources: "cron",
        ...(archived !== "exclude" && { archived }),
        ...(sources && { sources }),
      });
      const res = (await this.rest("GET", `api/sessions?${query}`)) as SessionPage;
      // A Bot Chat is opened from its bot's row only, never from the list (ADR 0066). Hermes lists them hidden, except
      // in the archived view, and one born visible elsewhere is still named "Bot Chat".
      for (const r of res.sessions) (this.isBotChatRow(profile, r) ? botChats.add(r.id) : rows.push(r));
      const passedCutoff = res.sessions.some((r) => !r.pinned && lastActive(r) < cutoff);
      if (passedCutoff || res.sessions.length === 0 || offset + PAGE_SIZE >= res.total) return { rows, more: false, botChats };
    }
    return { rows, more: true, botChats };
  }

  /**
   * How many chats in another profile's list are Unread, counted as the list would show them, from one page of its
   * most recent chats. `more`: the list reaches past that page, so there may be more.
   */
  private async unreadIn(profile: string): Promise<{ unread: number; more: boolean; chats: ListedChat[] }> {
    const cutoff = this.cache.olderPulled(profile) ? -Infinity : Date.now() - LIST_WINDOW_MS;
    const query = new URLSearchParams({ profile, order: "recent", limit: String(OTHER_PAGE_SIZE), offset: "0", exclude_sources: "cron" });
    const res = (await this.rest("GET", `api/sessions?${query}`)) as SessionPage;
    const chats = res.sessions
      .filter((r) => !r.archived && !this.deleted.has(r.id) && !this.isBotChatRow(profile, r))
      .map((r): ListedChat => ({ id: r.id, title: listTitle(r), at: lastActive(r), unread: !!r.unread && lastActive(r) >= cutoff, source: toSource(r.source) }));
    // As in syncOnce: the page also carries every pinned row, and the unpinned ones follow recency.
    const passedCutoff = res.sessions.some((r) => !r.pinned && lastActive(r) < cutoff);
    return { unread: chats.filter((c) => c.unread).length, more: !passedCutoff && res.sessions.length > 0 && OTHER_PAGE_SIZE < res.total, chats };
  }

  /** The Failed messages this computer keeps for the profile's chats, with the titles its saved list has. */
  private sendsIn(profile: string): SavedSend[] {
    const titles = new Map(this.cache.load(profile).map((c) => [c.id, c.title]));
    return Object.entries(loadOutbox(this.cache, profile)).flatMap(([chatId, rows]) =>
      rows.flatMap((r): SavedSend[] =>
        r.outgoing.state === "sending" ? [] : [{ chatId, itemId: r.id, state: r.outgoing.state, title: titles.get(chatId) ?? this.titlesSeen.get(`${profile} ${chatId}`) }],
      ),
    );
  }

  /** Keeps the profile's list for the next start, without the chats' transcripts. */
  private saveList(profile: string, chats: Chat[]) {
    this.cache.save(
      profile,
      // A Bot Chat isn't part of the list, so it isn't kept as part of it (ADR 0066).
      chats.filter((c) => !isBotChat(c)).map(({ id, title, source, settled, settledHere, archived, updatedAt, unread }) => ({
        id,
        title,
        source,
        settled,
        settledHere,
        archived,
        updatedAt,
        unread,
        items: [],
      })),
    );
  }

  /**
   * Sets a session's sidebar flags. Hermes refuses a session edit without a request id and the session's current
   * revision (409 `client_upgrade_required`), so each write first reads the revision from the mutation snapshot.
   * The flags are plain values, so a write that loses to another edit of the same session (`revision_conflict`) is
   * sent once more against the new revision, if `retry` agrees. A session Hermes has but answers 404 for is
   * `EditRefusedError`.
   */
  private async patchSession(
    chatId: string,
    profile: string,
    flags: { pinned?: boolean; unread?: boolean; archived?: boolean },
    retry: () => Promise<boolean> = async () => true,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const { exists, runtime_revision } = await this.mutationSnapshot(chatId, profile);
      try {
        return await this.fencedPatch(chatId, profile, flags, runtime_revision);
      } catch (e) {
        if (exists && (e as Error).message.includes("answered 404")) throw new EditRefusedError((e as Error).message);
        if (attempt > 0 || !(e as Error).message.includes("revision_conflict") || !(await retry())) throw e;
      }
    }
  }

  /** The session's current revision, which every session edit must name (`GET .../mutation-snapshot`). */
  private async revision(chatId: string, profile: string): Promise<number> {
    return (await this.mutationSnapshot(chatId, profile)).runtime_revision;
  }

  private async mutationSnapshot(chatId: string, profile: string): Promise<MutationSnapshot> {
    const query = new URLSearchParams({ profile });
    return (await this.rest("GET", `${sessionPath(chatId)}/mutation-snapshot?${query}`)) as MutationSnapshot;
  }

  /**
   * One session edit against `revision`, with a new request id. A profile switch can redial between reading the
   * revision and writing; the edit names its profile, so it goes out on the new connection.
   */
  private async fencedPatch(chatId: string, profile: string, edit: Record<string, unknown>, revision: number): Promise<void> {
    if (!this.pipe) await this.redialing;
    await this.rest("PATCH", sessionPath(chatId), { ...edit, profile, request_id: crypto.randomUUID(), expected_revision: revision });
  }

  /**
   * Deletes a session for good, fenced like an edit: Hermes (v0.22.6) refuses a DELETE that doesn't name a new
   * request id, the session's revision and its generation, with `client_upgrade_required` when it names none. A session
   * Hermes doesn't have has no generation; naming 0 then answers that it's already gone. The owner already said yes, so
   * a session that moved on between the read and the delete (`revision_conflict`, `stale_generation`), say from this
   * app's own read mark as the chat closed, is read again and deleted, once.
   */
  private async fencedDelete(chatId: string, profile: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const { runtime_revision, runtime_generation } = await this.mutationSnapshot(chatId, profile);
      const query = new URLSearchParams({
        profile,
        request_id: crypto.randomUUID(),
        expected_revision: String(runtime_revision),
        expected_generation: String(runtime_generation ?? 0),
      });
      // As for an edit, a profile switch can redial between the read and the delete, which names its profile.
      if (!this.pipe) await this.redialing;
      try {
        await this.rest("DELETE", `${sessionPath(chatId)}?${query}`);
        return;
      } catch (e) {
        if (attempt > 0 || !/revision_conflict|stale_generation/.test((e as Error).message)) throw e;
      }
    }
  }

  /** The chat's title as Hermes stores it now (`GET /api/sessions/{id}`), shown the way the list shows it. */
  private async readTitle(chatId: string, profile: string): Promise<string> {
    const row = (await this.rest("GET", `${sessionPath(chatId)}?${new URLSearchParams({ profile })}`)) as SessionRow;
    return listTitle(row);
  }

  /** See `loadModels`. */
  private async readModels(profile: string): Promise<ModelCatalog> {
    const why: string[] = [];
    const read = async (what: string, ask: () => Promise<unknown>) => {
      try {
        const catalog = catalogFromServer(profile, await timeLimit(ask(), MODELS_TIMEOUT_MS));
        if (!catalog) why.push(`${what} listed no models`);
        return catalog;
      } catch (e) {
        why.push(`${what}: ${withoutStop((e as Error).message)}`);
        return undefined;
      }
    };
    const catalog =
      (await read("model.options", () => this.request("model.options", { profile }))) ??
      (await read("GET /api/model/options", () => this.rest("GET", `api/model/options?${new URLSearchParams({ profile })}`))) ??
      fallbackCatalog(profile, await this.modelInUse(profile), why.join("; "));
    catalog.defaultPick ??= await this.modelInUse(profile);
    // `config.get reasoning` without a session reads the profile's effort; it writes nothing.
    const effort = await timeLimit(this.request("config.get", { key: "reasoning", profile }), MODELS_TIMEOUT_MS).then(
      (r) => (r as { value?: unknown } | undefined)?.value,
      () => undefined,
    );
    return isEffort(effort) ? { ...catalog, defaultEffort: effort } : catalog;
  }

  /** The model a chat on this connection runs on, else the profile's, as dashboard REST lists the profiles. */
  private async modelInUse(profile: string): Promise<ModelPick | undefined> {
    const chat = this.snapshot.chats.find((c) => c.model)?.model;
    if (chat) return { provider: chat.provider, model: chat.model };
    try {
      const p = ((await this.rest("GET", "api/profiles")) as ProfileList).profiles.find((p) => p.name === profile);
      return p?.model ? { provider: p.provider || "custom", model: p.model } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A file on the Hermes server, for the preview pane, read for the profile shown (preview.ts `readServerFile`). Hermes
   * reads it where its tools run, which for a profile with an SSH terminal backend is that machine. `session`: the chat
   * whose sandbox the path is in (ADR 0062).
   */
  readServerFile(path: string, session?: string): Promise<FileView> {
    return readServerFile((q) => this.rest("GET", q), path, this.snapshot.profile, session);
  }

  /**
   * A file on the dashboard's own machine, for the preview pane: found in its folder's listing and read through the
   * managed files routes, as the Server files screen reads it (ADR 0012), within that screen's preview limits. For
   * the audio and images Hermes saves itself, which aren't where a profile with an SSH terminal runs its tools.
   */
  async readHostFile(path: string): Promise<FileView> {
    const { dir, name } = splitPath(path);
    const entry = (await this.files.list(dir)).entries.find((e) => e.name === name);
    if (!entry || entry.kind !== "file") throw new Error("There's no file at this path on the dashboard's machine.");
    const support = previewSupport(entry);
    if (support.kind === "none") return { kind: "unsupported", reason: support.why, size: entry.size };
    return hostFileView(await this.files.preview(entry, support.kind === "maybe-text"));
  }

  /**
   * How Outputs reads Hermes for `profile` (outputs.ts): a chat's stored rows through dashboard REST, each page refused
   * past its size limit, and a folder's listing through `GET /api/fs/list`, where the profile's tools run. Every
   * request names the profile, so a run for a profile left behind still reads only that profile.
   */
  outputsIo(profile: string): OutputsIo {
    return {
      rows: async (chatId, offset, limit, maxBytes) => {
        const query = new URLSearchParams({ profile, order: "latest", limit: String(limit), offset: String(offset), inline_images: "false" });
        const body = await this.restGet(`${sessionPath(chatId)}/messages?${query}`, maxBytes);
        const res = JSON.parse(body) as { messages?: unknown };
        // UTF-8 bytes, as Rust counted them against the limit.
        return { rows: Array.isArray(res.messages) ? (res.messages as StoredOutputRow[]) : [], bytes: new TextEncoder().encode(body).byteLength };
      },
      listDir: async (path, host) => {
        // The dashboard's own machine, through the managed files routes Server files lists with (ADR 0012).
        if (host)
          return this.files.list(path).then(
            (l) => ({ entries: l.entries.map((e) => ({ name: e.name, isDirectory: e.kind === "dir" })) }),
            (e: unknown) => {
              const status = e instanceof RemoteFilesError ? e.status : undefined;
              const message = e instanceof Error ? e.message : String(e);
              if (status === 404 && /isn't on the server/.test(message)) return { entries: [], error: "ENOENT" };
              if (status === 400 && /not a folder/.test(message)) return { entries: [], error: "ENOTDIR" };
              if (status === 403) return { entries: [], error: "EACCES" };
              throw new Error(message);
            },
          );
        const res = JSON.parse(await this.restGet(`api/fs/list?${new URLSearchParams({ path, profile })}`, LIST_MAX_BYTES)) as { entries?: unknown; error?: unknown };
        const entries = (Array.isArray(res.entries) ? res.entries : []).flatMap((e: { name?: unknown; isDirectory?: unknown }) =>
          typeof e?.name === "string" ? [{ name: e.name, isDirectory: e.isDirectory === true }] : [],
        );
        return { entries, ...(typeof res.error === "string" && { error: res.error }) };
      },
      // Read as Preview reads it, naming the chat (ADR 0062). `read-text` reads at most 512 KB of the file.
      confirm: async (path, session) => {
        try {
          await this.restGet(`api/fs/read-text?${new URLSearchParams({ path, profile, session_id: session })}`, LIST_MAX_BYTES);
          return { state: "available" };
        } catch (e) {
          return outputFound(e instanceof Error ? e.message : String(e));
        }
      },
    };
  }

  /**
   * The last `lines` lines of one of `profile`'s Hermes log files (`GET /api/logs`, logs.ts, ADR 0033), as Hermes
   * answers it: `{file, lines}`. Only while connected; refused past `LIST_MAX_BYTES`.
   */
  async readLog(profile: string, file: string, lines: number): Promise<unknown> {
    return JSON.parse(await this.restGet(`api/logs?${new URLSearchParams({ file, lines: String(lines), profile })}`, LIST_MAX_BYTES));
  }

  /**
   * How Usage analytics reads Hermes (usageAnalytics.ts, ADR 0026): the stored session rows, every source and archived
   * ones too, newest started first; one stored session by id; and Hermes's own sums for a rolling period. Every request
   * names its profile, and reads only while connected.
   */
  usageIo(): UsageIo {
    const get = async (pathAndQuery: string) => JSON.parse(await this.restGet(pathAndQuery)) as unknown;
    return {
      page: async (profile, offset, limit) => {
        const query = new URLSearchParams({ profile, order: "created", archived: "include", limit: String(limit), offset: String(offset) });
        const res = (await get(`api/sessions?${query}`)) as { sessions?: unknown; total?: unknown };
        return { rows: Array.isArray(res.sessions) ? res.sessions : [], total: typeof res.total === "number" ? res.total : 0 };
      },
      session: (profile, id) => get(`${sessionPath(id)}?${new URLSearchParams({ profile })}`),
      hermesTotals: (profile, days) => get(`api/analytics/usage?${new URLSearchParams({ days: String(days), profile })}`),
    };
  }

  private async rest(method: RestMethod, pathAndQuery: string, body?: unknown): Promise<unknown> {
    // Once closed (signed out), nothing more goes out: the Rust side relays through whichever sign-in is current, which
    // may be another server's by then.
    if (!this.pipe || this.closing) throw new Error("Not connected to Hermes.");
    return JSON.parse(await this.relay(this.pipe, method, pathAndQuery, body));
  }

  /**
   * One dashboard REST call through `pipe`. A write whose capability Hermes lacks is refused before it is sent
   * (`CapabilityUnsupportedError`), and a GET's answer tells diagnostics about its route, for the connection it went
   * out on.
   */
  private relay(pipe: Pipe, method: RestMethod, pathAndQuery: string, body?: unknown): Promise<string> {
    const refused = this.capabilities.refuses({ rest: method, path: pathAndQuery });
    if (refused) return Promise.reject(new CapabilityUnsupportedError(refused));
    const answer = pipe.request(method, pathAndQuery, body === undefined ? undefined : JSON.stringify(body));
    if (method === "GET") this.observe({ route: pathAndQuery }, answer);
    else this.observeWrite({ route: pathAndQuery }, answer);
    return answer;
  }

  /**
   * A REST GET's raw answer, refused past `maxBytes` when that is given. Only while connected. `observe`: whether its
   * answer tells diagnostics about the route; not for the checks diagnostics makes itself.
   */
  private restGet(pathAndQuery: string, maxBytes?: number, observe = true): Promise<string> {
    const pipe = this.pipe;
    if (!pipe || this.snapshot.status !== "connected") return Promise.reject(new Error("Not connected to Hermes."));
    const answer = maxBytes === undefined ? pipe.request("GET", pathAndQuery) : pipe.getLimited(pathAndQuery, maxBytes);
    if (observe) this.observe({ route: pathAndQuery }, answer);
    return answer;
  }

  /** Tells diagnostics how a request the screens made was answered, with the answer, for the connection it went out on. */
  private observe(call: { route: string } | { method: string }, answer: Promise<unknown>) {
    const gen = this.generation;
    answer.then(
      (value) => this.capabilities.observe(gen, call, undefined, value),
      (e: unknown) => this.capabilities.observe(gen, call, e),
    );
  }

  /** Tells diagnostics when a change the screens sent failed, so a route or method Hermes lacks isn't sent to again. */
  private observeWrite(call: { route: string } | { method: string }, answer: Promise<unknown>) {
    const gen = this.generation;
    answer.catch((e: unknown) => this.capabilities.observeWrite(gen, call, e));
  }

  private track(p: Promise<unknown>) {
    const done: Promise<unknown> = p.catch(() => {}).finally(() => this.background.delete(done));
    this.background.add(done);
  }

  /** One JSON-RPC request. With a `file`, the pipe swaps its base64 in for the `FILE_MARK` in `params`. */
  private request(method: string, params: Record<string, unknown>, file?: { path: string; maxBytes: number }, observe = true): Promise<unknown> {
    const pipe = this.pipe;
    if (!pipe || this.snapshot.status !== "connected") return Promise.reject(new Error("Not connected to Hermes."));
    // A method that changes something, for a capability Hermes lacks, isn't sent.
    const refused = this.capabilities.refuses({ rpc: method });
    if (refused) return Promise.reject(new CapabilityUnsupportedError(refused));
    const id = this.nextId++;
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    // Diagnostics learns from the screens' own requests (not its own checks), for the connection each went out on.
    if (observe) {
      this.observe({ method }, done);
      this.observeWrite({ method }, done);
    }
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const [head, tail, ...rest] = frame.split(JSON.stringify(FILE_MARK).slice(1, -1));
    const sent = !file
      ? pipe.send(frame)
      : rest.length === 0 && tail !== undefined
        ? pipe.sendFile(head, file.path, tail, file.maxBytes)
        : Promise.reject(new Error("the request has no single place for the file"));
    sent.catch((err) => {
      this.pending.get(id)?.reject(err instanceof Error ? err : new Error(String(err)));
      this.pending.delete(id);
    });
    return done;
  }

  /**
   * The one way a message sent from here changes: `change` maps its row to what it becomes (`confirmed` once Hermes
   * has it, a row still outgoing, or null when it goes), and the chat's outbox is kept with it. For a profile no longer
   * shown, only its kept outbox changes.
   */
  private setOutgoing(profile: string, chatId: string, itemId: string, change: (row: OutgoingItem) => Item | null) {
    const apply = (items: Item[]) => items.flatMap((i) => (i.id === itemId && isOutgoing(i) ? (change(i) ?? []) : [i]));
    if (profile !== this.profile) return this.cache.saveOutbox(profile, chatId, apply(this.cache.loadOutbox(profile)[chatId] ?? []).filter(isOutgoing));
    this.patchChat(chatId, (c) => ({ ...c, items: apply(c.items) }));
    this.saveOutbox(chatId);
  }

  /** Keeps the chat's messages sent from here that Hermes hasn't confirmed, so they outlive a restart. */
  /** False: storage refused it. */
  private saveOutbox(chatId: string): boolean {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    return !chat || this.cache.saveOutbox(this.profile, chatId, chat.items.filter(isOutgoing)) !== false;
  }

  /** Notes stored row ids seen in a chat, for `knownRow`. */
  private noteRows(chatId: string, ids: unknown[]) {
    const newest = Math.max(this.knownRow.get(chatId) ?? -Infinity, ...ids.filter((n): n is number => typeof n === "number"));
    if (Number.isFinite(newest)) this.knownRow.set(chatId, newest);
  }

  /**
   * Settles the messages that may have reached Hermes in chats not loaded on this connection, by reading back each
   * chat's newest stored rows. One found there goes from the outbox: the chat's history shows it. One Hermes doesn't
   * have is marked failed. When the rows read don't reach back to when it went out, or can't be read, it stays unknown
   * until the next refresh, or until the chat is opened, whose resume settles it from the full history.
   */
  private async checkUnknownSends(profile: string) {
    for (const chat of this.snapshot.chats) {
      if (chat.runtimeId || this.resuming.has(chat.id) || !chat.items.some((i) => isOutgoing(i) && i.outgoing.state === "unknown")) continue;
      let readBack: ReadBack[];
      try {
        const query = new URLSearchParams({ profile, order: "latest", limit: String(READ_BACK_ROWS), inline_images: "false" });
        const res = (await this.rest("GET", `${sessionPath(chat.id)}/messages?${query}`)) as { messages?: (StoredRow & StoredMessage)[] };
        // Stored rows hold a skill's whole text; Hermes's history shows its invocation, which is what went out from here.
        readBack = (res.messages ?? []).map((m) => {
          const text = storedText(m.content);
          return { role: m.role ?? "", text: skillInvocationText(text) ?? text, rowId: m.id };
        });
      } catch {
        continue;
      }
      if (this.profile !== profile) return;
      // Fewer rows than asked for is the whole history; otherwise only rows past the oldest one read can be ruled out.
      const whole = readBack.length < READ_BACK_ROWS;
      const reaches = (after?: number) => whole || (after !== undefined && readBack.some((m) => m.rowId !== undefined && m.rowId <= after));
      for (const row of chat.items.filter(isOutgoing)) this.setOutgoing(profile, chat.id, row.id, (r) => settle(r, readBack, reaches));
    }
  }

  /** Gives each chat the dispatched tasks the watch has for its id or any of its lineage; a chat whose tasks didn't change is kept. */
  private placeTasks(by: ReadonlyMap<string, readonly DispatchedTask[]>) {
    let changed = false;
    const chats = this.snapshot.chats.map((c) => {
      const seen = new Set<string>();
      const tasks = [c.id, ...(c.lineage ?? [])].flatMap((sid) => by.get(sid) ?? []).filter((t) => !seen.has(t.id) && seen.add(t.id));
      const was = c.tasks ?? [];
      if (was.length === tasks.length && was.every((t, i) => sameTask(t, tasks[i]))) return c;
      changed = true;
      return { ...c, tasks: tasks.length ? tasks : undefined };
    });
    if (changed) this.update({ chats });
  }

  private patchChat(id: string, fn: (c: Chat) => Chat, nextFrame = false) {
    if (!this.snapshot.chats.some((c) => c.id === id)) return;
    this.update({ chats: this.snapshot.chats.map((c) => (c.id === id ? fn(c) : c)) }, nextFrame);
  }

  /**
   * Changes the snapshot. Listeners hear of it at once, or with `nextFrame`, at the next animation frame, along with
   * every other change made by then; any change heard of at once before that takes the waiting ones with it.
   */
  private update(patch: Partial<Snapshot>, nextFrame = false) {
    if (patch.chats) patch = { ...patch, chats: keepSidePlaces(this.snapshot.chats, patch.chats) };
    this.snapshot = { ...this.snapshot, ...patch };
    if (nextFrame) this.notifySoon();
    else this.tellListeners();
    this.pumpSoon();
  }

  private tellListeners() {
    this.cancelNotify();
    for (const fn of this.listeners) fn();
  }

  /**
   * Calls the listeners at the next animation frame, or after `NOTIFY_LATEST_MS` in a window that draws no frames,
   * whichever comes first. Then both are cancelled, so neither tells of a later batch out of turn.
   */
  private notifySoon() {
    if (this.notifyDue) return;
    // Each call checks it is still the batch due, in case its cancelling didn't take (no cancelAnimationFrame).
    const batch: NonNullable<Hermes["notifyDue"]> = { timer: setTimeout(() => flush(), NOTIFY_LATEST_MS) };
    const flush = () => this.notifyDue === batch && this.tellListeners();
    if (typeof requestAnimationFrame === "function") batch.frame = requestAnimationFrame(flush);
    this.notifyDue = batch;
  }

  private cancelNotify() {
    if (!this.notifyDue) return;
    if (this.notifyDue.frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.notifyDue.frame);
    clearTimeout(this.notifyDue.timer);
    this.notifyDue = undefined;
  }
}

/**
 * A side question whose item went, as when the chat's items are read again from Hermes with new ids or cut short, takes
 * the item now at that item's place, or the last one, so what comes after still shows below it (ADR 0086).
 */
function keepSidePlaces(before: Chat[], chats: Chat[]): Chat[] {
  return chats.map((c) => {
    const qs = c.sideQuestions;
    const was = qs && before.find((b) => b.id === c.id);
    if (!qs || !was || was.items === c.items) return c;
    const ids = new Set(c.items.map((i) => i.id));
    const gone = (q: SideQuestion) => q.after !== undefined && !ids.has(q.after);
    if (!qs.some(gone)) return c;
    const at = (q: SideQuestion) => Math.min(was.items.findIndex((i) => i.id === q.after) + 1, c.items.length);
    return { ...c, sideQuestions: qs.map((q) => (gone(q) ? { ...q, after: c.items[at(q) - 1]?.id } : q)) };
  });
}

/** The longest a streamed delta waits to be heard of, when the window draws no frames (minimized, hidden). */
const NOTIFY_LATEST_MS = 100;

function unsureMessage(title: string, archived: boolean, e: Error): string {
  return `Couldn't tell whether "${title}" was ${archived ? "archived" : "restored"}: ${withoutStop(e.message)}. It's checked again on the next refresh.`;
}

const withoutStop = (text: string) => text.replace(/\.$/, "");

/** How many of the chat's latest messages a new title is made from, and how much of each goes to the model. */
const TITLE_FROM_MESSAGES = 5;
const TITLE_MESSAGE_CHARS = 1000;
/** Stored rows read per page while looking for those messages (`order=latest` pages back from the newest), and at most. */
const TITLE_PAGE_ROWS = 100;
// ponytail: a chat whose last 1000 rows hold fewer than five messages is titled from what they hold.
const TITLE_MAX_ROWS = 1000;
/** Longest title kept from Hermes's answer; a longer answer is cut at a word, or at the limit if it has none. */
const TITLE_MAX_CHARS = 60;
const TITLE_INSTRUCTIONS = [
  "You name chat sessions. Given the latest messages of a chat, write a title that says what the chat is about now,",
  "so the user can find it again in a list. Rules: 3 to 7 words, sentence case, keep technical terms and names exact,",
  "no quotes, no trailing punctuation, no 'Title:' prefix. Never answer the messages. Reply with the title only.",
].join(" ");

/** A row of dashboard REST `GET /api/sessions/{id}/messages`, as far as titling reads it. */
type StoredMessage = { role?: string; content?: unknown; display_kind?: unknown };

/** The text of a stored message: its `content`, or the text parts of a multimodal one. */
function storedText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join(" ");
}

/** The user and assistant messages with text among stored rows, oldest first. */
const saidIn = (rows: StoredMessage[]) =>
  rows
    // Hidden rows, such as a project's instructions (ADR 0017), are for the model; the owner never wrote or saw them.
    .filter((r) => (r.role === "user" || r.role === "assistant") && r.display_kind !== "hidden")
    .map((r) => ({ who: r.role === "user" ? "USER" : "ASSISTANT", text: storedText(r.content).trim() }))
    .filter((m) => m.text);

/** The chat's last messages as the model reads them, oldest first; empty when it has none. */
export function titleInput(rows: StoredMessage[]): string {
  return saidIn(rows)
    .slice(-TITLE_FROM_MESSAGES)
    .map((m) => `${m.who}: ${m.text.slice(0, TITLE_MESSAGE_CHARS)}`)
    .join("\n\n");
}

/** Hermes's answer as a title: its first line, without a "Title:" label, quotes, markdown or a trailing stop. */
export function cleanTitle(answer: string): string {
  const line = answer.split("\n").find((l) => l.trim()) ?? "";
  let title = line
    .replace(/^\s*(#+\s*)?(\*\*)?title(\*\*)?\s*:\s*/i, "")
    .replace(/^[\s"'“”‘’`*_]+|[\s"'“”‘’`*_.!?]+$/g, "");
  // One character more than fits shows whether the cut lands inside a word, which then goes.
  // With no space to cut at, it is cut at the limit, never inside a character.
  if (title.length > TITLE_MAX_CHARS)
    title = title
      .slice(0, TITLE_MAX_CHARS + 1)
      .replace(/\s+\S*$/, "")
      .slice(0, TITLE_MAX_CHARS)
      .replace(/[\uD800-\uDBFF]$/, "");
  return title.trim();
}

/** How long setup waits for Hermes's list of provider keys. */
const PROVIDERS_TIMEOUT_MS = 20_000;

/** `p`, or a rejection once `ms` have passed without an answer. */
function timeLimit<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("Hermes didn't answer in time.")), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** The most a folder listing for Outputs may be: a folder of tens of thousands of entries. */
const LIST_MAX_BYTES = 8 * 1024 * 1024;

/**
 * What a failed `read-text` naming an Output's chat says about the file (outputs.ts `OutputsIo.confirm`, ADR 0062), or
 * undefined when Hermes no longer has the chat. A file too large to preview, or one Hermes is using, is there.
 */
export function outputFound(message: string): { state: "missing" | "folder" | "forbidden" | "available" | "unknown"; why?: string } | undefined {
  if (SESSION_GONE.test(message)) return undefined;
  const m = /^The dashboard answered (\d{3}): ([\s\S]*)$/.exec(message);
  if (!m) return { state: "unknown", why: message };
  let detail = m[2];
  try {
    const d = (JSON.parse(m[2]) as { detail?: unknown }).detail;
    if (typeof d === "string") detail = d;
  } catch {
    // As it came.
  }
  const status = Number(m[1]);
  if (status === 404 && detail.startsWith(SANDBOX_NOT_FOUND_PREFIX)) return { state: "missing", why: SANDBOX_MISSING };
  if (status === 404 && detail === "File not found") return { state: "missing", why: "It isn't at this path where its chat's tools ran: it was deleted, moved or renamed." };
  if (status === 400 && detail === "Path points to a directory") return { state: "folder" };
  if (status === 403) return { state: "forbidden", why: "The server refused to read it." };
  if (status === 413 || status === 409) return { state: "available" };
  return { state: "unknown", why: `The server couldn't read it (${status}): ${detail}` };
}

const sessionPath = (chatId: string) => `api/sessions/${encodeURIComponent(chatId)}`;

/** A session's title as the list shows it: an untitled one by its first words. */
function listTitle(r: Pick<SessionRow, "title" | "preview">, known?: string): string {
  return r.title || r.preview || known || "Untitled chat";
}

/** `prompt.submit` went out and the connection dropped before Hermes answered it. */
class PromptUnconfirmedError extends Error {}

function lastActive(r: Pick<SessionRow, "last_active" | "started_at">): number {
  return (r.last_active ?? r.started_at ?? 0) * 1000;
}

/** An FTS5 snippet as text with the matched words marked, on one line. */
function snippetParts(snippet: string): Found["snippet"] {
  return snippet
    .replace(/\s+/g, " ")
    .split(/>>>(.*?)<<</)
    .flatMap((text, i) => (!text ? [] : i % 2 ? [{ text, hit: true }] : [{ text }]));
}

/**
 * What find-in-chat looks for in a chat found by `q`: a one-word `q` where the snippet holds it, else the first
 * matched word, since Hermes matches each word of `q` on its own and as a prefix. Several words are never looked for
 * together: on screen, a line break or formatting can sit between them.
 */
function findTerm(q: string, snippet: Found["snippet"]): string {
  const plain = snippet.map((p) => p.text).join("");
  if (!/\s/.test(q) && plain.toLowerCase().includes(q.toLowerCase())) return q;
  return snippet.find((p) => p.hit)?.text ?? q;
}

/** A chat's Source from the session's `source` field. This app's own chats, `gui` ones, show no icon. */
/** How Hermes stores each source this app tells apart; `other` is everything else, so it can't be asked for. */
const RAW_SOURCES: Record<Exclude<Source, "other">, string[]> = {
  app: [APP_SOURCE, OLD_APP_SOURCE],
  telegram: ["telegram"],
  discord: ["discord"],
  desktop: ["desktop"],
  cli: ["cli", "tui"],
  import: ["import"],
};

/**
 * `sources` as dashboard REST's `sources=` takes them; undefined when they can't be asked for that way. Hermes stores
 * its canonical CLI, TUI and desktop chats as `local` (naming the surface in `created_source`, which `sources=` doesn't
 * look at), so `local` is asked for too and those chats are told apart here.
 */
function rawSources(sources?: Source[]): string | undefined {
  if (!sources?.length || sources.includes("other")) return undefined;
  const raw = sources.flatMap((s) => RAW_SOURCES[s as Exclude<Source, "other">]);
  return [...raw, ...(sources.some((s) => s === "app" || s === "cli" || s === "desktop") ? ["local"] : [])].join(",");
}

/** The surface a `local` chat was started on, when Hermes has stamped one (`_UNSET_CREATED_SOURCES` at `bf0203a`). */
const localSurface = (created?: string | null) => (created && created !== "unknown" && created !== "local" ? created : undefined);

export function toSource(stored = "", created?: string | null): Source {
  const source = stored === "local" ? (localSurface(created) ?? stored) : stored;
  switch (source) {
    case APP_SOURCE:
    case OLD_APP_SOURCE:
      return "app";
    case "telegram":
    case "discord":
    case "desktop":
      return source;
    case "cli":
    case "tui":
      return "cli";
    case "import":
      return "import";
    default:
      return "other";
  }
}

/** How many of a chat's newest stored rows are read back to settle a message that may have reached Hermes. */
const READ_BACK_ROWS = 100;

/** A history row as far as reading back a sent message needs it. `rowId`: its stored row, when it has one. */
type ReadBack = { role: string; text: string; rowId?: number };

/** `id`, or a variant of it no item in `items` has. */
const freeId = (items: Item[], id: string) => (items.some((i) => i.id === id) ? `${id}-${crypto.randomUUID().slice(0, 8)}` : id);

/** A new item's id. The chat's length alone can repeat one, since dismissing or retrying a message shortens the chat. */
const nextId = (items: Item[], prefix: string) => freeId(items, `${prefix}-${items.length}`);

/** `items` with outbox rows after them, each with an id none of `items` has. */
const withRows = (items: Item[], rows: OutgoingItem[]): Item[] => [...items, ...rows.map((r) => ({ ...r, id: freeId(items, r.id) }))];

const withOutgoing = (r: OutgoingItem, patch: Partial<Outgoing>): OutgoingItem => ({ ...r, outgoing: { ...r.outgoing, ...patch } });

/** The plain message, once Hermes has it. */
const confirmed = ({ outgoing: _, ...plain }: OutgoingItem): Item => plain;

/**
 * The profile's outbox as kept. A message kept while still sending was on its way when the app closed: if it had gone
 * out, Hermes may have it; if not, it never went.
 */
function loadOutbox(cache: ChatCache, profile: string): Record<string, OutgoingItem[]> {
  const loaded = (r: OutgoingItem): OutgoingItem =>
    r.outgoing.state !== "sending"
      ? r
      : r.outgoing.sent
        ? withOutgoing(r, { state: "unknown", reason: "The app closed before Hermes confirmed it." })
        : withOutgoing(r, { state: "failed", reason: "The app closed before it went out." });
  return Object.fromEntries(Object.entries(cache.loadOutbox(profile)).map(([chatId, rows]) => [chatId, rows.map(loaded)]));
}

/** Why a queue waits for the owner's Resume (ADR 0018). */
const PAUSED = {
  owner: "You paused it.",
  restored: "Hermes Chat closed, or showed another profile, since these were queued. Check the chat, then resume.",
  dropped: "The connection dropped, so the last reply wasn't watched to its end. Check the chat, then resume.",
  notSent: "A queued message didn't go, or may not have. Deal with it above, then resume.",
  held: "Hermes held the last queued message until another reply in this chat ended, so this app can't tell when it went. Check the chat, then resume.",
  unsaved: "This computer's storage is full, so the next message couldn't be kept safe while it went, and wasn't sent. Free some space (Settings → General → Clear local cache), then resume.",
};

/** The profile's queues as kept. One with messages comes back paused: what its chat did meanwhile went unseen. */
function loadQueues(cache: ChatCache, profile: string): Record<string, ChatQueue> {
  return Object.fromEntries(Object.entries(cache.loadQueues(profile)).map(([id, q]) => [id, { ...q, paused: q.paused ?? PAUSED.restored }]));
}

/**
 * Why a chat's queue waits once a turn ends this way, or nothing: a reply stopped or failed, or one Hermes asked an
 * Approval in, is for the owner to look at before the next message goes.
 */
function pauseAfter(type: string, p: Record<string, unknown>, items: Item[]): string | undefined {
  if (type === "error") return "The last reply ended with an error. Check the chat, then resume.";
  if (p.status === "interrupted") return "The last reply was stopped. Resume to send the next message.";
  if (p.error || p.status === "error") return "The last reply failed. Check the chat, then resume.";
  const turn = items.slice(turnStart(items));
  if (turn.some((i) => i.kind === "approval")) return "Hermes asked for an Approval in the last reply. Check the chat, then resume.";
  return undefined;
}

/** Each listed chat with its outbox. */
const withOutbox = (chats: Chat[], outbox: Record<string, OutgoingItem[]>) =>
  chats.map((c) => (outbox[c.id]?.length ? { ...c, items: withRows(c.items, outbox[c.id]) } : c));

/**
 * Whether a message that may have reached Hermes is in its chat's history read back: a message of the owner's, newer
 * than the newest row the chat had when it went out, with the prompt it went out with. Hermes may store a message with
 * attachments with more around the owner's words, so for one of those the words alone do.
 */
function arrived(row: OutgoingItem, readBack: ReadBack[]): boolean {
  const { sent, attachments } = row.outgoing;
  if (!sent) return false;
  const words = row.text.trim();
  return readBack.some(
    (m) =>
      m.role === "user" &&
      (sent.after === undefined || m.rowId === undefined || m.rowId > sent.after) &&
      (m.text.trim() === sent.prompt.trim() || (!!attachments?.length && !!words && m.text.includes(words))),
  );
}

/**
 * What the history read back makes of a message sent from here (read back, it wins): one that may have reached Hermes
 * goes if it is there, as the history shows it, and is marked failed if not, when `reaches` says the rows read go back
 * to when it went out. Messages failed or still sending stay as they are.
 */
function settle(row: OutgoingItem, readBack: ReadBack[], reaches: (after?: number) => boolean): OutgoingItem | null {
  if (row.outgoing.state !== "unknown") return row;
  if (arrived(row, readBack)) return null;
  if (!reaches(row.outgoing.sent?.after)) return row;
  return withOutgoing(row, { state: "failed", reason: "Hermes doesn't have it: the chat's history shows it never arrived." });
}

/** `settle` for every outbox row, against a chat's whole history. */
const reconcile = (rows: OutgoingItem[], readBack: ReadBack[]) => rows.flatMap((r) => settle(r, readBack, () => true) ?? []);

export const LOAD_ERROR_ID = "load-error";
const withoutLoadError = (items: Item[]) => items.filter((i) => i.id !== LOAD_ERROR_ID);

/**
 * Stored history as transcript items. Hermes doesn't keep tool results, except for edit tools. An assistant row's
 * reasoning shows as thinking before its text.
 */
function historyItems(messages: TranscriptMessage[]): Item[] {
  return messages.flatMap((m, i): Item[] => {
    const id = `h-${i}`;
    const thought: Item[] = m.role === "assistant" && m.reasoning?.trim() ? [{ kind: "thinking", id: `${id}-r`, text: m.reasoning.trim() }] : [];
    if (m.role === "tool")
      return [
        {
          kind: "tool",
          id,
          ...(m.tool_call_id && { callId: m.tool_call_id }),
          name: m.name || "tool",
          args: m.args ?? undefined,
          preview: m.context || undefined,
          status: "done",
          result: typeof m.content === "string" ? m.content : undefined,
        },
      ];
    // Assistant rows can be reasoning only; system rows are timeline notes this app doesn't show yet.
    if (!m.text?.trim()) return thought;
    const at = storedAt(m.timestamp);
    const rowId = Number.isSafeInteger(m.row_id) ? (m.row_id as number) : undefined;
    if (m.role === "user")
      return [{ kind: "user", id, text: m.text, ...(at && { at }), ...(rowId !== undefined && { rowId }), ...(m.display_kind === "steer" && { steer: true }) }];
    if (m.role === "assistant") return [...thought, { kind: "assistant", id, text: m.text, ...(at && { at }), ...(rowId !== undefined && { rowId }) }];
    return [];
  });
}

/** A stored Hermes time (Unix seconds) in ms, or nothing for a missing, zero or out-of-range one. */
const storedAt = (s: unknown) => (typeof s === "number" && s > 0 && s * 1000 <= 8.64e15 ? s * 1000 : undefined);

/** A card for an `approval` request. Choices this app doesn't know are dropped; it never makes one up. */
function approvalItem(r: ServerRequest): ApprovalItem {
  const p = r.params;
  const offered = Array.isArray(p.choices) ? p.choices : [];
  return {
    kind: "approval",
    id: r.id,
    requestId: String(p.request_id ?? ""),
    command: String(p.command ?? ""),
    description: String(p.description ?? ""),
    choices: APPROVAL_CHOICES.filter((c) => offered.includes(c)).sort((a, b) => offered.indexOf(a) - offered.indexOf(b)),
    // A grant Hermes doesn't say it allows is ruled out.
    allowSession: p.allow_session === true,
    allowPermanent: p.allow_permanent === true,
  };
}

/** Closes the waiting cards, or those of them `which` picks, with Hermes's reason. */
const endWaitingApprovals = (items: Item[], ended: string, which = (_: ApprovalItem) => true) =>
  items.map((i): Item => (isWaiting(i) && which(i) ? { ...i, ended } : i));

const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * `prev` updated from a session's `info` (`server._session_info`) and `usage` (`server._get_usage`, or `info.usage`).
 * The model is `Chat.model` (`pickFromInfo`).
 * Context fullness only as Hermes measured it: none until it has.
 */
function withLive(prev: SessionLive | undefined, info?: unknown, usage?: unknown): SessionLive | undefined {
  const i = obj(info);
  const u = obj(usage) ?? obj(i?.usage);
  if (!i && !u) return prev;
  const live: SessionLive = { ...prev };
  const approvals = approvalsOf(i);
  if (approvals) live.approvals = approvals;
  if (u) {
    live.context = contextUse(u);
    live.compactions = typeof u.compressions === "number" && u.compressions >= 0 ? u.compressions : undefined;
  }
  return live;
}

function contextUse(u: Record<string, unknown>): ContextUse | undefined {
  const { context_used: used, context_max: max, context_percent: percent } = u;
  if (typeof used !== "number" || typeof max !== "number" || typeof percent !== "number" || max <= 0) return undefined;
  return { used, max, percent, estimated: u.context_estimated === true };
}

function errorItem(c: Chat, text: string): Item {
  return { kind: "error", id: nextId(c.items, "e"), text };
}

/** Ends a turn's tool calls that were still running when it ended. */
const endRunningTools = (items: Item[], status: "done" | "stopped") =>
  items.map((i): Item => (i.kind === "tool" && i.status === "running" ? { ...i, status } : i));

/**
 * Marks the last reply interrupted and its running tool calls stopped. A reply stopped before it said anything gets
 * an empty one, so the transcript still shows the stop.
 */
function markInterrupted(items: Item[], from?: string | null): Item[] {
  const out = endRunningTools(items, "stopped");
  const last = out[out.length - 1];
  if (last?.kind === "assistant" && last.id !== from) out[out.length - 1] = { ...last, interrupted: true };
  else out.push({ kind: "assistant", id: nextId(out, "a"), text: "", interrupted: true });
  return out;
}

/**
 * Gives a turn's usage to its reply: the last reply or error after the turn started (`from`, else the last message),
 * unless it has some already, which a repeated `message.complete` would find.
 */
function withReplyUsage(items: Item[], usage: ReplyUsage, from?: string | null): Item[] {
  const start = turnFrom(items, from);
  // If the boundary itself disappeared, there is no reliable turn to attach these counters to.
  if (start < 0) return items;
  for (let n = items.length - 1; n >= start; n--) {
    const i = items[n];
    if (i.kind !== "assistant" && i.kind !== "error") continue;
    if (i.usage) return items;
    const out = [...items];
    out[n] = { ...i, usage };
    return out;
  }
  return items;
}

/**
 * Where the running turn's items start: just after `from`, the last item before its `message.start` (`null`: the chat
 * had none), else after the owner's last message (`turnStart`). -1 when `from` is no longer in the chat.
 */
function turnFrom(items: Item[], from?: string | null): number {
  if (from === null) return 0;
  if (from === undefined) return turnStart(items);
  const at = items.findIndex((i) => i.id === from);
  return at < 0 ? -1 : at + 1;
}

// Fold one session event into a chat. Text deltas extend the trailing assistant item, or start a new one
// after a tool call; reasoning deltas do the same with thinking items. `from` is the last item before the running
// turn's `message.start`: a turn Hermes starts by itself has no message from the owner before it, so the item it would
// otherwise extend is the last turn's.
function applyEvent(c: Chat, type: string, p: Record<string, unknown>, from?: string | null): Chat {
  const items = [...c.items];
  const tail = items[items.length - 1];
  const last = tail?.id === from ? undefined : tail;
  switch (type) {
    case "message.start":
      return { ...c, running: true, updatedAt: Date.now() };
    // `thinking.delta` is Hermes's spinner and wait notices, not reasoning, so it isn't shown.
    case "reasoning.delta": {
      const text = p.text;
      if (typeof text !== "string" || !text) return c;
      if (last?.kind === "thinking") items[items.length - 1] = { ...last, text: last.text + text };
      else items.push({ kind: "thinking", id: nextId(items, "r"), text });
      return { ...c, items, updatedAt: Date.now() };
    }
    // A response's reasoning in one go, up to 500 characters, when the model didn't stream it.
    case "reasoning.available": {
      const text = typeof p.text === "string" ? p.text.trim() : "";
      if (!text || last?.kind === "thinking") return c;
      items.push({ kind: "thinking", id: nextId(items, "r"), text });
      return { ...c, items };
    }
    case "message.delta": {
      const text = p.text;
      if (typeof text !== "string" || !text) return c;
      if (last?.kind === "assistant") items[items.length - 1] = { ...last, text: last.text + text };
      else items.push({ kind: "assistant", id: nextId(items, "a"), text });
      return { ...c, items, updatedAt: Date.now() };
    }
    case "tool.start":
      items.push({
        kind: "tool",
        id: String(p.tool_id),
        callId: String(p.tool_id),
        name: String(p.name ?? "tool"),
        args: p.args as Record<string, unknown> | undefined,
        preview: p.preview as string | undefined,
        status: "running",
      });
      return { ...c, items };
    case "tool.complete":
      return {
        ...c,
        items: items.map((i) =>
          i.kind === "tool" && i.id === String(p.tool_id)
            ? {
                ...i,
                status: "done",
                durationS: p.duration_s as number | undefined,
                // A screenshot inside it stays on the server (ADR 0061).
                result: toolResultText(p.result),
                summary: p.summary as string | undefined,
              }
            : i,
        ),
      };
    // Every second or so while a turn runs.
    case "session.usage":
      return { ...c, live: withLive(c.live, undefined, p.usage) };
    case "request.cancel":
      // Hermes stopped waiting: timed out, interrupted, or answered in another Hermes client.
      return { ...c, items: endWaitingApprovals(items, String(p.reason || "withdrawn"), (i) => i.id === p.id) };
    case "approval.cancelled": {
      // An interrupt or teardown dropped the session's waiting Approvals: the ones listed, by either id, or all.
      const ids = Array.isArray(p.request_ids) ? p.request_ids : undefined;
      return { ...c, items: endWaitingApprovals(items, String(p.reason || "withdrawn"), (i) => !ids || ids.includes(i.requestId) || ids.includes(i.id)) };
    }
    case "message.complete": {
      // Providers that don't stream send the whole reply here; a streamed turn repeats text it already sent.
      // A steered message is part of the turn, so the turn starts at the last message that began one.
      const begin = turnFrom(items, from);
      const lastUser = (begin < 0 ? turnStart(items) : begin) - 1;
      const answered = items.slice(lastUser + 1).some((i) => i.kind === "assistant");
      // The last response's reasoning, for a turn that showed none: it goes before the reply.
      const reasoning = typeof p.reasoning === "string" ? p.reasoning.trim() : "";
      if (reasoning && !items.slice(lastUser + 1).some((i) => i.kind === "thinking")) {
        const reply = items.map((i) => i.kind).lastIndexOf("assistant");
        items.splice(reply > lastUser ? reply : items.length, 0, { kind: "thinking", id: nextId(items, "r"), text: reasoning });
      }
      if (!answered && typeof p.text === "string" && p.text) items.push({ kind: "assistant", id: nextId(items, "a"), text: p.text });
      const end = { ...c, live: withLive(c.live, undefined, p.usage), running: false, stopping: false, updatedAt: Date.now() };
      // Stopped here or from another Hermes client.
      if (p.status === "interrupted") return { ...end, items: markInterrupted(endWaitingApprovals(items, "turn ended"), from) };
      const failure = p.error ?? (p.status === "error" ? p.failure_reason ?? "The turn failed." : undefined);
      if (failure) items.push(errorItem({ ...c, items }, String(failure)));
      return { ...end, items: endRunningTools(endWaitingApprovals(items, "turn ended"), "done") };
    }
    case "error":
      items.push(errorItem(c, String(p.message ?? "Hermes reported an error.")));
      return { ...c, items: endWaitingApprovals(items, "turn ended"), running: false, stopping: false };
    default:
      return c;
  }
}
