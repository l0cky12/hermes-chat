// @vitest-environment jsdom
// The tab strip scrolls the shown tab into sight in an effect. On WebView2 (Chromium 156 and later) scrollIntoView
// returns a Promise; an effect that returned it handed React a "cleanup" that isn't a function, so the next tab change
// threw while unmounting and React dropped the whole tree: the blank window of #308.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabStrip, type TabInfo } from "./Tabs";

const tabs: TabInfo[] = [
  { id: "backup", title: "Nightly backup" },
  { id: "nas", title: "NAS disks" },
];
const strip = (current: string | null) => (
  <TabStrip pane="a" tabs={tabs} current={current} onPick={() => {}} onClose={() => {}} onNew={() => {}} preview={() => null} onDropChat={() => {}} menu={() => []} />
);

let thrown: unknown[];
beforeEach(() => {
  thrown = [];
  // As WebView2 answers: a Promise that settles when the scroll ends. WebKitGTK and jsdom return undefined.
  Element.prototype.scrollIntoView = vi.fn(() => Promise.resolve()) as unknown as typeof Element.prototype.scrollIntoView;
  window.addEventListener("error", (e) => void (thrown.push(e.error), e.preventDefault()));
});
afterEach(cleanup);

describe("TabStrip on a browser whose scrollIntoView returns a Promise", () => {
  it("survives the shown tab changing", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(strip("backup"));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    view.rerender(strip("nas"));
    expect(thrown).toEqual([]);
    expect(view.container.querySelector('[aria-selected="true"]')?.textContent).toContain("NAS disks");
    view.unmount();
    expect(thrown).toEqual([]);
    quiet.mockRestore();
  });
});
