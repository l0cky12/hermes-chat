# Launch opens on the saved chats while it signs in, and a turned-down password still asks

Issue #268. At launch the app showed only "Signing in…" until every step of connecting had finished: two keyring reads, `GET /api/status`, the password sign-in, the WebSocket ticket, `/api/ws` and `gateway.ready`. Over a slow link (a Tailscale relay at about 71 ms a round trip, a dashboard slow to answer its first request after idling) that was about 3 seconds on a good launch, and much longer on a bad one, though the chat list this computer saved was there all along. Offline already shows that saved list after a failed sign-in (ADR 0112); it just wasn't used until one had failed.

## Decisions

- **With a saved sign-in and a saved chat list, launch opens the main screen on that list at once** (account.ts `launchOpen`, transport.ts `openSaved`). It is the same Hermes Offline reads from: the profile shown last, its chat list, and the Saved copies of chats opened lately, so the chat to reopen shows its Saved copy until it loads.
- **It starts connecting at once**, not after the first retry delay, and its status is **Connecting** (`ConnectionStatus` `"connecting"`, "Connecting…" by the status dot) until that first try has ended. Once connected, the list syncs and the open chat goes live as after a reconnect.
- **A first try the dashboard turns down goes back to the sign-in screen** with its error, as before: a wrong password or a refused token (`turnedDown`). The Hermes is closed first, so it never tries the wrong password again on its own. Only if the owner has stayed on that connection: a switch made meanwhile wins.
- **Any other failure is Offline's**: the list stays, the status becomes Reconnecting with why, and it keeps trying on the usual delays, counting the first try as one failed try.
- **With no saved chat list** (first run, a new connection, a cleared cache) launch waits for signing in on "Signing in…", as before, since there is nothing to show.

## Considered options

- **Leaving the status Reconnecting.** It says something dropped, and nothing has yet.
- **Sending the owner to the sign-in screen when a later try is turned down too.** That is a password changed on the server while the app runs or waits, which Offline already handles by saying why by the status dot; this change is only about launch.
- **Opening at once for a switch to another connection, too.** Switching asks first and is done on purpose, so a moment of "Connecting to…" is expected there. Left as it is.

## Consequences

- With saved chats, a wrong saved password shows the chat list for as long as the first try takes, then the sign-in screen.
- Anything the main screen asks of Hermes in that time waits or fails as it does while reconnecting, and is asked again once connected.
- **ADR 0112**: launch still signs in to the connection in use with its saved password; the saved list just shows while it does.
