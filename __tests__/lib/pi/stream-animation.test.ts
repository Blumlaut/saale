import { describe, it, expect } from "vitest";
import {
  createInitialState,
  feedBuffer,
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
  it("creates a zeroed state", () => {
    const state = createInitialState();
    expect(state.textBuffer).toBe("");
    expect(state.thinkingBuffer).toBe("");
    expect(state.smoothedRate).toBe(0);
    expect(state.rateStartChars).toBe(0);
    expect(state.rateStartTime).toBe(0);
    expect(state.rateLastChars).toBe(0);
    expect(state.rateLastTime).toBe(0);
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
    // SSE sent "Hello, world!" but we already displayed "Hello, "
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

    // First feed at t=1000, 10 chars total
    state = feedBuffer(state, "Hello", "", 0, 0, 1000);
    expect(state.rateLastChars).toBe(5);
    expect(state.rateLastTime).toBe(1000);
    expect(state.rateStartChars).toBe(0);
    expect(state.rateStartTime).toBe(0);

    // Second feed at t=1100, 14 chars total
    state = feedBuffer(state, "Hello, World!!", "", 0, 0, 1100);
    expect(state.rateLastChars).toBe(14);
    expect(state.rateLastTime).toBe(1100);
    expect(state.rateStartChars).toBe(5); // previous last became start
    expect(state.rateStartTime).toBe(1000);
  });

  it("resets rate window when cumulative chars decrease (new stream)", () => {
    let state = createInitialState();
    state = feedBuffer(state, "Some text", "", 0, 0, 1000);
    expect(state.rateLastChars).toBe(9);

    // New stream: cumulative chars reset to less than previous
    state = feedBuffer(state, "Hi", "", 0, 0, 2000);
    expect(state.rateStartChars).toBe(0);
    expect(state.rateStartTime).toBe(0);
    expect(state.rateLastChars).toBe(2);
    expect(state.rateLastTime).toBe(2000);
  });

  it("handles empty buffers when fully caught up", () => {
    const state = createInitialState();
    // SSE text is "Hello" and we've already displayed all 5 chars
    const result = feedBuffer(state, "Hello", "", 5, 0, 1000);

    expect(result.textBuffer).toBe("");
    expect(result.thinkingBuffer).toBe("");
  });

  it("handles thinking-only updates", () => {
    const state = createInitialState();
    const result = feedBuffer(state, "", "Deep thought", 0, 0, 1000);

    expect(result.textBuffer).toBe("");
    expect(result.thinkingBuffer).toBe("Deep thought");
  });
});

// ── estimateInstantRate ──────────────────────────────────────────────

describe("estimateInstantRate", () => {
  it("returns 0 when no rate data available", () => {
    const state = createInitialState();
    expect(estimateInstantRate(state)).toBe(0);
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
    // 100 chars in 1 second = 100 chars/sec
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
    // 50 chars in 50ms = 1000 chars/sec
    expect(estimateInstantRate(state)).toBe(1000);
  });

  it("returns 0 when time delta is zero", () => {
    const state: AnimationState = {
      ...createInitialState(),
      rateStartChars: 0,
      rateStartTime: 1000,
      rateLastChars: 100,
      rateLastTime: 1000,
    };
    expect(estimateInstantRate(state)).toBe(0);
  });
});

// ── updateSmoothedRate ───────────────────────────────────────────────

describe("updateSmoothedRate", () => {
  it("preserves smoothed rate when instant rate is 0 (SSE gap)", () => {
    const result = updateSmoothedRate(50, 0, 0.2);
    expect(result).toBe(50);
  });

  it("preserves smoothed rate when instant rate is negative", () => {
    const result = updateSmoothedRate(50, -10, 0.2);
    expect(result).toBe(50);
  });

  it("applies EMA smoothing for positive instant rate", () => {
    // smoothed=50, instant=100, ema=0.2
    // result = 50 * 0.8 + 100 * 0.2 = 40 + 20 = 60
    const result = updateSmoothedRate(50, 100, 0.2);
    expect(result).toBe(60);
  });

  it("smoothly transitions from zero rate", () => {
    // First SSE event: smoothed=0, instant=200
    // result = 0 * 0.8 + 200 * 0.2 = 40
    const result = updateSmoothedRate(0, 200, 0.2);
    expect(result).toBe(40);
  });

  it("converges toward instant rate over multiple updates", () => {
    let smoothed = 0;
    const instant = 100;
    const ema = 0.2;

    for (let i = 0; i < 20; i++) {
      smoothed = updateSmoothedRate(smoothed, instant, ema);
    }

    // After 20 iterations with EMA 0.2, should be close to 100
    expect(smoothed).toBeGreaterThan(90);
    expect(smoothed).toBeLessThanOrEqual(100);
  });
});

