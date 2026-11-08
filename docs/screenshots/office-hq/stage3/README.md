# Office HQ stage 3 (#283)

Taken with the verify skill (`.claude/skills/verify-hermes-chat`) in the real app, headless (Xvfb, llvmpipe software WebGL), against the stand-in dashboard. Shots 1 to 4 run at pixel ratio 1 in a 1280 by 820 window. Shots 5 to 8 run at pixel ratio 2 (`GDK_SCALE=2`), which leaves a 760 by 500 window, so the layout is cramped there.

1. `1-tags-hidden.png`: three agents typing (a delegating reply and its two subagents). No tag shows until the pointer is over an agent.
2. `2-hover-shows-tag-low.png`: the pointer, moved with real X input, is over the reply's character, and its tag shows. Low is on in the office's switch beside Reset view.
3. `3-tag-by-keyboard.png`: Tab reached a tag. It shows while it has focus, and Enter opens the agent's card.
4. `4-settings-office-quality.png`: Settings → Chats → Office quality, set to Low.
5. `5-normal-dpr2.png`: Normal at pixel ratio 2. The canvas is 648 by 544 pixels (ratio 1.5).
6. `6-low-applied-live-dpr2.png`: one click on Low in the open office. The canvas is 432 by 363 pixels (ratio 1), with no reopen.
7. `7-normal-walks.png`: on Normal, a reply in `work` needs an approval. 0.4 s later it walks along the hallway.
8. `8-low-appears.png`: the same change on Low. 0.4 s later it already stands in the Waiting room.

## CPU

The app's processes as a percentage of one core, from `cpu.sh 20 1`, with three agents typing in the open office. Normal and Low alternate in four rounds, switched with the office's own switch, with 3 s to settle before each sample. Frames are `.office-building[data-frames]` over the same 20 s. Each run ends with two samples with the office closed and the reply still running. The load average on 24 cores was 6 to 22.

Pixel ratio 1 (canvas 952 by 734 on both):

| | Round 1 | Round 2 | Round 3 | Round 4 | Frames in 20 s |
| --- | --- | --- | --- | --- | --- |
| Normal | 47.9% | 35.8% | 39.4% | 42.8% | 124–126 |
| Low | 22.6% | 24.1% | 27.9% | 27.1% | 62 |
| Closed | 14.4% | 18.6% | | | — |

Pixel ratio 2 (canvas 648 by 544 on Normal, 432 by 363 on Low):

| | Round 1 | Round 2 | Round 3 | Round 4 | Frames in 20 s |
| --- | --- | --- | --- | --- | --- |
| Normal | 48.1% | 35.0% | 54.9% | 34.5% | 125–132 |
| Low | 28.9% | 24.6% | 30.9% | 19.1% | 62–66 |
| Closed | 18.1% | 21.2% | | | — |

- In both runs, every Low sample is below every Normal sample. Medians: 41.1% against 25.6% at ratio 1, and 41.6% against 26.8% at ratio 2.
- The cost follows the frames drawn. Typing is the only thing that moves here, and Low types at 3 frames a second against Normal's 6.
- Before Low typed at half the pace, the same run at ratio 1 measured Normal at 35.2, 36.5, 41.1 and 44.6% and Low at 39.7, 36.6, 45.2 and 45.1%. Both drew about 125 frames in 20 s on the same canvas. A 15 frame cap and a pixel ratio of 1 change nothing while only typing moves on a ratio-1 screen, so Low now types at half the pace.
- The ratio-2 run shows little extra gain from the smaller canvas. The window is small, so a frame's fixed cost outweighs its pixels. On a large high-DPI screen, the pixel ratio matters more. That wasn't measured.

## Room changes

The same reply in `work` was moved from Working to Waiting with the stand-in's `POST /__live`, with its floor open. Frames were counted over the 3 s after its tag turned to Approval.

| Quality | Frames in 3 s |
| --- | --- |
| Normal | 37 (the walk, at up to 30 a second) |
| Low | 0 (the one frame that puts it in the Waiting room was drawn before counting started) |

With agents typing at pixel ratio 2, a 10 s window drew 31 frames on Low and 61 on Normal.

## Not measured

The owner's desktop with its graphics card. As in stage 2, that would run the app in the owner's live session.
