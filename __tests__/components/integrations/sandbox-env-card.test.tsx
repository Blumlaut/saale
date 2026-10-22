// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxEnvCard } from "@/components/integrations/sandbox-env-card";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("SandboxEnvCard", () => {
  it("lists the variable names that are set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ names: ["GH_TOKEN", "NPM_TOKEN"] }));

    render(<SandboxEnvCard />);

    expect(await screen.findByText("GH_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("NPM_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("2 set")).toBeInTheDocument();
  });

  it("says so when nothing is set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ names: [] }));

    render(<SandboxEnvCard />);

    expect(await screen.findByText("None set")).toBeInTheDocument();
  });

  it("saves a value and shows the name without ever showing the value", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ names: [] }))
      .mockResolvedValueOnce(jsonResponse({ names: ["GH_TOKEN"] }));

    render(<SandboxEnvCard />);
    await screen.findByText("None set");

    fireEvent.change(screen.getByLabelText("Variable name"), { target: { value: "gh_token" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "ghp_secret_value" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("GH_TOKEN")).toBeInTheDocument());
    expect(screen.queryByText("ghp_secret_value")).not.toBeInTheDocument();

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/settings/sandbox-env");
    expect(init.method).toBe("PUT");
    // The name is upper-cased as it is typed, so a lower-case paste still works.
    expect(JSON.parse(init.body)).toEqual({ name: "GH_TOKEN", value: "ghp_secret_value" });
  });

  it("masks the value field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ names: [] }));

    render(<SandboxEnvCard />);
    await screen.findByText("None set");

    expect(screen.getByLabelText("Value")).toHaveAttribute("type", "password");
  });

  it("removes a variable by name", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ names: ["GH_TOKEN"] }))
      .mockResolvedValueOnce(jsonResponse({ names: [] }));

    render(<SandboxEnvCard />);
    await screen.findByText("GH_TOKEN");

    fireEvent.click(screen.getByRole("button", { name: "Remove GH_TOKEN" }));

    await waitFor(() => expect(screen.getByText("None set")).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/settings/sandbox-env?name=GH_TOKEN");
    expect(init.method).toBe("DELETE");
  });

  it("shows the API's own reason when a name is refused", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ names: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ error: "Variable names start with a letter or underscore" }, 400),
      );

    render(<SandboxEnvCard />);
    await screen.findByText("None set");

    fireEvent.change(screen.getByLabelText("Variable name"), { target: { value: "BAD-NAME" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Variable names start with a letter/)).toBeInTheDocument();
  });

  it("disables Save until both fields have something in them", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ names: [] }));

    render(<SandboxEnvCard />);
    await screen.findByText("None set");

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Variable name"), { target: { value: "GH_TOKEN" } });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "x" } });
    expect(save).toBeEnabled();
  });
});
