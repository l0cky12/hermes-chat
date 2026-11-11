// @vitest-environment jsdom
// The Scheduled jobs screen in the app, against a fake Hermes whose cron routes behave as the deployed `bf0203a` did
// with a throwaway HERMES_HOME. Jobs are fixtures; nothing is scheduled anywhere.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { Main } from "../App";
import { StrictMode } from "react";
import { ScheduledJobs } from "./ScheduledJobs";
import { RestError } from "../hermes/pipe";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});

const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

function server() {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" })];
  s.otherProfiles = { work: [] };
  s.cron.jobs = { default: [], work: [] };
  s.cron.add("default", { name: "[fixture] Weekday brief", prompt: "Fixture only.", schedule: "0 9 * * 1-5", deliver: "telegram" });
  s.cron.add("default", { name: "[fixture] Paused check", prompt: "Fixture only.", schedule: "every 2h", paused: true });
  return s;
}

async function launch(s = server()) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  render(<Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }} onSignOut={async () => {}} />);
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
  // The screen, or the note in its place on a server without cron routes (ADR 0044).
  await waitFor(() => expect(document.querySelector(".jobs-screen, .capability-missing")?.textContent ?? "").not.toMatch(/^$|Loading the jobs/));
  return { hermes, user, s };
}

const writes = (s: FakeHermes) => s.restRequests.filter((r) => r.method !== "GET" && r.path.startsWith("/api/cron"));

