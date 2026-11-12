import { test, expect } from "@playwright/test";

import { gotoAndSettle } from "./utils";
import { mockMcpServers } from "./modal-scenarios";

/**
 * A row keeps its controls in sight.
 *
 * A server row carries one control of its own — the switch that turns it on —
 * and the rest behind its menu, which is visible without hovering. Actions that
 * only appear on hover are the ones nobody finds: the edit and remove buttons
 * hid behind a `group-hover` that no ancestor ever triggered.
 */

function opacity(locator: import("@playwright/test").Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).opacity);
}

test.describe("settings · integrations", () => {
  test("an MCP server row offers edit and remove from a visible menu", async ({ page }) => {
    await mockMcpServers(page);
    await gotoAndSettle(page, "/dashboard/settings/integrations", { quietNetwork: true });

    // The pointer rests off the row, so only the row's own styling can show it.
    await page.mouse.move(0, 0);
    const actions = page.getByRole("button", { name: "Actions for homeassistant" });
    await expect(actions).toHaveCount(1);
    expect(await opacity(page.getByRole("switch", { name: "Enable homeassistant" }))).toBe("1");
    expect(await opacity(actions)).toBe("1");

    await actions.click();
    await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Remove homeassistant?");
  });
});
