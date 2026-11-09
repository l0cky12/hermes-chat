// Transcript, thinking, tool-call groups, Approval cards, find bar, composer and the Settle button, ported from the prototype.
// Dictation and Read aloud come from Voice.tsx.
import { createContext, memo, type ReactNode, type RefObject, useCallback, useContext, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Archive, ArchiveRestore, ArrowUp, Brain, Camera, ChevronDown, ChevronRight, ChevronUp, CircleAlert, CloudOff, Columns2, CornerDownRight, EyeOff, FileDown, FileInput, Globe, HardDrive, Link2, ListPlus, Ellipsis, Paperclip, RotateCcw, Search, Server, Square, Trash2, Wrench, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { ApprovalChoice, AttachCheck, Attachment, Chat, ChatQueue, ConnectionStatus, Item, OutgoingItem, SideQuestion, Source } from "../hermes/model";
import { SOURCE_LABEL, isOutgoing, isWaiting } from "../hermes/model";
import type { SkillCall } from "../hermes/skillCommands";
import type { DeskState, ScreenshotDesk } from "../hermes/screenshots";
import { ApprovalCard } from "./ApprovalCard";
import { Menu, PinItem, type ChatPin } from "./ChatMenu";
import { isBotChat } from "../hermes/bots";
import { DeleteChatDialog } from "./DeleteChat";
import { ExportChatDialog } from "./ExportChat";
import { QueuePanel, type QueueApi } from "./Queue";
import { SubagentsPanel, type SubagentsApi } from "./Subagents";
import type { SubagentId } from "../hermes/subagents";
import { SideQuestionPair } from "./SideQuestions";
import { Markdown } from "./Markdown";
import { SourceIcon, Spinner, StoredTime, composing, highlight } from "./bits";
import { caretAfter, editStep, inputKind, type EditStep } from "./editKeys";
import type { EditKind } from "../hermes/editHistory";
import { wakeFull } from "../hermes/snooze";
import { stagedFiles } from "../hermes/unsaved";
import { AttachmentChip, Previews, readPreview } from "./previews";
import { Speaker } from "./speaker";
import { DictationNoteView, DictationStrip, ListenButton, MicButton, type VoiceApi, listenBlocked, micBlocked, useDictation, useVoiceSetup } from "./Voice";
import { withTranscript } from "../hermes/voice";
import { turnSettings } from "../hermes/voiceTurns";
import { LIMITS, overLimitNote, type Delivery } from "../hermes/transport";
import { ConversationPanel, StartConversationButton, conversationAway, startBlocked, usePageHidden, useVoiceConversation } from "./VoiceConversation";
import type { ConversationState, VoiceConversation } from "./conversation";
import type { VoiceSetup } from "../hermes/pipe";
import { ChatUsageButton, ReplyUsageLine } from "./Usage";
import { useLinkMenu, useOpenPreview } from "./previewContext";
import { ShowInChatContext, type ShowInChat } from "./showInChat";
import { linkTarget, previewName, toolTargets, withoutBidi } from "../hermes/preview";
import { type CommandHost, useSlashCommands } from "./SlashCommands";
import { BranchButton } from "./Branch";
import { useWindowHidden } from "./windowState";
import { EditButton, RegenerateButton, VariantNav } from "./Replay";
import { CopyButton, replyMarkdown } from "./CopyMessage";
import { turnsOf, type ReplayKind, type Variant } from "../hermes/replay";
import type { FollowUp } from "../hermes/uiPrefs";
import { sttRoute } from "../hermes/sttRoute";

/**
 * What a message sent while the chat's reply runs does (ADR 0057). `mode`: what Enter does, the Follow-up behavior
 * setting; Ctrl+Enter does the other. `why`: why a message can't steer the running reply now, so it is queued instead,
 * or undefined when it can. `steer` sends the words into the running reply and empties the Draft once Hermes has taken
 * them; it resolves with a note to show, if any, and rejects saying why nothing went.
 */
export type FollowUpHost = {
  mode: FollowUp;
  why(): string | undefined;
  steer(text: string): Promise<string | undefined>;
};

/** Why a message with files can't steer: `/steer` carries only words. */
const FILES_CANT_STEER = "A steer carries only words, so a message with files goes after the reply.";

/** The reasons for queueing instead of steering already told, so each is said once while the app runs. */
const toldWhy = new Set<string>();

type ToolItem = Extract<Item, { kind: "tool" }>;
type ThinkingItem = Extract<Item, { kind: "thinking" }>;
type Block = { kind: "tools"; id: string; tools: ToolItem[] } | Exclude<Item, ToolItem>;
type SideBlock = { kind: "side"; id: string; question: SideQuestion };

// Consecutive tool calls collapse into one group so a long run doesn't dominate the transcript. Each side question
// goes after the item it was asked after (ADR 0086), so one asked during a run of tool calls splits it.
function toBlocks(items: Item[], side: SideQuestion[] = []): (Block | SideBlock)[] {
  const out: (Block | SideBlock)[] = [];
  const sideAfter = (id?: string) => {
    for (const q of side) if (q.after === id) out.push({ kind: "side", id: q.id, question: q });
  };
  sideAfter(undefined);
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === "tool") {
      if (last?.kind === "tools") last.tools.push(it);
      else out.push({ kind: "tools", id: `g-${it.id}`, tools: [it] });
    } else out.push(it);
    sideAfter(it.id);
  }
  return out;
}

// A group is rebuilt on every render, so it counts as unchanged when it holds the same tool calls.
const sameBlock = (a: Block, b: Block) =>
  a === b || (a.kind === "tools" && b.kind === "tools" && a.tools.length === b.tools.length && a.tools.every((t, i) => t === b.tools[i]));

/**
 * Where the find bar opens when a chat is opened from a search: on `query`, at the first match in the message
 * `itemId`, or at the first match anywhere when the matched message isn't known. `at` tells one pick from the next.
 */
export type FindTarget = { query: string; itemId?: string; at: number };

/**
 * What to go to: a tool call, opened, by its call id (`Item.callId`), or a message by its stored row (`rowId`), as a
 * branch's link back does. `at` tells one request from the next.
 */
export type JumpTarget =
  | { callId: string; rowId?: undefined; turn?: undefined; at: number }
  | { rowId: number; callId?: undefined; turn?: undefined; at: number }
  /** The owner's message that starts turn `turn` (from 0), and its reply: where a version of that turn is opened. */
  | { turn: number; callId?: undefined; rowId?: undefined; at: number };
/** The tool call being gone to, for the tool rows and groups that hold it to open themselves. */
const JumpContext = createContext<JumpTarget | undefined>(undefined);

const STATUS_NOTE: Record<ConnectionStatus, string | undefined> = {
  connected: undefined,
  connecting: "Connecting to Hermes…",
  reconnecting: "Reconnecting to Hermes…",
  offline: "Offline. Click the status dot to reconnect.",
};

const NOT_CAPTURING: DeskState = { capturing: false };
const noDesk = () => () => {};
/**
 * The name a pasted file is saved under: its own, or for a screenshot (no name, or the webview's generic `image.png`)
 * a local timestamp like `clipboard-2026-11-02T153000.png`, its extension from the MIME type.
 */
export function pastedName(f: { name: string; type: string }, now = new Date()): string {
  if (f.name && !/^image\.\w+$/.test(f.name)) return f.name;
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replaceAll(":", "");
  return `clipboard-${local}.${/^\w+\/(\w+)$/.exec(f.type)?.[1] ?? "png"}`;
}

/**
 * Turns down a file dragged anywhere a pane doesn't take it, as the sidebar. Without this, on Windows (where Tauri's
 * native drop handler is off) the webview would open the dropped file in place of the app.
 */
export function refuseStrayFileDrops(target: Window = window) {
  const refuse = (e: DragEvent) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  };
  target.addEventListener("dragover", refuse);
  target.addEventListener("drop", refuse);
}

/**
 * The images on the clipboard, as files. WebKitGTK leaves a paste event's `files` empty even for a screenshot, but the
 * async clipboard API, asked during the paste, has it. Empty when there are none or the clipboard can't be read.
 */
async function clipboardImages(): Promise<File[]> {
  try {
    const items = await navigator.clipboard.read();
    return await Promise.all(
      items.flatMap((item) => {
        const type = item.types.find((t) => t.startsWith("image/"));
        return type ? [item.getType(type).then((b) => new File([b], "", { type }))] : [];
      }),
    );
  } catch {
    return [];
  }
}

