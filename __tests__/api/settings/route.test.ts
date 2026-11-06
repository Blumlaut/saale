import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AppSettings } from "@prisma/client";

const hoisted = vi.hoisted(() => ({
  requireSession: vi.fn(),
  ensureUserSettings: vi.fn(),
  applyUserSettingsPatch: vi.fn(),
  readInstanceDecisionModel: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireSession: hoisted.requireSession }));
vi.mock("@/lib/settings/update", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/settings/update")>("@/lib/settings/update");
  return {
    ...actual,
    ensureUserSettings: hoisted.ensureUserSettings,
    applyUserSettingsPatch: hoisted.applyUserSettingsPatch,
  };
});
vi.mock("@/lib/pi/decision-model", () => ({
  readInstanceDecisionModel: hoisted.readInstanceDecisionModel,
}));

import { GET, PATCH } from "@/app/api/settings/route";

function settingsRow(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "settings-1",
    userId: "user-1",
    defaultModelProvider: null,
    defaultModelName: null,
    defaultThinkingLevel: null,
    theme: "system",
    compactActivity: false,
    telegramToolNotices: false,
    agentCustomInstructions: null,
    coderCustomInstructions: null,
    emailWritingStyle: null,
    purposeModelOverrides: null,
    disabledModels: null,
    defaultToolConfig: null,
    coderToolConfig: null,
    toolPolicies: null,
    toolExposure: null,
    approvalDecisionModel: null,
    sidebarItems: null,
    pushNotifications: null,
    features: null,
    updatedAt: new Date(),
    ...overrides,
  } as AppSettings;
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.requireSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
  hoisted.ensureUserSettings.mockResolvedValue(settingsRow());
  hoisted.applyUserSettingsPatch.mockResolvedValue(settingsRow());
  hoisted.readInstanceDecisionModel.mockResolvedValue(null);
});

describe("GET /api/settings", () => {
  it("names the decision model the account follows while it has no pick", async () => {
    hoisted.readInstanceDecisionModel.mockResolvedValue({ provider: "custom-llamacpp", id: "kev" });

    const body = await (await GET()).json();

    expect(body.settings.instanceApprovalDecisionModel).toBe("custom-llamacpp:kev");
    expect(body.settings.approvalDecisionModel).toBeNull();
  });
});

// The client replaces its state with whatever a save answers, so a save that
// dropped the field would blank the hint line until the next load.
describe("PATCH /api/settings", () => {
  it("answers with the shape a load answers with", async () => {
    hoisted.readInstanceDecisionModel.mockResolvedValue({ provider: "custom-llamacpp", id: "kev" });

    const loaded = (await (await GET()).json()).settings;
    const saved = (await (await patch({ theme: "dark" })).json()).settings;

    expect(Object.keys(saved).sort()).toEqual(Object.keys(loaded).sort());
  });

  it("answers with the instance default the account follows", async () => {
    hoisted.readInstanceDecisionModel.mockResolvedValue({ provider: "custom-llamacpp", id: "kev" });
    hoisted.applyUserSettingsPatch.mockResolvedValue(settingsRow({ approvalDecisionModel: null }));

    const body = await (await patch({ approvalDecisionModel: null })).json();

    expect(body.settings.instanceApprovalDecisionModel).toBe("custom-llamacpp:kev");
  });

  it("writes the pick through the registry and answers with it", async () => {
    hoisted.applyUserSettingsPatch.mockResolvedValue(
      settingsRow({ approvalDecisionModel: "custom-llamacpp:kev" }),
    );

    const body = await (await patch({ approvalDecisionModel: "custom-llamacpp/kev" })).json();

    expect(hoisted.applyUserSettingsPatch).toHaveBeenCalledWith("user-1", {
      approvalDecisionModel: "custom-llamacpp/kev",
    });
    expect(body.settings.approvalDecisionModel).toBe("custom-llamacpp:kev");
  });
});
