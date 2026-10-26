import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRequestPluginUi = vi.fn();
vi.mock("@/lib/plugin-ui/requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plugin-ui/requests")>();
  return {
    ...actual,
    requestPluginUi: (...args: unknown[]) => mockRequestPluginUi(...args),
  };
});

const mockPublish = vi.fn();
vi.mock("@/lib/pi/session-events", () => ({
  publishSessionEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { createExtensionUiContext } from "@/lib/plugin-ui/ui-context";

const context = () => createExtensionUiContext({ userId: "user-1", sessionId: "session-1" });

describe("extension UI context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublish.mockResolvedValue(1);
  });

  it("returns the option the user picked", async () => {
    mockRequestPluginUi.mockResolvedValue({ value: "Deploy" });
    await expect(context().select("Pick one", ["Deploy", "Cancel"])).resolves.toBe("Deploy");
    expect(mockRequestPluginUi).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "select", title: "Pick one", options: ["Deploy", "Cancel"] }),
      expect.anything(),
    );
  });

  it("answers an unanswered dialog the way Pi's no-op UI does", async () => {
    mockRequestPluginUi.mockResolvedValue({ cancelled: true });
    await expect(context().select("Pick one", ["Deploy"])).resolves.toBeUndefined();
    await expect(context().input("Name?")).resolves.toBeUndefined();
    await expect(context().editor("Edit")).resolves.toBeUndefined();
    await expect(context().confirm("Sure?", "Really")).resolves.toBe(false);
  });

  it("passes a confirm through", async () => {
    mockRequestPluginUi.mockResolvedValue({ confirmed: true });
    await expect(context().confirm("Sure?", "Really")).resolves.toBe(true);
    expect(mockRequestPluginUi).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "confirm", message: "Really" }),
      expect.anything(),
    );
  });

  it("caps a dialog's timeout at its own", async () => {
    mockRequestPluginUi.mockResolvedValue({ cancelled: true });
    await context().select("Pick one", ["a"], { timeout: 10 * 60 * 1000 });
    const [, options] = mockRequestPluginUi.mock.calls[0]!;
    expect((options as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it("forwards the run's abort signal", async () => {
    mockRequestPluginUi.mockResolvedValue({ cancelled: true });
    const controller = new AbortController();
    await context().input("Name?", "type here", { signal: controller.signal });
    const [, options] = mockRequestPluginUi.mock.calls[0]!;
    expect((options as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  it("publishes a notice, a status line and a widget", () => {
    const ui = context();
    ui.notify("Deploy finished", "warning");
    ui.setStatus("deploy", "3 of 5");
    ui.setStatus("deploy", undefined);
    ui.setWidget("deploy", ["step 1", "step 2"], { placement: "belowEditor" });
    ui.setWidget("deploy", undefined);

    expect(mockPublish).toHaveBeenCalledWith("session-1", "plugin_notice", {
      message: "Deploy finished",
      type: "warning",
    });
    expect(mockPublish).toHaveBeenCalledWith("session-1", "plugin_status", {
      key: "deploy",
      text: "3 of 5",
    });
    // `undefined` clears the line; the client drops the key on null.
    expect(mockPublish).toHaveBeenCalledWith("session-1", "plugin_status", {
      key: "deploy",
      text: null,
    });
    expect(mockPublish).toHaveBeenCalledWith("session-1", "plugin_widget", {
      key: "deploy",
      lines: ["step 1", "step 2"],
      placement: "belowEditor",
    });
    expect(mockPublish).toHaveBeenCalledWith("session-1", "plugin_widget", {
      key: "deploy",
      lines: null,
      placement: "aboveEditor",
    });
  });

  it("ignores a widget built from a terminal component", () => {
    context().setWidget("deploy", () => ({}) as never);
    expect(mockPublish).toHaveBeenCalledWith("session-1", "plugin_widget", {
      key: "deploy",
      lines: null,
      placement: "aboveEditor",
    });
  });

  it("answers the terminal-only APIs as unavailable", async () => {
    const ui = context();
    await expect(ui.custom(() => ({}) as never)).resolves.toBeUndefined();
    expect(ui.getEditorText()).toBe("");
    expect(ui.getAllThemes()).toEqual([]);
    expect(ui.setTheme("dark")).toEqual({ success: false, error: expect.any(String) });
    expect(ui.onTerminalInput(() => undefined)()).toBeUndefined();
  });
});
