// @vitest-environment jsdom
// The side panel's shell (SidePanel.tsx, ADR 0039): a tab is made when first opened and kept, so what runs in it
// survives the owner going to another tab, the launcher (ADR 0159) or closing the panel; a tab with something running
// says so.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidePanel, type PanelTab } from "./SidePanel";

afterEach(cleanup);

const mounts: string[] = [];
const unmounts: string[] = [];
function Probe({ name, shown }: { name: string; shown: boolean }) {
  useEffect(() => {
    mounts.push(name);
    return () => void unmounts.push(name);
  }, [name]);
  return <p>{`${name} ${shown ? "shown" : "hidden"}`}</p>;
}

function Harness({ start = "preview", onClose = () => {} }: { start?: PanelTab | null; onClose?: () => void }) {
  const [tab, setTab] = useState<PanelTab | null>(start);
  const [shown, setShown] = useState(true);
  return (
    <>
      <button onClick={() => setShown((s) => !s)}>toggle</button>
      <SidePanel
        tab={tab}
        onTab={setTab}
        shown={shown}
        overlay={false}
        width={480}
        maxWidth={900}
        onResize={() => {}}
        onHide={() => {}}
        onClose={onClose}
        running={{ terminal: true }}
        tabs={{
          preview: (s) => <Probe name="preview" shown={s} />,
          terminal: (s) => <Probe name="terminal" shown={s} />,
          files: (s) => <Probe name="files" shown={s} />,
          screen: (s) => <Probe name="screen" shown={s} />,
        }}
      />
    </>
  );
}

