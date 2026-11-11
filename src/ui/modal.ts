// Keeping a modal dialog modal for the keyboard: Tab and Shift+Tab stay inside it, the app's shortcuts don't reach
// past it (App.tsx listens on the window, so stopping the key at the dialog is enough), and focus goes back where it
// was, or to `returnTo`, when it closes. Undo and redo in its text fields do reach the window, which runs them
// (editKeys.ts).
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { isTextEdit } from "./editKeys";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useModal(box: RefObject<HTMLElement | null>, returnTo?: RefObject<HTMLElement | null>) {
  // Read while rendering, before the dialog's own autoFocus moves focus into it.
  const [before] = useState(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined,
  );
  // What had focus inside the dialog when its effect was last cleaned up. StrictMode cleans up and sets up again
  // while the dialog stays open, and the cleanup has put focus back outside it: the second setup brings it back in.
  const held = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const root = box.current;
    if (held.current?.isConnected) held.current.focus();
    held.current = null;
    return () => {
      const now = document.activeElement;
      held.current = now instanceof HTMLElement && root?.contains(now) ? now : null;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
      const back = returnTo?.current ?? before;
      if (back?.isConnected) back.focus();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, []);
  return (e: KeyboardEvent) => {
    if (!isTextEdit(e)) e.stopPropagation();
    trapTab(e, box.current);
  };
}

/** Keeps Tab and Shift+Tab inside `root`, wrapping from its last focusable control to its first and back. */
export function trapTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (e.key !== "Tab" || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && isTabStop(el, root));
  if (!items.length) return e.preventDefault();
  const active = document.activeElement;
  const outside = !root.contains(active);
  if (e.shiftKey && (outside || active === items[0])) {
    e.preventDefault();
    items[items.length - 1].focus();
  } else if (!e.shiftKey && (outside || active === items[items.length - 1])) {
    e.preventDefault();
    items[0].focus();
  }
}

/** Of a named group of radios, only the checked one is a tab stop, or the first when none is. */
function isTabStop(el: HTMLElement, root: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) return true;
  const group = [...root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
  return el === (group.find((r) => r.checked) ?? group[0]);
}
