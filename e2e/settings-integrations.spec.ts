import { test, expect, type Locator } from "@playwright/test";

import { gotoAndSettle } from "./utils";
import { mockMcpServers } from "./modal-scenarios";

/**
 * A settings row that carries actions must show them.
 *
 * Row actions fade in on hover (`ROW_ACTION`), which only works when the row
 * renders the `group` class their `group-hover:` variants point at. Without it
 * the buttons stay at opacity 0 forever and the row looks read-only, which is
 * how the MCP servers lost their edit and remove buttons.
 */

function opacity(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).opacity);
}

test.describe("settings · integrations", () => {
  test("an MCP server row reveals its edit and remove buttons on hover", async ({ page }) => {
    await mockMcpServers(page);
    await gotoAndSettle(page, "/dashboard/settings/integrations", { quietNetwork: true });

    const edit = page.getByRole("button", { name: "Edit homeassistant" });
    const remove = page.getByRole("button", { name: "Remove homeassistant" });
    await expect(edit).toHaveCount(1);

    // The pointer rests off the row, so nothing but the hover rule can show them.
    await page.mouse.move(0, 0);
    expect(await opacity(edit)).toBe("0");
    expect(await opacity(remove)).toBe("0");

    await page.getByText("homeassistant", { exact: true }).hover();
    await expect.poll(() => opacity(edit)).toBe("1");
    await expect.poll(() => opacity(remove)).toBe("1");
  });
});
