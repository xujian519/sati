/**
 * TeamShare 共享黑板原语单测（P1-4）：CRUD / 去重 / 落盘重建 / 摘要。
 * 纯文件测试（无 mock）：每条 path 用 mkdtemp 隔离，黑板不驱动调度、无事件面。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TeamShare,
  clearTeamShareCache,
  getTeamShare,
  writeTeamShare,
  type TeamShareEntry,
} from "../../../../src/agent/team/index.js";

function boardPath(): string {
  return join(mkdtempSync(join(tmpdir(), "sati-team-share-")), "share.jsonl");
}

function entry(overrides: Partial<TeamShareEntry> = {}): TeamShareEntry {
  return {
    key: "结论:t3-新颖性",
    value: "D2 单独对比不覆盖区别特征",
    writer: "m1",
    ts: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

test("TeamShare：write 追加 JSONL，落盘可重建（同 key 历史版本保留）", () => {
  const path = boardPath();
  const board = new TeamShare(path);
  board.write(entry({ key: "k", value: "v1", ts: "2026-08-31T00:00:00.000Z" }));
  board.write(entry({ key: "k", value: "v2", ts: "2026-08-31T00:00:01.000Z", writer: "m2" }));

  // 磁盘持久化：两行 JSONL（同 key 不同 writer/toolCallId 不去重）
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "JSONL 每行一条，同 key 不同写入者保留历史");

  // 重建（新实例）读回全史
  const reloaded = new TeamShare(path);
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.read("k")?.value, "v2", "read 返回同 key 最新值");
  assert.deepEqual(reloaded.keys(), ["k"], "keys 去重且按首次出现序");
});

test("TeamShare：write 按 (key, writer, toolCallId) 去重幂等（resume/重放不重复落）", () => {
  const path = boardPath();
  const board = new TeamShare(path);
  const base = entry({ key: "检索范围", value: "CPC: A61K", writer: "m1", toolCallId: "call-1" });
  board.write(base);
  board.write(base); // 完全重复
  board.write(entry({ ...base, value: "CPC: A61K; A61P" })); // 同 key/writer/toolCallId 不同 value 仍去重（丢弃）
  board.write(entry({ ...base, value: "CPC: A61P", toolCallId: "call-2" })); // 不同 toolCallId → 新条目
  assert.equal(board.size(), 2, "前三条去重为 1，第 4 条独立写入");

  // 重建后去重集合一致（去重集合从落盘恢复，不因重放重复读入）
  const reloaded = new TeamShare(path);
  assert.equal(reloaded.size(), 2);
});

test("TeamShare：summary 输出键 + 值前缀 + 写入者；空黑板返回空串", () => {
  const board = new TeamShare(boardPath());
  assert.equal(board.summary(), "", "空黑板 summary 为空串（调用方据此不注入注记）");
  board.write(entry({ key: "检索范围", value: "CPC: A61K", writer: "m1" }));
  board.write(entry({ key: "结论:t3-新颖性", value: "D2 单独对比不覆盖区别特征", writer: "captain" }));
  const s = board.summary();
  assert.ok(s.includes("检索范围"), "含键名");
  assert.ok(s.includes("m1"), "含写入者");
  assert.ok(s.includes("D2 单独对比不覆盖区别特征"), "含值（≤prefixLen 不截断）");

  // 值超 prefixLen 断前缀 + maxEntries 封顶
  board.write(entry({ key: "long", value: "x".repeat(100), writer: "m1" }));
  const trimmed = board.summary(10, 5);
  assert.ok(trimmed.includes("xxxxx…"), "超长值断前缀并加省略号");
  assert.equal(board.summary(1, 30).split("\n").length, 1, "maxEntries 封顶");
});

test("TeamShare：summary 同 key 取最新值（与 read 语义一致），键按首次出现序", () => {
  const board = new TeamShare(boardPath());
  board.write(entry({ key: "k", value: "v1", writer: "m1" }));
  board.write(entry({ key: "k", value: "v2", writer: "m1", toolCallId: "call-2" }));
  board.write(entry({ key: "x", value: "x1", writer: "captain" }));
  const s = board.summary();
  assert.ok(s.includes("v2"), "summary 取同 key 最新值");
  assert.ok(!s.includes("v1"), "不暴露同 key 历史值");
  assert.ok(s.indexOf("k") < s.indexOf("x"), "键按首次出现序（k 先写在前）");
});

test("TeamShare：load 容忍坏行（追加写并发读到半行不崩）", () => {
  const path = boardPath();
  const board = new TeamShare(path);
  board.write(entry({ key: "good", value: "v", writer: "m1" }));
  // 手工追加一段坏行（非 JSON/缺字段）
  appendFileSync(path, "{bad-json\n");
  appendFileSync(path, JSON.stringify({ key: 123 }) + "\n");
  const reloaded = new TeamShare(path);
  assert.equal(reloaded.size(), 1, "坏行/缺字段行跳过，好行保留");
});

/**
 * #531 实例缓存：同路径在 (mtimeMs, size) 未变时复用同一 TeamShare 实例，避免每次派发/
 * 面板读取都全量 readFileSync + 逐行 JSON.parse。负控制内建于「同一实例」断言：若 getTeamShare
 * 退回每次 new TeamShare，引用相等断言即红。
 */
