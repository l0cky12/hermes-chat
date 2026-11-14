// How links, paths and tool calls in the transcript open the Preview (PreviewPane.tsx) and the Terminal, and the menu
// a right click on a link or a path opens. `LinksProvider`, mounted once by Main, owns the one menu open at a time.
// Without a provider, as in the benchmark harness, a link still never navigates the app's own window, and a right
// click shows WebKit's own menu.
import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactNode } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Copy, ExternalLink, PanelRight, SquareTerminal } from "lucide-react";
import { linkTarget, withoutBidi, type LinkTarget, type PreviewTarget } from "../hermes/preview";
import { resolvePath, type PathOpen } from "../hermes/paths";
import { Menu } from "./ChatMenu";
import type { WebPages } from "./tauriPreview";
import { errorText } from "../hermes/values";

/** What the one open menu is for: a link, or a path in a reply. */
type MenuOf = { link: LinkTarget } | { path: PathOpen };
type OpenMenu = MenuOf & { at: { x: number; y: number } };
type ShowMenu = (e: ReactMouseEvent<HTMLElement>, of: MenuOf) => void;
/** Opens a path (paths.ts `pathOpener`). Resolves once something opened or the owner was told why not. */
type OpenPath = (open: PathOpen) => Promise<void>;

const PreviewContext = createContext<((t: PreviewTarget) => void) | undefined>(undefined);
const MenuContext = createContext<ShowMenu | undefined>(undefined);
const PathContext = createContext<OpenPath | undefined>(undefined);
const PathsInContext = createContext<{ folder?: string; session?: string } | undefined>(undefined);

export const useOpenPreview = () => useContext(PreviewContext);

/** An `onContextMenu` that opens the link menu for `link` instead of WebKit's own. Undefined with no provider. */
export const useLinkMenu = () => {
  const show = useContext(MenuContext);
  return useMemo(() => show && ((e: ReactMouseEvent<HTMLElement>, link: LinkTarget) => show(e, { link })), [show]);
};

/**
 * Marks the text under it as speaking of where Hermes's tools run, so the paths in it link (ADR 0163): a chat's
 * transcript, a Server file. Markdown outside one links no path: a Local file's `~/notes` is on this computer.
 * `folder`: the folder a relative path joins, a chat's working folder; without one, only full paths link. `session`:
 * the chat whose sandbox a path may be in (preview.ts `readServerFile`).
 */
export function PathsIn({ folder, session, children }: { folder?: string; session?: string; children: ReactNode }) {
  const value = useMemo(() => ({ folder, session }), [folder, session]);
  return <PathsInContext.Provider value={value}>{children}</PathsInContext.Provider>;
}

/**
 * How every link and path in the app behaves: a click opens a link in the Preview, and a path in the Preview or the
 * Terminal (`path`); a right click (or the Menu key, or Shift+F10) opens its menu. The menu keeps its own copy of what
 * it is for, so a streaming reply re-rendering it (ADR 0068) leaves the open menu as it was. Without `path`, a path in
 * a reply stays text.
 */
export function LinksProvider({
  preview,
  path,
  web,
  onToast,
  children,
}: {
  preview: (t: PreviewTarget) => void;
  path?: OpenPath;
  web: Pick<WebPages, "openInBrowser">;
  onToast: (text: string) => void;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<OpenMenu>();
  // Stable, so opening a menu re-renders no link, and Menu's listeners aren't set up again on each render.
  const show = useCallback<ShowMenu>((e, of) => {
    e.preventDefault();
    // From the keyboard the event has no pointer position, so the menu opens under the link's first line.
    const r = e.currentTarget.getClientRects()[0] ?? e.currentTarget.getBoundingClientRect();
    setMenu({ ...of, at: e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 8, y: r.bottom } });
  }, []);
  const close = useCallback(() => setMenu(undefined), []);
  return (
    <PreviewContext.Provider value={preview}>
      <PathContext.Provider value={path}>
        <MenuContext.Provider value={show}>
          {children}
          {menu && "link" in menu && <LinkMenu {...menu} onClose={close} preview={preview} web={web} onToast={onToast} />}
          {menu && "path" in menu && path && <PathMenu {...menu} onClose={close} open={path} onToast={onToast} />}
        </MenuContext.Provider>
      </PathContext.Provider>
    </PreviewContext.Provider>
  );
}

