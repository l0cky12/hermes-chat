// The tower's floor labels (#459): a label per profile, none touching another and all inside the canvas, however tall
// the tower is.
import { describe, expect, it } from "vitest";
import type { ScreenPoint } from "./office3d/scene";
import { towerLabels } from "./OfficeBuilding";

/** The profiles from the issue, the bottom floor first, as the tower sorts them. */
const ISSUE = ["aegis", "anvil", "argus", "cerberus", "codex-reviewer", "daedalus", "forge", "hephaestus", "inbox-manager", "oracle", "orchestrator", "prometheus", "scribe", "studio-gateway", "talos"];
/** The size of the widest label among them in the app ("codex-reviewer 1"). */
const TAG = { w: 116, h: 20 };
/** The office's canvas in a 1280 × 820 window. */
const CANVAS = { w: 952, h: 734 };

/**
 * Where a tower's floors land on screen as the app's home view projects them: left of the middle, the bottom one 190 px
 * down, each next one about 19 px higher (less than a label is tall) and a little to the left, so a tall tower runs off
 * the top.
 */
const tower = (n: number, { bottom = 190, step = 19, off = (y: number) => y < -0.025 * CANVAS.h } = {}): ScreenPoint[] =>
  Array.from({ length: n }, (_, i) => {
    const y = bottom - i * step;
    return { x: 230 - i * 1.5, y, off: off(y) };
  });

const rect = (p: ScreenPoint) => ({ left: p.x - TAG.w / 2, right: p.x + TAG.w / 2, top: p.y - TAG.h / 2, bottom: p.y + TAG.h / 2 });

/** Every label is shown, inside the canvas, and touches no other. */
function expectApartAndInside(labels: readonly ScreenPoint[], canvas = CANVAS) {
  const boxes = labels.map(rect);
  for (const [i, b] of boxes.entries()) {
    expect(labels[i].off, `label ${i} shown`).toBe(false);
    expect(b.left, `label ${i} left`).toBeGreaterThanOrEqual(0);
    expect(b.top, `label ${i} top`).toBeGreaterThanOrEqual(0);
    expect(b.right, `label ${i} right`).toBeLessThanOrEqual(canvas.w);
    expect(b.bottom, `label ${i} bottom`).toBeLessThanOrEqual(canvas.h);
    for (const [j, c] of boxes.entries()) {
      if (j <= i) continue;
      const overlap = b.left < c.right && c.left < b.right && b.top < c.bottom && c.top < b.bottom;
      expect(overlap, `labels ${i} and ${j} overlap`).toBe(false);
    }
  }
}

describe("The tower's floor labels", () => {
  it("keep the issue's 15 profiles apart and inside the canvas, none lower than the bottom floor, in the tower's order", () => {
    const at = tower(ISSUE.length);
    // Without the layout, labels a floor apart overlap, and the top ones are past the canvas's top edge.
    expect(at[1].y - at[0].y).toBeGreaterThan(-TAG.h);
    expect(at.at(-1)!.y).toBeLessThan(0);
    const labels = towerLabels(at, TAG, CANVAS);
    expect(labels).toHaveLength(ISSUE.length);
    expectApartAndInside(labels);
    // None slides down over the building, and up each column floor i's label is above floor i - 1's.
    for (const p of labels) expect(p.y).toBeLessThanOrEqual(at[0].y);
    for (let i = 1; i < labels.length; i++) if (labels[i].x === labels[i - 1].x) expect(labels[i].y).toBeLessThan(labels[i - 1].y);
  });

  it("keep a larger roster apart and inside, in more columns when one doesn't fit the canvas", () => {
    expectApartAndInside(towerLabels(tower(40), TAG, CANVAS));
    // The bottom floor's column stays at the tower, the others going whichever way they fit.
    for (const n of [ISSUE.length, 40]) expect(towerLabels(tower(n), TAG, CANVAS)[0]).toEqual(tower(n)[0]);
    const short = { w: 952, h: 400 };
    const labels = towerLabels(tower(60, { bottom: 380 }), TAG, short);
    expectApartAndInside(labels, short);
    expect(new Set(labels.map((p) => p.x)).size).toBeGreaterThan(1);
  });

  it("keep them apart however the camera turns: from above, every floor lands on nearly the same point", () => {
    expectApartAndInside(towerLabels(tower(ISSUE.length, { bottom: 60, step: 2 }), TAG, CANVAS));
    expectApartAndInside(towerLabels(tower(ISSUE.length, { bottom: 5, step: 0 }), TAG, CANVAS));
  });

  it("keep them inside when the tower stands at the canvas's edge", () => {
    for (const dx of [-600, 400]) expectApartAndInside(towerLabels(tower(ISSUE.length).map((p) => ({ ...p, x: p.x + dx })), TAG, CANVAS));
    expectApartAndInside(towerLabels(tower(ISSUE.length, { bottom: 900 }), TAG, CANVAS));
  });

  it("leave each label on its floor when the floors are already far enough apart", () => {
    const at = tower(4, { step: 40 });
    expect(towerLabels(at, TAG, CANVAS)).toEqual(at);
  });

  it("hide them all only while no floor is on screen", () => {
    expect(towerLabels(tower(3, { off: () => true }), TAG, CANVAS).every((p) => p.off)).toBe(true);
    expect(towerLabels([], TAG, CANVAS)).toEqual([]);
  });
});
