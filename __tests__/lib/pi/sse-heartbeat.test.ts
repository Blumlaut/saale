import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseHeartbeat } from "@/lib/pi/sse-heartbeat";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PING_PAYLOAD = 'event: ping\ndata: {"t":1000}\n\n';

/**
 * Build a bare stream whose controller we can grab, so tests can drive the
 * controller directly (as the SSE route does with the HTTP response body).
 */
function makeStream(): {
  stream: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { stream, controller };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSseHeartbeat", () => {
  it("pings the controller on each interval while the stream is open, then stops cleanly", async () => {
    const { stream, controller } = makeStream();
    const reader = stream.getReader();

    const heartbeat = createSseHeartbeat(controller, 5, () => 1000);

    // First ping arrives after the first interval.
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe(PING_PAYLOAD);

    // Second ping arrives after the next interval.
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(new TextDecoder().decode(second.value)).toBe(PING_PAYLOAD);

    // stop() is idempotent and halts further pings.
    heartbeat.stop();
    heartbeat.stop();
    controller.close();
    const afterStop = await reader.read();
    expect(afterStop.done).toBe(true);
  });

  it("stops itself when the controller is closed underneath it, instead of throwing on every tick", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { stream, controller } = makeStream();
    const reader = stream.getReader();

    // Deliberately never call stop(): simulate a runtime teardown that the
    // route's cancel()/abort hooks never see (the Next.js SSE failure mode).
    createSseHeartbeat(controller, 5, () => 1000);

    // One ping while the stream is healthy...
    const first = await reader.read();
    expect(first.done).toBe(false);

    // ...then the consumer disappears: the stream is cancelled, closing the
    // controller. The next interval tick must self-stop (ERR_INVALID_STATE
    // swallowed, interval cleared) instead of logging an error every tick.
    await reader.cancel();
    await sleep(30); // well past several 5ms intervals

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("swallows only ERR_INVALID_STATE — other enqueue errors are still logged", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // A controller that throws a non-closed error on enqueue.
    const throwingController = {
      enqueue() {
        throw new TypeError("boom");
      },
    } as unknown as ReadableStreamDefaultController;

    const heartbeat = createSseHeartbeat(throwingController, 5, () => 1000);
    await sleep(15);

    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to enqueue SSE heartbeat:",
      expect.any(TypeError),
    );

    // Non-closed errors don't self-stop, so stop the interval explicitly to
    // avoid leaking a timer past the test.
    heartbeat.stop();
  });
});
