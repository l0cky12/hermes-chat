# Office

The rail's Office button opens the agent office in place of the chat panes. By default it is a 3D building (ADR 0089): the Workroom, Waiting room, Trouble room and Lounge, with each agent drawn in the room for its state, in its chat's team color, under a name tag. Clicking a tag or a character opens the agent's card, whose only action is Open chat. **List** shows the same agents as rows. Escape, or picking a chat, goes back. The building draws a frame only when something changes or moves, and none while the window is unfocused.

## Sub-features

- `open`: the rail button opens the full view; Escape closes it.
- `agents`: a chat whose reply delegates shows three characters typing at one group of Workroom desks, one tag each.
- `card`: a tag opens the agent's card; Open chat opens the chat.
- `list`: the header's **List** shows the same agents with the same accessible names.
- `frames`: `.office-building[data-frames]` counts every frame drawn. It stays still while nothing moves or while the window is unfocused.
- `cpu`: `scripts/cpu.sh <seconds> [samples]` reports the app's CPU over a window, as a percentage of one core.

## How to get to it (user POV)

- The Office button on the rail.
- Settings (Ctrl+,) → Chats → Office, for Building, List or Off.

## Driving it with wd.mjs

Preconditions:

- Signed in per [sign-in.md](sign-in.md).

- **Agents at work.** Run `$S/wd.mjs click button "New chat (Ctrl+N)"`, `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs keys 'delegate the audit\n'` and `$S/wd.mjs wait .msg Delegating`. The stand-in's reply runs on, with two subagents, `sa-1` and `sa-2`.
- **Open.** Run `$S/wd.mjs click button Office`, then `$S/wd.mjs wait .office-tag`. List the tags with `$S/wd.mjs eval 'return [...document.querySelectorAll(".office-tag")].map(t=>t.textContent+" | "+t.getAttribute("aria-label")).join("\n")'`. There are three: the chat's title (its reply), "Read the auth code" and "Read the tests", each `Running`. Take `$S/wd.mjs shot`.
- **Card.** Run `$S/wd.mjs click .office-tag "Read the tests"`, then `$S/wd.mjs wait '[role=dialog]' "Open chat"`. The card lists Chat, Profile, State, Goal, Doing now, Model and Time. `$S/wd.mjs click button "Open chat"` closes the office and opens the chat at its Subagents panel.
- **Frames.** Read `$S/wd.mjs eval 'return document.querySelector(".office-building").dataset.frames'` twice, 20 s apart. With agents typing it rises by about 6 a second; with nothing running it doesn't move.
- **Unfocused.** With agents typing, run `DISPLAY=$DISPLAY_NUM python3 -I $S/steal-focus.py 60 &` (after `. $HV_RUN/state.env`). `document.hasFocus()` turns false, and the frame count stays still until the window goes.
- **Queued at the door.** A prompt with both `delegate` and `queue` in it, such as `delegate the audit and queue the summary`, also requests a third subagent, "Write the summary", that stays Queued. It stands in the line outside the Workroom door.
- **Close up.** Turn the wheel toward a character: `$S/wd.mjs wheel .office-tag "<its tag text>" -- -120 40`, about 28 times from **Reset view**. The `40` aims 40 px under the tag, at the character, because a wheel turned over a tag doesn't reach the canvas. Where tags overlap (a busy Workroom pod), aim at a tag that stands apart, such as the door line's. A double click on a room also zooms, but its first click opens the card of any character under it.
- **At rest.** On a fresh `HV_INBOX=1 $S/hv up` run, start one chat with `needs approval to run` and one with `fail this one`, then open the office. It shows the Approval in the Waiting room with a "!", the failure in the Trouble room under a red marker, and `work`'s two Unread chats on a Lounge couch, and the frame count stays still. (The stand-in never ends a delegating reply, even on Stop, so use these instead.)
- **CPU.** Run `$S/cpu.sh 20 3` in each state. Keep each Bash call under a few minutes: a call that is killed takes the run down with it, so run a long sequence as one background script.
- **List fallback.** Start the run with `MESA_GLES_VERSION_OVERRIDE=1.0 MESA_GL_VERSION_OVERRIDE=1.1 $S/hv up`. WebGL contexts then fail as on a machine without it, while the app still draws; `__EGL_VENDOR_LIBRARY_FILENAMES` pointed at nothing makes WebKit abort instead. Open the office: `.office-fallback` reads "Showing the list: This computer's graphics didn't offer WebGL, which the building needs.", and the rows have the same accessible names as the building's tags.

## Gotchas

- Xvfb has no GPU. WebGL runs on llvmpipe, in software, so a frame costs far more CPU here than on a desktop with a graphics card. Compare the office open against the same state with it closed, not against zero.
- Right after sign-in, the first click into the composer can be intercepted while the window settles. Retry it after a second.
- A frame count read while the window isn't focused stays still by design. Check `document.hasFocus()` before reading a typing count.
