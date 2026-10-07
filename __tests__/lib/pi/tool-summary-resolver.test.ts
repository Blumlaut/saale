import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveTemplate,
  formatToolSummary,
  findToolInfo,
  ALL_TOOL_INFOS,
} from "@/lib/pi/tool-infos";

// Mock prisma for resolveToolSummary
vi.mock("@/lib/db", () => ({
  prisma: {
    infraMachine: {
      findFirst: vi.fn(),
    },
  },
}));

import * as db from "@/lib/db";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInfraMachine = db.prisma.infraMachine as any;

import { resolveToolSummary } from "@/lib/pi/tool-summary-resolver";

describe("resolveTemplate", () => {
  it("replaces simple placeholders", () => {
    expect(resolveTemplate("Running {cmd} on {host}", { cmd: "ls", host: "prod" })).toBe(
      "Running ls on prod",
    );
  });

  it("leaves unknown placeholders as-is", () => {
    expect(resolveTemplate("Running {cmd} on {host}", { cmd: "ls" })).toBe("Running ls on {host}");
  });

  it("handles null values as unknown", () => {
    expect(resolveTemplate("Running {cmd}", { cmd: null })).toBe("Running {cmd}");
  });

  it("converts non-string values to strings", () => {
    expect(resolveTemplate("Count: {count}", { count: 42 })).toBe("Count: 42");
  });

  it("handles templates with no placeholders", () => {
    expect(resolveTemplate("Syncing mailbox", {})).toBe("Syncing mailbox");
  });

  it("handles multiple occurrences of the same placeholder", () => {
    expect(resolveTemplate("{name} → {name}", { name: "prod" })).toBe("prod → prod");
  });
});

describe("findToolInfo", () => {
  it("returns info for known tools", () => {
    const info = findToolInfo("web_search");
    expect(info).toBeDefined();
    expect(info?.label).toBe("Web Search");
  });

  it("returns undefined for unknown tools", () => {
    expect(findToolInfo("nonexistent_tool")).toBeUndefined();
  });

  it("returns info with summaryTemplate when defined", () => {
    const info = findToolInfo("mail_search");
    expect(info?.summaryTemplate).toContain("query");
  });

  it("returns info without summaryTemplate for tools that don't need one", () => {
    const info = findToolInfo("mail_accounts");
    expect(info?.summaryTemplate).toBeUndefined();
  });
});

describe("formatToolSummary", () => {
  it("resolves templates for tools with summaryTemplate", () => {
    expect(formatToolSummary("web_search", { query: "latest news" })).toBe(
      'Searching web for "latest news"',
    );
  });

  it("returns null for tools without summaryTemplate", () => {
    expect(formatToolSummary("mail_accounts", {})).toBeNull();
  });

  it("returns null for unknown tools", () => {
    expect(formatToolSummary("nonexistent_tool", {})).toBeNull();
  });

  it("resolves mail_search template", () => {
    expect(formatToolSummary("mail_search", { query: "invoice" })).toBe(
      'Searching emails for "invoice"',
    );
  });

  it("resolves mail_sync static template", () => {
    expect(formatToolSummary("mail_sync", {})).toBe("Syncing mailbox");
  });

  it("resolves infra_exec template with machineName arg", () => {
    expect(formatToolSummary("infra_exec", { command: "ls -la", machineName: "prod-web" })).toBe(
      "Running ls -la on prod-web",
    );
  });

  it("resolves infra_add_machine template with name arg", () => {
    expect(formatToolSummary("infra_add_machine", { name: "home-server" })).toBe(
      "Adding machine home-server",
    );
  });

  it("resolves infra_remove_machine template with name arg", () => {
    expect(formatToolSummary("infra_remove_machine", { name: "old-server" })).toBe(
      "Removing machine old-server",
    );
  });

  it("leaves missing placeholders as-is", () => {
    expect(formatToolSummary("infra_exec", { command: "ls" })).toBe("Running ls on {machineName}");
  });
});

