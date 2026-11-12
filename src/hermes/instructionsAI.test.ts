// What each one-off call for a project's instructions is told and given, and how its answer is read (issue #536).
import { describe, expect, it } from "vitest";
import { ASK_INSTRUCTIONS, IMPROVE_INSTRUCTIONS, NOTES_MAX, WRITE_INSTRUCTIONS, draftCall, draftFrom, questionCall, questionFrom } from "./instructionsAI";

const project = { name: "Budget Tracker", folders: ["/srv/budget", "/srv/budget-web"] };

describe("the calls", () => {
  it("gives the project's name and folders, and the owner's material between tags", () => {
    const c = draftCall(project, { kind: "notes", notes: "A Rust CLI." });
    expect(c.instructions).toBe(WRITE_INSTRUCTIONS);
    expect(c.input).toBe("Project name: Budget Tracker\nFolders on the server: /srv/budget, /srv/budget-web\n\nWhat the owner wrote about the project:\n<notes>A Rust CLI.</notes>");
    expect(draftCall({ name: "X", folders: [] }, { kind: "improve", text: "Be brief." }).input).toContain("Folders on the server: none yet");
    expect(draftCall(project, { kind: "improve", text: "Be brief." }).instructions).toBe(IMPROVE_INSTRUCTIONS);
    expect(draftCall(project, { kind: "notes", notes: "x".repeat(NOTES_MAX + 50) }).input).toContain(`<notes>${"x".repeat(NOTES_MAX)}</notes>`);
  });

  it("asks again with the previous draft, and the note when there is one", () => {
    const source = { kind: "improve" as const, text: "Be brief." };
    expect(draftCall(project, source, { previous: "BE BRIEF.", note: " shorter " }).input).toMatch(/<previous_draft>BE BRIEF\.<\/previous_draft>\nThe owner's note for this version: <note>shorter<\/note>$/);
    expect(draftCall(project, source, { previous: "BE BRIEF.", note: "" }).input).toMatch(/The owner gave no note\.$/);
  });

  it("carries every answer so far, skips included, in each question call", () => {
    const answers = [{ question: "What is it for?", answer: "Budgets" }, { question: "Stack?" }];
    const c = questionCall(project, answers);
    expect(c.instructions).toBe(ASK_INSTRUCTIONS);
    expect(c.input).toContain("Questions asked so far: 2 of at most 8.");
    expect(c.input).toContain("<qa><question>What is it for?</question><answer>Budgets</answer></qa>\n<qa><question>Stack?</question><skipped/></qa>");
    expect(questionCall(project, []).input).toContain("<answers></answers>");
  });
});

describe("the answers", () => {
  it("reads a question, without numbering or quotes, or READY", () => {
    expect(questionFrom(" What is this project for? ")).toEqual({ question: "What is this project for?" });
    expect(questionFrom("3. What stack?")).toEqual({ question: "What stack?" });
    expect(questionFrom("Question 2: What stack?")).toEqual({ question: "What stack?" });
    expect(questionFrom("“What stack?”")).toEqual({ question: "What stack?" });
    expect(questionFrom("What stack?\n\nI ask because…")).toEqual({ question: "What stack?" });
    expect(questionFrom("ready.")).toEqual({ ready: true });
    expect(() => questionFrom("  ")).toThrow("Hermes didn't ask a question.");
  });

  it("reads a draft, taking off echoed tags, and refuses an empty one", () => {
    expect(draftFrom("\n<instructions>\nYou help.\n</instructions>\n")).toBe("You help.");
    expect(draftFrom("  You help.  ")).toBe("You help.");
    expect(() => draftFrom(" ")).toThrow("Hermes answered with no text.");
  });
});
