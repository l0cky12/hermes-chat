// @vitest-environment jsdom
// A render error below the boundary shows the error and a way back, instead of React unmounting the whole tree (#308).
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

// React reports a caught error on the console; that is wanted (Logs → This app keeps it), not noise.
let quiet: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  quiet = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  quiet.mockRestore();
});

function Shaky({ broken }: { broken: boolean }) {
  if (broken) throw new Error("the composer's state is not a string");
  return <main>The chat</main>;
}

describe("ErrorBoundary", () => {
  it("draws its children while nothing throws", () => {
    render(
      <ErrorBoundary>
        <Shaky broken={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("The chat")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a render error with its stack and the component it was in", () => {
    render(
      <ErrorBoundary>
        <Shaky broken />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("couldn't draw the window");
    expect(alert.textContent).toContain("the composer's state is not a string");
    const detail = alert.querySelector("pre")?.textContent ?? "";
    expect(detail).toMatch(/Error: the composer's state is not a string[\s\S]*at /);
    expect(detail).toMatch(/In:[\s\S]*Shaky/);
    expect(screen.queryByText("The chat")).toBeNull();
    expect(quiet).toHaveBeenCalled();
  });

  it("shows the #308 shape: an effect whose cleanup is a Promise throws when it re-runs", () => {
    // As scrollIntoView answers on WebView2, handed back by a concise-arrow effect.
    function Strip({ current }: { current: string }) {
      useEffect(() => Promise.resolve() as unknown as void, [current]);
      return <main>Tab {current}</main>;
    }
    const view = render(
      <ErrorBoundary>
        <Strip current="backup" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Tab backup")).toBeTruthy();
    view.rerender(
      <ErrorBoundary>
        <Strip current="nas" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("is not a function");
    expect(screen.queryByText(/^Tab /)).toBeNull();
  });

  it("Reload starts the app over", async () => {
    const reload = vi.fn();
    render(
      <ErrorBoundary reload={reload}>
        <Shaky broken />
      </ErrorBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("shows a thrown non-Error as its text", () => {
    function Odd(): never {
      throw "not even an Error";
    }
    render(
      <ErrorBoundary>
        <Odd />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("not even an Error");
  });
});
