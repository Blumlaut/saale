import { describe, expect, it } from "vitest";
import {
  CODER_TOOL_DEFAULTS,
  resolveCoderToolConfig,
  resolveCoderToolPolicies,
} from "@/lib/pi/coder-tools";
import { TOOL_CATEGORIES } from "@/lib/pi/tool-categories";
import { findProperty } from "@/lib/settings/properties";

describe("coder tool config", () => {
  it("turns on the worktree tools and leaves the app's own off", () => {
    expect(CODER_TOOL_DEFAULTS.terminal).toBe(true);
    expect(CODER_TOOL_DEFAULTS.web).toBe(true);
    expect(CODER_TOOL_DEFAULTS.memory).toBe(true);
    expect(CODER_TOOL_DEFAULTS.email).toBe(false);
    expect(CODER_TOOL_DEFAULTS.calendar).toBe(false);
    expect(CODER_TOOL_DEFAULTS.jobs).toBe(false);
  });

  it("follows the defaults for a category the stored config does not name", () => {
    const config = resolveCoderToolConfig(null);
    expect(Object.keys(config).sort()).toEqual(TOOL_CATEGORIES.map((c) => c.key).sort());
    // A category added after the setting was stored is still resolved.
    expect(config.watchers).toBe(CODER_TOOL_DEFAULTS.watchers);
  });

  it("lets a stored entry win over the default", () => {
    const config = resolveCoderToolConfig({ email: true, terminal: false });
    expect(config.email).toBe(true);
    expect(config.terminal).toBe(false);
    expect(config.memory).toBe(true);
  });

  it("ignores a stored value that is not a boolean", () => {
    const config = resolveCoderToolConfig({ email: "yes", terminal: null });
    expect(config.email).toBe(false);
    expect(config.terminal).toBe(true);
  });
});

describe("coder tool policies", () => {
  it("leaves the file tools open", () => {
    const policies = resolveCoderToolPolicies(null);
    expect(policies.write).toBe("allow");
    expect(policies.edit).toBe("allow");
  });

  it("keeps a policy the user set", () => {
    const policies = resolveCoderToolPolicies({ write: "off", mail_send: "ask" });
    expect(policies.write).toBe("off");
    expect(policies.edit).toBe("allow");
    expect(policies.mail_send).toBe("ask");
  });
});

describe("coder settings properties", () => {
  it("exposes a toggle per tool category", () => {
    for (const category of TOOL_CATEGORIES) {
      const property = findProperty(`coder.tools.category.${category.key}.enabled`);
      expect(property, category.key).toBeDefined();
      expect(property?.scope).toBe("user");
      expect(property?.columns).toEqual(["coderToolConfig"]);
    }
  });
});
