import { describe, expect, it } from "vitest";
import { groupsNotification } from "@/lib/devices/channel";

describe("the notification that changes a computer's groups", () => {
  it("carries the whole set as a notification, not a request", () => {
    const message = groupsNotification(["screen", "terminal"]);

    expect(message).toMatchObject({
      jsonrpc: "2.0",
      method: "notifications/saale/groups",
      params: { groups: ["screen", "terminal"] },
    });
    // No id: it is not a call, and nothing waits for an answer.
    expect("id" in message).toBe(false);
  });
});
