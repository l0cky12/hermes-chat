// What the UI renders. Terms follow GLOSSARY.md: a Chat is Active or Settled, may be Archived, and has one Source.
import type { ModelPick } from "./models";
import type { ChatUsage, ReplyUsage } from "./usage";
import type { SubagentTree } from "./subagents";
import type { DispatchedTask, RosterWork } from "./dispatched";

/** `import`: a transcript file imported into Hermes (ADR 0031). Hermes Chat shows it read-only. */
export type Source = "app" | "telegram" | "discord" | "cli" | "desktop" | "import" | "other";

export const SOURCE_LABEL: Record<Source, string> = {
  app: "Hermes Chat",
  telegram: "Telegram",
  discord: "Discord",
  cli: "the command line",
  desktop: "the Hermes desktop app",
  import: "a transcript file",
  other: "another Hermes platform",
};

/** A local file the owner is sending with a message: an image Hermes looks at, or any other file. */
export type Attachment = { path: string; name: string; size: number; kind: "image" | "file" };

/** Local files checked for attaching: the ones Hermes takes, and why each of the others can't go. */
export type AttachCheck = { attachments: Attachment[]; refused: string[] };

/**
 * `at` on a message or reply: when Hermes stored it (Unix ms), read from its stored row. It is left out until that row
 * is known, never filled in with when this app saw the message.
 */
/**
 * A message sent from this app that Hermes hasn't confirmed. `sending`: on its way. `failed`: Hermes didn't take it,
 * or reading back its history showed it never arrived. `unknown`: it went out and the connection dropped, or the app
 * closed, before Hermes answered, so Hermes may have it; the next read of the chat's history settles it. `reason`:
 * why, for `failed` and `unknown`. `attachments`: the files sent with it, so Retry sends them again. `sent`: set as it
 * goes out, to find it in the history: the prompt as sent, and the newest stored row the chat had then (`after`).
 */
export type Outgoing = {
  state: "sending" | "failed" | "unknown";
  reason?: string;
  attachments?: Attachment[];
  sent?: { prompt: string; after?: number };
  /**
   * A message that runs skills (skillCommands.ts): what `command.dispatch` is asked, so a retry runs them again. The
   * skill's text Hermes builds from it is never kept here; `sent.prompt` is what Hermes's history shows for it.
   */
  skill?: { name: string; arg: string };
};

export type Item =
  /**
   * `attachments`: names sent with the message. `outgoing`: sent from here and not confirmed yet. `rowId`: its stored
   * row, once known. `steer`: it went into a running reply, as `/steer` does, rather than starting a turn of its own
   * (Hermes stores it with `display_kind: "steer"`, ADR 0057).
   */
  | { kind: "user"; id: string; text: string; attachments?: string[]; at?: number; outgoing?: Outgoing; rowId?: number; steer?: boolean }
  /**
   * `interrupted`: the owner, or another Hermes client, stopped this reply before it finished. `rowId`: its stored row,
   * once known. `usage`: the tokens its turn took, only for a reply this app watched finish (`usage.ts`).
   */
  | { kind: "assistant"; id: string; text: string; interrupted?: boolean; at?: number; rowId?: number; usage?: ReplyUsage }
  /** The model's reasoning before a reply or a tool call, as Hermes streams or stores it. */
  | { kind: "thinking"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      /** The tool call's id (`tool_call_id`), the same live and in stored history; Outputs go to the call by it. */
      callId?: string;
      name: string;
      args?: Record<string, unknown>;
      preview?: string;
      /** `stopped`: the reply was interrupted while the tool call was running. */
      status: "running" | "done" | "stopped";
      durationS?: number;
      result?: string;
      summary?: string;
    }
  /**
   * An Approval: Hermes asks before running a command it counts as dangerous. `answer`: the owner's, from this app.
   * `ended`: why Hermes stopped waiting without one: its own reason (`timeout`, `interrupted`, `resolved` when
   * another Hermes client answered), `turn ended`, or `lost` when Hermes let go of the session while the connection
   * was down, or the chat couldn't be loaded again. `choices`: the answers Hermes offers, in its order.
   * `allowSession` / `allowPermanent`: false when Hermes rules out allowing the command for the chat, or always.
   */
  | {
      kind: "approval";
      id: string;
      requestId: string;
      command: string;
      description: string;
      choices: ApprovalChoice[];
      allowSession: boolean;
      allowPermanent: boolean;
      answer?: ApprovalChoice;
      ended?: string;
    }
  /** `usage`: the tokens a failed turn took before it failed, as for a reply. */
  | { kind: "error"; id: string; text: string; usage?: ReplyUsage };

