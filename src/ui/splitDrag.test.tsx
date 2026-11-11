// @vitest-environment jsdom
// Dragging the divider between two panes, with frames run by hand: a frame that takes long once the panes resize
// hands the rest of the drag to the guide line, and the panes take its place on release (#428).
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Split } from "./Split";

let frames: FrameRequestCallback[] = [];
let now = 0;

beforeEach(() => {
  frames = [];
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("panes") ? DOMRect.fromRect({ x: 0, y: 0, width: 1006, height: 800 }) : DOMRect.fromRect();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs the frames asked for so far, `paintMs` after the last one, as a browser that took that long to paint would. */
const frame = (paintMs = 5) =>
  act(() => {
    now += paintMs;
    const run = frames;
    frames = [];
    for (const cb of run) cb(now);
  });

const panes = () =>
  render(
    <Split
      activeKey="a"
      onActivate={() => {}}
      panes={[
        { key: "a", title: "Left chat", node: <p>left</p> },
        { key: "b", title: "Right chat", node: <p>right</p> },
      ]}
    />,
  );
const divider = () => document.querySelector<HTMLElement>(".divider")!;
const leftShare = () => Number(divider().getAttribute("aria-valuenow"));
const ghost = () => document.querySelector(".divider-ghost");

describe("Dragging the divider", () => {
  beforeEach(() => {
    HTMLElement.prototype.setPointerCapture = () => {};
  });

  it("resizes the panes live while each frame is quick", async () => {
    panes();
    fireEvent.pointerDown(divider(), { button: 0, clientX: 503, pointerId: 1 });
    for (const x of [453, 403, 353]) {
      fireEvent.pointerMove(divider(), { clientX: x, pointerId: 1 });
      await frame();
      await frame();
    }
    expect(leftShare()).toBe(35);
    expect(ghost()).toBeNull();
    fireEvent.pointerUp(divider(), { clientX: 353, pointerId: 1 });
    expect(leftShare()).toBe(35);
  });

  it("hands the rest of the drag to the guide line once a frame after a step is slow, then resizes on release", async () => {
    panes();
    fireEvent.pointerDown(divider(), { button: 0, clientX: 503, pointerId: 1 });
    fireEvent.pointerMove(divider(), { clientX: 453, pointerId: 1 });
    await frame();
    expect(leftShare()).toBe(45);
    // Painting the rewrapped chats takes 400 ms, after the render itself was quick.
    await frame(400);
    fireEvent.pointerMove(divider(), { clientX: 343, pointerId: 1 });
    await frame();
    expect(ghost()).not.toBeNull();
    expect(leftShare()).toBe(45);
    fireEvent.pointerUp(divider(), { clientX: 343, pointerId: 1 });
    expect(ghost()).toBeNull();
    expect(leftShare()).toBe(34);
  });
});