describe("resolveToolSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates non-infra tools to formatToolSummary", async () => {
    const result = await resolveToolSummary("web_search", { query: "react docs" }, "user-1");
    expect(result).toBe('Searching web for "react docs"');
  });

  it("resolves infra_exec with machine name from DB", async () => {
    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({ name: "prod-web-01" });

    const result = await resolveToolSummary(
      "infra_exec",
      {
        id: "machine-123",
        command: "systemctl status nginx",
      },
      "user-1",
    );

    expect(result).toBe("Running systemctl status nginx on prod-web-01");
    expect(mockInfraMachine.findFirst).toHaveBeenCalledWith({
      where: { id: "machine-123", userId: "user-1" },
      select: { name: true },
    });
  });

  it("resolves infra_write_file with machineId arg", async () => {
    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({ name: "deploy-server" });

    const result = await resolveToolSummary(
      "infra_write_file",
      {
        machineId: "machine-456",
        path: "/etc/nginx/nginx.conf",
        content: "...",
      },
      "user-1",
    );

    expect(result).toBe("Writing to /etc/nginx/nginx.conf on deploy-server");
  });

  it("resolves infra_notes_list with machine name", async () => {
    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({ name: "web-01" });

    const result = await resolveToolSummary("infra_notes_list", { id: "m1" }, "user-1");

    expect(result).toBe("Listing notes for web-01");
  });

  it("resolves infra_notes_upsert with machineId", async () => {
    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue({ name: "prod" });

    const result = await resolveToolSummary(
      "infra_notes_upsert",
      {
        machineId: "m1",
        title: "services",
        content: "nginx, postgres",
      },
      "user-1",
    );

    expect(result).toBe("Saving note on prod");
  });

  it("resolves infra_add_machine without DB lookup (uses name from args)", async () => {
    const result = await resolveToolSummary(
      "infra_add_machine",
      {
        name: "new-server",
        host: "10.0.0.1",
        username: "deploy",
        authMethod: "key",
      },
      "user-1",
    );

    expect(result).toBe("Adding machine new-server");
    // No DB lookup needed — template uses {name} from args
    expect(mockInfraMachine.findFirst).not.toHaveBeenCalled();
  });

  it("resolves infra_remove_machine without DB lookup", async () => {
    const result = await resolveToolSummary(
      "infra_remove_machine",
      {
        id: "m1",
        name: "old-server",
      },
      "user-1",
    );

    expect(result).toBe("Removing machine old-server");
    expect(mockInfraMachine.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to missing machineName when machine not found", async () => {
    vi.mocked(mockInfraMachine.findFirst).mockResolvedValue(null);

    const result = await resolveToolSummary(
      "infra_exec",
      {
        id: "nonexistent",
        command: "ls",
      },
      "user-1",
    );

    expect(result).toBe("Running ls on {machineName}");
  });

  it("returns null for infra_notes_get (no template, no machine ID)", async () => {
    const result = await resolveToolSummary("infra_notes_get", { id: "note-123" }, "user-1");
    expect(result).toBeNull();
  });

  it("returns null for infra_notes_delete (no template)", async () => {
    const result = await resolveToolSummary("infra_notes_delete", { id: "note-456" }, "user-1");
    expect(result).toBeNull();
  });

  it("returns null for infra_list_machines (no template)", async () => {
    const result = await resolveToolSummary("infra_list_machines", {}, "user-1");
    expect(result).toBeNull();
  });

  it("returns null for unknown tools", async () => {
    const result = await resolveToolSummary("nonexistent_tool", {}, "user-1");
    expect(result).toBeNull();
  });
});

describe("ALL_TOOL_INFOS consistency", () => {
  it("has summaryTemplate for infra tools that need machine name resolution", () => {
    const infraToolsWithTemplates = ALL_TOOL_INFOS.filter(
      (t) => t.category === "infra" && t.summaryTemplate,
    );

    const names = infraToolsWithTemplates.map((t) => t.name);
    expect(names).toContain("infra_exec");
    expect(names).toContain("infra_write_file");
    expect(names).toContain("infra_notes_list");
    expect(names).toContain("infra_notes_upsert");
    expect(names).toContain("infra_add_machine");
    expect(names).toContain("infra_remove_machine");
  });

  it("infra notes_get and notes_delete have no summaryTemplate (no machine ID in args)", () => {
    expect(findToolInfo("infra_notes_get")?.summaryTemplate).toBeUndefined();
    expect(findToolInfo("infra_notes_delete")?.summaryTemplate).toBeUndefined();
  });
});
