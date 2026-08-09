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
 * Steps: collect Sati-*-win-*.exe → min-size check → read CHANGELOG.md notes
 * → create/update GitHub Release → upload exes + Sati-latest-win-*.exe
 * permalink copies (byte + SHA256 verified) → verify remote sizes via GitHub API.
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

// ── Collect installers ──
const exes = fs
  .readdirSync(distDir)
  .filter(f => /^Sati-.*-win-.*\.exe$/.test(f))
  .map(f => path.join(distDir, f));
if (exes.length === 0) {
  fail(`No Sati-*-win-*.exe found in ${distDir}`);
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
