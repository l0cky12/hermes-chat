# Provider keys are listed in Settings and removed only through Rust, with a read-back

The owner wants to manage model provider API keys from the app instead of editing `.env` files on the server (#315, the first piece of #241). Setup could already add a key (ADR 0009), but nothing could list the saved ones or remove one. The deployed Hermes (`bf0203a`, `hermes_cli/web_routers/config_env.py`) has what this needs: `GET /api/env?profile=` lists each variable with `is_set` and a redacted preview, `PUT /api/env` saves one, and `DELETE /api/env?profile=` with `{key}` removes it from the profile's `.env` and its mirrors, answering 404 `<KEY> not found in .env` when it isn't set.

## Decisions

- **Its own tab, Settings → Providers**, right after Model, with two sections: Saved keys, one row per provider with a key, and Add a key. The list is `providerKeys()` (Setup's own), so the two screens offer the same providers and can't disagree. A key is shown only as Hermes's redacted preview. Settings search mounts the tab among the results, as it does Model and Voice, since it holds no unsaved edit worth guarding; what was typed goes when the search starts or ends.
- **Add and Replace are Setup's save.** `Dashboard::save_provider_key` checks the key with the provider and saves it, and the key stays in Rust. Both screens share the result wording (`savedKeyText`) and the scrub that keeps a typed key out of any error (`withoutKey`).
- **Remove is a Rust command that checks, deletes and reads back.** `hermes_remove_provider_key` accepts only a variable `GET /api/env` lists as a provider's secret, the same rule as save (one shared check), sends `DELETE /api/env?profile=` with `{key}`, and reads the list again. A 404 counts as removed, so a retry or a key already removed elsewhere succeeds. If the read-back still shows `is_set`, it fails saying Hermes still lists the key. The screen then reads the list again itself, and a row leaves only once that read shows the provider unset. Like save, it never follows a redirect off the dashboard's origin, and it gives up after 30 seconds.
- **The window's relay refuses `DELETE api/env`.** `Dashboard::request` checks the path as the server routes it (`.` segments resolved, escapes decoded, as for the file routes in ADR 0012), so `api/./env` and `api/%65nv` are refused too. The checked command is the only way a key leaves the server from this app. `GET api/env` stays relayed.
- **Removal asks first, in place.** Remove opens "Remove the <provider> key from the <profile> profile on the server?" with Remove and Cancel. One thing happens at a time on the screen: while a key is being checked, saved or removed, every other button waits.
- **One variable per provider.** A provider with two credentials (Anthropic's key and token) shows its primary one, and Remove takes that variable only. If Hermes still lists a key for the provider afterwards, the row stays and says so.
- **Out of scope here:** subscription sign-in (OAuth) and custom endpoints, which are the other two pieces of #241.

## Considered options

- **Let the relay pass `DELETE api/env` for provider rows.** Rejected: the relay can't read the list to check the variable, so a webview bug or injected script could delete any `.env` entry. Rust checks first.
- **Drop the row as soon as the delete answers.** Rejected: an answer says what Hermes did with the request, not what it holds now. A 404 counts as removed and a 200 doesn't prove the key is gone from every place Hermes reads it, so the row waits for a read that shows it unset.
- **A tab per profile.** Rejected: the tab shows the profile in use, as Model and Voice do; another profile starts afresh, and any answer for the one before is dropped.

## Consequences

- A key can be added, replaced and removed for the shown profile, and the model picker reads the model list again after each change.
- A Hermes without `GET /api/env` shows a note and offers no change. See `docs/compatibility.md`, "Provider keys".
- Verification: Rust tests against a local stand-in dashboard (`removes_a_provider_key_and_reads_the_list_back`, `a_key_hermes_says_is_not_set_counts_as_removed`, `says_so_when_hermes_still_lists_the_key_after_removing_it`, `removes_only_what_hermes_lists_as_a_provider_key`, `never_relays_a_delete_of_the_servers_env`, and the redirect and timeout cases), and component tests against the fake Hermes (`providerSettings.test.tsx`).
