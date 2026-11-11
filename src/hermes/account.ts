// Signing in and out of a saved connection (connections.ts, ADR 0112). Each connection's dashboard password is kept in
// the system keyring under its id, so the app signs in at launch without asking; the rest of the connection is kept in
// the connection list, so the sign-in screen after Sign out has everything but the password. Its extra request
// headers, whose values can be secrets, are kept in the keyring too, and stay after Sign out.
//
// A secret is only ever given back for the address it was saved for: a password with the mode, target and username
// it signed in with, headers with their URL. So a sign-in to an edited address whose secrets the keyring couldn't save
// never sends the old address's secrets to the new one. A connection with several routes (ADR 0120) saves its password
// with every route it was typed for, and a route added since, whose secrets weren't saved, is skipped (`locked`)
// until the password is typed again.
//
// A connection can sign in with the dashboard's session token instead (ADR 0058). Rust keeps that token in its own
// keyring entry and loads it itself; this side only learns which addresses it is saved for (`TokenKeyring`).
import { type Address, type Connections, type SavedConnection, addressKey, addressOf, cleanName, detailsOf, wayOf } from "./connections";
import { TOKEN_REFUSED, routeAddress, routeKey, routesOf, savedRoute, withRoutes, type RouteDetails } from "./routes";
import type { ExtraHeader, SignInDetails } from "./tauriPipe";
import type { Hermes } from "./transport";

/** A connection's address and username, without its secrets. */
export type SavedSignIn = Address;

/** One saved secret: a dashboard password, or extra headers as JSON. `load` resolves to undefined when none is saved. */
export type Keyring = { load(): Promise<string | undefined>; save(value: string): Promise<void>; delete(): Promise<void> };

/**
 * A connection's token entry, which only Rust reads (ADR 0058). `saved`: the addresses (`routeKey`s) a token is saved
 * for, none when there is none. `keep`: saves the token the connection in use signed in with, if it was typed for this
 * sign-in, for `routes`. `delete`: deletes it.
 */
export type TokenKeyring = { saved(): Promise<string[] | undefined>; keep(routes: string[]): Promise<void>; delete(): Promise<void> };

/** A connection's keyring entries. */
export type Secrets = { password: Keyring; headers: Keyring; token: TokenKeyring };

/**
 * `connections`: the saved connections. `secrets`: a connection's keyring entries. `connect`: signs in to Hermes as `c`,
 * rejecting if that fails. `readSaved`: what this computer saved for `c`, to read while it can't connect
 * (transport's `readSaved`).
 */
export type Account = {
  connections: Connections;
  secrets: (c: SavedConnection) => Secrets;
  connect: (c: SavedConnection, d: SignInDetails, signal?: AbortSignal) => Promise<Hermes>;
  readSaved: (c: SavedConnection, d: SignInDetails, reason: string) => Hermes | undefined;
  /** What this computer saved for `c`, shown while signing in to it starts at once (transport's `openSaved`). */
  openSaved: (c: SavedConnection, d: SignInDetails) => { hermes: Hermes; firstTry: Promise<string | undefined> } | undefined;
};

/** What the Rust side says when the dashboard turns the password down (`TransportError::BadCredentials`). */
export const WRONG_PASSWORD = "Wrong username or password.";

/** Whether `reason` is a sign-in that only asking again can fix, so launch shows the sign-in screen, not Offline. */
export const turnedDown = (reason: string) => reason === WRONG_PASSWORD || TOKEN_REFUSED.test(reason);

/** Whether `reason` is a sign-in Hermes turned down, or won't take for now (`TransportError::RateLimited`): trying it
 * again on its own would only spend sign-in attempts. */
export const signInRefused = (reason: string) => turnedDown(reason) || reason.startsWith("Too many sign-in attempts.");

/** What the keyring kept at sign-in. */
export type Kept = { password: boolean; headers: boolean };

/**
 * The keyring's password entry, saved with what it signs in to. One route: its address, as before routes existed
 * (`v: 1`), so an older version still reads it. Several: the username and every route (`v: 2`).
 */
function passwordEntry(d: SignInDetails, password: string): string {
  if (!d.routes) return JSON.stringify({ v: 1, for: addressKey(d), password });
  return JSON.stringify({ v: 2, username: d.username.trim(), routes: d.routes.filter((r) => !r.locked).map(routeKey), password });
}

/**
 * The saved password, and the keys (`routeKey`) of `c`'s routes it was saved for. Undefined when it was saved for none
 * of them. The migrated connection's entry is the plain password kept before, which counts only for the address it had
 * then.
 */
