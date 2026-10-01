/**
 * Inkscape 文字转路径导出测试（src/patent/figuregen/inkscape-renderer.ts）。
 *
 * 进程边界用 **chmod +x 的临时 shell 脚本**冒充 inkscape（照本仓 tools-graphviz.spec.ts
 * "假可执行脚本"的隔离手法），单测**不依赖本机真装了 Inkscape**：假脚本自己拷贝预置产物，
 * 退出码/ stderr / 是否产出由脚本行为决定。
 *
 * 覆盖：成功路径的原子换入、`<text>` 残留、安全门、几何/画布守卫、非 SVG 目标、
 * 缺二进制的两条路径（fail-loud 的 TypeError 与结构化 setup_required）、非零退出码、
 * 退出码 0 但 stderr 有实质输出、超时、调用方取消、产物缺失、可执行发现顺序与门控解析。
 * 每个用例都断言"被拒时原文件逐字节不变"或产物内容，断言被改坏即变红。
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  FIGURE_TEXT_TO_PATH_ENV,
  INKSCAPE_CANDIDATE_PATHS,
  INKSCAPE_CMD_ENV,
  checkOutlineGeometry,
  exportSvgTextToPath,
  isFigureTextToPathEnabled,
  isSvgTarget,
  resolveInkscapeCmd,
} from "../../../src/patent/figuregen/inkscape-renderer.js";

/** 待转换的原图：80×40mm 画幅，一个矩形 + 一条中文标签（`<text>`，字体依赖的来源）。 */
const ORIGINAL_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="40mm" viewBox="0 0 80 40" font-family="sans-serif">',
  '<rect x="10" y="10" width="60" height="20" fill="#FFFFFF" stroke="#000000" stroke-width="0.25"/>',
  '<text x="40" y="24" font-size="5" text-anchor="middle" fill="#000000">开始(10)</text>',
  "</svg>",
].join("\n");

/** 转换产物：文字被轮廓路径替代，画布与墨迹范围不变（成功路径的预置产物）。 */
const OUTLINED_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="40mm" viewBox="0 0 80 40" font-family="sans-serif">',
  '<rect x="10" y="10" width="60" height="20" fill="#FFFFFF" stroke="#000000" stroke-width="0.25"/>',
  '<path d="M33.5 19 L46.5 19 L46.5 25.5 L33.5 25.5 Z" fill="#000000"/>',
  "</svg>",
].join("\n");

