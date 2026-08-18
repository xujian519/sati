#!/usr/bin/env node
// export-html.mjs
// Sati HTML 交付物导出工具。
//
// 用法：
//   node scripts/export-html.mjs wechat <input.html> [output.html]
//   node scripts/export-html.mjs png <input.html> [output.png] [--width W --height H]
//   node scripts/export-html.mjs pdf <input.html> [output.pdf]
//   node scripts/export-html.mjs zhihu <input.html> [output.html]
//   node scripts/export-html.mjs check <input.html>
//   node scripts/export-html.mjs --help
//
// 说明：
// - wechat 需要 juice；如未安装请先 `pnpm add juice`。
// - png/pdf 需要系统 Chrome/Chromium；长页面 PNG 不保证 full-page，推荐 PDF。
// - 输出路径拒绝路径穿越，且不允许写入文件系统根目录。

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHROME_CANDIDATES = [
  process.env.SATI_CHROME_PATH || process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find(path => existsSync(path));
}

function chromeUserDataDir() {
  return mkdtempSync(join(tmpdir(), "sati-chrome-"));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function safeOutputPath(output) {
  const raw = String(output).trim();
  if (raw.split(/[\\/]+/).includes("..")) {
    fail(`Refusing path traversal in output: ${output}`);
  }
  const abs = resolve(raw);
  if (abs === sep || /^[A-Za-z]:[\\/]?$/.test(abs)) {
    fail(`Refusing filesystem root as output: ${output}`);
  }
  return abs;
}

function readInput(input) {
  const abs = resolve(input);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    fail(`Input file not found: ${input}`);
  }
  return abs;
}

async function exportWechat(input, output) {
  const { default: juice } = await import("juice");
  const html = readFileSync(input, "utf8");
  const inlined = juice(html, { preserveMediaQueries: true, applyStyleTags: true, removeStyleTags: false });
  const out = output ?? input.replace(extname(input), "-wechat.html");
  const abs = safeOutputPath(out);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, inlined, "utf8");
  console.log(`WeChat HTML: ${abs}`);
}

function chromeFlags(args) {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return ["--no-sandbox", "--disable-setuid-sandbox", ...args];
  }
  return args;
}

async function exportPng(input, output, width, height) {
  const chrome = findChrome();
  if (!chrome) fail("Chrome/Chromium not found (set SATI_CHROME_PATH or CHROME_PATH)");
  const out = output ?? input.replace(extname(input), ".png");
  const abs = safeOutputPath(out);
  mkdirSync(dirname(abs), { recursive: true });
  const flags = [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    `--user-data-dir=${chromeUserDataDir()}`,
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=5000",
    "--force-device-scale-factor=2",
  ];
  if (width && height) flags.push(`--window-size=${width},${height}`);
  flags.push(`--screenshot=${abs}`, `file://${resolve(input)}`);
  await execFileAsync(chrome, chromeFlags(flags), { timeout: 120000 });
  if (!existsSync(abs)) fail("Chrome did not create PNG");
  console.log(`PNG: ${abs}`);
}

async function exportPdf(input, output) {
  const chrome = findChrome();
  if (!chrome) fail("Chrome/Chromium not found (set SATI_CHROME_PATH or CHROME_PATH)");
  const out = output ?? input.replace(extname(input), ".pdf");
  const abs = safeOutputPath(out);
  mkdirSync(dirname(abs), { recursive: true });
  const flags = [
    "--headless",
    "--disable-gpu",
    `--user-data-dir=${chromeUserDataDir()}`,
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=5000",
    "--print-to-pdf-no-header",
    `--print-to-pdf=${abs}`,
    `file://${resolve(input)}`,
  ];
  await execFileAsync(chrome, chromeFlags(flags), { timeout: 120000 });
  if (!existsSync(abs)) fail("Chrome did not create PDF");
  console.log(`PDF: ${abs}`);
}

function exportZhihu(input, output) {
  let html = readFileSync(input, "utf8");
  html = html.replace(/<mjx-container[^>]*>([\s\S]*?)<\/mjx-container>/gi, (_m, inner) => {
    const encoded = Buffer.from(inner.replace(/<[^>]*>/g, "")).toString("base64");
    return `<span data-eeimg="1" data-formula="${encoded}"></span>`;
  });
  const out = output ?? input.replace(extname(input), "-zhihu.html");
  const abs = safeOutputPath(out);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, html, "utf8");
  console.log(`Zhihu HTML: ${abs}`);
}

function checkSingle(input) {
  execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "check-html-templates.mjs"), resolve(input)], {
    stdio: "inherit",
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  node scripts/export-html.mjs wechat <input.html> [output.html]
  node scripts/export-html.mjs png <input.html> [output.png] [--width W --height H]
  node scripts/export-html.mjs pdf <input.html> [output.pdf]
  node scripts/export-html.mjs zhihu <input.html> [output.html]
  node scripts/export-html.mjs check <input.html>
`);
    return;
  }
  const [command, input, ...rest] = args;
  const absInput = readInput(input);
  if (command === "wechat") {
    exportWechat(absInput, rest[0]).catch(e => fail(`wechat failed: ${e.message}`));
  } else if (command === "png") {
    const widthIdx = rest.indexOf("--width");
    const heightIdx = rest.indexOf("--height");
    const width = widthIdx >= 0 ? rest[widthIdx + 1] : undefined;
    const height = heightIdx >= 0 ? rest[heightIdx + 1] : undefined;
    const out = rest.find(arg => !arg.startsWith("--"));
    exportPng(absInput, out, width, height).catch(e => fail(`png failed: ${e.message}`));
  } else if (command === "pdf") {
    exportPdf(absInput, rest[0]).catch(e => fail(`pdf failed: ${e.message}`));
  } else if (command === "zhihu") {
    exportZhihu(absInput, rest[0]);
  } else if (command === "check") {
    checkSingle(absInput);
  } else {
    fail(`Unknown command: ${command}`);
  }
}

main();
