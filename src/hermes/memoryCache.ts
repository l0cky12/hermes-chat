// An in-memory ChatCache for tests: `saved` holds each profile's list, `profile` the one shown last, and `pulled` the
// profiles whose older history the owner pulled.
import type { Chat } from "./model";
import type { ChatCache } from "./transport";

export type MemoryCache = ChatCache & { saved: Record<string, Chat[]>; profile?: string; pulled: Set<string> };

export function memoryCache({ saved = {}, profile }: { saved?: Record<string, Chat[]>; profile?: string } = {}): MemoryCache {
  const cache: MemoryCache = {
    saved: { ...saved },
    profile,
    pulled: new Set(),
    load: (p) => cache.saved[p] ?? [],
    save: (p, chats) => void (cache.saved[p] = chats),
    lastProfile: () => cache.profile,
    rememberProfile: (p) => void (cache.profile = p),
    bytes: () => Object.values(cache.saved).reduce((n, chats) => n + JSON.stringify(chats).length * 2, 0),
    clear: () => void (cache.saved = {}),
    olderPulled: (p) => cache.pulled.has(p),
    rememberOlderPulled: (p) => void cache.pulled.add(p),
  };
  return cache;
}
