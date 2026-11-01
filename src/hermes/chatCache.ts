// Each profile's last synced chat list, kept in localStorage so the list shows as soon as Hermes connects.
import type { Chat } from "./model";
import type { ChatCache } from "./transport";

const key = (profile: string) => `hermes-chat.chats.${profile}`;

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
};
