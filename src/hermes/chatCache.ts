// Each profile's last synced chat list, kept in localStorage so the list shows as soon as Hermes connects, the
// profile shown last, so the next sign-in opens it, and the profiles whose older history the owner pulled.
// Clearing the cache deletes the chat lists only.
import type { Chat } from "./model";
import type { ChatCache } from "./transport";

const LIST_PREFIX = "hermes-chat.chats.";
const key = (profile: string) => `${LIST_PREFIX}${profile}`;
const PROFILE_KEY = "hermes-chat.profile";
const PULLED_KEY = "hermes-chat.older-pulled";

/** The keys of the saved chat lists. */
function listKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(LIST_PREFIX)) keys.push(k);
  }
  return keys;
}

function pulledProfiles(): string[] {
  try {
    const profiles: unknown = JSON.parse(localStorage.getItem(PULLED_KEY) ?? "[]");
    return Array.isArray(profiles) ? profiles.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

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
  bytes() {
    try {
      // localStorage keeps text as UTF-16: two bytes a character, key and value.
      return listKeys().reduce((n, k) => n + 2 * (k.length + (localStorage.getItem(k)?.length ?? 0)), 0);
    } catch {
      return 0;
    }
  },
  clear() {
    try {
      for (const k of listKeys()) localStorage.removeItem(k);
    } catch {
      // Nothing can be deleted from a store that can't be read.
    }
  },
  olderPulled(profile) {
    return pulledProfiles().includes(profile);
  },
  rememberOlderPulled(profile) {
    try {
      const pulled = pulledProfiles();
      if (!pulled.includes(profile)) localStorage.setItem(PULLED_KEY, JSON.stringify([...pulled, profile]));
    } catch {
      // The next launch shows the past month only, until the owner pulls again.
    }
  },
};
