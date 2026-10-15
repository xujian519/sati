/**
 * CLI 旗标解析（P2.7 从 `cli/sati.ts` 搬出的纯函数）行为锚。
 *
 * 约定：`--flag value`；值缺失或以 `--` 开头一律视为「未提供」——这条约定让
 * `sati cron create --message --json` 这类误用退化为「缺参数报用法」，而不是把
 * 下一个旗标当成值喂给 gateway。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  inferChannelKey,
  readNumberFlag,
  readPort,
  readRepeatedStringFlag,
  readStringFlag,
} from "../../src/cli/commands/flagParsing.js";

test("readPort 解析合法端口，非法与缺失返回 undefined", () => {
  assert.equal(readPort(["--port", "8080"]), 8080);
  assert.equal(readPort(["--port"]), undefined);
  assert.equal(readPort(["--port", "abc"]), undefined);
  assert.equal(readPort(["--port", "--other"]), undefined);
  assert.equal(readPort(["server"]), undefined);
});

test("readStringFlag 拒绝把下一个旗标当值", () => {
  assert.equal(readStringFlag(["--session", "cli:x"], "--session"), "cli:x");
  assert.equal(readStringFlag(["--session", "--json"], "--session"), undefined);
  assert.equal(readStringFlag(["--session"], "--session"), undefined);
  assert.equal(readStringFlag([], "--session"), undefined);
  // 只取首个匹配（与 indexOf 语义一致）
  assert.equal(readStringFlag(["--task", "a", "--task", "b"], "--task"), "a");
});

test("readRepeatedStringFlag 收集全部出现且同样拒绝旗标值", () => {
  assert.deepEqual(readRepeatedStringFlag(["--source", "a", "--source", "b"], "--source"), ["a", "b"]);
  assert.deepEqual(readRepeatedStringFlag(["--source", "--x"], "--source"), []);
  assert.deepEqual(readRepeatedStringFlag([], "--source"), []);
});

test("readNumberFlag 在 readStringFlag 之上叠加数字解析", () => {
  assert.equal(readNumberFlag(["--limit", "5"], "--limit"), 5);
  assert.equal(readNumberFlag(["--limit", "x"], "--limit"), undefined);
  assert.equal(readNumberFlag([], "--limit"), undefined);
});

test("inferChannelKey 按第一个冒号切分，无冒号或冒号在首字符回落 cli", () => {
  assert.equal(inferChannelKey("cli:s_local"), "cli");
  assert.equal(inferChannelKey("team:t1:m2"), "team");
  assert.equal(inferChannelKey("no-colon"), "cli");
  assert.equal(inferChannelKey(":leading"), "cli");
});
