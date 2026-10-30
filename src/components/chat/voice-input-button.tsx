"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Mic, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useVoiceRecorder, type VoiceState } from "@/hooks/use-voice-recorder";

/** How long the button must be held before the microphone opens. */
const HOLD_DELAY_MS = 200;
/** Upward travel that keeps the recording going after the finger lifts. */
const LOCK_PX = 64;
/** Leftward travel that throws the recording away instead of sending it. */
const CANCEL_PX = 80;

interface VoiceInputButtonProps {
  /** The decoded sentence, ready to join the draft at the caret. */
  onText: (text: string) => void;
}

function clock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/**
 * Hold to record, slide up to keep recording after lifting the finger, slide
 * left to throw it away. A plain click records until the next click, which is
 * what a pointer without a drag does on a desktop.
 */
export function VoiceInputButton({ onText }: VoiceInputButtonProps) {
  const [locked, setLocked] = useState(false);
  const [overCancel, setOverCancel] = useState(false);

  // The gesture resolves in one press: pointerup follows the move that locked
  // the recording before React has re-rendered, so the flags live in refs and
  // the state mirrors them for the label.
  const lockedRef = useRef(false);
  const overCancelRef = useRef(false);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const stateRef = useRef<VoiceState>("idle");
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { state, seconds, start, stop, cancel } = useVoiceRecorder({
    onText,
    onError: (message) => toast.error(message),
  });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const setLock = useCallback((value: boolean) => {
    lockedRef.current = value;
    setLocked(value);
  }, []);

  const setCancelZone = useCallback((value: boolean) => {
    overCancelRef.current = value;
    setOverCancel(value);
  }, []);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }, []);

  useEffect(() => clearHoldTimer, [clearHoldTimer]);

  const begin = useCallback(() => {
    if (stateRef.current !== "idle") return;
    setLock(false);
    setCancelZone(false);
    void start();
  }, [start, setLock, setCancelZone]);

  const finish = useCallback(
    (discard: boolean) => {
      if (discard) cancel();
      else stop();
      setLock(false);
      setCancelZone(false);
    },
    [cancel, stop, setLock, setCancelZone],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || stateRef.current === "transcribing") return;
    // Any press on a running recording ends it, locked or not.
    if (stateRef.current === "recording") {
      finish(overCancelRef.current);
      return;
    }

    // Without this the drag turns into a native drag-and-drop, which cancels
    // the pointer and takes the recording with it.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    originRef.current = { x: event.clientX, y: event.clientY };
    clearHoldTimer();
    holdTimerRef.current = setTimeout(begin, HOLD_DELAY_MS);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const origin = originRef.current;
    if (!origin || stateRef.current !== "recording") return;

    if (!lockedRef.current && origin.y - event.clientY >= LOCK_PX) {
      setLock(true);
      setCancelZone(false);
      navigator.vibrate?.(10);
      return;
    }
    if (!lockedRef.current) {
      setCancelZone(origin.x - event.clientX >= CANCEL_PX);
    }
  };

  const handlePointerUp = () => {
    clearHoldTimer();
    const pressed = originRef.current !== null;
    originRef.current = null;
    if (!pressed) return;

    // Released before the hold delay: a click on the mic does nothing.
    if (stateRef.current !== "recording") return;
    if (lockedRef.current) return; // keeps going until the timer is tapped
    finish(overCancelRef.current);
  };

  // The browser took the gesture away (a scroll, a call): keep what was said.
  const handlePointerCancel = () => {
    clearHoldTimer();
    originRef.current = null;
    setLock(false);
    setCancelZone(false);
  };

  // Keyboard activation never fires the pointer handlers.
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.detail !== 0) return;
    if (stateRef.current === "recording") finish(false);
    else begin();
  };

  const preventDrag = (event: React.DragEvent) => event.preventDefault();

  if (state === "transcribing") {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground h-8 w-8 shrink-0 rounded-lg"
        disabled
        aria-label="Transcribing the recording"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
      </Button>
    );
  }

  const recording = state === "recording";

  // Every part stays mounted through the gesture: a node React swaps mid-press
  // drops the pointer capture and cancels the recording.
  return (
    <>
      <span
        className={cn(
          "border-border/60 bg-popover text-muted-foreground pointer-events-none absolute -top-9 left-2 z-10 rounded-full border px-2.5 py-1 text-xs shadow-sm",
          !recording && "hidden",
          overCancel && "border-destructive/40 text-destructive",
        )}
        role="status"
      >
        {overCancel
          ? "Release to throw it away"
          : locked
            ? "Tap the timer to stop"
            : "Slide up to keep recording, or tap to stop"}
      </span>

      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "text-destructive hover:bg-destructive/10 hover:text-destructive h-8 w-8 shrink-0 rounded-lg",
          !(recording && locked) && "hidden",
        )}
        onClick={() => finish(true)}
        aria-label="Throw the recording away"
      >
        <X className="h-4 w-4" />
      </Button>

      <Button
        variant={recording ? "destructive" : "ghost"}
        size={recording ? "sm" : "icon"}
        className={cn(
          "h-8 shrink-0 touch-none rounded-lg select-none",
          recording ? "gap-1.5 px-2" : "w-8",
          overCancel && "border-destructive/40 bg-destructive/20",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={handleClick}
        onDragStart={preventDrag}
        aria-label={recording ? `Stop recording, ${clock(seconds)}` : "Record a voice message"}
      >
        {recording ? (
          <>
            <Square className="fill-current" />
            <span className="text-xs tabular-nums">{clock(seconds)}</span>
          </>
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </Button>
    </>
  );
}
