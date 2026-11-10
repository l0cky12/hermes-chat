// The rules of a project's context files (ADR 0135): what a chat is told and when, capacity, and what may be added.
import { describe, expect, it } from "vitest";
import { typedText } from "./branch";
import {
  DEFAULT_LIMIT_TOKENS,
  MAX_FILE_BYTES,
  capacityOf,
  contextFile,
  defaultFolder,
  folderSlug,
  kindByName,
  listedFiles,
  percentUsed,
  plan,
  planAdd,
  start,
  textFileName,
  withContext,
  type ContextFile,
  type ContextSet,
  type LedgerEntry,
} from "./projectContext";

const DIR = "/srv/budget/context";
const file = (name: string, text: string | undefined, version = "1"): ContextFile => ({
  name,
  path: `${DIR}/${name}`,
  size: text?.length ?? 2048,
  version,
  kind: text === undefined ? "binary" : "text",
  ...(text !== undefined && { tokens: Math.ceil(text.length / 4) }),
});
const set = (...files: ContextFile[]): ContextSet => ({ project: "Budget", dir: DIR, files });
const texts = (...files: [string, string][]) => new Map(files.map(([name, text]) => [`${DIR}/${name}`, text]));

describe("what counts as a context file", () => {
  it("lists a folder's own files by name, without folders, hidden files and links out of it", () => {
    const listed = listedFiles([
      { name: "notes.md", path: `${DIR}/notes.md`, kind: "file", size: 10, modified: 5000, mime: "text/markdown" },
      { name: "archive", path: `${DIR}/archive`, kind: "dir" },
      { name: ".secret", path: `${DIR}/.secret`, kind: "file", size: 1 },
      { name: "elsewhere.txt", path: "/etc/passwd", kind: "file", size: 1, linkTarget: "/etc/passwd" },
      { name: "gone", path: `${DIR}/gone`, kind: "broken-link" },
      { name: "Brief.pdf", path: `${DIR}/Brief.pdf`, kind: "file", size: 99, modified: 7000, mime: "application/pdf" },
    ]);
    expect(listed).toEqual([
      { name: "Brief.pdf", path: `${DIR}/Brief.pdf`, size: 99, version: "99:7000", kind: "pdf", mime: "application/pdf" },
      { name: "notes.md", path: `${DIR}/notes.md`, size: 10, version: "10:5000", kind: "text", mime: "text/markdown" },
    ]);
  });

  it("tells a file's kind from its name and type, and leaves an unknown one to be read", () => {
    expect(kindByName("a.md")).toBe("text");
    expect(kindByName("a.PDF", "application/pdf")).toBe("pdf");
    expect(kindByName("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(kindByName("a.png", "image/png")).toBe("binary");
    expect(kindByName("a.zip", "application/zip")).toBe("binary");
    expect(kindByName("NOTES", "application/octet-stream")).toBeUndefined();
  });

  it("counts a text file's room from its size, an extracted file's from its text, and none for a file without text", () => {
    expect(contextFile({ name: "a.md", path: "/c/a.md", size: 9, version: "v", kind: "text" }).tokens).toBe(3);
    expect(contextFile({ name: "a.pdf", path: "/c/a.pdf", size: 90_000, version: "v", kind: "pdf" }, "twelve bytes").tokens).toBe(3);
    expect(contextFile({ name: "scan.pdf", path: "/c/scan.pdf", size: 90_000, version: "v", kind: "pdf" }, null).tokens).toBeUndefined();
    expect(contextFile({ name: "a.png", path: "/c/a.png", size: 400, version: "v", kind: "binary" }).tokens).toBeUndefined();
    expect(contextFile({ name: "NOTES", path: "/c/NOTES", size: 8, version: "v" }, "plain é")).toMatchObject({ kind: "text", tokens: 2 });
    expect(contextFile({ name: "blob", path: "/c/blob", size: 8, version: "v" }, null)).toMatchObject({ kind: "binary" });
  });
});

describe("capacity", () => {
  it("is half the default model's context window, and full mode up to exactly that", () => {
    const at = (tokens: number) => capacityOf([{ ...file("a.md", "x"), tokens }], 200_000);
    expect(at(1_000)).toEqual({ used: 1_000, limit: 100_000, mode: "full" });
    expect(percentUsed(at(1_000))).toBe(1);
    expect(at(100_000).mode).toBe("full");
    expect(at(100_001).mode).toBe("list");
    expect(capacityOf([{ ...file("a.md", "x"), tokens: 40_000 }], 64_000)).toEqual({ used: 40_000, limit: 32_000, mode: "list" });
  });

  it("is 100,000 tokens when the model's window isn't known", () => {
    expect(DEFAULT_LIMIT_TOKENS).toBe(100_000);
    expect(capacityOf([{ ...file("a.md", "x"), tokens: 50_000 }]).limit).toBe(100_000);
    expect(percentUsed(capacityOf([{ ...file("a.md", "x"), tokens: 50_000 }]))).toBe(50);
  });

  it("leaves files without text out of the count", () => {
    expect(capacityOf([file("logo.png", undefined), file("a.md", "12345678")]).used).toBe(2);
  });
});

describe("what a new chat is told", () => {
  it("in full mode: each file's text under its path, then the files with no text, by path", () => {
    const told = start(set(file("notes.md", "Rent is 900.\n"), file("logo.png", undefined)), texts(["notes.md", "Rent is 900.\n"]), "full");
    expect(told.block).toBe(
      [
        'Context files from the project "Budget". Every chat in this project has them. Each file\'s text follows its path.',
        "",
        `## ${DIR}/notes.md (13 B, MD)`,
        "Rent is 900.",
        "",
        "These files have no text to include. Open them with your file tools if you need them:",
        `- ${DIR}/logo.png (2.0 KB, PNG)`,
      ].join("\n"),
    );
    expect(told.next).toEqual({ mode: "full", files: { [`${DIR}/notes.md`]: { version: "1", text: true }, [`${DIR}/logo.png`]: { version: "1", text: false } } });
  });

  it("in list mode: where the files are and each one's path, and no text", () => {
    const told = start(set(file("big.md", "secret words"), file("README", "x")), texts(["big.md", "secret words"]), "list");
    expect(told.block).toBe(
      `Context files from the project "Budget" are too large to include here. They are in ${DIR}. Open the ones you need with your file tools:\n- ${DIR}/big.md (12 B, MD)\n- ${DIR}/README (1 B, FILE)`,
    );
    expect(told.next.files[`${DIR}/big.md`]).toEqual({ version: "1", text: false });
  });

  it("is nothing for a project with no context files", () => {
    expect(start(set(), new Map(), "full")).toEqual({ block: null, next: { mode: "full", files: {} } });
  });

  it("keeps a file's text from being read as a reference Hermes would expand or fetch", () => {
    const refs = ["file:/etc/passwd", "url:https://example.com", "diff", "staged", "git:1", "folder:/x"];
    const text = `See ${refs.map((r) => `@${r}`).join(", ")}. Mail a@b.c.`;
    const { block } = start(set(file("a.md", text)), texts(["a.md", text]), "full");
    expect(block).not.toMatch(/@(file:|folder:|git:|url:|diff|staged)/);
    for (const r of refs) expect(block).toContain(`@⁠${r}`);
    expect(block).toContain("a@b.c");
  });
});

describe("what an open chat is told before its next message", () => {
  const notes = file("notes.md", "Rent is 900.");
  const had = (told: { next: LedgerEntry }) => told.next;

  it("gets every file the first time, as added", () => {
    const told = plan(undefined, set(notes, file("logo.png", undefined)), texts(["notes.md", "Rent is 900."]), "full");
    expect(told.block).toBe(
      [
        'The context files of the project "Budget" changed since this chat last got them.',
        "",
        `Added: ${DIR}/notes.md (12 B, MD)`,
        "Rent is 900.",
        "",
        `Added: ${DIR}/logo.png (2.0 KB, PNG)`,
      ].join("\n"),
    );
  });

  it("never gets the same text twice", () => {
    const all = texts(["notes.md", "Rent is 900."]);
    const first = start(set(notes), all, "full");
    const again = plan(had(first), set(notes), all, "full");
    expect(again.block).toBeNull();
    expect(again.next).toEqual(first.next);
  });

  it("gets an added file's text, a replaced file's new text, and a removed file's path", () => {
    const first = start(set(notes, file("old.md", "Old.")), texts(["notes.md", "Rent is 900."], ["old.md", "Old."]), "full");
    const now = set(file("notes.md", "Rent is 950.", "2"), file("plan.md", "Save more."));
    const told = plan(had(first), now, texts(["notes.md", "Rent is 950."], ["plan.md", "Save more."]), "full");
    expect(told.block).toBe(
      [
        'The context files of the project "Budget" changed since this chat last got them.',
        "",
        `Replaced: ${DIR}/notes.md (12 B, MD)`,
        "Rent is 950.",
        "",
        `Added: ${DIR}/plan.md (10 B, MD)`,
        "Save more.",
        "",
        `Removed: ${DIR}/old.md`,
      ].join("\n"),
    );
    expect(plan(told.next, now, texts(["notes.md", "Rent is 950."], ["plan.md", "Save more."]), "full").block).toBeNull();
  });

  it("gets the whole list of paths once when the files go over capacity, then only what changed, without text", () => {
    const first = start(set(notes), texts(["notes.md", "Rent is 900."]), "full");
    const big = file("big.md", "Huge.");
    const over = plan(had(first), set(notes, big), texts(["notes.md", "Rent is 900."], ["big.md", "Huge."]), "list");
    expect(over.block).toBe(
      `Context files from the project "Budget" are too large to include here. They are in ${DIR}. Open the ones you need with your file tools:\n- ${DIR}/notes.md (12 B, MD)\n- ${DIR}/big.md (5 B, MD)`,
    );
    expect(plan(over.next, set(notes, big), new Map(), "list").block).toBeNull();
    const more = plan(over.next, set(notes, big, file("more.md", "More.")), new Map(), "list");
    expect(more.block).toBe(`The context files of the project "Budget" changed since this chat last got them.\n\nAdded: ${DIR}/more.md (5 B, MD)`);
  });

  it("back under capacity, gets the text of each file it hasn't had the text of, and no other", () => {
    const all = texts(["notes.md", "Rent is 900."], ["big.md", "Huge."]);
    const big = file("big.md", "Huge.");
    const first = start(set(notes), all, "full");
    const over = plan(had(first), set(notes, big), all, "list");
    const back = plan(over.next, set(notes, big), all, "full");
    expect(back.block).toBe(`The context files of the project "Budget" changed since this chat last got them.\n\nAdded: ${DIR}/big.md (5 B, MD)\nHuge.`);
    expect(back.next.mode).toBe("full");
    expect(plan(back.next, set(notes, big), all, "full").block).toBeNull();
  });

  it("is told nothing when the project has no files", () => {
    expect(plan(undefined, set(), new Map(), "full").block).toBeNull();
  });

  it("rides below the owner's words, where both Hermes clients hide it", () => {
    const sent = withContext("What's the rent?", ["block one", "block two"]);
    expect(sent).toBe("What's the rent?\n\n--- Attached Context ---\n\nblock one\n\nblock two");
    expect(typedText(sent)).toBe("What's the rent?");
    expect(withContext("Hi", [])).toBe("Hi");
  });
});

describe("adding files", () => {
  const local = (name: string, size = 10) => ({ path: `/home/me/${name}`, name, size });

  it("refuses a file over 30 MB by name, and still adds the rest of the batch", () => {
    const p = planAdd([], [local("small.md"), local("movie.mkv", MAX_FILE_BYTES + 1), local("edge.bin", MAX_FILE_BYTES)], "all");
    expect(p.fresh.map((f) => f.name)).toEqual(["small.md", "edge.bin"]);
    expect(p.refused).toEqual([{ name: "movie.mkv", why: "movie.mkv wasn't added: it's 30.0 MB, over the 30.0 MB a context file can be." }]);
  });

  it("holds a name that is already there until the owner says replace", () => {
    const p = planAdd([{ name: "notes.md" }], [local("notes.md"), local("new.md")], "all");
    expect(p.taken.map((f) => f.name)).toEqual(["notes.md"]);
    expect(p.fresh.map((f) => f.name)).toEqual(["new.md"]);
  });

  it("refuses hidden and credential names, and a second file of the same name", () => {
    const p = planAdd([], [local(".env"), local("auth.json"), local("a.md"), local("a.md")], "all");
    expect(p.fresh.map((f) => f.name)).toEqual(["a.md"]);
    expect(p.refused.map((r) => r.name)).toEqual([".env", "auth.json", "a.md"]);
  });

  it("takes at most 8 MiB on an SSH profile", () => {
    expect(planAdd([], [local("big.txt", 9 * 1024 * 1024)], "text-only").refused[0].why).toContain("on an SSH profile");
  });

  it("saves text content as <title>.md", () => {
    expect(textFileName("Style guide")).toBe("Style guide.md");
    expect(textFileName("notes.md")).toBe("notes.md");
    expect(textFileName(" a/b ")).toBe("a-b.md");
    expect(textFileName("..hidden")).toBe("hidden.md");
  });

  it("names the folder made for a project that has none", () => {
    expect(folderSlug("Budget Tracker 2026!", "p_1")).toBe("budget-tracker-2026");
    expect(folderSlug("日本語", "p_1")).toBe("project-p_1");
    expect(folderSlug("x".repeat(60), "p_1")).toHaveLength(48);
    expect(defaultFolder("/home/liam/.hermes/profiles/work/", "Budget Tracker", "p_1")).toBe("/home/liam/.hermes/profiles/work/projects/budget-tracker");
  });
});
