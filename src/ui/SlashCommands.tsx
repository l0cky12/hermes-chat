// The composer's slash commands (commands.ts, ADR 0015): the menu that opens as a "/" starts the message, the command
// help, the question before a destructive command, and what a command answers. The same menu offers the profile's
// skills after the commands, and a "$" anywhere in the message opens it with skills alone (skillCommands.ts). An "@"
// opens it with the profile's other chats, to reference one (chatReferences.ts).
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Link2, X } from "lucide-react";
import { COMMANDS, argProblem, completion, matchCommands, menuQuery, typedCommand, type CommandDef } from "../hermes/commands";
import { dollarQuery, matchSkills, skillRun, type SkillCommand, type SkillCommands, type SkillRun } from "../hermes/skillCommands";
import { atQuery, matchChats, type ReferableChat } from "../hermes/chatReferences";
import { Spinner, composing } from "./bits";
import { errorText } from "../hermes/values";
import type { OfferedCommand } from "../hermes/extensions";

/**
 * What runs the commands for one composer. `why`: why a command can't run now, or undefined when it can. `run` resolves
 * with text to show under the composer, if any, and rejects saying why the command didn't run. It empties the Draft
 * only once the command has run, and only while `still()` says the composer that ran it is still on its chat, so a
 * command that fails or answers late leaves the words typed.
 */
export type CommandHost = {
  why(def: CommandDef): string | undefined;
  /** Opens the compatibility guide at Hermes's commands; set only while Hermes is known to lack them. */
  guide?: () => void;
  run(def: CommandDef, arg: string, still: () => boolean): Promise<string | undefined>;
  /** The skills offered here, or undefined while unknown or when this Hermes can't run them from the composer. */
  skills?: SkillCommands;
  /** Reads the skills again if they may have changed; called as a menu opens. */
  refreshSkills?: () => void;
  /** The installed extensions' commands offered here (ADR 0126, section 5), after the commands and the skills. */
  extensions?: ExtensionCommands;
  /** The chats an "@" can reference here, and adding one to the message. Picking one never sends. */
  references?: { chats: readonly ReferableChat[]; reference(chat: ReferableChat): void };
};

/** `why`: why an extension's command can't run here now. `run` resolves with its note, as `CommandHost.run` does. */
export type ExtensionCommands = {
  offered: readonly OfferedCommand[];
  why(cmd: OfferedCommand): string | undefined;
  run(cmd: OfferedCommand, arg: string, still: () => boolean): Promise<string | undefined>;
};

/** The extension command typed: "/" first, then an offered command's name, then whitespace or the end. */
export function typedExtension(text: string, offered: readonly OfferedCommand[]): { cmd: OfferedCommand; arg: string } | undefined {
  const m = /^\/(\S+)([\s\S]*)$/.exec(text);
  const cmd = m ? offered.find((c) => c.name === m[1].toLowerCase()) : undefined;
  return cmd && { cmd, arg: m![2].trim() };
}

const matchExtensions = (q: string, offered: readonly OfferedCommand[]) => [
  ...offered.filter((c) => c.name.startsWith(q)),
  ...offered.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.description.toLowerCase().split(/\W+/).some((w) => w.startsWith(q)))),
];

/** A row of the menu: one of the app's commands, a skill, an extension's command, or a chat to reference. */
type Row = { kind: "command"; def: CommandDef } | { kind: "skill"; skill: SkillCommand } | { kind: "extension"; cmd: OfferedCommand } | { kind: "reference"; chat: ReferableChat };

type Note = { title?: string; text: string; error?: boolean };

const SCOPE = {
  local: { label: "App", title: "An action of Hermes Chat" },
  server: { label: "Hermes", title: "Hermes runs it for this chat" },
};

function Scope({ def }: { def: CommandDef }) {
  return (
    <span className={`cmd-scope ${def.scope}`} title={SCOPE[def.scope].title}>
      {SCOPE[def.scope].label}
    </span>
  );
}

