import { describe, it, expect } from "vitest";
import {
  createInitialState,
  feedBuffer,
  computePending,
  estimateInstantRate,
  updateSmoothedRate,
  computeCatchUpBoost,
  stepAnimation,
  consumeFromBuffer,
  resetAnimation,
  DEFAULT_CONFIG,
  type AnimationState,
} from "@/lib/pi/stream-animation";

describe("createInitialState", () => {
  it("creates a zeroed state with accumulators", () => {
    const state = createInitialState();
    expect(state.textBuffer).toBe("");
    expect(state.thinkingBuffer).toBe("");
    expect(state.smoothedRate).toBe(0);
    expect(state.textAccum).toBe(0);
    expect(state.thinkingAccum).toBe(0);
  });
});

describe("resetAnimation", () => {
  it("returns a fresh zeroed state", () => {
    const state = resetAnimation();
    expect(state).toEqual(createInitialState());
  });
});

// ── feedBuffer ────────────────────────────────────────────────────────

describe("feedBuffer", () => {
  it("computes buffers from cumulative text minus displayed length", () => {
    const state = createInitialState();
    const result = feedBuffer(state, "Hello, world!", "", 0, 0, 1000);

    expect(result.textBuffer).toBe("Hello, world!");
    expect(result.thinkingBuffer).toBe("");
  });

  it("only buffers undisplayed characters", () => {
    const state = createInitialState();
    const result = feedBuffer(state, "Hello, world!", "", 7, 0, 1000);

    expect(result.textBuffer).toBe("world!");
    expect(result.thinkingBuffer).toBe("");
  });

  it("handles both text and thinking buffers", () => {
    const state = createInitialState();
    const result = feedBuffer(state, "text content", "thinking content", 0, 0, 1000);

    expect(result.textBuffer).toBe("text content");
    expect(result.thinkingBuffer).toBe("thinking content");
  });

  it("updates rate tracking window on each feed", () => {
    let state = createInitialState();

    // First feed at t=1000, 5 chars total
    state = feedBuffer(state, "Hello", "", 0, 0, 1000);
    expect(state.rateLastChars).toBe(5);
    expect(state.rateLastTime).toBe(1000);
    expect(state.rateStartChars).toBe(0);
    expect(state.rateStartTime).toBe(0);

    // Second feed at t=1100, 14 chars total
    state = feedBuffer(state, "Hello, World!!", "", 0, 0, 1100);
    expect(state.rateLastChars).toBe(14);
    expect(state.rateLastTime).toBe(1100);
    expect(state.rateStartChars).toBe(5);
    expect(state.rateStartTime).toBe(1000);
  });

  it("resets rate window when cumulative chars decrease (new stream)", () => {
    let state = createInitialState();
    state = feedBuffer(state, "Some text", "", 0, 0, 1000);
    expect(state.rateLastChars).toBe(9);

    // New stream: cumulative chars reset
    state = feedBuffer(state, "Hi", "", 0, 0, 2000);
    expect(state.rateStartChars).toBe(0);
    expect(state.rateStartTime).toBe(0);
    expect(state.rateLastChars).toBe(2);
    expect(state.rateLastTime).toBe(2000);
  });

  it("handles empty buffers when fully caught up", () => {
    const state = createInitialState();
    const result = feedBuffer(state, "Hello", "", 5, 0, 1000);

    expect(result.textBuffer).toBe("");
    expect(result.thinkingBuffer).toBe("");
  });
});

// ── computePending ────────────────────────────────────────────────────

describe("computePending", () => {
  it("computes pending from cumulative minus displayed", () => {
    const result = computePending("Hello, world!", "", 7, 0);
    expect(result.textPending).toBe("world!");
    expect(result.thinkingPending).toBe("");
  });

  it("handles zero pending", () => {
    const result = computePending("Hello", "", 5, 0);
    expect(result.textPending).toBe("");
    expect(result.thinkingPending).toBe("");
  });
});

// ── estimateInstantRate ──────────────────────────────────────────────

describe("estimateInstantRate", () => {
  it("returns 0 when no rate data available", () => {
    expect(estimateInstantRate(createInitialState())).toBe(0);
  });

  it("returns 0 when only one measurement point", () => {
    const state = {
      ...createInitialState(),
      rateLastChars: 100,
      rateLastTime: 1000,
    };
    expect(estimateInstantRate(state)).toBe(0);
  });

  it("computes correct rate from two measurement points", () => {
    const state: AnimationState = {
      ...createInitialState(),
      rateStartChars: 0,
      rateStartTime: 1000,
      rateLastChars: 100,
      rateLastTime: 2000,
    };
    expect(estimateInstantRate(state)).toBe(100);
  });

  it("handles sub-second intervals", () => {
    const state: AnimationState = {
      ...createInitialState(),
      rateStartChars: 0,
      rateStartTime: 1000,
      rateLastChars: 50,
      rateLastTime: 1050,
    };
    expect(estimateInstantRate(state)).toBe(1000);
  });
});