/**
 * The header's More (⋯) menu: the chat's less-used actions, each with its name. It opens below its button, at the
 * button's right edge, and the arrow keys move between its items (ChatMenu.tsx's Menu). `onDelete`, left out while a
 * reply runs, adds Delete chat… last; it asks first (DeleteChat.tsx), and a reply starting meanwhile takes the question
 * away for good. Export as Markdown… opens the Export dialog (ExportChat.tsx); `onExport` gets its notice once saved.
 */
function MoreMenu({
  chat,
  onExport,
  onCopyLink,
  pin,
  onSettle,
  onArchive,
  onDelete,
}: {
  chat: Chat;
  onExport?: (notice: string) => void;
  onCopyLink?: () => void;
  pin?: ChatPin;
  onSettle?: (settled: boolean) => void;
  onArchive?: (archived: boolean) => void;
  onDelete?: () => void;
}) {
  const [at, setAt] = useState<{ x: number; y: number }>();
  const close = useCallback(() => setAt(undefined), []);
  const button = useRef<HTMLButtonElement>(null);
  const [askDelete, setAskDelete] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    if (!onDelete) setAskDelete(false);
  }, [!onDelete]);
  const item = (label: string, icon: ReactNode, run: () => void, title?: string, danger?: boolean) => (
    <button
      role="menuitem"
      className={`menu-item${danger ? " danger" : ""}`}
      title={title}
      onClick={() => {
        close();
        run();
      }}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{label}</span>
    </button>
  );
  return (
    <>
      <button
        ref={button}
        className={`icon-btn ${at ? "on" : ""}`}
        title={isBotChat(chat) ? "More actions: export" : `More actions: export, copy link, ${pin ? "pin, " : ""}settle, archive${onDelete ? ", delete" : ""}`}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={!!at}
        // Its open menu closes on a press outside it; a press here is the toggle's, so it doesn't reopen what it
        // closed. Only then: a press while closed must still reach another pane's open menu, to close it.
        onMouseDown={(e) => at && e.stopPropagation()}
        onClick={(e) => {
          if (at) return close();
          const r = e.currentTarget.getBoundingClientRect();
          // ponytail: 180px is .menu's min-width; a wider menu sits a little right of the button's edge.
          setAt({ x: r.right - 180, y: r.bottom + 4 });
        }}
      >
        <Ellipsis size={16} />
      </button>
      {at && (
        <Menu label={`More actions for ${chat.title}`} x={at.x} y={at.y} onClose={close}>
          {onExport && item("Export as Markdown…", <FileDown size={15} />, () => setExporting(true))}
          {/* A Bot Chat is opened from its bot's row, found by its title (ADR 0066): no link to it by id, and nothing
              that would retire it, which would leave its bot to start another. */}
          {onCopyLink && !isBotChat(chat) && item("Copy chat link", <Link2 size={15} />, onCopyLink, "Copy a link that opens this chat in Hermes Chat on this computer")}
          {pin && !isBotChat(chat) && !chat.archived && <PinItem pin={pin} onClose={close} />}
          {onSettle && !isBotChat(chat) && !chat.archived && item(chat.settled ? "Unsettle" : "Settle", chat.settled ? <ArchiveRestore size={15} /> : <Archive size={15} />, () => onSettle(!chat.settled))}
          {onArchive &&
            !isBotChat(chat) &&
            !chat.running &&
            (chat.archived
              ? item("Restore", <RotateCcw size={15} />, () => onArchive(false))
              : item("Archive", <EyeOff size={15} />, () => onArchive(true), "Hide in every Hermes client, keeping its history"))}
          {onDelete && !isBotChat(chat) && (
            <>
              <div className="menu-sep" role="separator" />
              {item("Delete chat…", <Trash2 size={15} />, () => setAskDelete(true), "Delete this chat in every Hermes client. This can't be undone.", true)}
            </>
          )}
        </Menu>
      )}
      {exporting && onExport && <ExportChatDialog chat={chat} returnTo={button} onSaved={onExport} onClose={() => setExporting(false)} />}
      {askDelete && onDelete && (
        <DeleteChatDialog
          title={chat.title}
          returnTo={button}
          onClose={() => setAskDelete(false)}
          onDelete={() => {
            setAskDelete(false);
            onDelete();
          }}
        />
      )}
    </>
  );
}

/** When a Saved copy was taken, as the note above it says it. */
const savedWhen = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * `alsoPostsIn`: the Telegram or Discord chat Hermes will also post its replies in. `draft`: the composer's text, kept
 * outside the pane so it survives switching chats. `onAnswer` answers an Approval card. `onSettle`, `onArchive`,
 * `onExport` and `onCopyLink` are left out for a chat not started yet. `notLoaded`: the chat has no Saved copy and can't load until
 * Hermes is connected. `onRetry`, `onEdit` and `onDismiss` act on failed or unconfirmed messages. `modelControls`
 * contains the model picker; `footer` contains the status bar. Only the active pane answers Ctrl+F and takes focus as
 * it opens. Native drops attach to the pane under the pointer. Export, Copy chat link, Settle and Archive are in the header's More menu.
 * `screenshots` attaches captures; `screenshotKeys` names the shortcut.
 * `voice` supplies Dictation and Read aloud. `voiceSend` puts a Voice conversation's turn in the chat as the owner's
 * message; it is left out for a chat not started yet, where a conversation can't start (ADR 0041). `commands` runs the slash commands typed in the composer. `queue` is the
 * chat's queue of messages waiting to go after its reply, and `queueApi` changes it; it is left out for a chat not
 * started yet, which can't queue. `branch` offers Branch from here under each message with text (ADR 0027): `blocked`
 * says why none can be made now. `branchedFrom` is shown at the top of a branch, where it came from. `replay` offers
 * Edit under the owner's messages and Regenerate under each turn's last reply (ADR 0035); `blocked` says why neither
 * can be used now. `variants` are the versions of this chat's turns, shown under each turn's last reply. Copy is under
 * every sent message and finished reply with text, whatever else is offered. `compare`: the pane is one of two compared
 * panes (ADR 0101), so a send goes to both chats and nothing queues or steers.
 */
