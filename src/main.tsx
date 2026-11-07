import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { restoreDraftsAfterRestart } from "./hermes/tauriUpdates";
import { syncScreenshotOutbox } from "./hermes/tauriScreenshot";
import { captureAppDiagnostics } from "./hermes/logs";
import { followEditKeys } from "./ui/editKeys";
import { followWindowVisibility } from "./ui/windowState";
import "./styles.css";

// Console warnings and errors, uncaught errors and unhandled rejections, for Logs → This app (ADR 0033).
captureAppDiagnostics();

/** The drafts saved for an update's restart couldn't all be put back, so the app doesn't open over them. */
function RecoveryFailed({ reason }: { reason: string }) {
  return (
    <div className="restarting-overlay" role="alert">
      <div className="recovery-failed">
        <p>Hermes Chat couldn't finish putting back the drafts it saved when it restarted for an update: {reason}</p>
        <p className="muted small">They're still saved. Try again; if this keeps happening, move that file somewhere else and they'll stay there.</p>
        <button className="btn" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    </div>
  );
}

// Whether the window is hidden to the tray, for the whole app's life (ADR 0034).
void followWindowVisibility();
followEditKeys();

void restoreDraftsAfterRestart().then((failed) => {
  const root = createRoot(document.getElementById("root")!);
  if (failed) return root.render(<RecoveryFailed reason={failed} />);
  // Even at the sign-in screen, crash leftovers are swept with every connection's persisted outbox protected: after
  // an update's restart has put its outboxes back, so their screenshots are kept.
  void syncScreenshotOutbox().catch(() => {});
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
});
