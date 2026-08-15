/**
 * PDF 渲染：调用系统 Chrome / Chromium 无头打印。
 *
 * 设计原则：不引入 puppeteer/playwright 等重型依赖；优先复用用户已安装的
 * Chrome / Chromium / Edge，找不到时返回 undefined 让工具回退 HTML-only。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 候选 Chrome 可执行路径（macOS / Linux / Windows）。 */
const CHROME_CANDIDATES: string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** 返回可用的 Chrome 可执行路径，找不到返回 undefined。 */
export function findChrome(): string | undefined {
  const env = process.env.SATI_CHROME_PATH ?? process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Chrome 沙箱标志：仅在 root 环境（Linux 容器/CI）下禁用沙箱；
 * 普通桌面用户保持沙箱开启，避免无谓降低 Chrome 安全姿态。
 */
function sandboxFlags(): string[] {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return ["--no-sandbox", "--disable-setuid-sandbox"];
  }
  return [];
}

/** 调用 headless Chrome 将 HTML 打印为 PDF。 */
export async function renderPdf(
  htmlPath: string,
  pdfPath: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const chrome = findChrome();
  if (chrome === undefined) {
    return { ok: false, error: "未找到 Chrome/Chromium 可执行文件（可设置 SATI_CHROME_PATH）" };
  }

  const args = [
    "--headless",
    "--disable-gpu",
    ...sandboxFlags(),
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=5000",
    "--print-to-pdf-no-header",
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];

  try {
    // Chrome 在 Windows 上返回的是 chrome.exe 而非目录，dirname 可能为空。
    const cwd = dirname(chrome) || undefined;
    await execFileAsync(chrome, args, { cwd, timeout: 120_000 });
    if (!existsSync(pdfPath)) {
      return { ok: false, error: `Chrome 未生成 PDF: ${pdfPath}` };
    }
    return { ok: true, path: pdfPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Chrome PDF 打印失败: ${message}` };
  }
}
