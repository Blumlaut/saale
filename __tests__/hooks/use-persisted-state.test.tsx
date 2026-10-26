// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import {
  arrayOf,
  isBoolean,
  oneOf,
  usePersistedState,
  type PersistedStateOptions,
  type PersistedStateSetter,
} from "@/hooks/use-persisted-state";

/**
 * Remembered view preferences. A stored value has to survive a remount, an
 * unreadable or outdated one has to fall back instead of throwing, and the
 * write must never happen before the stored value has been read.
 */

const KEY = "tests:preference";

let setter: PersistedStateSetter<unknown>;

function Probe<T>({
  storageKey = KEY,
  fallback,
  options,
}: {
  storageKey?: string;
  fallback: T;
  options?: PersistedStateOptions<T>;
}) {
  const [value, set, restored] = usePersistedState(storageKey, fallback, options);
  useEffect(() => {
    setter = set as PersistedStateSetter<unknown>;
  }, [set]);
  return (
    <>
      <output data-testid="value">{JSON.stringify(value)}</output>
      <output data-testid="restored">{String(restored)}</output>
    </>
  );
}

function value(): unknown {
  return JSON.parse(screen.getByTestId("value").textContent ?? "null");
}

function restored(): boolean {
  return screen.getByTestId("restored").textContent === "true";
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("usePersistedState", () => {
  it("starts on the fallback when nothing is stored", async () => {
    render(<Probe fallback={true} />);

    expect(value()).toBe(true);
    expect(restored()).toBe(true);
  });

  it("reads a stored value after mount", async () => {
    window.localStorage.setItem("saale:ui:" + KEY, JSON.stringify(false));

    render(<Probe fallback={true} />);

    expect(value()).toBe(false);
  });

  it("writes a change and keeps it across a remount", async () => {
    const first = render(<Probe fallback={true} />);

    act(() => setter(false));

    expect(window.localStorage.getItem("saale:ui:" + KEY)).toBe("false");
    first.unmount();

    render(<Probe fallback={true} />);
    expect(value()).toBe(false);
  });

  it("updates from the current value", async () => {
    render(<Probe fallback={0} />);

    act(() => setter((current: unknown) => (current as number) + 1));
    act(() => setter((current: unknown) => (current as number) + 1));

    expect(value()).toBe(2);
  });

  it("falls back when a stored value fails the guard", async () => {
    window.localStorage.setItem("saale:ui:" + KEY, JSON.stringify("week"));

    render(<Probe fallback={"month"} options={{ validate: oneOf("month", "day") }} />);

    expect(value()).toBe("month");
  });

  it("falls back when the stored value cannot be parsed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    window.localStorage.setItem("saale:ui:" + KEY, "{not json");

    render(<Probe fallback={true} />);

    expect(value()).toBe(true);
    expect(logged).toHaveBeenCalled();
  });

  it("keeps the boolean guard honest", async () => {
    expect(isBoolean(true)).toBe(true);
    expect(isBoolean("true")).toBe(false);

    window.localStorage.setItem("saale:ui:" + KEY, JSON.stringify("yes"));
    render(<Probe fallback={false} options={{ validate: isBoolean }} />);

    expect(value()).toBe(false);
  });

  it("reads a list through its element guard", async () => {
    window.localStorage.setItem(
      "saale:ui:" + KEY,
      JSON.stringify(["completed", "today", "unknown"]),
    );

    render(
      <Probe
        fallback={["completed"]}
        options={{ validate: arrayOf(oneOf("completed", "today")) }}
      />,
    );

    expect(value()).toEqual(["completed"]);
  });
});
