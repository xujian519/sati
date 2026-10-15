/**
 * `sati skills migrate` 的参数解析与状态渲染（P2.7 从 `cli/sati.ts` 搬出的纯函数）。
 *
 * `parseSkillMigrationSources` 抛错是**有意**的：未知来源写错时宁可让顶层
 * `main().catch` 打出「Unknown skills source」，也不要静默当成「不迁移任何来源」
 * 让用户以为迁移成功却什么都没做。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { formatSkillMigrationStatus, parseSkillMigrationSources } from "../../src/cli/commands/skillsCommand.js";
import type { SkillMigrationItem } from "../../src/extension/skills/index.js";

test("parseSkillMigrationSources 处理别名、all 与去重", () => {
  assert.equal(parseSkillMigrationSources(undefined), undefined);
  assert.equal(parseSkillMigrationSources(""), undefined);
  assert.deepEqual(parseSkillMigrationSources("claude"), ["claude-code"]);
  assert.deepEqual(parseSkillMigrationSources("cc"), ["claude-code"]);
  assert.deepEqual(parseSkillMigrationSources("claude-code"), ["claude-code"]);
  assert.deepEqual(parseSkillMigrationSources("openclaw"), ["openclaw"]);
  assert.deepEqual(parseSkillMigrationSources("hermes"), ["hermes"]);
  assert.deepEqual(parseSkillMigrationSources("all"), ["claude-code", "openclaw", "hermes"]);
  // 大小写与空白归一，重复项去重
  assert.deepEqual(parseSkillMigrationSources(" ALL "), ["claude-code", "openclaw", "hermes"]);
  assert.deepEqual(parseSkillMigrationSources("cc,cc"), ["claude-code"]);
  assert.deepEqual(parseSkillMigrationSources("cc,,openclaw"), ["claude-code", "openclaw"]);
  // 全空项 => 未指定（undefined），而非空数组
  assert.equal(parseSkillMigrationSources(",,,"), undefined);
});

test("parseSkillMigrationSources 对未知来源抛错（不静默降级）", () => {
  assert.throws(() => parseSkillMigrationSources("cursor"), /Unknown skills source "cursor"/);
});

test("formatSkillMigrationStatus 五态映射", () => {
  const statuses: Array<[SkillMigrationItem["status"], string]> = [
    ["migrated", "+"],
    ["would_migrate", "?"],
    ["conflict", "!"],
    ["error", "x"],
    ["skipped", "-"],
  ];
  for (const [status, glyph] of statuses) {
    assert.equal(formatSkillMigrationStatus({ status } as SkillMigrationItem), glyph, status);
  }
});
