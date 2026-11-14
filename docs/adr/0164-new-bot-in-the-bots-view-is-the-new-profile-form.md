# New bot in the Bots view is the New profile form

> **Accepted.** It changes one line of ADR 0066: "This app doesn't create bots." The rest of ADR 0066 stands.

The owner wanted to set up bots from the Bots view and see the new bot there once made. Until now the view only listed bots. A bot is a profile (ADR 0066), and making one meant leaving for Settings → Profiles, making a profile there, and opening the Bots view again to find it.

## Decisions

- **New bot (+) in the Bots view's header** opens Settings → Profiles' own New profile form (`ProfileForm` in `src/ui/ProfileSettings.tsx`), titled "New bot", with "Create bot" as its button. The form is the same one: name, description, model and persona, the same checks before sending, and the same `POST /api/profiles` (ADR 0156). Nothing is written another way.
- **A name another profile has is refused before sending.** The form checks against the roster the view holds, which lists every profile.
- **The new bot shows once made.** The form closes, the view reads `profiles.list` again, and the new bot's row takes focus once the roster lists it. A note says it was created and that opening its row starts its Bot Chat.
- **No Bot Chat is started and no intro is sent.** Hermes's desktop greets a bot it makes with "Hey, tell me about yourself!". That spends a model turn and puts a message in the owner's name into the chat. Here, as for every Bot Chat (ADR 0066), the owner speaks first: the Bot Chat is made the first time the row opens.
- **No Bot Mode block is written.** The new profile has no `ui_meta['hermes-bots']` (title, colour, pin). The roster lists every profile, so the bot shows without it, named from its profile name. Writing that block needs the compare-and-swap round trip ADR 0066 left for later.
- **What the form can't do here, it leaves out.** Clone instead and Set model (after a create whose model Hermes didn't set) go on to dialogs that live in Settings → Profiles, so New bot doesn't offer them. A model Hermes didn't set is said in the note.
- **New bot is off** while the app isn't connected, while the server lacks `POST /api/profiles`, and on a Hermes without Bot Mode, whose view shows no rows.

## Considered options

- **A smaller bot form** (name and description only). Rejected: it would duplicate the New profile form's checks and failure handling for less.
- **Send the owner to Settings → Profiles.** Rejected: the owner asked to stay in the Bots view and see the bot there.
- **Open the new bot's Bot Chat at once.** Rejected: switching profiles is the owner's call, and the row is one click away.

## Consequences

- The Bots view and Settings → Profiles share the profile wiring (`profilesWiring` in `App.tsx`).
- A bot made here is an ordinary profile: it shows in the profile switcher and in Settings → Profiles too.