export function ChatPane({
  chat,
  notLoaded,
  findTarget,
  jumpTo,
  onJumpMissed,
  status,
  alsoPostsIn,
  draft,
  onDraft,
  onDraftStep,
  onRetry,
  onEdit,
  onDismiss,
  onAttach,
  onSend,
  onStop,
  onAnswer,
  pin,
  onSettle,
  onArchive,
  onExport,
  onCopyLink,
  onDelete,
  modelControls,
  active = true,
  visible = true,
  split = false,
  voice,
  voiceSend,
  screenshots,
  screenshotKeys,
  projects,
  snoozedUntil,
  notice,
  banner,
  footer,
  onUsage,
  headActions,
  queue,
  queueApi,
  subagents,
  showSubagent,
  commands,
  onDismissSideQuestion,
  followUp,
  compare,
  branch,
  branchedFrom,
  replay,
  variants,
}: {
  chat: Chat;
  notLoaded?: boolean;
  findTarget?: FindTarget;
  /** Scroll to this tool call and open it, once the history holding it has loaded (Outputs, "Go to the message"). */
  jumpTo?: JumpTarget;
  /** The history loaded without the tool call `jumpTo` names. */
  onJumpMissed?: () => void;
  status: ConnectionStatus;
  alsoPostsIn?: Source;
  draft: string;
  onDraft: (text: string, how?: EditKind) => void;
  /** Undoes or redoes the Draft, and says its text then, or undefined when there was nothing to step. */
  onDraftStep: (step: EditStep) => string | undefined;
  onRetry: (itemId: string) => void;
  onEdit: (itemId: string) => void;
  onDismiss: (itemId: string) => void;
  onAttach: (paths: string[]) => Promise<AttachCheck>;
  /** `skill`: the message runs skills (skillCommands.ts); Hermes builds what goes from it. */
  onSend: (text: string, attachments: Attachment[], skill?: SkillCall) => void;
  onStop: () => void;
  onAnswer: (approvalId: string, choice: ApprovalChoice, confirmed?: boolean) => void;
  /** Pinning the chat to the top of the list (ADR 0085); left out for a chat not started yet. */
  pin?: ChatPin;
  onSettle?: (settled: boolean) => void;
  onArchive?: (archived: boolean) => void;
  /** Shows the notice for a chat exported with the Export dialog. */
  onExport?: (notice: string) => void;
  /** Copies the chat's link (chatLinks.ts). */
  onCopyLink?: () => void;
  /** Deletes the chat, once the owner has said yes in the header menu's question. */
  onDelete?: () => void;
  modelControls?: ReactNode;
  active?: boolean;
  visible?: boolean;
  split?: boolean;
  voice?: VoiceApi;
  voiceSend?: (text: string) => Promise<{ delivery: Delivery; itemId?: string }>;
  screenshots?: ScreenshotDesk;
  screenshotKeys?: string;
  /** The names of the projects the chat is in, or a new chat will be put in. */
  projects?: string[];
  /** When the chat wakes, if the owner snoozed it and it hasn't woken yet (snooze.ts). */
  snoozedUntil?: number;
  /** Shown at the top of the transcript: what a new chat starts with. */
  notice?: ReactNode;
  /** Shown under the header, outside the transcript's scroll: a question about this chat. */
  banner?: ReactNode;
  footer?: ReactNode;
  onUsage?: () => void;
  headActions?: ReactNode;
  queue?: ChatQueue;
  queueApi?: QueueApi;
  /** Steer, Stop and output for the chat's Subagents; without it the panel only shows them. */
  subagents?: SubagentsApi;
  /** A subagent to open in the Subagents panel, from the agent office. */
  showSubagent?: { id: SubagentId; at: number };
  commands?: CommandHost;
  /** Takes away the card of one of the chat's side questions (ADR 0070). */
  onDismissSideQuestion?: (id: string) => void;
  /** What sending does while the reply runs: queue or steer (ADR 0057). Without it, it queues. */
  followUp?: FollowUpHost;
  compare?: Comparing;
  branch?: { blocked?: string; onBranch: (itemId: string) => void };
  branchedFrom?: ReactNode;
  replay?: { blocked?: string; onReplay: (itemId: string, kind: ReplayKind) => void };
  variants?: { byTurn: Map<number, Variant[]>; onPick: (chatId: string, turn: number) => void };
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const voiceSetup = useVoiceSetup(voice, status === "connected");
  // One reply reads aloud at a time; closing the chat stops it and lets go of its audio.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const [speaker, setSpeaker] = useState<Speaker>();
  useEffect(() => {
    if (!voice) return;
    const s = new Speaker((text) => voiceRef.current!.speak(text));
    setSpeaker(s);
    return () => s.dispose();
  }, [!voice]);
  const listen = speaker && { speaker, blocked: listenBlocked(status, voiceSetup) };
  useEffect(() => { if (!active) speaker?.stop(); }, [active, speaker]);
  // Hidden to the tray, nothing is read aloud (ADR 0034).
  const windowHidden = useWindowHidden();
  useEffect(() => { if (windowHidden) speaker?.stop(); }, [windowHidden, speaker]);
  // A Voice conversation runs through the same speaker, and pauses whenever the owner can't see it (ADR 0041).
  const minimized = usePageHidden();
  const conversation = useVoiceConversation({
    voice,
    speaker,
    send: voiceSend,
    stopReply: onStop,
    chat,
    away: conversationAway({ status, windowHidden, pageHidden: minimized, active }),
  });
  // The blocks are memoized, so they get one answer handler for the life of the pane.
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  const answer = useCallback(
    (approvalId: string, choice: ApprovalChoice, confirmed?: boolean) => onAnswerRef.current(approvalId, choice, confirmed),
    [],
  );
  // So do failed messages, one handler for all three actions.
  const outgoingRef = useRef({ retry: onRetry, edit: onEdit, dismiss: onDismiss });
  outgoingRef.current = { retry: onRetry, edit: onEdit, dismiss: onDismiss };
  const onOutgoing = useCallback((itemId: string, action: OutgoingAction) => outgoingRef.current[action](itemId), []);
  // And Branch from here, one handler for every message.
  const branchRef = useRef(branch?.onBranch);
  branchRef.current = branch?.onBranch;
  const onBranch = useCallback((itemId: string) => branchRef.current?.(itemId), []);
  // And Edit and Regenerate.
  const replayRef = useRef(replay?.onReplay);
  replayRef.current = replay?.onReplay;
  const onReplay = useCallback((itemId: string, kind: ReplayKind) => replayRef.current?.(itemId, kind), []);
  const pickRef = useRef(variants?.onPick);
  pickRef.current = variants?.onPick;
  const onPickVariant = useCallback((chatId: string, turn: number) => pickRef.current?.(chatId, turn), []);
  // Each turn's owner's message, and its last reply with text: where Regenerate and the versions of the turn go.
  const turns = useMemo(() => {
    const ofUser = turnsOf(chat.items);
    const lastReply = new Map<number, string>();
    let turn = -1;
    for (const i of chat.items) {
      if (i.kind === "user" && !i.outgoing) turn = ofUser.get(i.id)!;
      else if (i.kind === "assistant" && turn >= 0 && i.text.trim()) lastReply.set(turn, i.id);
    }
    const anchor = new Map<string, number>();
    for (const [id, t] of ofUser) anchor.set(lastReply.get(t) ?? id, t);
    return { ofUser, regenerable: new Set(lastReply.values()), anchor };
  }, [chat.items]);
  // A failed message can be sent again once Hermes is connected and the chat has no reply running.
  const canRetry = status === "connected" && !chat.loading && !chat.running;
  const findRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  // For the status bar's context inspector: a stored time to the message there, marked as a jump to a tool call is.
  const showInChat = useCallback<ShowInChat>((at) => {
    const msgs = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>(".msg[data-item]") ?? []);
    const el = at === undefined ? msgs[0] : msgs.find((m) => m.dataset.at !== undefined && Number(m.dataset.at) >= at);
    if (!el) return false;
    stickToBottom.current = false;
    el.scrollIntoView?.({ block: "start" });
    el.classList.add("jumped");
    setTimeout(() => el.classList.remove("jumped"), 2500);
    return true;
  }, []);
  const [findOpen, setFindOpen] = useState(false);
  // Deleting waits for a reply to finish, here or in another client.
  const deleteHere = chat.running ? undefined : onDelete;
  const [query, setQuery] = useState("");
  // Which match is the current one, counting from the top of the chat.
  const [matchIndex, setMatchIndex] = useState(0);
  const [count, setCount] = useState(0);
  // A search pick waiting for the chat's history, so the find bar can land on the matched message.
  const [landing, setLanding] = useState(false);
  // The current match should be scrolled to after the next render.
  const scrollToMatch = useRef(false);

  useEffect(() => {
    if (!findTarget) return;
    setFindOpen(true);
    setQuery(findTarget.query);
    setLanding(true);
    stickToBottom.current = false;
  }, [findTarget?.at]);

  const openFind = () => {
    setFindOpen(true);
    setTimeout(() => findRef.current?.select(), 0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !composing(e) && activeRef.current) {
        e.preventDefault();
        openFind();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The transcript catches up with the find bar in the background, so re-marking a long chat doesn't hold up typing.
  const typed = findOpen ? query : "";
  const q = useDeferredValue(typed);

  // After every render, count the marks and point at the current one. Marks still for an earlier query don't count.
  useLayoutEffect(() => {
    if (q !== typed) return;
    const marks = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("mark.hit") ?? []);
    setCount(marks.length);
    let idx = Math.min(matchIndex, marks.length - 1);
    // Land once the history is in: it has marks, or it has loaded without any (the match was in a tool call, say).
    if (landing && !chat.loading && (marks.length || chat.runtimeId)) {
      setLanding(false);
      const itemId = findTarget?.itemId;
      idx = Math.max(0, itemId ? marks.findIndex((m) => m.closest(`[data-item="${CSS.escape(itemId)}"]`)) : 0);
      setMatchIndex(idx);
      scrollToMatch.current = true;
    }
    marks.forEach((m, i) => m.classList.toggle("current", i === idx));
    if (scrollToMatch.current && marks[idx]) {
      scrollToMatch.current = false;
      marks[idx].scrollIntoView({ block: "center" });
    }
  });

  // Going to a tool call: once its row is on screen, scroll it to the middle, mark it and move focus to it. A history
  // that loaded without it says so; one still loading, or a Saved copy while offline without it, waits.
  const [jumping, setJumping] = useState<JumpTarget>();
  useEffect(() => {
    if (!jumpTo) return;
    stickToBottom.current = false;
    setJumping(jumpTo);
  }, [jumpTo?.at]);
  useLayoutEffect(() => {
    if (!jumping) return;
    let el: HTMLElement | null | undefined;
    if (jumping.rowId !== undefined) {
      const rowId = jumping.rowId;
      const item = chat.items.find((i) => (i.kind === "user" || i.kind === "assistant") && i.rowId === rowId);
      el = item && scrollRef.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(item.id)}"]`);
    } else if (jumping.turn !== undefined) {
      const turn = jumping.turn;
      const id = [...turns.anchor].find(([, t]) => t === turn)?.[0];
      el = id ? scrollRef.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"]`) : undefined;
    } else {
      const id = CSS.escape(jumping.callId);
      el = scrollRef.current?.querySelector<HTMLElement>(`[data-call="${id}"]`) ?? scrollRef.current?.querySelector<HTMLElement>(`[data-calls~="${id}"]`);
    }
    if (el) {
      setJumping(undefined);
      el.scrollIntoView?.({ block: "center" });
      el.classList.add("jumped");
      el.focus({ preventScroll: true });
      setTimeout(() => el.classList.remove("jumped"), 2500);
    } else if (!chat.loading && chat.runtimeId) {
      setJumping(undefined);
      onJumpMissed?.();
    }
  });

  // A new side question shows at the bottom, so asking one goes there as sending a message does.
  const sideSeen = useRef(new Set(chat.sideQuestions?.map((q) => q.id)));
  useLayoutEffect(() => {
    const qs = chat.sideQuestions ?? [];
    if (qs.some((q) => !sideSeen.current.has(q.id))) stickToBottom.current = true;
    sideSeen.current = new Set(qs.map((q) => q.id));
  }, [chat.sideQuestions]);

  // Follow the stream while the user is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current && !q) el.scrollTop = el.scrollHeight;
  });

  // Resizing the pane rewraps the transcript without a render; one at the bottom stays there.
  const qRef = useRef(q);
  qRef.current = q;
  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current && !qRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const step = (d: number) => {
    if (!count) return;
    setMatchIndex((i) => (Math.min(i, count - 1) + d + count) % count);
    scrollToMatch.current = true;
    stickToBottom.current = false;
  };
  const closeFind = () => {
    setFindOpen(false);
    setLanding(false);
  };

  // Rebuilt only when the chat changes, so a reply streaming in the other pane costs this one little.
  const blocks = useMemo(() => toBlocks(chat.items, chat.sideQuestions), [chat.items, chat.sideQuestions]);
  // Cards ignore clicks for a moment after the transcript changes, since it may have moved them under the pointer.
  const movedAt = useMemo(() => performance.now(), [chat.items, chat.sideQuestions]);
  const last = chat.items[chat.items.length - 1];
  const waiting = chat.items.some(isWaiting);
  // Enter queues while a reply runs, while Hermes isn't connected, and while messages are queued already, so a new one
  // never jumps the queue. The composer's hint says which Enter does.
  const queueing = !compare && !!queueApi && (!!chat.running || status !== "connected" || !!queue?.items.length);

  return (
    <div className="chat" ref={rootRef}>
      <header className="chat-head">
        <div className="chat-title">
          {chat.source !== "app" && <SourceIcon source={chat.source} size={13} />}
          <span>{chat.title}</span>
          {isBotChat(chat) ? (
            <span className="badge" title="Its bot's one continuous chat, opened from the Bots view">
              Bot
            </span>
          ) : (
            chat.settled && <span className="badge">Settled</span>
          )}
          {!isBotChat(chat) && !chat.settled && !chat.archived && snoozedUntil !== undefined && (
            <span className="badge" title={`Snoozed until ${wakeFull(snoozedUntil)}`}>
              Snoozed
            </span>
          )}
          {chat.archived && <span className="badge">Archived</span>}
          {projects?.map((name) => (
            <span key={name} className="badge project-badge" title={`In the project ${name}`}>
              {name}
            </span>
          ))}
        </div>
        <div className="chat-head-end">
          {/* Outside the actions, whose dimming would show through its breakdown. */}
          {onUsage && <ChatUsageButton chat={chat} onRefresh={onUsage} />}
          <div className="chat-head-actions">
            {headActions}
            <button
              className="icon-btn"
              title="Find in chat (Ctrl+F)"
              aria-label="Find in chat"
              aria-keyshortcuts="Control+F"
              onClick={openFind}
            >
              <Search size={16} />
            </button>
            {(onExport || onCopyLink || (onSettle && !chat.archived) || (onArchive && !chat.running) || deleteHere) && (
              <MoreMenu chat={chat} onExport={onExport} onCopyLink={onCopyLink} pin={pin} onSettle={onSettle} onArchive={onArchive} onDelete={deleteHere} />
            )}
          </div>
        </div>
        {findOpen && (
          <div className="find" role="search">
            <input
              ref={findRef}
              autoFocus
              placeholder="Find in chat"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchIndex(0);
                setLanding(false);
                scrollToMatch.current = true;
                stickToBottom.current = false;
              }}
              onKeyDown={(e) => {
                if (composing(e)) return;
                if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  step(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1);
                } else if (e.key === "Escape") closeFind();
              }}
            />
            <span className="find-count" aria-live="polite">
              {query ? `${count ? Math.min(matchIndex, count - 1) + 1 : 0} of ${count}` : ""}
            </span>
            <button className="icon-btn" title="Previous (↑ or Shift+Enter)" disabled={!count} onClick={() => step(-1)}>
              <ChevronUp size={16} />
            </button>
            <button className="icon-btn" title="Next (↓ or Enter)" disabled={!count} onClick={() => step(1)}>
              <ChevronDown size={16} />
            </button>
            <button className="icon-btn" title="Close (Esc)" onClick={closeFind}>
              <X size={16} />
            </button>
          </div>
        )}
      </header>
      {banner && <div className="chat-banner">{banner}</div>}

      <div
        className="transcript"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <JumpContext.Provider value={jumpTo}>
        <div className="transcript-inner">
          {chat.source !== "app" && (
            <div className="imported-note">
              <SourceIcon source={chat.source} /> Imported from {SOURCE_LABEL[chat.source]}.
              {chat.source === "import"
                ? " Its messages are dated as the file had them; a Markdown export has only the time it was exported."
                : chat.settled && " Replying here moves it to Active."}
            </div>
          )}
          {branchedFrom}
          {chat.savedAt !== undefined && (
            <div className="saved-note" role="note">
              {status === "connected" ? <HardDrive size={13} /> : <CloudOff size={13} />}
              <span>
                <b>Saved copy</b> from {savedWhen(chat.savedAt)}.{" "}
                {status === "connected"
                  ? chat.loading
                    ? "Loading the latest from Hermes…"
                    : "It may be out of date."
                  : status === "connecting"
                    ? "Connecting to Hermes, so newer messages may be missing until it loads."
                    : "You're offline, so newer messages may be missing."}
              </span>
            </div>
          )}
          {chat.loading && chat.items.length === 0 && (
            <div className="loading-chat">
              <Spinner /> Loading chat
            </div>
          )}
          {notLoaded && chat.items.every((i) => i.kind === "user" && i.outgoing) && (
            <div className="unloaded-chat">
              <CloudOff size={14} /> This chat isn't saved on this computer. It loads once Hermes is connected.
            </div>
          )}
          {notice}
          {!chat.loading && !notLoaded && blocks.length === 0 && (
            <div className="empty-state">
              <div className="empty-chat">What should Hermes work on?</div>
              <ul className="empty-keys" aria-label="Keyboard shortcuts">
                <li><kbd>Ctrl N</kbd> New chat</li>
                <li><kbd>Ctrl K</kbd> Search chats</li>
                <li><kbd>Alt ↑↓</kbd> Switch chats</li>
                <li><kbd>Ctrl ,</kbd> Settings</li>
              </ul>
            </div>
          )}
          {blocks.map((b) =>
            b.kind === "side" ? (
              <SideQuestionPair key={b.id} question={b.question} onDismiss={onDismissSideQuestion} />
            ) : (
              <BlockView
                key={b.id}
                block={b}
                live={!!chat.running && b === last}
                query={q}
                offline={status !== "connected" || !!chat.loading}
                movedAt={b.kind === "approval" ? movedAt : 0}
                onAnswer={answer}
                listen={b.kind === "assistant" ? listen : undefined}
                canRetry={b.kind === "user" && !!b.outgoing && canRetry}
                onOutgoing={onOutgoing}
                onBranch={branch && (b.kind === "user" || b.kind === "assistant") ? onBranch : undefined}
                branchBlocked={branch && (b.kind === "user" || b.kind === "assistant") ? branch.blocked : undefined}
                onReplay={replay && ((b.kind === "user" && turns.ofUser.has(b.id)) || (b.kind === "assistant" && turns.regenerable.has(b.id))) ? onReplay : undefined}
                replayBlocked={replay && (b.kind === "user" || b.kind === "assistant") ? replay.blocked : undefined}
                versions={turns.anchor.has(b.id) ? variants?.byTurn.get(turns.anchor.get(b.id)!) : undefined}
                chatId={chat.id}
                turn={turns.anchor.get(b.id)}
                onPickVariant={onPickVariant}
              />
            ),
          )}
          {/* A reply waiting on the owner isn't thinking, and streamed thinking shows its own row. */}
          {chat.running && last?.kind !== "assistant" && last?.kind !== "thinking" && !(last && isWaiting(last)) && (
            <div className="msg assistant thinking">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
        </JumpContext.Provider>
      </div>

      <SubagentsPanel
        tree={chat.subagents}
        api={subagents}
        approvalWaiting={waiting}
        show={showSubagent}
        onGoToApproval={() => {
          const id = chat.items.find(isWaiting)?.id;
          const card = id && rootRef.current?.querySelector<HTMLElement>(`.approval[data-item="${CSS.escape(id)}"]`);
          if (!card) return;
          card.scrollIntoView({ block: "center" });
          card.focus();
        }}
      />
      {queueApi && <QueuePanel chat={chat} queue={queue} status={status} api={queueApi} />}
      {chat.source === "import" ? (
        // ADR 0031: an imported transcript is a record, not a session Hermes can carry on as it was.
        <div className="composer-wrap read-only-note" role="note">
          <FileInput size={14} aria-hidden /> This is an imported transcript, so it's read-only here. Hermes has its words, not
          everything the original chat had, so it can't carry on from it. Start a new chat to continue.
        </div>
      ) : (
      <Composer
        offline={status !== "connected"}
        queueing={queueing}
        onQueue={compare ? undefined : queueApi?.add}
        running={!!chat.running}
        stopping={!!chat.stopping}
        note={STATUS_NOTE[status]}
        hint={waiting ? "Hermes is waiting for your approval above." : undefined}
        alsoPostsIn={alsoPostsIn}
        text={draft}
        onText={onDraft}
        onStep={onDraftStep}
        onAttach={onAttach}
        onSend={(...send) => {
          stickToBottom.current = true;
          onSend(...send);
        }}
        onStop={onStop}
        modelControls={modelControls}
        autoFocus={active}
        dropHere={(x, y) => {
          if (!visible) return false;
          if (!split) return true;
          const r = rootRef.current?.getBoundingClientRect();
          return !!r && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
        }}
        dropZone={rootRef}
        voice={voice}
        voiceSetup={voiceSetup}
        conversation={conversation}
        started={!!voiceSend}
        status={status}
        screenshots={screenshots}
        screenshotKeys={screenshotKeys}
        commands={commands}
        followUp={compare ? undefined : followUp}
        compare={compare}
      />
      )}
      <ShowInChatContext.Provider value={showInChat}>{footer}</ShowInChatContext.Provider>
    </div>
  );
}

