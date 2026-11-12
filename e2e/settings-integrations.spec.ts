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

  test("a pasted config is imported and the list shows what landed", async ({ page }) => {
    await mockMcpServers(page);
    await page.route(/\/api\/mcp\/servers\/import$/, (route) =>
      route.fulfill({
        status: 201,
        json: {
          created: [
            {
              id: "e2e-imported",
              name: "github",
              transport: "stdio",
              url: null,
              command: "npx -y @modelcontextprotocol/server-github",
              cwd: null,
              envNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
              description: "",
              toolPolicy: "ask",
              enabled: true,
              chatEnabled: true,
              coderEnabled: true,
              hasToken: false,
              hasOAuth: false,
              shared: false,
              createdAt: "2026-01-01T09:00:00Z",
              updatedAt: "2026-01-01T09:00:00Z",
            },
          ],
          skipped: [{ name: "broken", error: "This entry has neither a command nor a URL." }],
        },
      }),
    );
    await gotoAndSettle(page, "/dashboard/settings/integrations", { quietNetwork: true });

    await page.getByRole("button", { name: "Import config" }).click();
    await page
      .locator('textarea[aria-label="MCP config"]')
      .fill('{"mcpServers":{"github":{"command":"npx","args":["-y","srv"]}}}');
    await page.getByRole("button", { name: "Import servers" }).click();

    // What landed is named, and what could not be read still says why.
    await expect(page.getByText("Added github.")).toBeVisible();
    await expect(page.getByText(/broken: This entry has neither/)).toBeVisible();
  });
});
