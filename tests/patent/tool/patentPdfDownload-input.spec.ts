/**
 * TASK-P1-02 测试：下载路径安全。
 *
 * - validateInput：专利号归一化后拒绝路径穿越字符（\ 与 ..），保留去重/上限校验；
 * - checkPermissions：outputDir 解析后在工作区之外时追加越界提示
 *   （保留绝对路径能力，不改变可写路径集合）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createPatentPdfDownloadTool } from "../../../src/tool/builtin/patentPdfDownload.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const tool = createPatentPdfDownloadTool();
// validateInput / checkPermissions 在 SatiToolDefinition 上为可选字段，
// 本工具实现提供了两者，测试以非空断言收紧。
const validateInput = tool.validateInput!;
const checkPermissions = tool.checkPermissions!;

function makeContext(cwd: string): SatiToolRuntimeContext {
  return { cwd, env: process.env } as unknown as SatiToolRuntimeContext;
}

test("validateInput：正常专利号通过，且归一化去重生效", async () => {
  const res = await validateInput({ patents: ["CN115690481A", "cn115690481a", " CN115690481A "] }, makeContext("/tmp"));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual((res.input as { patents: string[] }).patents, ["CN115690481A"]);
  }
});

test("validateInput：路径穿越专利号 CN../evil 被拒绝", async () => {
  const res = await validateInput({ patents: ["CN../evil"] }, makeContext("/tmp"));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.issues[0].message, /path traversal/);
  }
});

test("validateInput：反斜杠专利号 CN..\\evil 被拒绝（Windows 分隔符）", async () => {
  const res = await validateInput({ patents: ["CN..\\evil"] }, makeContext("/tmp"));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.issues[0].message, /path traversal/);
  }
});

test("validateInput：空专利列表被拒绝", async () => {
  const res = await validateInput({ patents: [] }, makeContext("/tmp"));
  assert.equal(res.ok, false);
});

test("validateInput：混合合法与穿越专利号，整体拒绝并列出违规项", async () => {
  const res = await validateInput({ patents: ["CN115690481A", "US11452699B2", "CN..\\.\\evil"] }, makeContext("/tmp"));
  assert.equal(res.ok, false);
  if (!res.ok) {
    // 消息为归一化后的违规项原文（"CN..\\.\\evil"），断言包含穿越标记即可
    assert.ok(res.issues[0].message.includes(".."), res.issues[0].message);
  }
});

test("checkPermissions：outputDir 在 workspace 内时无越界提示", async () => {
  const res = await checkPermissions(
    { patents: ["CN115690481A"], outputDir: "patents" },
    makeContext("/Users/xujian/projects/Sati"),
  );
  assert.equal(res.type, "ask");
  assert.ok(!res.reason.message.includes("outside the current workspace"));
});

test("checkPermissions：outputDir 在 workspace 外（绝对路径）时追加越界提示", async () => {
  const res = await checkPermissions(
    { patents: ["CN115690481A"], outputDir: "/Users/xujian/Downloads/patents" },
    makeContext("/Users/xujian/projects/Sati"),
  );
  assert.equal(res.type, "ask");
  assert.ok(
    res.reason.message.includes("outside the current workspace"),
    `message 应含越界提示: ${res.reason.message}`,
  );
});

test("checkPermissions：不传 outputDir（默认 workspace 内）时无越界提示", async () => {
  const res = await checkPermissions({ patents: ["CN115690481A"] }, makeContext("/Users/xujian/projects/Sati"));
  assert.equal(res.type, "ask");
  assert.ok(!res.reason.message.includes("outside the current workspace"));
});
