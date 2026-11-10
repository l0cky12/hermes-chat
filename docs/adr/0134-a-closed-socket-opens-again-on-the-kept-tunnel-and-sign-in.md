# A closed socket opens again on the kept tunnel and sign-in

When the `/api/ws` socket closed, the app treated it as a lost connection (#409). It closed the whole connection in Rust, the SSH tunnel and the signed-in dashboard session with it. Then it waited 1 second and opened everything again: a new `ssh`, `GET /api/status`, the password sign-in, a ticket, and the socket. Measured with real Hermes `f0d94882` over SSH, the socket came back about 1.2 seconds after it closed: the 1-second wait plus the full open. Every drop also spent one sign-in, and Hermes allows 10 password sign-ins a minute from one address, so a connection whose socket kept dropping went Offline.

A socket can close while the rest of the connection is fine, for example when a proxy in front of Hermes ends the WebSocket.

## Decisions

- **A closed socket is opened again on the same connection first.** The transport keeps the pipe whose socket closed and dials through `Pipe.reopen`. In Rust, `hermes_reopen` mints a ticket on the kept `Dashboard` and opens `/api/ws` over the kept tunnel. Nothing else runs: no `ssh`, no status read, no sign-in.
- **It starts at once.** The 1-second wait is for a connection that failed. A socket that closes within 1 second of connecting still waits out the rest of that second, so a server that keeps closing new sockets isn't hammered.
- **Any failure falls back to today's full open, in the same try.** When the ticket or the socket fails, Rust closes the whole connection and the transport calls `hermes_connect`. A reopen the app stops closes the whole connection too. When the dial fails or is stopped, the transport disconnects the kept pipe, which also closes the server pages opened over it (ADR 0114), as a drop always did before. A dead tunnel fails fast, because the local relay finds no `ssh` socket. A sign-in Hermes no longer takes answers the ticket with 401. Both rebuild everything, as before. The reopen's ticket and socket each get 5 seconds, so a tunnel that hangs instead of failing doesn't hold the fallback for long.
- **Only a socket that closed reopens.** A connection that went quiet past the heartbeat deadline, a profile switch, and a move back to a preferred route (ADR 0120) still open everything again.
- **Transfers and Screens stop as on any reconnect.** A reopen is still a new socket, so the transfer rules that hang on "the connection was replaced" keep holding (ADR 0023), and a Screen's lease came over the socket that closed.
- **A reopen is its own entry in the record of connection attempts** (#270), over the route the connection was on, with only its `ticket`, `websocket` and `ready` steps.

## Considered options

- **Keep the tunnel and sign in again.** It saves the `ssh` handshake but not the sign-in, and the dashboard's session cookies are still good when only the socket closed.
- **Drop the 1-second wait and keep the full rebuild.** Faster, but every drop still costs a new `ssh` and a sign-in.
- **Tell a socket-only drop from a tunnel loss before choosing.** The close reason doesn't say which, and trying the reopen answers it in one round trip.

## Consequences

- A socket-only drop costs one ticket request and one WebSocket handshake: about 30 ms instead of 1.2 seconds, measured the same way.
- When the tunnel hangs instead of failing, the connection now comes back after about 5.2 seconds, where it took about 1.2 seconds before: the reopen waits out its 5-second ticket limit before the full open runs.
- Server pages opened over SSH stay open across a socket-only drop. Before, every drop closed them.
- A server that keeps closing new sockets gets a ticket and a socket about once a second for as long as it does, with no further backoff, because each reopen succeeds. Before, the same server got a sign-in each time, until its login limit put the app Offline.
- A route the connection was on when its socket closed is tried again before the others. ADR 0120's "drops move to the next route" now applies when the reopen fails.