/** Copies `text`, and says whether it took: `what` is "link" or "path". */
function copy(text: string, what: string, onToast: (text: string) => void) {
  const failed = (e?: unknown) => onToast(`Couldn't copy the ${what}${e ? `: ${errorText(e)}` : "."}`);
  if (!navigator.clipboard?.writeText) return failed();
  navigator.clipboard.writeText(text).then(() => onToast(`${what[0].toUpperCase()}${what.slice(1)} copied.`), failed);
}

/**
 * Open in the Preview, Open in the Terminal and Copy path. The Preview reads the path as a file without asking what it
 * is. The Terminal opens a folder shell in a folder, and in the folder a file is in.
 */
function PathMenu({ path, at, onClose, open, onToast }: { path: PathOpen; at: OpenMenu["at"]; onClose: () => void; open: OpenPath; onToast: (text: string) => void }) {
  // Close first, so focus is back on the path before the Preview or the Terminal takes it.
  const act = (f: () => void) => () => {
    onClose();
    f();
  };
  return (
    <Menu label="Path" x={at.x} y={at.y} onClose={onClose}>
      <button role="menuitem" className="menu-item" onClick={act(() => void open({ ...path, as: "preview" }))}>
        <span className="menu-icon">
          <PanelRight size={15} />
        </span>
        <span className="menu-label">Open in the Preview</span>
      </button>
      <button role="menuitem" className="menu-item" onClick={act(() => void open({ ...path, as: "terminal" }))}>
        <span className="menu-icon">
          <SquareTerminal size={15} />
        </span>
        <span className="menu-label">Open in the Terminal</span>
      </button>
      <div className="menu-sep" role="separator" />
      <button role="menuitem" className="menu-item" onClick={act(() => copy(path.path, "path", onToast))}>
        <span className="menu-icon">
          <Copy size={15} />
        </span>
        <span className="menu-label">Copy path</span>
      </button>
    </Menu>
  );
}

/**
 * Open in the Preview, Open in your browser and Copy link. A server page's browser item is shown but does nothing:
 * this computer's browser would open this computer's port, not the server's, so it opens only through the Preview's
 * tunnel. A link the Preview won't load can only be copied.
 */
function LinkMenu({
  link,
  at,
  onClose,
  preview,
  web,
  onToast,
}: { link: LinkTarget; at: OpenMenu["at"]; onClose: () => void; preview: (t: PreviewTarget) => void; web: Pick<WebPages, "openInBrowser">; onToast: (text: string) => void }) {
  const noteId = useId();
  // Close first, so focus is back on the link before the Preview or the browser takes it.
  const act = (f: () => void) => () => {
    onClose();
    f();
  };
  return (
    <Menu label="Link" x={at.x} y={at.y} onClose={onClose}>
      {link.kind !== "elsewhere" && (
        <>
          <button role="menuitem" className="menu-item" onClick={act(() => preview({ kind: "web", url: link.url }))}>
            <span className="menu-icon">
              <PanelRight size={15} />
            </span>
            <span className="menu-label">Open in the Preview</span>
          </button>
          {link.kind === "page" ? (
            <button
              role="menuitem"
              className="menu-item"
              onClick={act(
                () =>
                  void web.openInBrowser(link.url).then(
                    (browser) => onToast(`Opened in ${browser ?? "your browser"}.`),
                    (e) => onToast(`Couldn't open it in your browser: ${errorText(e)}`),
                  ),
              )}
            >
              <span className="menu-icon">
                <ExternalLink size={15} />
              </span>
              <span className="menu-label">Open in your browser</span>
            </button>
          ) : (
            <>
              {/* Not `disabled`: Menu's arrow keys move focus with `.focus()`, which a disabled button refuses. */}
              <button role="menuitem" className="menu-item" aria-disabled="true" aria-describedby={noteId}>
                <span className="menu-icon">
                  <ExternalLink size={15} />
                </span>
                <span className="menu-label">Open in your browser</span>
              </button>
              <div className="menu-note" id={noteId}>
                A server page opens in your browser only through the Preview.
              </div>
            </>
          )}
          <div className="menu-sep" role="separator" />
        </>
      )}
      <button role="menuitem" className="menu-item" onClick={act(() => copy(link.kind === "elsewhere" ? link.href : link.url, "link", onToast))}>
        <span className="menu-icon">
          <Copy size={15} />
        </span>
        <span className="menu-label">Copy link</span>
      </button>
    </Menu>
  );
}

