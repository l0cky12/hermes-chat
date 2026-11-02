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
  await waitFor(() => expect(document.querySelector(".jobs-screen")?.textContent).not.toMatch(/Loading the jobs/));
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
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This Hermes server has no scheduled jobs. Updating Hermes adds them.");
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

  it("shows the profile's own jobs after switching profile", async () => {
    const s = server();
    s.cron.add("work", { name: "[fixture] Work job", prompt: "Fixture only.", schedule: "0 8 * * *" });
    const { hermes } = await launch(s);
    await act(async () => void (await hermes.switchProfile("work")));
    expect(await screen.findByText("[fixture] Work job")).toBeTruthy();
    expect(screen.queryByText("[fixture] Weekday brief")).toBeNull();
  });
});
