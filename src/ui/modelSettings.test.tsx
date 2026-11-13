// @vitest-environment jsdom
// Settings → Model on screen, against the fake dashboard: the draft, Apply, the guardrails, and leaving Settings.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// Vitest empties a CSS import, ?raw included.
import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { appearanceStore } from "./appearance";
import { SettingsScreen } from "./Settings";

afterEach(cleanup);

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

/** The app around Settings: Back to chat closes it, and it can be opened again. */
function Shell({ hermes }: { hermes: Hermes }) {
  const [open, setOpen] = useState(true);
  const [appearance] = useState(() => appearanceStore(memoryStorage(), document.createElement("html")));
  if (!open) return <button onClick={() => setOpen(true)}>Open Settings</button>;
  return (
    <SettingsScreen
      status="connected"
      unsecure={false}
      username="liam"
      passwordSaved
      profile="default"
      olderPulled={false}
      cacheBytes={() => 0}
      appearance={appearance}
      listFonts={async () => ({ all: [], mono: [] })}
      modelSettings={hermes.modelSettings}
      onClearCache={() => {}}
      onPullOlder={async () => []}
      onSignOut={async () => {}}
      onClose={() => setOpen(false)}
    />
  );
}

/** `setup` changes what the fake dashboard has before Settings reads it. */
async function shown(setup?: (server: FakeHermes) => void) {
  const server = new FakeHermes();
  setup?.(server);
  const hermes = await connect(server.openPipe, "default");
  const user = userEvent.setup();
  render(<Shell hermes={hermes} />);
  await user.click(screen.getByRole("tab", { name: /Model/ }));
  await screen.findByRole("combobox", { name: "Main provider" });
  return { server, user };
}

const select = (name: string) => screen.getByRole<HTMLSelectElement>("combobox", { name });
/** A model field is a search box over the provider's models, not a <select>: it opens on a click and lists options. */
async function pickModel(user: ReturnType<typeof userEvent.setup>, name: string, model: string) {
  await user.click(select(name));
  await user.click(within(screen.getByRole("listbox", { name })).getByRole("option", { name: model }));
}
const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET").map((r) => [`${r.method} ${r.path}`, r.body]);

