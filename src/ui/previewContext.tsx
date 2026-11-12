// How links and tool calls in the transcript open the Preview (PreviewPane.tsx), and the link menu a right click on one
// opens. `LinksProvider`, mounted once by Main, owns the one menu open at a time. Without a provider, as in the
// benchmark harness, a link still never navigates the app's own window, and a right click shows WebKit's own menu.
import { createContext, useCallback, useContext, useId, useState, type ReactNode } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Copy, ExternalLink, PanelRight } from "lucide-react";
import { linkTarget, withoutBidi, type LinkTarget, type PreviewTarget } from "../hermes/preview";
import { Menu } from "./ChatMenu";
import type { WebPages } from "./tauriPreview";
import { errorText } from "../hermes/values";

type OpenMenu = { link: LinkTarget; at: { x: number; y: number } };
type ShowLinkMenu = (e: ReactMouseEvent<HTMLElement>, link: LinkTarget) => void;

const PreviewContext = createContext<((t: PreviewTarget) => void) | undefined>(undefined);
const LinkMenuContext = createContext<ShowLinkMenu | undefined>(undefined);

export const useOpenPreview = () => useContext(PreviewContext);

/** An `onContextMenu` that opens the link menu for `link` instead of WebKit's own. Undefined with no provider. */
export const useLinkMenu = () => useContext(LinkMenuContext);

/**
 * How every link in the app behaves: a click opens it in the Preview, a right click (or the Menu key, or Shift+F10)
 * opens the link menu. The menu keeps its own copy of the link, so a streaming reply re-rendering it (ADR 0068) leaves
 * the open menu as it was.
 */
export function LinksProvider({
  preview,
  web,
  onToast,
  children,
}: {
  preview: (t: PreviewTarget) => void;
  web: Pick<WebPages, "openInBrowser">;
  onToast: (text: string) => void;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<OpenMenu>();
  // Stable, so opening a menu re-renders no link, and Menu's listeners aren't set up again on each render.
  const show = useCallback<ShowLinkMenu>((e, link) => {
    e.preventDefault();
    // From the keyboard the event has no pointer position, so the menu opens under the link's first line.
    const r = e.currentTarget.getClientRects()[0] ?? e.currentTarget.getBoundingClientRect();
    setMenu({ link, at: e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 8, y: r.bottom } });
  }, []);
  const close = useCallback(() => setMenu(undefined), []);
  return (
    <PreviewContext.Provider value={preview}>
      <LinkMenuContext.Provider value={show}>
        {children}
        {menu && <LinkMenu {...menu} onClose={close} preview={preview} web={web} onToast={onToast} />}
      </LinkMenuContext.Provider>
    </PreviewContext.Provider>
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
}: OpenMenu & { onClose: () => void; preview: (t: PreviewTarget) => void; web: Pick<WebPages, "openInBrowser">; onToast: (text: string) => void }) {
  const noteId = useId();
  // Close first, so focus is back on the link before the Preview or the browser takes it.
  const act = (f: () => void) => () => {
    onClose();
    f();
  };
  const copy = (text: string) => {
    const failed = (e?: unknown) => onToast(`Couldn't copy the link${e ? `: ${errorText(e)}` : "."}`);
    if (!navigator.clipboard?.writeText) return failed();
    navigator.clipboard.writeText(text).then(() => onToast("Link copied."), failed);
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
      <button role="menuitem" className="menu-item" onClick={act(() => copy(link.kind === "elsewhere" ? link.href : link.url))}>
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
