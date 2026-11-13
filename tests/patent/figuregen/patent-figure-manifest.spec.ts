/**
 * src/tool/builtin/patentFigureManifest — 附图交付物清单工具（登记 + 校验）。
 *
 * 覆盖要点（与工具的诚实口径一一对应）：
 * 1. build 模式：登记出文件、角色与哈希，且**不写盘**（清单只在返回值里）；
 * 2. check 模式：文件被改过 ⇒ `hash-mismatch`；文件没了 ⇒ `file-missing`；
 * 3. 三态：sidecar 无 `deliverables` 字段 ⇒ `not-registered`（**不是** verified，
 *    也不是「已核验通过」）⇒ `ok=false`；
 * 4. 输出契约：canonical data 满足工具声明的 `outputSchema`。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDeliverableManifest } from "../../../src/patent/figuregen/deliverable-manifest.js";
import { buildFigureSidecar } from "../../../src/patent/figuregen/sidecar.js";
import {
  createPatentFigureManifestTool,
  type PatentFigureManifestOutput,
} from "../../../src/tool/builtin/patentFigureManifest.js";
import { validateCanonicalOutput } from "../../../src/tool/execution/outputSchemaValidation.js";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

/** 每个用例一个临时目录（用完即删，不污染工作区）。 */
async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sati-figure-manifest-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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

/** 调工具并取 canonical data（顺带断言输出契约成立）。 */
async function runTool(
  input: Parameters<ReturnType<typeof createPatentFigureManifestTool>["execute"]>[0],
  cwd: string,
): Promise<PatentFigureManifestOutput> {
  const tool = createPatentFigureManifestTool();
  const result = await tool.execute(input, makeContext(cwd));
  assert.ok(result.data !== undefined, "工具必须返回 canonical data");
  assert.deepEqual(validateCanonicalOutput(result.data, tool.outputSchema ?? {}), []);
  return result.data as PatentFigureManifestOutput;
}

/** 取某类发现。 */
function findingsOfKind(output: PatentFigureManifestOutput, kind: string) {
  return output.findings.filter(finding => finding.kind === kind);
}

/** 写一份带清单的 sidecar（清单按当前文件实况算）。 */
async function writeSidecarWithManifest(
  dir: string,
  outputName: string,
  files: readonly { role: "figure" | "submission-page" | "html"; path: string }[],
): Promise<string> {
  const manifest = await buildDeliverableManifest(files);
  const sidecar = buildFigureSidecar({
    outputName,
    renderer: "builtin",
    jurisdiction: "cn",
    files: [],
    figures: [],
    check: { ok: true, findings: [], refsInFigures: [], refsInText: [] },
    skipTextRules: true,
    deliverables: manifest,
  });
  const sidecarPath = join(dir, `${outputName}-figures.json`);
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), "utf8");
  return sidecarPath;
}

/** 写一份**无清单字段**的 sidecar（旧 sidecar 的合法形态）。 */
async function writeSidecarWithoutManifest(dir: string, outputName: string): Promise<string> {
  const sidecar = buildFigureSidecar({
    outputName,
    renderer: "builtin",
    jurisdiction: "cn",
    files: [],
    figures: [],
    check: { ok: true, findings: [], refsInFigures: [], refsInText: [] },
    skipTextRules: true,
  });
  const sidecarPath = join(dir, `${outputName}-figures.json`);
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), "utf8");
  return sidecarPath;
}

