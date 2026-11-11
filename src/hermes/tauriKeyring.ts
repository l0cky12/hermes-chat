// The real keyring: Rust keeps each saved connection's dashboard password, and its extra request headers as JSON, in
// the system keyring, one entry of each per connection id (src-tauri/src/saved_password.rs). The connection migrated
// from the single sign-in kept before passes no id, and keeps the entries it already had. A dashboard token (ADR 0058)
// is never read here: Rust loads it, and this side only asks which addresses it is saved for.
import { invoke } from "@tauri-apps/api/core";
import type { Keyring, Secrets, TokenKeyring } from "./account";
import type { SavedConnection } from "./connections";
import { asError } from "./tauriPipe";

function keyring(kind: "password" | "headers", c: SavedConnection): Keyring {
  const connection = c.legacy ? null : c.id;
  return {
    load: () => invoke<string | null>(`${kind}_load`, { connection }).then((v) => v ?? undefined, asError),
    save: (value) => invoke<void>(`${kind}_save`, { [kind]: value, connection }).catch(asError),
    delete: () => invoke<void>(`${kind}_delete`, { connection }).catch(asError),
  };
}

/** The token entry (ADR 0058): Rust reads and writes it; this side learns only which addresses it is saved for. */
function tokenKeyring(c: SavedConnection): TokenKeyring {
  const connection = c.legacy ? null : c.id;
  return {
    saved: () =>
      invoke<[string, string][] | null>("token_saved", { connection }).then((v) => v?.map(([mode, target]) => JSON.stringify([mode, target])), asError),
    keep: (routes, attempt) =>
      invoke<void>("token_keep", { connection, attempt: attempt ?? "", addresses: routes.map((k) => JSON.parse(k) as [string, string]) }).catch(asError),
    delete: () => invoke<void>("token_delete", { connection }).catch(asError),
  };
}

export const systemSecrets = (c: SavedConnection): Secrets => ({ password: keyring("password", c), headers: keyring("headers", c), token: tokenKeyring(c) });
