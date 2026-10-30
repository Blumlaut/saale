// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
}));

// The recorder drives MediaRecorder, which jsdom has no idea about. The
// gesture is what this file is about.
vi.mock("@/hooks/use-voice-recorder", async () => {
  const { useState } = await import("react");
  return {
    useVoiceRecorder: () => {
      const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
      return {
        state,
        seconds: 3,
        start: () => {
          spies.start();
          setState("recording");
        },
        stop: () => {
          spies.stop();
          setState("idle");
        },
        cancel: () => {
          spies.cancel();
          setState("idle");
        },
      };
    },
  };
});

import { VoiceInputButton } from "@/components/chat/voice-input-button";

const HOLD_MS = 250;

function stubPointerCapture() {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
}

function press(button: HTMLElement, init: { clientX: number; clientY: number }) {
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, ...init });
}

function move(button: HTMLElement, init: { clientX: number; clientY: number }) {
  fireEvent.pointerMove(button, { button: 0, pointerId: 1, ...init });
}

function release(button: HTMLElement) {
  fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
}

function mic(): HTMLElement {
  return screen.getByRole("button", { name: /record a voice message/i });
}

function hold(button: HTMLElement) {
  press(button, { clientX: 100, clientY: 400 });
  act(() => {
    vi.advanceTimersByTime(HOLD_MS);
  });
}

describe("VoiceInputButton", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    stubPointerCapture();
    // jsdom has no vibration motor.
    Object.defineProperty(navigator, "vibrate", { value: vi.fn(), configurable: true });
  });

  it("opens the microphone only after the hold", () => {
    render(<VoiceInputButton onText={vi.fn()} />);

    press(mic(), { clientX: 100, clientY: 400 });
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });

    expect(spies.start).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /stop recording/i })).toBeInTheDocument();
  });

  it("does nothing for a plain click", () => {
    render(<VoiceInputButton onText={vi.fn()} />);

    press(mic(), { clientX: 100, clientY: 400 });
    release(mic());
    act(() => {
      vi.advanceTimersByTime(HOLD_MS * 4);
    });

    expect(spies.start).not.toHaveBeenCalled();
  });

  it("finishes the recording when the finger lifts", () => {
    render(<VoiceInputButton onText={vi.fn()} />);
    const button = mic();
    hold(button);
    release(button);

    expect(spies.stop).toHaveBeenCalledOnce();
    expect(spies.cancel).not.toHaveBeenCalled();
  });

  it("keeps recording after lifting once it is slid up", () => {
    render(<VoiceInputButton onText={vi.fn()} />);
    const button = mic();
    hold(button);
    move(button, { clientX: 100, clientY: 320 });
    release(button);

    expect(spies.stop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /stop recording/i })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: /stop recording/i }), {
      button: 0,
      pointerId: 1,
    });
    expect(spies.stop).toHaveBeenCalledOnce();
  });

  it("throws the recording away when it is slid left", () => {
    render(<VoiceInputButton onText={vi.fn()} />);
    const button = mic();
    hold(button);
    move(button, { clientX: 20, clientY: 400 });
    release(button);

    expect(spies.cancel).toHaveBeenCalledOnce();
    expect(spies.stop).not.toHaveBeenCalled();
  });

  it("keeps the last recording when the browser cancels the gesture", () => {
    render(<VoiceInputButton onText={vi.fn()} />);
    const button = mic();
    hold(button);
    fireEvent.pointerCancel(button, { pointerId: 1 });

    expect(spies.cancel).not.toHaveBeenCalled();
    expect(spies.stop).not.toHaveBeenCalled();
  });
});