test("build 模式：登记出文件、角色与哈希（清单只在返回值里，不写盘）", async () => {
  await withTempDir(async dir => {
    const figurePath = join(dir, "figs-fig1.svg");
    const pagePath = join(dir, "figs-fig1-page.svg");
    const content = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    await writeFile(figurePath, content, "utf8");
    await writeFile(pagePath, "<svg/>", "utf8");
    const before = (await readdir(dir)).sort();

    const output = await runTool({ mode: "build", output_dir: dir, output_name: "figs" }, dir);

    assert.equal(output.mode, "build");
    assert.equal(output.checked, "verified");
    assert.equal(output.ok, true);
    assert.equal(output.manifest.length, 2);
    const figure = output.manifest.find(entry => entry.file === "figs-fig1.svg");
    assert.equal(figure?.role, "figure");
    assert.equal(figure?.sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(figure?.bytes, Buffer.byteLength(content));
    assert.ok(typeof figure?.mtimeMs === "number");
    const page = output.manifest.find(entry => entry.file === "figs-fig1-page.svg");
    assert.equal(page?.role, "submission-page");
    assert.deepEqual((await readdir(dir)).sort(), before, "build 模式不得写盘");
  });
});

test("build 模式：files 直给文件清单（只登记符合命名约定的产物）", async () => {
  await withTempDir(async dir => {
    const figurePath = join(dir, "figs-fig2.svg");
    await writeFile(figurePath, "<svg/>", "utf8");
    await writeFile(join(dir, "notes.txt"), "随手记的一笔", "utf8");

    const output = await runTool({ mode: "build", files: [figurePath, join(dir, "notes.txt")] }, dir);

    assert.equal(output.manifest.length, 1);
    assert.equal(output.manifest[0]?.file, "figs-fig2.svg");
    assert.equal(output.findings.filter(finding => finding.severity === "fail").length, 0);
    assert.equal(findingsOfKind(output, "not-in-manifest").length, 1, "命名不合约定的文件不进清单，但要说清为什么");
  });
});

test("build 模式：文件读不到 ⇒ file-missing（不把「没写成」记成「已登记」）", async () => {
  await withTempDir(async dir => {
    const missingPath = join(dir, "figs-fig1.svg");
    const output = await runTool({ mode: "build", files: [missingPath] }, dir);

    assert.equal(output.manifest.length, 0);
    assert.equal(output.ok, false);
    assert.equal(output.checked, "unavailable");
    assert.equal(findingsOfKind(output, "file-missing").length, 1);
  });
});

test("check 模式：文件被改过 ⇒ hash-mismatch（内容漂移，ok=false）", async () => {
  await withTempDir(async dir => {
    const figurePath = join(dir, "figs-fig1.svg");
    await writeFile(figurePath, "<svg>原始内容</svg>", "utf8");
    const sidecarPath = await writeSidecarWithManifest(dir, "figs", [{ role: "figure", path: figurePath }]);
    // 登记之后内容被改（长度也变）⇒ 内容漂移。
    await writeFile(figurePath, "<svg>被改过的更长内容</svg>", "utf8");

    const output = await runTool({ mode: "check", sidecar_path: sidecarPath }, dir);

    assert.equal(output.checked, "verified");
    assert.equal(output.ok, false);
    const mismatch = findingsOfKind(output, "hash-mismatch");
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0]?.file, "figs-fig1.svg");
    assert.equal(mismatch[0]?.severity, "fail");
    assert.equal(findingsOfKind(output, "size-mismatch").length, 0, "hash 命中时不重复报大小");
  });
});

test("check 模式：登记过的文件没了 ⇒ file-missing", async () => {
  await withTempDir(async dir => {
    const figurePath = join(dir, "figs-fig1.svg");
    await writeFile(figurePath, "<svg/>", "utf8");
    const sidecarPath = await writeSidecarWithManifest(dir, "figs", [{ role: "figure", path: figurePath }]);
    await rm(figurePath);

    const output = await runTool({ mode: "check", sidecar_path: sidecarPath }, dir);

    assert.equal(output.checked, "verified");
    assert.equal(output.ok, false);
    const missing = findingsOfKind(output, "file-missing");
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.file, "figs-fig1.svg");
  });
});

test("check 模式：清单与当前文件一致 ⇒ verified 且零发现", async () => {
  await withTempDir(async dir => {
    const figurePath = join(dir, "figs-fig1.svg");
    await writeFile(figurePath, "<svg/>", "utf8");
    const sidecarPath = await writeSidecarWithManifest(dir, "figs", [{ role: "figure", path: figurePath }]);

    const output = await runTool({ mode: "check", sidecar_path: sidecarPath }, dir);

    assert.equal(output.checked, "verified");
    assert.equal(output.ok, true);
    assert.deepEqual(output.findings, []);
    assert.equal(output.manifest.length, 1);
  });
});

test("check 模式：sidecar 无 deliverables 字段 ⇒ not-registered（未核验，不判通过）", async () => {
  await withTempDir(async dir => {
    await writeFile(join(dir, "figs-fig1.svg"), "<svg/>", "utf8");
    const sidecarPath = await writeSidecarWithoutManifest(dir, "figs");

    const output = await runTool({ mode: "check", sidecar_path: sidecarPath }, dir);

    assert.equal(output.checked, "not-registered", "没登记 ≠ 已核验通过");
    assert.equal(output.ok, false, "未核验不得判通过");
    assert.deepEqual(output.findings, []);
    assert.match(output.note, /未核验/u);
  });
});