describe("The side panel", () => {
  it("makes each tab when first opened and keeps it, hidden, while another tab or nothing is shown", () => {
    mounts.length = unmounts.length = 0;
    render(<Harness />);
    expect(mounts).toEqual(["preview"]);
    fireEvent.click(screen.getByRole("tab", { name: /Terminal/ }));
    expect(mounts).toEqual(["preview", "terminal"]);
    expect(screen.getByText("terminal shown")).toBeTruthy();
    expect(screen.getByText("preview hidden")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Screen/ }));
    fireEvent.click(screen.getByText("toggle"));
    expect(screen.getByText("screen hidden")).toBeTruthy();
    expect(document.querySelector("aside")!.hasAttribute("hidden")).toBe(true);
    expect(unmounts).toEqual([]);
    expect(screen.queryByText(/^files/)).toBeNull();
  });

  it("marks a tab with something running, and closes on Escape", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    expect(screen.getByRole("tab", { name: /Terminal/ }).querySelector(".run-dot")).not.toBeNull();
    expect(screen.getByRole("tab", { name: /Files/ }).querySelector(".run-dot")).toBeNull();
    fireEvent.keyDown(screen.getByRole("tab", { name: /Files/ }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  describe("launcher", () => {
    const rows = () => screen.getAllByRole("listitem").map((li) => li.querySelector("button")!);

    it("lists the four tabs with their keys, focused on the first, and makes no tab until one is picked", () => {
      mounts.length = 0;
      render(<Harness start={null} />);
      expect(screen.getByRole("heading", { name: "Open a surface" })).toBeTruthy();
      const list = screen.getByRole("list", { name: "Open a surface" });
      expect(rows().map((b) => [b.textContent, b.getAttribute("aria-keyshortcuts")])).toEqual([
        ["PreviewP", "P"],
        ["TerminalT", "T"],
        ["FilesF", "F"],
        ["ScreenS", "S"],
      ]);
      expect(list.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(rows()[0]);
      expect(screen.queryAllByRole("tab", { selected: true })).toEqual([]);
      expect(mounts).toEqual([]);
    });

    it("opens a tab by click, by its letter in either case, and moves between rows with the arrows, wrapping", () => {
      render(<Harness start={null} />);
      const aside = document.querySelector("aside")!;
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      expect(document.activeElement).toBe(rows()[3]);
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(rows()[0]);
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(rows()[1]);

      fireEvent.keyDown(document.activeElement!, { key: "f" });
      expect(screen.getByText("files shown")).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Open a surface" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Open a surface" }));
      fireEvent.keyDown(aside, { key: "T" });
      expect(screen.getByText("terminal shown")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Open a surface" }));
      fireEvent.click(rows()[3]);
      expect(screen.getByText("screen shown")).toBeTruthy();
    });

    it("opens the focused row on Enter", async () => {
      const user = userEvent.setup();
      render(<Harness start={null} />);
      await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
      expect(screen.getByText("screen shown")).toBeTruthy();
    });

    it("leaves Ctrl, Alt and Meta with the letters and arrows to the app's own shortcuts", () => {
      render(<Harness start={null} />);
      const first = rows()[0];
      for (const mod of ["ctrlKey", "altKey", "metaKey"]) {
        for (const key of ["ArrowDown", "ArrowUp", "t"]) {
          expect(fireEvent.keyDown(first, { key, [mod]: true })).toBe(true);
          expect(document.activeElement).toBe(first);
        }
      }
      expect(screen.getByRole("heading", { name: "Open a surface" })).toBeTruthy();
    });

    it("takes a letter by its key's place on a non-Latin layout, and only by its character on a Latin one", () => {
      render(<Harness start={null} />);
      fireEvent.keyDown(rows()[0], { key: "е", code: "KeyT" });
      expect(screen.getByText("terminal shown")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open a surface" }));
      // Latin layouts go by the character: Dvorak's Y, BÉPO's è and Polish AltGr+S's ś are in QWERTY's T and S places.
      for (const [key, code] of [["y", "KeyT"], ["è", "KeyT"], ["ś", "KeyS"]]) {
        fireEvent.keyDown(rows()[0], { key, code });
        expect(screen.getByRole("heading", { name: "Open a surface" })).toBeTruthy();
      }
      fireEvent.keyDown(rows()[0], { key: "f", code: "KeyU" });
      expect(screen.getByText("files shown")).toBeTruthy();
    });

    it("keeps focus on a control in the panel when the window narrows or widens past the overlay width", () => {
      const props = {
        tab: null,
        onTab: () => {},
        shown: true,
        width: 480,
        maxWidth: 900,
        onResize: () => {},
        onHide: () => {},
        onClose: () => {},
        tabs: { preview: () => null, terminal: () => null, files: () => null, screen: () => null },
      };
      const { rerender } = render(<SidePanel {...props} overlay={false} />);
      expect(document.activeElement).toBe(rows()[0]);
      const close = screen.getByRole("button", { name: "Close the side panel" });
      close.focus();
      rerender(<SidePanel {...props} overlay />);
      expect(document.activeElement).toBe(close);
      rerender(<SidePanel {...props} overlay={false} />);
      expect(document.activeElement).toBe(close);
    });

    it("keeps what was made, hidden, while it shows again after +, and leaves the letters alone with a modifier or a tab shown", () => {
      mounts.length = unmounts.length = 0;
      render(<Harness />);
      fireEvent.keyDown(document.querySelector("aside")!, { key: "t" });
      expect(screen.getByText("preview shown")).toBeTruthy();

      const plus = screen.getByRole("button", { name: "Open a surface" });
      expect(plus.classList.contains("on")).toBe(false);
      fireEvent.click(plus);
      expect(plus.classList.contains("on")).toBe(true);
      expect(screen.getByText("preview hidden")).toBeTruthy();
      expect(unmounts).toEqual([]);
      fireEvent.keyDown(document.activeElement!, { key: "t", ctrlKey: true });
      expect(screen.getByRole("heading", { name: "Open a surface" })).toBeTruthy();
      fireEvent.click(screen.getByRole("tab", { name: /Preview/ }));
      expect(screen.getByText("preview shown")).toBeTruthy();
      expect(mounts).toEqual(["preview"]);
    });

    it("closes on Escape", () => {
      const onClose = vi.fn();
      render(<Harness start={null} onClose={onClose} />);
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