/** 临时工作区（原图 + 假可执行脚本 + 预置产物）。 */
function makeWorkspace(): { dir: string; svgPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sati-inkscape-"));
  const svgPath = join(dir, "fig.svg");
  writeFileSync(svgPath, ORIGINAL_SVG, "utf8");
  return { dir, svgPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 写一个假 inkscape 可执行脚本（`chmod +x`）：脚本先解出 `--export-filename=` 的参数放进 `$out`，
 * 再执行 `body` 各行（body 里可用 `"$out"` 读该路径）。
 */
function writeFakeInkscape(dir: string, name: string, body: readonly string[]): string {
  const script = [
    "#!/bin/sh",
    // 真实 Inkscape 也是从 argv 里读 --export-filename=…；假脚本照抄这个形状，参数装配出问题即失败。
    'out=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --export-filename=*) out="${arg#--export-filename=}" ;;',
    "  esac",
    "done",
    ...body,
    "",
  ].join("\n");
  const path = join(dir, name);
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** 把产物写进临时文件并返回其路径（假脚本用 `cp` 把它拷成 Inkscape 的产物）。 */
function writeProduct(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

test("resolveInkscapeCmd：显式覆盖 → 平台候选 → PATH；覆盖值不存在抛 TypeError（不回落）", () => {
  const missing = join(tmpdir(), "sati-no-such-inkscape");
  assert.throws(
    () => resolveInkscapeCmd({ [INKSCAPE_CMD_ENV]: missing }, { exists: () => false }),
    (error: unknown) => error instanceof TypeError && /指向的文件不存在/u.test(error.message),
    "显式覆盖值不存在必须抛 TypeError，不得回落自动探测",
  );

  const explicit = resolveInkscapeCmd(
    { [INKSCAPE_CMD_ENV]: "/opt/custom/inkscape" },
    { exists: path => path === "/opt/custom/inkscape" },
  );
  assert.deepEqual(explicit, { cmd: "/opt/custom/inkscape", source: INKSCAPE_CMD_ENV });

  // 平台候选优先于 PATH：只让第二个候选存在（PATH 段上的名字也存在，仍应返回候选）。
  const candidate = INKSCAPE_CANDIDATE_PATHS[1]!;
  const fromCandidate = resolveInkscapeCmd(
    { PATH: "/some/path-dir" },
    { exists: path => path === candidate || path === join("/some/path-dir", "inkscape") },
  );
  assert.equal(fromCandidate?.cmd, candidate);

  const fromPath = resolveInkscapeCmd(
    { PATH: `/nope${delimiter}/some/path-dir` },
    { exists: path => path === join("/some/path-dir", "inkscape") },
  );
  assert.deepEqual(fromPath, { cmd: join("/some/path-dir", "inkscape"), source: "PATH /some/path-dir" });

  assert.equal(resolveInkscapeCmd({ PATH: "" }, { exists: () => false }), undefined);
});

test("门控：SATI_FIGURE_TEXT_TO_PATH 默认关，1/true/on 为开", () => {
  assert.equal(isFigureTextToPathEnabled({}), false, "未设默认关");
  assert.equal(isFigureTextToPathEnabled({ [FIGURE_TEXT_TO_PATH_ENV]: "" }), false, "空值默认关");
  assert.equal(isFigureTextToPathEnabled({ [FIGURE_TEXT_TO_PATH_ENV]: "1" }), true);
  assert.equal(isFigureTextToPathEnabled({ [FIGURE_TEXT_TO_PATH_ENV]: "true" }), true);
  assert.equal(isFigureTextToPathEnabled({ [FIGURE_TEXT_TO_PATH_ENV]: " TRUE " }), true);
  assert.equal(isFigureTextToPathEnabled({ [FIGURE_TEXT_TO_PATH_ENV]: "on" }), true);
  assert.equal(isFigureTextToPathEnabled({ [FIGURE_TEXT_TO_PATH_ENV]: "0" }), false);
  assert.equal(isFigureTextToPathEnabled({ [FIGURE_TEXT_TO_PATH_ENV]: "yes" }), false, "无法识别的值回落默认关");
  assert.equal(isSvgTarget("a/b/FIG-1.SVG"), true);
  assert.equal(isSvgTarget("fig.png"), false);
});

test("成功路径：产物校验通过后原子换入原路径（无临时文件残留）", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    const product = writeProduct(binDir, "product.svg", OUTLINED_SVG);
    const fake = writeFakeInkscape(binDir, "inkscape-ok", [`cp ${JSON.stringify(product)} "$out"`, "exit 0"]);
    const result = await exportSvgTextToPath({ path: ws.svgPath, cmd: fake });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(readFileSync(ws.svgPath, "utf8"), OUTLINED_SVG, "原路径应被换入产物");
    assert.ok(!readFileSync(ws.svgPath, "utf8").includes("<text>"), "产物不得再含 <text>");
    if (result.ok) {
      assert.equal(result.bytesBefore, Buffer.byteLength(ORIGINAL_SVG, "utf8"));
      assert.equal(result.bytesAfter, Buffer.byteLength(OUTLINED_SVG, "utf8"));
    }
    assert.deepEqual(
      readdirSync(ws.dir).filter(name => name.includes(".tmp-")),
      [],
      "原子写回的临时文件应已 rename，不留残渣",
    );
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("产物仍含 <text>：判失败且原文件逐字节不变", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    const stillText = writeProduct(binDir, "still-text.svg", ORIGINAL_SVG);
    const fake = writeFakeInkscape(binDir, "inkscape-text", [`cp ${JSON.stringify(stillText)} "$out"`, "exit 0"]);
    const result = await exportSvgTextToPath({ path: ws.svgPath, cmd: fake });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "render_failed");
      assert.equal(result.reason, "text_remains");
      assert.match(result.error, /仍含 <text>/u);
    }
    assert.equal(readFileSync(ws.svgPath, "utf8"), ORIGINAL_SVG, "被拒时原文件必须逐字节不变");
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("产物未过安全门（DOCTYPE）：判失败且原文件不变", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    const unsafe = writeProduct(
      binDir,
      "unsafe.svg",
      `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${OUTLINED_SVG}`,
    );
    const fake = writeFakeInkscape(binDir, "inkscape-unsafe", [`cp ${JSON.stringify(unsafe)} "$out"`, "exit 0"]);
    const result = await exportSvgTextToPath({ path: ws.svgPath, cmd: fake });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "unsafe_product");
      assert.match(result.error, /DOCTYPE/u);
    }
    assert.equal(readFileSync(ws.svgPath, "utf8"), ORIGINAL_SVG);
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("几何守卫：墨迹越界即拒收，原文件不变", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    // 画布未变、矩形未变，但多出一条跑到画布右侧（x=95..110，远超 70 + 1.6mm 容差）的轮廓。
    const drifted = OUTLINED_SVG.replace("</svg>", '<path d="M95 35 L110 39" stroke="#000000" fill="none"/></svg>');
    const product = writeProduct(binDir, "drifted.svg", drifted);
    const fake = writeFakeInkscape(binDir, "inkscape-drift", [`cp ${JSON.stringify(product)} "$out"`, "exit 0"]);
    const result = await exportSvgTextToPath({ path: ws.svgPath, cmd: fake });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "geometry_regression");
      assert.match(result.error, /墨迹范围/u);
    }
    assert.equal(readFileSync(ws.svgPath, "utf8"), ORIGINAL_SVG);
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("几何守卫：画布（viewBox/宽高）被改写即拒收，原文件不变", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    const rescaled = OUTLINED_SVG.replace(
      'width="80mm" height="40mm" viewBox="0 0 80 40"',
      'width="160mm" height="80mm" viewBox="0 0 160 80"',
    );
    const product = writeProduct(binDir, "rescaled.svg", rescaled);
    const fake = writeFakeInkscape(binDir, "inkscape-canvas", [`cp ${JSON.stringify(product)} "$out"`, "exit 0"]);
    const result = await exportSvgTextToPath({ path: ws.svgPath, cmd: fake });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "geometry_regression");
      assert.match(result.error, /viewBox/u);
    }
    assert.equal(readFileSync(ws.svgPath, "utf8"), ORIGINAL_SVG);
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("checkOutlineGeometry：几何一致放行、向内收缩放行、向外越界拒收", () => {
  assert.equal(checkOutlineGeometry(ORIGINAL_SVG, OUTLINED_SVG), undefined, "同画布同范围应放行");
  const smaller = OUTLINED_SVG.replace("M33.5 19 L46.5 19 L46.5 25.5 L33.5 25.5 Z", "M36 21 L44 21 L44 24 L36 24 Z");
  assert.equal(checkOutlineGeometry(ORIGINAL_SVG, smaller), undefined, "字形轮廓比占位框小属正常");
  const outside = OUTLINED_SVG.replace("</svg>", '<path d="M10 10 L95 10" stroke="#000000"/></svg>');
  assert.match(checkOutlineGeometry(ORIGINAL_SVG, outside) ?? "", /超出原图/u);
});

test("非 SVG 目标：显式报「未生效」且不启动任何进程", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    const pngPath = join(ws.dir, "fig.png");
    writeFileSync(pngPath, "not-an-svg", "utf8");
    const sentinel = join(ws.dir, "ran");
    const fake = writeFakeInkscape(binDir, "inkscape-sentinel", [`touch ${JSON.stringify(sentinel)}`, "exit 0"]);
    const result = await exportSvgTextToPath({ path: pngPath, cmd: fake });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "unsupported_target");
      assert.equal(result.reason, "not_applicable");
      assert.match(result.error, /未生效/u);
    }
    assert.equal(existsSync(sentinel), false, "非 SVG 目标不应启动 Inkscape");
    assert.equal(readFileSync(pngPath, "utf8"), "not-an-svg");
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("二进制缺失：覆盖值不存在→invalid_cmd，探测落空→not_installed（均带安装指引）", async () => {
  const ws = makeWorkspace();
  try {
    const missing = join(tmpdir(), "sati-no-such-inkscape-binary");

    const invalid = await exportSvgTextToPath({ path: ws.svgPath, env: { [INKSCAPE_CMD_ENV]: missing } });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.code, "setup_required");
      assert.equal(invalid.reason, "invalid_cmd");
      assert.match(invalid.error, /指向的文件不存在/u);
      assert.match(invalid.installHint ?? "", /brew install --cask inkscape/u);
      assert.match(invalid.installHint ?? "", new RegExp(INKSCAPE_CMD_ENV, "u"));
    }

    // exists 注入为恒假：本用例不依赖宿主是否真的装了 Inkscape（候选路径在别的机器上可能存在）。
    const notInstalled = await exportSvgTextToPath({ path: ws.svgPath, env: { PATH: "" }, exists: () => false });
    assert.equal(notInstalled.ok, false);
    if (!notInstalled.ok) {
      assert.equal(notInstalled.code, "setup_required");
      assert.equal(notInstalled.reason, "not_installed");
      assert.match(notInstalled.installHint ?? "", /Inkscape/u);
    }

    // 直接传一个不存在的可执行路径：spawn 失败也是结构化错误，不是静默降级。
    const spawnFailed = await exportSvgTextToPath({ path: ws.svgPath, cmd: missing });
    assert.equal(spawnFailed.ok, false);
    if (!spawnFailed.ok) {
      assert.equal(spawnFailed.code, "render_failed");
      assert.equal(spawnFailed.reason, "spawn_failed");
      assert.match(spawnFailed.error, /无法启动 Inkscape/u);
    }
    assert.equal(readFileSync(ws.svgPath, "utf8"), ORIGINAL_SVG, "缺二进制时原文件不得被改动");
  } finally {
    ws.cleanup();
  }
});

