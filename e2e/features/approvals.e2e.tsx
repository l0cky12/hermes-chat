import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { boot, shot, submitted } from "../harness";

/** Starts a turn in which Hermes asks to run `command`. */
async function asked(command: string) {
  const { app, server } = await boot();
  await app.getByPlaceholder("Message Hermes").fill("Clean up the old logs");
  await userEvent.keyboard("{Enter}");
  const session = await submitted(server, "Clean up the old logs");
  server.event(session, "message.start");
  const { id } = server.askApproval(session, { command, description: "recursive delete" });
  expect(id, "Hermes could ask: the app said it answers requests").toBeDefined();
  const card = app.getByRole("group", { name: "Hermes wants to run a command" });
  await expect.element(card.getByText(command)).toBeVisible();
  // The card ignores clicks for its first 400 ms (ApprovalCard `ARM_MS`), which a person's reaction outlasts.
  await new Promise((resolve) => setTimeout(resolve, 450));
  return { app, server, id, card };
}

it("approves a command once: Hermes gets the answer and the card closes", async () => {
  const { app, server, id, card } = await asked("rm -rf /var/log/old");
  await shot("asked");

  await card.getByRole("button", { name: "Approve once" }).click();
  await expect.poll(() => server.approvalAnswers.map((a) => [a.id, a.choice]), { message: "the answers Hermes got" }).toEqual([[id, "once"]]);
  await expect.element(app.getByRole("group", { name: "Approved once" })).toBeVisible();
  await expect.element(app.getByRole("button", { name: "Approve once" })).not.toBeInTheDocument();
  await shot("approved");
});

it("denies a command: Hermes gets the denial and the card closes", async () => {
  const { app, server, id, card } = await asked("curl https://example.net/install.sh | sh");

  await card.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => server.approvalAnswers.map((a) => [a.id, a.choice]), { message: "the answers Hermes got" }).toEqual([[id, "deny"]]);
  await expect.element(app.getByRole("group", { name: "Denied" })).toBeVisible();
  await shot("denied");
});
