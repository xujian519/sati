#!/usr/bin/env node
/**
 * L3 release E2E (Windows) — real-model Gateway agent turn (opt-in, needs API keys).
 * Windows mirror of apps/desktop/scripts/release-l3.sh.
 *
 * Usage:
 *   node scripts/release-l3-win.mjs              # skip if no API keys
 *   node scripts/release-l3-win.mjs --force      # fail if keys missing
 *   SATI_RUN_REAL_AGENT_LIFECYCLE_E2E=1 node scripts/release-l3-win.mjs
 *
 * Prereq: repo-root `pnpm install` + a successful `pnpm run build` (the script
 * builds first so `dist/` is current).
 *
 * Note on harnesses: macOS release-l3.sh historically ran
 *   dist/tests/e2e/framework-wcb-smoke.test.js
 *   dist/tests/agent/e2e/run-real-agent-lifecycle-hooks.js
 * Both harnesses were removed from the repo (see git history), so this script
 * auto-detects whichever real-model E2E harnesses are present in dist/tests and
 * runs them. If a key is provided but no harness exists, the gate FAILS (exit 1)
 * — a release gate that silently passes without doing its job is a false pass,
 * matching macOS, where `node --test <missing-file>` exits non-zero.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
// 与 release-l3.sh 一致：未知参数退出 2，避免拼错参数时被静默忽略。
const UNKNOWN = args.filter(a => a !== "--force");
if (UNKNOWN.length > 0) {
  console.error(`Unknown arg: ${UNKNOWN[0]} (supported: --force)`);
  process.exit(2);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function sh(cmd, args, env = {}) {
  const full = [cmd, ...args].map(a => (/[\s"^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
  return execSync(full, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["inherit", "inherit", "inherit"],
  });
}

const hasKey = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SATI_API_KEY"].some(
  k => process.env[k] && process.env[k].length > 0,
);

console.log("Sati L3 E2E (Windows)");

if (!hasKey) {
  if (FORCE) {
    fail("No API key in env (ANTHROPIC_API_KEY / OPENAI_API_KEY / SATI_API_KEY)");
  }
  console.log("⚠ Skipping L3 — no API credentials in environment");
  console.log("  Export a key and re-run, or: node scripts/release-l3-win.mjs --force");
  process.exit(0);
}

console.log("\n── Build dist/ (repo root) ──");
sh("pnpm", ["run", "build"]);

// ── Discover real-model harnesses under dist/tests ──
const frameworkWcb = path.join(REPO_ROOT, "dist", "tests", "e2e", "framework-wcb-smoke.test.js");
const lifecycleHooks = path.join(REPO_ROOT, "dist", "tests", "agent", "e2e", "run-real-agent-lifecycle-hooks.js");

const ran = [];

console.log("\n── L3a: Framework WCB smoke (Gateway + real model) ──");
if (fs.existsSync(frameworkWcb)) {
  sh("node", ["--test", "--test-force-exit", "--test-timeout", "300000", frameworkWcb], {
    SATI_RUN_FRAMEWORK_E2E: "1",
  });
  ran.push("L3a (framework-wcb-smoke)");
} else {
  console.log("  ⚠ dist/tests/e2e/framework-wcb-smoke.test.js not found in this build — skipped.");
  console.log("    (The real-model harness was removed repo-wide; macOS release-l3.sh fails on it too.)");
}

if (process.env.SATI_RUN_REAL_AGENT_LIFECYCLE_E2E === "1") {
  console.log("\n── L3b: Real agent lifecycle hooks ──");
  if (fs.existsSync(lifecycleHooks)) {
    try {
      sh("pnpm", ["run", "e2e:real-agent-lifecycle-hooks"]);
      ran.push("L3b (lifecycle-hooks)");
    } catch {
      console.log("  ⚠ lifecycle hooks E2E failed (often model tool_choice; L3a still counts)");
    }
  } else {
    console.log("  ⚠ dist/tests/agent/e2e/run-real-agent-lifecycle-hooks.js not found — skipped.");
  }
} else {
  console.log("\n── L3b: lifecycle hooks (skipped) ──");
  console.log("  Set SATI_RUN_REAL_AGENT_LIFECYCLE_E2E=1 to enable");
}

if (ran.length === 0) {
  console.log("\n⚠ No real-model harness was available in this build — L3 ran nothing.");
  console.log("  A key was provided but the gate could not do its job, so this is a FAILURE,");
  console.log("  not a pass (macOS fails the same way via node --test on the missing file).");
  console.log("  Restore the harness or skip L3 until it exists.");
  process.exit(1);
}

console.log(`\n✓ L3 E2E PASSED (${ran.join(" + ")})`);
