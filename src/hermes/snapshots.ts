// Snapshots (ADR 0123): a chat's page, published to an S3-compatible bucket the owner names, reached by a link that
// ends at its expiry or when it's revoked. Rust holds the secret key and makes every request to the host
// (`snapshot_*` in src-tauri); the webview sees the host's settings, never the secret. Screens take a `SnapshotApi`, so
// tests hand them a fake; only `tauriSnapshots` calls Rust.
import { invoke } from "@tauri-apps/api/core";
import { asError } from "./tauriPipe";

/** Where snapshots go. The secret key that goes with `keyId` stays in the keyring and never reaches the webview. */
export type SnapshotHost = {
  /** An absolute https:// address with no path, such as "https://s3.us-east-1.amazonaws.com". */
  endpoint: string;
  region: string;
  bucket: string;
  /** Every snapshot's key starts with it. Empty, or ending in "/". */
  prefix: string;
  keyId: string;
};

export const DEFAULT_PREFIX = "hermes-chat-snapshots/";

export type Expiry = "hour" | "day" | "week";

/** The lifetimes a link can have, in the order offered. 7 days is the most a presigned S3 link lasts. */
export const EXPIRIES: readonly { id: Expiry; label: string }[] = [
  { id: "hour", label: "1 hour" },
  { id: "day", label: "1 day" },
  { id: "week", label: "7 days" },
];

export const DEFAULT_EXPIRY: Expiry = "day";

/** `created` and `expires` are RFC 3339 UTC times. */
export type LiveSnapshot = { state: "live"; id: string; title: string; created: string; expires: string; url: string };

/** One snapshot as the bucket holds it. A revoked one has no state: no version of it is left, so it isn't listed. */
export type Snapshot =
  | LiveSnapshot
  /** Past its expiry, and the list's delete of it failed. */
  | { state: "expired"; id: string; title: string; created: string; expires: string }
  /** Its body no longer matches what was published, or its details can't be read: something else wrote it. */
  | { state: "changed"; id: string; title?: string | null; created?: string | null; expires?: string | null }
  /** Only older versions or delete markers are left: a Revoke that didn't finish. */
  | { state: "unrevoked"; id: string };

/** The list, and the host settings it was read with. */
export type SnapshotList = { host: SnapshotHost; snapshots: Snapshot[] };

/** What Publish did. Only `live` was read back and matched; `maybeSent` must never be shown as "not published". */
export type Published =
  | { outcome: "live"; snapshot: LiveSnapshot }
  /** The host refused the upload, and its listing shows nothing for the key. */
  | { outcome: "notPublished"; reason: string }
  /** Anything else: the page may be in the bucket. */
  | { outcome: "maybeSent"; reason: string };

/** One function per Rust command. A rejection's message is a sentence for the owner. */
export type SnapshotApi = {
  /** The saved settings, or null when none are. */
  host: () => Promise<SnapshotHost | null>;
  /** Saves the settings with their secret, which is always typed again, and gives back what was saved. */
  saveHost: (host: SnapshotHost, secret: string) => Promise<SnapshotHost>;
  clearHost: () => Promise<void>;
  /** Lists the prefix's versions and writes nothing. Rejects with what the host answered. */
  testHost: () => Promise<void>;
  /** Uploads exactly `html`. Rejects only when no host is saved or the keyring fails, so nothing was sent. */
  publish: (html: string, title: string, expiry: Expiry) => Promise<Published>;
  list: () => Promise<SnapshotList>;
  /** A freshly signed link to a Live snapshot that ends when it does. */
  link: (id: string) => Promise<string>;
  /** Resolves only once no version of the snapshot is left in the bucket. */
  revoke: (id: string) => Promise<void>;
};

export const tauriSnapshots: SnapshotApi = {
  host: () => invoke<SnapshotHost | null>("snapshot_host").catch(asError),
  saveHost: (host, secret) => invoke<SnapshotHost>("snapshot_host_save", { host, secret }).catch(asError),
  clearHost: () => invoke<void>("snapshot_host_clear").catch(asError),
  testHost: () => invoke<void>("snapshot_host_test").catch(asError),
  publish: (html, title, expiry) => invoke<Published>("snapshot_publish", { html, title, expiry }).catch(asError),
  list: () => invoke<SnapshotList>("snapshot_list").catch(asError),
  link: (id) => invoke<string>("snapshot_link", { id }).catch(asError),
  revoke: (id) => invoke<void>("snapshot_revoke", { id }).catch(asError),
};

export const sameHost = (a: SnapshotHost, b: SnapshotHost) =>
  a.endpoint === b.endpoint && a.region === b.region && a.bucket === b.bucket && a.prefix === b.prefix && a.keyId === b.keyId;

/** The endpoint's host name, as the destination shows it; the endpoint as typed when it doesn't parse. */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
}

/** A snapshot's time, as the desktop's locale writes a date and time. */
export const snapshotTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Copies to the clipboard, or rejects where there is none. */
export const clipboardText = (text: string): Promise<void> =>
  navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard"));