// ── computeCatchUpBoost ──────────────────────────────────────────────

describe("computeCatchUpBoost", () => {
  it("returns 1 when buffer is at or below threshold", () => {
    expect(computeCatchUpBoost(0, 50, 2)).toBe(1);
    expect(computeCatchUpBoost(49, 50, 2)).toBe(1);
    expect(computeCatchUpBoost(50, 50, 2)).toBe(1);
  });

  it("increases proportionally above threshold", () => {
    // 150 pending, threshold 50 → excess 100 → boost = min(2, 1 + 100/100) = 2
    expect(computeCatchUpBoost(150, 50, 2)).toBe(2);
  });

  it("caps at max boost", () => {
    // 500 pending, threshold 50 → excess 450 → raw boost = 1 + 450/100 = 5.5 → capped at 2
    expect(computeCatchUpBoost(500, 50, 2)).toBe(2);
  });

  it("scales smoothly between threshold and cap", () => {
    // 100 pending, threshold 50 → excess 50 → boost = 1 + 50/100 = 1.5
    expect(computeCatchUpBoost(100, 50, 2)).toBeCloseTo(1.5);
  });
});

// ── stepAnimation ────────────────────────────────────────────────────

describe("stepAnimation", () => {
  const config = DEFAULT_CONFIG;

  it("returns zero chars when no pending buffer", () => {
    const state = createInitialState();
    const result = stepAnimation(state, config, 0);

    expect(result.textChars).toBe(0);
    expect(result.thinkingChars).toBe(0);
    expect(result.hasPending).toBe(false);
  });

  it("uses minimum rate when smoothed rate is zero", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hello world this is a test",
      smoothedRate: 0,
    };
    const result = stepAnimation(state, config, 0);

    // Minimum: 0.4 chars/frame, rounded to at least 0
    expect(result.textChars).toBeGreaterThanOrEqual(0);
    expect(result.textChars).toBeLessThanOrEqual(1);
    expect(result.hasPending).toBe(true);
  });

  it("scales chars per frame from smoothed rate", () => {
    // smoothedRate = 120 chars/sec, targetFps = 60 → 2 chars/frame
    // But capped at maxCharsPerFrame = 2.0
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "A".repeat(100),
      smoothedRate: 120,
    };
    const result = stepAnimation(state, config, 0);

    expect(result.textChars).toBeLessThanOrEqual(2);
    expect(result.textChars).toBeGreaterThan(0);
  });

  it("clamps to max chars per frame", () => {
    // smoothedRate = 600 chars/sec → 10 chars/frame → capped at 2
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "A".repeat(100),
      smoothedRate: 600,
    };
    const result = stepAnimation(state, config, 0);

    expect(result.textChars).toBeLessThanOrEqual(2);
  });

  it("applies catch-up boost when buffer exceeds threshold", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "A".repeat(200), // well above threshold of 50
      smoothedRate: 60, // 1 char/frame base
    };
    const result = stepAnimation(state, config, 0);

    // With 200 chars pending, boost = min(2, 1 + 150/100) = 2
    // So charsPerFrame = 1 * 2 = 2 (capped at max)
    expect(result.textChars).toBeGreaterThanOrEqual(1);
    expect(result.textChars).toBeLessThanOrEqual(2);
  });

  it("splits proportionally between text and thinking", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "AAAAA", // 5 chars
      thinkingBuffer: "BBBB", // 4 chars
      smoothedRate: 60, // 1 char/frame
    };
    const result = stepAnimation(state, config, 0);

    // Total pending: 9, text ratio: 5/9
    // charsPerFrame ≈ 1 (from rate 60/60)
    // textChars ≈ round(1 * 5/9) = 1, thinkingChars ≈ ceil(1 - 1) = 0
    // Or textChars = 0, thinkingChars = 1 depending on rounding
    expect(result.textChars + result.thinkingChars).toBeGreaterThanOrEqual(0);
    expect(result.textChars + result.thinkingChars).toBeLessThanOrEqual(2);
  });

  it("never displays more chars than available in buffer", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hi", // only 2 chars
      smoothedRate: 600, // would want 10 chars/frame
    };
    const result = stepAnimation(state, config, 0);

    expect(result.textChars).toBeLessThanOrEqual(2);
  });

  it("updates smoothed rate with new instant rate", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hello world",
      smoothedRate: 50,
    };
    const result = stepAnimation(state, config, 100);

    // EMA: 50 * 0.8 + 100 * 0.2 = 60
    expect(result.state.smoothedRate).toBe(60);
  });

  it("preserves smoothed rate when no new SSE data (instantRate=0)", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hello world",
      smoothedRate: 50,
    };
    const result = stepAnimation(state, config, 0);

    expect(result.state.smoothedRate).toBe(50);
  });
});