function passwordFor(c: SavedConnection, raw: string | undefined): { password: string; routes: Set<string> } | undefined {
  if (raw === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    v = undefined;
  }
  const routes = routesOf(c);
  const entry = v as { v?: unknown; for?: unknown; password?: unknown; username?: unknown; routes?: unknown } | null;
  const forAddress = (key: string) => new Set(routes.filter((r) => addressKey(routeAddress(r, c.username)) === key).map(routeKey));
  let found: { password: string; routes: Set<string> } | undefined;
  if (entry && typeof entry === "object" && typeof entry.password === "string" && entry.v === 1 && typeof entry.for === "string")
    found = { password: entry.password, routes: forAddress(entry.for) };
  else if (entry && typeof entry === "object" && typeof entry.password === "string" && entry.v === 2) {
    const saved = Array.isArray(entry.routes) ? entry.routes.filter((k): k is string => typeof k === "string") : [];
    found = entry.username === c.username.trim() ? { password: entry.password, routes: new Set(routes.map(routeKey).filter((k) => saved.includes(k))) } : undefined;
  } else if (c.legacy) found = { password: raw, routes: forAddress(c.legacy.address) };
  return found?.routes.size ? found : undefined;
}

/** The saved extra request headers, by the URL they were saved for. */
type SavedHeaders = Map<string, ExtraHeader[]>;

const headerList = (v: unknown): ExtraHeader[] =>
  Array.isArray(v) ? v.filter((h): h is ExtraHeader => typeof h?.name === "string" && typeof h?.value === "string") : [];

/**
 * The keyring's headers entry. One route: `{url, headers}`, as before routes existed. Several: each web address's
 * headers with its URL (`v: 2`). None to save: undefined, and the entry is deleted.
 */
function headersEntry(d: SignInDetails): string | undefined {
  if (!d.routes) return d.headers?.length ? JSON.stringify({ url: d.url, headers: d.headers }) : undefined;
  // A locked route keeps the headers saved for its URL: they were given back for that URL, and go nowhere else.
  const routes = d.routes.filter((r) => r.kind !== "ssh" && r.headers?.length).map((r) => ({ url: r.target, headers: r.headers }));
  return routes.length ? JSON.stringify({ v: 2, routes }) : undefined;
}

/**
 * Signs in to `c` with `d`, and once Hermes has answered, keeps `c` with `d`'s address (and `name`, if given) as the
 * connection in use, and saves the password and extra headers in its keyring entries. `c` may be a new connection
 * (`Connections.draft`), which is saved only now. A keyring that can't save doesn't stop the sign-in; `notSaved`
 * says what wasn't kept and why. `signal` stops it while Hermes hasn't answered yet; then nothing is saved, and it
 * rejects with transport's `CONNECT_STOPPED`. Once Hermes has answered, the sign-in is kept whatever `signal` says.
 */
export async function signIn(
  c: SavedConnection,
  d: SignInDetails,
  account: Account,
  name?: string,
  signal?: AbortSignal,
): Promise<{ hermes: Hermes; connection: SavedConnection; notSaved?: string; kept: Kept }> {
  const hermes = await account.connect(c, d, signal);
  const { password } = d;
  // The server the routes reached, once one said: every route must reach it from now on (ADR 0120). Only a connection
  // with several routes keeps it.
  const server = d.routes ? (hermes.getSnapshot().route?.server ?? d.server) : undefined;
  const { routes: _routes, server: _server, method: _method, provider: _provider, ...rest } = c;
  const connection: SavedConnection = {
    ...rest,
    ...addressOf(d),
    ...wayOf(d),
    name: name === undefined ? c.name : cleanName(name, d),
    ...(d.routes && { routes: d.routes.map(savedRoute) }),
    ...(server && { server }),
  };
  try {
    account.connections.save(connection);
  } catch (e) {
    await hermes.close().catch(() => {});
    throw e;
  }
  account.connections.use(connection.id);
  const secrets = account.secrets(connection);
  const notSaved: string[] = [];
  const kept = { password: true, headers: true };
  // A connection keeps one way to sign in: the other's secret goes.
  if (d.method === "token") {
    if (d.token?.trim())
      await secrets.token.keep(routesOf(d).filter((r) => !r.locked).map(routeKey)).catch((e: Error) => {
        kept.password = false;
        notSaved.push(`Couldn't save the token in the system keyring: ${e.message}`);
      });
    await secrets.password.delete().catch(() => {});
  } else {
    await secrets.password.save(passwordEntry(d, password)).catch((e: Error) => {
      kept.password = false;
      notSaved.push(`Couldn't save the password in the system keyring: ${e.message}`);
    });
    await secrets.token.delete().catch(() => {});
  }
  // The headers are saved with the URL they were signed in to; `savedHeaders` gives them back for that URL only.
  const headers = headersEntry(d);
  const savingHeaders = headers ? secrets.headers.save(headers) : secrets.headers.delete();
  await savingHeaders.catch((e: Error) => {
    kept.headers = false;
    notSaved.push(`Couldn't save the extra request headers in the system keyring: ${e.message}`);
  });
  const signedIn = account.connections.get(connection.id) ?? connection;
  return notSaved.length ? { hermes, connection: signedIn, notSaved: notSaved.join(". "), kept } : { hermes, connection: signedIn, kept };
}

