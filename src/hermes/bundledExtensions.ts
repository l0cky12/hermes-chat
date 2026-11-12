// The extensions that ship with the app (ADR 0126, section 9). Until Delivery step 4 they are the only ones: each is
// parsed with the same manifest parser a file install will use, and runs in the same sandbox.
import chatStatsManifest from "../extensions/chat-stats/manifest.json?raw";
import chatStatsSource from "../extensions/chat-stats/main.js?raw";
import { parseManifest } from "./extensionManifest";
import type { Packaged } from "./extensions";

function bundled(manifest: string, source: string): Packaged {
  const parsed = parseManifest(manifest);
  if (!parsed.ok) throw new Error(`A bundled extension's manifest is refused: ${JSON.stringify(parsed.problem)}`);
  return { manifest: parsed.manifest, source };
}

export const BUNDLED: readonly Packaged[] = [bundled(chatStatsManifest, chatStatsSource)];