/** One of two compared panes (ADR 0101). `refuse`: why a send can't go to both chats now; it says nothing was sent. */
export type Comparing = { refuse?: string; onStop: () => void };

/** Read aloud for a reply: the chat's speaker, and why it can't be used now. */
type Listen = { speaker: Speaker; blocked?: string };
type OutgoingAction = "retry" | "edit" | "dismiss";

/**
 * One block of the transcript. Memoized, so a streamed delta re-renders only the block it changes. `live`: the reply
 * or thinking is still streaming. `offline` and `movedAt` are for an Approval card; other blocks get `movedAt` 0, so
 * the transcript changing doesn't re-render them. `canRetry` and `onOutgoing` are for a message Hermes didn't take, or
 * may not have; other blocks get `canRetry` false.
 */
const BlockView = memo(
  function BlockView({
    block,
    live,
    query,
    offline,
    movedAt,
    onAnswer,
    listen,
    canRetry,
    onOutgoing,
    onBranch,
    branchBlocked,
    onReplay,
    replayBlocked,
    versions,
    chatId,
    turn,
    onPickVariant,
  }: {
    block: Block;
    live: boolean;
    query: string;
    offline: boolean;
    movedAt: number;
    onAnswer: (approvalId: string, choice: ApprovalChoice, confirmed?: boolean) => void;
    listen?: Listen;
    canRetry: boolean;
    onOutgoing: (itemId: string, action: OutgoingAction) => void;
    onBranch?: (itemId: string) => void;
    branchBlocked?: string;
    onReplay?: (itemId: string, kind: ReplayKind) => void;
    replayBlocked?: string;
    versions?: Variant[];
    chatId: string;
    turn?: number;
    onPickVariant: (chatId: string, turn: number) => void;
  }) {
    const current = versions ? versions.findIndex((v) => v.chatId === chatId) : -1;
    const nav = versions && current >= 0 && turn !== undefined && (
      <VariantNav versions={versions} current={current} onPick={(id) => onPickVariant(id, turn)} />
    );
    if (block.kind === "user")
      return (
        <div className={`msg user${block.outgoing ? ` outgoing ${block.outgoing.state}` : ""}${block.steer ? " steer" : ""}`} data-item={block.id} data-at={block.at}>
          {block.steer && (
            <div className="steer-tag" title="This went into the running reply, as /steer does, rather than as a new message.">
              <CornerDownRight size={12} aria-hidden /> Steered into the reply
            </div>
          )}
          {block.attachments && (
            <div className="msg-files">
              {block.attachments.map((name, i) => (
                <span key={i} className="chip">
                  <Paperclip size={12} />
                  <span className="chip-name">{name}</span>
                </span>
              ))}
            </div>
          )}
          {block.text && <div className="bubble-text">{highlight(block.text, query)}</div>}
          <StoredTime at={block.at} />
          {isOutgoing(block) && block.outgoing.state !== "sending" && (
            <SendFailed item={block} canRetry={canRetry} act={(action) => onOutgoing(block.id, action)} />
          )}
          {!block.outgoing && block.text.trim() && (
            <div className="msg-actions">
              <CopyButton words={() => block.text} what="message" />
              {onReplay && <EditButton blocked={replayBlocked} onEdit={() => onReplay(block.id, "edit")} />}
              {onBranch && <BranchButton blocked={branchBlocked} onBranch={() => onBranch(block.id)} />}
            </div>
          )}
          {nav}
        </div>
      );
    if (block.kind === "assistant")
      return (
        <div className="msg assistant" data-item={block.id} data-at={block.at}>
          <Markdown text={block.text} query={query} streaming={live} />
          {live && <span className="cursor" />}
          {block.interrupted && <div className="stopped">Stopped</div>}
          {!live && block.text.trim() && (
            <div className="msg-actions-row">
              {listen && <ListenButton speaker={listen.speaker} itemId={block.id} text={block.text} blocked={listen.blocked} />}
              <div className="msg-actions">
                <CopyButton words={() => replyMarkdown(block.text)} what="reply" />
                {onReplay && <RegenerateButton blocked={replayBlocked} onRegenerate={() => onReplay(block.id, "regenerate")} />}
                {onBranch && <BranchButton blocked={branchBlocked} onBranch={() => onBranch(block.id)} />}
              </div>
            </div>
          )}
          {!live && nav}
          <StoredTime at={block.at} />
          {block.usage && !live && <ReplyUsageLine usage={block.usage} />}
        </div>
      );
    if (block.kind === "error")
      return (
        <div className="msg error" role="alert" data-item={block.id}>
          {block.text}
          {block.usage && <ReplyUsageLine usage={block.usage} />}
        </div>
      );
    if (block.kind === "thinking") return <Thought item={block} live={live} query={query} />;
    if (block.kind === "approval")
      return <ApprovalCard item={block} offline={offline} movedAt={movedAt} onAnswer={(c, confirmed) => onAnswer(block.id, c, confirmed)} />;
    return <ToolGroup tools={block.tools} />;
  },
  (a, b) =>
    sameBlock(a.block, b.block) &&
    a.live === b.live &&
    a.query === b.query &&
    a.offline === b.offline &&
    a.movedAt === b.movedAt &&
    a.onAnswer === b.onAnswer &&
    a.listen?.speaker === b.listen?.speaker &&
    a.listen?.blocked === b.listen?.blocked &&
    a.canRetry === b.canRetry &&
    a.onOutgoing === b.onOutgoing &&
    a.onBranch === b.onBranch &&
    a.branchBlocked === b.branchBlocked &&
    a.onReplay === b.onReplay &&
    a.replayBlocked === b.replayBlocked &&
    a.versions === b.versions &&
    a.chatId === b.chatId &&
    a.turn === b.turn &&
    a.onPickVariant === b.onPickVariant,
);