/** `c`'s saved extra request headers, by URL. None when nothing is saved or the keyring can't be read. */
async function savedHeaders(c: SavedConnection, account: Account): Promise<SavedHeaders> {
  const out: SavedHeaders = new Map();
  try {
    const saved = JSON.parse((await account.secrets(c).headers.load()) ?? "null") as { v?: unknown; url?: unknown; headers?: unknown; routes?: unknown } | null;
    if (saved?.v === 2 && Array.isArray(saved.routes))
      for (const r of saved.routes as { url?: unknown; headers?: unknown }[]) {
        if (typeof r?.url === "string") out.set(r.url, headerList(r.headers));
      }
    else if (typeof saved?.url === "string") out.set(saved.url, headerList(saved.headers));
  } catch {
    // Nothing saved that can be read.
  }
  return out;
}

/** `c`'s routes with the headers saved for each one's URL now; a URL edited since gets none. */
const routesWithHeaders = (c: SavedConnection, headers: SavedHeaders): RouteDetails[] =>
  routesOf(c).map((r) => {
    const h = r.kind === "ssh" ? undefined : headers.get(r.target);
    return { ...r, ...(h?.length && { headers: h }) };
  });

/** The sign-in for `c` with `password`: its address, or with several routes all of them, and the server it reaches. */
function detailsFor(c: SavedConnection, password: string, headers: SavedHeaders, routes = routesWithHeaders(c, headers)): SignInDetails {
  const d = c.routes ? withRoutes(detailsOf(c, password), routes) : detailsOf(c, password, headers.get(c.url) ?? []);
  return c.routes && c.server ? { ...d, server: c.server } : d;
}

/** What the keyring holds for `c`: its saved sign-in, if any, and its extra request headers when they were read. */
type SavedRead = { saved?: SignInDetails; headers?: SavedHeaders };

/**
 * `c` with its saved password, to sign in without asking. Undefined when no password is saved for any of its routes,
 * or the keyring can't be read, so the owner is asked. A route the password wasn't saved for is `locked`: connecting
 * skips it.
 */
export async function savedSignIn(c: SavedConnection, account: Account): Promise<SignInDetails | undefined> {
  return (await readSaved(c, account, false)).saved;
}

/**
 * `c` with its saved sign-in, or the sign-in screen's form when none is saved or the keyring can't be read. Both need
 * the headers entry, so it is read beside the password or token, once.
 */
export async function savedSignInOrForm(c: SavedConnection, account: Account): Promise<{ saved: SignInDetails } | { form: SignInDetails }> {
  const { saved, headers } = await readSaved(c, account, true);
  return saved ? { saved } : { form: detailsFor(c, "", headers ?? new Map()) };
}

/**
 * Reads `c`'s password, or which addresses its token is saved for (Rust loads the token itself), and its headers.
 * `both`: the headers are read at the same time; otherwise only once a password or token is found, because each read
 * of a locked keyring can ask the owner to unlock it. A route the password or token wasn't saved for is `locked`.
 */
async function readSaved(c: SavedConnection, account: Account, both: boolean): Promise<SavedRead> {
  const secrets = account.secrets(c);
  const token = c.method === "token" ? secrets.token.saved().catch(() => undefined) : undefined;
  const password = c.method === "token" ? undefined : secrets.password.load().catch(() => undefined);
  const early = both ? savedHeaders(c, account) : undefined;
  const headers = () => early ?? savedHeaders(c, account);
  if (token) {
    const keys = new Set((await token) ?? []);
    if (!routesOf(c).some((r) => keys.has(routeKey(r)))) return { headers: await early };
    const h = await headers();
    const routes = routesWithHeaders(c, h).map((r) => (keys.has(routeKey(r)) ? r : { ...r, locked: true }));
    return { saved: { ...detailsFor(c, "", h, routes), savedToken: c.legacy ? null : c.id }, headers: h };
  }
  const saved = passwordFor(c, await password);
  if (!saved) return { headers: await early };
  const h = await headers();
  const routes = routesWithHeaders(c, h).map((r) => (saved.routes.has(routeKey(r)) ? r : { ...r, locked: true }));
  return { saved: detailsFor(c, saved.password, h, routes), headers: h };
}

