// The real notifications: Rust posts them to the desktop's notification service (src-tauri/src/notify.rs). One about a
// waiting card goes with a tag, and Rust sends the tag back with what the owner did with it: opened it, or chose Deny
// where the service shows actions (ADR 0173). Rust keeps its notifications across a reload of the webview, so each
// webview's tags start with its own random prefix: an action whose tag isn't kept here, as one from before a reload,
// does nothing more than bring the window forward, which Rust does itself.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NoticeActions, Notify } from "./transport";
import { asError } from "./tauriPipe";

/** The notifications whose actions are still listened for, as Rust listens (notify.rs `CLICKABLE_KEPT`). */
const KEPT = 64;
const tagged = new Map<string, NoticeActions>();
const launch = crypto.randomUUID();
let lastTag = 0;
let listening: Promise<unknown> | undefined;

type Acted = { tag: string; action: "open" | "deny" };

function listenOnce() {
  listening ??= listen<Acted>("notification-action", ({ payload: { tag, action } }) => {
    const actions = tagged.get(tag);
    tagged.delete(tag);
    if (action === "open") actions?.open();
    else if (action === "deny") actions?.deny?.();
  }).catch(() => (listening = undefined));
}

export const desktopNotify: Notify = (n, actions) => {
  if (!actions) return invoke<void>("notify_desktop", n).catch(asError);
  listenOnce();
  const tag = `${launch}-${++lastTag}`;
  tagged.set(tag, actions);
  for (const old of tagged.keys()) if (tagged.size > KEPT) tagged.delete(old);
  return invoke<void>("notify_desktop", { ...n, tag, deny: !!actions.deny }).catch((e) => {
    tagged.delete(tag);
    return asError(e);
  });
};
