/**
 * patent_figure_* — 工具错误码契约测试（#545）。
 *
 * `code` 在本仓是**语义通道**，不是日志字段：上层按它选恢复策略
 * （`src/tool/execution/errorRecovery.ts`）、按它识别"连续传非法入参"并熔断
 * （`src/agent/loop/AgentLoop.ts` 与 `toolFailure.ts`）。把入参校验抛出的
 * `invalid_tool_input` 折叠成 `tool_execution_failed`，等于把可修复的输入错误报成执行环境
 * 故障：模型只会反复重试，不会去改 `format`；`details`（tool / format / path）也一并丢失。
 *
 * 三个制图工具必须同法——结构化错误原样透传，只有非结构化异常才包装。三个工具此前三种写法
 * 并存（两个折叠、一个正确），新工具会照抄哪一份并不确定。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import { createPatentFigureCheckTool } from "../../../src/tool/builtin/patentFigureCheck.js";
import { createPatentFigureGenerateTool } from "../../../src/tool/builtin/patentFigureGenerate.js";
import { createPatentFigureProjectTool } from "../../../src/tool/builtin/patentFigureProject.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-test",
    turnId: "turn-1",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      rules: { allow: [], deny: [], ask: [] },
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
    },
  };
}

const FIG: FigureSpec = {
  figure_no: 1,
  kind: "flowchart",
  nodes: [{ id: "a", label: "处理模块(20)", ref: 20 }],
  edges: [],
};

/** 取拒绝原因（不抛：调用方要检查 `code`，而不只是 message 正则）。 */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err;
  }
}

function assertInvalidInput(err: unknown, tool: string, messagePattern: RegExp): SatiToolRuntimeError {
  assert.ok(err instanceof SatiToolRuntimeError, `应抛 SatiToolRuntimeError，实际为 ${String(err)}`);
  assert.equal(err.code, "invalid_tool_input", "入参错误不得折叠成 tool_execution_failed");
  assert.match(err.message, messagePattern);
  assert.equal(err.details?.tool, tool, "details.tool 须随错误外传");
  return err;
}

test("patent_figure_generate：try 内的入参校验保住 invalid_tool_input 与 details", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-figuregen-codes-"));
  try {
    const tool = createPatentFigureGenerateTool();
    const err = await caught(tool.execute({ figures: [FIG], output_name: "pkg", format: "pdf" }, makeContext(cwd)));
    const typed = assertInvalidInput(err, "patent_figure_generate", /非法 format "pdf"/u);
    assert.equal(typed.details?.format, "pdf", "details.format 是调用方修复入参的线索");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_check：try 内的读盘/校验失败保住 invalid_tool_input", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-figuregen-codes-"));
  try {
    const tool = createPatentFigureCheckTool();
    const err = await caught(
      tool.execute({ image_paths: ["不存在的附图.png"], spec_text: "处理模块(20)" }, makeContext(cwd)),
    );
    assertInvalidInput(err, "patent_figure_check", /无法读取附图图片/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_check：try 之外的入参校验（对照组）码不变", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-figuregen-codes-"));
  try {
    const tool = createPatentFigureCheckTool();
    const err = await caught(tool.execute({ spec_text: "处理模块(20)" }, makeContext(cwd)));
    assertInvalidInput(err, "patent_figure_check", /至少提供一项/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_project：三个工具同法（非法 view 亦为 invalid_tool_input）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-figuregen-codes-"));
  try {
    const tool = createPatentFigureProjectTool();
    const err = await caught(
      tool.execute({ step_path: "part.step", output_name: "pkg", view: "isometric" }, makeContext(cwd)),
    );
    assertInvalidInput(err, "patent_figure_project", /非法 view/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