/** The sign-in screen's details for `c` when it asks: everything saved but the password. */
export async function signInForm(c: SavedConnection, account: Account): Promise<SignInDetails> {
  return detailsFor(c, "", await savedHeaders(c, account));
}

/**
 * Signs in to `c` with its saved sign-in. If that fails for any reason but a wrong password, the chat list and Saved
 * copies this computer kept for `c` open anyway, Offline, and the app keeps trying to connect. Rejects when the
 * password is wrong or nothing is saved to read, so the owner is asked.
 */
export async function launchSignIn(c: SavedConnection, d: SignInDetails, account: Account): Promise<Hermes> {
  try {
    return await account.connect(c, d);
  } catch (e) {
    const reason = (e as Error).message;
    const offline = turnedDown(reason) ? undefined : account.readSaved(c, d, reason);
    if (!offline) throw e;
    return offline;
  }
}

/**
 * Opens `c` at launch with its saved sign-in (ADR 0089). With a chat list saved for it, that shows at once, Connecting,
 * while the first try to sign in runs; `turnedDown` resolves once that try has ended, to why the dashboard turned the
 * password or token down (`turnedDown`), with the Hermes closed so the owner is asked, or to undefined, and any other
 * failure is retried as Offline is. With none saved, it waits for signing in, as `launchSignIn`, and rejects as it does.
 */
export async function launchOpen(c: SavedConnection, d: SignInDetails, account: Account): Promise<{ hermes: Hermes; turnedDown?: Promise<string | undefined> }> {
  const opened = account.openSaved(c, d);
  if (!opened) return { hermes: await launchSignIn(c, d, account) };
  const { hermes, firstTry } = opened;
  return {
    hermes,
    turnedDown: firstTry.then(async (reason) => {
      if (reason === undefined || !turnedDown(reason)) return undefined;
      await hermes.close().catch(() => {});
      return reason;
    }),
  };
}

/**
 * Signs out of `c` (`signOut`), then reads what the sign-in screen starts from. Both finish before it resolves, so the
 * screen never shows with the details it had before. Never rejects; `error` says what Sign out couldn't do.
 */
export async function signOutToSignIn(hermes: Hermes, c: SavedConnection, account: Account): Promise<{ initial: SignInDetails; error?: string }> {
  let error: string | undefined;
  try {
    await signOut(hermes, c, account);
  } catch (e) {
    error = (e as Error).message;
  }
  return { initial: await signInForm(c, account), error };
}

/**
 * Deletes `c`'s saved password or token, then closes the connection, so a close that fails can't leave it behind.
 * Rejects, signed out, if the keyring can't delete it. A token stays valid on the server until it is replaced there.
 */
export async function signOut(hermes: Hermes, c: SavedConnection, account: Account): Promise<void> {
  const what = c.method === "token" ? "token" : "password";
  try {
    const secrets = account.secrets(c);
    await secrets.password.delete();
    await secrets.token.delete();
  } catch (e) {
    throw new Error(`Signed out, but couldn't delete the saved ${what} from the system keyring: ${(e as Error).message}`);
  } finally {
    await hermes.close().catch(() => {});
  }
}

/**
 * Removes a saved connection from this computer: its password, token and extra headers from the keyring, then (after
 * `close`, which signs out of it when it is in use) everything kept locally for it (`forgetLocal`), then the
 * connection itself. Nothing is sent to Hermes, so its chats stay on the server. If the keyring can't delete a
 * secret, nothing else is done and the connection stays in use, so its entries aren't left behind unnamed; this
 * rejects with why, and the owner can try again.
 */
export async function removeConnection(
  c: SavedConnection,
  account: Account,
  forgetLocal: (c: SavedConnection) => Promise<void>,
  close?: () => Promise<void>,
): Promise<void> {
  const secrets = account.secrets(c);
  const failed: string[] = [];
  await secrets.password.delete().catch((e: Error) => failed.push(`the password (${e.message})`));
  await secrets.headers.delete().catch((e: Error) => failed.push(`the extra request headers (${e.message})`));
  await secrets.token.delete().catch((e: Error) => failed.push(`the token (${e.message})`));
  if (failed.length) throw new Error(`The connection is still saved: the system keyring couldn't delete ${failed.join(" or ")}. Try again.`);
  // Signed out before its data goes, so nothing the connection still writes lands after the deleting.
  await close?.();
  await forgetLocal(c);
  account.connections.remove(c.id);
}
