import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { boot, shot, submitted } from "../harness";

it("sends a message with Enter and shows the reply Hermes streams", async () => {
  const { app, server } = await boot();
  const composer = app.getByPlaceholder("Message Hermes");
  await composer.fill("Why is the blog down?");
  await userEvent.keyboard("{Enter}");

  const session = await submitted(server, "Why is the blog down?");
  await expect.element(app.getByText("Why is the blog down?").first()).toBeVisible();
  await expect.element(composer, { message: "the composer empties once sent" }).toHaveValue("");

  server.event(session, "message.start");
  server.event(session, "message.delta", { text: "Caddy stopped after the certificate " });
  await expect.element(app.getByText("Caddy stopped after the certificate")).toBeVisible();
  await shot("streaming");
  const reply = "Caddy stopped after the certificate renewal failed. Restarting it fixed the site.";
  server.event(session, "message.delta", { text: "renewal failed. Restarting it fixed the site." });
  server.event(session, "message.complete", { text: reply, status: "complete" });
  await expect.element(app.getByText(reply)).toBeVisible();
  await shot("replied");
});
