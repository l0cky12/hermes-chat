// @vitest-environment jsdom
// Settings → Snapshots (SnapshotSettings.tsx, ADR 0123): the host card never shows or keeps a secret, and the list
// shows each snapshot's state with only the actions that state allows.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, SnapshotApi, SnapshotHost, SnapshotList } from "../hermes/snapshots";
import { SnapshotSettings } from "./SnapshotSettings";

afterEach(cleanup);

const HOST: SnapshotHost = { endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "liam-shares", prefix: "hermes-chat-snapshots/", keyId: "AKIAEXAMPLE" };
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const id = (c: string) => c.repeat(26);
const LIVE: Snapshot = {
  state: "live",
  id: id("a"),
  title: "Moving house",
  created: "2026-11-11T21:30:00Z",
  expires: "2026-11-12T21:30:00Z",
  url: "https://stale.example/old-link",
};
const EXPIRED: Snapshot = { state: "expired", id: id("b"), title: "Old plans", created: "2026-11-01T10:00:00Z", expires: "2026-11-02T10:00:00Z" };
const CHANGED: Snapshot = { state: "changed", id: id("c"), title: "Deploy keys", created: "2026-11-10T09:00:00Z", expires: null };
const UNREVOKED: Snapshot = { state: "unrevoked", id: id("d") };

function fake(over: Partial<SnapshotApi> = {}, host: SnapshotHost | null = HOST, snapshots: Snapshot[] = [LIVE, EXPIRED, CHANGED, UNREVOKED]) {
  let saved = host;
  const api = {
    host: vi.fn(async () => saved),
    saveHost: vi.fn(async (h: SnapshotHost) => (saved = h)),
    clearHost: vi.fn(async () => void (saved = null)),
    testHost: vi.fn(async () => {}),
    publish: vi.fn(),
    list: vi.fn(async (): Promise<SnapshotList> => ({ host: saved!, snapshots })),
    link: vi.fn(async () => "https://fresh.example/new-link"),
    revoke: vi.fn(async () => {}),
    ...over,
  } satisfies SnapshotApi;
  const copied: string[] = [];
  const view = render(<SnapshotSettings api={api} copyText={async (t) => void copied.push(t)} />);
  return { api, copied, view, user: userEvent.setup() };
}

const field = (name: string) => screen.getByLabelText(name, { selector: "input" }) as HTMLInputElement;
const rowOf = (name: string) => screen.getByText(name).closest(".set-row") as HTMLElement;