describe("the Scheduled jobs screen", () => {
  it("lists the jobs with their schedule, time zone, next run and state", async () => {
    await launch();
    expect(screen.getByRole("heading", { name: "Scheduled jobs" })).toBeTruthy();
    expect(screen.getByText(/Times are in America\/Chicago/)).toBeTruthy();
    const brief = screen.getByText("[fixture] Weekday brief").closest("button")!;
    expect(within(brief).getByText(/On weekdays at 9:00 AM/)).toBeTruthy();
    expect(within(brief).getByText(/Next:/).textContent).toMatch(/CST/);
    expect(within(brief).getByText(/Telegram/)).toBeTruthy();
    const paused = screen.getByText("[fixture] Paused check").closest("button")!;
    expect(within(paused).getByText("Paused")).toBeTruthy();
    expect(within(paused).getByText(/won't run until resumed/)).toBeTruthy();
  });

  it("says when there are no jobs, and when the server has none to offer", async () => {
    const s = server();
    s.cron.jobs.default = [];
    await launch(s);
    expect(await screen.findByText(/No scheduled jobs in this profile yet/)).toBeTruthy();
    cleanup();
    const old = server();
    old.cron.missing = true;
    await launch(old);
    // The screen's own read finds no route, so the note saying what is missing takes its place (ADR 0044).
    expect(await screen.findByRole("region", { name: /This Hermes server doesn't support Scheduled jobs/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New job/ })).toBeNull();
  });

  it("warns when the profile's scheduler isn't running", async () => {
    const s = server();
    s.cron.heartbeat = null;
    await launch(s);
    expect(await screen.findByText(/hasn't recorded its scheduler running/)).toBeTruthy();
  });

  it("validates a new job, previews its runs, and creates it once", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByRole("button", { name: /New job/ }));
    await user.click(screen.getByRole("button", { name: "Create job" }));
    expect(screen.getByText("Write what Hermes should do each time.")).toBeTruthy();
    expect(screen.getByText(/^Enter a schedule\./)).toBeTruthy();
    await user.type(screen.getByPlaceholderText(/What Hermes should do/), "Fixture only.");
    const schedule = screen.getByPlaceholderText("every day at 9am");
    await user.type(schedule, "0 25 * * *");
    expect(screen.getByRole("alert").textContent).toBe("There's no hour 25: use 0–23.");
    await user.clear(schedule);
    await user.type(schedule, "weekdays at 8:30am");
    expect(screen.getByText("On weekdays at 8:30 AM")).toBeTruthy();
    expect(document.querySelectorAll(".job-preview li")).toHaveLength(5);
    await user.type(screen.getByPlaceholderText(/Named after the prompt/), "Fixture new");
    await user.click(screen.getByLabelText(/Create it paused/));
    // Two quick presses: one create.
    const create = screen.getByRole("button", { name: "Create job" });
    await user.dblClick(create);
    await screen.findByRole("heading", { name: /Fixture new/ });
    expect(writes(s)).toHaveLength(1);
    expect(writes(s)[0].body).toMatchObject({ name: "Fixture new", schedule: "weekdays at 8:30am", paused: true });
  });

  it("asks before running a job now, says what it will do, and shows how the run ended", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByText("[fixture] Paused check"));
    await user.click(screen.getByRole("button", { name: /Run now/ }));
    const dialog = screen.getByRole("alertdialog", { name: "Run this job now?" });
    expect(dialog.textContent).toMatch(/sends its prompt to the agent/);
    expect(dialog.textContent).toMatch(/also resumes the job/);
    expect(writes(s)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(writes(s)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Run now/ }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Run now" }));
    expect(await screen.findByText("The run finished: Succeeded.")).toBeTruthy();
    expect(writes(s).map((w) => w.path)).toEqual([expect.stringMatching(/\/trigger$/)]);
  });

  it("asks before deleting, and deletes only once Hermes has", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByText("[fixture] Weekday brief"));
    await user.click(within(document.querySelector<HTMLElement>(".jobs-screen")!).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete this job?" });
    expect(dialog.textContent).toMatch(/can't be undone/);
    await user.click(within(dialog).getByRole("button", { name: "Delete job" }));
    await screen.findByRole("heading", { name: "Scheduled jobs" });
    expect(screen.queryByText("[fixture] Weekday brief")).toBeNull();
    expect(s.cron.jobs.default.map((j) => j.name)).toEqual(["[fixture] Paused check"]);
  });

  it("pauses and resumes", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByText("[fixture] Weekday brief"));
    await user.click(screen.getByRole("button", { name: /Pause/ }));
    await screen.findByRole("button", { name: /Resume/ });
    expect(s.cron.jobs.default[0].enabled).toBe(false);
    await user.click(screen.getByRole("button", { name: /Resume/ }));
    await screen.findByRole("button", { name: /Pause/ });
    expect(s.cron.jobs.default[0].enabled).toBe(true);
  });

  it("edits a job, stops at a change made elsewhere, and saves over it when asked", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByText("[fixture] Weekday brief"));
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    const schedule = screen.getByDisplayValue("0 9 * * 1-5");
    s.cron.jobs.default[0].prompt = "Changed elsewhere.";
    await user.clear(schedule);
    await user.type(schedule, "0 10 * * 1-5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByText(/changed in another Hermes client since you opened it \(prompt\)/)).textContent).toBeTruthy();
    expect(writes(s)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Save over their changes" }));
    await screen.findByRole("heading", { name: "[fixture] Weekday brief" });
    expect(writes(s).map((w) => w.body)).toEqual([{ updates: { prompt: "Fixture only.", schedule: "0 10 * * 1-5", repeat: "forever" } }]);
  });

  it("shows why a save failed and keeps the edits", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByText("[fixture] Weekday brief"));
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    s.cron.failNext = { match: /^PUT /, when: "before" };
    const name = screen.getByDisplayValue("[fixture] Weekday brief");
    await user.clear(name);
    await user.type(name, "Fixture renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByText(/weren't saved/)).textContent).toMatch(/Hermes didn't answer/);
    expect(screen.getByDisplayValue("Fixture renamed")).toBeTruthy();
    expect(s.cron.jobs.default[0].name).toBe("[fixture] Weekday brief");
  });

  it("loads under StrictMode, which mounts the screen twice", async () => {
    const s = server();
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    render(
      <StrictMode>
        <ScheduledJobs api={hermes.cron} profile="default" connected onClose={() => {}} />
      </StrictMode>,
    );
    expect(await screen.findByText("[fixture] Weekday brief")).toBeTruthy();
  });

  it("warns about a copy of the job in another profile", async () => {
    const s = server();
    s.cron.jobs.work.push(structuredClone(s.cron.jobs.default[0]));
    const { user } = await launch(s);
    await user.click(screen.getByText("[fixture] Weekday brief"));
    expect((await screen.findByText(/profile has a copy of this job, with the same id/)).textContent).toMatch(/^ ?The work profile/);
  });

  it("shows a one-shot's single run once", async () => {
    const s = server();
    s.cron.add("default", { name: "[fixture] Once", prompt: "Fixture only.", schedule: "in 2h" });
    const { user } = await launch(s);
    await user.click(screen.getByText("[fixture] Once"));
    expect(document.querySelectorAll(".job-runs-preview li")).toHaveLength(1);
  });

  it("keeps an overdue one-shot's repeat limit when only its name changes", async () => {
    const s = server();
    const row = s.cron.add("default", { name: "[fixture] Overdue", prompt: "Fixture only.", schedule: "in 2h" });
    Object.assign(row, { schedule: { kind: "once", run_at: "2026-01-01T09:00:00-06:00", display: "once at 2026-01-01 09:00" }, schedule_display: "once at 2026-01-01 09:00" });
    const { user } = await launch(s);
    await user.click(screen.getByText("[fixture] Overdue"));
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    const name = screen.getByDisplayValue("[fixture] Overdue");
    await user.clear(name);
    await user.type(name, "Fixture overdue renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { name: "Fixture overdue renamed" });
    expect(writes(s).map((w) => w.body)).toEqual([{ updates: { name: "Fixture overdue renamed" } }]);
  });

  it("previews only the runs a repeat limit has left, after a schedule edit too", async () => {
    const s = server();
    const row = s.cron.add("default", { name: "[fixture] Limited", prompt: "Fixture only.", schedule: "every 2h", repeat: 5 });
    (row.repeat as { completed: number }).completed = 4;
    const { user } = await launch(s);
    await user.click(screen.getByText("[fixture] Limited"));
    expect(document.querySelectorAll(".job-runs-preview li")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    const schedule = screen.getByDisplayValue("every 120m");
    await user.clear(schedule);
    await user.type(schedule, "every 3h");
    expect(document.querySelectorAll(".job-preview li")).toHaveLength(1);
  });

  it("pages run history 20 at a time up to Hermes's limit, and says what a missed run does", async () => {
    const s = server();
    const id = s.cron.jobs.default[0].id;
    s.cron.runs[id] = Array.from({ length: 120 }, (_, i) => ({ id: `cron_output:${id}:${i}`, title: `COMPLETED · run ${i}`, preview: `run ${i}`, source: "cron_output", started_at: 1_793_600_000 - i * 60 }));
    const { user } = await launch(s);
    await user.click(screen.getByText("[fixture] Weekday brief"));
    expect(screen.getByText(/Hermes still runs it up to 2 hours late/)).toBeTruthy();
    const history = () => document.querySelectorAll(".job-history > li");
    await waitFor(() => expect(history()).toHaveLength(20));
    for (const n of [40, 60, 80, 100]) {
      await user.click(screen.getByRole("button", { name: "Show more runs" }));
      await waitFor(() => expect(history()).toHaveLength(n));
    }
    expect(screen.queryByRole("button", { name: "Show more runs" })).toBeNull();
    expect(screen.getByText("Hermes lists a job's latest 100 runs; older ones aren't shown.")).toBeTruthy();
    expect(s.restRequests.filter((r) => r.path.endsWith("/runs")).map((r) => r.query.get("limit"))).toEqual(["20", "40", "60", "80", "100"]);
    expect(history()[99].textContent).toMatch(/run 99/);
  });

  it("stops paging when Hermes has no more runs", async () => {
    const s = server();
    const id = s.cron.jobs.default[0].id;
    s.cron.runs[id] = Array.from({ length: 27 }, (_, i) => ({ id: `cron_output:${id}:${i}`, title: `COMPLETED · run ${i}`, source: "cron_output", started_at: 1_793_600_000 - i * 60 }));
    const { user } = await launch(s);
    await user.click(screen.getByText("[fixture] Weekday brief"));
    await user.click(await screen.findByRole("button", { name: "Show more runs" }));
    await waitFor(() => expect(document.querySelectorAll(".job-history > li")).toHaveLength(27));
    expect(screen.queryByRole("button", { name: "Show more runs" })).toBeNull();
    expect(screen.getByText("Showing the latest 27 runs.")).toBeTruthy();
  });

  it("shows each run's state, times and error, and an agent run's result when asked", async () => {
    const s = server();
    const id = s.cron.jobs.default[0].id;
    const at = 1_793_806_654;
    s.cron.runs[id] = [
      { id: "local-now", source: "cron", started_at: at + 300, ended_at: null, is_active: true, scheduler_owned: true, profile: "default" },
      { id: "local-ok", source: "cron", started_at: at, ended_at: at + 80, end_reason: "cron_complete", profile: "default", preview: "[IMPORTANT: You are running as a scheduled cron job." },
      { id: "cron_output:x:1", title: "FAILED · Script exited with code 3", preview: "# Cron Job: x **Status:** script failed", source: "cron_output", started_at: at - 60 },
      { id: "local-dead", source: "cron", started_at: at - 600, ended_at: null, is_active: false, scheduler_owned: false, profile: "default" },
    ];
    s.transcripts["local-ok"] = [
      { role: "user", text: "Fixture only.", row_id: 1 },
      { role: "assistant", text: "[fixture] Here is the weekday brief.", row_id: 2 },
    ];
    const { user } = await launch(s);
    await user.click(screen.getByText("[fixture] Weekday brief"));
    const history = await screen.findByRole("list", { name: "Run history, newest first" });
    const rows = within(history).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".badge")!.textContent)).toEqual(["Running", "Succeeded", "Failed", "Unknown"]);
    expect(rows[1].textContent).toMatch(/took 1 min 20 s/);
    // Hermes's injected cron preamble isn't the result, so it isn't shown as one.
    expect(rows[1].textContent).not.toMatch(/IMPORTANT/);
    expect(rows[2].textContent).toMatch(/Script exited with code 3/);
    expect(rows[2].textContent).not.toMatch(/Cron Job/);
    expect(rows[3].textContent).toMatch(/no end recorded for this run/);
    expect(screen.getByText("A run is under way on the server.")).toBeTruthy();
    // Only agent runs have a session to read; reading it is a GET and changes nothing.
    expect(within(rows[2]).queryByRole("button", { name: /Show the result/ })).toBeNull();
    const show = within(rows[1]).getByRole("button", { name: "Show the result" });
    await user.click(show);
    expect(await within(rows[1]).findByText("[fixture] Here is the weekday brief.")).toBeTruthy();
    expect(within(rows[1]).getByRole("button", { name: "Hide the result" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(rows[1]).getByRole("region", { name: "Run result" })).toBeTruthy();
    expect(writes(s)).toHaveLength(0);
    await user.click(within(rows[1]).getByRole("button", { name: "Hide the result" }));
    expect(within(rows[1]).queryByText("[fixture] Here is the weekday brief.")).toBeNull();
  });

  it("drops a history answer that a newer read has superseded", async () => {
    const s = server();
    const id = s.cron.jobs.default[0].id;
    s.cron.runs[id] = [{ id: "cron_output:x:old", title: "COMPLETED · the old run", preview: "the old run", source: "cron_output", started_at: 1_793_600_000 }];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const route = s.cron.route.bind(s.cron);
    let first = true;
    s.cron.route = (req) => {
      const handle = route(req);
      if (!handle || !req.path.endsWith("/runs") || !first) return handle;
      first = false;
      // Hermes read the history as it was, but the answer is slow to arrive.
      return async () => {
        const answer = await handle();
        await held;
        return answer;
      };
    };
    const { user } = await launch(s);
    await user.click(screen.getByText("[fixture] Weekday brief"));
    s.cron.runs[id] = [{ id: "cron_output:x:new", title: "COMPLETED · the manual run", preview: "the manual run", source: "cron_output", started_at: 1_793_700_000 }, ...s.cron.runs[id]];
    await user.click(screen.getByRole("button", { name: /Run now/ }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Run now" }));
    expect(await screen.findByText("the manual run")).toBeTruthy();
    release();
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(screen.getByText("the manual run")).toBeTruthy();
    expect(document.querySelectorAll(".job-history > li")).toHaveLength(2);
  });

  it("doesn't start a second run while one is under way", async () => {
    const s = server();
    const job = s.cron.jobs.default[0];
    s.cron.executions[job.id] = { id: "e1", job_id: job.id, status: "running", claimed_at: "2026-11-04T09:35:34-06:00" };
    const { user } = await launch(s);
    const row = screen.getByText("[fixture] Weekday brief").closest("button")!;
    expect(within(row).getByText("Running")).toBeTruthy();
    await user.click(row);
    await user.click(screen.getByRole("button", { name: /Run now/ }));
    expect(screen.getByRole("alertdialog").textContent).toMatch(/A run of this job is under way on the server: Hermes runs one at a time/);
    s.cron.failNext = { match: /trigger$/, when: "before", message: new RestError(409, '{"detail":"Job is already running or was claimed by another scheduler"}') };
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Run now" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This job is running already. Its result shows here once it finishes.");
    expect(job.last_run_at).toBeNull();
  });

  it("says where Hermes can't deliver a job's results", async () => {
    const s = server();
    s.cron.add("default", { name: "[fixture] To Discord", prompt: "Fixture only.", schedule: "0 9 * * *", deliver: "discord" });
    s.cron.add("default", { name: "[fixture] To Slack", prompt: "Fixture only.", schedule: "0 9 * * *", deliver: "slack" });
    const { user } = await launch(s);
    expect(within(screen.getByText("[fixture] To Discord").closest("button")!).getByText("Discord has no home channel set on the server, so Hermes won't deliver there.")).toBeTruthy();
    expect(within(screen.getByText("[fixture] To Slack").closest("button")!).getByText("Slack isn't set up on this profile's gateway, so Hermes won't deliver there.")).toBeTruthy();
    expect(within(screen.getByText("[fixture] Weekday brief").closest("button")!).queryByText(/won't deliver/)).toBeNull();
    await user.click(screen.getByText("[fixture] To Slack"));
    await user.click(screen.getByRole("button", { name: /Run now/ }));
    expect(screen.getByRole("alertdialog").textContent).toMatch(/Slack isn't set up/);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    // The job's own target stays offered, so saving another field doesn't change it; a platform with no home channel can't be picked.
    const deliver = screen.getByLabelText("Deliver to") as HTMLSelectElement;
    expect(deliver.value).toBe("slack");
    expect((within(deliver).getByRole("option", { name: /Discord/ }) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByText("Slack isn't set up on this profile's gateway, so Hermes won't deliver there.")).toBeTruthy();
  });

  it("says when the dashboard doesn't allow reading or changing jobs", async () => {
    const s = server();
    const route = s.cron.route.bind(s.cron);
    let refuse = true;
    s.cron.route = (req) => (refuse && req.path === "/api/cron/jobs" ? () => Promise.reject(new RestError(403, '{"detail":"Forbidden"}')) : route(req));
    await launch(s);
    expect((await screen.findByRole("alert")).textContent).toBe("The dashboard doesn't allow this: Forbidden");
    expect(screen.queryByRole("button", { name: /New job/ })).toBeNull();
    cleanup();
    refuse = false;
    const t = server();
    const { user: u2 } = await launch(t);
    await u2.click(screen.getByText("[fixture] Weekday brief"));
    t.cron.failNext = { match: /pause$/, when: "before", message: new RestError(403, '{"detail":"Forbidden"}') };
    await u2.click(screen.getByRole("button", { name: /Pause/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("The dashboard doesn't allow this: Forbidden");
    expect(screen.getByRole("button", { name: /Pause/ })).toBeTruthy();
    expect(t.cron.jobs.default[0].enabled).toBe(true);
  });

  it("finds a job whose create answer was lost, without creating it twice", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByRole("button", { name: /New job/ }));
    await user.type(screen.getByPlaceholderText(/What Hermes should do/), "Fixture only.");
    await user.type(screen.getByPlaceholderText("every day at 9am"), "every 2h");
    await user.type(screen.getByPlaceholderText(/Named after the prompt/), "Fixture lost answer");
    // Hermes saved it, then the connection dropped before its answer came back.
    s.cron.failNext = { match: /^POST /, when: "after" };
    await user.click(screen.getByRole("button", { name: "Create job" }));
    await screen.findByRole("heading", { name: /Fixture lost answer/ });
    expect(writes(s)).toHaveLength(1);
    expect(s.cron.jobs.default.filter((j) => j.name === "Fixture lost answer")).toHaveLength(1);
  });

  it("keeps the last list read, with actions off, once disconnected", async () => {
    const s = server();
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    const view = render(<ScheduledJobs api={hermes.cron} profile="default" connected onClose={() => {}} />);
    expect(await screen.findByText("[fixture] Weekday brief")).toBeTruthy();
    view.rerender(<ScheduledJobs api={hermes.cron} profile="default" connected={false} onClose={() => {}} />);
    expect(screen.getByText(/Not connected to Hermes\. Jobs keep running on the server/).textContent).toMatch(/as it was last read/);
    expect((screen.getByRole("button", { name: /New job/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("[fixture] Weekday brief")).toBeTruthy();
  });

  it("creates a job in another profile, on that profile's clock, and never shows a superseded profile's settings", async () => {
    const s = server();
    const { user } = await launch(s);
    await user.click(screen.getByRole("button", { name: /New job/ }));
    const where = screen.getByLabelText("Profile") as HTMLSelectElement;
    await waitFor(() => expect(within(where).getAllByRole("option").map((o) => o.textContent)).toEqual(["default (this one)", "work"]));
    // Picking work, then back to default before work's settings arrive: work's late answer is dropped.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const route = s.cron.route.bind(s.cron);
    s.cron.route = (req) => {
      const handle = route(req);
      if (!handle || req.query.get("profile") !== "work" || req.path !== "/api/cron/jobs") return handle;
      return async () => {
        await held;
        return handle();
      };
    };
    await user.selectOptions(where, "work");
    expect(screen.getByText(/Reading that profile's settings/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create job" }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(where, "default");
    release();
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(screen.getByText(/the default profile's schedule time zone/)).toBeTruthy();
    s.cron.route = route;
    await user.selectOptions(where, "work");
    await screen.findByText(/the work profile's schedule time zone/);
    await user.type(screen.getByPlaceholderText(/What Hermes should do/), "Fixture only.");
    await user.type(screen.getByPlaceholderText("every day at 9am"), "every day at 7am");
    await user.type(screen.getByPlaceholderText(/Named after the prompt/), "Fixture in work");
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary.textContent).toMatch(/Profilework/);
    await user.click(screen.getByRole("button", { name: "Create job" }));
    expect(await screen.findByText(/Created “Fixture in work” in the work profile/)).toBeTruthy();
    expect(writes(s).map((w) => w.query.get("profile"))).toEqual(["work"]);
    expect(s.cron.jobs.work.map((j) => j.name)).toEqual(["Fixture in work"]);
    expect(screen.queryByText("Fixture in work")).toBeNull();
  });

  it("sums up a new job before it is saved, and sends nothing to test its delivery", async () => {
    const { user, s } = await launch();
    await user.click(screen.getByRole("button", { name: /New job/ }));
    expect(screen.queryByRole("region", { name: "Summary" })).toBeNull();
    await user.type(screen.getByPlaceholderText(/What Hermes should do/), "Fixture only.");
    await user.type(screen.getByPlaceholderText("every day at 9am"), "weekdays at 8:30am");
    await user.selectOptions(screen.getByLabelText("Deliver to"), "telegram");
    await user.type(screen.getByPlaceholderText("Leave empty to keep running"), "5");
    await user.click(screen.getByLabelText(/Create it paused/));
    const terms = Object.fromEntries(
      within(screen.getByRole("region", { name: "Summary" }))
        .getAllByRole("term")
        .map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]),
    );
    expect(terms).toEqual({
      Job: "Named by Hermes after its prompt",
      Profile: "default",
      Runs: "On weekdays at 8:30 AM, on the schedule time zone, America/Chicago",
      Stops: "After 5 runs",
      "Delivers to": "Telegram",
      Starts: "Paused: it won't run until resumed",
    });
    expect(screen.getByText(/Nothing is sent to try it/)).toBeTruthy();
    expect(s.restRequests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("says the schedule's time zone apart from this computer's, and what a clock change does", async () => {
    const s = server();
    s.cron.add("default", { name: "[fixture] Night", prompt: "Fixture only.", schedule: "30 2 * * *" });
    const { user } = await launch(s);
    await user.click(screen.getByText("[fixture] Night"));
    expect(screen.getByText(/^Schedule time zone: America\/Chicago\./)).toBeTruthy();
    expect(screen.getByText(/Clocks go (forward|back) an hour on/)).toBeTruthy();
  });

  it("puts focus back where the owner was", async () => {
    const { user } = await launch();
    await user.click(screen.getByText("[fixture] Weekday brief"));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "[fixture] Weekday brief" }));
    await user.click(screen.getByRole("button", { name: /Run now/ }));
    expect(document.activeElement).toBe(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Run now/ })));
    await user.click(screen.getByRole("button", { name: /Back to the jobs/ }));
    await waitFor(() => expect((document.activeElement as HTMLElement).dataset.jobId).toBe(screen.getByText("[fixture] Weekday brief").closest("button")!.dataset.jobId));
  });

  it("puts a change Hermes confirmed in the list, though the owner left the job before it landed", async () => {
    const { user, s } = await launch();
    let release!: () => void;
    s.cron.gate = new Promise<void>((r) => (release = r));
    await user.click(screen.getByText("[fixture] Weekday brief"));
    await user.click(screen.getByRole("button", { name: /Pause/ }));
    await user.click(screen.getByRole("button", { name: /Back to the jobs/ }));
    release();
    await waitFor(() => expect(within(screen.getByText("[fixture] Weekday brief").closest("button")!).queryByText("Paused")).toBeTruthy());
    s.cron.gate = new Promise<void>((r) => (release = r));
    await user.click(screen.getByText("[fixture] Weekday brief"));
    await user.click(within(document.querySelector<HTMLElement>(".jobs-screen")!).getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete job" }));
    await user.click(screen.getByRole("button", { name: /Back to the jobs/ }));
    release();
    await waitFor(() => expect(screen.queryByText("[fixture] Weekday brief")).toBeNull());
    expect(screen.getByRole("heading", { name: "Scheduled jobs" })).toBeTruthy();
  });

  it("keeps Hermes's own words for a failed delivery", async () => {
    const s = server();
    const id = s.cron.jobs.default[0].id;
    s.cron.runs[id] = [{ id: `cron_output:${id}:latest`, title: "DELIVERY FAILED · Telegram said: chat not found", preview: "Telegram said: chat not found", source: "cron_output", started_at: 1_793_800_000 }];
    const { user } = await launch(s);
    await user.click(screen.getByText("[fixture] Weekday brief"));
    const row = within(await screen.findByRole("list", { name: "Run history, newest first" })).getByRole("listitem");
    expect(row.textContent).toMatch(/Failed.*delivering its result failed: Telegram said: chat not found/);
  });

  it("says when the profile a new job goes in has no time zone Hermes Chat can name", async () => {
    const s = server();
    s.cron.timezones = { work: "" };
    const { user } = await launch(s);
    await user.click(screen.getByRole("button", { name: /New job/ }));
    const where = screen.getByLabelText("Profile") as HTMLSelectElement;
    await waitFor(() => expect(within(where).getAllByRole("option")).toHaveLength(2));
    await user.selectOptions(where, "work");
    expect(await screen.findByText(/Hermes uses the server's own time zone and doesn't name it/)).toBeTruthy();
    expect(screen.getByText(/^Times are shown in this computer's time zone/)).toBeTruthy();
    expect(screen.queryByText(/the work profile's schedule time zone/)).toBeNull();
    await user.type(screen.getByPlaceholderText(/What Hermes should do/), "Fixture only.");
    await user.type(screen.getByPlaceholderText("every day at 9am"), "every day at 7am");
    expect(screen.getByRole("region", { name: "Summary" }).textContent).toMatch(/can't confirm the work profile's own time zone/);
  });

  it("doesn't let a list read from before a change undo it", async () => {
    const { user, s } = await launch();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const route = s.cron.route.bind(s.cron);
    let arm = true;
    s.cron.route = (req) => {
      const handle = route(req);
      if (!handle || !arm || req.method !== "GET" || req.path !== "/api/cron/jobs") return handle;
      arm = false;
      // Hermes read the list before the pause below; its answer arrives after it.
      return async () => {
        const answer = await handle();
        await held;
        return answer;
      };
    };
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await user.click(screen.getByText("[fixture] Weekday brief"));
    await user.click(screen.getByRole("button", { name: /Pause/ }));
    await screen.findByRole("button", { name: /Resume/ });
    release();
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    expect(screen.getByRole("button", { name: /Resume/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Back to the jobs/ }));
    expect(within(screen.getByText("[fixture] Weekday brief").closest("button")!).getByText("Paused")).toBeTruthy();
  });

  it("reads a run's result again once the run has changed, and drops a read the owner hid", async () => {
    const s = server();
    const id = s.cron.jobs.default[0].id;
    s.cron.runs[id] = [{ id: "local-r", source: "cron", started_at: 1_793_800_000, ended_at: null, is_active: true, scheduler_owned: true, profile: "default" }];
    s.transcripts["local-r"] = [{ role: "user", text: "Fixture only.", row_id: 1 }];
    let release!: () => void;
    let held: Promise<void> | undefined = new Promise<void>((r) => (release = r));
    const { user } = await launch(s);
    // Hold the first read of the run's messages: it answers with the run as it was, after the run has finished.
    const realStored = (s as unknown as { storedMessages: (id: string, q: URLSearchParams) => unknown }).storedMessages.bind(s);
    (s as unknown as { storedMessages: (id: string, q: URLSearchParams) => unknown }).storedMessages = (mid, q) => {
      const answer = realStored(mid, q);
      const wait = held;
      held = undefined;
      return wait ? wait.then(() => answer) : answer;
    };
    await user.click(screen.getByText("[fixture] Weekday brief"));
    const history = await screen.findByRole("list", { name: "Run history, newest first" });
    await user.click(within(history).getByRole("button", { name: "Show the result" }));
    s.cron.runs[id] = [{ id: "local-r", source: "cron", started_at: 1_793_800_000, ended_at: 1_793_800_030, end_reason: "cron_complete", profile: "default" }];
    s.transcripts["local-r"].push({ role: "assistant", text: "[fixture] The finished reply.", row_id: 2 });
    await user.click(screen.getByRole("button", { name: /Refresh runs/ }));
    expect(await screen.findByText("[fixture] The finished reply.")).toBeTruthy();
    release();
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    expect(screen.getByText("[fixture] The finished reply.")).toBeTruthy();
    expect(screen.queryByText(/has no reply from the agent/)).toBeNull();
    // Hidden while still reading: the answer, when it comes, doesn't open it again.
    await user.click(screen.getByRole("button", { name: "Hide the result" }));
    held = new Promise<void>((r) => (release = r));
    await user.click(screen.getByRole("button", { name: "Show the result" }));
    await user.click(screen.getByRole("button", { name: "Hide the result" }));
    release();
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    expect(screen.queryByText("[fixture] The finished reply.")).toBeNull();
    expect(screen.getByRole("button", { name: "Show the result" })).toBeTruthy();
  });

  it("doesn't call a zone Hermes doesn't name the one it runs the jobs in", async () => {
    const s = server();
    s.cron.timezone = "";
    s.cron.jobs.default = [];
    await launch(s);
    expect(screen.getByText(/Times are shown in this computer's time zone, .*, which may not be the zone Hermes runs this profile's jobs in\./)).toBeTruthy();
    expect(screen.queryByText(/the schedule time zone Hermes runs/)).toBeNull();
    expect(screen.getByText(/Hermes uses the server's own time zone and doesn't name it/)).toBeTruthy();
  });

  it("gives focus back to New job when a new job is cancelled", async () => {
    const { user } = await launch();
    await user.click(screen.getByRole("button", { name: /New job/ }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "New scheduled job" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /New job/ })));
  });

  it("never shows a profile's jobs once another profile is current", async () => {
    const s = server();
    s.cron.add("work", { name: "[fixture] Work job", prompt: "Fixture only.", schedule: "0 8 * * *" });
    const hermes = await connect(s.openPipe);
    running.push(hermes);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const route = s.cron.route.bind(s.cron);
    s.cron.route = (req) => {
      const handle = route(req);
      if (!handle || req.query.get("profile") !== "default" || req.path !== "/api/cron/jobs") return handle;
      return async () => {
        const answer = await handle();
        await held;
        return answer;
      };
    };
    const view = render(<ScheduledJobs key="default" api={hermes.cron} profile="default" connected onClose={() => {}} />);
    view.rerender(<ScheduledJobs key="work" api={hermes.cron} profile="work" connected onClose={() => {}} />);
    expect(await screen.findByText("[fixture] Work job")).toBeTruthy();
    release();
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(screen.queryByText("[fixture] Weekday brief")).toBeNull();
    expect(screen.getByText("[fixture] Work job")).toBeTruthy();
  });

  it("shows the profile's own jobs after switching profile", async () => {
    const s = server();
    s.cron.add("work", { name: "[fixture] Work job", prompt: "Fixture only.", schedule: "0 8 * * *" });
    const { hermes } = await launch(s);
    await act(async () => void (await hermes.switchProfile("work")));
    expect(await screen.findByText("[fixture] Work job")).toBeTruthy();
    expect(screen.queryByText("[fixture] Weekday brief")).toBeNull();
  });
});

describe("Troubleshoot on the Scheduled jobs screen", () => {
  const creates = (s: FakeHermes) => s.requests.filter((q) => q.method === "session.create");
  const submitted = (s: FakeHermes) => s.requests.filter((q) => q.method === "prompt.submit").map((q) => String(q.params.text));
  const failedRun = (id: string, at = 1_793_800_000) => ({ id: `cron_output:${id}:1`, title: "FAILED · Script exited with code 3", preview: "boom", source: "cron_output", started_at: at });

  it("hands a job to Hermes in a new chat in the job's profile, then shows what changed and offers Run now", async () => {
    const s = server();
    const work = s.cron.add("work", { name: "[fixture] Work report", prompt: "Fixture only.", schedule: "0 8 * * *", deliver: "discord" });
    s.cron.runs[work.id] = [failedRun(work.id)];
    const { hermes, user } = await launch(s);
    await act(async () => void (await hermes.switchProfile("work")));
    await screen.findByText("[fixture] Work report");

    // The button is on each job in the list, and shows the message before anything is sent.
    await user.click(screen.getByRole("button", { name: "Troubleshoot [fixture] Work report" }));
    const preview = await screen.findByRole("region", { name: "Troubleshoot in a new chat" });
    const box = (await within(preview).findByRole("textbox", { name: "First message" })) as HTMLTextAreaElement;
    const text = box.value;
    expect(text).toMatch(/“\[fixture\] Work report” \(id `[^`]+`\) in the work profile/);
    expect(text).toMatch(/- Schedule: `0 8 \* \* \*`/);
    expect(text).toMatch(/- State: scheduled \(not paused\)/);
    expect(text).toMatch(/Discord has no home channel set on the server/);
    expect(text).toMatch(/### 1\. Failed\n- Script run/);
    expect(text).toMatch(/Script exited with code 3/);
    expect(within(preview).getByText(/new chat in the/).textContent).toMatch(/work profile, the job's/);
    expect(creates(s)).toHaveLength(0);

    await user.click(within(preview).getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(submitted(s)).toEqual([text]));
    // The chat started in the job's profile, and shows in place of the Jobs screen.
    expect(creates(s).map((q) => q.params.profile)).toEqual(["work"]);
    await waitFor(() => expect(document.querySelector(".jobs-screen")).toBeNull());
    const chat = hermes.getSnapshot().chats.find((c) => c.running)!;
    expect(chat).toBeTruthy();

    // Hermes fixes the job with its own cron tool, and its reply ends.
    const row = s.cron.jobs.work.find((j) => j.id === work.id)!;
    row.deliver = "telegram";
    row.prompt = "Fixture only, and say so.";
    act(() => s.event(s.runtimeIdOf(chat.id)!, "message.complete", { text: "Changed the delivery from discord to telegram." }));
    await user.click(await screen.findByRole("button", { name: "See what changed" }));

    const panel = await screen.findByRole("region", { name: "Troubleshooting" });
    expect(within(panel).getByText(/What changed on the job since the chat started/)).toBeTruthy();
    const changes = within(panel).getByRole("list", { name: "What changed" });
    expect(changes.textContent).toMatch(/Delivers to: discord → telegram/);
    expect(changes.textContent).toMatch(/Prompt changed:BeforeFixture only\.NowFixture only, and say so\./);
    // The app itself changed nothing on the job.
    expect(writes(s)).toHaveLength(0);
    await user.click(within(panel).getByRole("button", { name: "Run now to check the fix" }));
    expect(screen.getByRole("alertdialog", { name: "Run this job now?" })).toBeTruthy();
  }, 20_000);

  it("offers Troubleshoot on a failed run, and reads the job again when the chat's reply ends", async () => {
    const s = server();
    const id = s.cron.jobs.default[0].id;
    const at = 1_793_806_654;
    s.cron.runs[id] = [
      { id: "local-ok", source: "cron", started_at: at, ended_at: at + 80, end_reason: "cron_complete", profile: "default" },
      failedRun(id, at - 60),
    ];
    s.transcripts["local-ok"] = [
      { role: "user", text: "Fixture only.", row_id: 1 },
      { role: "assistant", text: "[fixture] Here is the weekday brief.", row_id: 2 },
    ];
    const { hermes, user } = await launch(s);
    await user.click(screen.getByText("[fixture] Weekday brief"));
    const history = await screen.findByRole("list", { name: "Run history, newest first" });
    const rows = within(history).getAllByRole("listitem");
    expect(within(rows[0]).queryByRole("button", { name: "Troubleshoot this run" })).toBeNull();
    await user.click(within(rows[1]).getByRole("button", { name: "Troubleshoot this run" }));
    const box = (await screen.findByRole("textbox", { name: "First message" })) as HTMLTextAreaElement;
    // Opened from far down the page, the preview takes focus, so it is where the owner is.
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Troubleshoot in a new chat" }));
    expect(box.value).toMatch(/### 2\. Failed \(the run I picked\)/);
    // An agent run's reply is read for the message, as Show the result reads it.
    expect(box.value).toMatch(/The agent's last reply:\n```text\n\[fixture\] Here is the weekday brief\./);
    // The owner can edit the message before it goes.
    await user.type(box, "\n\nIt started failing after I renamed the channel.");
    await user.click(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(submitted(s)).toHaveLength(1));
    expect(submitted(s)[0]).toMatch(/after I renamed the channel\.$/);
    expect(creates(s).map((q) => q.params.profile)).toEqual(["default"]);
    const chat = hermes.getSnapshot().chats.find((c) => c.running)!;

    // Back on the Jobs screen while Hermes works: the job says so.
    await user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
    expect((await screen.findByText("[fixture] Weekday brief")).closest("li")!.textContent).toMatch(/Hermes is troubleshooting this job in a chat/);
    await user.click(screen.getByText("[fixture] Weekday brief"));
    const panel = await screen.findByRole("region", { name: "Troubleshooting" });
    expect(within(panel).getByText(/Hermes is working on this job in a chat/)).toBeTruthy();

    const row = s.cron.jobs.default.find((j) => j.id === id)!;
    row.enabled = false;
    row.state = "paused";
    const lists = () => s.restRequests.filter((r) => r.method === "GET" && r.path === "/api/cron/jobs").length;
    const before = lists();
    act(() => s.event(s.runtimeIdOf(chat.id)!, "message.complete", { text: "Paused it." }));
    // Read again without the owner pressing Refresh, and no toast: the screen says it.
    await waitFor(() => expect(within(panel).getByRole("list", { name: "What changed" }).textContent).toMatch(/State: scheduled → paused/));
    expect(lists()).toBeGreaterThan(before);
    expect(screen.queryByRole("button", { name: "See what changed" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Open the chat" })).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Troubleshooting" })).toBeNull();
    expect(writes(s)).toHaveLength(0);
  }, 20_000);

  it("says what changed only once the job was read after the reply ended, and offers to try again when it couldn't be", async () => {
    const s = server();
    const id = s.cron.jobs.default[0].id;
    const { hermes, user } = await launch(s);
    await user.click(screen.getByRole("button", { name: "Troubleshoot [fixture] Weekday brief" }));
    await user.click(await screen.findByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(submitted(s)).toHaveLength(1));
    const chat = hermes.getSnapshot().chats.find((c) => c.running)!;
    await user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
    await user.click(await screen.findByText("[fixture] Weekday brief"));
    const panel = await screen.findByRole("region", { name: "Troubleshooting" });
    s.cron.jobs.default.find((j) => j.id === id)!.deliver = "local";

    // A slow read: until it answers, the panel says nothing about what changed and offers no Run now.
    let answer!: () => void;
    s.cron.listGate = new Promise((r) => (answer = r));
    act(() => s.event(s.runtimeIdOf(chat.id)!, "message.complete", { text: "Done." }));
    expect(await within(panel).findByText(/Reading the job again/)).toBeTruthy();
    expect(within(panel).queryByRole("list", { name: "What changed" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Run now to check the fix" })).toBeNull();

    // It fails.
    s.cron.failLists = 99;
    s.cron.listGate = undefined;
    act(() => answer());
    expect(await within(panel).findByText(/couldn't be read again: .*connection reset/)).toBeTruthy();
    expect(within(panel).queryByRole("list", { name: "What changed" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Run now to check the fix" })).toBeNull();

    s.cron.failLists = 0;
    await user.click(within(panel).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(panel).getByRole("list", { name: "What changed" }).textContent).toMatch(/Delivers to: telegram → local/));
    expect(within(panel).getByRole("button", { name: "Run now to check the fix" })).toBeTruthy();
  }, 20_000);

  it("reads the job again while Hermes works, and still follows the reply to its end", async () => {
    const s = server();
    const id = s.cron.jobs.default[0].id;
    const { hermes, user } = await launch(s);
    await user.click(screen.getByRole("button", { name: "Troubleshoot [fixture] Weekday brief" }));
    await user.click(await screen.findByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(submitted(s)).toHaveLength(1));
    const chat = hermes.getSnapshot().chats.find((c) => c.running)!;
    await user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
    await user.click(await screen.findByText("[fixture] Weekday brief"));
    const panel = await screen.findByRole("region", { name: "Troubleshooting" });
    const row = s.cron.jobs.default.find((j) => j.id === id)!;

    row.deliver = "local";
    await user.click(within(panel).getByRole("button", { name: "Read the job again" }));
    await waitFor(() => expect(within(panel).getByRole("list", { name: "What changed" }).textContent).toMatch(/Delivers to: telegram → local/));
    expect(within(panel).getByText("Changes so far, as the job was last read:")).toBeTruthy();
    expect(within(panel).getByText(/Hermes is working on this job/)).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Run now to check the fix" })).toBeNull();

    // Hermes changes more, and its reply ends: the screen reads the job again by itself.
    row.prompt = "Fixture only, and changed again.";
    act(() => s.event(s.runtimeIdOf(chat.id)!, "message.complete", { text: "Done." }));
    await waitFor(() => expect(within(panel).getByText(/What changed on the job since the chat started/)).toBeTruthy());
    expect(within(panel).getByRole("list", { name: "What changed" }).textContent).toMatch(/Prompt changed/);
    expect(within(panel).getByRole("button", { name: "Run now to check the fix" })).toBeTruthy();
  }, 20_000);

  it("says when nothing on the job changed", async () => {
    const s = server();
    const { hermes, user } = await launch(s);
    await user.click(screen.getByText("[fixture] Weekday brief"));
    await user.click(await screen.findByRole("button", { name: "Troubleshoot" }));
    await user.click(await screen.findByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(submitted(s)).toHaveLength(1));
    expect(submitted(s)[0]).toMatch(/Hermes has no runs of this job on record\./);
    const chat = hermes.getSnapshot().chats.find((c) => c.running)!;
    act(() => s.event(s.runtimeIdOf(chat.id)!, "message.complete", { text: "Nothing to fix." }));
    await user.click(await screen.findByRole("button", { name: "See what changed" }));
    const panel = await screen.findByRole("region", { name: "Troubleshooting" });
    expect(within(panel).getByText(/Nothing on the job has changed since the chat started/)).toBeTruthy();
  }, 20_000);

  it("starts nothing when Hermes refuses the chat's first message, and says why", async () => {
    const s = server();
    s.rejectPrompt = { code: 4009, message: "session busy" };
    const { user } = await launch(s);
    await user.click(screen.getByText("[fixture] Weekday brief"));
    await user.click(await screen.findByRole("button", { name: "Troubleshoot" }));
    await user.click(await screen.findByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(creates(s)).toHaveLength(1));
    s.rejectPrompt = undefined;
    await user.click(screen.getByRole("button", { name: "Scheduled jobs" }));
    expect((await screen.findByText("[fixture] Weekday brief")).closest("li")!.textContent).toMatch(/Troubleshooting didn't start/);
    await user.click(screen.getByText("[fixture] Weekday brief"));
    expect(within(await screen.findByRole("region", { name: "Troubleshooting" })).getByRole("alert").textContent).toMatch(/session busy/);
  }, 20_000);
});