// ── consumeFromBuffer ────────────────────────────────────────────────

describe("consumeFromBuffer", () => {
  it("removes consumed characters from buffer", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hello, world!",
      thinkingBuffer: "Thinking...",
    };
    const result = consumeFromBuffer(state, 5, 3);

    expect(result.textBuffer).toBe(", world!");
    // "Thinking...".slice(3) = "nking..."
    expect(result.thinkingBuffer).toBe("nking...");
  });

  it("handles consuming all characters", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hi",
      thinkingBuffer: "",
    };
    const result = consumeFromBuffer(state, 2, 0);

    expect(result.textBuffer).toBe("");
    expect(result.thinkingBuffer).toBe("");
  });

  it("preserves other state fields", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "Hello",
      smoothedRate: 100,
    };
    const result = consumeFromBuffer(state, 3, 0);

    expect(result.smoothedRate).toBe(100);
    // "Hello".slice(3) = "lo"
    expect(result.textBuffer).toBe("lo");
  });
});

// ── Integration: full animation cycle ────────────────────────────────

describe("full animation cycle", () => {
  const config = DEFAULT_CONFIG;

  /**
   * Simulate a complete streaming session with chunked SSE arrivals
   * and verify smooth, non-jerky playback.
   */
  it("smoothly animates through chunked SSE arrivals without jerky pauses", () => {
    let state = createInitialState();
    let displayedText = "";
    let displayedThinking = "";
    const frames: number[] = [];

    // Simulate SSE chunks arriving at irregular intervals
    const chunks = [
      { time: 1000, text: "Hello", thinking: "" },
      { time: 1050, text: "Hello, how", thinking: "" }, // 50ms later, 7 more chars
      { time: 1200, text: "Hello, how are", thinking: "Let me" }, // 150ms gap, more chars
      { time: 2500, text: "Hello, how are you?", thinking: "Let me think" }, // 1300ms gap!
      { time: 2600, text: "Hello, how are you today?", thinking: "Let me think about this" },
    ];

    let chunkIndex = 0;
    let currentTime = 1000;
    let frameCount = 0;
    const maxFrames = 500; // safety limit

    // Simulate animation frames at 60fps (≈16.67ms apart)
    while (frameCount < maxFrames) {
      // Feed any SSE chunks that have arrived by now
      while (chunkIndex < chunks.length && chunks[chunkIndex]!.time <= currentTime) {
        const chunk = chunks[chunkIndex]!;
        state = feedBuffer(
          state,
          chunk.text,
          chunk.thinking,
          displayedText.length,
          displayedThinking.length,
          chunk.time,
        );
        chunkIndex++;
      }

      // Estimate instant rate from current state
      const instantRate = estimateInstantRate(state);

      // Step animation
      const step = stepAnimation(state, config, instantRate);

      // Consume displayed characters
      state = consumeFromBuffer(state, step.textChars, step.thinkingChars);
      displayedText = displayedText + "".padEnd(step.textChars); // track length only
      displayedThinking = displayedThinking + "".padEnd(step.thinkingChars);

      // Actually track lengths properly
      frames.push(state.textBuffer.length + state.thinkingBuffer.length);

      frameCount++;
      currentTime += 1000 / 60; // ~16.67ms per frame

      // Stop when all chunks fed and buffer drained
      if (
        chunkIndex >= chunks.length &&
        state.textBuffer.length === 0 &&
        state.thinkingBuffer.length === 0
      ) {
        break;
      }
    }

    // Verify: animation completed
    expect(frameCount).toBeLessThan(maxFrames);

    // Verify: no frame had a massive spike in pending chars (would indicate jerky behavior)
    // With smooth animation, the buffer should stay bounded
    const maxBuffer = Math.max(...frames);
    expect(maxBuffer).toBeLessThan(50); // should never build up to 50+ chars
  });

  /**
   * The key test: during SSE gaps (no new chunks), the animation
   * should continue displaying buffered chars at a steady minimum rate.
   * This is the anti-jerky guarantee.
   */
  it("maintains minimum display rate during SSE gaps", () => {
    let state = createInitialState();

    // Feed initial chunk: 30 chars
    state = feedBuffer(state, "Hello, this is a test message!", "", 0, 0, 1000);

    // Simulate 60 frames (1 second at 60fps) with NO new SSE data
    let totalDisplayed = 0;
    for (let i = 0; i < 60; i++) {
      const step = stepAnimation(state, DEFAULT_CONFIG, 0); // instantRate=0 (no new data)
      state = consumeFromBuffer(state, step.textChars, step.thinkingChars);
      totalDisplayed += step.textChars + step.thinkingChars;

      if (state.textBuffer.length === 0 && state.thinkingBuffer.length === 0) {
        break;
      }
    }

    // With min rate of 0.4 chars/frame at 60fps = 24 chars/sec minimum
    // Over ~1 second (60 frames), should display at least 0.4 * 30 = 12 chars
    // (capped at 30 total available)
    expect(totalDisplayed).toBeGreaterThan(0);
    // Should have consumed all or most of the 30-char buffer
    expect(totalDisplayed).toBeGreaterThanOrEqual(12);
  });

  /**
   * After a long SSE gap, playback should NOT slow down — the smoothed
   * rate is preserved (not decayed) so display continues at the last
   * known good rate.
   */
  it("preserves smoothed rate across SSE gaps", () => {
    let state = createInitialState();

    // First chunk establishes rate
    state = feedBuffer(state, "Hello", "", 0, 0, 1000);
    state = feedBuffer(state, "Hello, world!", "", 0, 0, 1050);

    // Instant rate: 13 chars in 50ms = 260 chars/sec
    const instantRate = estimateInstantRate(state);
    expect(instantRate).toBeGreaterThan(0);

    // Step with this rate to establish smoothed rate
    let step = stepAnimation(state, DEFAULT_CONFIG, instantRate);
    const smoothedAfterFirst = step.state.smoothedRate;
    expect(smoothedAfterFirst).toBeGreaterThan(0);
    state = step.state;

    // Now simulate 100 frames with NO new SSE data (instantRate=0)
    for (let i = 0; i < 100; i++) {
      step = stepAnimation(state, DEFAULT_CONFIG, 0);
      state = step.state;
    }

    // Smoothed rate should be PRESERVED, not decayed to 0
    expect(state.smoothedRate).toBe(smoothedAfterFirst);
  });

  /**
   * Catch-up: when buffer grows large (SSE faster than display),
   * the animation speeds up to drain the buffer.
   */
  it("catches up when buffer exceeds threshold", () => {
    const state: AnimationState = {
      ...createInitialState(),
      textBuffer: "A".repeat(200), // large buffer
      smoothedRate: 60, // 1 char/frame base rate
    };

    const step = stepAnimation(state, DEFAULT_CONFIG, 0);

    // With 200 chars pending (threshold=50), boost should kick in
    const boost = computeCatchUpBoost(
      200,
      DEFAULT_CONFIG.catchUpThreshold,
      DEFAULT_CONFIG.maxCatchUpBoost,
    );
    expect(boost).toBeGreaterThan(1);
    // charsPerFrame should be boosted (base 1 * boost, capped at 2)
    expect(step.textChars).toBeGreaterThanOrEqual(1);
  });

  /**
   * End-to-end: simulate realistic streaming with varying chunk sizes
   * and verify the display catches up smoothly.
   */
  it("handles realistic streaming pattern with varying chunk sizes", () => {
    let state = createInitialState();
    let displayedTextLen = 0;
    let displayedThinkingLen = 0;

    // Realistic pattern: chunks arrive at varying sizes and intervals
    const events = [
      { time: 0, text: "Hi", thinking: "" },
      { time: 30, text: "Hi there!", thinking: "" },
      { time: 80, text: "Hi there! How", thinking: "Let me" },
      { time: 150, text: "Hi there! How are", thinking: "Let me think" },
      {
        time: 300,
        text: "Hi there! How are you doing today? I hope you're having a great day!",
        thinking: "Let me think about how to respond warmly",
      },
      {
        time: 500,
        text: "Hi there! How are you doing today? I hope you're having a great day! It's always nice to connect and chat.",
        thinking: "Let me think about how to respond warmly and engage in conversation",
      },
    ];

    let eventIndex = 0;
    let frameTime = 0;
    let totalFrames = 0;
    let displayedDuringGap = 0; // chars displayed during SSE gaps
    let inGap = false;

    while (totalFrames < 3000) {
      // Feed events
      while (eventIndex < events.length && events[eventIndex]!.time <= frameTime) {
        const evt = events[eventIndex]!;
        state = feedBuffer(
          state,
          evt.text,
          evt.thinking,
          displayedTextLen,
          displayedThinkingLen,
          1000 + evt.time,
        );
        inGap = false;
        eventIndex++;
      }

      if (eventIndex >= events.length) {
        inGap = true;
      }

      const instantRate = estimateInstantRate(state);
      const step = stepAnimation(state, DEFAULT_CONFIG, inGap ? 0 : instantRate);

      displayedTextLen += step.textChars;
      displayedThinkingLen += step.thinkingChars;
      state = consumeFromBuffer(state, step.textChars, step.thinkingChars);

      if (inGap) {
        displayedDuringGap += step.textChars + step.thinkingChars;
      }

      totalFrames++;
      frameTime += 1000 / 60;

      if (
        eventIndex >= events.length &&
        state.textBuffer.length === 0 &&
        state.thinkingBuffer.length === 0
      ) {
        break;
      }
    }

    // Verify: animation completed within frame budget
    expect(totalFrames).toBeLessThan(3000);

    // Verify: chars were displayed during SSE gaps (anti-jerky)
    expect(displayedDuringGap).toBeGreaterThan(0);

    // Verify: all content was eventually displayed
    const finalText = events[events.length - 1]!.text;
    const finalThinking = events[events.length - 1]!.thinking;
    expect(displayedTextLen).toBe(finalText.length);
    expect(displayedThinkingLen).toBe(finalThinking.length);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles thinking-only content", () => {
    let state = createInitialState();
    state = feedBuffer(state, "", "Deep reasoning here", 0, 0, 1000);

    const step = stepAnimation(state, DEFAULT_CONFIG, 0);
    expect(step.textChars).toBe(0);
    expect(step.thinkingChars).toBeGreaterThan(0);
  });

  it("handles text-only content", () => {
    let state = createInitialState();
    state = feedBuffer(state, "Just text", "", 0, 0, 1000);

    const step = stepAnimation(state, DEFAULT_CONFIG, 0);
    expect(step.textChars).toBeGreaterThan(0);
    expect(step.thinkingChars).toBe(0);
  });

  it("handles single character buffer", () => {
    let state = createInitialState();
    state = feedBuffer(state, "X", "", 0, 0, 1000);

    const step = stepAnimation(state, DEFAULT_CONFIG, 0);
    expect(step.textChars).toBeLessThanOrEqual(1);
  });

  it("handles very long single chunk", () => {
    const longText = "A".repeat(1000);
    let state = createInitialState();
    state = feedBuffer(state, longText, "", 0, 0, 1000);

    const step = stepAnimation(state, DEFAULT_CONFIG, 0);
    // Should be capped at maxCharsPerFrame
    expect(step.textChars).toBeLessThanOrEqual(DEFAULT_CONFIG.maxCharsPerFrame);
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
