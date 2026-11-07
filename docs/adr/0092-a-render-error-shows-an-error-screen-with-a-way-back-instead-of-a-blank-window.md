# A render error shows an error screen with a way back, instead of a blank window

Issue #308. On the Windows build, every send turned the whole window blank. The app had no React error boundary, so any exception thrown while React drew the tree (a render, a hook, an effect's cleanup, a state updater) unmounted everything: the owner saw an empty window with no message, no log and no way back but closing the app, and nothing said what had gone wrong. That hid the real cause (an effect handing React a Promise as its cleanup) for as long as it took to drive the Windows build under WebDriver on a CI runner.

## Decisions

- **One boundary at the top, around `App`** (`src/ui/ErrorBoundary.tsx`, mounted in `src/main.tsx`). It is the last line, not a way to carry on with a broken screen: nothing below it catches its own errors, so a failure anywhere shows the same screen. The sign-in screen, Setup and the signed-in window all sit under it.
- **The screen says what was thrown.** The error's message in plain sight, its stack and React's component stack under Details, so the owner can paste them into an issue. React also reports a caught error on the console, so Logs → This app keeps it with the rest of the app's diagnostics (ADR 0033).
- **One way back: Reload**, as the recovery screen for a failed drafts restore offers. It starts the app over: the connection is made again from what this computer saved, and drafts are saved as they are typed, so nothing typed is lost. Rust keeps its side (the pipe, the tunnel) and the new page takes it over as a launch does.
- **Only render-time errors.** An error in an event handler or a promise never unmounts the tree, so the boundary never sees it; those keep showing as the toast, alert or Logs entry they already had.

## Considered options

- **Try again, drawing the tree once more without a reload.** Dropped: remounting `App` reuses the launch-time connection, which `launch()` memoises so StrictMode's second mount can't open a second one. After the owner switched connections or signed out, that instance is closed, so Try again would bring back a dead connection and leave the live one open with nobody to close it. Making the remount pick up the live connection means teaching the launch memo about every switch, more than this screen is worth; Reload gets the same result through the path that already works.
- **A boundary per pane or per screen**, so a broken chat pane leaves the list usable. Dropped for now: it needs a decision per seam about what a half-working window may do (send, save, switch profile), and the owner first needs to see the error at all.
- **Catching at the symptom** with a try/catch around the send path. That hides the next cause as well as this one, and a boundary is what React gives for exactly this.

## Consequences

- A thrown render error still interrupts the owner, but with the message, the stack and a button, and no longer with a blank window. A bug report can carry the error instead of a description of emptiness.
- An error that comes back on every launch shows the screen on every launch; Reload then does not help, and the details say what to report.
