# One secret matcher: every redacting surface hides every shape, and the values its caller knows

Issue #521: four redactors each had their own rules. Logs (ADR 0033) hid one set of shapes. Gateway errors (ADR 0073) hid those, the owner's typed values, and two token shapes Logs didn't know. Connection attempts hid the Logs set and the sign-in's own values. The chat export (ADR 0076) flagged a fifth set in `secrets.ts`. So a Discord token was hidden in a gateway error and kept in Logs, a `SECRET_KEY=` was flagged in an export and kept in Logs, and a cookie was hidden in Logs and never flagged in an export.

## Decisions

- **One table of secret shapes** (`src/hermes/secrets.ts` `SHAPES`): the union of what any surface matched. Each shape has the kind the support bundle counts, the mark that takes its place, and the part of a match that is the secret.
- **Every surface that hides secrets on its own replaces every shape** (`redactSecrets`): Logs and the support bundle, troubleshooting chats, server facts, gateway errors and connection attempts. Overlapping matches are one replacement, named for the one that starts first. Over-redacting a log line is the accepted cost. Missing a secret that another surface hides is not.
- **Values the caller knows go through one function** (`redactValues`): gateway errors' typed values, a sign-in's password, token and header values, and an export's picks. Places that overlap or touch are one, so no order of values leaves part of one behind. A value under 4 characters counts only where no letter or digit is beside it, except an export's picks, which count wherever they are. Connection attempts take the whole word around each, as before, since what is left of a word could be part of an address.
- **A chat export flags from the same table** (`findSecrets`), and the owner can still keep any flag. A flag redacts by default, and chat is prose and code, so there a shape may turn down what reads as chat: a named value must look like a password, a bearer token in prose must have a digit, an `Authorization` header must be one scheme and one credential, a cookie must be `name=value` pairs, a Discord-shaped token must start with mixed-case base64. A line that is all base64 is never flagged in an export, where it is as often a public key, a certificate or a hash.
- **A link's whole user part is the secret**, as Logs had it. An export now flags `app:Pa55w0rd!` in `postgres://app:Pa55w0rd!@db`, not only the password, and a token used as the user name (`https://sk_live_…@host`) is flagged too.

## Considered options

- **Applying the shapes in the export's redaction** (`redactValues`) as well as flagging them. The owner's Keep would no longer keep anything, and every `password: required` in a chat about code would be cut.
- **One vocabulary of kinds.** The export dialog keeps its own words for four shapes ("API key", "password in a link", "sign-in token (JWT)", "password or key") through each shape's `label`. Logs, the support bundle and troubleshooting keep theirs.

## Consequences

- A new secret shape is a row in `SHAPES`. Every surface hides it at once; say in its `flag` what a chat should not flag.
- `secrets.test.ts` "Every surface hides what another hides" runs each surface over the same samples, and lists by name what an export leaves to the owner.
