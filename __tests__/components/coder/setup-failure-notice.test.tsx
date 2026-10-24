// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SetupFailureNotice } from "@/components/coder/setup-failure-notice";

/**
 * The warning that a chat's setup script failed.
 *
 * A failing script does not stop the chat, so this chip is the only thing that
 * tells the user their worktree is missing its install. It has to stay folded
 * while it is a sentence, unfold to the error itself, and never claim a failure
 * that is not there.
 */

const FAILURE = {
  exitCode: 1,
  output: "npm ERR! could not resolve dependency",
  failedAt: new Date().toISOString(),
};

describe("SetupFailureNotice", () => {
  it("renders nothing for a chat whose setup script worked", () => {
    const { container } = render(<SetupFailureNotice failure={null} />);

    expect(container.childElementCount).toBe(0);
  });

  it("says the install failed without the noise of the output", () => {
    render(<SetupFailureNotice failure={FAILURE} />);

    expect(screen.getByText("Setup script failed")).toBeTruthy();
    // Folded: the error is one click away, not in the sidebar's face.
    expect(screen.queryByText(/could not resolve dependency/)).toBeNull();
  });

  it("unfolds to the exit status and what the script printed", async () => {
    render(<SetupFailureNotice failure={FAILURE} />);

    fireEvent.click(screen.getByRole("button", { name: "Show the setup script's error" }));

    expect(await screen.findByText("Exit 1")).toBeTruthy();
    expect(screen.getByText(/npm ERR! could not resolve dependency/)).toBeTruthy();
  });

  it("names a script that never got to run", () => {
    render(<SetupFailureNotice failure={{ ...FAILURE, exitCode: null, output: "" }} />);

    expect(screen.getByText("Setup script failed")).toBeTruthy();
  });

  it("says so when the script printed nothing at all", async () => {
    render(<SetupFailureNotice failure={{ ...FAILURE, output: "   " }} />);

    fireEvent.click(screen.getByRole("button", { name: "Show the setup script's error" }));

    expect(await screen.findByText("The script printed nothing.")).toBeTruthy();
  });
});