/** How the owner answers an Approval: run it this once, for the rest of the chat, always, or not at all. */
export const APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const;
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

export type ApprovalItem = Extract<Item, { kind: "approval" }>;

/** A message sent from here that Hermes hasn't confirmed (`Outgoing`). */
export type OutgoingItem = Extract<Item, { kind: "user" }> & { outgoing: Outgoing };

export const isOutgoing = (i: Item): i is OutgoingItem => i.kind === "user" && i.outgoing !== undefined;

/**
 * Where the last turn starts: just after the owner's last message that began one. A steered message goes into the
 * reply already running, so it doesn't begin a turn. 0 when there is no such message.
 */
export const turnStart = (items: Item[]) => {
  for (let n = items.length - 1; n >= 0; n--) {
    const i = items[n];
    if (i.kind === "user" && !i.steer) return n + 1;
  }
  return 0;
};

/**
 * A Queued message: words and files the owner lined up to send after the chat's reply (ADR 0018). `id` is stable for
 * its life in the queue. Once it goes it leaves the queue and is an outgoing message (`Outgoing`) like any other.
 */
export type Queued = { id: string; text: string; attachments?: Attachment[] };

/**
 * A chat's queue, kept on this computer per connection, profile and chat. `paused`: why it waits for the owner's
 * Resume (the owner paused it, or the last reply ended in a way the owner should look at first). `unsaved`: the last
 * write to this computer's storage failed, so it lasts only until the app closes.
 */
export type ChatQueue = { items: Queued[]; paused?: string; unsaved?: boolean };

/** The most messages one chat's queue holds. */
export const QUEUE_LIMIT = 20;

/** Every key either holds has the same value in both, compared by identity; a missing key counts as undefined. */
export function sameFields<T extends object>(a: T, b: T): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof T)[]);
  return [...keys].every((k) => a[k] === b[k]);
}

/** The answers the owner can give an Approval: the ones Hermes offers, less the broader grants it rules out. */
export const offeredChoices = (i: ApprovalItem): ApprovalChoice[] =>
  i.choices.filter((c) => (c !== "session" || i.allowSession) && (c !== "always" || i.allowPermanent));

/** Answers that allow the command beyond this once, so the owner confirms them first. */
export const isBroadGrant = (c: ApprovalChoice) => c === "session" || c === "always";

/** An Approval Hermes is still waiting on. */
export const isWaiting = (i: Item): i is ApprovalItem => i.kind === "approval" && !i.answer && !i.ended;

