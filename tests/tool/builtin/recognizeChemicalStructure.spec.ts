/**
 * recognize_chemical_structure 工具集成测试。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/index.js";
import { createRecognizeChemicalStructureTool } from "../../../src/tool/builtin/recognizeChemicalStructure.js";
import type { ChemistryPhase } from "../../../src/patent/chemistry/index.js";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { SatiToolModelClient, SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const STEP1_JSON = JSON.stringify({
  is_chemical: true,
  kind: "structure",
  overall_description: "阿司匹林的结构式",
  confidence: 0.9,
});

const STEP2_JSON = JSON.stringify({
  kind: "structure",
  candidates: [{ smiles: "CC(=O)OC1=CC=CC=C1C(=O)O", confidence: 0.95 }],
  names: ["阿司匹林"],
  formula: "C9H8O4",
});

const REVIEW_JSON = JSON.stringify({
  kind: "structure",
  kept_formulas: ["C9H8O4"],
  kept_smiles: [],
  names: [{ name: "阿司匹林", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O", confidence: 0.9 }],
  warnings: [],
});

const NAME_JSON = JSON.stringify({
  kind: "structure",
  candidates: [{ smiles: "C1=CC=CC=C1", confidence: 0.8 }],
  names: ["苯"],
  formula: "C6H6",
});

function fakeModel(): SatiToolModelClient {
  return {
    async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      const phase = request.metadata?.phase as ChemistryPhase;
      const body =
        phase === "step1" ? STEP1_JSON : phase === "step2" ? STEP2_JSON : phase === "name" ? NAME_JSON : REVIEW_JSON;
      yield { type: "text_delta", text: body };
      yield { type: "usage", usage: { inputTokens: 8, outputTokens: 8 } };
    },
  };
}

function baseContext(model: SatiToolModelClient | undefined, cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    model,
  };
}

/** 生成一张真实 PNG 并写入临时目录，返回绝对路径。 */
async function makeTmpPng(): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-chem-tool-"));
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  const buffer = await sharp({
    create: { width: 600, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
  const filePath = path.join(dir, "chem1.png");
  await writeFile(filePath, buffer);
  return { dir, filePath };
}

test("recognize_chemical_structure: 工具元数据（只读/并发安全/域）", () => {
  const tool = createRecognizeChemicalStructureTool();
  assert.equal(tool.name, "recognize_chemical_structure");
  assert.equal(tool.domain, "patent");
  assert.equal(tool.isReadOnly({ image_path: "x.png" }), true);
  assert.equal(tool.isConcurrencySafe({ image_path: "x.png" }), true);
});

test("recognize_chemical_structure: 无模型客户端时返回错误而非抛出", async () => {
  const tool = createRecognizeChemicalStructureTool();
  const result = await tool.execute({ image_path: "x.png" }, baseContext(undefined, process.cwd()));
  const first = result.content[0];
  assert.equal(first?.type, "text");
  if (first?.type === "text") {
    assert.ok(first.text.includes("未注入模型客户端"), "应提示模型客户端缺失");
  }
});

test("recognize_chemical_structure: image 模式——全流程识别并写入化学索引", async () => {
  const { dir, filePath } = await makeTmpPng();
  try {
    const tool = createRecognizeChemicalStructureTool();
    const result = await tool.execute(
      { image_path: filePath, mode: "image", claim_context: "一种药物化合物" },
      baseContext(fakeModel(), dir),
    );

    const output = result.data as {
      kind: string;
      canonicalSmiles: string;
      formula: string;
      usable: boolean;
      needHumanReview: boolean;
    };
    assert.equal(output.kind, "structure");
    assert.equal(output.canonicalSmiles, "CC(=O)Oc1ccccc1C(=O)O");
    assert.equal(output.formula, "C9H8O4");
    assert.equal(output.usable, true);
    assert.equal(output.needHumanReview, false);
    assert.equal(result.metadata?.mode, "image");
    assert.equal(result.metadata?.indexed, true);

    const indexPath = path.join(dir, ".sati", "chemistry-index.json");
    const indexRaw = await readFile(indexPath, "utf8");
    const index = JSON.parse(indexRaw) as { entries: Array<{ sourceKey: string }> };
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0]?.sourceKey, path.relative(dir, filePath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recognize_chemical_structure: text 模式——文档文本三级流水线并写入索引", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-chem-tool-"));
  try {
    const tool = createRecognizeChemicalStructureTool();
    const text = "本实施例制备了阿司匹林 CC(=O)OC1=CC=CC=C1C(=O)O，分子式 C9H8O4。";
    const result = await tool.execute({ text, mode: "text" }, baseContext(fakeModel(), dir));

    const output = result.data as { canonicalSmiles: string; usable: boolean; names: string[] };
    assert.equal(output.canonicalSmiles, "CC(=O)Oc1ccccc1C(=O)O");
    assert.equal(output.usable, true);
    assert.ok(output.names.includes("阿司匹林"));
    assert.equal(result.metadata?.mode, "text");
    assert.equal(result.metadata?.indexed, true);

    const indexPath = path.join(dir, ".sati", "chemistry-index.json");
    const indexRaw = await readFile(indexPath, "utf8");
    const index = JSON.parse(indexRaw) as { entries: Array<{ sourceKey: string }> };
    assert.ok(index.entries[0]?.sourceKey.startsWith("text:"), "文本模式索引键应为 text:<hash>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recognize_chemical_structure: text 模式——化合物名称走 name→SMILES 单步流", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-chem-tool-"));
  try {
    const tool = createRecognizeChemicalStructureTool();
    const result = await tool.execute({ text: "苯" }, baseContext(fakeModel(), dir));

    const output = result.data as { canonicalSmiles: string; usable: boolean };
    assert.equal(output.canonicalSmiles, "c1ccccc1");
    assert.equal(output.usable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recognize_chemical_structure: auto 模式按输入分派（image_path → image；text → text）", async () => {
  const { dir, filePath } = await makeTmpPng();
  try {
    const tool = createRecognizeChemicalStructureTool();
    const imageResult = await tool.execute({ image_path: filePath }, baseContext(fakeModel(), dir));
    assert.equal(imageResult.metadata?.mode, "image");

    const textResult = await tool.execute({ text: "化合物为 C6H12O6。" }, baseContext(fakeModel(), dir));
    assert.equal(textResult.metadata?.mode, "text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recognize_chemical_structure: 索引写入失败时静默降级（indexed=false 且结果不受影响）", async () => {
  const { dir, filePath } = await makeTmpPng();
  try {
    // 用普通文件占住 .sati 路径：upsert 时 mkdir/readFile 失败 → 写入失败
    await writeFile(path.join(dir, ".sati"), "不是目录", "utf8");
    const tool = createRecognizeChemicalStructureTool();
    const result = await tool.execute({ image_path: filePath, mode: "image" }, baseContext(fakeModel(), dir));

    assert.equal(result.metadata?.indexed, false);
    const output = result.data as { canonicalSmiles: string };
    assert.equal(output.canonicalSmiles, "CC(=O)Oc1ccccc1C(=O)O");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recognize_chemical_structure: plan 只读模式不写索引", async () => {
  const { dir, filePath } = await makeTmpPng();
  try {
    const tool = createRecognizeChemicalStructureTool();
    const planContext: SatiToolRuntimeContext = {
      sessionId: "s1",
      turnId: "t1",
      cwd: dir,
      permissionMode: "plan",
      permissionContext: {
        mode: "plan",
        cwd: dir,
        additionalWorkingDirectories: [],
        canPrompt: true,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
      model: fakeModel(),
    };
    const result = await tool.execute({ image_path: filePath, mode: "image" }, planContext);

    assert.equal(result.metadata?.indexed, false);
    await assert.rejects(() => readFile(path.join(dir, ".sati", "chemistry-index.json"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recognize_chemical_structure: 非法输入校验", async () => {
  const tool = createRecognizeChemicalStructureTool();
  // image 模式缺 image_path
  await assert.rejects(
    () => tool.execute({ mode: "image" }, baseContext(fakeModel(), process.cwd())),
    (err: unknown) => {
      assert.ok(err instanceof SatiToolRuntimeError);
      assert.equal(err.code, "invalid_tool_input");
      return true;
    },
  );
  // text 模式空文本
  await assert.rejects(
    () => tool.execute({ mode: "text", text: "   " }, baseContext(fakeModel(), process.cwd())),
    (err: unknown) => {
      assert.ok(err instanceof SatiToolRuntimeError);
      assert.equal(err.code, "invalid_tool_input");
      return true;
    },
  );
});