// ── updateSmoothedRate ───────────────────────────────────────────────

describe("updateSmoothedRate", () => {
  it("preserves smoothed rate when instant rate is 0 (SSE gap)", () => {
    expect(updateSmoothedRate(50, 0, 0.2)).toBe(50);
  });

  it("applies EMA smoothing for positive instant rate", () => {
    // smoothed=50, instant=100, ema=0.2 → 50*0.8 + 100*0.2 = 60
    expect(updateSmoothedRate(50, 100, 0.2)).toBe(60);
  });

  it("smoothly transitions from zero rate", () => {
    expect(updateSmoothedRate(0, 200, 0.2)).toBe(40);
  });

  it("converges toward instant rate over multiple updates", () => {
    let smoothed = 0;
    for (let i = 0; i < 20; i++) {
      smoothed = updateSmoothedRate(smoothed, 100, 0.2);
    }
    expect(smoothed).toBeGreaterThan(90);
    expect(smoothed).toBeLessThanOrEqual(100);
  });
});

// ── computeCatchUpBoost ──────────────────────────────────────────────

describe("computeCatchUpBoost", () => {
  it("returns 1 when buffer is at or below threshold", () => {
    expect(computeCatchUpBoost(0, 50, 2)).toBe(1);
    expect(computeCatchUpBoost(50, 50, 2)).toBe(1);
  });

  it("increases proportionally above threshold", () => {
    expect(computeCatchUpBoost(150, 50, 2)).toBe(2);
  });

  it("caps at max boost", () => {
    expect(computeCatchUpBoost(500, 50, 2)).toBe(2);
  });
});

// ── stepAnimation (fractional accumulation) ─────────────────────────

describe("stepAnimation", () => {
  const config = DEFAULT_CONFIG;

  it("returns zero chars when no pending buffer", () => {
    const state = createInitialState();
    const result = stepAnimation(state, config, 0);

    expect(result.textChars).toBe(0);
    expect(result.thinkingChars).toBe(0);
    expect(result.hasPending).toBe(false);
  });

  it("accumulates fractionally and displays when accumulator >= 1", () => {
    // slowCharsPerSec = 8, targetFps = 60 → 0.133 chars/frame
    // At this rate, it takes ~7.5 frames to display 1 char
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hello world this is a test sentence",
      smoothedRate: 0,
    };

    let totalDisplayed = 0;
    let currentState = state;
    for (let i = 0; i < 30; i++) {
      const result = stepAnimation(currentState, config, 0);
      totalDisplayed += result.textChars;
      currentState = result.state;
      if (result.textChars > 0) {
        currentState = consumeFromBuffer(currentState, result.textChars, 0);
      }
    }

    // At 8 chars/sec, over 30 frames (0.5 sec), expect ~4 chars displayed
    expect(totalDisplayed).toBeGreaterThan(2);
    expect(totalDisplayed).toBeLessThan(8);
  });

  it("respects max chars/sec cap", () => {
    // Even with huge smoothed rate, display is capped at maxCharsPerSec (16)
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "A".repeat(1000),
      smoothedRate: 600, // would want 600 chars/sec
    };

    let totalDisplayed = 0;
    let currentState = state;
    for (let i = 0; i < 60; i++) {
      const result = stepAnimation(currentState, config, 0);
      totalDisplayed += result.textChars;
      currentState = result.state;
      if (result.textChars > 0) {
        currentState = consumeFromBuffer(currentState, result.textChars, 0);
      }
    }

    // At 16 chars/sec max, over 60 frames (1 sec), expect ~16 chars
    expect(totalDisplayed).toBeLessThanOrEqual(20); // small margin for accumulation
  });

  it("applies catch-up boost when buffer exceeds threshold", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "A".repeat(200),
      smoothedRate: 0,
    };

    let totalDisplayed = 0;
    let currentState = state;
    for (let i = 0; i < 60; i++) {
      const result = stepAnimation(currentState, config, 0);
      totalDisplayed += result.textChars;
      currentState = result.state;
      if (result.textChars > 0) {
        currentState = consumeFromBuffer(currentState, result.textChars, 0);
      }
    }

    // With catch-up boost, should display more than base rate
    // Base: 8 chars/sec. Boost: up to 1.5x = 12 chars/sec. Capped at 16.
    expect(totalDisplayed).toBeGreaterThan(4);
  });

  it("splits proportionally between text and thinking", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "AAAAAAAAAA", // 10 chars
      thinkingBuffer: "BBBBBBBBBB", // 10 chars
      smoothedRate: 0,
    };

    let textTotal = 0;
    let thinkingTotal = 0;
    let currentState = state;
    for (let i = 0; i < 120; i++) {
      const result = stepAnimation(currentState, config, 0);
      textTotal += result.textChars;
      thinkingTotal += result.thinkingChars;
      currentState = result.state;
      currentState = consumeFromBuffer(currentState, result.textChars, result.thinkingChars);
      if (currentState.textBuffer.length === 0 && currentState.thinkingBuffer.length === 0) break;
    }

    // Should be roughly equal split
    expect(Math.abs(textTotal - thinkingTotal)).toBeLessThanOrEqual(2);
  });

  it("updates smoothed rate with new instant rate", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hello world",
      smoothedRate: 50,
    };
    const result = stepAnimation(state, config, 100);

    // EMA: 50 * 0.85 + 100 * 0.15 = 57.5
    expect(result.state.smoothedRate).toBeCloseTo(57.5);
  });

  it("preserves smoothed rate when no new SSE data", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hello world",
      smoothedRate: 50,
    };
    const result = stepAnimation(state, config, 0);

    expect(result.state.smoothedRate).toBe(50);
  });

  it("never displays more chars than available in buffer", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hi",
      textAccum: 2.0, // pre-loaded accumulator
      smoothedRate: 600,
    };
    const result = stepAnimation(state, config, 0);

    expect(result.textChars).toBeLessThanOrEqual(2);
  });

  it("does not produce negative char counts", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "A",
      thinkingBuffer: "B",
      smoothedRate: 0,
    };
    const step = stepAnimation(state, DEFAULT_CONFIG, 0);
    expect(step.textChars).toBeGreaterThanOrEqual(0);
    expect(step.thinkingChars).toBeGreaterThanOrEqual(0);
  });
});

