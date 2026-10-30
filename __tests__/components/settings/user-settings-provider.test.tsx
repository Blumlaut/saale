// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  UserSettingsProvider,
  useUserSettings,
} from "@/app/dashboard/settings/components/user-settings-provider";
import type { UserSettings } from "@/app/dashboard/settings/types";

const { fetchJson, patchJson } = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  patchJson: vi.fn(),
}));

vi.mock("@/lib/http", () => ({ fetchJson, patchJson }));

const stored: UserSettings = {
  defaultModelProvider: "openai",
  defaultModelName: "gpt-4o",
  defaultThinkingLevel: "off",
  theme: "system",
  compactActivity: true,
  agentCustomInstructions: null,
  coderCustomInstructions: null,
  emailWritingStyle: null,
  purposeModelOverrides: null,
  disabledModels: null,
  defaultToolConfig: null,
  coderToolConfig: null,
  toolPolicies: null,
  toolExposure: null,
  pushNotifications: null,
};

function wrapper({ children }: { children: ReactNode }) {
  return <UserSettingsProvider>{children}</UserSettingsProvider>;
}

async function renderSettings() {
  const view = renderHook(() => useUserSettings(), { wrapper });
  await waitFor(() => expect(view.result.current.settings).not.toBeNull());
  return view;
}

/** A write that only answers when the test says so. */
function heldWrite() {
  let release: () => void = () => {};
  patchJson.mockImplementationOnce(
    (_url, body: Partial<UserSettings>) =>
      new Promise((resolve) => {
        release = () => resolve({ settings: { ...stored, ...body } });
      }),
  );
  return () => release();
}

beforeEach(() => {
  fetchJson.mockReset().mockResolvedValue({ settings: stored });
  patchJson.mockReset().mockImplementation((_url, body: Partial<UserSettings>) => {
    return Promise.resolve({ settings: { ...stored, ...body } });
  });
});

describe("settings autosave", () => {
  it("shows a change immediately and sends only the changed column", async () => {
    const release = heldWrite();
    const { result } = await renderSettings();

    act(() => result.current.update({ compactActivity: false }));

    // The switch reads back before the request resolves.
    expect(result.current.settings?.compactActivity).toBe(false);
    expect(patchJson).toHaveBeenCalledTimes(1);
    expect(patchJson).toHaveBeenCalledWith("/api/settings", { compactActivity: false });

    await act(async () => release());
    await waitFor(() => expect(result.current.saveState).toBe("saved"));
  });

  it("queues a second change to the same column behind the first request", async () => {
    const release = heldWrite();
    const { result } = await renderSettings();

    act(() => result.current.update({ compactActivity: false }));
    act(() => result.current.update({ compactActivity: true }));

    // One request at a time, so the answer to the first cannot undo the second.
    expect(patchJson).toHaveBeenCalledTimes(1);

    await act(async () => release());
    await waitFor(() => expect(patchJson).toHaveBeenCalledTimes(2));
    expect(patchJson.mock.calls[1]![1]).toEqual({ compactActivity: true });
    expect(patchJson.mock.calls[0]![1]).toEqual({ compactActivity: false });
    expect(result.current.settings?.compactActivity).toBe(true);
  });

  it("reports a failed write and keeps the value on screen", async () => {
    const { result } = await renderSettings();

    await act(async () => {
      patchJson.mockRejectedValueOnce(new Error("offline"));
      result.current.update({ compactActivity: false });
    });

    expect(result.current.saveState).toBe("error");
    expect(result.current.settings?.compactActivity).toBe(false);
    expect(result.current.saving).toBe(false);
  });

  it("answers `save` with whether the change landed", async () => {
    const { result } = await renderSettings();

    await act(async () => {
      expect(await result.current.save({ emailWritingStyle: "Short." })).toBe(true);
    });
    expect(patchJson).toHaveBeenCalledWith("/api/settings", { emailWritingStyle: "Short." });

    await act(async () => {
      patchJson.mockRejectedValueOnce(new Error("offline"));
      expect(await result.current.save({ emailWritingStyle: "Shorter." })).toBe(false);
    });
    expect(result.current.saveState).toBe("error");
  });
});
