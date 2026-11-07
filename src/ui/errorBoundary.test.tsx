// @vitest-environment jsdom
// A render error below the boundary shows the error and a way back, instead of React unmounting the whole tree (#308).
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(cleanup);

function Shaky({ broken }: { broken: { now: boolean } }) {
  if (broken.now) throw new Error("the composer's state is not a string");
  return <main>The chat</main>;
}

describe("ErrorBoundary", () => {
  it("draws its children while nothing throws", () => {
    render(
      <ErrorBoundary>
        <Shaky broken={{ now: false }} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("The chat")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the thrown error with its stack, and Try again draws the children once more", async () => {
    // React reports the caught error on the console; that is wanted (Logs → This app keeps it), not noise.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { now: true };
    render(
      <ErrorBoundary>
        <Shaky broken={broken} />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("couldn't draw the window");
    expect(alert.textContent).toContain("the composer's state is not a string");
    expect(alert.querySelector("pre")?.textContent).toMatch(/Error: the composer's state is not a string[\s\S]*at /);
    expect(screen.queryByText("The chat")).toBeNull();
    expect(quiet).toHaveBeenCalled();

    broken.now = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("The chat")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    quiet.mockRestore();
  });

  it("Reload starts the app over", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(
      <ErrorBoundary reload={reload}>
        <Shaky broken={{ now: true }} />
      </ErrorBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
    quiet.mockRestore();
  });

  it("shows a thrown non-Error as its text", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    function Odd(): never {
      throw "not even an Error";
    }
    render(
      <ErrorBoundary>
        <Odd />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("not even an Error");
    quiet.mockRestore();
  });
});
