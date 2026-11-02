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
// The composer's model picker lists what `model.options` offers (models.ts) and switches one chat at a time with
// The preview pane reads Server files over dashboard REST `GET /api/fs/*` (preview.ts).
// session-scoped `config.set`; it never writes the profile's default model, reasoning or fast mode (Settings → Model does).
// A message sent from here is marked in the transcript until Hermes confirms it (`Outgoing`). One Hermes didn't take,
// or may not have, stays there with Retry, kept beside the cache so it outlives a restart, and never in a Saved copy.
// Whether one Hermes may have got did arrive is settled by reading the chat's history back (ADR 0006).
// Each chat's context fullness and YOLO come from its session's `info` and `usage`: research doc "Status bar".
// Token usage and cost (usage.ts, ADR 0008): each reply's usage is how far its session's live counters moved during
// its turn; each chat's totals and cost are Hermes's stored ones, read with the chat list and after each turn.
import { PersonaApi } from "./persona";
import { APPROVAL_CHOICES, isBroadGrant, isOutgoing, isWaiting, offeredChoices, type ApprovalChoice, type ApprovalItem, type AttachCheck, type Attachment, type Chat, type ConnectionStatus, type ContextPart, type ContextUse, type Found, type Item, type OtherProfiles, type Outgoing, type OutgoingItem, type SessionLive, type Source } from "./model";
import { catalogFromServer, fallbackCatalog, isEffort, modelKey, pickFromInfo, type ModelCatalog, type ModelPick } from "./models";
import { noOthers, OtherProfilesCheck } from "./otherProfiles";
// Projects are Hermes's own, read and written with legacy `projects.*` (projects.ts, research doc "Projects").
import { projectsApi, type ProjectsApi } from "./projects";
import { ModelSettingsApi } from "./modelSettings";
import type { OpenPipe, Pipe, PipeEvent, RestMethod, Route, Speech, Transcript, VoiceSetup } from "./pipe";
import { remoteFiles, type RemoteFiles } from "./remoteFiles";
import { isUnsecure } from "./unsecure";
import { readServerFile, type FileView } from "./preview";
import { chatUsageOf, countersOf, newerChatUsage, replyUsage, ZERO_COUNTERS, type ReplyUsage, type UsageCounters } from "./usage";

/**
 * The `source` this app stamps on chats it starts. Legacy `session.create` stores any string as-is, but the gateway
 * takes an edit (rename, pin, archive, read) only on a local client's row whose source it knows (`LEGACY_LOCAL_SOURCES`,
 * `authorize_history` at the deployed `bf0203a`): every edit of a `hermes-chat` row was answered 404 `not_found`.
 */
export const APP_SOURCE = "gui";
/** What this app stamped before, still shown as this app's. Hermes won't edit these chats. */
const OLD_APP_SOURCE = "hermes-chat";
const READY_TIMEOUT_MS = 15_000;
/** Waits before each try to reconnect a dropped connection. When the last try fails the app is Offline until the
 * owner asks to reconnect, so a wrong password isn't retried for ever. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
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
/** The most chats one search lists; dashboard REST caps it at 100. */
const SEARCH_LIMIT = 50;

const MiB = 1024 * 1024;
/** The most legacy `image.attach_bytes` and `file.attach` take (research doc §7). PDFs go as files: `pdf.attach`
 * needs `pdftoppm`, which the live server doesn't have. */
const LIMITS = { image: { bytes: 25 * MiB, what: "images" }, file: { bytes: 256 * MiB, what: "files" } };
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
  saveOutbox(profile: string, chatId: string, items: OutgoingItem[]): void;
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
};
type SessionPage = { sessions: SessionRow[]; total: number };
/** Dashboard REST `GET /api/sessions/{id}`, as far as this app reads it. Flags come as stored, 0 or 1. */
type SessionDetail = { archived?: boolean | number };
/** Dashboard REST `GET /api/sessions/{id}/mutation-snapshot`: the revision a session edit must name. */
type MutationSnapshot = { exists: boolean; runtime_revision: number };
/**
 * A row of dashboard REST `GET /api/sessions/search` (research doc "Searching chats"): one per chat, archived ones
 * too. `snippet` is FTS5's, with each matched word `>>>marked<<<`; `role` is the matched message's, and null when the
 * chat's id or title matched instead.
 */
type SearchRow = Pick<SessionRow, "id" | "source" | "title" | "preview" | "started_at" | "last_active" | "archived"> & {
  snippet?: string;
  role?: string | null;
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
  timestamp?: number | null;
  /** The stored row (`messages.id`); a live session's not-yet-stored tail has none. */
  row_id?: number | null;
};

/** Legacy `prompt.submit` result. `user_row_id`: the stored row of the message, when its turn started at once
 * (`tui_gateway/methods_prompt.py` at `bf0203a`). */
type Submitted = { user_row_id?: number | null };

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
  /** The models the shown profile can switch to (`loadModels`); none until read. */
  models?: ModelCatalog;
  /** The switch to `profile` from `from`, until the new profile's list has been read. `error`: why it hasn't yet. */
  switching?: { from: string; error?: string };
};

/**
 * Connects to Hermes for `profile`, by default the one shown last; rejects if the first connection fails. Later drops
 * are reconnected by the returned Hermes.
 */
