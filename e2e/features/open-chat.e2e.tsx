import { expect, it } from "vitest";
import { row } from "../../src/hermes/fakeHermes";
import { boot, shot } from "../harness";

it("opens a chat from the list and shows its transcript", async () => {
  const { app, server } = await boot({
    seed: (s) => {
      s.sessions = [row("backup", 0.1, { pinned: true, title: "Nightly backup failing" }), row("nas", 2, { title: "NAS disk usage" })];
      s.transcripts = {
        backup: [
          { role: "user", text: "Why did the nightly backup fail?" },
          { role: "assistant", text: "The restic repository was still locked from an earlier run. `restic unlock` cleared it." },
        ],
      };
    },
  });

  await app.getByRole("button", { name: /Nightly backup failing/ }).click();
  await expect.element(app.getByText("Why did the nightly backup fail?")).toBeVisible();
  await expect.element(app.getByText(/The restic repository was still locked/)).toBeVisible();
  await shot("transcript");

  expect(server.requests.filter((r) => r.method === "session.resume").map((r) => r.params.session_id), "the chats the app resumed").toEqual(["backup"]);
});
