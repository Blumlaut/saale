// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ProvisioningNotice } from "@/components/coder/provisioning-notice";

/**
 * The card that tells a coder chat's user why nothing has answered yet.
 *
 * Its whole value is being true at the right moment: shown while the workspace
 * is being built, gone the instant the build finishes, and never asking the
 * server at all about a chat that is not waiting on anything.
 */

function stubProvisioning(...answers: Array<{ step: string; startedAt: string } | null>) {
  const fetchMock = vi.fn(async () => {
    const provisioning = answers.length > 1 ? answers.shift() : answers[0];
    return { ok: true, status: 200, json: async () => ({ provisioning }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const startedAt = new Date(Date.now() - 61_000).toISOString();

describe("ProvisioningNotice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says nothing and asks nothing when the chat is not waiting", async () => {
    const fetchMock = stubProvisioning({ step: "setup", startedAt });

    const { container } = render(<ProvisioningNotice sessionId="s-1" waiting={false} />);

    expect(container.childElementCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the work the server is doing", async () => {
    stubProvisioning({ step: "setup", startedAt });

    render(<ProvisioningNotice sessionId="s-1" waiting />);

    expect(await screen.findByText("Running setup script")).toBeTruthy();
    // Time already spent is shown, so a slow install is visibly still moving.
    expect(screen.getByText("1m 01s")).toBeTruthy();
  });

  it("describes a worktree checkout in its own words", async () => {
    stubProvisioning({ step: "worktree", startedAt: new Date().toISOString() });

    render(<ProvisioningNotice sessionId="s-1" waiting />);

    expect(await screen.findByText("Preparing the checkout")).toBeTruthy();
  });

  it("disappears once the build is over", async () => {
    stubProvisioning({ step: "setup", startedAt }, null);

    const { container } = render(<ProvisioningNotice sessionId="s-1" waiting />);

    expect(await screen.findByText("Running setup script")).toBeTruthy();
    // The poll that answers null is the next one after the interval.
    await waitFor(() => expect(container.childElementCount).toBe(0), { timeout: 3_000 });
  });
});