export type Chat = {
  /** The stored Hermes session id, as dashboard REST lists it. */
  id: string;
  /** The legacy WS runtime session id, once this app has started or resumed the chat on this connection. */
  runtimeId?: string;
  title: string;
  source: Source;
  settled: boolean;
  /** Whether it is Active or Settled is kept on this computer, because Hermes won't store it for this chat (ADR 0002). */
  settledHere?: boolean;
  /** Archived in Hermes: hidden in every Hermes client, its history kept. Active or Settled stays as it was. */
  archived?: boolean;
  /** A bot's Bot Chat, opened from the Bots view: it stays out of the chat list and search (bots.ts, ADR 0066). */
  bot?: boolean;
  updatedAt: number;
  /** Something happened in it since the owner last opened it here or in another Hermes client (ADR 0002). */
  unread?: boolean;
  items: Item[];
  /** Its stored history is on the way (`Hermes.open`). */
  loading?: boolean;
  /**
   * The transcript on screen is the Saved copy this computer took at this time, not yet loaded from Hermes on this
   * connection: Hermes can't be reached, or the history is still on the way.
   */
  savedAt?: number;
  running?: boolean;
  /** Stop was asked for; the reply keeps running until Hermes ends the turn (`Hermes.stop`). */
  stopping?: boolean;
  /**
   * The model the chat runs on: as Hermes last reported it for the chat, or as the owner last picked for it here.
   * Unknown until the chat is started or resumed on this connection, or for a server that doesn't say.
   */
  model?: ModelPick;
  /** What Hermes reports about the chat's session on this connection; gone when the connection drops. */
  live?: SessionLive;
  /**
   * Its tokens and cost over its whole life, as Hermes last recorded them (`usage.ts`). Unknown until read from Hermes on
   * this connection. `usageError`: why the latest read failed; `usage` is then the earlier read, if any.
   */
  usage?: ChatUsage;
  usageError?: string;
  /** The Subagents its replies started that this connection has heard of (subagents.ts, ADR 0072). Kept until the app closes. */
  subagents?: SubagentTree;
  /**
   * Its background subagents as Hermes's `subagent.roster` counts them, while it has no Subagents tree here, from when the
   * app saw them running until their wake turn ends (dispatched.ts `RosterWork`, issue #311). Set by the transport only.
   */
  roster?: RosterWork;
  /**
   * The kanban tasks its replies created, in any of its lineage's segments, that are outstanding, need the owner, or
   * are over but inside the wake grace (dispatched.ts, kanban.ts). Set by the transport only.
   */
  tasks?: DispatchedTask[];
  /** The ids of every segment of a compressed chat (`_lineage_ids`, ADR 0026), so a task filed under an earlier one matches. */
  lineage?: string[];
  /**
   * Its side questions on screen, oldest first. They are never among its items, so nothing that saves, exports,
   * branches or sends the chat sees them; the transcript shows each where it was asked (ADR 0070, ADR 0086).
   */
  sideQuestions?: SideQuestion[];
};

/**
 * A question asked with `/btw` (GLOSSARY "Side question (/btw)", ADR 0070), which Hermes answers from a snapshot of the
 * chat without adding to it. `taskId`: Hermes's id for it once Hermes took it, which its answer (`btw.complete`) names.
 * `after`: the id of the chat's last item when it was asked, which the transcript shows it after; none when the chat had
 * none (ADR 0086).
 */
export type SideQuestion = { id: string; question: string; after?: string; taskId?: string } & (
  | { state: "asking" }
  | { state: "answered"; answer: string }
  | { state: "failed"; error: string }
);

/**
 * A chat's live session as Hermes reports it (`session.info`, `session.usage`, research doc "Status bar"); its model is
 * `Chat.model`.
 * `context`: how full the context window is, only once Hermes has measured it. `approvals`: its approval mode as Hermes
 * last reported it (ADR 0091); undefined until Hermes does. `compactions`: how many times Hermes has compacted the chat
 * since its agent was built on the server (`usage.compressions`); undefined when Hermes reports no compactor for it.
 */
export type SessionLive = { context?: ContextUse; approvals?: Approvals; compactions?: number };

/** The profile's `approvals.mode` (GLOSSARY "Approval mode"). */
export type ApprovalMode = "smart" | "manual" | "off";

/**
 * What Hermes does before a command it counts as dangerous in a chat, as it reports it (`approval_mode`, `yolo` in
 * `session.info`). `mode`: the profile's, shared by every session on the profile. `yolo`: Hermes runs such commands in
 * this chat without asking, because the chat's own flag is on, `mode` is "off", or Hermes was launched with `--yolo`.
 */