describe("Settings → Model", () => {
  it("shows the main model, subagents, auxiliary models and guardrails as Hermes has them", async () => {
    await shown();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(
      expect.arrayContaining(["Main model", "Subagents", "Auxiliary models", "Idle compaction"]),
    );
    // The guardrails are the page header's summary box (ADR 0159): one line, with the checks under "Safety checks".
    const guard = document.querySelector<HTMLElement>("header.page-head section.applies-box")!;
    expect(guard.querySelector(".applies-line")!.textContent).toBe("Hermes checks pinned helpers and the price before it switches the main model.");
    expect(guard.querySelector(".applies-more")!.textContent!.trim()).toBe("Safety checks");
    expect(select("Main provider").value).toBe("openrouter");
    expect(select("Main model").value).toBe("z-ai/glm-5.3-flash");
    expect(select("Main reasoning effort").value).toBe("high");
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Fast mode" }).checked).toBe(false);
    expect(select("Subagent route").value).toBe("inherit");
    expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Subagent turn limit" }).value).toBe("50");
    expect(select("Compression provider").value).toBe("openrouter");
    expect(select("Compression effort").value).toBe("inherit");
    expect(select("Approval checks provider").value).toBe("auto");
    expect(select("Approval checks effort").value).toBe("none");
    expect(within(guard).getByText(/Text generation, Compression and Vision are pinned to OpenRouter/)).toBeTruthy();
  });

  it("keeps the pickers' text in view: the form-field select style leaves .select's padding alone", async () => {
    // .select is 32px tall with no vertical padding. The setup form's field rule padded every select in a field 8px top
    // and bottom, which cut the text in the Model page's pickers down to a sliver.
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync("src/styles.css", "utf8") as string;
    document.head.append(sheet);
    try {
      await shown();
      for (const name of ["Main provider", "Main model", "Main reasoning effort"]) expect(select(name).closest(".set-control")).toBeTruthy();
      for (const s of screen.getAllByRole<HTMLSelectElement>("combobox")) {
        expect([s.getAttribute("aria-label"), getComputedStyle(s).height, getComputedStyle(s).paddingTop, getComputedStyle(s).paddingBottom]).toEqual([
          s.getAttribute("aria-label"),
          "32px",
          "0px",
          "0px",
        ]);
      }
    } finally {
      sheet.remove();
    }
  });

  it("can't apply a provider switch until a model is picked for the new provider", async () => {
    const { user } = await shown();
    await user.selectOptions(select("Main provider"), "nous");
    expect(select("Main model").value).toBe("");
    expect(screen.getByText("Choose a model for nous.")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply main model" }).disabled).toBe(true);
    await pickModel(user, "Main model", "hermes-5-70b");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply main model" }).disabled).toBe(false);
  });
});

describe("A model field searches the provider's models (#538)", () => {
  const listed = (name: string) => within(screen.getByRole("listbox", { name })).getAllByRole("option").map((o) => o.textContent);
  const active = (name: string) => within(screen.getByRole("listbox", { name })).getByRole("option", { selected: true }).textContent;

  it("narrows the list as you type; the arrow keys and Enter pick, and nothing is written until Apply", async () => {
    const { server, user } = await shown();
    const field = select("Main model");
    await user.click(field);
    expect(listed("Main model")).toEqual(["z-ai/glm-5.3-flash", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "google/gemini-3.7-flash", "anthropic/claude-fable-5.1"]);
    expect(active("Main model")).toBe("z-ai/glm-5.3-flash");

    await user.type(field, "V4 deep");
    expect(listed("Main model")).toEqual(["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"]);
    await user.keyboard("{ArrowDown}");
    expect(active("Main model")).toBe("deepseek/deepseek-v4-pro");
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field.getAttribute("aria-expanded")).toBe("false");
    expect(field.value).toBe("deepseek/deepseek-v4-pro");
    expect(screen.getByText("Not applied yet. Leaving Settings drops it.")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply main model" }).disabled).toBe(false);
    expect(writes(server)).toEqual([]);
  });

  it("scrolls the first match into view as typing narrows the list, even when it's still the first row", async () => {
    const { user } = await shown();
    const scrolled: string[] = [];
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      const field = select("Main model");
      await user.click(field);
      expect(scrolled).toEqual(["z-ai/glm-5.3-flash"]);
      await user.keyboard("d");
      expect(listed("Main model")[0]).toBe("deepseek/deepseek-v4-flash");
      expect(scrolled[scrolled.length - 1]).toBe("deepseek/deepseek-v4-flash");
    } finally {
      Element.prototype.scrollIntoView = was;
    }
  });

  it("opens from the keyboard on the model in use, and Escape closes it without changing anything", async () => {
    const { user } = await shown();
    const field = select("Main model");
    field.focus();
    await user.keyboard("{ArrowDown}");
    expect(active("Main model")).toBe("z-ai/glm-5.3-flash");
    await user.keyboard("{ArrowUp}");
    expect(active("Main model")).toBe("anthropic/claude-fable-5.1");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field.value).toBe("z-ai/glm-5.3-flash");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply main model" }).disabled).toBe(true);
  });

  /** The open list, found as assistive technology finds it: by the field's aria-controls. */
  const popup = (field: HTMLElement) => {
    const list = document.getElementById(field.getAttribute("aria-controls") ?? "");
    expect(list?.getAttribute("role")).toBe("listbox");
    return list!;
  };

  it("starts a new search when typing right after a pick or Escape, without another click", async () => {
    const { user } = await shown();
    const field = select("Main model");
    await user.click(field);
    await user.keyboard("pro{Enter}");
    expect(field.value).toBe("deepseek/deepseek-v4-pro");
    await user.keyboard("gem");
    expect(listed("Main model")).toEqual(["google/gemini-3.7-flash"]);
    await user.keyboard("{Escape}");
    expect(field.value).toBe("deepseek/deepseek-v4-pro");
    await user.keyboard("glm{Enter}");
    expect(field.value).toBe("z-ai/glm-5.3-flash");
  });

  it("says when no model matches, keeping the empty list the field points at, and Enter then picks nothing", async () => {
    const { user } = await shown();
    const field = select("Compression model");
    await user.type(field, "no such model");
    expect(within(popup(field)).queryAllByRole("option")).toEqual([]);
    expect(within(field.closest(".model-combo")!).getByRole("status").textContent).toBe("No models match.");
    await user.keyboard("{Enter}{Escape}");
    expect(field.value).toBe("deepseek/deepseek-v4-flash");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply auxiliary models" }).disabled).toBe(true);
  });

  it("says when the provider lists no models", async () => {
    const { user } = await shown((server) => server.modelConfig.catalog.push({ slug: "bare", name: "Bare", models: [], capabilities: {} }));
    await user.selectOptions(select("Main provider"), "bare");
    const field = select("Main model");
    await user.click(field);
    expect(within(popup(field)).queryAllByRole("option")).toEqual([]);
    expect(within(field.closest(".model-combo")!).getByRole("status").textContent).toBe("This provider lists no models.");
  });

  it("shows a saved model the provider no longer lists, and keeps it on offer", async () => {
    const { user } = await shown((server) => (server.modelConfig.model.default = "z-ai/glm-4-retired"));
    const field = select("Main model");
    expect(field.value).toBe("z-ai/glm-4-retired");
    await user.click(field);
    expect(listed("Main model")[0]).toBe("z-ai/glm-4-retiredNot listed now");
    expect(active("Main model")).toBe("z-ai/glm-4-retiredNot listed now");
    await user.type(field, "glm");
    expect(listed("Main model")).toEqual(["z-ai/glm-4-retiredNot listed now", "z-ai/glm-5.3-flash"]);
  });

  it("searches the subagent's model too, among the main provider's models for a custom model", async () => {
    const { user } = await shown();
    await user.selectOptions(select("Subagent route"), "custom-model");
    const field = select("Subagent model");
    await user.type(field, "gemini");
    expect(listed("Subagent model")).toEqual(["google/gemini-3.7-flash"]);
    await user.keyboard("{Enter}");
    expect(field.value).toBe("google/gemini-3.7-flash");
  });
});

