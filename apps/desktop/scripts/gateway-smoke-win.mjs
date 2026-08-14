#!/usr/bin/env node
/**
 * Sati Windows L1 gateway smoke — starts the packaged gateway with the same
 * module-resolution wiring the runtime (server-manager.ts) and L2
 * (release-l2-win.mjs) use, then polls /health.
 *
 * The bare extracted tree cannot start the gateway: Windows bsdtar materializes
 * only one junction level, so isolated transitive deps and the
 * edgeclaw-memory-core workspace link are unreachable until the pnpm vstore
 * links are reconstructed (relink-pnpm-win.mjs, run by verify-installer.bat
 * before this script) and the runtime junctions below are created.
 *
 * Usage:
 *   node gateway-smoke-win.mjs <ccmDir> <ccuiDir> <memDir> <nodeExe> <homeDir> <port>
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";

const [ccmDir, ccuiDir, memDir, nodeExe, homeDir, portStr] = process.argv.slice(2);
const port = Number(portStr);

function fail(msg) {
  console.error(`  [FAIL] ${msg}`);
  process.exit(1);
}

function mkJunction(link, target) {
  if (fs.existsSync(link)) return;
  fs.mkdirSync(path.dirname(link), { recursive: true });
  execFileSync("cmd.exe", ["/c", "mklink", "/J", link, target], { stdio: "pipe" });
}

// ── Runtime-equivalent wiring (mirrors release-l2-win.mjs) ──
// 1. edgeclaw-memory-core resolvable from sati-main's node_modules
mkJunction(path.join(ccmDir, "node_modules", "edgeclaw-memory-core"), memDir);

// 2. UI server imports ../../src/* relative paths that expect sandbox/dist and sandbox/src
const distDir = path.join(ccmDir, "dist");
const sandbox = path.dirname(ccmDir);
if (fs.existsSync(distDir)) {
  mkJunction(path.join(sandbox, "dist"), distDir);
  mkJunction(path.join(sandbox, "src"), path.join(distDir, "src"));
}

// 3. memory-core also referenced from sandbox root
mkJunction(path.join(sandbox, "edgeclaw-memory-core"), memDir);

// 4. UI server imports ../../../src/context/memory/edgeclaw-memory-core/...
const memJunction = path.join(distDir, "src", "context", "memory", "edgeclaw-memory-core");
if (fs.existsSync(memJunction) && !fs.lstatSync(memJunction).isSymbolicLink()) {
  fs.rmSync(memJunction, { recursive: true, force: true });
}
mkJunction(memJunction, memDir);

// 5. Hoisted shared deps for the UI server's upward resolution
mkJunction(path.join(sandbox, "node_modules"), path.join(ccmDir, "node_modules"));

// ── Start gateway ──
const gwEntry = path.join(ccmDir, "dist", "src", "cli", "sati.js");
if (!fs.existsSync(gwEntry)) fail(`Gateway entry not found: ${gwEntry}`);

const gwLog = path.join(sandbox, "gateway.log");
const gw = spawn(nodeExe, [gwEntry, "server"], {
  cwd: ccmDir,
  env: {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    SATI_HOME: path.join(homeDir, ".sati"),
    SATI_GATEWAY_PORT: String(port),
    NO_COLOR: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
gw.stdout.pipe(fs.createWriteStream(gwLog, { flags: "a" }));
gw.stderr.pipe(fs.createWriteStream(gwLog, { flags: "a" }));

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let data = "";
      res.on("data", d => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function waitForHealth(url, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await httpGet(url);
      if (r.status === 200) return true;
    } catch {
      /* retry */
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

console.log(`  Starting Gateway on port ${port}...`);
const healthy = await waitForHealth(`http://127.0.0.1:${port}/health`, 120000);
if (!healthy) {
  console.error("  [FAIL] Gateway did not respond within 120s");
  console.error("  Last lines of gateway log:");
  try {
    const tail = fs.readFileSync(gwLog, "utf8").split("\n").slice(-12).join("\n");
    console.error(tail);
  } catch {
    /* no log */
  }
  gw.kill();
  process.exit(1);
}
console.log("  [PASS] Gateway healthy");
gw.kill();
process.exit(0);
