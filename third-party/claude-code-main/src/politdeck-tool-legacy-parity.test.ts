import { describe, expect, test } from "bun:test";
import { toolMatchesName } from "./Tool.js";
import { BashTool } from "./tools/BashTool/BashTool.js";
import { FileReadTool } from "./tools/FileReadTool/FileReadTool.js";
import { GlobTool } from "./tools/GlobTool/GlobTool.js";
import { GrepTool } from "./tools/GrepTool/GrepTool.js";
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from "./utils/permissions/PermissionMode.js";

describe("legacy tool contract probes for PolitDeck parity", () => {
  test("tool lookup matches primary names and aliases", () => {
    expect(toolMatchesName({ name: "Read", aliases: ["read_file"] }, "Read")).toBe(true);
    expect(toolMatchesName({ name: "Read", aliases: ["read_file"] }, "read_file")).toBe(true);
    expect(toolMatchesName({ name: "Read", aliases: ["read_file"] }, "Write")).toBe(false);
  });

  test("permission mode parsing falls back to default", () => {
    expect(permissionModeFromString("plan")).toBe("plan");
    expect(permissionModeFromString("not-a-mode")).toBe("default");
    expect(toExternalPermissionMode("bypassPermissions")).toBe("bypassPermissions");
  });

  test("filesystem read and search tools are read-only and concurrency safe", () => {
    expect(FileReadTool.name).toBe("Read");
    expect(FileReadTool.isReadOnly({ file_path: `${process.cwd()}/package.json` })).toBe(true);

    expect(GlobTool.name).toBe("Glob");
    expect(GlobTool.isReadOnly({ pattern: "**/*" })).toBe(true);
    expect(GlobTool.isConcurrencySafe({ pattern: "**/*" })).toBe(true);

    expect(GrepTool.name).toBe("Grep");
    expect(GrepTool.isReadOnly({ pattern: "needle" })).toBe(true);
    expect(GrepTool.isConcurrencySafe({ pattern: "needle" })).toBe(true);
  });

  test("bash read-only classification drives concurrency safety", () => {
    expect(BashTool.name).toBe("Bash");
    expect(BashTool.isReadOnly({ command: "pwd" })).toBe(true);
    expect(BashTool.isConcurrencySafe({ command: "pwd" })).toBe(true);

    expect(BashTool.isReadOnly({ command: "npm install" })).toBe(false);
    expect(BashTool.isConcurrencySafe({ command: "npm install" })).toBe(false);
  });
});