test("非零退出码：归为 exit_code 并带上退出码与 stderr 摘录，原文件不变", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    const fake = writeFakeInkscape(binDir, "inkscape-fail", [`printf '%s\\n' 'cannot open input file' >&2`, "exit 3"]);
    const result = await exportSvgTextToPath({ path: ws.svgPath, cmd: fake });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "render_failed");
      assert.equal(result.reason, "exit_code");
      assert.match(result.error, /退出码 3/u);
      assert.match(result.error, /cannot open input file/u);
      assert.equal(result.stderr, "cannot open input file");
    }
    assert.equal(readFileSync(ws.svgPath, "utf8"), ORIGINAL_SVG);
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("退出码 0 但 stderr 有实质输出：判失败（退出码不是成功的充分条件）", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    const product = writeProduct(binDir, "product.svg", OUTLINED_SVG);
    const fake = writeFakeInkscape(binDir, "inkscape-stderr", [
      `cp ${JSON.stringify(product)} "$out"`,
      `printf '%s\\n' 'Inkscape: failed to parse the document' >&2`,
      "exit 0",
    ]);
    const result = await exportSvgTextToPath({ path: ws.svgPath, cmd: fake });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "stderr_output");
      assert.match(result.error, /failed to parse the document/u);
    }
    assert.equal(readFileSync(ws.svgPath, "utf8"), ORIGINAL_SVG);
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("stderr 只有已知环境噪声（Fontconfig/GTK）：不判失败", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    const product = writeProduct(binDir, "product.svg", OUTLINED_SVG);
    const fake = writeFakeInkscape(binDir, "inkscape-noise", [
      `cp ${JSON.stringify(product)} "$out"`,
      `printf '%s\\n' 'Fontconfig warning: "/etc/fonts/fonts.conf", line 5: unknown element' >&2`,
      `printf '%s\\n' '(inkscape:1234): Gtk-WARNING **: cannot open display' >&2`,
      "exit 0",
    ]);
    const result = await exportSvgTextToPath({ path: ws.svgPath, cmd: fake });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(readFileSync(ws.svgPath, "utf8"), OUTLINED_SVG);
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("超时（内部期限）：归为 timeout 并强杀子进程，原文件不变", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    // exec 让 sh 被 sleep 取代：SIGKILL 直接命中 sleep，close 立刻到达（不吊在孙进程的管道上）。
    const fake = writeFakeInkscape(binDir, "inkscape-hang", ["exec sleep 30"]);
    const started = Date.now();
    const result = await exportSvgTextToPath({ path: ws.svgPath, cmd: fake, timeoutMs: 400 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "render_failed");
      assert.equal(result.reason, "timeout");
      assert.match(result.error, /超时（400ms/u);
    }
    assert.ok(Date.now() - started < 10_000, "超时应由期限触发，而不是等 sleep 自然结束");
    assert.equal(readFileSync(ws.svgPath, "utf8"), ORIGINAL_SVG);
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("调用方取消：归为 cancelled（而不是 exit_code/signalled）", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    const fake = writeFakeInkscape(binDir, "inkscape-hang2", ["exec sleep 30"]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      const result = await exportSvgTextToPath({
        path: ws.svgPath,
        cmd: fake,
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "cancelled");
        assert.equal(result.reason, "cancelled");
      }
    } finally {
      clearTimeout(timer);
    }
    assert.equal(readFileSync(ws.svgPath, "utf8"), ORIGINAL_SVG);
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("产物缺失（退出码 0 但不产出）：判失败而非假装成功", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    const fake = writeFakeInkscape(binDir, "inkscape-empty", ["exit 0"]);
    const result = await exportSvgTextToPath({ path: ws.svgPath, cmd: fake });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "missing_product");
      assert.match(result.error, /未生成输出文件/u);
    }
    assert.equal(readFileSync(ws.svgPath, "utf8"), ORIGINAL_SVG);
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("argv 形状：--export-type=svg --export-plain-svg --export-text-to-path + 输入路径", async () => {
  const ws = makeWorkspace();
  const binDir = mkdtempSync(join(tmpdir(), "sati-fake-inkscape-"));
  try {
    // 假脚本把收到的 argv 原样落盘，供断言"文字转路径"的确切命令形状（参数写错即红）。
    const argvLog = join(binDir, "argv.txt");
    const product = writeProduct(binDir, "product.svg", OUTLINED_SVG);
    const fake = writeFakeInkscape(binDir, "inkscape-argv", [
      `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
      `cp ${JSON.stringify(product)} "$out"`,
      "exit 0",
    ]);
    const result = await exportSvgTextToPath({ path: ws.svgPath, cmd: fake });
    assert.equal(result.ok, true, JSON.stringify(result));
    const argv = readFileSync(argvLog, "utf8").trim().split("\n");
    assert.deepEqual(argv.slice(0, 3), ["--export-type=svg", "--export-plain-svg", "--export-text-to-path"]);
    assert.match(argv[3] ?? "", /^--export-filename=.*outlined\.svg$/u);
    assert.equal(argv[4], ws.svgPath, "输入 SVG 作为位置参数传入");
  } finally {
    ws.cleanup();
    rmSync(binDir, { recursive: true, force: true });
  }
});
