// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import OfflinePage from "@/app/offline/page";

/**
 * The offline page is precached by the service worker and served with no network
 * available, so it must render its message from the HTML alone and offer a way
 * back  the retry cannot depend on anything but the browser.
 */

const originalLocation = window.location;

function stubLocationReload() {
  const reload = vi.fn();
  Object.defineProperty(window, "location", {
    value: { reload },
    writable: true,
    configurable: true,
  });
  return reload;
}

afterEach(() => {
  Object.defineProperty(window, "location", {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
});

describe("offline page", () => {
  it("tells the user they are offline", () => {
    render(<OfflinePage />);

    expect(screen.getByRole("heading", { name: /you're offline/i })).toBeInTheDocument();
  });

  it("reloads the page when the user retries", () => {
    const reload = stubLocationReload();
    render(<OfflinePage />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
