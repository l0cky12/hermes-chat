// @vitest-environment jsdom
// Settings → Profiles is a converted screen (ADR 0100): every word on it, in the states it shows, comes from the
// catalogue. Rendered under the pseudo-locale, which marks each catalogue string, so a literal left in stands out.
// Profile names, descriptions and models are data, marked translate="no". All data is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it } from "vitest";
import { LocaleContext } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import { FakeHermes } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { ProfileSettings, type ProfilesWiring } from "./ProfileSettings";
import { SettingsSearching } from "./SettingRows";

beforeAll(() => {
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const p = pseudoLocale();

it("shows only catalogue words in the list, its menu, New, Edit and Delete", async () => {
  const server = new FakeHermes();
  server.otherProfiles = { work: [] };
  server.profileModel.work = { model: "gpt-6.1", provider: "openai", reasoning_effort: "medium", fast: false };
  server.profileMeta.work = { description: "Writes code", description_auto: true };
  server.profileMeta.default = { display_name: "Main" };
  server.gatewaysRunning.add("work");
  server.distributions.work = "coders";
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  await hermes.sync();
  const wiring: ProfilesWiring = {
    api: hermes.manageProfiles,
    inUse: "default",
    connected: true,
    unread: (n) => (n === "work" ? 2 : undefined),
    catalog: async () => [{ slug: "openai", name: "OpenAI", models: ["gpt-6.1"], caps: {} }],
    busy: () => ({ kind: "queue" }),
    lostMessages: () => 2,
    jobCount: async () => 1,
    switchTo: async () => true,
    local: { pending: () => ({ from: "old", to: "work" }), note: () => {}, clear: () => {}, renamed: async () => {}, deleted: async () => {} },
    showTab: () => {},
    copyText: async () => {},
  };
  const user = userEvent.setup();
  render(
    <LocaleContext value={p}>
      <SettingsSearching.Provider value={true}>
        <ProfileSettings wiring={wiring} />
      </SettingsSearching.Provider>
    </LocaleContext>,
  );
  const list = await screen.findByRole("listbox", { name: p.profiles.list });
  await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(2));
  // The move offer for a rename the app closed in the middle of shows too.
  expect(screen.getByText(p.profiles.moveOffer("old", "work"), { exact: false })).toBeTruthy();
  expect(untranslated(document.body)).toEqual([]);

  await user.click(within(list).getByRole("button", { name: p.profiles.actionsOf("default") }));
  expect(screen.getByRole("menu")).toBeTruthy();
  expect(untranslated(document.body)).toEqual([]);
  await user.keyboard("{Escape}");

  await user.click(screen.getByRole("button", { name: p.profiles.newProfile }));
  const create = screen.getByRole("dialog");
  await user.type(within(create).getByLabelText(p.profiles.form.name), "work");
  expect(untranslated(document.body)).toEqual([]);
  await user.click(within(create).getByRole("button", { name: p.common.cancel }));
  expect(untranslated(document.body)).toEqual([]);
  await user.click(screen.getByRole("button", { name: p.profiles.form.discard }));

  await user.click(within(list).getByRole("button", { name: p.profiles.editOf("work") }));
  const edit = screen.getByRole("dialog");
  await user.clear(within(edit).getByLabelText(p.profiles.form.name));
  await user.type(within(edit).getByLabelText(p.profiles.form.name), "coder");
  expect(untranslated(document.body)).toEqual([]);
  await user.click(within(edit).getByRole("button", { name: p.common.cancel }));
  await user.click(screen.getByRole("button", { name: p.profiles.form.discard }));

  await user.click(within(list).getByRole("button", { name: p.profiles.actionsOf("work") }));
  await user.click(screen.getByRole("menuitem", { name: p.profiles.menu.delete }));
  const del = screen.getByRole("alertdialog");
  await waitFor(() => expect(within(del).getByText(p.profiles.del.jobsCount(1))).toBeTruthy());
  expect(untranslated(document.body)).toEqual([]);
  await act(async () => {});
});