test("#531 getTeamShare：(mtime,size) 未变 → 复用同一实例（load 只跑一次）", () => {
  clearTeamShareCache();
  const path = boardPath();
  const first = getTeamShare(path);
  const second = getTeamShare(path);
  assert.equal(first, second, "签名未变 → 缓存命中返回同一实例（未重新构造/load）");
});

test("#531 getTeamShare：文件 size 变化 → 签名失效 → 重建并读回新内容", () => {
  clearTeamShareCache();
  const path = boardPath();
  const first = getTeamShare(path);
  assert.equal(first.size(), 0, "前置：空黑板");
  // 外部追加（绕过实例）→ size 变化 → 下次访问必须失配重建
  appendFileSync(path, `${JSON.stringify(entry({ key: "外部", value: "v", writer: "m9" }))}\n`);
  const second = getTeamShare(path);
  assert.notEqual(first, second, "签名失配 → 重建新实例（负控制：缓存不失效则返回同一实例红）");
  assert.equal(second.size(), 1, "新实例读回外部追加的条目");
});

test("#531 writeTeamShare：写后刷新签名 → 后续读命中热实例，键序保持首次出现序", () => {
  clearTeamShareCache();
  const path = boardPath();
  writeTeamShare(path, entry({ key: "k1", value: "v1", writer: "m1" }));
  const afterWrite = getTeamShare(path);
  assert.equal(afterWrite.size(), 1, "写后读命中热实例（含新条目，未因签名失配重读盘）");

  writeTeamShare(path, entry({ key: "k2", value: "v2", writer: "m2" }));
  writeTeamShare(path, entry({ key: "k1", value: "v1b", writer: "m1", toolCallId: "c2" }));
  const board = getTeamShare(path);
  // 键序 = 首次出现序（k1 先写在前），与缓存前 summary()/keys() 逐字一致——反向扫会翻成末次序
  assert.deepEqual(board.keys(), ["k1", "k2"], "键按首次出现序");
  assert.equal(board.read("k1")?.value, "v1b", "同 key 取最新值");
  const summary = board.summary();
  assert.ok(summary.indexOf("k1") < summary.indexOf("k2"), "summary 键序为首次出现序（k1 在 k2 前）");
});

test("#531 writeTeamShare：去重写入不改文件 → 签名同值刷新无害，size 不增", () => {
  clearTeamShareCache();
  const path = boardPath();
  const base = entry({ key: "k", value: "v", writer: "m1", toolCallId: "call-1" });
  writeTeamShare(path, base);
  writeTeamShare(path, base); // 完全重复 → 幂等丢弃，不追加
  const board = getTeamShare(path);
  assert.equal(board.size(), 1, "重复写入去重，黑板仍 1 条");
});