describe("Settings → Model as cards of rows (#174, ADR 0059)", () => {
  const section = (heading: string) => screen.getByRole("heading", { name: heading, level: 2 }).closest("section")!;
  /** The card a control sits in, and whether it is a row's control there. */
  const inRow = (el: Element, heading: string) => !!el.closest(".set-row > .set-control") && el.closest(".set-card") === section(heading).querySelector(".set-card");

  it("turns Fast mode on from its words as well as its box", async () => {
    const { user } = await shown();
    // The one model the stand-in gives a fast mode.
    await user.selectOptions(select("Main provider"), "openai-codex");
    await pickModel(user, "Main model", "gpt-6.1-sol");
    const box = screen.getByRole<HTMLInputElement>("checkbox", { name: "Fast mode" });
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(false);
    await user.click(screen.getByText("Fast mode", { selector: "label" }));
    expect(box.checked).toBe(true);
  });

  it("puts each setting in a row of its section's card, with Apply on the card's last line", async () => {
    await shown();
    for (const heading of ["Main model", "Text generation", "Subagents", "Auxiliary models", "Idle compaction"])
      expect(section(heading).querySelector(":scope > .set-card")).toBeTruthy();
    // The guardrails are rows of a card in the header's summary box (ADR 0159).
    const guards = document.querySelectorAll("header.page-head .applies-box details > .set-card > .set-row.model-guard");
    expect(guards.length).toBeGreaterThan(0);
    for (const name of ["Main provider", "Main model", "Main reasoning effort"]) expect(inRow(select(name), "Main model")).toBe(true);
    expect(inRow(screen.getByRole("checkbox", { name: "Fast mode" }), "Main model")).toBe(true);
    for (const name of ["Subagent route", "Subagent reasoning effort"]) expect(inRow(select(name), "Subagents")).toBe(true);
    for (const name of ["Subagent turn limit", "Subagent concurrency", "Subagent timeout in seconds"])
      expect(inRow(screen.getByRole("spinbutton", { name }), "Subagents")).toBe(true);
    for (const name of ["Compression provider", "Compression model", "Compression effort"]) expect(inRow(select(name), "Auxiliary models")).toBe(true);
    expect(inRow(screen.getByRole("button", { name: /^Model:/ }), "Text generation")).toBe(true);
    expect(inRow(screen.getByRole("switch", { name: "Compact idle chats" }), "Idle compaction")).toBe(true);
    for (const [part, heading] of [
      ["main model", "Main model"],
      ["subagent", "Subagents"],
      ["auxiliary models", "Auxiliary models"],
    ]) {
      const apply = screen.getByRole("button", { name: `Apply ${part}` });
      expect(apply.closest(".set-card > .set-note")).toBe(section(heading).querySelector(".set-card > .set-note:last-child"));
    }
  });

  it("folds only explanation: states, problems and what leaving drops stay in view", async () => {
    const { user } = await shown();
    const visible = (text: RegExp) => !screen.getByText(text).closest("[hidden], details:not([open])");
    // Each part's state says that a change waits here, beside its Apply.
    const states = screen.getAllByText("Same as Hermes. Changes wait here until you apply them.");
    expect(states).toHaveLength(3);
    for (const state of states) expect(state.closest("[hidden], details:not([open])")).toBeNull();
    expect(visible(/Subagents run on the main agent's provider and model/)).toBe(true);
    await user.selectOptions(select("Main provider"), "nous");
    expect(visible(/^Choose a model for nous\.$/)).toBe(true);
    await pickModel(user, "Main model", "hermes-5-70b");
    expect(visible(/^Not applied yet\. Leaving Settings drops it\.$/)).toBe(true);
    // Nothing on the tab is folded but the help behind an (i), and the safety checks behind the header's summary line.
    for (const fold of screen.getByRole("tabpanel").querySelectorAll("[hidden]")) expect(fold.classList.contains("set-more")).toBe(true);
    const folds = screen.getByRole("tabpanel").querySelectorAll("details");
    expect([...folds].map((d) => d.closest("section")?.className)).toEqual(["applies-box"]);
    expect(screen.getByText(/Text generation, Compression and Vision are pinned to OpenRouter/).closest("details")).toBe(folds[0]);
  });

  it("keeps the longer help behind an (i), opened by a search that finds words in it", async () => {
    const { user } = await shown();
    for (const [about, words] of [
      ["About Text generation model", "other Hermes clients use it too"],
      ["About Compact idle chats", "prompt cache has gone cold"],
    ]) {
      const button = screen.getByRole("button", { name: about });
      const help = document.getElementById(button.getAttribute("aria-controls")!)!;
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(help.hidden).toBe(true);
      expect(help.textContent).toContain(words);
    }
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "prompt cache");
    await waitFor(() => expect(section("Idle compaction").hasAttribute("data-search-miss")).toBe(false));
    expect(section("Main model").hasAttribute("data-search-miss")).toBe(true);
    const about = screen.getByRole("button", { name: "About Compact idle chats" });
    expect(about.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(about.getAttribute("aria-controls")!)!.hidden).toBe(false);
  });
});

describe("Leaving Settings", () => {
  it("drops the draft silently: nothing is written, and reopening shows what Hermes has", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Main provider"), "nous");
    await pickModel(user, "Main model", "hermes-5-70b");
    await user.selectOptions(select("Subagent route"), "custom-model");
    await user.clear(screen.getByRole("spinbutton", { name: "Subagent turn limit" }));
    await user.type(screen.getByRole("spinbutton", { name: "Subagent turn limit" }), "99");
    await user.selectOptions(select("Compression effort"), "none");

    await user.click(screen.getByRole("button", { name: /Back to chat/ }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes(server)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    await user.click(screen.getByRole("tab", { name: /Model/ }));
    await screen.findByRole("combobox", { name: "Main provider" });
    expect(select("Main provider").value).toBe("openrouter");
    expect(select("Main model").value).toBe("z-ai/glm-5.3-flash");
    expect(select("Subagent route").value).toBe("inherit");
    expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Subagent turn limit" }).value).toBe("50");
    expect(select("Compression effort").value).toBe("inherit");
    expect(writes(server)).toEqual([]);
  });
});

describe("Guardrail: helper tasks pinned to another provider", () => {
  it("asks before the main model moves off their provider; Cancel writes nothing, Apply anyway applies", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Main provider"), "nous");
    await pickModel(user, "Main model", "hermes-5-70b");
    await user.click(screen.getByRole("button", { name: "Apply main model" }));

    const ask = screen.getByRole("alertdialog", { name: "Auxiliary models still pinned" });
    expect(ask.textContent).toContain("Auxiliary models still pinned to OpenRouter — apply anyway?");
    expect(ask.textContent).toContain("Text generation, Compression and Vision will keep running there");
    expect(writes(server)).toEqual([]);

    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes(server)).toEqual([]);
    expect(select("Main provider").value).toBe("nous");

    await user.click(screen.getByRole("button", { name: "Apply main model" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Apply anyway" }));
    await screen.findByText("Applied. New chats use it.");
    expect(writes(server)).toEqual([["POST /api/model/set", { scope: "main", provider: "nous", model: "hermes-5-70b" }]]);
    expect(server.modelConfig.model).toEqual({ provider: "nous", default: "hermes-5-70b" });
  });

  it("doesn't ask when the main model stays on the provider they're pinned to", async () => {
    const { server, user } = await shown();
    await pickModel(user, "Main model", "deepseek/deepseek-v4-pro");
    await user.click(screen.getByRole("button", { name: "Apply main model" }));
    await screen.findByText("Applied. New chats use it.");
    expect(writes(server)).toEqual([["POST /api/model/set", { scope: "main", provider: "openrouter", model: "deepseek/deepseek-v4-pro" }]]);
  });
});

describe("Guardrail: a model Hermes flags as expensive", () => {
  it("Keep current writes nothing and puts the current model back", async () => {
    const { server, user } = await shown();
    await pickModel(user, "Main model", "anthropic/claude-fable-5.1");
    await user.click(screen.getByRole("button", { name: "Apply main model" }));

    const ask = await screen.findByRole("alertdialog", { name: "Expensive model" });
    expect(ask.textContent).toContain("Switch the main model to anthropic/claude-fable-5.1?");
    expect(ask.textContent).toContain("has known pricing above Hermes' safety threshold.");
    expect(ask.textContent).toContain("Output tokens: $150.00/M");
    expect(server.modelConfig.model.default).toBe("z-ai/glm-5.3-flash");

    await user.click(within(ask).getByRole("button", { name: "Keep current" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(select("Main model").value).toBe("z-ai/glm-5.3-flash");
    expect(server.modelConfig.model.default).toBe("z-ai/glm-5.3-flash");
    // Only the refused request went out; Hermes wrote nothing for it.
    expect(writes(server)).toEqual([["POST /api/model/set", { scope: "main", provider: "openrouter", model: "anthropic/claude-fable-5.1" }]]);
  });

  it("Switch anyway applies it", async () => {
    const { server, user } = await shown();
    await pickModel(user, "Main model", "anthropic/claude-fable-5.1");
    await user.click(screen.getByRole("button", { name: "Apply main model" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Switch anyway" }));
    await screen.findByText("Applied. New chats use it.");
    expect(server.modelConfig.model.default).toBe("anthropic/claude-fable-5.1");
    expect(writes(server).at(-1)).toEqual([
      "POST /api/model/set",
      { scope: "main", provider: "openrouter", model: "anthropic/claude-fable-5.1", confirm_expensive_model: true },
    ]);
  });
});

describe("Guardrail: an expensive helper model", () => {
  it("asks too; Keep current puts the task's model back, Switch anyway sets it", async () => {
    const { server, user } = await shown();
    await pickModel(user, "Compression model", "anthropic/claude-fable-5.1");
    await user.click(screen.getByRole("button", { name: "Apply auxiliary models" }));
    let ask = await screen.findByRole("alertdialog", { name: "Expensive model" });
    expect(ask.textContent).toContain("Use anthropic/claude-fable-5.1 for Compression?");
    await user.click(within(ask).getByRole("button", { name: "Keep current" }));
    expect(select("Compression model").value).toBe("deepseek/deepseek-v4-flash");
    expect(server.modelConfig.auxiliary.compression.model).toBe("deepseek/deepseek-v4-flash");

    await pickModel(user, "Compression model", "anthropic/claude-fable-5.1");
    await user.click(screen.getByRole("button", { name: "Apply auxiliary models" }));
    ask = await screen.findByRole("alertdialog", { name: "Expensive model" });
    await user.click(within(ask).getByRole("button", { name: "Switch anyway" }));
    await waitFor(() => expect(server.modelConfig.auxiliary.compression.model).toBe("anthropic/claude-fable-5.1"));
  });
});

describe("Subagents and auxiliary models", () => {
  it("Use parent model asks for a provider and writes that alone", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Subagent route"), "parent-model");
    expect(screen.getByText("Choose the subagent provider.")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Subagent model" })).toBeNull();
    await user.selectOptions(select("Subagent provider"), "nous");
    await user.click(screen.getByRole("button", { name: "Apply subagent" }));
    await waitFor(() => expect(server.modelConfig.delegation).toMatchObject({ provider: "nous", model: "" }));
    expect(writes(server)).toEqual([["PUT /api/config", { config: { delegation: { provider: "nous" } } }]]);
  });

  it("applies a helper task's own model and Off effort, leaving the main model's draft alone", async () => {
    const { server, user } = await shown();
    await user.selectOptions(select("Main reasoning effort"), "low");
    await user.selectOptions(select("Compression provider"), "openai-codex");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply auxiliary models" }).disabled).toBe(true);
    await pickModel(user, "Compression model", "gpt-6.1-mini");
    await user.selectOptions(select("Compression effort"), "none");
    await user.click(screen.getByRole("button", { name: "Apply auxiliary models" }));
    await waitFor(() => expect(server.modelConfig.auxiliary.compression).toEqual({ provider: "openai-codex", model: "gpt-6.1-mini", reasoning_effort: "none" }));
    expect(select("Main reasoning effort").value).toBe("low");
    expect(server.modelConfig.agent.reasoning_effort).toBe("high");
  });
});

describe("Text generation model", () => {
  const card = () => screen.getByRole("group", { name: "Text generation model" });

  it("is picked like a chat's model and written at once, and the helper list no longer shows it", async () => {
    const { server, user } = await shown();
    expect(within(card()).getByRole("button", { name: "Model: deepseek/deepseek-v4-flash" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Text generation" })).toBeNull();

    await user.click(within(card()).getByRole("button", { name: /^Model:/ }));
    await user.click(await within(card()).findByRole("button", { name: /^google\/gemini-3.7-flash/ }));

    await waitFor(() => expect(server.modelConfig.auxiliary.title_generation).toEqual({ provider: "openrouter", model: "google/gemini-3.7-flash" }));
    expect(writes(server)).toEqual([
      ["POST /api/model/set", { scope: "auxiliary", task: "title_generation", provider: "openrouter", model: "google/gemini-3.7-flash", reasoning_effort: null }],
    ]);
    expect(await within(card()).findByRole("button", { name: "Model: google/gemini-3.7-flash" })).toBeTruthy();
    // Another helper task's draft is untouched, so there's nothing to apply.
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply auxiliary models" }).disabled).toBe(true);
  });

  it("sets its reasoning effort from the pill", async () => {
    const { server, user } = await shown();
    await user.click(await within(card()).findByRole("button", { name: /^Reasoning effort:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Low" }));
    await waitFor(() => expect(server.modelConfig.auxiliary.title_generation.reasoning_effort).toBe("low"));
  });

  it("goes back to the main model with reset", async () => {
    const { server, user } = await shown();
    await user.click(within(card()).getByRole("button", { name: "Use the main model for text generation" }));
    await waitFor(() => expect(server.modelConfig.auxiliary.title_generation).toEqual({ provider: "auto", model: "" }));
    expect(await within(card()).findByText(/Until you pick one, it's the main model, z-ai\/glm-5.3-flash/)).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Use the main model for text generation" })).toBeNull();
  });

  it("asks before an expensive model, and Keep current writes nothing", async () => {
    const { server, user } = await shown();
    await user.click(within(card()).getByRole("button", { name: /^Model:/ }));
    await user.click(within(await within(card()).findByRole("group", { name: "OpenRouter" })).getByRole("button", { name: /^anthropic\/claude-fable-5.1/ }));
    const ask = await screen.findByRole("alertdialog", { name: "Expensive model" });
    expect(ask.textContent).toContain("Use anthropic/claude-fable-5.1 for text generation?");
    await user.click(within(ask).getByRole("button", { name: "Keep current" }));
    expect(server.modelConfig.auxiliary.title_generation.model).toBe("deepseek/deepseek-v4-flash");

    await user.click(within(card()).getByRole("button", { name: /^Model:/ }));
    await user.click(within(await within(card()).findByRole("group", { name: "OpenRouter" })).getByRole("button", { name: /^anthropic\/claude-fable-5.1/ }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Expensive model" })).getByRole("button", { name: "Use anyway" }));
    await waitFor(() => expect(server.modelConfig.auxiliary.title_generation.model).toBe("anthropic/claude-fable-5.1"));
  });
});