/**
 * Under a message Hermes didn't take, or may not have: why, and Retry, which sends the same words and files again as a
 * new message. One Hermes may have says so, since sending it again could run it twice; reading the chat's history back
 * once Hermes is connected settles it. Edit takes its words back into the composer, and is left out for a message with
 * files, which the composer can't take back.
 */
/** A reason as a sentence: Hermes's own come as lowercase fragments, like "session busy". */
const sentence = (text = "") => (text ? `${text[0].toUpperCase()}${text.slice(1)}${/[.!?)]$/.test(text) ? "" : "."}` : "");

function SendFailed({ item, canRetry, act }: { item: OutgoingItem; canRetry: boolean; act: (action: OutgoingAction) => void }) {
  const unknown = item.outgoing.state === "unknown";
  return (
    <div className={`send-failed ${item.outgoing.state}`} role="alert">
      <div className="send-failed-why">
        <CircleAlert size={13} />
        <span>
          {unknown ? "Hermes may already have this message. " : "Not sent. "}
          {sentence(item.outgoing.reason)}
          {unknown && " It's checked against the chat's history once Hermes is connected."}
        </span>
      </div>
      <div className="send-failed-actions">
        <button className="btn" onClick={() => act("dismiss")}>
          Dismiss
        </button>
        {!item.outgoing.attachments?.length && (
          <button className="btn" onClick={() => act("edit")}>
            Edit
          </button>
        )}
        <button className="btn primary" onClick={() => act("retry")} disabled={!canRetry} title={unknown ? "Send it again: Hermes may run it twice" : "Send it again"}>
          <RotateCcw size={13} /> Retry
        </button>
      </div>
    </div>
  );
}

