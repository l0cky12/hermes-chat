// The real signed-in app against the fake Hermes, seeded with a few chats, so `shoot.mjs` can screenshot it.
import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import { Main } from "../../src/App";
import { FakeHermes, row } from "../../src/hermes/fakeHermes";
import { connect } from "../../src/hermes/transport";
import { appearanceStore } from "../../src/ui/appearance";
import { captureAppDiagnostics } from "../../src/hermes/logs";

const mode = new URLSearchParams(location.search).get("mode") ?? "dark";
localStorage.setItem("hermes-chat.appearance", JSON.stringify({ scheme: mode }));
appearanceStore(localStorage, document.documentElement);

const server = new FakeHermes();
server.sessions = [
  row("backup", 0.02, { pinned: true, title: "Nightly backup failing", message_count: 6 }),
  row("nas", 0.3, { pinned: true, title: "NAS disk usage", source: "telegram" }),
  row("caddy", 1, { title: "Caddy reverse proxy config", last_read_at: 0 }),
  row("rust", 2, { title: "Rust lifetimes question" }),
  row("trip", 4, { title: "Plan a weekend in Lisbon" }),
  row("grafana", 9, { title: "Grafana dashboard for UPS" }),
  row("zfs", 20, { title: "ZFS scrub schedule" }),
];
server.transcripts = {
  backup: [
    { role: "user", text: "Why did the nightly backup fail last night?" },
    {
      role: "assistant",
      text:
        "The restic job exited with **status 1** because the repository was still locked from an earlier run that was killed mid-prune.\n\n" +
        "Here's what I found in the journal:\n\n```bash\n$ journalctl -u restic-backup --since yesterday\nFatal: unable to create lock in backend: repository is already locked by PID 4127\n```\n\n" +
        "To fix it:\n\n1. Make sure no other restic process is running.\n2. Remove the stale lock with `restic unlock`.\n3. Re-run the backup by hand to confirm it completes.\n\nWant me to do steps 1–3 now?",
    },
    { role: "user", text: "Yes, go ahead." },
    { role: "assistant", text: "Done — the lock is cleared and a fresh snapshot `a91f3c2e` finished in 4m 12s. I also added `--retry-lock 10m` to the unit so a short overlap won't fail the job again." },
  ],
  nas: [{ role: "user", text: "How full is the NAS?" }, { role: "assistant", text: "The `tank` pool is at **71%** (5.1 TiB of 7.2 TiB)." }],
};

// Skills (ADR 0030, ADR 0015): synthetic ones in the default profile; `notes` is kept off for this app's chats.
const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nThe ${name} skill's instructions.\n`;
for (const [name, description] of [
  ["debugging", "Find the cause of a failure before changing anything"],
  ["restic-maintenance", "Check, unlock and prune restic repositories without losing snapshots"],
  ["release-notes", "Write release notes from the changes merged since the last tag"],
  ["writing", "Plain, short sentences; no filler"],
  ["notes", "Keep running notes for a chat"],
])
  server.skills.add("default", { dir: `/home/liam/.hermes/skills/${name}`, source: "agent" }, skillMd(name, description));
server.skills.platformDisabled.default = { tui: ["notes"] };

// Automations (ADR 0108): one GitHub route on a webhooks/1 server, with a made-up delivery history.
server.sessions.push(row("hook-41", 0.05, { source: "webhook", title: "Triage example/fixture#41" }));
server.webhooks.baseUrl = "https://hooks.example.net";
server.webhooks.add("default", "triage-issues", {
  provider: "github",
  events: ["issues"],
  filters: [{ field: "action", equals: "opened" }],
  coalesce: { key: "{repository.full_name}#{issue.number}", window_seconds: 30, max_wait_seconds: 300 },
  prompt: "New issue #{issue.number} on {repository.full_name}: {issue.title}\n\nRead it and suggest labels and a first reply.",
});
server.webhooks.rejections = { default: { "triage-issues": { bad_signature: { count: 3, last_at: Date.now() / 1000 - 5400 } } } };
const ago = (min: number) => Date.now() / 1000 - min * 60;
const issue = (n: number, title: string) => ({ "repository.full_name": "example/fixture", "issue.number": n, "issue.title": title });
for (const d of [
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000001", received_at: ago(180), state: "filtered", reason: "event:push", event: "push", action: null, excerpt: { ref: "refs/heads/main" } },
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000002", received_at: ago(150), state: "filtered", reason: "filter", action: "closed", excerpt: issue(38, "[fixture] Typo in the README") },
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000003", received_at: ago(95), state: "completed", outcome: "completed", session_id: "hook-41", duplicates: 1, excerpt: issue(41, "[fixture] Sync stalls on a slow link") },
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000004", received_at: ago(40), state: "failed", reason: "failed", outcome: "failed", session_id: "hook-41", retryable: true, retry_needs_confirmation: true, excerpt: issue(42, "[fixture] Crash when the list is empty") },
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000005", received_at: ago(3), state: "superseded", superseded_by: "4f1c2a90-0000-4000-8000-000000000006", coalesce_key: "example/fixture#43", action: "opened", excerpt: issue(43, "[fixture] Dark mode contrast") },
  { delivery_id: "4f1c2a90-0000-4000-8000-000000000006", received_at: ago(2), state: "running", session_id: "hook-41", action: "edited", excerpt: issue(43, "[fixture] Dark mode contrast") },
])
  server.webhooks.addDelivery("default", "triage-issues", { updated_at: d.received_at, ...d });
