# A reconnect counts as a failed try until its connection stays up ten seconds

The app reconnects a dropped connection after 1, 2, 4, 8 and 16 seconds, then goes Offline until the owner reconnects. Until now, every dial that reached `gateway.ready` reset that count, however briefly the connection lasted (#485). A server that closed each connection just after it was ready was therefore dialled about once a second for as long as it did so. In a fake that closed each connection right after `client.capabilities`, that was 60 full opens in one minute. A full open is an `ssh`, a sign-in and a list sync. With a kept socket (ADR 0134) it was 62 reopens a minute instead. Hermes crashing on the `session.resume` that a reconnect sends gives the same loop.

## Decisions

- **A dial that reaches ready still counts as a try.** `redial` counts every try before it dials. A dropped connection resets the count only if it had stayed up for at least 10 seconds (`STEADY_MS`), measured from when it connected.
- **The reopened socket follows the same count.** A closed socket waits the current try's delay from when its connection connected, not always the first try's 1 second. Once the tries are used up, the app goes Offline, as for any other failed reconnect.
- **The owner's Reconnect starts the count again**, as before.

## Considered options

- **Reset the count on a timer 10 seconds after connecting.** It behaves the same, and a timer would need clearing on every drop and close. Checking how long the connection lasted when it drops needs no extra state.
- **Keep retrying at the last delay instead of going Offline.** A server that closes every connection is broken in a way that waiting won't fix. Offline is what the app already does once every try has failed.
- **A shorter steady time, such as the first retry's second.** A Hermes that crashes on the resume or list read that follows a reconnect can take a few seconds to do it over SSH. Ten seconds is well past that, and a working connection lasts minutes.

## Consequences

- A server that closes each connection just after it is ready gets at most six opens: the first plus five retries over about 31 seconds. Then the app is Offline until the owner reconnects.
- A connection that stayed up 10 seconds or more and then drops is retried after 1 second, as before.
- Two drops less than 10 seconds apart wait 2 seconds before the second reconnect, where they waited 1 second before.
