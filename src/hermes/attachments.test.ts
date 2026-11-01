import { describe, expect, it } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect } from "./transport";

const MiB = 1024 * 1024;
const b64 = (s: string) => btoa(s);

async function signedIn() {
  const server = new FakeHermes();
  server.files = {
    "/home/liam/Pictures/rack.png": "\x89PNG fake",
    "/home/liam/notes/disk report.txt": "sda 92%",
    "/home/liam/big.png": { size: 26 * MiB },
    "/home/liam/huge.iso": { size: 300 * MiB },
    "/home/liam/scan.pdf": { size: 40 * MiB },
    "/home/liam/notes": { dir: true },
  };
  const hermes = await connect(server.openPipe);
  const id = await hermes.newChat();
  const runtime = server.runtimeIdOf(id)!;
  return { server, hermes, id, runtime, chat: () => hermes.getSnapshot().chats.find((c) => c.id === id)! };
}

describe("Choosing files to attach", () => {
  it("names each file and sorts images from other files", async () => {
    const { hermes } = await signedIn();
    const got = await hermes.checkAttachments(["/home/liam/Pictures/rack.png", "/home/liam/notes/disk report.txt", "/home/liam/scan.pdf"]);
    expect(got).toEqual({
      attachments: [
        { path: "/home/liam/Pictures/rack.png", name: "rack.png", size: 9, kind: "image" },
        { path: "/home/liam/notes/disk report.txt", name: "disk report.txt", size: 7, kind: "file" },
        { path: "/home/liam/scan.pdf", name: "scan.pdf", size: 40 * MiB, kind: "file" },
      ],
      refused: [],
    });
  });

  it("refuses images over 25 MB and other files over 256 MB, the most Hermes takes", async () => {
    const { hermes } = await signedIn();
    const got = await hermes.checkAttachments(["/home/liam/big.png", "/home/liam/huge.iso", "/home/liam/Pictures/rack.png"]);
    expect(got.attachments.map((a) => a.name)).toEqual(["rack.png"]);
    expect(got.refused).toEqual([
      "big.png is 26.0 MB. Hermes takes images up to 25 MB.",
      "huge.iso is 300.0 MB. Hermes takes files up to 256 MB.",
    ]);
  });

  it("refuses folders and files it can't read", async () => {
    const { hermes } = await signedIn();
    const got = await hermes.checkAttachments(["/home/liam/notes", "/home/liam/gone.txt"]);
    expect(got).toEqual({
      attachments: [],
      refused: ["Couldn't attach notes: it's a folder", "Couldn't attach gone.txt: No such file or directory (os error 2)"],
    });
  });
});

describe("Sending attachments", () => {
  it("sends an image as base64 before the message that goes with it", async () => {
    const { server, hermes, id, runtime, chat } = await signedIn();
    const { attachments } = await hermes.checkAttachments(["/home/liam/Pictures/rack.png"]);
    await hermes.send(id, "Which cable is loose?", attachments);

    expect(server.requests.slice(-2).map((r) => [r.method, r.params])).toEqual([
      ["image.attach_bytes", { session_id: runtime, filename: "rack.png", content_base64: b64("\x89PNG fake") }],
      ["prompt.submit", { session_id: runtime, profile: "default", text: "Which cable is loose?" }],
    ]);
    expect(chat().items).toEqual([{ kind: "user", id: "u-0", text: "Which cable is loose?", attachments: ["rack.png"] }]);
    expect(chat().running).toBe(true);
  });

  it("stages other files in the chat's workspace and puts their @file: refs before the message", async () => {
    const { server, hermes, id, runtime } = await signedIn();
    const { attachments } = await hermes.checkAttachments(["/home/liam/notes/disk report.txt", "/home/liam/scan.pdf"]);
    server.files["/home/liam/scan.pdf"] = "%PDF-1.7";
    await hermes.send(id, "Summarise these", attachments);

    expect(server.last("file.attach")!.params).toEqual({
      session_id: runtime,
      name: "scan.pdf",
      data_url: `data:application/octet-stream;base64,${b64("%PDF-1.7")}`,
    });
    expect(server.last("prompt.submit")!.params.text).toBe("@file:`attachments/disk report.txt`\n@file:attachments/scan.pdf\n\nSummarise these");
  });

  it("asks about the image when it is sent with no text, and titles a new chat after it", async () => {
    const { server, hermes, id, chat } = await signedIn();
    const { attachments } = await hermes.checkAttachments(["/home/liam/Pictures/rack.png"]);
    await hermes.send(id, "", attachments);

    expect(server.last("prompt.submit")!.params.text).toBe("What do you see in this image?");
    expect(chat()).toMatchObject({ title: "rack.png", items: [{ kind: "user", id: "u-0", text: "", attachments: ["rack.png"] }] });
  });

  it("resumes a listed chat before attaching to it", async () => {
    const server = new FakeHermes();
    server.sessions = [row("s1", 1, { pinned: true })];
    server.files = { "/tmp/a.txt": "a" };
    const hermes = await connect(server.openPipe);
    await hermes.sync();
    const { attachments } = await hermes.checkAttachments(["/tmp/a.txt"]);
    await hermes.send("s1", "Look", attachments);

    expect(server.requests.map((r) => r.method)).toEqual(["session.resume", "file.attach", "prompt.submit"]);
    expect(server.last("file.attach")!.params.session_id).toBe(server.runtimeIdOf("s1"));
  });

  it("doesn't send the message if an attachment fails, and takes back the images already queued", async () => {
    const { server, hermes, id, runtime, chat } = await signedIn();
    const { attachments } = await hermes.checkAttachments(["/home/liam/Pictures/rack.png", "/home/liam/notes/disk report.txt"]);
    server.handlers["file.attach"] = (r) => server.fail(r.id, 5028, "No space left on device");
    await hermes.send(id, "Check these", attachments);
    await hermes.idle();

    expect(server.requests.map((r) => r.method)).not.toContain("prompt.submit");
    expect(server.last("image.detach")!.params).toEqual({ session_id: runtime, path: "/hermes/images/upload_1.png" });
    expect(chat().running).toBe(false);
    expect(chat().items.at(-1)).toEqual({ kind: "error", id: "e-1", text: "Couldn't attach disk report.txt: No space left on device" });
  });

  it("re-checks the size when sending, in case the file grew", async () => {
    const { server, hermes, id, chat } = await signedIn();
    const { attachments } = await hermes.checkAttachments(["/home/liam/Pictures/rack.png"]);
    server.files["/home/liam/Pictures/rack.png"] = { size: 30 * MiB };
    await hermes.send(id, "Which cable is loose?", attachments);

    expect(server.requests.map((r) => r.method)).not.toContain("image.attach_bytes");
    expect(chat().items.at(-1)).toEqual({
      kind: "error",
      id: "e-1",
      text: "Couldn't attach rack.png: it's 30.0 MB now, over the 25 MB limit",
    });
  });

  it("lets Stop wait until the attachments and message are sent", async () => {
    const { server, hermes, id } = await signedIn();
    const { attachments } = await hermes.checkAttachments(["/home/liam/notes/disk report.txt"]);
    await Promise.all([hermes.send(id, "Check", attachments), hermes.stop(id)]);
    expect(server.requests.map((r) => r.method).slice(-3)).toEqual(["file.attach", "prompt.submit", "session.interrupt"]);
  });
});