/**
 * A link's tooltip, the one place its address shows before the click. The address always comes first: a Markdown title
 * (`[docs](https://x/?d=… "https://docs.python.org/")`) only follows it, on one line of its own (#471).
 */
function linkTip(where: string | undefined, title: string | undefined): string | undefined {
  const words = title && withoutBidi(title).replace(/\s+/g, " ").trim();
  return [where, words].filter(Boolean).join("\n") || undefined;
}

/**
 * A link in a reply or a previewed Markdown file. An http(s) link opens in the Preview, a loopback one from the Hermes
 * server (ADR 0114); anything else does nothing, since following it would replace Hermes Chat's own window. Same-page
 * `#anchors` still scroll, and keep WebKit's own menu. A link whose address react-markdown emptied (`file:`,
 * `javascript:`) has nothing to open or copy, so it gets no menu, and not WebKit's either: its Open Link would load this
 * window's own page. On a screen that covers the Preview, such as Settings, `click="menu"` opens the link menu instead, so
 * the owner picks where it opens.
 */
export function PreviewLink({
  href,
  children,
  title,
  className,
  click = "preview",
}: {
  href?: string;
  children?: ReactNode;
  title?: string;
  className?: string;
  click?: "preview" | "menu";
}) {
  const open = useOpenPreview();
  const menu = useLinkMenu();
  const link = linkTarget(href, location.origin);
  const url = link && link.kind !== "elsewhere" ? link.url : undefined;
  const follow = (e: ReactMouseEvent<HTMLElement>) => {
    if (href?.startsWith("#") && e.type === "click") return;
    e.preventDefault();
    if (e.type !== "click") return;
    if (click === "menu") {
      if (link) menu?.(e, link);
    } else if (url) open?.({ kind: "web", url });
  };
  return (
    <a
      href={href}
      className={className}
      title={linkTip(url && click === "preview" ? `${url}\nOpens in the preview${link?.kind === "serverPage" ? ", from the Hermes server" : ""}` : (url ?? href), title)}
      onClick={follow}
      onAuxClick={follow}
      onContextMenu={
        menu &&
        ((e) => {
          if (link) menu(e, link);
          else if (href !== undefined && !href.startsWith("#")) e.preventDefault();
        })
      }
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

/**
 * A path in a reply (ADR 0163). A click, or Enter, opens it: a file in the Preview, a folder in a folder shell. It is
 * an `<a>` with no `href`, so nothing can ever send the app's window to it. Outside a `PathsIn`, with a relative path
 * and no folder to join, or where nothing opens paths, it stays the text's own words.
 */
export function PathLink({ written, folder, title, children }: { written: string; folder: boolean; title?: string; children?: ReactNode }) {
  const open = useContext(PathContext);
  const menu = useContext(MenuContext);
  const within = useContext(PathsInContext);
  const [busy, setBusy] = useState(false);
  const path = within && resolvePath(written, within.folder);
  if (!open || !within || !path) return <>{children}</>;
  const request: PathOpen = { path, saysFolder: folder, ...(within.session && { session: within.session }) };
  const go = () => {
    if (busy) return;
    setBusy(true);
    void open(request).finally(() => setBusy(false));
  };
  return (
    <a
      className="path-link"
      role="link"
      tabIndex={0}
      aria-busy={busy || undefined}
      title={linkTip(`${withoutBidi(path)}\nOn the Hermes server: a file opens in the Preview, a folder in the Terminal.`, title)}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        go();
      }}
      onContextMenu={menu && ((e) => menu(e, { path: request }))}
    >
      {children}
    </a>
  );
}
