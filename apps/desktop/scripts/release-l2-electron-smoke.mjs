#!/usr/bin/env node
/**
 * L2 Electron smoke — launches packaged Sati.app with an isolated SATI_HOME
 * and stub V2 config, then asserts the main window loads the local UI URL.
 *
 * Requires display (macOS GUI). Skip in headless CI with PD_SKIP_ELECTRON=1.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron } from "playwright";

const appPath = process.env.PD_APP;
if (!appPath) {
  console.error("PD_APP must point to Sati.app");
  process.exit(2);
}

const execPath = path.join(appPath, "Contents/MacOS/Sati");
if (!fs.existsSync(execPath)) {
  console.error(`Missing executable: ${execPath}`);
  process.exit(2);
}

/**
 * 清理测试实例。按 execPath 精确匹配（测试 app 的完整路径），
 * 不用宽泛的 "Sati.app/Contents/MacOS/Sati" 模式 —— 后者会
 * 误杀用户真实安装的 /Applications/Sati.app。
 */
function killPackagedSati() {
  try {
    execSync(`pkill -f "${execPath}" 2>/dev/null || true`, {
      stdio: "ignore",
    });
  } catch {
    /* ignore */
  }
}

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "sati-e2e-home-"));
const pilotHome = path.join(sandboxHome, ".sati");
fs.mkdirSync(pilotHome, { recursive: true });

const stubYaml = `schemaVersion: 1
agent:
  model: sati/claude-sonnet-4-5-20250929
model:
  providers:
    sati:
      protocol: anthropic
      url: "https://api.anthropic.com"
      apiKey: "smoke-test-not-real"
      models:
        claude-sonnet-4-5-20250929: {}
`;
fs.writeFileSync(path.join(pilotHome, "sati.yaml"), stubYaml, { mode: 0o600 });

let electronApp;
try {
  electronApp = await electron.launch({
    executablePath: execPath,
    env: {
      ...process.env,
      HOME: sandboxHome,
      SATI_HOME: pilotHome,
      SATI_E2E: "1",
    },
    timeout: 120_000,
  });

  const deadline = Date.now() + 120_000;
  let mainPage = null;
  while (Date.now() < deadline) {
    for (const w of electronApp.windows()) {
      const url = w.url();
      if (url.includes("127.0.0.1")) {
        mainPage = w;
        break;
      }
    }
    if (mainPage) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!mainPage) {
    const urls = electronApp.windows().map(w => w.url());
    throw new Error(`Main UI window did not appear within 120s (windows: ${urls.join(", ") || "none"})`);
  }
  await mainPage.waitForLoadState("domcontentloaded", { timeout: 60_000 });
  console.log(`  ✓ Electron main window loaded: ${mainPage.url()}`);

  await mainPage.waitForSelector('[role="tablist"]', { timeout: 90_000 });
  console.log("  ✓ Main shell tablist visible");
} finally {
  if (electronApp) await electronApp.close().catch(() => {});
  killPackagedSati();
  await new Promise(r => setTimeout(r, 1500));
  try {
    fs.rmSync(sandboxHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* ignore cleanup races */
  }
}

console.log("\nL2 Electron smoke PASSED");