export type Approvals = { mode: ApprovalMode; yolo: boolean };

/** `used` of `max` tokens, `percent` full. `estimated`: Hermes counted part of it itself, not the provider. */
export type ContextUse = { used: number; max: number; percent: number; estimated: boolean };

export type ConnectionStatus = "connected" | "connecting" | "reconnecting" | "offline";

/**
 * Unread chats in a profile the app isn't showing, as its latest check found them (`Hermes.checkOtherProfiles`).
 * `unread`: how many chats in the profile's list are Unread. `more`: the check read only the profile's most recent
 * chats and the list holds more, so more of them may be Unread. `error`: why the latest check failed; the other
 * fields then come from an earlier check, if there was one. When it was read is in `CheckTimes`.
 */
export type OtherProfile = {
  unread?: number;
  more?: boolean;
  error?: string;
  chats?: ListedChat[];
  sends?: SavedSend[];
  failures?: SeenFailure[];
};

/**
 * A failure this app saw in a chat of a profile, before the owner switched away from it. Hermes keeps no record of it
 * that a check could read, so it is kept, by its error row's id and a fingerprint of its text, until the owner is
 * back in the profile. No text is kept.
 */
export type SeenFailure = { chatId: string; title: string; itemId: string; mark: string };

/**
 * A chat in the page of another profile's list that the latest check read, for the inbox. `at`: its last activity
 * (Unix ms). `unread`: it counts towards the profile's Unread chats.
 */
export type ListedChat = { id: string; title: string; at: number; unread: boolean; source?: Source };

/** A Failed message this computer keeps for a chat in a profile not shown (`Outgoing`): Hermes didn't take it, or may not have. */
export type SavedSend = { chatId: string; itemId: string; state: "failed" | "unknown"; title?: string };

/** The profiles the app isn't showing, by name. `error`: why the latest check couldn't list the profiles. */
export type OtherProfiles = { byName: Record<string, OtherProfile>; error?: string };

/**
 * The sessions live in the dashboard's own process, in every profile, as `session.active_list` last reported them:
 * the ones working on a turn, or waiting for the owner's answer. `chatId`: the stored session id. `at`: its last
 * activity (Unix ms). `profile`: the profile it is in, when known: for a session this app started or resumed, or
 * once looking its id up in every profile found it in exactly one; `title` and `source` then come from that profile's
 * row. `error`: why the latest check failed; `sessions` are then from the one before. `unsupported`:
 * this Hermes has no `session.active_list`.
 */
export type LiveSession = { chatId: string; status: "working" | "waiting"; at: number; profile?: string; title?: string; source?: Source };
export type LiveSessions = { sessions: LiveSession[]; error?: string; unsupported?: boolean };

/**
 * When each background check last read its answer (Unix ms), kept apart from what it found so a check that finds
 * nothing new changes nothing the app draws (#423). `others`: the profiles were listed. `byProfile`: each profile not
 * shown had its chats read; a failed read keeps the time of the one before. `live`: `session.active_list` answered.
 */
export type CheckTimes = { others?: number; live?: number; byProfile: Record<string, number> };

/**
 * A chat found by searching all chats (`Hermes.search`). `snippet`: the text around the match, with the matched words
 * marked. `find`: what find-in-chat looks for when the chat opens; there is none when only the title matched.
 */
export type Found = Pick<Chat, "title" | "source" | "settled" | "archived" | "updatedAt"> & {
  chatId: string;
  snippet: { text: string; hit?: boolean }[];
  find?: string;
  /** The kind of message that matched. */
  role?: "user" | "assistant";
  /** The model Hermes last recorded for the chat, when it says. */
  model?: string;
  /** Hermes stored it as a local chat without saying which app started it, so it can't be matched by source. */
  sourceUnknown?: boolean;
};
