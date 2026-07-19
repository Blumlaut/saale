/**
 * Pure animation logic for streaming text display.
 *
 * Decouples SSE chunk arrival from display timing using a buffer-based approach:
 * - Incoming characters accumulate in a buffer
 * - The animation loop consumes from the buffer at a steady display rate
 * - Rate adapts to SSE patterns via EMA smoothing
 * - Catch-up mechanism prevents buffer from growing unbounded
 * - Minimum display rate ensures progress even during SSE gaps
 *
 * All functions are pure and testable — no React, no refs, no side effects.
 */

/** Configuration for the animation loop. */
export interface AnimationConfig {
  /** Target frames per second (default: 60). */
  targetFps: number;
  /** Minimum chars displayed per frame when caught up (default: 0.4). */
  slowCharsPerFrame: number;
  /** Maximum chars displayed per frame to avoid "zipping" (default: 2.0). */
  maxCharsPerFrame: number;
  /** Buffer size threshold to trigger catch-up (default: 50). */
  catchUpThreshold: number;
  /** Maximum catch-up boost multiplier (default: 2). */
  maxCatchUpBoost: number;
  /** EMA smoothing factor for rate estimation (default: 0.2). */
  emaFactor: number;
}

export const DEFAULT_CONFIG: AnimationConfig = {
  targetFps: 60,
  slowCharsPerFrame: 1.5, // ~90 chars/sec — smooth minimum, no stalls
  maxCharsPerFrame: 3.0, // higher cap for catch-up without zipping
  catchUpThreshold: 30, // kick in sooner when buffer grows
  maxCatchUpBoost: 2,
  emaFactor: 0.3, // faster adaptation to rate changes
};

/** State tracked between animation frames. */
export interface AnimationState {
  /** Characters received but not yet displayed (text portion). */
  textBuffer: string;
  /** Characters received but not yet displayed (thinking portion). */
  thinkingBuffer: string;
  /** Smoothed display rate in chars/sec. */
  smoothedRate: number;
  /** First measurement point for rate calculation. */
  rateStartChars: number;
  rateStartTime: number;
  /** Last measurement point for rate calculation. */
  rateLastChars: number;
  rateLastTime: number;
}

/** Result of one animation step. */
export interface AnimationStepResult {
  /** Characters to display this frame (text). */
  textChars: number;
  /** Characters to display this frame (thinking). */
  thinkingChars: number;
  /** Updated animation state for the next frame. */
  state: AnimationState;
  /** Whether there are still characters pending. */
  hasPending: boolean;
}

/**
 * Create initial animation state.
 */
export function createInitialState(): AnimationState {
  return {
    textBuffer: "",
    thinkingBuffer: "",
    smoothedRate: 0,
    rateStartChars: 0,
    rateStartTime: 0,
    rateLastChars: 0,
    rateLastTime: 0,
  };
}

/**
 * Compute the pending buffer lengths from cumulative text minus displayed.
 *
 * Pure buffer computation — does NOT touch rate tracking.
 * Call this every animation frame to get current pending chars.
 *
 * @param newText - Full cumulative text from SSE (not a delta).
 * @param newThinking - Full cumulative thinking from SSE (not a delta).
 * @param displayedTextLength - Number of text characters already displayed.
 * @param displayedThinkingLength - Number of thinking characters already displayed.
 */
export function computePending(
  newText: string,
  newThinking: string,
  displayedTextLength: number,
  displayedThinkingLength: number,
): { textPending: string; thinkingPending: string } {
  return {
    textPending: newText.slice(displayedTextLength),
    thinkingPending: newThinking.slice(displayedThinkingLength),
  };
}

/**
 * Feed new characters into the buffer from an SSE update.
 *
 * This is called ONLY when new SSE data arrives (cumulative chars changed).
 * It updates the rate tracking window and sets the buffer.
 *
 * CRITICAL: Do NOT call this every animation frame — it shifts the rate
 * tracking window and will poison the rate estimate with zero-delta frames.
 *
 * @param state - Current animation state.
 * @param newText - Full cumulative text from SSE (not a delta).
 * @param newThinking - Full cumulative thinking from SSE (not a delta).
 * @param displayedTextLength - Number of text characters already displayed.
 * @param displayedThinkingLength - Number of thinking characters already displayed.
 * @param nowMs - Current timestamp in milliseconds.
 */
export function feedBuffer(
  state: AnimationState,
  newText: string,
  newThinking: string,
  displayedTextLength: number,
  displayedThinkingLength: number,
  nowMs: number,
): AnimationState {
  // Compute new buffers (everything not yet displayed)
  const textBuffer = newText.slice(displayedTextLength);
  const thinkingBuffer = newThinking.slice(displayedThinkingLength);

  // Update rate tracking window: shift last → start, current → last
  const cumulativeChars = newText.length + newThinking.length;
  let rateStartChars = state.rateStartChars;
  let rateStartTime = state.rateStartTime;
  let rateLastChars = state.rateLastChars;
  let rateLastTime = state.rateLastTime;

  // Reset rate window if cumulative count has reset (new stream)
  if (cumulativeChars < state.rateLastChars) {
    rateStartChars = 0;
    rateStartTime = 0;
    rateLastChars = 0;
    rateLastTime = 0;
  }

  // Shift window
  rateStartChars = rateLastChars;
  rateStartTime = rateLastTime;
  rateLastChars = cumulativeChars;
  rateLastTime = nowMs;

  return {
    ...state,
    textBuffer,
    thinkingBuffer,
    rateStartChars,
    rateStartTime,
    rateLastChars,
    rateLastTime,
  };
}

