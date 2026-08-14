#!/usr/bin/env node
/**
 * Sati Windows installer publisher — uploads built NSIS installers to a
 * GitHub Release. Mirror of the publish section of apps/desktop/scripts/
 * release.sh, for the Windows side (no bash there).
 *
 * Usage:
 *   node scripts/publish-win.mjs [dist-electron-dir]
 *     (default dist-electron-dir: apps/desktop/dist-electron)
 *
 * Prereqs:
 *   - gh CLI installed + authenticated (`gh auth status`)
 *   - Built installers in dist-electron/ (from build-win.bat)
 *
 * Steps: collect Sati-<version>-win-<x64|arm64>.exe → min-size check → read
 * CHANGELOG.md notes → create/update GitHub Release → upload exes +
 * Sati-latest-win-*.exe permalink copies (byte + SHA256 verified) → verify
 * remote sizes via GitHub API.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "../..");

const distDir = path.resolve(process.argv[2] || path.join(DESKTOP_DIR, "dist-electron"));

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ── Pre-flight: gh CLI ──
console.log("Sati Windows publisher");
try {
  sh("gh", ["--version"]);
} catch {
  fail("gh CLI not found. Install: winget install GitHub.cli  (https://cli.github.com/)");
}
try {
  sh("gh", ["auth", "status"]);
} catch {
  fail("gh CLI not authenticated. Run: gh auth login");
}

// ── Version: desktop package.json is the single source of truth ──
const desktopPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, "package.json"), "utf8"));
const version = desktopPkg.version;
const tag = `v${version}`;
console.log(`  Version: ${tag}`);

// ── Version lockstep (mirrors release.sh pre-flight) ──
// Gateway hello frames, the MCP client identity and the TUI header read the
// repo-root package.json; a mismatch makes installed desktop version diverge
// from the reported internal version. Use `node scripts/bump-version.mjs`.
const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const uiPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "ui", "package.json"), "utf8"));
if (rootPkg.version !== version) {
  fail(
    `Repo-root package.json version (${rootPkg.version}) != desktop version (${version}).\n` +
      "  Keep versions in lockstep: run 'node scripts/bump-version.mjs' from the repo root.",
  );
}
if (uiPkg.version !== version) {
  fail(
    `ui/package.json version (${uiPkg.version}) != desktop version (${version}).\n` +
      "  Keep versions in lockstep: run 'node scripts/bump-version.mjs' from the repo root.",
  );
}

// ── Git provenance gate (mirrors release.sh pre-flight) ──
// A published installer without a corresponding git tag is untraceable — when a
// user reports a bug you can't check out the code that built their binary.
// Escape hatches match release.sh: ALLOW_UNTAGGED=1 skips the tag check,
// ALLOW_NON_MAIN_SIGNED=1 allows publishing from a non-main branch.
function git(args) {
  try {
    return sh("git", ["-C", REPO_ROOT, ...args]);
  } catch {
    return null;
  }
}

const gitSha = git(["rev-parse", "--short", "HEAD"]);
if (gitSha === null) {
  console.log("  ⚠ Not a git checkout — skipping tag/branch checks");
} else {
  const gitFullSha = git(["rev-parse", "HEAD"]);
  const tagSha = git(["rev-parse", `${tag}^{commit}`]);
  if (tagSha === null || tagSha !== gitFullSha) {
    if (process.env.ALLOW_UNTAGGED !== "1") {
      fail(
        `git tag '${tag}' does not point at HEAD (${gitSha}).\n` +
          "  Tag the release commit first: git tag -a " +
          tag +
          ` -m "release(desktop): v${version}"\n` +
          "  Local testing can bypass with: ALLOW_UNTAGGED=1 node scripts/publish-win.mjs",
      );
    }
    console.log(`  ⚠ tag '${tag}' ≠ HEAD (ALLOW_UNTAGGED=1) — publishing anyway`);
  } else {
    console.log(`  git tag: ${tag} → HEAD (${gitSha})`);
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && !["main", "master", "release"].includes(branch)) {
    if (process.env.ALLOW_NON_MAIN_SIGNED !== "1") {
      fail(
        `Publishing from non-release branch '${branch}'.\n` +
          "  Official releases should come from main/master/release.\n" +
          "  Hotfix 强制覆盖: ALLOW_NON_MAIN_SIGNED=1 node scripts/publish-win.mjs",
      );
    }
    console.log(`  ⚠ publishing from branch '${branch}' (ALLOW_NON_MAIN_SIGNED=1)`);
  } else if (branch) {
    console.log(`  Branch: ${branch}`);
  }
}

// ── Collect installers ──
// 只收当前版本的 per-arch 安装包（Sati-<version>-win-<x64|arm64>.exe）。宽松的
// `Sati-.*-win-.*\.exe` 会把旧配置时代遗留的无架构后缀 `Sati-<ver>-win.exe`
// （曾出现 830MB 的过期产物）和目录里残留的旧版本安装包一起收进来上传到新
// release；build-win.bat 会在构建前清理无架构后缀遗留，这里再严格卡一道。
const exes = fs
  .readdirSync(distDir)
  .filter(f => new RegExp(`^Sati-${version}-win-(x64|arm64)\\.exe$`).test(f))
  .map(f => path.join(distDir, f));
if (exes.length === 0) {
  fail(`No Sati-${version}-win-<x64|arm64>.exe found in ${distDir}`);
}

const MIN_INSTALLER_BYTES = 100_000_000; // mirrors release.sh pd_release_assert_min_installer_size
for (const exe of exes) {
  const size = fs.statSync(exe).size;
  if (size < MIN_INSTALLER_BYTES) {
    fail(`Installer looks truncated (${size} < ${MIN_INSTALLER_BYTES} bytes): ${path.basename(exe)}`);
  }
  console.log(`  Installer: ${path.basename(exe)} (${(size / 1e6).toFixed(1)}MB)`);
}

// ── Release notes from CHANGELOG.md (same extraction as release.sh) ──
let notes = null;
const changelog = path.join(REPO_ROOT, "CHANGELOG.md");
if (fs.existsSync(changelog)) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = fs.readFileSync(changelog, "utf8").match(new RegExp(`## v${escaped}([\\s\\S]*?)(?:^## |\\z)`, "m"));
  if (match && match[1]) notes = match[1].trim();
}
if (!notes) {
  notes = `Sati Desktop ${tag}\n\nWindows installer build.`;
}

// ── GitHub repo slug from origin remote ──
let repoSlug = null;
try {
  const remote = sh("git", ["-C", REPO_ROOT, "remote", "get-url", "origin"]);
  const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (m) repoSlug = m[1];
} catch {
  /* fall through */
}
if (!repoSlug) fail("Could not determine GitHub repo slug from 'git remote get-url origin'");

