#!/usr/bin/env node
/**
 * L2d cold-start (Windows) — Electron first launch with NO sati.yaml (new user path).
 * Uses an isolated temp HOME; does NOT read or write host config.
 *
 * Usage:
 *   PD_APP=C:\...\win-unpacked node scripts/release-l2d-cold-start-win.mjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { _electron as electron } from "playwright";

const appPath = process.env.PD_APP;
if (!appPath) {
  console.error("PD_APP must point to the win-unpacked directory");
  process.exit(2);
}

const execPath = path.join(appPath, "Sati.exe");
if (!fs.existsSync(execPath)) {
  console.error(`Missing executable: ${execPath}`);
  process.exit(2);
}

/**
 * 清理测试实例。Windows 无法按可执行文件路径过滤 taskkill，
 * 只能按 PID 精确杀 —— 用 electronApp.process().pid（测试实例本身），
 * 绝不用 taskkill /IM Sati.exe（会杀掉用户真实运行的 Sati.exe）。
 */
function killPackagedSati(pid) {
  try {
    if (pid) {
      execSync(`taskkill /F /PID ${pid} /T 2>NUL`, { stdio: "ignore", shell: "cmd.exe" });
    } else {
      console.warn("[l2d] no test PID available; skipping orphan kill (won't touch user instances)");
    }
  } catch {
    /* ignore */
  }
}

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "sati-coldstart-"));
const pilotHome = path.join(sandboxHome, ".sati");
fs.mkdirSync(pilotHome, { recursive: true });
// Intentionally no sati.yaml — triggers desktop onboarding.

console.log(`  isolated HOME: ${sandboxHome}`);
console.log(`  (host config is not modified)`);

let electronApp;
try {
  electronApp = await electron.launch({
    executablePath: execPath,
    env: {
      ...process.env,
      HOME: sandboxHome,
      USERPROFILE: sandboxHome,
      SATI_HOME: pilotHome,
      SATI_E2E_MOCK_PROVIDER: "1",
    },
    timeout: 180_000,
  });

  const deadline = Date.now() + 120_000;
  let onboardingPage = null;
  while (Date.now() < deadline) {
    for (const w of electronApp.windows()) {
      const title = await w.title().catch(() => "");
      const url = w.url();
      if (title.includes("初始化") || url.includes("onboarding")) {
        onboardingPage = w;
        break;
      }
    }
    if (onboardingPage) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!onboardingPage) {
    throw new Error("Onboarding window did not appear (expected first-run with empty config)");
  }
  console.log("  ✓ Onboarding window opened");

  await onboardingPage.locator("#base-url").fill("https://api.anthropic.com");
  await onboardingPage.locator("#api-key").fill("sk-smoke-test-not-real");
  await onboardingPage.locator("#model-name").fill("claude-sonnet-4-5-20250929");
  await onboardingPage.locator("#test-btn").click();
  await onboardingPage.waitForSelector(".status.success, .status.info", { timeout: 30_000 });
  await onboardingPage.locator("#save-btn").click();

  const cfgPath = path.join(pilotHome, "sati.yaml");
  const cfgDeadline = Date.now() + 60_000;
  while (Date.now() < cfgDeadline) {
    if (fs.existsSync(cfgPath)) break;
    await new Promise(r => setTimeout(r, 300));
  }
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Config not written under isolated SATI_HOME: ${cfgPath}`);
  }
  const yaml = fs.readFileSync(cfgPath, "utf8");
  if (!yaml.includes("schemaVersion: 1")) {
    throw new Error("Onboarding wrote non-V2 config (missing schemaVersion: 1)");
  }
  if (!yaml.includes("agent:") || !yaml.includes("model:")) {
    throw new Error("Onboarding config missing agent/model sections");
  }
  console.log("  ✓ Onboarding saved V2 sati.yaml in isolated home");

  const mainDeadline = Date.now() + 120_000;
  let mainPage = null;
  while (Date.now() < mainDeadline) {
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
    throw new Error("Main UI window did not load after onboarding");
  }
  await mainPage.waitForSelector('[role="tablist"]', { timeout: 90_000 });
  console.log(`  ✓ Main window after onboarding: ${mainPage.url()}`);
} finally {
  if (electronApp) {
    await electronApp.close().catch(() => {});
    killPackagedSati(electronApp.process()?.pid);
  }
  await new Promise(r => setTimeout(r, 1500));
  try {
    fs.rmSync(sandboxHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* ignore */
  }
}

console.log("\nL2d cold-start Electron PASSED (Windows)");
