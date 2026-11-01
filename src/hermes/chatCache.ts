// Each profile's last synced chat list, kept in localStorage so the list shows as soon as Hermes connects, and the
// profile shown last, so the next sign-in opens it.
import type { Chat } from "./model";
import type { ChatCache } from "./transport";

const key = (profile: string) => `hermes-chat.chats.${profile}`;
const PROFILE_KEY = "hermes-chat.profile";

export const localChatCache: ChatCache = {
  load(profile) {
    try {
      const chats: unknown = JSON.parse(localStorage.getItem(key(profile)) ?? "[]");
      return Array.isArray(chats) ? chats.filter((c): c is Chat => typeof c?.id === "string" && typeof c.title === "string") : [];
    } catch {
      return [];
    }
  },
  save(profile, chats) {
    try {
      localStorage.setItem(key(profile), JSON.stringify(chats));
    } catch {
      // A full or unavailable store only costs the instant list at next sign-in.
    }
  },
  lastProfile() {
    try {
      return localStorage.getItem(PROFILE_KEY) || undefined;
    } catch {
      return undefined;
    }
  },
  rememberProfile(profile) {
    try {
      localStorage.setItem(PROFILE_KEY, profile);
    } catch {
      // The next sign-in opens the default profile instead.
    }
  },
};
