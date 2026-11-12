// The host frame an extension's worker runs behind (ADR 0126, section 1). The frame's `srcdoc` is the same for every
// extension and holds no byte of a package: the source arrives over postMessage as a string and becomes a `blob:`
// worker. The app's page CSP in index.html must list SHIM_HASH, because WebKit applies the parent's CSP to a srcdoc
// frame as well as the frame's own (docs/research/extension-isolation/app-probe.js); extensionHost.test.ts checks it.

/**
 * Runs in the frame. Takes only the first message from `parent` that carries two ports and a string, starts one worker
 * from the string, hands it the call port, and reports its uncaught errors on the control port. Then it ignores every
 * other message, so nothing in the frame's own realm ever runs extension code.
 */
export const SHIM = `onmessage=e=>{if(e.source!==parent||e.ports.length!==2||typeof e.data!=="string")return;onmessage=null;const[c,p]=e.ports,w=new Worker(URL.createObjectURL(new Blob([e.data],{type:"text/javascript"})));w.onerror=x=>{x.preventDefault();c.postMessage(String(x.message||"error"))};w.postMessage(0,[p])}`;

/** SHA-256 of SHIM, base64. Pinned here so the CSP is static; extensionHost.test.ts recomputes it. */
export const SHIM_HASH = "sha256-sELYs6Cxhmzc0m3KuPPGF2XkQ8pbRMHwwIdgEaA13XM=";

/** The frame's own CSP: no network, no eval, no script but the shim, workers only from blob:. */
export const FRAME_CSP = `default-src 'none'; script-src '${SHIM_HASH}'; worker-src blob:`;

export const SRCDOC = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><script>${SHIM}</script>`;

/**
 * Runs in the worker before the extension's code. Removes `Worker` and `SharedWorker`, so a busy loop can't hide in a
 * nested worker while the outer one answers pings, and closes `caches`, which WebKitGTK shares between opaque frames.
 * It shares one script with the extension, whose function declarations are hoisted above it, so it names no global:
 * the global is the script's `this`, and `Object` is the one an object literal has. A property a hoisted declaration
 * made non-configurable makes `defineProperty` throw, and the worker stops before the extension runs.
 */
export const PRELUDE = `(()=>{const g=this,O=({}).constructor;for(const n of["Worker","SharedWorker"])O.defineProperty(g,n,{value:undefined,writable:false,configurable:false});for(let o=g;o;o=O.getPrototypeOf(o))if(O.getOwnPropertyDescriptor(o,"caches"))O.defineProperty(o,"caches",{get(){throw "caches is closed"},configurable:false})})();\n`;

/** One running extension's frame, as the runtime sees it. `send` and `onMessage` carry JSON-RPC text. */
export type Host = {
  send(text: string): void;
  onMessage(cb: (data: unknown) => void): void;
  /** An uncaught error in the worker, or a source that didn't load. */
  onCrash(cb: (why: string) => void): void;
  /** Removes the frame, which stops its worker (ADR 0126, T3). */
  remove(): void;
};

export type StartHost = (source: string) => Host;

/** Starts a host frame in `mount`, hidden and out of the tab order. */
export function startFrame(source: string, mount: HTMLElement = document.body): Host {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.className = "extension-host";
  frame.srcdoc = SRCDOC;
  const calls = new MessageChannel();
  const control = new MessageChannel();
  frame.addEventListener("load", () => frame.contentWindow?.postMessage(PRELUDE + source, "*", [control.port2, calls.port2]), { once: true });
  mount.append(frame);
  return {
    send: (text) => calls.port1.postMessage(text),
    onMessage: (cb) => void (calls.port1.onmessage = (e) => cb(e.data)),
    onCrash: (cb) => void (control.port1.onmessage = (e) => cb(String(e.data))),
    remove: () => {
      calls.port1.close();
      control.port1.close();
      frame.remove();
    },
  };
}
