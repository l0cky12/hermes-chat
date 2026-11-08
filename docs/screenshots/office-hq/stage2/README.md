# Office HQ stage 2 (#282)

Taken with the verify skill (`.claude/skills/verify-hermes-chat`) in the real app, headless (Xvfb, llvmpipe software WebGL), against the stand-in dashboard started with `HV_INBOX=1`. Shots 1 and 6 come from a run after the review fixes, the others from a run before them; nothing the others show changed. Another profile's reply is driven with the stand-in's `POST /__live`, as `session.active_list` reports one.

1. `1-default-floor-tower.png`: the office opens on the shown profile's floor. `work` is a closed floor in the tower beside the building, with its agent count. Its two seeded Unread chats were last active 1 hour and 3 days ago, so they have gone home. `default` has no agent either, and its floor says so. (The keyring note at the bottom is this headless run's; it has no keyring.)
2. `2-work-floor-typing.png`: a reply started in `work`, seen on its floor 13.4 s after it started (5.5 s in an earlier run). Looking at `work`'s floor leaves the app on `default`, and `default` is in the tower.
3. `3-walking-to-waiting-room.png`: the reply now waits for an approval. It walks out of the Workroom and along the hallway.
4. `4-waiting-room.png`: it arrives in the Waiting room, hand up under a "!".
5. `5-lounge-unread.png`: the reply ended, and the Inbox's read of `work` says the chat is Unread: it sits on a Lounge couch.
6. `6-walking-out-after-dismiss.png`: its Inbox entry dismissed, the office opened again walks it off the Lounge couch toward the front door. The floor's note says why agents leave.
7. `7-three-typing-default.png`: a delegating reply in `default`, three agents typing; `work`'s floor in the tower is lit with "!" while its reply waits for an approval.

## Requests while another profile's reply starts

From `POST /__live` to the character on `work`'s floor, the stand-in got:

```text
23:32:09.696Z POST /__live                 (the test's control)
23:32:21.798Z GET  /api/profiles
23:32:21.810Z GET  /api/sessions/w1        (asked of each profile, once, to find which one holds the new session)
23:32:21.812Z GET  /api/sessions/w1
```

`session.active_list` goes over the chat socket, which the stand-in doesn't log. No profile's chat list (`GET /api/sessions?profile=…`) was read. The three GETs are the transport's existing lookup of a session it didn't start, done once per session (`ownerOf` in `transport.ts`), not a new kind of request.

## CPU

The app's processes, as a percentage of one core. The box was shared with other sessions' builds and test runs, at a load average of 50 to 126 on 24 cores, so treat these as rough.

| State | Samples | Frames |
| --- | --- | --- |
| Closed, nothing moving (10 s) | 0.7, 0.7, 0.1% | — |
| Open, nothing moving (10 s) | 0.4, 0.9, 0.4% | 0 in each |
| Closed, three agents running (10 s) | 30.2, 33.0, 32.2% | — |
| Open, three agents typing (10 s) | 49.6, 48.6, 46.8% | 91, 91, 86 |
| Open, one agent walking (about 1.9 s, from the walk's start) | 76.8, 60.2, 91.2, 109.4% | 20, 18, 26, 32 |
| Open, the same agent standing (about 1.9 s, right after) | 21.8, 21.0, 22.8, 22.7% | 0 in each |

- A walk lasts one to two seconds and draws only while it lasts. On software WebGL it costs about 40 to 85% of a core for that time, then nothing.
- The walking and standing windows were read from the app's two processes directly (`/proc/<pid>/stat`), started as the agent's tag turned to Waiting. `cpu.sh`'s 2-second windows missed the walk: it first scans every process for the run's display, which on this busy box took longer than the walk.
- The walking and standing windows both include a reply still running in `default` (its three agents type on `default`'s floor, which wasn't the one open, so they drew nothing).
- Not measured on the owner's desktop with its graphics card, as stage 1 was: that would run the app on the owner's live session.
