// The window's title: the chat on screen, after how many chats are unread. The webview's `document.title` is the one
// source; the Rust side copies it to the native window (main_window.rs), which WebKitGTK and WebView2 don't do alone.
import { useEffect } from "react";

const APP_NAME = "Hermes Chat";

/**
 * `(<unread>) <chat> - Hermes Chat`. No count while nothing is unread, and the app's name alone while no chat is open
 * (the New chat pane).
 */
export function windowTitle(chat: string | undefined, unread: number): string {
  const name = chat?.trim() ? `${chat.trim()} - ${APP_NAME}` : APP_NAME;
  return unread > 0 ? `(${unread}) ${name}` : name;
}

/** Keeps `document.title` at `title` while mounted, and puts the app's name back after. */
export function useWindowTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => () => void (document.title = APP_NAME), []);
}
