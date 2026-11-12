// The window's one `Extensions` (extensions.ts), and how components reach it. Tests pass their own through the provider.
import { createContext, useContext, useSyncExternalStore } from "react";
import { BUNDLED } from "../hermes/bundledExtensions";
import { startFrame } from "../hermes/extensionHost";
import { Extensions } from "../hermes/extensions";

export const appExtensions = new Extensions({ catalogue: BUNDLED, startHost: (source) => startFrame(source) });

export const ExtensionsContext = createContext<Extensions>(appExtensions);

export function useExtensions() {
  const store = useContext(ExtensionsContext);
  return { store, states: useSyncExternalStore(store.subscribe, store.getSnapshot) };
}
