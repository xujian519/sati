import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PERMISSION_SETTINGS,
  getPermissionSettingsPath,
  normalizePermissionEntry,
  normalizePermissionSettings,
  permissionEntryToRule,
  permissionSettingsToRuleSet,
  readPermissionSettings,
  writePermissionSettings,
} from "../../src/permission/index.js";

test("normalizePermissionEntry maps tool name aliases", () => {
  assert.equal(normalizePermissionEntry("Read"), "read_file");
  assert.equal(normalizePermissionEntry("Write"), "write_file");
  assert.equal(normalizePermissionEntry("Edit"), "edit_file");
  assert.equal(normalizePermissionEntry("Bash"), "bash");
  assert.equal(normalizePermissionEntry("WebSearch"), "web_search");
});

test("normalizePermissionEntry converts Bash(...) to bash:pattern", () => {
  assert.equal(normalizePermissionEntry("Bash(npm run build)"), "bash:npm run build");
  // 空参数 → 纯 bash
  assert.equal(normalizePermissionEntry("Bash()"), "bash");
  // 空白 → 空字符串
  assert.equal(normalizePermissionEntry("   "), "");
});

test("normalizePermissionEntry passes through unknown tool names and trims", () => {
  assert.equal(normalizePermissionEntry("  write_file  "), "write_file");
  assert.equal(normalizePermissionEntry("custom_tool"), "custom_tool");
});

test("permissionEntryToRule splits pattern after first colon", () => {
  const r = permissionEntryToRule("bash:npm run build", "allow");
  assert.equal(r.source, "user");
  assert.equal(r.behavior, "allow");
  assert.equal(r.toolName, "bash");
  assert.equal(r.pattern, "npm run build");
});

test("permissionEntryToRule with no pattern leaves pattern undefined", () => {
  const r = permissionEntryToRule("read_file", "allow");
  assert.equal(r.toolName, "read_file");
  assert.equal(r.pattern, undefined);
});

test("permissionSettingsToRuleSet maps allowed/disallowed arrays", () => {
  const rules = permissionSettingsToRuleSet({
    version: 1,
    allowedTools: ["write_file", "bash:npm run build"],
    disallowedTools: ["Read"],
    skipPermissions: true,
  });
  assert.deepEqual(
    rules.allow.map(r => r.behavior),
    ["allow", "allow"],
  );
  assert.deepEqual(
    rules.allow.map(r => r.toolName),
    ["write_file", "bash"],
  );
  assert.deepEqual(rules.ask, []);
  assert.equal(rules.deny.length, 1);
  assert.equal(rules.deny[0]?.toolName, "read_file");
  assert.equal(rules.deny[0]?.behavior, "deny");
});

test("normalizePermissionSettings tolerates malformed input", () => {
  for (const bad of [null, "nope", [], undefined]) {
    const settings = normalizePermissionSettings(bad);
    assert.equal(settings.version, 1);
    assert.deepEqual(settings.allowedTools, []);
    assert.deepEqual(settings.disallowedTools, []);
    assert.equal(settings.skipPermissions, false);
  }
});

test("normalizePermissionSettings normalizes entries and deduplicates", () => {
  const settings = normalizePermissionSettings({
    allowedTools: ["Write", "write_file", "  ", 42, "Bash(npm test)"],
    disallowedTools: "not-array",
    skipPermissions: false,
  });
  assert.deepEqual(settings.allowedTools, ["write_file", "bash:npm test"]);
  assert.deepEqual(settings.disallowedTools, []);
  assert.equal(settings.skipPermissions, false);
  assert.equal(settings.version, 1);
});

test("readPermissionSettings: missing file defaults, corrupt file fails safe", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-perm-test-"));
  try {
    const env = { SATI_HOME: dir };
    // 文件不存在（首次运行）→ 合法默认
    assert.deepEqual(readPermissionSettings(env), DEFAULT_PERMISSION_SETTINGS);
    // 写一个损坏的文件 → 保守处理：不容忍损坏放大为绕过权限（skipPermissions=false）
    writeFileSync(join(dir, "permissions.json"), "{invalid json", "utf8");
    assert.deepEqual(readPermissionSettings(env), { ...DEFAULT_PERMISSION_SETTINGS, skipPermissions: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writePermissionSettings persists and overwrites per field", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-perm-test-"));
  try {
    const env = { SATI_HOME: dir };
    const path = getPermissionSettingsPath(env);
    const written = writePermissionSettings({ allowedTools: ["write_file"], skipPermissions: false }, env);
    assert.deepEqual(written.allowedTools, ["write_file"]);
    assert.equal(written.skipPermissions, false);
    assert.equal(typeof written.lastUpdated, "string");

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { allowedTools: string[]; skipPermissions: boolean };
    assert.deepEqual(onDisk.allowedTools, ["write_file"]);
    assert.equal(onDisk.skipPermissions, false);

    // 二次写入按字段覆盖（写什么字段替换什么字段）
    const overwritten = writePermissionSettings({ allowedTools: ["bash"] }, env);
    assert.deepEqual(overwritten.allowedTools, ["bash"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getPermissionSettingsPath honors SATI_HOME env", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-perm-test-"));
  try {
    const env = { SATI_HOME: dir };
    assert.equal(getPermissionSettingsPath(env), join(dir, "permissions.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