/** What a message that runs skills says under the composer before it goes. */
const runsWith = (run: SkillRun) =>
  run.keys.length === 1 ? `Sends with the ${run.keys[0]} skill: Hermes loads its instructions with the message.` : `Sends with ${run.keys.length} skills: ${run.keys.join(", ")}. Hermes loads their instructions with the message.`;

/**
 * The slash commands of a composer whose text is `text`. `run` runs the text as a command if it is one of the
 * registry's, and says whether it did; any other text is the caller's to send. `skill`: how the text runs skills when
 * sent, if it does (skillCommands.ts). `onKeyDown` takes the keys the menu uses, and says whether it took this one.
 * `view` goes above the composer, and `inputProps` on its text box.
 */
export function useSlashCommands(host: CommandHost | undefined, text: string, onText: (text: string) => void, taRef: RefObject<HTMLTextAreaElement | null>) {
  const listId = useId();
  const [index, setIndex] = useState(0);
  // The text the menu was closed on, by Escape or by picking a command. Typing anything else opens it again.
  const [closedFor, setClosedFor] = useState<string>();
  const [note, setNote] = useState<Note>();
  const [confirm, setConfirm] = useState<{ def: CommandDef; arg: string }>();
  const [help, setHelp] = useState(false);
  const [pending, setPending] = useState<string>();
  // A command's answer that comes after this composer has gone, to another chat or profile, isn't shown.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);

  // Where the caret is, for a "$" typed anywhere. The text box knows while it holds this text; `caret` is where it was
  // last seen, and moving it renders the menu again.
  const [caret, setCaret] = useState<number>();
  const box = taRef.current;
  const before = text.slice(0, box && box.value === text ? box.selectionEnd : Math.min(caret ?? text.length, text.length));
  const skills = host?.skills?.offered ?? [];
  const query = host && closedFor !== text ? menuQuery(text) : undefined;
  const dollar = host && closedFor !== text && query === undefined ? dollarQuery(before) : undefined;
  const at = host?.references && closedFor !== text && query === undefined && !dollar ? atQuery(before) : undefined;
  // The "/" menu: the app's commands, then the skills whose name no command has. The "$" menu: skills alone, and only
  // while one matches, so a price or a shell variable typed in prose opens nothing. The "@" menu likewise, with chats.
  const rows: Row[] =
    query !== undefined
      ? [
          ...matchCommands(query).map((def): Row => ({ kind: "command", def })),
          ...matchSkills(query, skills.filter((s) => !COMMANDS.some((c) => c.name === s.key))).map((skill): Row => ({ kind: "skill", skill })),
          ...matchExtensions(query, host?.extensions?.offered ?? []).map((cmd): Row => ({ kind: "extension", cmd })),
        ]
      : dollar
        ? matchSkills(dollar.query, skills).map((skill): Row => ({ kind: "skill", skill }))
        : at
          ? matchChats(at.query, host!.references!.chats).map((chat): Row => ({ kind: "reference", chat }))
          : [];
  const open = query !== undefined || rows.length > 0;
  const matches = rows;
  const sel = Math.max(0, Math.min(index, matches.length - 1));
  useEffect(() => setIndex(0), [query, dollar?.query, dollar?.start, at?.query, at?.start]);
  // The skills are read again, if they may have changed, as either menu could open.
  const asking = query !== undefined || dollar !== undefined;
  const refresh = host?.refreshSkills;
  useEffect(() => {
    if (asking) refresh?.();
  }, [asking, refresh]);
  // How the text runs skills when sent; a command of the app's runs instead when the text is one.
  const toRun = host?.skills && !typedCommand(text) && !typedExtension(text, host.extensions?.offered ?? []) ? skillRun(text.trim(), host.skills) : undefined;
  // The chosen command stays in view as the arrows move through a list taller than the menu.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${sel}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, sel, listId]);

  const focusText = () => taRef.current?.focus();
  const caretTo = useRef<{ text: string; at: number }>(undefined);
  useLayoutEffect(() => {
    const to = caretTo.current;
    if (!to || to.text !== text) return;
    caretTo.current = undefined;
    taRef.current?.setSelectionRange(to.at, to.at);
  }, [text, taRef]);
  const accept = (row: Row) => {
    let next: string;
    let to: number | undefined;
    if (row.kind === "command") next = completion(row.def);
    else if (row.kind === "extension") next = `/${row.cmd.name} `;
    else if (row.kind === "reference") {
      // The "@title" typed so far goes; the chat goes with the message as a chip above the text instead.
      next = `${text.slice(0, at!.start)}${text.slice(before.length)}`;
      to = at!.start;
      host!.references!.reference(row.chat);
    } else if (!dollar) next = `/${row.skill.key} `;
    else {
      // The "$name" typed so far becomes the skill's, with a space after it unless one is there already.
      const after = text.slice(before.length);
      const name = `$${row.skill.key}`;
      next = `${text.slice(0, dollar.start)}${name}${/^\s/.test(after) ? "" : " "}${after}`;
      to = dollar.start + name.length + 1;
    }
    onText(next);
    setClosedFor(next);
    setCaret(to);
    // A skill put in mid-message leaves the caret after it, once React has put the new text in.
    caretTo.current = to === undefined ? undefined : { text: next, at: to };
    focusText();
  };

  /** Puts an "@" in at the caret, after a space when it would join a word, so the chats menu opens. */
  const startReference = () => {
    const [from, to] = box && box.value === text ? [box.selectionStart, box.selectionEnd] : [before.length, before.length];
    const lead = from > 0 && !/\s/.test(text[from - 1]) ? " " : "";
    const next = `${text.slice(0, from)}${lead}@${text.slice(to)}`;
    const at = from + lead.length + 1;
    onText(next);
    setClosedFor(undefined);
    setCaret(at);
    caretTo.current = { text: next, at };
    focusText();
  };

  const execute = async (name: string, go: (still: () => boolean) => Promise<string | undefined>) => {
    setNote(undefined);
    setPending(name);
    try {
      const out = await go(() => mounted.current);
      if (mounted.current && out) setNote({ title: `/${name}`, text: out });
    } catch (e) {
      if (mounted.current) setNote({ text: `/${name} didn't run: ${errorText(e)}`, error: true });
    } finally {
      if (mounted.current) setPending(undefined);
    }
  };
  const runDef = (def: CommandDef, arg: string) => execute(def.name, (still) => host!.run(def, arg, still));

  const refuse = (name: string, why: string) => setNote({ text: `/${name} can't run: ${why}`, error: true });

  const run = (): boolean => {
    const typed = host && typedCommand(text);
    const ext = host?.extensions && !typed ? typedExtension(text, host.extensions.offered) : undefined;
    if (ext) {
      if (pending) return true;
      const why = host!.extensions!.why(ext.cmd);
      if (why) refuse(ext.cmd.name, why);
      else void execute(ext.cmd.name, (still) => host!.extensions!.run(ext.cmd, ext.arg, still));
      return true;
    }
    if (!typed) return false;
    if (pending) return true;
    const { def, arg } = typed;
    if (def.name === "help") {
      onText("");
      setNote(undefined);
      setHelp(true);
      return true;
    }
    const why = host.why(def) ?? argProblem(def, arg);
    if (why) refuse(def.name, why);
    else if (def.destructive) setConfirm({ def, arg });
    else void runDef(def, arg);
    return true;
  };

  const cancelConfirm = () => {
    setConfirm(undefined);
    focusText();
  };
  const confirmed = () => {
    if (!confirm) return;
    setConfirm(undefined);
    // The chat may have changed while the question was open, say a reply started.
    const why = host?.why(confirm.def);
    if (why) refuse(confirm.def.name, why);
    else void runDef(confirm.def, confirm.arg);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (composing(e)) return false;
    if (e.key === "Escape" && (open || help)) {
      e.preventDefault();
      e.stopPropagation();
      if (open) setClosedFor(text);
      else setHelp(false);
      return true;
    }
    if (!open || !matches.length || e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((sel + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
      return true;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      e.preventDefault();
      accept(matches[sel]);
      return true;
    }
    return false;
  };

  const inputProps = {
    "aria-autocomplete": "list" as const,
    "aria-controls": open && matches.length ? listId : undefined,
    "aria-activedescendant": open && matches.length ? `${listId}-${sel}` : undefined,
    onSelect: (e: { currentTarget: HTMLTextAreaElement }) => setCaret(e.currentTarget.selectionEnd),
    onClick: (e: { currentTarget: HTMLTextAreaElement }) => setCaret(e.currentTarget.selectionEnd),
  };
  const firstSkill = matches.findIndex((r) => r.kind === "skill");

  const view: ReactNode = host && (
    <>
      {help && <CommandHelp host={host} onClose={() => (setHelp(false), focusText())} />}
      {confirm && (
        <div
          className="cmd-confirm"
          role="alertdialog"
          aria-label="Delete this chat?"
          onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), cancelConfirm())}
          onBlur={(e) => e.currentTarget.contains(e.relatedTarget) || setConfirm(undefined)}
        >
          <span>Delete this chat in every Hermes client? This can't be undone.</span>
          <button className="row-confirm danger" title="Delete this chat in every Hermes client. This can't be undone." onClick={confirmed}>
            Delete
          </button>
          <button className="row-confirm" autoFocus onClick={cancelConfirm}>
            Cancel
          </button>
        </div>
      )}
      {pending && (
        <div className="cmd-note pending" role="status">
          <Spinner /> Running /{pending}…
        </div>
      )}
      {note && !pending && (
        <div className={`cmd-note ${note.error ? "error" : ""}`} role={note.error ? "alert" : "status"}>
          <div className="cmd-note-body">
            {note.title && <div className="cmd-note-title">{note.title}</div>}
            {note.title ? <pre className="cmd-output">{note.text}</pre> : note.text}
          </div>
          <button className="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => (setNote(undefined), focusText())}>
            <X size={14} />
          </button>
        </div>
      )}
      {toRun && !open && !pending && (
        <div className={`skill-note ${toRun.problem ? "error" : ""}`} role="status">
          {toRun.problem ?? runsWith(toRun)}
        </div>
      )}
      {open && (
        <div className="cmd-menu">
          {matches.length ? (
            <div role="listbox" id={listId} aria-label={at ? "Chats" : dollar ? "Skills" : "Commands"}>
              {matches.map((row, i) => {
                const why = row.kind === "command" ? host.why(row.def) : row.kind === "extension" ? host.extensions?.why(row.cmd) : undefined;
                const prev = matches[i - 1];
                const newExtension = row.kind === "extension" && (prev?.kind !== "extension" || prev.cmd.id !== row.cmd.id);
                return (
                  <div
                    key={row.kind === "command" ? `c-${row.def.name}` : row.kind === "skill" ? `s-${row.skill.key}` : row.kind === "reference" ? `h-${row.chat.id}` : `e-${row.cmd.name}`}
                    role="presentation"
                  >
                    {i === firstSkill && !dollar && (
                      <div className="cmd-group" aria-hidden="true">
                        Skills
                      </div>
                    )}
                    {newExtension && (
                      <div className="cmd-group" aria-hidden="true">
                        {row.cmd.extension}
                      </div>
                    )}
                    <div
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === sel}
                      className={`cmd-option ${row.kind} ${i === sel ? "sel" : ""} ${why ? "unavailable" : ""}`}
                      // The text box keeps focus, so typing goes on after a click.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => i !== sel && setIndex(i)}
                      onClick={() => accept(row)}
                    >
                      {row.kind === "command" ? (
                        <>
                          <span className="cmd-name">/{row.def.name}</span>
                          {row.def.args && <span className="cmd-args">{row.def.args}</span>}
                          <Scope def={row.def} />
                          <span className="cmd-desc">{row.def.description}</span>
                          {why && <span className="cmd-why">{why}</span>}
                        </>
                      ) : row.kind === "reference" ? (
                        <>
                          <Link2 size={13} aria-hidden />
                          <span className="cmd-desc">{row.chat.title}</span>
                        </>
                      ) : row.kind === "extension" ? (
                        <>
                          <span className="cmd-name">/{row.cmd.name}</span>
                          <span className="cmd-scope extension" title={`An extension's command: ${row.cmd.extension} runs it in its sandbox on this computer. Nothing is sent to Hermes.`}>
                            Extension
                          </span>
                          <span className="cmd-desc">{row.cmd.description}</span>
                          {why && <span className="cmd-why">{why}</span>}
                        </>
                      ) : (
                        <>
                          <span className="cmd-name">
                            {dollar ? "$" : "/"}
                            {row.skill.key}
                          </span>
                          <span className="cmd-scope skill" title="A skill: Hermes loads its instructions with the message">
                            Skill
                          </span>
                          <span className="cmd-desc">{row.skill.description}</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="cmd-empty" role="status">
              No command{skills.length ? " or skill" : ""} is called {text}. Enter sends it as an ordinary message.
            </div>
          )}
          <div className="cmd-keys">
            {at
              ? "↑↓ to choose · Enter or Tab to reference it · Esc to close"
              : dollar
                ? "↑↓ to choose · Enter or Tab to put it in · Esc to close"
                : "↑↓ to choose · Enter or Tab to fill in · Esc to close · /help lists them all"}
          </div>
        </div>
      )}
    </>
  );

  return { run, skill: toRun, onKeyDown, inputProps, view, startReference };
}

/** Every command, with its argument, what it does, where it runs and why it can't run now. */
function CommandHelp({ host, onClose }: { host: CommandHost; onClose: () => void }) {
  const group = (scope: CommandDef["scope"], title: string) => (
    <>
      <h3>{title}</h3>
      <dl>
        {COMMANDS.filter((c) => c.scope === scope).map((def) => {
          const why = host.why(def);
          return (
            <div key={def.name} className={why ? "unavailable" : undefined}>
              <dt>
                <code>/{def.name}</code>
                {def.args && <span className="cmd-args">{def.args}</span>}
              </dt>
              <dd>
                {def.description}
                {why && <span className="cmd-why">{why}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </>
  );
  return (
    <section className="cmd-help" aria-label="Commands" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <div className="cmd-help-head">
        <h2>Commands</h2>
        <button className="icon-btn" aria-label="Close commands" title="Close (Esc)" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <p>
        Type / at the start of a message to pick one. Any other text that starts with /, or words after a command that takes
        none, is sent as an ordinary message.
      </p>
      {!!host.skills?.offered.length && (
        <p>
          The menu also lists this profile's skills that are on. Pick one with / at the start of a message, or type $ and its
          name anywhere in it, as in "fix the build using $debugging". The message then goes with the skill loaded. A command
          wins over a skill of the same name after /; $ still reaches the skill.
        </p>
      )}
      {group("local", "In this app")}
      {group("server", "On Hermes, for this chat")}
      {!!host.extensions?.offered.length && (
        <>
          <h3>From extensions, on this computer</h3>
          <dl>
            {host.extensions.offered.map((cmd) => {
              const why = host.extensions!.why(cmd);
              return (
                <div key={cmd.name} className={why ? "unavailable" : undefined}>
                  <dt>
                    <code>/{cmd.name}</code>
                  </dt>
                  <dd>
                    {cmd.description} ({cmd.extension})
                    {why && <span className="cmd-why">{why}</span>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </>
      )}
      {host.guide && (
        <p className="cmd-why">
          This Hermes server doesn't support Hermes's slash commands; the app's own commands still work.{" "}
          <button className="link-btn" onClick={host.guide} aria-label="Compatibility guide: Hermes's slash commands">
            Compatibility guide
          </button>
        </p>
      )}
    </section>
  );
}
