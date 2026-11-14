import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { boot, shot } from "../harness";

it("changes the main model: Hermes stores it, and Settings shows it when opened again", async () => {
  const { app, server } = await boot();
  await app.getByPlaceholder("Message Hermes").click();
  await userEvent.keyboard("{Control>},{/Control}");
  await app.getByRole("tab", { name: /Model/ }).click();
  const model = app.getByRole("combobox", { name: "Main model" });
  await expect.element(model).toHaveValue("z-ai/glm-5.3-flash");

  await model.click();
  await app.getByRole("listbox", { name: "Main model" }).getByRole("option", { name: "deepseek/deepseek-v4-pro" }).click();
  await app.getByRole("button", { name: "Apply main model" }).click();
  await expect.element(app.getByText("Applied. New chats use it.")).toBeVisible();
  await shot("applied");

  await app.getByRole("button", { name: "Back to chat" }).click();
  await app.getByRole("button", { name: "Settings", exact: true }).click();
  await app.getByRole("tab", { name: /Model/ }).click();
  await expect.element(model, { message: "Settings, opened again, reads the model back from Hermes" }).toHaveValue("deepseek/deepseek-v4-pro");
  await shot("reopened");

  const writes = server.restRequests.filter((r) => r.method !== "GET").map((r) => [`${r.method} ${r.path}`, r.body]);
  expect(writes, "what Settings wrote to Hermes").toEqual([["POST /api/model/set", { scope: "main", provider: "openrouter", model: "deepseek/deepseek-v4-pro" }]]);
});
