# Setup can stop a sign-in under way, runs again from the sign-in screen, and drops late answers

ADR 0009 made Setup test a sign-in before keeping it, and ADR 0112 made Add and Edit go through it. Issue #101 asked to finish that flow: stop a connection that is being made, never let a late answer replace what Setup shows, offer Run setup again from the sign-in screen as well as from Settings, and let the owner skip the provider step on a server that already has one. This ADR records how.

## Stopping Save and connect

While **Save and connect** waits for Hermes, Setup shows **Stop** in place of Back, and Escape does the same. Stop aborts the sign-in through an `AbortSignal` that goes from Setup through `connectWith` and `signIn` to transport's `connect`. There it closes the Hermes being dialled, which stops Rust opening the connection (`hermes_connect_cancel`, from ADR 0009's review), and `connect` rejects with `CONNECT_STOPPED`. Because `signIn` saves nothing until Hermes has answered, a stopped sign-in leaves the connection list and the keyring as they were. Then the connection in use before, if there was one, is put back exactly as after a failed switch (ADR 0009): from the sign-in kept in memory, or Offline with what this computer saved. Setup says "Connecting was stopped. Nothing was saved" and, when something was put back, that the connection in use is back. The tested details stay, so Save and connect can be tried again.

A Save and connect that is still waiting its turn behind another connection change (`src/hermes/serial.ts`) is stopped at once, and never starts (`Serial.stoppable`). The connection in use hasn't been touched yet, so there is nothing to put back. While it waits, it doesn't overtake the change ahead of it, as a plain change does. That change carries on as asked, so stopping Save and connect can't leave it abandoned with nothing connected in its place. Save and connect claims its place only when it starts. If a newer change was asked for after it, it starts already overtaken and gives way.

A Stop that lands after Hermes answered changes nothing: the sign-in is kept, and Setup moves on to the providers step. Stopping can't undo a sign-in that has been saved, and pretending otherwise would leave the keyring and the list out of step. Setup still can't be cancelled or closed while a sign-in is under way: it can only be stopped, so it never goes away with a connection half made. If Setup is unmounted anyway, it stops the sign-in.

## Late answers

The providers step reads and writes for one connection and one profile: the `Hermes` it was given and the profile that `Hermes` shows. That pair is the step's scope, and it is numbered. Each read of the provider list is numbered too. A list or its error counts only if it answers the latest read in the same scope. A save's answer counts while the scope is the same, however many reads came between, so trying a failed read again never hides a key that was saved. When the scope changes (a connection put back under Setup, or the profile changed), the step clears what it showed, the key typed and whether one was saved, and reads again. So a key typed for one profile is never sent to another, and a save still under way for the old scope doesn't report into the new one. This is the same rule as a connection test's numbering (ADR 0009), applied to the provider list.

## Provider keys

Rust already keeps a provider's and Hermes's own words out of a key's errors (ADR 0009). The webview now checks again before it shows an error. If the text repeats any 8 characters of the key, or a shorter key in full, it is replaced by "Hermes's answer isn't shown, as it may repeat the key". This is the same 8-character rule Rust uses for header values. The key field is a password field with autocomplete and spellcheck off, and is emptied once the key is saved. Nothing about the key is kept on this computer. The only thing shown about a saved key is the server's own redacted preview.

## Leaving the providers step

After Save and connect, the step's button is **Skip** while no key has been saved and Hermes already lists a provider it can use, **Skip for now** when it lists none, and **Finish** once a key is saved. Opened from Settings only to add a key, it stays **Done**. Skipping never blocks: a server may get its keys from its own `.env`, from an account provider, or from a model list Hermes Chat couldn't read.

## Run setup again from the sign-in screen

The sign-in screen for a saved connection offers **Run setup again…**. It opens Setup's Edit for that connection (ADR 0112), starting from what is saved for it without the password, so the same id, drafts and data stay with it. Cancel goes back to the sign-in screen. **Set up a new connection…** still adds another. Reading the saved details can wait on the keyring. Setup then opens only if nothing else was asked for on the sign-in screen meanwhile: no other pick, sign-in, removal or new setup, the screen still showing that connection, and nothing signed in.

## Drafts

Reconfiguring the connection in use keeps its id (ADR 0112), and drafts are kept under the connection's scope, written as the owner types. A changed address, a failed switch that puts the old connection back, and a stopped one all reopen with the same draft. Tests cover each case.

## Considered options

- **Let Cancel close Setup during Save and connect.** Rejected: the sign-in would carry on with no screen to report it, and could replace the connection in use after the owner had left Setup.
- **Undo a sign-in that Hermes already answered when Stop comes late.** Rejected: it would mean deleting a keyring entry and a list record that were just written, which could fail half way. Keeping it is honest, and the owner can switch back.
- **Hide every error from the provider step.** Rejected: errors like "Hermes doesn't list it as a model provider's key" or a timeout tell the owner what to do and can't contain the key. The 8-character check hides only text that might.

## Consequences

- `Account.connect`, `signIn` and transport's `connect` take an optional `AbortSignal`. Callers that don't pass one behave as before.
- Stop relies on `hermes_connect_cancel`. A Rust connect that ignores the cancel still ends at its 60-second limit (ADR 0009), and Setup shows Stopping… until then.
- Verified with the app's tests against the fake Hermes and a fake Rust side, and in the real app against a local stub dashboard. Not verified against a live Hermes server, a real provider key, or a working Secret Service.
