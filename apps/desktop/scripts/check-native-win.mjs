#!/usr/bin/env node
/**
 * Sati Windows native-deps preflight — replaces the old build step 4b
 * (`npm rebuild better-sqlite3 sharp node-pty mupdf`).
 *
 * Why: every module ships an ABI-correct prebuilt binary for the bundled Node
 * runtime, so a node-gyp rebuild is pure waste (5-15 min per build, requires
 * MSVC Build Tools, and silently degrades to a warning when MSVC is absent):
 *   - better-sqlite3@13: prebuilds/win32-x64.node shipped in the npm package
 *     (FTS5 included — verified: CREATE VIRTUAL TABLE ... USING fts5 + MATCH)
 *   - node-pty@1.1: prebuilds/win32-x64/pty.node shipped in the npm package
 *   - sharp@0.35: binary via the @img/sharp-* optional dependency
 *   - mupdf@1.28: pure WASM (dist/*.wasm), ESM-only (dynamic import required)
 *
 * This check loads each module with the *bundled* Node (see build-win.bat)
 * from the workspace tree the runtime will use, and fails fast if any
 * assumption breaks. Exit 1 only for runtime-critical modules
 * (better-sqlite3, sharp); node-pty / mupdf failures print a warning and exit 0.
 *
 * Usage (from repo root):
 *   "%RESOURCES%\node-bin\node.exe" apps\desktop\scripts\check-native-win.mjs
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const UI_DIR = path.join(REPO_ROOT, "ui");

// Resolve like the packaged app does: sharp/mupdf are root deps,
// better-sqlite3/node-pty are ui deps.
const rootRequire = createRequire(path.join(REPO_ROOT, "package.json"));
const uiRequire = createRequire(path.join(UI_DIR, "package.json"));

const HARD_FAIL = new Set(["better-sqlite3", "sharp"]);
const results = [];

function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "[PASS]" : "[FAIL]"} ${name} — ${detail}`);
}

async function checkBetterSqlite3() {
  const sqlite = uiRequire("better-sqlite3");
  const db = new sqlite(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
  db.prepare("INSERT INTO t (x) VALUES (?)").run("hello");
  const row = db.prepare("SELECT x FROM t WHERE t MATCH ?").get("hello");
  if (!row) throw new Error("fts5 MATCH returned no row");
  db.close();
}

async function checkNodePty() {
  const pty = uiRequire("node-pty");
  if (typeof pty.spawn !== "function") throw new Error("spawn is not a function");
}

async function checkSharp() {
  const sharp = rootRequire("sharp");
  const buf = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  if (!buf || buf.length === 0) throw new Error("png render returned empty buffer");
}

async function checkMupdf() {
  const mod = await import(pathToFileURL(rootRequire.resolve("mupdf")));
  if (!mod || typeof mod.default !== "object") throw new Error("default export is not an object");
}

async function main() {
  console.log("Sati Windows native-deps preflight (bundled Node)");
  const checks = [
    ["better-sqlite3", checkBetterSqlite3],
    ["sharp", checkSharp],
    ["node-pty", checkNodePty],
    ["mupdf", checkMupdf],
  ];
  for (const [name, fn] of checks) {
    try {
      await fn();
      report(name, true, "loads OK");
    } catch (err) {
      report(name, false, err.message);
    }
  }

  const hardFails = results.filter(r => !r.ok && HARD_FAIL.has(r.name));
  if (hardFails.length > 0) {
    console.error(
      `\nERROR: runtime-critical native module(s) failed to load under the bundled Node: ` +
        hardFails.map(r => r.name).join(", ") +
        ".\n  Fix: re-run 'pnpm install' with scripts enabled, or bump pnpm-lock.yaml.",
    );
    process.exit(1);
  }
  const softFails = results.filter(r => !r.ok);
  if (softFails.length > 0) {
    console.warn(
      `\nWARN: non-critical native module(s) failed to load: ${softFails.map(r => r.name).join(", ")} — continuing.`,
    );
  }
  console.log("\nOK: native deps preflight passed");
}

await main();
