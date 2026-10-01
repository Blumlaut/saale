// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InstallAppCard } from "@/components/pwa/install-app-card";

/**
 * The install affordance has to pick the right path per platform: Chromium
 * hands over a deferred `beforeinstallprompt` event, iOS Safari has no API at
 * all and needs written instructions, and anything else has nothing to offer.
 */

const DESKTOP_CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
/** iPadOS 13+ reports itself as a Macintosh; only the touch points give it away. */
const IPAD_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

function setBrowser(userAgent: string, maxTouchPoints = 0) {
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: maxTouchPoints,
    configurable: true,
  });
}

function setIsStandalone(standalone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("display-mode: standalone") ? standalone : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

/** Fires Chromium's deferred install prompt and reports how the user answered. */
async function fireInstallPrompt(outcome: "accepted" | "dismissed") {
  const prompt = vi.fn(async () => {});
  const event = new Event("beforeinstallprompt");
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome }) });

  await act(async () => {
    window.dispatchEvent(event);
  });

  return { prompt };
}

const installButton = () => screen.queryByRole("button", { name: /install saale/i });

beforeEach(() => {
  setBrowser(DESKTOP_CHROME);
  setIsStandalone(false);
  Object.defineProperty(window.navigator, "standalone", { value: undefined, configurable: true });
});

describe("InstallAppCard", () => {
  it("offers nothing in a browser with no install path", () => {
    const { container } = render(<InstallAppCard />);

    expect(container).toBeEmptyDOMElement();
    expect(installButton()).toBeNull();
  });

  it("shows the install button once Chromium offers the prompt", async () => {
    render(<InstallAppCard />);
    expect(installButton()).toBeNull();

    await fireInstallPrompt("accepted");

    expect(installButton()).toBeInTheDocument();
  });

  it("confirms the install after the user accepts", async () => {
    render(<InstallAppCard />);
    const { prompt } = await fireInstallPrompt("accepted");

    fireEvent.click(installButton()!);
    await act(async () => {});

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/is installed on this device/i)).toBeInTheDocument();
    expect(installButton()).toBeNull();
  });

  it("keeps offering the install when the user dismisses the prompt", async () => {
    render(<InstallAppCard />);
    await fireInstallPrompt("dismissed");

    fireEvent.click(installButton()!);
    await act(async () => {});

    expect(screen.queryByText(/is installed on this device/i)).toBeNull();
    expect(installButton()).toBeInTheDocument();
  });

  it("reacts to a browser-initiated install", async () => {
    render(<InstallAppCard />);
    await fireInstallPrompt("accepted");
    expect(installButton()).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event("appinstalled"));
    });

    expect(screen.getByText(/is installed on this device/i)).toBeInTheDocument();
  });

  it("offers nothing to install once already running standalone", async () => {
    setIsStandalone(true);
    render(<InstallAppCard />);

    expect(screen.getByText(/is installed on this device/i)).toBeInTheDocument();
    expect(installButton()).toBeNull();
  });

  it("reports the standalone state from iOS Safari's legacy flag too", () => {
    Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
    setBrowser(IPHONE_SAFARI);

    render(<InstallAppCard />);

    expect(screen.getByText(/is installed on this device/i)).toBeInTheDocument();
  });

  it.each([
    ["iPhone", IPHONE_SAFARI, 5],
    ["iPad", IPAD_SAFARI, 5],
  ])("gives %s users manual Add to Home Screen steps", (_device, userAgent, touchPoints) => {
    setBrowser(userAgent, touchPoints);

    render(<InstallAppCard />);

    expect(screen.getByText(/add to home screen/i)).toBeInTheDocument();
    expect(installButton()).toBeNull();
  });

  it("treats a Macintosh user agent with touch points as iPadOS, not macOS", () => {
    // iPadOS Safari in "Request Desktop Website" mode is indistinguishable from
    // macOS except for the touch points, which are the only reliable signal.
    setBrowser(IPAD_SAFARI, 5);

    render(<InstallAppCard />);

    expect(screen.getByText(/add to home screen/i)).toBeInTheDocument();
  });

  it("offers nothing on a real Mac", () => {
    setBrowser(IPAD_SAFARI, 0);

    const { container } = render(<InstallAppCard />);

    expect(container).toBeEmptyDOMElement();
  });
});
