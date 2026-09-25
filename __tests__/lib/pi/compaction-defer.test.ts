import { describe, it, expect, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { submitDeferringToCompaction } from "@/lib/pi/compaction-defer";

/** Pi's rejection while a compaction holds the session. */
function compactionError(): Error {
  return new Error(
    "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
  );
}

function fakeSession() {
  const waitForIdle = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  return {
    waitForIdle,
    session: { waitForIdle } as unknown as Pick<AgentSession, "waitForIdle">,
  };
}

describe("submitDeferringToCompaction", () => {
  it("submits straight away when the session is free", async () => {
    const { session, waitForIdle } = fakeSession();
    const submit = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await submitDeferringToCompaction(session, submit);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(waitForIdle).not.toHaveBeenCalled();
  });

  it("waits for the compaction to finish, then submits", async () => {
    const { session, waitForIdle } = fakeSession();
    let resolveIdle = () => {};
    waitForIdle.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveIdle = resolve;
      }),
    );

    const submit = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(compactionError())
      .mockResolvedValue(undefined);

    const deferred = submitDeferringToCompaction(session, submit);

    // Still waiting: the compaction has not released the session yet.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(waitForIdle).toHaveBeenCalledTimes(1);

    resolveIdle();
    await deferred;

    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("propagates unrelated failures without retrying", async () => {
    const { session, waitForIdle } = fakeSession();
    const submit = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("provider exploded"));

    await expect(submitDeferringToCompaction(session, submit)).rejects.toThrow("provider exploded");

    expect(submit).toHaveBeenCalledTimes(1);
    expect(waitForIdle).not.toHaveBeenCalled();
  });

  it("gives up after the retry budget instead of looping forever", async () => {
    const { session, waitForIdle } = fakeSession();
    // Idle reported but the prompt still rejected: the retry budget, not the
    // idle wait, has to end the loop.
    const submit = vi.fn<() => Promise<void>>().mockRejectedValue(compactionError());

    await expect(submitDeferringToCompaction(session, submit)).rejects.toThrow(
      /compaction is in progress/,
    );

    expect(submit).toHaveBeenCalledTimes(5);
    expect(waitForIdle).toHaveBeenCalledTimes(4);
  });
});
