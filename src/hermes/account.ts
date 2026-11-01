// Signing in and out. The dashboard password is kept in the system keyring, so the app signs in at launch without
// asking; the rest of the sign-in is kept beside it, so the sign-in screen after Sign out has everything but the
// password.
import type { SignInDetails } from "./tauriPipe";
import type { Hermes } from "./transport";

export type SavedSignIn = Omit<SignInDetails, "password">;

/** The one saved dashboard password. `load` resolves to undefined when none is saved. */
export type Keyring = { load(): Promise<string | undefined>; save(password: string): Promise<void>; delete(): Promise<void> };

/** `store`: the saved sign-in without the password. `connect`: signs in to Hermes, rejecting if that fails. */
export type Account = {
  keyring: Keyring;
  store: { load(): SavedSignIn; save(d: SavedSignIn): void };
  connect: (d: SignInDetails) => Promise<Hermes>;
};

/**
 * Signs in, and once Hermes has answered, saves the password in the keyring and the rest of the sign-in beside it.
 * A keyring that can't save doesn't stop the sign-in; `notSaved` says why the password wasn't kept.
 */
export async function signIn(d: SignInDetails, account: Account): Promise<{ hermes: Hermes; notSaved?: string }> {
  const hermes = await account.connect(d);
  const { password, ...saved } = d;
  account.store.save(saved);
  try {
    await account.keyring.save(password);
    return { hermes };
  } catch (e) {
    return { hermes, notSaved: `Couldn't save the password in the system keyring: ${(e as Error).message}` };
  }
}

/**
 * At launch: the saved sign-in with its password, to sign in without asking. Undefined when no password is saved or
 * the keyring can't be read, so the owner is asked.
 */
export async function savedSignIn(account: Account): Promise<SignInDetails | undefined> {
  const password = await account.keyring.load().catch(() => undefined);
  return password === undefined ? undefined : { ...account.store.load(), password };
}

/**
 * Deletes the saved password, then closes the connection, so a close that fails can't leave the password behind.
 * Rejects, signed out, if the keyring can't delete it.
 */
export async function signOut(hermes: Hermes, account: Account): Promise<void> {
  try {
    await account.keyring.delete();
  } catch (e) {
    throw new Error(`Signed out, but couldn't delete the saved password from the system keyring: ${(e as Error).message}`);
  } finally {
    await hermes.close().catch(() => {});
  }
}
