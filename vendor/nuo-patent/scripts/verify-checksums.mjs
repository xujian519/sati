#!/usr/bin/env node
/**
 * nuo-patent vendor checksum 审计（P3-03）：
 *   node scripts/verify-checksums.mjs           # 校验（postinstall 入口）
 *   node scripts/verify-checksums.mjs generate  # 重新生成 checksums.sha256
 *
 * 校验 vendor/nuo-patent/dist/** 与 checksums.sha256 逐文件 SHA-256 对比，
 * 不匹配/缺失/多余即 exit 1（pnpm install 失败），防预构建产物被意外篡改。
 * 上游来源见 SOURCE_COMMIT；dist 由上游仓库预构建，install 时不会重生成。
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(pkgRoot, "dist");
const manifestPath = join(pkgRoot, "checksums.sha256");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function generate() {
  const files = (await walk(distRoot)).sort();
  const lines = [];
  for (const file of files) {
    lines.push(`${await sha256(file)}  ${relative(pkgRoot, file)}`);
  }
  await writeFile(manifestPath, lines.join("\n") + "\n");
  console.log(`checksums.sha256 updated: ${files.length} files under dist/`);
}

async function verify() {
  const expected = new Map();
  for (const line of (await readFile(manifestPath, "utf8")).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [hash, ...rest] = trimmed.split(/\s+/);
    expected.set(rest.join(" "), hash);
  }
  const actual = new Map();
  for (const file of await walk(distRoot)) {
    actual.set(relative(pkgRoot, file), await sha256(file));
  }
  const errors = [];
  for (const [rel, hash] of expected) {
    const actualHash = actual.get(rel);
    if (actualHash === undefined) errors.push(`MISSING  ${rel}`);
    else if (actualHash !== hash) errors.push(`MISMATCH ${rel}`);
  }
  for (const rel of actual.keys()) {
    if (!expected.has(rel)) errors.push(`EXTRA    ${rel}`);
  }
  if (errors.length > 0) {
    console.error(`nuo-patent checksum verification failed (${errors.length} issue(s)):`);
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      "The vendored dist/ was modified unexpectedly; restore it from git, or run `node scripts/verify-checksums.mjs generate` only if the change is intentional.",
    );
    process.exit(1);
  }
  console.log(`nuo-patent checksum OK (${expected.size} files)`);
}

const mode = process.argv[2] ?? "verify";
if (mode === "generate") {
  await generate();
} else if (mode === "verify") {
  await verify();
} else {
  console.error(`unknown mode: ${mode} (use generate|verify)`);
  process.exit(1);
}