test("check 模式：sidecar 不存在 ⇒ not-registered（未核验，不判通过）", async () => {
  await withTempDir(async dir => {
    const output = await runTool({ mode: "check", sidecar_path: join(dir, "figs-figures.json") }, dir);

    assert.equal(output.checked, "not-registered");
    assert.equal(output.ok, false);
    assert.match(output.note, /未核验/u);
  });
});

test("check 模式：目录里多出没登记的产物 ⇒ not-in-manifest（warn，不阻断）", async () => {
  await withTempDir(async dir => {
    const figurePath = join(dir, "figs-fig1.svg");
    await writeFile(figurePath, "<svg/>", "utf8");
    const sidecarPath = await writeSidecarWithManifest(dir, "figs", [{ role: "figure", path: figurePath }]);
    await writeFile(join(dir, "figs-fig2.svg"), "<svg/>", "utf8");

    const output = await runTool({ mode: "check", sidecar_path: sidecarPath }, dir);

    const unregistered = findingsOfKind(output, "not-in-manifest");
    assert.equal(unregistered.length, 1);
    assert.equal(unregistered[0]?.file, "figs-fig2.svg");
    assert.equal(unregistered[0]?.severity, "warn");
    assert.equal(output.ok, true, "warn 级不阻断");
  });
});

test("check 模式：output_dir + output_name 定位（清单与产物同名主干）", async () => {
  await withTempDir(async dir => {
    const figurePath = join(dir, "figs-fig1.svg");
    await writeFile(figurePath, "<svg/>", "utf8");
    await writeSidecarWithManifest(dir, "figs", [{ role: "figure", path: figurePath }]);

    const output = await runTool({ mode: "check", output_dir: dir, output_name: "figs" }, dir);

    assert.equal(output.checked, "verified");
    assert.equal(output.ok, true);
    assert.equal(output.manifest.length, 1);
  });
});

test("check 模式：files 定位（清单取同目录 sidecar，比对集合＝调用方点名的文件）", async () => {
  await withTempDir(async dir => {
    const figurePath = join(dir, "figs-fig1.svg");
    await writeFile(figurePath, "<svg/>", "utf8");
    await writeSidecarWithManifest(dir, "figs", [{ role: "figure", path: figurePath }]);

    const output = await runTool({ mode: "check", files: [figurePath] }, dir);

    assert.equal(output.checked, "verified");
    assert.equal(output.ok, true);
    assert.deepEqual(output.findings, []);
  });
});

test("入参：定位方式必须三选一（缺一报错，同时给也报错）", async () => {
  await withTempDir(async dir => {
    const tool = createPatentFigureManifestTool();
    await assert.rejects(
      () => tool.execute({ mode: "check" }, makeContext(dir)),
      (err: unknown) => err instanceof SatiToolRuntimeError && err.code === "invalid_tool_input",
    );
    await assert.rejects(
      () =>
        tool.execute(
          { mode: "check", sidecar_path: join(dir, "figs-figures.json"), files: [join(dir, "figs-fig1.svg")] },
          makeContext(dir),
        ),
      (err: unknown) => err instanceof SatiToolRuntimeError && err.code === "invalid_tool_input",
    );
    await assert.rejects(
      () => tool.execute({ mode: "check", output_dir: dir }, makeContext(dir)),
      (err: unknown) => err instanceof SatiToolRuntimeError && err.code === "invalid_tool_input",
    );
  });
});

test("入参：mode 非法 ⇒ invalid_tool_input（不静默按缺省处理）", async () => {
  await withTempDir(async dir => {
    const tool = createPatentFigureManifestTool();
    await assert.rejects(
      () => tool.execute({ mode: "verify" }, makeContext(dir)),
      (err: unknown) => err instanceof SatiToolRuntimeError && err.code === "invalid_tool_input",
    );
  });
});

test("工具契约：名称 / 域 / 别名 / 只读 / 输出契约齐备", () => {
  const tool = createPatentFigureManifestTool();
  assert.equal(tool.name, "patent_figure_manifest");
  assert.equal(tool.domain, "patent");
  assert.equal(tool.kind, "custom");
  assert.deepEqual(tool.aliases, ["PatentFigureManifest", "figure_manifest"]);
  assert.equal(tool.title, "Patent Figure Deliverable Manifest");
  assert.equal(tool.isReadOnly({}), true, "build 模式也只读盘不写盘");
  assert.ok(tool.outputSchema !== undefined, "必须声明输出契约");
  assert.ok(tool.description.length <= 1200, `描述过长：${String(tool.description.length)}`);
});