// Settings → Persona (ADR 0014, 0117): `?profiles=1` adds two more profiles, each with its own SOUL.md (synthetic).
server.souls = {
  default: "# Persona\n\nYou are Hermes, a terse home-lab assistant. Answer in plain words, and say what you changed.\n",
  work: "# Work\n\nYou are Hermes at work: formal, careful, and you cite the ticket you are working on.\n",
};
if (new URLSearchParams(location.search).get("profiles")) server.otherProfiles = { work: [], research: [] };

// `?relay=http://127.0.0.1:PORT`: `GET /api/logs` goes to a real Hermes dashboard through that relay (logs-live.mjs), as
// it would through the Rust side, and Logs' Save writes through it too. Everything else stays the fake Hermes.
const relay = new URLSearchParams(location.search).get("relay");
if (relay) {
  captureAppDiagnostics();
  const viaRelay = async (pathAndQuery: string) => {
    const res = await fetch(`${relay}/${pathAndQuery}`).catch((e: Error) => {
      throw new Error(`Couldn't reach the relay: ${e.message}`);
    });
    const body = await res.text();
    if (res.status === 599) throw new Error(JSON.parse(body).unreachable);
    if (!res.ok) throw new Error(`The dashboard answered ${res.status}: ${body}`);
    return body;
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: { text: string; fileName: string }) => {
      if (cmd !== "logs_export") throw new Error(`${cmd} isn't in the browser harness`);
      const res = await fetch(`${relay}/save?${new URLSearchParams({ name: args.fileName })}`, { method: "POST", body: args.text });
      return res.text();
    },
  };
  const open = server.openPipe;
  server.openPipe = async (...a: Parameters<typeof open>) => {
    const pipe = await open(...a);
    const request = pipe.request.bind(pipe);
    const getLimited = pipe.getLimited.bind(pipe);
    pipe.request = (method, path, body) => (path.startsWith("api/logs?") ? viaRelay(path) : request(method, path, body));
    pipe.getLimited = (path, max) => (path.startsWith("api/logs?") ? viaRelay(path) : getLimited(path, max));
    return pipe;
  };
}

const hermes = await connect(server.openPipe);
// `openInbox()` is the tray's Open Inbox; `summon(s)` is `hermes-chat --show`, with `selection` as what Rust reads from
// the selection and the clipboard (ADR 0172).
const shots: { server: FakeHermes; hermes: typeof hermes; openInbox?: () => void; summon?: (s: { fromElsewhere: boolean }) => void; selection: object } = {
  server,
  hermes,
  selection: {},
};
(window as unknown as { shots: unknown }).shots = shots;
// Settings → General's desktop parts, as the desktop app wires them: two saved connections, the tray and screenshots. The
// tray and screenshot answers are made up, as Rust would give them on a desktop that shows tray icons.
const current = { id: "conn-home-0001", name: "Home server", mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam", addedAt: 0, lastUsedAt: Date.now() - 60e3 };
const saved = [current, { id: "conn-work-0002", name: "Work lab", mode: "url" as const, sshTarget: "", url: "https://hermes.lab.example.net", username: "liam", addedAt: 0, lastUsedAt: Date.now() - 3 * 86400e3 }];
let tray = { closeToTray: false, tray: "shown" as const };
const trayWiring = {
  status: async () => tray,
  setCloseToTray: async (on: boolean) => (tray = { ...tray, closeToTray: on }),
  onStatus: () => () => {},
  onNewChat: () => () => {},
  onOpenInbox: (fn: () => void) => ((shots.openInbox = fn), () => {}),
  reportInbox: () => {},
};
const screenshots = {
  api: { capture: () => Promise.reject(new Error("No screenshots in the browser harness")), discard: async () => {} },
  onDesktopShortcut: () => () => {},
  attached: () => {},
  support: async () => ({ ok: true, summary: "Screenshots use the desktop portal (xdg-desktop-portal-hyprland): pick a region or a window." }),
};
createRoot(document.getElementById("root")!).render(
  <Main
    hermes={hermes}
    connection={current}
    saved={saved}
    onSwitchConnection={() => {}}
    onTestConnection={async () => ({ ok: true, route: { kind: "ssh", target: "liam@hermes", local: "127.0.0.1:9119" }, version: "0.22.6", unsecure: false }) as never}
    tray={trayWiring as never}
    summon={{ onSummoned: (fn) => ((shots.summon = fn as never), () => {}), readSelection: async () => shots.selection } as never}
    screenshots={screenshots}
    onSignOut={async () => {}}
  />,
);
