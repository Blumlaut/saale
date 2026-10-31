/**
 * How a computer's tool call reads on a card.
 *
 * The tools arrive as `mcp__<machine>__<tool>`, so the arguments mean nothing
 * to the person reading the transcript. A card says `Click at 812, 340 on
 * workstation` instead of `{"x":812,"y":340}`.
 */

import { mcpNameKey, mcpServerFromToolName } from "@/lib/mcp/shared";
import { sanitizeDeviceName } from "./shared";

/** Longest command or text a card quotes before it stops being a card. */
const MAX_QUOTE = 80;

function quote(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_QUOTE ? `${flat.slice(0, MAX_QUOTE)}…` : flat;
}

function number(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "number" ? String(Math.round(value)) : null;
}

function text(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The summary of one device tool call, or null when the tool is not one of the
 * agent's.
 */
export function deviceToolSummary(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const on = ` on ${sanitizeDeviceName(serverName)}`;
  const at = `${number(args, "x")}, ${number(args, "y")}`;

  switch (toolName) {
    case "screenshot": {
      const monitor = text(args, "monitor");
      return monitor ? `Screenshot of ${monitor}${on}` : `Screenshot${on}`;
    }
    case "list_windows":
      return `List the windows${on}`;
    case "click": {
      const button = text(args, "button");
      const kind =
        button === "right" ? "Right click" : button === "middle" ? "Middle click" : "Click";
      return `${kind} at ${at}${on}`;
    }
    case "double_click":
      return `Double click at ${at}${on}`;
    case "move":
      return `Move the pointer to ${at}${on}`;
    case "drag":
      return `Drag ${number(args, "from_x")}, ${number(args, "from_y")} to ${number(args, "to_x")}, ${number(args, "to_y")}${on}`;
    case "scroll": {
      const dy = number(args, "dy") ?? "0";
      const dx = number(args, "dx") ?? "0";
      return `Scroll ${dx}, ${dy} at ${at}${on}`;
    }
    case "type_text": {
      const body = text(args, "text");
      return body ? `Type "${quote(body)}"${on}` : `Type text${on}`;
    }
    case "press_key": {
      const keys = text(args, "keys");
      return keys ? `Press ${keys}${on}` : `Press a key${on}`;
    }
    case "read_file": {
      const path = text(args, "path");
      return path ? `Read ${path}${on}` : `Read a file${on}`;
    }
    case "write_file": {
      const path = text(args, "path");
      return path ? `Write ${path}${on}` : `Write a file${on}`;
    }
    case "list_dir": {
      const path = text(args, "path");
      return path ? `List ${path}${on}` : `List a directory${on}`;
    }
    case "grep": {
      const pattern = text(args, "pattern");
      return pattern ? `Search for "${quote(pattern)}"${on}` : `Search a directory${on}`;
    }
    case "find": {
      const pattern = text(args, "pattern");
      return pattern ? `Find files named "${quote(pattern)}"${on}` : `Find files${on}`;
    }
    case "run_command": {
      const command = text(args, "command");
      return command ? `Run "${quote(command)}"${on}` : `Run a command${on}`;
    }
    default:
      return null;
  }
}

/** The machine segment of an MCP tool name, when the tool has one. */
export function deviceNameFromTool(toolName: string): string | null {
  return mcpServerFromToolName(toolName);
}

/** Whether two names are the same machine, in the spelling Pi folds them to. */
export function sameDevice(a: string, b: string): boolean {
  return mcpNameKey(a) === mcpNameKey(b);
}
