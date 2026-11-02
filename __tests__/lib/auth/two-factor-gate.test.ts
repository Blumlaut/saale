import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { adminSettings: { findUnique: vi.fn() } },
}));

import {
  owesTwoFactorSetup,
  TWO_FACTOR_REQUIRED_PATH,
  type TwoFactorGateSession,
} from "@/lib/auth/two-factor-policy";

/** A signed-in account that has not set two-factor up. */
const unenrolled: TwoFactorGateSession = { user: { twoFactorEnabled: false } };

describe("owesTwoFactorSetup", () => {
  it("holds an unenrolled account on the requirement page", () => {
    expect(
      owesTwoFactorSetup({ required: true, session: unenrolled, path: "/dashboard/chat" }),
    ).toBe(true);
  });

  it("lets the requirement page itself through", () => {
    expect(
      owesTwoFactorSetup({ required: true, session: unenrolled, path: TWO_FACTOR_REQUIRED_PATH }),
    ).toBe(false);
  });

  it("asks nothing when the instance does not require it", () => {
    expect(
      owesTwoFactorSetup({ required: false, session: unenrolled, path: "/dashboard/chat" }),
    ).toBe(false);
  });

  it("asks nothing of an account that already has it", () => {
    const enrolled: TwoFactorGateSession = { user: { twoFactorEnabled: true } };
    expect(owesTwoFactorSetup({ required: true, session: enrolled, path: "/dashboard/chat" })).toBe(
      false,
    );
  });

  it("leaves an impersonated account alone", () => {
    const impersonated: TwoFactorGateSession = {
      user: { twoFactorEnabled: false },
      session: { impersonatedBy: "admin-1" },
    };
    expect(
      owesTwoFactorSetup({ required: true, session: impersonated, path: "/admin/users" }),
    ).toBe(false);
  });
});
