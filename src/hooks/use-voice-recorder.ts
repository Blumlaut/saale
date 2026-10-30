"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/http";

/** `idle` → `recording` → `transcribing` → `idle`. */
export type VoiceState = "idle" | "recording" | "transcribing";

/** A spoken message, not a recording. long enough for a paragraph or two. */
const MAX_RECORDING_MS = 120_000;

/** Whatever the browser can actually encode, best first. */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];

interface UseVoiceRecorderOptions {
  /** Receives the transcript, once the server has decoded the recording. */
  onText: (text: string) => void;
  /** Called with a sentence to show the user when a step fails. */
  onError?: (message: string) => void;
}

function supportedMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

export function useVoiceRecorder({ onText, onError }: UseVoiceRecorderOptions) {
  const [state, setState] = useState<VoiceState>("idle");
  const [seconds, setSeconds] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // A recording resolves after the render that started it, so the refs carry
  // the callbacks that are current when it does.
  const onTextRef = useRef(onText);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onTextRef.current = onText;
    onErrorRef.current = onError;
  }, [onText, onError]);

  const stopTicker = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }, []);

  const releaseStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);

  const transcribe = useCallback(async (blob: Blob) => {
    setState("transcribing");
    try {
      const form = new FormData();
      form.append("audio", blob, "recording.webm");
      const data = await fetchJson<{ text: string }>("/api/voice/transcribe", {
        method: "POST",
        body: form,
      });
      onTextRef.current(data.text);
    } catch (err) {
      console.error("Failed to transcribe the recording:", err);
      onErrorRef.current?.(
        err instanceof Error ? err.message : "The recording could not be transcribed",
      );
    } finally {
      setState("idle");
      setSeconds(0);
    }
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      onErrorRef.current?.("This browser cannot record audio");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error("Microphone access was refused:", err);
      onErrorRef.current?.("Turn on microphone access to use voice input");
      return;
    }

    const mimeType = supportedMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    discardRef.current = false;
    streamRef.current = stream;
    recorderRef.current = recorder;

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      chunksRef.current = [];
      recorderRef.current = null;
      releaseStream();
      stopTicker();
      if (discardRef.current || blob.size === 0) {
        setState("idle");
        setSeconds(0);
        return;
      }
      void transcribe(blob);
    });

    recorder.start();
    setSeconds(0);
    setState("recording");
    stopTicker();
    const startedAt = Date.now();
    tickRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setSeconds(Math.floor(elapsed / 1000));
      if (elapsed >= MAX_RECORDING_MS) recorderRef.current?.stop();
    }, 500);
  }, [releaseStream, stopTicker, transcribe]);

  /** Finish the recording and transcribe it. */
  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  /** Throw the recording away, mid-flight or not. */
  const cancel = useCallback(() => {
    discardRef.current = true;
    if (recorderRef.current) {
      recorderRef.current.stop();
    } else {
      releaseStream();
      stopTicker();
      setState("idle");
      setSeconds(0);
    }
  }, [releaseStream, stopTicker]);

  // A draft navigation must not leave the microphone on.
  useEffect(() => {
    return () => {
      discardRef.current = true;
      recorderRef.current?.stop();
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      stopTicker();
    };
  }, [stopTicker]);

  return { state, seconds, start, stop, cancel };
}
