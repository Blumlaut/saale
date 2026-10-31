import { describe, expect, it } from "vitest";
import { deviceToolSummary } from "@/lib/devices/summary";

const MACHINE = "workstation";

describe("a computer's tool call on a card", () => {
  it("names the machine and the action", () => {
    expect(deviceToolSummary(MACHINE, "click", { x: 812, y: 340.4 })).toBe(
      "Click at 812, 340 on workstation",
    );
    expect(deviceToolSummary(MACHINE, "double_click", { x: 10, y: 20 })).toBe(
      "Double click at 10, 20 on workstation",
    );
    expect(deviceToolSummary(MACHINE, "click", { x: 1, y: 2, button: "right" })).toBe(
      "Right click at 1, 2 on workstation",
    );
  });

  it("quotes what a command or a typing call carries", () => {
    expect(deviceToolSummary(MACHINE, "run_command", { command: "  ls\n -la " })).toBe(
      'Run "ls -la" on workstation',
    );
    expect(deviceToolSummary(MACHINE, "type_text", { text: "hello there" })).toBe(
      'Type "hello there" on workstation',
    );
  });

  it("keeps a long quote readable", () => {
    const summary = deviceToolSummary(MACHINE, "run_command", { command: "x".repeat(200) });
    expect(summary?.length).toBeLessThan(120);
    expect(summary?.endsWith("…\" on workstation")).toBe(true);
  });

  it("says which file and which display", () => {
    expect(deviceToolSummary(MACHINE, "read_file", { path: "/etc/hosts" })).toBe(
      "Read /etc/hosts on workstation",
    );
    expect(deviceToolSummary(MACHINE, "screenshot", {})).toBe("Screenshot on workstation");
    expect(deviceToolSummary(MACHINE, "screenshot", { monitor: "display-1" })).toBe(
      "Screenshot of display-1 on workstation",
    );
  });

  it("answers nothing for a tool it does not know", () => {
    expect(deviceToolSummary(MACHINE, "send_email", {})).toBeNull();
  });
});
