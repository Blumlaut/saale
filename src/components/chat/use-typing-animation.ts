import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  feedBuffer,
  computePending,
  estimateInstantRate,
  stepAnimation,
  consumeFromBuffer,
  DEFAULT_CONFIG,
  type AnimationState,
} from "@/lib/pi/stream-animation";
import type { StreamingState } from "./chat-streaming-state";

/**
 * Buffer-based typing animation for smooth, non-jerky text playback.
 *
 * SSE chunks feed into a buffer; the rAF loop consumes at a steady rate.
 * Rate is estimated from SSE arrival patterns but preserved during gaps.
 */
export function useTypingAnimation(
  isLoading: boolean,
  setStreaming: Dispatch<SetStateAction<StreamingState>>,
  streamingRef: React.RefObject<StreamingState>,
) {
  const animFrameRef = useRef<number | null>(null);
  const animStateRef = useRef<AnimationState>({
    textBuffer: "",
    thinkingBuffer: "",
    smoothedRate: 0,
    rateStartChars: 0,
    rateStartTime: 0,
    rateLastChars: 0,
    rateLastTime: 0,
    charsAccum: 0,
  });

  useEffect(() => {
    if (!isLoading) {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      animStateRef.current = {
        textBuffer: "",
        thinkingBuffer: "",
        smoothedRate: 0,
        rateStartChars: 0,
        rateStartTime: 0,
        rateLastChars: 0,
        rateLastTime: 0,
        charsAccum: 0,
      };
      return;
    }

    const config = DEFAULT_CONFIG;
    let lastInstantRate = 0;
    let lastCumulative = 0;

    const step = () => {
      setStreaming((prev) => {
        const cumulative = prev.current.text.length + prev.current.thinking.length;
        const hasNewData = cumulative !== lastCumulative;
        lastCumulative = cumulative;

        let animState = animStateRef.current;

        // Only update rate tracking when new SSE data arrives.
        if (hasNewData) {
          const now = Date.now();
          animState = feedBuffer(
            animState,
            prev.current.text,
            prev.current.thinking,
            prev.displayText.length,
            prev.displayThinking.length,
            now,
          );

          const instantRate = estimateInstantRate(animState);
          if (instantRate > 0) {
            lastInstantRate = instantRate;
          }
        }

        const pending = computePending(
          prev.current.text,
          prev.current.thinking,
          prev.displayText.length,
          prev.displayThinking.length,
        );
        animState = {
          ...animState,
          textBuffer: pending.textPending,
          thinkingBuffer: pending.thinkingPending,
        };

        const animStep = stepAnimation(animState, config, lastInstantRate);

        animStateRef.current = consumeFromBuffer(
          animStep.state,
          animStep.textChars,
          animStep.thinkingChars,
        );

        const next = {
          ...prev,
          displayText: prev.current.text.slice(0, prev.displayText.length + animStep.textChars),
          displayThinking: prev.current.thinking.slice(
            0,
            prev.displayThinking.length + animStep.thinkingChars,
          ),
        };
        streamingRef.current = next;
        animFrameRef.current = requestAnimationFrame(step);
        return next;
      });
    };

    animFrameRef.current = requestAnimationFrame(step);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [isLoading, setStreaming, streamingRef]);
}