describe("Settings → Snapshots, the host card", () => {
  it("asks for every required field, then saves the settings with the secret and never shows the secret again", async () => {
    const { api, user } = fake({}, null, []);
    await screen.findByRole("form", { name: "Set up a snapshot host" });
    expect(field("Prefix").value).toBe("hermes-chat-snapshots/");
    expect(field("Secret access key").type).toBe("password");
    expect(screen.getByText(/ListBucketVersions/)).toBeTruthy();
    expect(screen.getByText(/lasts at most 7 days/)).toBeTruthy();
    expect(screen.getByText("Set up a snapshot host above to publish and list snapshots.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toBe("Endpoint, Region, Bucket, Access key ID and Secret access key are needed.");
    await user.type(field("Endpoint"), HOST.endpoint);
    await user.type(field("Region"), HOST.region);
    await user.type(field("Bucket"), HOST.bucket);
    await user.type(field("Access key ID"), HOST.keyId);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toBe("Secret access key is needed.");
    expect(api.saveHost).not.toHaveBeenCalled();

    await user.type(field("Secret access key"), SECRET);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.saveHost).toHaveBeenCalledWith(HOST, SECRET);
    expect(await screen.findByText("s3.us-east-1.amazonaws.com")).toBeTruthy();
    await screen.findByText("No snapshots in the bucket.");
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("Change fills in the settings but not the secret, and won't save until the secret is typed again", async () => {
    const { api, user } = fake();
    await user.click(await screen.findByRole("button", { name: "Change" }));
    expect(screen.getByRole("form", { name: "Change the snapshot host" })).toBeTruthy();
    expect(field("Bucket").value).toBe("liam-shares");
    expect(field("Access key ID").value).toBe("AKIAEXAMPLE");
    expect(field("Secret access key").value).toBe("");
    await user.clear(field("Bucket"));
    await user.type(field("Bucket"), "team-shares");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toBe("Secret access key is needed.");
    expect(api.saveHost).not.toHaveBeenCalled();
    await user.type(field("Secret access key"), SECRET);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.saveHost).toHaveBeenCalledWith({ ...HOST, bucket: "team-shares" }, SECRET);
    expect(await screen.findByText("team-shares")).toBeTruthy();
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it("says what a Test found, either way", async () => {
    let fail = false;
    const { user } = fake({ testHost: vi.fn(async () => (fail ? Promise.reject(new Error("The host refused the key (403).")) : undefined)) });
    await user.click(await screen.findByRole("button", { name: "Test" }));
    expect((await screen.findByText(/The host answered/)).getAttribute("role")).toBe("status");
    fail = true;
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The test failed: The host refused the key (403).");
  });

  it("removes the host only once the owner says yes, and shows the form again", async () => {
    const { api, user } = fake();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const ask = screen.getByRole("alertdialog", { name: "Remove the snapshot host?" });
    expect(ask.textContent).toContain("Snapshots already published stay in the bucket");
    expect(api.clearHost).not.toHaveBeenCalled();
    await user.click(within(ask).getByRole("button", { name: "Remove" }));
    expect(api.clearHost).toHaveBeenCalled();
    expect(await screen.findByRole("form", { name: "Set up a snapshot host" })).toBeTruthy();
    expect(screen.queryByText("Moving house")).toBeNull();
  });
});

describe("Settings → Snapshots, the list", () => {
  it("shows each state with only the actions it allows", async () => {
    fake();
    await screen.findByText("Moving house");
    const live = rowOf("Moving house");
    expect(live.textContent).toMatch(/Ends /);
    expect(within(live).getByRole("button", { name: "Copy link to Moving house" })).toBeTruthy();
    expect(within(live).getByRole("button", { name: "Revoke Moving house" })).toBeTruthy();

    const expired = rowOf("Old plans");
    expect(expired.textContent).toContain("couldn't delete it from the bucket");
    expect(within(expired).queryByRole("button", { name: /Copy link/ })).toBeNull();
    expect(within(expired).getByRole("button", { name: "Revoke Old plans" })).toBeTruthy();

    const changed = rowOf("Deploy keys");
    expect(changed.textContent).toContain("Something else changed this page");
    expect(within(changed).queryByRole("button", { name: /Copy link/ })).toBeNull();
    expect(within(changed).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Revoke Deploy keys"]);

    const unrevoked = rowOf(id("d"));
    expect(unrevoked.textContent).toContain("Revoke didn't finish");
    expect(within(unrevoked).getByRole("button", { name: `Revoke ${id("d")}` })).toBeTruthy();
  });

  it("Copy link asks for a fresh link and copies that, never the one the list read", async () => {
    const { api, copied, user } = fake();
    await user.click(await screen.findByRole("button", { name: "Copy link to Moving house" }));
    expect(api.link).toHaveBeenCalledWith(HOST, id("a"));
    expect(copied).toEqual(["https://fresh.example/new-link"]);
    expect(within(rowOf("Moving house")).getByRole("status").textContent).toBe("Link copied.");
  });

  it("Revoke asks first, then drops the row and reads the list again", async () => {
    const snapshots = [LIVE, EXPIRED];
    const { api, user } = fake({}, HOST, snapshots);
    await user.click(await screen.findByRole("button", { name: "Revoke Old plans" }));
    expect(api.revoke).not.toHaveBeenCalled();
    snapshots.splice(1, 1);
    await user.click(within(screen.getByRole("alertdialog", { name: "Revoke Old plans?" })).getByRole("button", { name: "Revoke" }));
    expect(api.revoke).toHaveBeenCalledWith(HOST, id("b"));
    await waitFor(() => expect(screen.queryByText("Old plans")).toBeNull());
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Moving house")).toBeTruthy();
  });

  it("keeps the row and says why when Revoke doesn't finish", async () => {
    const { user } = fake({ revoke: vi.fn(async () => Promise.reject(new Error("Revoke may not have worked: 2 versions are left."))) });
    await user.click(await screen.findByRole("button", { name: "Revoke Moving house" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Revoke Moving house?" })).getByRole("button", { name: "Revoke" }));
    const row = rowOf("Moving house");
    expect((await within(row).findByRole("alert")).textContent).toBe("Revoke may not have worked: 2 versions are left.");
    expect(within(row).getByRole("button", { name: "Revoke Moving house" })).toBeTruthy();
  });

  it("says when the bucket can't be read, and reads it again on Try again", async () => {
    let fail = true;
    const { api, user } = fake({ list: vi.fn(async () => (fail ? Promise.reject(new Error("The host couldn't be reached.")) : { host: HOST, snapshots: [LIVE] })) });
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't read the snapshots from the bucket: The host couldn't be reached.");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Moving house")).toBeTruthy();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("drops a list read with other host settings than the card shows", async () => {
    fake({ list: vi.fn(async () => ({ host: { ...HOST, bucket: "someone-elses" }, snapshots: [LIVE] })) });
    await screen.findByText("s3.us-east-1.amazonaws.com");
    await act(async () => {});
    expect(screen.queryByText("Moving house")).toBeNull();
    expect(screen.getByText(/Reading the bucket/)).toBeTruthy();
  });
});
