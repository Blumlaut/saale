import { describe, it, expect } from "vitest";
import {
  COMMAND_CATALOG,
  getCommandMeta,
  listCommands,
  searchCommands,
} from "@/lib/commands/catalog";
import type { CommandSurface } from "@/lib/commands/types";

/**
 * The catalog is what every surface renders from. Telegram imposes its own
 * constraints on command names and descriptions  a violation is rejected by
 * the Bot API at registration time, so it must fail here instead.
 */
describe("command catalog", () => {
  it("declares at least one command", () => {
    expect(COMMAND_CATALOG.length).toBeGreaterThan(0);
  });

  it("uses names the Telegram bot menu accepts", () => {
    for (const meta of COMMAND_CATALOG) {
      expect(meta.name, `"${meta.name}" is not a legal Telegram command name`).toMatch(
        /^[a-z][a-z0-9_]{0,31}$/,
      );
    }
  });

  it("keeps descriptions inside Telegram's bot menu limit", () => {
    for (const meta of COMMAND_CATALOG) {
      expect(meta.description.length).toBeLessThanOrEqual(256);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it("offers every command on at least one surface", () => {
    for (const meta of COMMAND_CATALOG) {
      expect(meta.surfaces.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate names", () => {
    const names = COMMAND_CATALOG.map((meta) => meta.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses aliases Telegram accepts that collide with no other name", () => {
    const names: readonly string[] = COMMAND_CATALOG.map((meta) => meta.name);
    const aliases = COMMAND_CATALOG.flatMap((meta) => ("aliases" in meta ? meta.aliases : []));

    for (const alias of aliases) {
      expect(alias, `"${alias}" is not a legal Telegram command name`).toMatch(
        /^[a-z][a-z0-9_]{0,31}$/,
      );
    }
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases.filter((alias) => names.includes(alias))).toEqual([]);
  });

  it("looks commands up case-insensitively", () => {
    expect(getCommandMeta("MODEL")?.name).toBe("model");
    expect(getCommandMeta("nope")).toBeUndefined();
  });

  it("resolves an alias to the command it stands for", () => {
    expect(getCommandMeta("yolo")?.name).toBe("stfu");
    expect(getCommandMeta("YOLO")?.name).toBe("stfu");
    // An alias is not a surface entry of its own.
    expect(listCommands("web").map((meta) => meta.name)).not.toContain("yolo");
  });

  it("lists commands per surface", () => {
    const web = listCommands("web").map((meta) => meta.name);
    const telegram = listCommands("telegram").map((meta) => meta.name);

    expect(web).toContain("compact");
    expect(telegram).toContain("compact");
    // Starting a chat is a Telegram-only command: the web has a button.
    expect(telegram).toContain("new");
    expect(web).not.toContain("new");
    // A command must not leak into a surface it does not declare.
    for (const meta of COMMAND_CATALOG) {
      for (const surface of ["web", "telegram"] as CommandSurface[]) {
        expect((meta.surfaces as readonly CommandSurface[]).includes(surface)).toBe(
          (surface === "web" ? web : telegram).includes(meta.name),
        );
      }
    }
  });

  it("searches by name and by description, ranking name matches first", () => {
    expect(searchCommands("web", "").map((meta) => meta.name)).toEqual(
      listCommands("web").map((meta) => meta.name),
    );
    expect(searchCommands("web", "com").map((meta) => meta.name)).toEqual(["compact"]);

    // No command name contains "approvals"  this only matches the stfu
    // description, which is how the menu stays findable by intent.
    expect(searchCommands("web", "approvals").map((meta) => meta.name)).toEqual(["stfu"]);

    // "s" matches two names and every description: the names come first.
    const ranked = searchCommands("web", "s").map((meta) => meta.name);
    expect(ranked.slice(0, 2)).toEqual(["stfu", "stop"]);
    expect(ranked).toHaveLength(listCommands("web").length);

    // An alias finds its command by name, not by description.
    expect(searchCommands("web", "yolo").map((meta) => meta.name)).toEqual(["stfu"]);

    expect(searchCommands("web", "zzz")).toEqual([]);
  });
});
