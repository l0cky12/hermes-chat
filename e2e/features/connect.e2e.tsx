import { expect, it } from "vitest";
import { row } from "../../src/hermes/fakeHermes";
import { boot, shot } from "../harness";

it("signs in: a wrong password is refused, the right one opens the chats", async () => {
  const { app, rust } = await boot({ signedIn: false, dashboardPassword: "hunter2", seed: (s) => (s.sessions = [row("deploy", 1, { pinned: true, title: "Deploy the blog" })]) });

  const password = app.getByLabelText(/^Dashboard password/);
  await expect.element(app.getByRole("heading", { name: "Connect to hermes.example.net" })).toBeVisible();
  await expect.element(app.getByLabelText("Dashboard username")).toHaveValue("owner");
  await shot("sign-in screen");

  await password.fill("wrong-password");
  await app.getByRole("button", { name: "Connect" }).click();
  await expect.element(app.getByText("The dashboard turned down the username or password.")).toBeVisible();
  await shot("wrong password");

  await password.fill("hunter2");
  await app.getByRole("button", { name: "Connect" }).click();
  await expect.element(app.getByText("Deploy the blog").first()).toBeVisible();
  await shot("signed in");

  const tried = rust.calls.filter((c) => c.cmd === "hermes_connect").map((c) => c.args.credential.password);
  expect(tried, "the passwords Rust was asked to sign in with").toEqual(["wrong-password", "hunter2"]);
});
