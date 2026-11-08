# The office's characters as people (#302): CPU

The same method as stage 1 ([../office-hq/cpu.md](../office-hq/cpu.md)): the app's CPU as a percentage of one core, summed over its processes, with `.claude/skills/verify-hermes-chat/scripts/cpu.sh`, in 20 s samples. "Three agents typing" is a chat whose reply delegated to two subagents on the stand-in dashboard. Each round measures the office closed, then open, with the window focused, and the cost of the building is open minus closed. The old build (`main` at a68f173) and the new one ran in turn, A, B, A, B, so both saw the same machine. The machine is shared with other sessions, and its load average moved between 6 and 60 during the runs.

Verdict: no measurable difference. The new characters draw the same 6 frames a second, and what each frame costs moved less than the noise between rounds.

## Headless (Xvfb, llvmpipe software WebGL)

Open minus closed, three agents typing, three rounds in each of three passes per build:

| Build | Pass 1 (load ~45) | Pass 2 (load ~15) | Pass 3 (load ~6) | Median of 9 |
| --- | --- | --- | --- | --- |
| Before | 27.9, 22.1, 16.8 | 24.6, 20.6, 17.4 | 22.2, 22.0, 21.8 | **+22.0 %** |
| After | 28.0, 19.6, 24.5 | 24.3, 19.4, 24.1 | 23.5, 22.0, 22.8 | **+23.5 %** |

Both drew 125 to 146 frames in each 20 s window, about 6 a second plus the frames opening the office draws. The ranges, 16.8 to 27.9 % before and 19.4 to 28.0 % after, overlap almost entirely. In pass 3, the quietest, the office closed measured 16.8 to 20.2 % for both. Stage 1 measured +21.4 % here (33.6 % open against 12.2 % closed).

The cost is in drawing frames in software. Stage 1 traced it to WebKit's web process, and it rose and fell with the frame rate; this run did not profile it again.

## The owner's desktop (Arch, Hyprland, AMD Radeon RX 6400)

The debug build, started by WebDriver in a window on the owner's session with a private HOME and D-Bus and `WEBKIT_DISABLE_DMABUF_RENDERER=1`. The app and WebKit's web process held `/dev/dri/renderD129` open, which is the RX 6400 (`1002:743f`, the card at 0d:00.0), and the run didn't set `LIBGL_ALWAYS_SOFTWARE`. The window sat on its own workspace on the second monitor and had focus only during each round.

Open minus closed, three agents typing, five rounds per pass:

| Build | Pass | Rounds | Median |
| --- | --- | --- | --- |
| Before | 2 | +1.2, +0.3, −0.5, +3.4, +1.7 | +1.2 % |
| After | 1 | +0.7, +0.3, −8.7, −0.2, −1.3 | −0.2 % |
| After | 2 | +1.2, −0.3, +0.5, −4.5, −3.4 | −0.3 % |

Every focused round drew 119 to 136 frames in its 20 s window. The old build's first pass is left out: its window never had focus, so it drew no frames, by design.

On the graphics card the building costs less than this method can resolve, before and after. The office-closed baseline (three agents running, the app's own cost) drifted from 12 % to 27 % of a core over the session, and swung by up to 9 points between neighbouring rounds. Stage 1 measured +2.6 % here, with a steadier baseline.

## What was not measured

- A profile of this run's frames. The limiter is inferred from stage 1.
- A release build of the Rust side. Most of the office's cost is in WebKit's web process, which a release build doesn't change.