// ── Permalink copies (Sati-latest-win-*.exe, byte + SHA256 identical) ──
const permalinks = [];
for (const exe of exes) {
  const base = path.basename(exe);
  const latestName = base.replace(`Sati-${version}-`, "Sati-latest-");
  if (latestName === base) continue;
  const dst = path.join(distDir, latestName);
  fs.copyFileSync(exe, dst);
  if (fs.statSync(dst).size !== fs.statSync(exe).size) {
    fail(`Permalink size mismatch: ${latestName}`);
  }
  if (sha256(dst) !== sha256(exe)) {
    fail(`Permalink SHA256 mismatch: ${latestName}`);
  }
  permalinks.push(dst);
  console.log(`  Permalink: ${latestName}`);
}

// ── Create/update release + upload ──
function releaseExists() {
  try {
    sh("gh", ["release", "view", tag, "--repo", repoSlug, "--json", "url"]);
    return true;
  } catch {
    return false;
  }
}

const allAssets = [...exes, ...permalinks];
console.log(`\nPublishing ${tag} → ${repoSlug} …`);
if (releaseExists()) {
  sh("gh", ["release", "upload", tag, ...allAssets, "--repo", repoSlug, "--clobber"]);
  console.log("  Release exists — assets uploaded (overwrite)");
} else {
  sh("gh", [
    "release",
    "create",
    tag,
    ...allAssets,
    "--repo",
    repoSlug,
    "--title",
    `Sati Desktop ${tag}`,
    "--notes",
    notes,
  ]);
  console.log("  Release created");
}

// ── Verify remote sizes via GitHub API (mirrors release.sh) ──
function verifyAssetOnGitHub(name, expectedBytes) {
  const out = sh("gh", [
    "release",
    "view",
    tag,
    "--repo",
    repoSlug,
    "--json",
    "assets",
    "-q",
    `.assets[] | select(.name=="${name}") | .size`,
  ]);
  const remote = Number.parseInt(out, 10);
  if (!Number.isFinite(remote) || remote !== expectedBytes) {
    fail(`GitHub asset size mismatch for ${name}: remote=${out} local=${expectedBytes}`);
  }
  console.log(`  GitHub asset OK: ${name} (${remote} bytes)`);
}

for (const asset of allAssets) {
  verifyAssetOnGitHub(path.basename(asset), fs.statSync(asset).size);
}

const url = sh("gh", ["release", "view", tag, "--repo", repoSlug, "--json", "url", "-q", ".url"]);
console.log(`\n✓ Published: ${url}`);
