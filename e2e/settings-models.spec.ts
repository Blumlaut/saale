import { test, expect } from "@playwright/test";

import { gotoAndSettle } from "./utils";

/**
 * The provider-wide switch in Settings → Models has to move the models it
 * covers: off hides them, on shows them again. The inventory is mocked so the
 * case does not depend on which providers this instance happens to have.
 */

const PROVIDER_ID = "fixture";
const PROVIDER_NAME = "Fixture Co";
const MODEL_IDS = ["fixture-a", "fixture-b"];

const INVENTORY = {
  providers: [
    {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      modelCount: MODEL_IDS.length,
      modelsConfigurable: true,
    },
  ],
  models: {
    [PROVIDER_ID]: [
      {
        id: MODEL_IDS[0],
        name: "Fixture A",
        reasoning: false,
        vision: false,
        contextWindow: 200_000,
      },
      {
        id: MODEL_IDS[1],
        name: "Fixture B",
        reasoning: false,
        vision: false,
        contextWindow: 200_000,
      },
    ],
  },
  endpointLimits: {},
  totalModels: MODEL_IDS.length,
  disabledModels: [],
};

test.describe("settings · models", () => {
  test("the provider switch hides and shows every model it covers", async ({ page }) => {
    await page.route("**/api/providers/models*", (route) => route.fulfill({ json: INVENTORY }));

    try {
      await gotoAndSettle(page, "/dashboard/settings/models", { quietNetwork: true });

      const providerSwitch = page.getByRole("switch", {
        name: `Show or hide every model of ${PROVIDER_NAME}`,
      });
      const models = page.getByRole("switch", { name: /Fixture [AB]/ });
      const firstModel = models.first();
      const secondModel = models.last();

      await expect(firstModel).toBeVisible();
      await expect(providerSwitch).toHaveAttribute("aria-checked", "true");

      // Off hides the group: every model the row covers loses its switch.
      await providerSwitch.click();
      await expect(firstModel).toHaveAttribute("aria-checked", "false");
      await expect(secondModel).toHaveAttribute("aria-checked", "false");
      await expect(providerSwitch).toHaveAttribute("aria-checked", "false");

      // ...and on brings them back.
      await providerSwitch.click();
      await expect(firstModel).toHaveAttribute("aria-checked", "true");
      await expect(secondModel).toHaveAttribute("aria-checked", "true");
      await expect(providerSwitch).toHaveAttribute("aria-checked", "true");
    } finally {
      // The switches write the shared account's settings; leave them as found.
      await page.request.patch("/api/settings", { data: { disabledModels: null } });
    }
  });
});
