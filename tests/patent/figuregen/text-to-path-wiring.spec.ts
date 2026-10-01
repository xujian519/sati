/**
 * 文本转路径（字体独立导出）的**接线**测试：门控、产物、sidecar 标记与回读语义。
 *
 * 模块自身的判据与失败分类见 `inkscape-renderer.spec.ts`；这里只测"接进生成流程"这一层：
 * - 默认关时完全不碰产物（SVG 保留 `<text>`、sidecar 无标记）；
 * - 开启时图形与落版页都转路径，且 sidecar 记录 `text_to_path`；
 * - 开关开了却没有 Inkscape 时**在落盘之前** fail-loud（不留半成品输出目录）。
 *
 * 假 Inkscape 是可执行脚本（本仓既有手法），故不依赖本机真装了 Inkscape。
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FIGURE_TEXT_TO_PATH_ENV, INKSCAPE_CMD_ENV, parseFigureSvg } from "../../../src/patent/figuregen/index.js";
import { FigureGateHandler, isInterruptStageError, type PipelineState } from "../../../src/patent/index.js";
import { createPatentFigureGenerateTool } from "../../../src/tool/builtin/patentFigureGenerate.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

const FIG: FigureSpec = {
  figure_no: 1,
  kind: "flowchart",
  nodes: [
    { id: "a", label: "开始", shape: "ellipse" },
    { id: "b", label: "处理模块(20)", ref: 20 },
  ],
  edges: [{ from: "a", to: "b", label: "是" }],
};

/** figure-gate 的输入态（附图目录 + 说明书文本两面）。 */
function gateState(dir: string): PipelineState {
  return { figure_dir: dir, claims_draft: "处理模块(20)。", spec_draft: "处理模块(20)执行处理。" };
}

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-textpath",
    turnId: "turn-textpath",
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

/** 假 Inkscape：把 `<text>…</text>` 全部换成 `<path/>`（模拟"字形已转轮廓"）。 */
const FAKE_INKSCAPE = `#!/usr/bin/env python3
import re, sys
out = None
source = None
for arg in sys.argv[1:]:
    if arg.startswith("--export-filename="):
        out = arg.split("=", 1)[1]
    else:
        source = arg
data = open(source, encoding="utf-8").read()
data = re.sub(r"<text[^>]*>.*?</text>", '<path d="M0 0"/>', data, flags=re.S)
open(out, "w", encoding="utf-8").write(data)
`;

function writeFakeInkscape(dir: string): string {
  const script = join(dir, "fake-inkscape");
  writeFileSync(script, FAKE_INKSCAPE, "utf8");
  chmodSync(script, 0o755);
  return script;
}

/** 在指定的环境变量下执行，结束后逐字恢复（避免用例间互相污染）。 */
async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("文本转路径默认关：产物保留 <text>、sidecar 不记 text_to_path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-t2p-off-"));
  try {
    await withEnv({ [FIGURE_TEXT_TO_PATH_ENV]: undefined, [INKSCAPE_CMD_ENV]: undefined }, async () => {
      await createPatentFigureGenerateTool().execute(
        { figures: [FIG], output_name: "keep", output_dir: dir },
        makeContext(dir),
      );
    });
    assert.match(readFileSync(join(dir, "keep-fig1.svg"), "utf8"), /<text/u, "默认关时字形应保持为文本");
    const sidecar = JSON.parse(readFileSync(join(dir, "keep-figures.json"), "utf8")) as { text_to_path?: boolean };
    assert.equal(sidecar.text_to_path, undefined, "未转路径不得留下标记");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文本转路径开启：图形与落版页都转路径，sidecar 记 text_to_path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-t2p-on-"));
  try {
    const fake = writeFakeInkscape(dir);
    await withEnv({ [FIGURE_TEXT_TO_PATH_ENV]: "1", [INKSCAPE_CMD_ENV]: fake }, async () => {
      await createPatentFigureGenerateTool().execute(
        { figures: [FIG], output_name: "outlined", output_dir: dir, fit_to_page: true },
        makeContext(dir),
      );
    });
    assert.doesNotMatch(readFileSync(join(dir, "outlined-fig1.svg"), "utf8"), /<text/u, "图形应转为轮廓");
    assert.doesNotMatch(
      readFileSync(join(dir, "outlined-fig1-page.svg"), "utf8"),
      /<text/u,
      "落版页同样要转（它也是交付物，同样依赖读者字体）",
    );
    const sidecar = JSON.parse(readFileSync(join(dir, "outlined-figures.json"), "utf8")) as {
      text_to_path?: boolean;
    };
    assert.equal(sidecar.text_to_path, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文本转路径开启但 Inkscape 不可用：落盘前 fail-loud（不留半成品目录）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-t2p-missing-"));
  try {
    // `SATI_INKSCAPE_CMD` 指向不存在的文件：显式覆盖值不可用按契约报错（不回落自动探测）
    await withEnv(
      { [FIGURE_TEXT_TO_PATH_ENV]: "1", [INKSCAPE_CMD_ENV]: join(dir, "definitely-not-here") },
      async () => {
        await assert.rejects(
          createPatentFigureGenerateTool().execute(
            { figures: [FIG], output_name: "ghost", output_dir: dir },
            makeContext(dir),
          ),
          /可执行文件不可用/u,
        );
      },
    );
    assert.equal(existsSync(join(dir, "ghost-fig1.svg")), false, "探测失败必须发生在落盘之前");
    assert.deepEqual(
      readdirSync(dir).filter(name => name.startsWith("ghost")),
      [],
      "不得留下任何半成品",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("转路径后 figure-gate 不把「读不到文本图号」误判为「无图号」（V15）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-t2p-gate-"));
  try {
    const fake = writeFakeInkscape(dir);
    // 两幅图：CN 档案下「两幅以上须用阿拉伯数字顺序编号」，缺图号会 V15 fail
    await withEnv({ [FIGURE_TEXT_TO_PATH_ENV]: "1", [INKSCAPE_CMD_ENV]: fake }, async () => {
      await createPatentFigureGenerateTool().execute(
        {
          figures: [FIG, { ...FIG, figure_no: 2 }],
          output_name: "gated",
          output_dir: dir,
        },
        makeContext(dir),
      );
    });
    const sidecar = JSON.parse(readFileSync(join(dir, "gated-figures.json"), "utf8")) as { text_to_path?: boolean };
    assert.equal(sidecar.text_to_path, true, "用例前提：产物确实转过路径");

    // 回读层面：文字已成轮廓 ⇒ `numbered`（可见形态，属性不算）必然为 false，
    // 这正是需要回退到生成期 sidecar 的原因。
    assert.equal(parseFigureSvg(readFileSync(join(dir, "gated-fig1.svg"), "utf8")).numbered, false);

    const handler = new FigureGateHandler();
    let report: string;
    try {
      report = String((await handler.execute({ state: gateState(dir) })).figure_report ?? "");
    } catch (err) {
      assert.ok(isInterruptStageError(err), `不应有别的错误：${String(err)}`);
      report = String((err.data as { figure_report?: string }).figure_report ?? "");
    }
    assert.doesNotMatch(report, /\[FAIL\] V15/u, "转路径后不得因读不到文本图号而报 V15");
    assert.match(report, /图1、图2 带图号/u, "图号观测应以生成期 sidecar 的 caption 为准");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
