# Office tower floor labels (#459)

Taken with the verify skill in the real app (Tauri, WebKitGTK), headless (Xvfb at 1400 × 900, llvmpipe software WebGL), against the stand-in dashboard, in a 1280 × 820 window. The stand-in holds `default`, its own `work`, and the profiles in `HV_PROFILES`, each running one reply (`POST /__live`). A delegating reply on `default`, the open floor, gives three characters to hover.

The issue's 15 names are Hermes profiles: the owner's `~/.hermes/profiles` holds them (and five more). In the building, each profile but the open one is a floor of the tower, with a label naming it. Those labels are the column in the issue. A character's own name tag only shows while it is hovered, focused or picked (#283), so those tags can't pile up.

## The issue's 15 profiles (16 tower floors with `work`)

| | Before (`origin/main` 82cc9cd6) | After |
| --- | --- | --- |
| Home view | `before-1-home.png`: `aegis` and `anvil` overlap; 8 labels are hidden past the top edge or cut by it | `after-1-home.png`: none overlap, none outside the canvas. 8 labels fit between the bottom floor and the top edge, at the tower; the other 8 stand in a second column on the tower's far side, away from the building |
| Turned to look from above | `before-2-from-above.png`: 10 overlapping pairs, 11 labels hidden or cut | `after-2-from-above.png`: none overlap, none outside the canvas |

The counts are the shots script's own check: each label's box, read from the page, against every other label's and the canvas's.

- `after-3-hover-character.png`: the real X pointer over the reply's character shows its tag.
- `after-4-pointer-on-tag.png`: the pointer then moved straight up onto that tag in one move. The tag stays, under the pointer.
- `before-4-pointer-on-tag.png`: the same move on `origin/main`. The tag goes about 250 ms after the pointer reaches it. See "The hover handoff" below.
- `after-5-top-floor-opened.png`: a click on `talos`, the label the issue saw cut off at the top, opens its floor ("talos's floor, looked at from default"). On `origin/main` WebDriver refused the same click: "element not interactable".

## A larger roster: 40 profiles (41 tower floors)

The owner's 20 real profile names plus `agent-01` to `agent-20`.

- `roster-1-home.png`: 41 labels, none overlapping or outside the canvas. The bottom floor's column stays at the tower, and the rest go on in columns beside it.
- `roster-2-from-above.png`: the same from above.

The app learns other profiles 20 per check, every 30 s while the office is open, so the shots wait until the tower lists every floor.

## The hover handoff

Moving the pointer straight from a character's head onto its tag (the tag sits on the head) hid the tag on `origin/main`. The probe logged this order in WebKitGTK for that one move:

```text
 87 ms  pointerout   canvas      React runs the tag's onPointerEnter here: the grace timer is cleared
 87 ms  pointerleave canvas      the scene reports "no character": a new 250 ms timer starts
 88 ms  pointerenter tag
340 ms  data-hover off           the tag hides under the pointer
```

A gradual move doesn't hit this, because the scene has already reported "no character" over the empty canvas between the head and the tag. The tag now also takes `onPointerMove`. The move event comes after both boundary events, so the tag holds. `src/ui/office.test.tsx` replays this order and fails without the fix.

## Not covered

- The owner's desktop with a GPU, and a real Hermes. The labels' placement depends only on where the scene projects the floors and the labels' measured size, both of which the real app here exercised.
- With 41 floors, the second to fifth columns stand over the back edge of the Workroom. They stay inside the canvas and never overlap, but they can sit over a back-row character there.

## Setup

`setup/` holds the scripts. `hv.sh` is the verify skill's `hv` with displays in :170 to :179 and `HV_PROFILES` in the stand-in. `signin.sh`, `seed.sh` and `shots.sh` drive one pass, and `run.sh` runs a pass end to end:

```sh
HV_TARGET=~/.cache/hermes-verify/target-459 docs/screenshots/office-name-tags/setup/hv.sh build
cp ~/.cache/hermes-verify/target-459/debug/hermes-chat /tmp/hermes-chat-after
HV_TARGET=~/.cache/hermes-verify/target-459 HV_PROFILES=talos,studio-gateway,scribe,prometheus,orchestrator,oracle,inbox-manager,hephaestus,forge,daedalus,codex-reviewer,cerberus,argus,anvil,aegis \
  docs/screenshots/office-name-tags/setup/run.sh after /tmp/hermes-chat-after
```