/**
 * The model's reasoning, folded to one line. `live`: it is still streaming, so the line shows its latest words.
 */
function Thought({ item, live, query }: { item: ThinkingItem; live: boolean; query: string }) {
  const [open, setOpen] = useState(false);
  const latest = item.text.trimEnd().split("\n").pop();
  return (
    <div className="tools" data-item={item.id}>
      <button className="tool-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {live ? <Spinner /> : <Brain size={13} />}
        <span className="thought-label">{live ? "Thinking" : "Thought"}</span>
        <span className="tool-preview thought-preview">{live && !open ? latest : ""}</span>
        <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />
      </button>
      {open && <div className="thought-body">{highlight(item.text, query)}</div>}
    </div>
  );
}

function ToolRow({ t }: { t: ToolItem }) {
  const [open, setOpen] = useState(false);
  const jump = useContext(JumpContext);
  useEffect(() => {
    if (jump?.callId && t.callId === jump.callId) setOpen(true);
  }, [jump?.at]);
  const summary = t.status === "stopped" ? "stopped" : t.summary;
  return (
    <div className={`tool ${open ? "open" : ""}`} data-call={t.callId} tabIndex={t.callId ? -1 : undefined}>
      <button className="tool-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {t.status === "running" ? <Spinner /> : <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />}
        <span className="tool-name">{t.name}</span>
        <span className="tool-preview">{t.preview && withoutBidi(t.preview)}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        {t.durationS != null && <span className="tool-dur">{t.durationS}s</span>}
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-label">Arguments</div>
          <pre>{withoutBidi(JSON.stringify(t.args ?? {}, null, 2))}</pre>
          {/* Stored history keeps no result for most tools. */}
          {(t.status === "running" || t.result !== undefined) && (
            <>
              <div className="tool-label">Result</div>
              <pre>{t.status === "running" ? "…" : t.result ? withoutBidi(t.result) : "(empty)"}</pre>
            </>
          )}
          <ToolPreviews t={t} />
        </div>
      )}
    </div>
  );
}

/**
 * What an opened tool call can show in the preview pane: the files and pages it names, which are on the Hermes server
 * since that is where tools run, and its output.
 */
function ToolPreviews({ t }: { t: ToolItem }) {
  const open = useOpenPreview();
  const menu = useLinkMenu();
  if (!open) return null;
  const targets = toolTargets(t, location.origin);
  const output = t.status !== "running" && t.result ? t.result : undefined;
  if (!targets.length && !output) return null;
  return (
    <div className="tool-previews">
      <span className="tool-label">Preview</span>
      {targets.map((x) => {
        const link = x.kind === "web" ? linkTarget(x.url, location.origin) : undefined;
        return (
          <button
            key={x.kind === "server" ? `s:${x.path}` : x.kind === "web" ? `w:${x.url}` : x.kind}
            className="preview-chip"
            title={x.kind === "server" ? `${withoutBidi(x.path)}\nOn the Hermes server` : x.kind === "web" ? x.url : undefined}
            onClick={() => open(x)}
            onContextMenu={menu && link && ((e) => menu(e, link))}
          >
            {x.kind === "server" ? <Server size={12} /> : <Globe size={12} />}
            <span>{withoutBidi(previewName(x))}</span>
          </button>
        );
      })}
      {output && (
        <button className="preview-chip" title="What the tool call returned" onClick={() => open({ kind: "tool", name: t.name, text: output })}>
          <Wrench size={12} />
          <span>Output</span>
        </button>
      )}
    </div>
  );
}