// ── consumeFromBuffer ────────────────────────────────────────────────

describe("consumeFromBuffer", () => {
  it("removes consumed characters from buffer", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hello, world!",
    };
    const result = consumeFromBuffer(state, 5, 0);

    expect(result.textBuffer).toBe(", world!");
  });

  it("handles consuming all characters", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hi",
    };
    const result = consumeFromBuffer(state, 2, 0);

    expect(result.textBuffer).toBe("");
  });
});

// ── Integration: full animation cycle ────────────────────────────────

describe("full animation cycle", () => {
  const config = DEFAULT_CONFIG;

  /**
   * The key test: smooth, steady playback at a readable pace.
   * Text should NOT zip through chunks then stall — it should
   * flow at a consistent rate.
   */
  it("maintains steady readable pace across chunked SSE arrivals", () => {
    let state = createInitialState();
    let displayedTextLen = 0;
    let displayedThinkingLen = 0;
    let lastCumulative = 0;
    let lastInstantRate = 0;

    // Simulate chunks arriving at irregular intervals
    const events = [
      { time: 0, text: "Hi", thinking: "" },
      { time: 50, text: "Hi there!", thinking: "" },
      { time: 150, text: "Hi there! How", thinking: "" },
      { time: 400, text: "Hi there! How are you?", thinking: "" },
      { time: 800, text: "Hi there! How are you doing today?", thinking: "" },
    ];

    let eventIndex = 0;
    let frameTime = 0;
    let totalFrames = 0;
    const displayTimes: number[] = []; // track when each char was displayed

    while (totalFrames < 3000) {
      // Feed events
      while (eventIndex < events.length && events[eventIndex]!.time <= frameTime) {
        const evt = events[eventIndex]!;
        const newCumulative = evt.text.length + evt.thinking.length;

        if (newCumulative !== lastCumulative) {
          state = feedBuffer(
            state,
            evt.text,
            evt.thinking,
            displayedTextLen,
            displayedThinkingLen,
            1000 + evt.time,
          );
          lastCumulative = newCumulative;

          const instantRate = estimateInstantRate(state);
          if (instantRate > 0) lastInstantRate = instantRate;
        }
        eventIndex++;
      }

      // Recompute buffer every frame
      const currentText = eventIndex > 0 ? events[eventIndex - 1]!.text : "";
      const currentThinking = eventIndex > 0 ? events[eventIndex - 1]!.thinking : "";
      const pending = computePending(
        currentText,
        currentThinking,
        displayedTextLen,
        displayedThinkingLen,
      );

      const stateWithBuffer = {
        ...state,
        textBuffer: pending.textPending,
        thinkingBuffer: pending.thinkingPending,
      };

      const step = stepAnimation(stateWithBuffer, config, lastInstantRate);

      if (step.textChars > 0 || step.thinkingChars > 0) {
        displayTimes.push(frameTime);
      }

      displayedTextLen += step.textChars;
      displayedThinkingLen += step.thinkingChars;
      // Preserve accumulators from step result, consume buffers
      state = {
        ...step.state,
        textBuffer: pending.textPending.slice(step.textChars),
        thinkingBuffer: pending.thinkingPending.slice(step.thinkingChars),
      };

      totalFrames++;
      frameTime += 1000 / 60;

      if (
        eventIndex >= events.length &&
        pending.textPending.length === 0 &&
        pending.thinkingPending.length === 0
      ) {
        break;
      }
    }

    // Verify: animation completed
    expect(totalFrames).toBeLessThan(3000);

    // Verify: all content displayed
    expect(displayedTextLen).toBe(events[events.length - 1]!.text.length);

    // Verify: display is relatively even (no huge gaps between displayed chars)
    // With fractional accumulation, chars should be spaced ~7-8 frames apart
    if (displayTimes.length > 2) {
      const gaps: number[] = [];
      for (let i = 1; i < displayTimes.length; i++) {
        gaps.push(displayTimes[i]! - displayTimes[i - 1]!);
      }
      const maxGap = Math.max(...gaps);
      // Max gap should be reasonable (not 30+ frames = 0.5s gaps)
      expect(maxGap).toBeLessThan(2000); // 2000ms = very generous
    }
  });

  /**
   * During SSE gaps, the animation continues at the preserved rate.
   * This is the anti-jerky guarantee: no stalling between chunks.
   */
  it("continues displaying during SSE gaps at steady rate", () => {
    let state = createInitialState();

    // Feed initial chunk: 40 chars
    state = feedBuffer(state, "Hello, this is a test message for checking!", "", 0, 0, 1000);

    // Simulate 120 frames (2 seconds at 60fps) with NO new SSE data
    let totalDisplayed = 0;
    let currentState = state;
    for (let i = 0; i < 120; i++) {
      const step = stepAnimation(currentState, DEFAULT_CONFIG, 0);
      totalDisplayed += step.textChars + step.thinkingChars;
      currentState = step.state;
      currentState = consumeFromBuffer(currentState, step.textChars, step.thinkingChars);

      if (currentState.textBuffer.length === 0 && currentState.thinkingBuffer.length === 0) {
        break;
      }
    }

    // At 8 chars/sec, over 2 seconds = ~16 chars displayed
    // (capped at 40 total available)
    expect(totalDisplayed).toBeGreaterThan(8);
    expect(totalDisplayed).toBeLessThanOrEqual(40);
  });

  /**
   * Smoothed rate is preserved across SSE gaps (not decayed).
   */
  it("preserves smoothed rate across SSE gaps", () => {
    let state = createInitialState();
    state = feedBuffer(state, "Hello", "", 0, 0, 1000);
    state = feedBuffer(state, "Hello, world!", "", 0, 0, 1050);

    const instantRate = estimateInstantRate(state);
    expect(instantRate).toBeGreaterThan(0);

    let step = stepAnimation(state, DEFAULT_CONFIG, instantRate);
    const smoothedAfterFirst = step.state.smoothedRate;
    expect(smoothedAfterFirst).toBeGreaterThan(0);
    state = step.state;

    // 100 frames with no new SSE data
    for (let i = 0; i < 100; i++) {
      step = stepAnimation(state, DEFAULT_CONFIG, 0);
      state = step.state;
    }

    expect(state.smoothedRate).toBe(smoothedAfterFirst);
  });

  /**
   * Rate tracking is not poisoned when feedBuffer is called only on data changes.
   */
  it("rate tracking is not poisoned when feedBuffer is called only on data changes", () => {
    let state = createInitialState();
    let displayedTextLen = 0;
    let displayedThinkingLen = 0;
    let lastCumulative = 0;
    let lastInstantRate = 0;

    const events = [
      { time: 1000, text: "Hello there!", thinking: "" },
      { time: 1500, text: "Hello there! How are you?", thinking: "" },
    ];

    let eventIndex = 0;
    let frameTime = 1000;
    let totalFrames = 0;

    while (totalFrames < 500) {
      const hasNewEvent = eventIndex < events.length && events[eventIndex]!.time <= frameTime;

      if (hasNewEvent) {
        const evt = events[eventIndex]!;
        const newCumulative = evt.text.length + evt.thinking.length;

        if (newCumulative !== lastCumulative) {
          state = feedBuffer(
            state,
            evt.text,
            evt.thinking,
            displayedTextLen,
            displayedThinkingLen,
            evt.time,
          );
          lastCumulative = newCumulative;

          const instantRate = estimateInstantRate(state);
          if (instantRate > 0) lastInstantRate = instantRate;
        }
        eventIndex++;
      }

      const currentText = eventIndex > 0 ? events[eventIndex - 1]!.text : "";
      const currentThinking = eventIndex > 0 ? events[eventIndex - 1]!.thinking : "";
      const pending = computePending(
        currentText,
        currentThinking,
        displayedTextLen,
        displayedThinkingLen,
      );

      const stateWithBuffer = {
        ...state,
        textBuffer: pending.textPending,
        thinkingBuffer: pending.thinkingPending,
      };

      const step = stepAnimation(stateWithBuffer, DEFAULT_CONFIG, lastInstantRate);

      displayedTextLen += step.textChars;
      displayedThinkingLen += step.thinkingChars;
      state = {
        ...step.state,
        textBuffer: pending.textPending.slice(step.textChars),
        thinkingBuffer: pending.thinkingPending.slice(step.thinkingChars),
      };

      totalFrames++;
      frameTime += 1000 / 60;

      if (
        eventIndex >= events.length &&
        pending.textPending.length === 0 &&
        pending.thinkingPending.length === 0
      ) {
        break;
      }
    }

    expect(totalFrames).toBeLessThan(500);
    expect(displayedTextLen).toBe(events[events.length - 1]!.text.length);
    expect(lastInstantRate).toBeGreaterThan(0);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles thinking-only content", () => {
    let state = createInitialState();
    state = feedBuffer(state, "", "Deep reasoning here", 0, 0, 1000);

    // Run enough frames to display some thinking
    let totalDisplayed = 0;
    let currentState = state;
    for (let i = 0; i < 120; i++) {
      const step = stepAnimation(currentState, DEFAULT_CONFIG, 0);
      totalDisplayed += step.thinkingChars;
      currentState = step.state;
      currentState = consumeFromBuffer(currentState, step.textChars, step.thinkingChars);
      if (currentState.thinkingBuffer.length === 0) break;
    }

    expect(totalDisplayed).toBeGreaterThan(0);
  });

  it("handles very long single chunk", () => {
    const longText = "A".repeat(1000);
    let state = createInitialState();
    state = feedBuffer(state, longText, "", 0, 0, 1000);

    // Even with huge buffer, display rate is capped
    let totalDisplayed = 0;
    let currentState = state;
    for (let i = 0; i < 60; i++) {
      const step = stepAnimation(currentState, DEFAULT_CONFIG, 0);
      totalDisplayed += step.textChars;
      currentState = step.state;
      currentState = consumeFromBuffer(currentState, step.textChars, 0);
    }

    // At max 16 chars/sec, over 1 second = ~16 chars
    expect(totalDisplayed).toBeLessThanOrEqual(25);
  });

  it("does not produce negative char counts", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "A",
      thinkingBuffer: "B",
      smoothedRate: 0,
    };
    const step = stepAnimation(state, DEFAULT_CONFIG, 0);
    expect(step.textChars).toBeGreaterThanOrEqual(0);
    expect(step.thinkingChars).toBeGreaterThanOrEqual(0);
  });

  it("handles buffer becoming empty mid-run", () => {
    let state: AnimationState = {
      ...createInitialState(),
      textBuffer: "AB",
      textAccum: 1.9, // almost ready to display 2 chars
      smoothedRate: 0,
    };

    // First step: should display 1 char (accumulator >= 1)
    let step = stepAnimation(state, DEFAULT_CONFIG, 0);
    expect(step.textChars).toBeGreaterThanOrEqual(1);

    // Consume 1 char, leaving 1
    state = consumeFromBuffer(step.state, step.textChars, 0);

    // Continue — should eventually drain
    let totalDisplayed = step.textChars;
    for (let i = 0; i < 60; i++) {
      step = stepAnimation(state, DEFAULT_CONFIG, 0);
      totalDisplayed += step.textChars;
      state = consumeFromBuffer(step.state, step.textChars, 0);
      if (state.textBuffer.length === 0) break;
    }

    expect(totalDisplayed).toBeLessThanOrEqual(2);
  });
});
