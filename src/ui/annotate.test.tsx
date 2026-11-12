// @vitest-environment jsdom
// The annotation overlay on its own (ADR 0094): an Add the owner's cancel overtook ends nothing, since a newer
// annotation may be open by the time it finishes.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Still } from "../hermes/annotations";
import { AnnotationOverlay, type AnnotationDesk } from "./Annotate";
import type { Annotator } from "./tauriPreview";

const still: Still = { id: 1, generation: 0, path: "/c/1/0/still.png", url: "https://framed.example/", takenAtMs: 0, width: 400, height: 300, scale: 1, elements: false };
const api: Annotator = {
  still: async () => still,
  query: async () => null,
  pick: async () => Promise.reject({ kind: "unsupported" }),
  read: async () => new Blob(["png"]),
  stage: async () => "/c/1/1/annotation-1.png",
  discard: async () => {},
};

beforeEach(() => {
  URL.createObjectURL = () => "blob:still";
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function addingWith(handOver: Promise<boolean>) {
  const desk: AnnotationDesk = { target: () => ({ chat: "Fix the app", key: "chat-a" }), nextAnnotation: () => 1, annotate: () => handOver };
  const onDone = vi.fn();
  const view = render(<AnnotationOverlay still={still} page={{ url: still.url, where: "web" }} api={api} desk={desk} onDone={onDone} />);
  const stage = await screen.findByLabelText(/^The still of the page/);
  fireEvent.pointerDown(stage, { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
  fireEvent.pointerMove(stage, { clientX: 110, clientY: 60 });
  fireEvent.pointerUp(stage, { clientX: 110, clientY: 60 });
  fireEvent.click(within(await screen.findByRole("region", { name: "Review the annotation" })).getByRole("button", { name: "Add to message" }));
  return { view, onDone };
}

describe("Annotation overlay", () => {
  it("ends itself once its Add is handed over", async () => {
    const { onDone } = await addingWith(Promise.resolve(true));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
  });

  it("ends nothing when it was cancelled while its Add was being handed over", async () => {
    let handed!: (ok: boolean) => void;
    const { view, onDone } = await addingWith(new Promise((r) => (handed = r)));
    view.unmount();
    await act(async () => handed(true));
    expect(onDone).not.toHaveBeenCalled();
  });
});