export async function connect(openPipe: OpenPipe, profile?: string, cache: ChatCache = noCache, notify?: Notify): Promise<Hermes> {
  const hermes = new Hermes(openPipe, profile ?? cache.lastProfile() ?? "default", cache, notify);
  await hermes.dial();
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

export class Hermes {
  private pipe?: Pipe;
  /** The profile the pipe's `/api/ws` was opened for. */
  private pipeProfile?: string;
  /** Counts pipes opened; events from an older pipe than the current one are ignored. */
  private generation = 0;
  /** The pipe being opened is waiting for `gateway.ready`. */
  private onReady?: (payload: Record<string, unknown>) => void;
  /** Ends the dial under way with this error. */
  private abortDial?: (e: Error) => void;
  /** The dropped pipe, until the Rust side has closed it. Opening the next one waits, because Rust holds a single
   * connection and closing drops whichever it holds. */
  private droppedClosing?: Promise<void>;
  private redialing?: Promise<void>;
  private failedTries = 0;
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
  private snapshot: Snapshot;
  /** Chats this app moved between Active and Settled that Hermes hasn't stored yet: the `pinned` flag each should
   * have (ADR 0002). While a chat is here, this flag beats the one the server lists. */
  private pinWanted = new Map<string, boolean>();
  /** The latest write of each chat's pinned flag, so a chat's writes go out one at a time, in order. */
  private pinWrites = new Map<string, Promise<void>>();
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
  /** How many `session.info` events each runtime session has sent on this connection, so `setYolo` can tell
   * whether Hermes reported the effective state before answering. */
  private infoCount = new Map<string, number>();
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
  /** The newest stored row each chat is known to have, from its history and the turns sent from here. A message that
   * may have reached Hermes is looked for only past the row its chat had when it went out. */
  private knownRow = new Map<string, number>();
  private syncing?: Promise<Error | undefined>;
  private syncAgain = false;
  private background = new Set<Promise<unknown>>();
  /** When the shown profile's list last synced on this connection. */
  private listedAt?: number;
  /** The voice set-up read for a connection and profile (`voiceSetup`). */
  private voiceRead?: { key: string; done: Promise<VoiceSetup> };
  /** The model list being read, and for which profile. */
  private modelsLoading?: { profile: string; done: Promise<void> };
  /** A chat and model Hermes asked to confirm as expensive: picking it again for that chat confirms it. */
  private confirmModel?: string;
  /** Hermes's projects, each call naming its profile (projects.ts). Folders are read, never created. */
  readonly projects: ProjectsApi = projectsApi({
    rpc: (method, params) => this.request(method, params),
    get: (pathAndQuery) => this.rest("GET", pathAndQuery),
  });
  private others = new OtherProfilesCheck({
    scope: () => (this.pipe && this.snapshot.status === "connected" && !this.closing ? { connection: this.generation, profile: this.profile } : undefined),
    profiles: () => this.profiles(),
    unreadIn: (profile) => this.unreadIn(profile),
    publish: (others) => this.update({ others }),
  });

  /**
   * The files on the machine the dashboard runs on, read-only (remoteFiles.ts). They are the same for every profile,
   * and can only be read while connected.
   */
  readonly files: RemoteFiles = remoteFiles((pathAndQuery, maxBytes) => this.restGet(pathAndQuery, maxBytes));

  constructor(
    private openPipe: OpenPipe,
    profile: string,
    private cache: ChatCache = noCache,
    private notify: Notify = () => Promise.resolve(),
  ) {
    this.snapshot = { profile, chats: withOutbox(cache.load(profile), loadOutbox(cache, profile)), olderPulled: cache.olderPulled(profile), archivedListed: false, status: "offline", unsecure: false, others: noOthers };
  }

  /** See `readSaved`. */
  static readSaved(openPipe: OpenPipe, reason: string, cache: ChatCache, notify?: Notify): Hermes | undefined {
    const hermes = new Hermes(openPipe, cache.lastProfile() ?? "default", cache, notify);
    if (!hermes.snapshot.chats.length) return undefined;
    hermes.dropped(reason);
    return hermes;
  }

  /** Settings → Model's reads and writes, for the profile shown (modelSettings.ts). */
  readonly modelSettings = new ModelSettingsApi(
    (method, pathAndQuery, body) => this.rest(method, pathAndQuery, body),
    () => this.profile,
  );

  /** Settings → Persona's reads and writes of a profile's SOUL.md (persona.ts). Each call names its profile. */
  readonly persona = new PersonaApi((method, pathAndQuery, body) => this.rest(method, pathAndQuery, body));

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
    const gen = ++this.generation;
    const ready = new Promise<Record<string, unknown>>((resolve) => (this.onReady = resolve));
    // Set as soon as the pipe closes or the app gives up, even after gateway.ready has arrived.
    let failure: Error | undefined;
    const failed = new Promise<never>((_, reject) => (this.abortDial = (e) => reject((failure ??= e))));
    failed.catch(() => {}); // Raced below, once the pipe is open.
    let up = false;
    let pipe: Pipe | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const profile = this.profile;
    try {
      pipe = await this.openPipe((e) => {
        if (gen !== this.generation) return;
        if (e.kind === "closed" && !up) this.abortDial?.(new Error(`The connection closed before Hermes was ready: ${e.reason}`));
        else this.handle(e);
      }, profile);
      const payload = await Promise.race([
        ready,
        failed,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("Hermes didn't send gateway.ready in time.")), READY_TIMEOUT_MS);
        }),
      ]);
      if (failure) throw failure;
      if (payload.session_authority) throw new ProtocolMismatchError();
    } catch (e) {
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
    // Without this, Hermes never sends this connection an Approval (research doc §6).
    this.track(this.request("client.capabilities", { server_requests: true }));
  }

  /** Tries to connect again now, after a drop or from Offline, and keeps retrying on its own if that fails. */
  reconnect(): Promise<void> {
    if (!this.redialing) this.failedTries = 0;
    return this.redial();
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
    if (name === this.profile) return;
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
    }
    const unread = this.snapshot.chats.filter((c) => c.unread).length;
    this.others.switched(from, name, this.listedAt === undefined ? undefined : { unread, listedAt: this.listedAt });
    this.listedAt = undefined;
    this.viewing.clear();
    this.readWhenBack.clear();
    this.staleItems.clear();
    this.resumeOnReconnect.clear();
    this.revealed.clear();
    this.update({
      profile: name,
      chats: withOutbox(this.cache.load(name), loadOutbox(this.cache, name)),
      olderPulled: this.cache.olderPulled(name),
      archivedListed: false,
      syncError: undefined,
      models: undefined,
      switching: { from },
    });
    // A reconnect under way may be opening the old profile's socket.
    await this.redialing;
    if (this.profile !== name || this.closing) return;
    if (this.pipe && this.pipeProfile === name) return void this.sync();
    if (this.pipe) this.detach(`Switching to the ${name} profile.`);
    await this.reconnect();
  }

  /**
   * Checks the profiles not shown for Unread chats, over dashboard REST and without switching the socket. Only reads:
   * nothing is marked read. Runs at most every 15 seconds; the app calls it every `CHECK_EVERY_MS`. Results land in
   * the snapshot's `others`.
   */
  checkOtherProfiles(): Promise<void> {
    return this.others.check();
  }

  /**
   * Searches the words and titles of every chat in the profile, Active and Settled, however old. Archived chats are
   * left out, as they are from the list, unless `archived` asks for them too.
   */
  async search(text: string, { archived = false } = {}): Promise<Found[]> {
    const q = text.trim();
    if (!q) return [];
    const profile = this.profile;
    const query = new URLSearchParams({ q, profile, limit: String(SEARCH_LIMIT), exclude_sources: "cron" });
    const res = (await this.rest("GET", `api/sessions/search?${query}`)) as { results: SearchRow[] };
    if (this.profile !== profile) throw new Error(`Switched to the ${this.profile} profile before the results came.`);
    const listed = new Map(this.snapshot.chats.map((c) => [c.id, c]));
    return res.results
      .filter((r) => (archived || !this.isArchived(r)) && !this.deleted.has(r.id))
      .map((r): Found => {
        const c = listed.get(r.id);
        const snippet = snippetParts(r.snippet ?? "");
        const role = r.role === "user" || r.role === "assistant" ? r.role : undefined;
        return {
          chatId: r.id,
          // The list's title, so a chat is called the same in both while the search index catches up with a rename.
          title: c?.title ?? listTitle(r),
          source: toSource(r.source),
          // Every pinned chat is listed, so one that isn't is Settled.
          settled: c?.settled ?? true,
          ...(this.isArchived(r) && { archived: true }),
          updatedAt: Math.max(c?.updatedAt ?? 0, lastActive(r)),
          snippet,
          ...(role && { role, find: findTerm(q, snippet) }),
        };
      });
  }

  /** Puts a found chat in the list, if it isn't there yet, so it can be opened (`open`). */
  reveal(found: Found) {
    if (this.snapshot.chats.some((c) => c.id === found.chatId)) return;
    const { chatId: id, title, source, settled, archived, updatedAt } = found;
    this.revealed.add(id);
    this.update({ chats: [...this.snapshot.chats, { id, title, source, settled, archived, updatedAt, items: [] }] });
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
   * Starts a Chat in this app. It is Active from the start, and pinned once Hermes has stored it (ADR 0002). `model`:
   * what it runs on, for this chat only; left out, it runs on the profile's model.
   */
  async newChat(model?: ModelPick): Promise<string> {
    const res = (await this.request("session.create", {
      profile: this.profile,
      source: APP_SOURCE,
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
      if (f.size > limit.bytes)
        refused.push(`${f.name} is ${(f.size / MiB).toFixed(1)} MB. Hermes takes ${limit.what} up to ${limit.bytes / MiB} MB.`);
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
  async send(chatId: string, text: string, attachments: Attachment[] = []): Promise<Delivery> {
    return (await this.deliver(chatId, text, attachments)).delivery;
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
    const { delivery, itemId: again } = await this.deliver(chatId, first.text, first.outgoing.attachments ?? []);
    if (delivery.delivery === "unsent" && first.outgoing.state === "unknown" && again) this.setOutgoing(profile, chatId, again, () => first);
    return delivery;
  }

  /** The owner lets go of a message Hermes didn't take, or may not have. One still sending stays. */
  dismiss(chatId: string, itemId: string) {
    this.setOutgoing(this.profile, chatId, itemId, (r) => (r.outgoing.state === "sending" ? r : null));
  }

  /** `send`, also giving the id of the message in the chat. */
  private async deliver(chatId: string, text: string, attachments: Attachment[]): Promise<{ delivery: Delivery; itemId?: string }> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat) return { delivery: { delivery: "unsent", reason: "This chat isn't in the list." } };
    const profile = this.profile;
    const activating = chat.settled;
    const wantedBefore = this.pinWanted.get(chatId);
    if (activating) this.pinWanted.set(chatId, true);
    const user: OutgoingItem = {
      kind: "user",
      id: freeId(chat.items, `u-${chat.items.length}`),
      text,
      ...(attachments.length && { attachments: attachments.map((a) => a.name) }),
      outgoing: { state: "sending", ...(attachments.length && { attachments }) },
    };
    this.patchChat(chatId, (c) => ({
      ...c,
      settled: false,
      running: true,
      updatedAt: Date.now(),
      title: c.items.length === 0 && c.runtimeId ? (text || attachments[0]?.name || c.title).slice(0, 48) : c.title,
      items: [...c.items, user],
    }));
    // Kept from the start, so a message on its way when the app closes isn't lost.
    this.saveOutbox(chatId);
    try {
      // From here Hermes may have it: what went out, and the newest row the chat had, find it in the history later.
      const goingOut = (prompt: string) =>
        this.setOutgoing(profile, chatId, user.id, (r) => withOutgoing(r, { sent: { prompt, ...(this.knownRow.has(chatId) && { after: this.knownRow.get(chatId) }) } }));
      const submitting = this.resume(chatId).then((runtimeId) => this.submit(runtimeId, text, attachments, goingOut));
      this.submitting.set(chatId, submitting);
      const rowId = submitting.then(
        (r) => (typeof r.user_row_id === "number" ? r.user_row_id : undefined),
        () => undefined,
      );
      this.turns.set(chatId, { userId: user.id, rowId });
      let res: Submitted;
      try {
        res = await submitting;
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
      this.patchChat(chatId, (c) => ({ ...c, running: false, settled: activating || c.settled }));
      return { delivery: { delivery: unknown ? "unknown" : "unsent", reason }, itemId: user.id };
    }
  }

  /** Moves a chat to Settled here at once, and unpins it on the server (ADR 0002). `unsettle` undoes it. */
  settle(chatId: string): Promise<void> {
    return this.setSettled(chatId, true);
  }

  /** Moves a chat to Active here at once, and pins it on the server. `settle` undoes it. */
  unsettle(chatId: string): Promise<void> {
    return this.setSettled(chatId, false);
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
      await this.rest("DELETE", `api/sessions/${encodeURIComponent(chatId)}?${new URLSearchParams({ profile })}`);
      this.cache.saveOutbox(profile, chatId, []);
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
   * Answers an Approval with the owner's choice, in a response frame to Hermes's request (research doc §6). One
   * already answered, or that Hermes stopped waiting for, is left alone, and so is a choice Hermes didn't offer, or a
   * broader grant (`isBroadGrant`) the owner hasn't `confirmed`. So is a card from before a drop until its chat is
   * loaded again, which tells whether Hermes still waits on it. If the answer can't go, the chat says so and the card
   * stays waiting.
   */
  async answerApproval(chatId: string, approvalId: string, choice: ApprovalChoice, confirmed = false): Promise<void> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    const card = chat?.items.find((i) => i.id === approvalId);
    if (!card || !isWaiting(card) || !offeredChoices(card).includes(choice) || (isBroadGrant(choice) && !confirmed)) return;
    if (this.snapshot.status === "connected" && !chat?.runtimeId) return;
    const answer = (a?: ApprovalChoice) =>
      this.patchChat(chatId, (c) => ({ ...c, items: c.items.map((i) => (i.id === approvalId && i.kind === "approval" ? { ...i, answer: a } : i)) }));
    answer(choice);
    try {
      if (!this.pipe || this.snapshot.status !== "connected") throw new Error("Not connected to Hermes.");
      await this.pipe.send(JSON.stringify({ jsonrpc: "2.0", id: approvalId, result: { choice, all: false } }));
    } catch (e) {
      answer(undefined);
      this.patchChat(chatId, (c) => ({ ...c, items: [...c.items, errorItem(c, `Couldn't answer Hermes: ${(e as Error).message}`)] }));
    }
  }

  /**
   * Turns YOLO on or off for this chat only: Hermes then runs commands it counts as dangerous without asking
   * (`config.set yolo`, session scope; research doc "Status bar"). Hermes keeps it with the chat. Rejects if the
   * chat isn't open on this connection or Hermes refuses.
   */
  async setYolo(chatId: string, on: boolean): Promise<void> {
    const runtimeId = this.snapshot.chats.find((c) => c.id === chatId)?.runtimeId;
    if (!runtimeId) throw new Error("This chat isn't open on Hermes.");
    const infos = this.infoCount.get(runtimeId) ?? 0;
    const res = (await this.request("config.set", { session_id: runtimeId, profile: this.profile, key: "yolo", value: on ? "on" : "off" })) as { value?: unknown };
    // `value` is only the chat's own flag. Whether Hermes auto-approves also depends on its launch flag and
    // approvals.mode, which only `session.info` reports; Hermes sends that just before this answer, when the session's
    // agent exists (`methods_config_set.py` `_set_yolo`).
    const reported = (this.infoCount.get(runtimeId) ?? 0) > infos;
    this.patchChat(chatId, (c) => {
      if (c.runtimeId !== runtimeId) return c;
      // The chat's flag is on, so YOLO is on whatever else holds.
      if (res.value === "1") return { ...c, live: { ...c.live, yolo: true } };
      // Off for the chat, yet still on: something wider than this chat turns it on.
      if (reported) return c.live?.yolo ? { ...c, live: { ...c.live, yoloEverywhere: true } } : c;
      // Not reported: unknown until Hermes says, never assumed off.
      return { ...c, live: { ...c.live, yolo: undefined, yoloEverywhere: undefined } };
    });
  }

  /** What fills the chat's context window, by category, as Hermes estimates it now; empty when Hermes gives none. */
  async contextBreakdown(chatId: string): Promise<ContextPart[]> {
    const runtimeId = this.snapshot.chats.find((c) => c.id === chatId)?.runtimeId;
    if (!runtimeId) return [];
    const res = (await this.request("session.context_breakdown", { session_id: runtimeId })) as { categories?: unknown };
    return (Array.isArray(res?.categories) ? res.categories : []).flatMap((v): ContextPart[] => {
      const p = obj(v);
      return p && typeof p.id === "string" && typeof p.label === "string" && typeof p.tokens === "number"
        ? [{ id: p.id, label: p.label, tokens: p.tokens, ...(typeof p.color === "string" && { color: p.color }) }]
        : [];
    });
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
    this.syncing = (async () => {
      try {
        let failure: Error | undefined;
        do {
          this.syncAgain = false;
          failure = await this.syncOnce();
        } while (this.syncAgain);
        return failure;
      } finally {
        this.syncing = undefined;
      }
    })();
    this.track(this.syncing);
    return this.syncing;
  }

  /** Resolves once background work (list syncs, pinning) has finished. Tests wait on it; the app doesn't need to. */
  async idle() {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  async close() {
    this.closing = true;
    this.abortDial?.(new Error("Closed by the app."));
    this.generation++;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    await this.pipe?.close();
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
    // Broadcast when any process changes the session store (tui_gateway/change_watcher.py).
    if (type === "sessions.changed") {
      void this.sync();
      return;
    }
    const chat = session_id ? this.snapshot.chats.find((c) => c.runtimeId === session_id) : undefined;
    if (!chat) return;
    // Sent when the chat's model, reasoning, fast mode or YOLO changes, here or in another Hermes client.
    if (type === "session.info") {
      this.infoCount.set(chat.runtimeId!, (this.infoCount.get(chat.runtimeId!) ?? 0) + 1);
      const model = pickFromInfo(payload);
      this.patchChat(chat.id, (c) => ({ ...c, ...(model && { model }), live: withLive(c.live, payload) }));
      // Between turns its usage is where the next turn starts; one sent during a turn is part of the way through it.
      const counters = countersOf(payload.usage);
      if (counters && !chat.running) this.usageFrom.set(session_id!, counters);
      return;
    }
    if (type === "message.start") this.turnStart.set(chat.id, chat.items.at(-1)?.id ?? null);
    const usage = type === "message.complete" ? this.turnUsage(session_id!, payload.usage) : undefined;
    const from = this.turnStart.get(chat.id);
    if (type === "message.complete" || type === "error") this.turnStart.delete(chat.id);
    // A turn that failed without a `message.complete` ends without counters, so the next one can't be measured.
    if (type === "error") this.usageFrom.set(session_id!, "unknown");
    this.patchChat(chat.id, (c) => {
      const next = applyEvent(c, type, payload);
      return usage ? { ...next, items: withReplyUsage(next.items, usage, from) } : next;
    });
    if (type === "message.complete") {
      const receipt = (payload.persisted_turn ?? {}) as PersistedTurn;
      this.noteRows(chat.id, [receipt.user_row_id, receipt.final_assistant_row_id, ...(Array.isArray(receipt.row_ids) ? receipt.row_ids : [])]);
      this.stampTurn(chat.id, receipt);
    }
    if (type === "message.complete") this.track(this.refreshUsage(chat.id));
    // By the end of a turn Hermes has stored the session, so a pin that failed earlier can succeed.
    if (type === "message.complete" && this.pinWanted.has(chat.id)) this.track(this.writePin(chat.id));
    // The finished reply is newer than the read watermark, though the owner watched it come in.
    if (type === "message.complete" && this.isViewing(chat.id)) this.seen(chat.id);
    // A turn ends once; a repeated end finds the chat no longer running.
    if ((type === "message.complete" || type === "error") && chat.running) this.alert(NOTICES.finished);
    if (type === "message.complete") this.saveTranscript(chat.id);
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
   * A question from Hermes. An Approval shows as a card in its chat. Other kinds this app can't show yet are turned
   * down, so the agent doesn't wait out their timeout for an answer that won't come.
   */
  private onServerRequest(req: ServerRequest) {
    if (req.method !== "approval") {
      const error = { code: NO_SUCH_METHOD, message: `Hermes Chat can't answer ${req.method} requests yet.` };
      void this.pipe?.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, error })).catch(() => {});
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
      const told = this.request("approval.received", { session_id: chat.runtimeId, request_id: i.requestId }).catch((e) => {
        this.shownApprovals.delete(i.requestId);
        if (e instanceof RpcError && e.code === NO_SUCH_METHOD) this.noApprovalReceived = true;
      });
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
    this.generation++;
    clearInterval(this.heartbeat);
    // Lets the Rust side end the tunnel.
    if (pipe) this.droppedClosing = pipe.close().catch(() => {}).finally(() => (this.droppedClosing = undefined));
    for (const p of this.pending.values()) p.reject(new ConnectionLostError(`Connection closed: ${reason}`));
    this.pending.clear();
    this.infoCount.clear();
    this.earlyRequests.clear();
    // Runtime sessions end with the connection.
    this.usageFrom.clear();
    this.turnStart.clear();
    for (const c of this.snapshot.chats) {
      if (c.runtimeId) this.staleItems.set(c.id, c.items.length);
      if (c.running || c.items.some(isWaiting)) this.resumeOnReconnect.add(c.id);
    }
    this.update({
      status: "reconnecting",
      closedReason: reason,
      chats: this.snapshot.chats.map((c) => (c.runtimeId || c.running ? { ...c, runtimeId: undefined, live: undefined, running: false, stopping: false } : c)),
    });
  }

  /** A switch under way, with why it hasn't finished. */
  private switchFailed(e: Error): Pick<Snapshot, "switching"> {
    const switching = this.snapshot.switching;
    return switching ? { switching: { from: switching.from, error: e.message } } : {};
  }

  private retryLater() {
    const wait = RETRY_DELAYS_MS[this.failedTries];
    if (wait === undefined) return this.update({ status: "offline" });
    this.retryTimer = setTimeout(() => void this.redial(), wait);
  }

  private redial(): Promise<void> {
    if (this.closing || this.snapshot.status === "connected") return Promise.resolve();
    this.redialing ??= (async () => {
      clearTimeout(this.retryTimer);
      const switching = this.snapshot.switching;
      this.update({ status: "reconnecting", ...(switching && { switching: { from: switching.from } }) });
      try {
        await this.dial();
        this.failedTries = 0;
        this.resumeBusyChats();
        void this.sync();
      } catch (e) {
        if (this.closing) return;
        this.failedTries++;
        this.update({ closedReason: (e as Error).message, ...this.switchFailed(e as Error) });
        // A server that changed protocol won't change back on its own.
        if (e instanceof ProtocolMismatchError) this.update({ status: "offline" });
        else this.retryLater();
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
   * don't ride along with the next one. `goingOut` hears the prompt just before it goes.
   */
  private async submit(runtimeId: string, text: string, attachments: Attachment[], goingOut: (prompt: string) => void) {
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
      return (await this.request("prompt.submit", { session_id: runtimeId, profile: this.profile, text: prompt }).catch((e) => {
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
        const res = (await this.request("session.resume", { session_id: chatId, profile: this.profile, inline_images: false })) as {
          session_id: string;
          messages?: TranscriptMessage[];
          /** A live session's turn is still going. */
          running?: boolean;
          /** What a live session is still waiting on, oldest first. */
          open_requests?: ServerRequest[];
          info?: unknown;
          usage?: unknown;
        };
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

  private setSettled(chatId: string, settled: boolean): Promise<void> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat || chat.settled === settled) return Promise.resolve();
    this.pinWanted.set(chatId, !settled);
    this.patchChat(chatId, (c) => ({ ...c, settled }));
    return this.writePin(chatId);
  }

  /**
   * Writes the chat's wanted pinned flag once any earlier write for it is done. Each write reads the flag as it goes
   * out, so a quick Undo leaves the server where the owner left the chat. A failed write stays wanted: the chat stays
   * where the owner put it here, and the next finished turn or refresh tries again. A chat with a turn running may
   * not be stored yet, so its failure isn't reported until the end of the turn. `profile` is the chat's, which the
   * owner may have switched away from by the time the write goes out.
   */
  private writePin(chatId: string, profile = this.profile): Promise<void> {
    const write = (this.pinWrites.get(chatId) ?? Promise.resolve()).then(async () => {
      const pinned = this.pinWanted.get(chatId);
      if (pinned === undefined) return;
      const running = this.snapshot.chats.find((c) => c.id === chatId)?.running;
      try {
        await this.patchSession(chatId, profile, { pinned });
        this.pinnedSinceListRead.add(chatId);
        if (this.pinWanted.get(chatId) === pinned) this.pinWanted.delete(chatId);
        this.patchChat(chatId, (c) => (c.settledHere ? { ...c, settledHere: undefined } : c));
      } catch (e) {
        if (e instanceof EditRefusedError) return this.keepSettledHere(chatId, profile, pinned);
        if (!running) this.update({ syncError: `Couldn't keep a chat ${pinned ? "Active" : "Settled"} on the server: ${(e as Error).message}` });
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

  private async syncOnce(): Promise<Error | undefined> {
    const profile = this.profile;
    const cutoff = this.snapshot.olderPulled ? -Infinity : Date.now() - LIST_WINDOW_MS;
    this.pinnedSinceListRead.clear();
    this.readSinceListRead.clear();
    this.retitledSinceListRead.clear();
    const archivedListed = this.snapshot.archivedListed;
    const rows = new Map<string, SessionRow>();
    try {
      for (const r of await this.readList(profile, "exclude", cutoff)) rows.set(r.id, r);
      // Every page also carries the pinned chats that aren't archived; the list has them already.
      if (archivedListed) for (const r of await this.readList(profile, "only", -Infinity)) if (r.archived) rows.set(r.id, r);
    } catch (e) {
      if (this.profile === profile) this.update({ syncError: `Couldn't refresh the chat list: ${(e as Error).message}`, ...this.switchFailed(e as Error) });
      return e as Error;
    }
    // The owner switched profile meanwhile; the switch syncs the new one.
    if (this.profile !== profile) return undefined;

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
          source: toSource(r.source),
          settled: !(wanted ?? r.pinned),
          archived: this.isArchived(r) || undefined,
          updatedAt: Math.max(c?.updatedAt ?? 0, lastActive(r)),
          unread: !!r.unread && !readHere && !onScreen,
          // List rows carry the stored token and cost totals too.
          usage: newerChatUsage(c?.usage, chatUsageOf(r, Date.now())),
        };
      });
    // Chats started or resumed on this connection stay even before Hermes stores them (a new chat has no row
    // until its first prompt), and so do chats picked from a search and chats being archived or restored.
    const listedIds = new Set(listed.map((c) => c.id));
    const onThisConnection = this.snapshot.chats.filter(
      (c) => (c.runtimeId || this.revealed.has(c.id) || this.archiveWanted.has(c.id)) && !listedIds.has(c.id),
    );
    const chats = [...onThisConnection, ...listed];
    this.listedAt = Date.now();
    const switched = !!this.snapshot.switching;
    this.update({ chats, syncError: undefined, switching: undefined });
    for (const chatId of readOnScreen) this.seen(chatId);
    this.saveList(profile, chats);
    if (switched) this.cache.rememberProfile(profile);
    const busy = this.busyIn.get(profile);
    this.busyIn.delete(profile);
    for (const id of busy ?? []) this.resumeOnReconnect.add(id);
    if (busy) this.resumeBusyChats();
    await this.checkUnsureArchives(profile);
    await this.checkUnknownSends(profile);
    return undefined;
  }

  /**
   * Reads the profile's chats from dashboard REST, most recent first, `archived` ones excluded or only those, until
   * the list passes `cutoff`. Every page also carries all pinned rows, archived or not, out of order; the unpinned
   * ones follow recency.
   */
  private async readList(profile: string, archived: "exclude" | "only", cutoff: number): Promise<SessionRow[]> {
    const rows: SessionRow[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const query = new URLSearchParams({
        profile,
        order: "recent",
        limit: String(PAGE_SIZE),
        offset: String(offset),
        exclude_sources: "cron",
        ...(archived === "only" && { archived }),
      });
      const res = (await this.rest("GET", `api/sessions?${query}`)) as SessionPage;
      rows.push(...res.sessions);
      const passedCutoff = res.sessions.some((r) => !r.pinned && lastActive(r) < cutoff);
      if (passedCutoff || res.sessions.length === 0 || offset + PAGE_SIZE >= res.total) break;
    }
    return rows;
  }

  /**
   * How many chats in another profile's list are Unread, counted as the list would show them, from one page of its
   * most recent chats. `more`: the list reaches past that page, so there may be more.
   */
  private async unreadIn(profile: string): Promise<{ unread: number; more: boolean }> {
    const cutoff = this.cache.olderPulled(profile) ? -Infinity : Date.now() - LIST_WINDOW_MS;
    const query = new URLSearchParams({ profile, order: "recent", limit: String(OTHER_PAGE_SIZE), offset: "0", exclude_sources: "cron" });
    const res = (await this.rest("GET", `api/sessions?${query}`)) as SessionPage;
    const unread = res.sessions.filter((r) => r.unread && !r.archived && !this.deleted.has(r.id) && lastActive(r) >= cutoff).length;
    // As in syncOnce: the page also carries every pinned row, and the unpinned ones follow recency.
    const passedCutoff = res.sessions.some((r) => !r.pinned && lastActive(r) < cutoff);
    return { unread, more: !passedCutoff && res.sessions.length > 0 && OTHER_PAGE_SIZE < res.total };
  }

  /** Keeps the profile's list for the next start, without the chats' transcripts. */
  private saveList(profile: string, chats: Chat[]) {
    this.cache.save(
      profile,
      chats.map(({ id, title, source, settled, settledHere, archived, updatedAt, unread }) => ({
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
   * reads it where its tools run, which for a profile with an SSH terminal backend is that machine.
   */
  readServerFile(path: string): Promise<FileView> {
    return readServerFile((q) => this.rest("GET", q), path, this.snapshot.profile);
  }

  private async rest(method: RestMethod, pathAndQuery: string, body?: unknown): Promise<unknown> {
    // Once closed (signed out), nothing more goes out: the Rust side relays through whichever sign-in is current, which
    // may be another server's by then.
    if (!this.pipe || this.closing) throw new Error("Not connected to Hermes.");
    return JSON.parse(await this.pipe.request(method, pathAndQuery, body === undefined ? undefined : JSON.stringify(body)));
  }

  /** A REST GET's raw answer, refused past `maxBytes` when that is given. Only while connected. */
  private restGet(pathAndQuery: string, maxBytes?: number): Promise<string> {
    const pipe = this.pipe;
    if (!pipe || this.snapshot.status !== "connected") return Promise.reject(new Error("Not connected to Hermes."));
    return maxBytes === undefined ? pipe.request("GET", pathAndQuery) : pipe.getLimited(pathAndQuery, maxBytes);
  }

  private track(p: Promise<unknown>) {
    const done: Promise<unknown> = p.catch(() => {}).finally(() => this.background.delete(done));
    this.background.add(done);
  }

  /** One JSON-RPC request. With a `file`, the pipe swaps its base64 in for the `FILE_MARK` in `params`. */
  private request(method: string, params: Record<string, unknown>, file?: { path: string; maxBytes: number }): Promise<unknown> {
    const pipe = this.pipe;
    if (!pipe || this.snapshot.status !== "connected") return Promise.reject(new Error("Not connected to Hermes."));
    const id = this.nextId++;
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
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
  private saveOutbox(chatId: string) {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (chat) this.cache.saveOutbox(this.profile, chatId, chat.items.filter(isOutgoing));
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
        readBack = (res.messages ?? []).map((m) => ({ role: m.role ?? "", text: storedText(m.content), rowId: m.id }));
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

  private patchChat(id: string, fn: (c: Chat) => Chat) {
    if (!this.snapshot.chats.some((c) => c.id === id)) return;
    this.update({ chats: this.snapshot.chats.map((c) => (c.id === id ? fn(c) : c)) });
  }

  private update(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn();
  }
}

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
type StoredMessage = { role?: string; content?: unknown };

/** The text of a stored message: its `content`, or the text parts of a multimodal one. */
function storedText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join(" ");
}

/** The user and assistant messages with text among stored rows, oldest first. */
const saidIn = (rows: StoredMessage[]) =>
  rows
    .filter((r) => r.role === "user" || r.role === "assistant")
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

/** `p`, or a rejection once `ms` have passed without an answer. */
function timeLimit<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("Hermes didn't answer in time.")), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
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
function toSource(source = ""): Source {
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
    const rowId = m.role === "assistant" && Number.isSafeInteger(m.row_id) ? (m.row_id as number) : undefined;
    if (m.role === "user" || m.role === "assistant") return [...thought, { kind: m.role, id, text: m.text, ...(at && { at }), ...(rowId !== undefined && { rowId }) }];
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
 * Context fullness only as Hermes measured it: none until it has. YOLO only when Hermes reports it.
 */
function withLive(prev: SessionLive | undefined, info?: unknown, usage?: unknown): SessionLive | undefined {
  const i = obj(info);
  const u = obj(usage) ?? obj(i?.usage);
  if (!i && !u) return prev;
  const live: SessionLive = { ...prev };
  if (typeof i?.yolo === "boolean") Object.assign(live, { yolo: i.yolo, yoloEverywhere: i.approval_mode === "off" });
  if (u) live.context = contextUse(u);
  return live;
}

function contextUse(u: Record<string, unknown>): ContextUse | undefined {
  const { context_used: used, context_max: max, context_percent: percent } = u;
  if (typeof used !== "number" || typeof max !== "number" || typeof percent !== "number" || max <= 0) return undefined;
  return { used, max, percent, estimated: u.context_estimated === true };
}

function errorItem(c: Chat, text: string): Item {
  return { kind: "error", id: `e-${c.items.length}`, text };
}

/** Ends a turn's tool calls that were still running when it ended. */
const endRunningTools = (items: Item[], status: "done" | "stopped") =>
  items.map((i): Item => (i.kind === "tool" && i.status === "running" ? { ...i, status } : i));

/**
 * Marks the last reply interrupted and its running tool calls stopped. A reply stopped before it said anything gets
 * an empty one, so the transcript still shows the stop.
 */
function markInterrupted(items: Item[]): Item[] {
  const out = endRunningTools(items, "stopped");
  const last = out[out.length - 1];
  if (last?.kind === "assistant") out[out.length - 1] = { ...last, interrupted: true };
  else out.push({ kind: "assistant", id: `a-${out.length}`, text: "", interrupted: true });
  return out;
}

/**
 * Gives a turn's usage to its reply: the last reply or error after the turn started (`from`, else the last message),
 * unless it has some already, which a repeated `message.complete` would find.
 */
function withReplyUsage(items: Item[], usage: ReplyUsage, from?: string | null): Item[] {
  const start = from === null ? 0 : from === undefined ? items.map((i) => i.kind).lastIndexOf("user") + 1 : items.findIndex((i) => i.id === from) + 1;
  // If the boundary itself disappeared, there is no reliable turn to attach these counters to.
  if (typeof from === "string" && start === 0) return items;
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

// Fold one session event into a chat. Text deltas extend the trailing assistant item, or start a new one
// after a tool call; reasoning deltas do the same with thinking items.
function applyEvent(c: Chat, type: string, p: Record<string, unknown>): Chat {
  const items = [...c.items];
  const last = items[items.length - 1];
  switch (type) {
    case "message.start":
      return { ...c, running: true, updatedAt: Date.now() };
    // `thinking.delta` is Hermes's spinner and wait notices, not reasoning, so it isn't shown.
    case "reasoning.delta": {
      const text = p.text;
      if (typeof text !== "string" || !text) return c;
      if (last?.kind === "thinking") items[items.length - 1] = { ...last, text: last.text + text };
      else items.push({ kind: "thinking", id: `r-${items.length}`, text });
      return { ...c, items, updatedAt: Date.now() };
    }
    // A response's reasoning in one go, up to 500 characters, when the model didn't stream it.
    case "reasoning.available": {
      const text = typeof p.text === "string" ? p.text.trim() : "";
      if (!text || last?.kind === "thinking") return c;
      items.push({ kind: "thinking", id: `r-${items.length}`, text });
      return { ...c, items };
    }
    case "message.delta": {
      const text = p.text;
      if (typeof text !== "string" || !text) return c;
      if (last?.kind === "assistant") items[items.length - 1] = { ...last, text: last.text + text };
      else items.push({ kind: "assistant", id: `a-${items.length}`, text });
      return { ...c, items, updatedAt: Date.now() };
    }
    case "tool.start":
      items.push({
        kind: "tool",
        id: String(p.tool_id),
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
                result: typeof p.result === "string" ? p.result : p.result == null ? undefined : JSON.stringify(p.result, null, 2),
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
      const lastUser = items.map((i) => i.kind).lastIndexOf("user");
      const answered = items.slice(lastUser + 1).some((i) => i.kind === "assistant");
      // The last response's reasoning, for a turn that showed none: it goes before the reply.
      const reasoning = typeof p.reasoning === "string" ? p.reasoning.trim() : "";
      if (reasoning && !items.slice(lastUser + 1).some((i) => i.kind === "thinking")) {
        const reply = items.map((i) => i.kind).lastIndexOf("assistant");
        items.splice(reply > lastUser ? reply : items.length, 0, { kind: "thinking", id: `r-${items.length}`, text: reasoning });
      }
      if (!answered && typeof p.text === "string" && p.text) items.push({ kind: "assistant", id: `a-${items.length}`, text: p.text });
      const end = { ...c, live: withLive(c.live, undefined, p.usage), running: false, stopping: false, updatedAt: Date.now() };
      // Stopped here or from another Hermes client.
      if (p.status === "interrupted") return { ...end, items: markInterrupted(endWaitingApprovals(items, "turn ended")) };
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