/**
 * Estimate the instantaneous SSE rate from the rate tracking window.
 *
 * Returns 0 if there isn't enough data to compute a rate.
 *
 * @param state - Current animation state with rate tracking data.
 */
export function estimateInstantRate(state: AnimationState): number {
  if (state.rateStartTime === 0 || state.rateLastTime === 0) {
    return 0;
  }
  const charsDelta = state.rateLastChars - state.rateStartChars;
  const timeDelta = state.rateLastTime - state.rateStartTime;
  if (timeDelta <= 0) return 0;
  return charsDelta / (timeDelta / 1000);
}

/**
 * Update the smoothed rate using Exponential Moving Average.
 *
 * Only updates when instantRate > 0 (new SSE data arrived).
 * When no new data, the smoothed rate is preserved (not decayed)
 * to maintain steady playback during SSE gaps.
 *
 * @param smoothedRate - Current smoothed rate.
 * @param instantRate - Latest instantaneous rate estimate.
 * @param emaFactor - Smoothing factor (0-1, lower = more smoothing).
 */
export function updateSmoothedRate(
  smoothedRate: number,
  instantRate: number,
  emaFactor: number,
): number {
  if (instantRate <= 0) return smoothedRate;
  return smoothedRate * (1 - emaFactor) + instantRate * emaFactor;
}

/**
 * Compute the catch-up boost multiplier based on buffer size.
 *
 * When the buffer exceeds the threshold, speed up proportionally
 * to prevent the display from falling too far behind.
 *
 * @param totalPending - Total characters pending in both buffers.
 * @param threshold - Buffer size threshold for catch-up.
 * @param maxBoost - Maximum boost multiplier.
 */
export function computeCatchUpBoost(
  totalPending: number,
  threshold: number,
  maxBoost: number,
): number {
  if (totalPending <= threshold) return 1;
  const excess = totalPending - threshold;
  return Math.min(maxBoost, 1 + excess / 100);
}

/**
 * Perform one step of the animation loop.
 *
 * Given the current buffer state and configuration, this computes
 * how many characters to display this frame and returns the updated state.
 *
 * The algorithm:
 * 1. Calculate chars/frame from smoothed rate (or minimum rate)
 * 2. Apply catch-up boost if buffer is large
 * 3. Clamp to max chars/frame and available buffer
 * 4. Split proportionally between text and thinking buffers
 *
 * @param state - Current animation state.
 * @param config - Animation configuration.
 * @param newInstantRate - Instant rate from latest SSE data (0 if no new data). Pass 0 to preserve the smoothed rate during gaps.
 */
export function stepAnimation(
  state: AnimationState,
  config: AnimationConfig,
  newInstantRate: number,
): AnimationStepResult {
  const textPending = state.textBuffer.length;
  const thinkingPending = state.thinkingBuffer.length;
  const totalPending = textPending + thinkingPending;

  if (totalPending <= 0) {
    return {
      textChars: 0,
      thinkingChars: 0,
      state,
      hasPending: false,
    };
  }

  // Update smoothed rate (preserves current rate when no new SSE data)
  const smoothedRate = updateSmoothedRate(state.smoothedRate, newInstantRate, config.emaFactor);

  // Base speed from smoothed rate, with minimum fallback
  let charsPerFrame = Math.max(config.slowCharsPerFrame, smoothedRate / config.targetFps);

  // Apply catch-up boost if buffer is growing
  const boost = computeCatchUpBoost(totalPending, config.catchUpThreshold, config.maxCatchUpBoost);
  charsPerFrame *= boost;

  // Clamp to max to avoid "zipping"
  charsPerFrame = Math.min(charsPerFrame, config.maxCharsPerFrame);

  // Clamp to available buffer
  charsPerFrame = Math.min(charsPerFrame, totalPending);

  // Split proportionally between text and thinking.
  // CRITICAL: use Math.ceil for the primary buffer to guarantee progress.
  // Math.round(0.4) = 0 would stall the animation entirely during SSE gaps.
  const textRatio = totalPending > 0 ? textPending / totalPending : 0.5;
  const textChars = Math.min(textPending, Math.max(0, Math.ceil(charsPerFrame * textRatio)));
  const thinkingChars = Math.min(
    thinkingPending,
    Math.max(0, Math.ceil(charsPerFrame - textChars)),
  );

  // Safety: ensure at least 1 char displayed when there's pending content.
  // This prevents the animation from stalling due to rounding.
  if (textChars + thinkingChars === 0 && totalPending > 0) {
    if (textPending > 0) {
      return {
        textChars: 1,
        thinkingChars: 0,
        state: { ...state, smoothedRate },
        hasPending: true,
      };
    }
    return {
      textChars: 0,
      thinkingChars: 1,
      state: { ...state, smoothedRate },
      hasPending: true,
    };
  }

  return {
    textChars,
    thinkingChars,
    state: {
      ...state,
      smoothedRate,
    },
    hasPending: true,
  };
}

/**
 * Advance the display by consuming characters from the buffer.
 *
 * Returns the new displayed lengths after consuming the given number of characters.
 *
 * @param state - Current animation state.
 * @param textChars - Number of text characters to display this frame.
 * @param thinkingChars - Number of thinking characters to display this frame.
 */
export function consumeFromBuffer(
  state: AnimationState,
  textChars: number,
  thinkingChars: number,
): AnimationState {
  return {
    ...state,
    textBuffer: state.textBuffer.slice(textChars),
    thinkingBuffer: state.thinkingBuffer.slice(thinkingChars),
  };
}

/**
 * Reset animation state for a new stream.
 */
export function resetAnimation(): AnimationState {
  return createInitialState();
}
