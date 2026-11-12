// An extension's view in the Preview (ADR 0126, section 6). The app draws the extension's nodes with its own elements:
// text is text, never HTML or Markdown, so a view loads nothing and links nowhere. A button runs one of the extension's
// own commands in the chat the view is for, as the owner's action.
import { useEffect, useRef, useState } from "react";
import type { ExtensionId } from "../hermes/extensionManifest";
import type { Action } from "../hermes/extensions";
import type { ViewNode } from "../hermes/extensionRpc";
import { errorText } from "../hermes/values";
import { Spinner } from "./bits";
import { useExtensions } from "./extensionsContext";

function Node({ node, run, busy }: { node: ViewNode; run: (a: Action) => void; busy: boolean }) {
  switch (node.kind) {
    case "heading":
      return <h3>{node.text}</h3>;
    case "text":
      return <p className="ext-text">{node.text}</p>;
    case "notice":
      return (
        <p className="ext-notice" role="note">
          {node.text}
        </p>
      );
    case "list":
      return (
        <ul>
          {node.items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        <table className="ext-table">
          <thead>
            <tr>
              {node.columns.map((c, i) => (
                <th key={i} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "facts":
      return (
        <dl className="ext-facts">
          {node.facts.map((f, i) => (
            <div key={i}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "button":
      return (
        <button type="button" className="btn" disabled={busy} onClick={() => run({ kind: "command", name: node.command, arg: node.arg })}>
          {node.label}
        </button>
      );
  }
}

/** `reloadSeq` is the Preview's reload count: a reload, or opening an empty view, asks the extension to draw it. */
export function ExtensionView({ id, view, title, reloadSeq }: { id: ExtensionId; view: string; title: string; reloadSeq: number }) {
  const { store, states } = useExtensions();
  const state = states.find((s) => s.manifest.id === id);
  const nodes = state?.views[view];
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean }>();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    store.setShown(id, true);
    return () => {
      live.current = false;
      store.setShown(id, false);
    };
  }, [store, id]);

  const run = (action: Action) => {
    setBusy(true);
    setNote(undefined);
    store
      .runInView(id, action)
      .then((r) => live.current && r.note && setNote({ text: r.note }))
      .catch((e) => live.current && setNote({ text: errorText(e), error: true }))
      .finally(() => live.current && setBusy(false));
  };
  // Opening a view with nothing drawn, or a reload, asks for it, when its extension runs for a chat still on screen.
  const asked = useRef<number>(undefined);
  useEffect(() => {
    if (asked.current === reloadSeq) return;
    const first = asked.current === undefined;
    asked.current = reloadSeq;
    if (first && nodes) return;
    if (state?.boundTo && state.runtime.kind === "running") run({ kind: "render", view });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the reload count alone, so a new snapshot never asks again
  }, [reloadSeq]);

  const command = state?.manifest.commands[0]?.name;
  return (
    <div className="ext-view" aria-label={`${title}, an extension's view`} role="region">
      {state?.boundTo && <p className="muted ext-for">For the chat “{state.boundTo}”</p>}
      {nodes?.length ? (
        nodes.map((n, i) => <Node key={i} node={n} run={run} busy={busy} />)
      ) : (
        <p className="muted">{state?.installed ? `Nothing to show yet.${command ? ` Run /${command} in a chat to fill this view.` : ""}` : "This extension isn't installed."}</p>
      )}
      {busy && (
        <p className="muted" role="status">
          <Spinner /> Running…
        </p>
      )}
      {note && (
        <p className={note.error ? "ext-note error" : "ext-note"} role={note.error ? "alert" : "status"}>
          {note.text}
        </p>
      )}
    </div>
  );
}
