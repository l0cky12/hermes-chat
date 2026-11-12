# Templates are local data with plain placeholders, and Insert only fills the draft

> **Update:** the composer's Templates button and dialog (`Templates.tsx`) were removed because the owner doesn't use them. The stored `templates` field, its checks in `templates.ts`, and its backup section are kept, so saved templates aren't lost and old backups still restore.

Issue #89 asks for reusable messages with blanks the owner fills in, previewed in full before they reach the composer.

## Where they live

Hermes has nothing to keep them in. Its quick commands are commands defined in the profile's config, not messages with blanks to fill in. Templates are the owner's own text and only matter in this app, so this computer keeps them, in the existing display-preferences document (`hermes-ui-prefs` in webview local storage, `uiPrefs.ts`), as a `templates` field. That document is already versioned, checked field by field on every read, shared live between windows through the `storage` event, and left alone by Clear local cache. It is separate from the chat cache and from drafts. A future backup of this computer's settings takes it with the other preferences.

- A template is `{id, name, description, body, project?}`. Names are unique ignoring case, at most 80 characters. Descriptions are at most 300 characters and bodies at most 20,000. The library keeps at most 300. On read, an entry that isn't valid, or repeats an id or name, is dropped.
- `project` is `{scope, id, name}`, where `scope` is the same connection-and-profile key as project membership (`projectLinks.ts` `projectScope`). The template is offered only in that project's chats, or while the list shows that project. `name` labels it when the project isn't in the current list. When Hermes says the project is gone (deleted from this app, or a write that finds it missing), the template loses its scope and is offered everywhere. An editor open on it meanwhile keeps that, unless the owner picks a project there. Nothing the owner wrote is deleted with a project.
- A write that local storage refuses (full) is kept in memory until the app closes, as for other preferences, and the library says so instead of claiming it saved. Writes replace the whole list read just before, so two windows saving in the same instant can lose one change. This is the same as every other preference, and the edit is still on screen to save again.

## The placeholder format

`{name}` is required, `{name?}` optional, `{name=default}` optional with a one-line default, `{name...}` multiline (combinable with `?` or `=`), and `\{` a literal brace. A name is a Unicode letter or `_`, then letters, digits, `_` or `-`. Any other brace is ordinary text, and so is a blank right inside another brace pair (`{{host}}`, `${{env}}`). That rule keeps the formats an admin or coding template is full of working without escapes: JSON, Jinja/Ansible `{{ }}`, GitHub Actions `${{ }}`, shell `{a,b}` and `{1..3}`. The cost is that `${VAR}` and f-string `{x}` read as blanks. The library's field list and the preview both show such a blank at once, and `\{` keeps it literal.

Rendering is one left-to-right pass of one regular expression. Each value is put in verbatim and never scanned again, so a value containing `{x}` or `\{` stays as typed. There are no expressions, filters, conditionals or includes, and nothing is evaluated. Values are looked up as the object's own properties only, so a blank called `constructor` or `__proto__` is an ordinary name. A required blank left empty (or only whitespace) stays as `{name}` in the preview and blocks Insert.

A template engine (Mustache, Handlebars) was rejected: its own `{{ }}` syntax would collide with the admin formats above, and it would add a dependency and logic features the issue rules out.

## Insert

Insert writes the rendered text into the chat's draft through the same path as typing (`drafts.ts`), so it is kept per connection, profile and chat like any draft. It never sends, queues or attaches anything. With a non-empty draft the dialog offers only **Replace draft** and **Add after draft** (the draft with trailing whitespace trimmed, a blank line, then the message). Ctrl+Enter does nothing there, so the owner always picks explicitly. Back, Cancel, Escape and clicking outside close the dialog, or return to the list, without touching the draft. The dialog is modal and belongs to the composer that opened it. If the chat or profile changes, the composer goes and so does the dialog, so a template can't land in another chat's draft.

## Export and import

Export writes `{"format": "hermes-chat-templates", "version": 1, "templates": [{name, description, body}]}` through the native Save dialog (`templates_export`, which shares chat Export's Rust code). Project scopes, ids and anything about the connection are left out: they mean nothing on another connection, and an export shouldn't name a server or user. Import reads a file the owner picks, up to 2 MB. A file that isn't JSON, isn't this format, or has a newer version is refused whole. Each entry is checked like a stored template, and a description that isn't text or is too long also makes it invalid. Invalid ones are skipped and counted, taken names get ` (2)`, ` (3)`…, and everything imported gets new ids and no project.

## Verification limits

Tested in the automated suite with a fake Hermes (`templates.test.ts`, `templates.test.tsx`, `projects.test.ts`, `uiPrefs.test.ts`). The screenshots were taken from the real Tauri app against that fake, not against a live Hermes. Nothing about templates depends on the Hermes version: no server call is involved until the owner sends.