function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const jump = useContext(JumpContext);
  useEffect(() => {
    if (jump?.callId && tools.some((t) => t.callId === jump.callId)) setOpen(true);
  }, [jump?.at]);
  if (tools.length === 1)
    return (
      <div className="tools">
        <ToolRow t={tools[0]} />
      </div>
    );
  const running = tools.find((t) => t.status === "running");
  const names = [...new Set(tools.map((t) => t.name))].join(", ");
  return (
    <div className="tools" data-calls={tools.flatMap((t) => t.callId ?? []).join(" ") || undefined} tabIndex={-1}>
      <button className="tool-line group" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {running ? <Spinner /> : <Wrench size={13} />}
        <span className="tool-name">{tools.length} tool calls</span>
        <span className="tool-preview">{running ? withoutBidi(`${running.name} · ${running.preview ?? ""}`) : names}</span>
        <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="tool-group-body">
          {tools.map((t) => (
            <ToolRow key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({
  offline,
  queueing = false,
  onQueue,
  running,
  stopping,
  note,
  hint,
  alsoPostsIn,
  text,
  onText,
  onStep,
  onAttach,
  onSend,
  onStop,
  modelControls,
  autoFocus = true,
  dropHere,
  dropZone,
  voice,
  voiceSetup,
  conversation,
  started = false,
  status,
  screenshots,
  screenshotKeys,
  commands,
  followUp,
  compare,
}: {
  offline: boolean;
  /** Enter, and the Queue button, add the message to the chat's queue (`onQueue`, which says why it couldn't). */
  queueing?: boolean;
  onQueue?: (text: string, attachments: Attachment[]) => string | undefined;
  running: boolean;
  stopping: boolean;
  note?: string;
  hint?: string;
  alsoPostsIn?: Source;
  /** `onSend` empties it. */
  text: string;
  onText: (text: string, how?: EditKind) => void;
  onStep: (step: EditStep) => string | undefined;
  onAttach: (paths: string[]) => Promise<AttachCheck>;
  onSend: (text: string, attachments: Attachment[], skill?: SkillCall) => void;
  onStop: () => void;
  modelControls?: ReactNode;
  autoFocus?: boolean;
  /** Whether a drop at this point of the window, in CSS pixels, is for this composer. Left out, every drop is. */
  dropHere?: (x: number, y: number) => boolean;
  /** Where an HTML5 file drop attaches here: the pane. */
  dropZone: RefObject<HTMLElement | null>;
  voice?: VoiceApi;
  voiceSetup?: VoiceSetup;
  /** The pane's Voice conversation, and whether the chat has started, which one needs. */
  conversation?: VoiceConversation;
  started?: boolean;
  status: ConnectionStatus;
  /** Screenshots come from here, and staged ones go back to it to be deleted once sent, removed or left behind. */
  screenshots?: ScreenshotDesk;
  screenshotKeys?: string;
  commands?: CommandHost;
  /** While a reply runs, Enter queues or steers by its `mode`, and Ctrl+Enter does the other. */
  followUp?: FollowUpHost;
  compare?: Comparing;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // What an update's restart would drop, for Settings to name (unsaved.ts).
  const me = useRef({}).current;
  useEffect(() => stagedFiles.set(me, attachments), [attachments]);
  useEffect(() => () => stagedFiles.set(me, []), []);
  const focused = useRef(autoFocus);
  focused.current = autoFocus;
  // The transcript joins the text as it is when it arrives, typed meanwhile included.
  const textRef = useRef(text);
  textRef.current = text;
  // Focus goes back to the text once a recording is done with, whichever way, since the controls it was on are gone.
  const wasDictating = useRef(false);
  // Where speech-to-text runs: with this computer in the route, Dictation works without Hermes (ADR 0065).
  const sttPrefs = useSyncExternalStore(sttRoute.subscribe, sttRoute.get);
  const dictation = useDictation(voice?.transcribe, (heard) => {
    if (!focused.current) return;
    const next = withTranscript(textRef.current, heard);
    onText(next);
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      // After React has put the new text in.
      requestAnimationFrame(() => ta.setSelectionRange(next.length, next.length));
    }
  });
  const [refused, setRefused] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const talk = useSyncExternalStore(conversation?.subscribe ?? noDesk, conversation?.getSnapshot ?? (() => NOT_TALKING));
  const talking = talk.phase !== "off";
  const startTalkRef = useRef<HTMLButtonElement>(null);
  // Why the conversation couldn't start, after a click on the Start button while it can't.
  const [talkBlocked, setTalkBlocked] = useState<string>();
  const previews = useRef<Previews>(null);
  const [, previewed] = useReducer((n: number) => n + 1, 0);

  // Thumbnails follow the staged list, so removing, sending or replacing an image releases its preview.
  useEffect(() => {
    const p = new Previews(readPreview, previewed);
    previews.current = p;
    return () => p.dispose();
  }, []);
  useEffect(() => previews.current?.sync(attachments), [attachments]);
  useEffect(() => {
    if (wasDictating.current && !dictation.active && autoFocus) taRef.current?.focus();
    wasDictating.current = dictation.active;
  }, [dictation.active]);
  // Leaving a pane (including Settings or the narrow switcher) releases its microphone and drops late transcripts.
  useEffect(() => { if (!autoFocus) dictation.cancel(); }, [autoFocus]);
  // So does hiding the window to the tray: the microphone never stays open behind a hidden window (ADR 0034). The
  // recording is dropped, as Cancel drops it; nothing is sent to Hermes to transcribe.
  const windowHidden = useWindowHidden();
  useEffect(() => { if (windowHidden) dictation.cancel(); }, [windowHidden]);

  // Files still being read, saved or checked: sending waits for them, so none misses the message it was added for.
  const [attaching, setAttaching] = useState(0);
  const busy = async <T,>(work: () => Promise<T>): Promise<T> => {
    setAttaching((n) => n + 1);
    try {
      return await work();
    } finally {
      setAttaching((n) => n - 1);
    }
  };

  const add = (paths: string[], stillHere = () => true) => busy(async () => {
    if (!paths.length) return [];
    try {
      const got = await onAttach(paths);
      if (!stillHere()) return [];
      setAttachments((cur) => [...cur, ...got.attachments.filter((a) => !cur.some((x) => x.path === a.path))]);
      setRefused(got.refused);
      return got.attachments.map((a) => a.path);
    } catch (e) {
      if (!stillHere()) return [];
      setRefused([`Couldn't attach files: ${e instanceof Error ? e.message : String(e)}`]);
      return [];
    }
  });
  const addRef = useRef(add);
  addRef.current = add;
  const dropHereRef = useRef(dropHere);
  dropHereRef.current = dropHere;

  // Screenshots attach here while this composer is on screen. Any still staged when it goes (another chat opened,
  // signing out) are deleted: attachments aren't kept in a Draft.
  const shot = useSyncExternalStore(screenshots?.subscribe ?? noDesk, screenshots?.getSnapshot ?? (() => NOT_CAPTURING));
  // A new screenshot replaces the notes about the last thing attached.
  useEffect(() => {
    if (shot.capturing) setRefused([]);
  }, [shot.capturing]);
  const staged = useRef(attachments);
  staged.current = attachments;
  useEffect(() => {
    if (!screenshots || !autoFocus) return;
    let current = true;
    const stop = screenshots.attachTo({
      attach: (paths) => addRef.current(paths, () => current),
      detach: (paths) => setAttachments((cur) => cur.filter((a) => !paths.includes(a.path))),
      restore: (back) => setAttachments((cur) => [...cur, ...back.filter((a) => !cur.some((x) => x.path === a.path))]),
      note: (text) => setRefused((cur) => [...cur, text]),
    });
    return () => {
      current = false;
      stop();
    };
  }, [screenshots, autoFocus]);
  // Focus changes only transfer capture routing. A pane retains its staged attachments until its composer leaves.
  useEffect(() => () => screenshots?.release(staged.current.map((a) => a.path)), [screenshots]);

  // Tauri's native drop event (off on Windows, below): it gives real file paths, so Rust can read the bytes. Every composer
  // hears every drop; with two panes, the one under the pointer takes it. Tauri gives the point in physical pixels.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      const here = (p: { x: number; y: number }) => {
        const scale = window.devicePixelRatio || 1;
        return dropHereRef.current?.(p.x / scale, p.y / scale) ?? true;
      };
      if (payload.type === "enter" || payload.type === "over") setDragging(here(payload.position));
      else {
        setDragging(false);
        if (payload.type === "drop" && here(payload.position)) void addRef.current(payload.paths);
      }
    });
    return () => void unlisten.then((stop) => stop());
  }, []);

  // A pasted file, or one dropped on Windows, has no path of its own: Rust saves its bytes to a temp file, which then
  // attaches like a drop. One too big for Hermes is refused before its bytes are read into the webview.
  const stageFiles = (incoming: File[] | Promise<File[]>, nameOf = pastedName) => busy(async () => {
    try {
      const files = await incoming;
      const tooBig = files.filter((f) => f.size > LIMITS.file.bytes);
      const paths = await Promise.all(
        files
          .filter((f) => !tooBig.includes(f))
          .map(async (f) =>
            invoke<string>("stage_clipboard_file", await f.arrayBuffer(), { headers: { "x-name": encodeURIComponent(nameOf(f)) } }),
          ),
      );
      await add(paths);
      const notes = tooBig.map((f) => overLimitNote(nameOf(f), f.size, LIMITS.file));
      if (notes.length) setRefused((cur) => (paths.length ? [...cur, ...notes] : notes));
    } catch (e) {
      setRefused([`Couldn't attach the files: ${e instanceof Error ? e.message : String(e)}`]);
    }
  });
  const stageRef = useRef(stageFiles);
  stageRef.current = stageFiles;

  // On Windows the native drop handler is off (tauri.windows.conf.json), because there it takes every drag and a chat
  // dragged onto a tab strip never reached the page. Files dropped there come as HTML5 drops, with bytes but no path.
  // WebKitGTK gives an HTML5 drop from another app no files, so Linux keeps the native event above.
  useEffect(() => {
    const zone = dropZone.current;
    if (!zone) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
      setDragging(true);
    };
    const leave = (e: DragEvent) => hasFiles(e) && !zone.contains(e.relatedTarget as Node) && setDragging(false);
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      // A dropped file keeps its own name; only a paste's generic `image.png` is a screenshot to rename.
      void stageRef.current(Array.from(e.dataTransfer!.files), (f) => f.name);
    };
    zone.addEventListener("dragenter", over);
    zone.addEventListener("dragover", over);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("drop", drop);
    return () => {
      zone.removeEventListener("dragenter", over);
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("drop", drop);
    };
  }, [dropZone]);

  const pick = async () => {
    try {
      const paths = await openFileDialog({ multiple: true, directory: false });
      if (paths) await add(paths);
    } catch (e) {
      setRefused([`Couldn't open the file picker: ${e instanceof Error ? e.message : String(e)}`]);
    }
  };

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  }, [text]);

  const sendable = attaching === 0 && (!!text.trim() || attachments.length > 0);
  const slash = useSlashCommands(commands, text, onText, taRef);
  const caretTo = useRef<{ text: string; at: number }>(undefined);
  useLayoutEffect(() => {
    const to = caretTo.current;
    if (!to || to.text !== text) return;
    caretTo.current = undefined;
    taRef.current?.setSelectionRange(to.at, to.at);
  }, [text]);
  const step = (which: EditStep) => {
    const before = textRef.current;
    const after = onStep(which);
    if (after !== undefined) caretTo.current = { text: after, at: caretAfter(before, after) };
  };
  // Undo and Redo from WebView2's context menu (Windows) would step the webview's history: ours runs instead.
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const onBefore = (e: InputEvent) => {
      if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
      e.preventDefault();
      stepRef.current(e.inputType === "historyUndo" ? "undo" : "redo");
    };
    ta.addEventListener("beforeinput", onBefore);
    return () => ta.removeEventListener("beforeinput", onBefore);
  }, []);
  // While a reply runs a message can steer it instead of waiting in the queue. Why it can't now, if it can't: the
  // chat's (no /steer here, still loading), or the message's own (files). Offline, everything queues without a word.
  const [steering, setSteering] = useState(false);
  const canFollow = !!followUp && !!onQueue && running && !offline;
  const steerWhy = canFollow ? (followUp.why() ?? (attachments.length ? FILES_CANT_STEER : undefined)) : undefined;
  const enterSteers = canFollow && followUp.mode === "steer" && !steerWhy;
  const ctrlSteers = canFollow && followUp.mode === "queue" && !steerWhy;
  const steer = async (words: string) => {
    setSteering(true);
    setRefused([]);
    try {
      const out = await followUp!.steer(words);
      if (out) setRefused([out]);
    } catch (e) {
      setRefused([`Couldn't steer the reply, so nothing was sent: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setSteering(false);
    }
  };
  /** `other`: Ctrl+Enter, which does the other of queue and steer while a reply runs. */
  const send = (other = false) => {
    if (slash.run()) return;
    if (!sendable || steering) return;
    if (compare?.refuse) return setRefused([compare.refuse]);
    const skill = slash.skill;
    if (skill) {
      // Hermes builds a skill's message for the chat's session when it goes, so it can't wait in the queue or steer a
      // running reply, and the files' words would land around the skill's own text.
      if (skill.problem) return setRefused([skill.problem]);
      if (attachments.length) return setRefused(["Files can't go with a message that runs a skill. Send them in a message of their own."]);
      if (queueing && onQueue) return setRefused(["A message that runs a skill can't be queued. Send it while connected, with no reply running and nothing queued."]);
      if (offline || running) return;
      onSend(text.trim(), attachments, skill.call);
      setRefused([]);
      return;
    }
    // A message that would steer and can't is queued, saying why: the chat's reason once, files every time.
    let fellBack: string | undefined;
    if (canFollow && (followUp.mode === "steer") !== other) {
      if (!steerWhy) return void steer(text.trim());
      if (steerWhy === FILES_CANT_STEER) fellBack = `Your message is queued, not steered. ${steerWhy}`;
      else if (!toldWhy.has(steerWhy)) {
        toldWhy.add(steerWhy);
        fellBack = `Your message is queued, not steered. /steer can't run: ${steerWhy}`;
      }
    }
    if (queueing && onQueue) {
      const why = onQueue(text.trim(), attachments);
      if (why) return setRefused([why]);
    } else {
      if (offline || running) return;
      onSend(text.trim(), attachments);
    }
    setAttachments([]);
    setRefused(fellBack ? [fellBack] : []);
  };
  // What Enter, and the button beside the text, do now; Ctrl+Enter does the other while a reply runs.
  const enterDoes = enterSteers ? "steer" : queueing ? "queue" : "send";
  // With the Ctrl+Enter hint there is no room for Shift+Enter's, which never changes.
  const keysHint = `Enter to ${enterDoes} · ${enterSteers ? "Ctrl+Enter to queue" : ctrlSteers ? "Ctrl+Enter to steer" : "Shift+Enter for a new line"}`;

  return (
    <div
      className="composer-wrap"
      onKeyDown={(e) => {
        if (e.key === "Escape" && dictation.active && !composing(e)) {
          e.preventDefault();
          dictation.cancel();
        }
      }}
    >
      {note && <div className="offline-note">{note}</div>}
      {!note && hint && <div className="composer-hint">{hint}</div>}
      {alsoPostsIn && (
        <div className="platform-note">
          <SourceIcon source={alsoPostsIn} /> Hermes also posts its replies in this {SOURCE_LABEL[alsoPostsIn]} chat.
        </div>
      )}
      {compare && (
        <div className="compare-note" role="note">
          <Columns2 size={13} aria-hidden /> Comparing: each message goes to both panes.
          <button className="link-btn" onClick={compare.onStop}>
            Stop comparing
          </button>
        </div>
      )}
      <DictationNoteView dictation={dictation} />
      {talkBlocked && !talking && (
        <div className="voice-note" role="alert">
          <span>{talkBlocked}</span>
          <button className="link-btn" onClick={() => setTalkBlocked(undefined)}>
            Dismiss
          </button>
        </div>
      )}
      {conversation && talking && (
        <ConversationPanel
          conversation={conversation}
          setup={voiceSetup}
          onSettings={voice?.openSettings}
          onEnd={() => {
            conversation.end();
            // Back to the button that started it, once it is shown again.
            requestAnimationFrame(() => (startTalkRef.current ?? taRef.current)?.focus());
          }}
        />
      )}
      {shot.capturing && (
        <div className="capture-note" role="status">
          Taking a screenshot: select a region or window, or press Esc to cancel.
        </div>
      )}
      {refused.map((r, i) => (
        <div key={i} className="attach-note" role="alert">
          {r}
        </div>
      ))}
      {slash.view}
      <div className={`composer ${dragging ? "dragging" : ""}`}>
        {dragging && <div className="drop-overlay">Drop files to attach</div>}
        {attachments.length > 0 && (
          <div className="chips">
            {attachments.map((f) => (
              <AttachmentChip
                key={f.path}
                file={f}
                preview={previews.current?.get(f.path)}
                onRemove={() => {
                  setAttachments((cur) => cur.filter((x) => x.path !== f.path));
                  screenshots?.release([f.path]);
                }}
              />
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          data-composer
          rows={1}
          autoFocus={autoFocus}
          placeholder="Message Hermes"
          value={text}
          {...slash.inputProps}
          onChange={(e) => onText(e.target.value, inputKind(e.nativeEvent))}
          onPaste={(e) => {
            // Only files are taken over; text pastes as it always has.
            if (dragging) return;
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              void stageFiles(files);
            } else if (!e.clipboardData.getData("text/plain")) void stageFiles(clipboardImages());
          }}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return;
            const edit = editStep(e);
            // Even with nothing to step, so the webview's own history never runs on this text.
            if (edit && !composing(e)) {
              e.preventDefault();
              step(edit);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
              e.preventDefault();
              // Enter queues or steers only while the hint below says so; Dictation hides it.
              if (!(queueing && dictation.active)) send(e.ctrlKey || e.metaKey);
            }
          }}
        />
        <div className="composer-bar">
          <button className="icon-btn" title="Attach files" onClick={() => void pick()}>
            <Paperclip size={16} />
          </button>
          {voice && !dictation.active && !talking && <MicButton dictation={dictation} blocked={micBlocked(status, voiceSetup, sttPrefs)} />}
          {conversation && !dictation.active && !talking && (
            <StartConversationButton
              ref={startTalkRef}
              blocked={startBlocked(status, voiceSetup, started, dictation.active, sttPrefs)}
              onBlocked={setTalkBlocked}
              onStart={() => {
                setTalkBlocked(undefined);
                conversation.start(turnSettings(voiceSetup));
              }}
            />
          )}
          {screenshots && (
            <button
              className="icon-btn"
              title={screenshotKeys ? `Attach a screenshot (${screenshotKeys})` : "Attach a screenshot"}
              aria-label="Attach a screenshot"
              disabled={shot.capturing}
              onClick={() => void screenshots.capture()}
            >
              <Camera size={16} />
            </button>
          )}
          {modelControls}
          {!dictation.active && (
            <span className="composer-keys" title={steerWhy && `Can't steer now: ${steerWhy}`}>
              {keysHint}
            </span>
          )}
          {enterSteers ? (
            <button
              className="send queue-btn"
              title="Steer: add to the running reply without stopping it (Enter)"
              aria-label="Steer"
              disabled={!sendable || steering}
              onClick={() => send()}
            >
              {steering ? <Spinner /> : <CornerDownRight size={16} />}
            </button>
          ) : (
            queueing &&
            onQueue && (
              <button className="send queue-btn" title="Queue: send after the reply (Enter)" aria-label="Queue" disabled={!sendable || steering} onClick={() => send()}>
                <ListPlus size={16} />
              </button>
            )
          )}
          {running ? (
            <button className="send stop" title={stopping ? "Stopping" : "Stop"} disabled={offline || stopping} onClick={onStop}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            !(queueing && onQueue) && (
              <button className="send" title="Send" disabled={offline || !sendable} onClick={() => send()}>
                <ArrowUp size={16} />
              </button>
            )
          )}
        </div>
        {dictation.active && <DictationStrip dictation={dictation} />}
      </div>
    </div>
  );
}

const NOT_TALKING: ConversationState = { phase: "off", muted: false, hearing: false, playing: false, heard: [], devices: [] };
