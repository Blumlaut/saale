import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  stopChatGeneration: vi.fn(),
  clearQueuedMessages: vi.fn(),
  isTelegramSessionActive: vi.fn(),
  interruptTelegramChat: vi.fn(),
}));

vi.mock("@/lib/chat/stop-generation", () => ({
  stopChatGeneration: hoisted.stopChatGeneration,
}));
vi.mock("@/lib/chat/queue", () => ({ clearQueuedMessages: hoisted.clearQueuedMessages }));
vi.mock("@/lib/telegram/session-registry", () => ({
  isTelegramSessionActive: hoisted.isTelegramSessionActive,
  interruptTelegramChat: hoisted.interruptTelegramChat,
}));

import { stopHandler } from "@/lib/commands/handlers/stop";
import { webContext } from "../../../helpers/command-context";

/** `/stop`, and the optional `clear:true` that drops the queue behind it. */
describe("/stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.stopChatGeneration.mockResolvedValue(true);
    hoisted.clearQueuedMessages.mockResolvedValue(2);
  });

  it("cancels the run and asks the client to reconnect", async () => {
    const outcome = await stopHandler.run(webContext("stop"));

    expect(outcome).toEqual({ message: "Stopped.", tone: "info", refresh: "generation" });
    expect(hoisted.clearQueuedMessages).not.toHaveBeenCalled();
  });

  it("says so when nothing was running", async () => {
    hoisted.stopChatGeneration.mockResolvedValue(false);

    const outcome = await stopHandler.run(webContext("stop"));

    expect(outcome.message).toBe("Nothing is running.");
  });

  it("drops the queued messages with clear:true", async () => {
    const outcome = await stopHandler.run(webContext("stop", "clear:true"));

    expect(hoisted.clearQueuedMessages).toHaveBeenCalledWith("user-1", "session-1");
    expect(outcome.message).toBe("Stopped. Dropped 2 queued messages.");
  });

  it("reads a boolean however it was typed", async () => {
    const outcome = await stopHandler.run(webContext("stop", "clear:TRUE"));

    expect(hoisted.clearQueuedMessages).toHaveBeenCalled();
    expect(outcome.message).toContain("Dropped 2 queued messages");
  });

  it("says nothing about a queue it did not clear", async () => {
    hoisted.clearQueuedMessages.mockResolvedValue(0);

    const outcome = await stopHandler.run(webContext("stop", "clear:true"));

    expect(outcome.message).toBe("Stopped.");
  });

  it("leaves the queue alone when a message is queued and clear is false", async () => {
    await stopHandler.run(webContext("stop", "clear:false"));

    expect(hoisted.clearQueuedMessages).not.toHaveBeenCalled();
  });
});
