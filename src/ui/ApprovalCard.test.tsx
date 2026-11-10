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

  it("shows hidden characters in the command and description", () => {
    const html = show(card({ command: "rm -rf /tmp/\u202Egol.\u200Bsh\n  ls\tx", description: "a\u2066b" }));
    expect(html).toContain("rm -rf /tmp/\\u{202E}gol.\\u{200B}sh\n  ls\tx");
    expect(html).toContain("a\\u{2066}b");
  });

  // jsdom doesn't paint, so this checks the rules: the real-app repro is in #414.
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
