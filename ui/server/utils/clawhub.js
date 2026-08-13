/**
 * clawhub CLI resolver.
 *
 * Why this exists: the desktop app (Electron) is launched from Finder, so its
 * server process inherits macOS's minimal GUI PATH (/usr/bin:/bin:/usr/sbin:/sbin).
 * Globally installed npm CLIs (nvm / ~/.npm-global / ...) are invisible to it,
 * which made `execFile("clawhub", ...)` fail with ENOENT. This module resolves
 * clawhub outside PATH and returns an absolute path when one is found.
 */
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Shared message for the routes when no clawhub executable can be located. */
export const CLAWHUB_NOT_FOUND_MESSAGE =
  "clawhub CLI not found. Install it with `npm install -g clawhub`, then restart Sati.";

function pathApiFor(platform) {
  return platform === "win32" ? path.win32 : path;
}

function candidateFileNames(platform) {
  return platform === "win32" ? ["clawhub.exe", "clawhub.cmd", "clawhub"] : ["clawhub"];
}

function isDirectlySpawnable(candidate, platform) {
  // On Windows, .cmd/.bat can only run through a shell, so execFile cannot use
  // them directly; return null in that case and let callers fall back to the
  // bare name, which PATHEXT resolves (same behavior as before).
  return platform !== "win32" || !/\.(cmd|bat)$/i.test(candidate);
}

function isRegularFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function appendExisting(candidates, candidate, pathExists) {
  if (pathExists(candidate) && !candidates.includes(candidate)) {
    candidates.push(candidate);
  }
}

/**
 * Numeric version compare ("v9.11.0" < "v10.0.0"). nvm uses a leading "v",
 * asdf does not; both are handled by stripping the prefix and comparing each
 * dot-separated part numerically.
 */
function compareNodeVersions(a, b) {
  const partsA = String(a).replace(/^v/i, "").split(".").map(Number);
  const partsB = String(b).replace(/^v/i, "").split(".").map(Number);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function probeDirectory(directory, fileNames, pathExists, isFile, platform, found) {
  for (const name of fileNames) {
    const candidate = pathApiFor(platform).join(directory, name);
    if (pathExists(candidate) && isFile(candidate) && isDirectlySpawnable(candidate, platform)) {
      appendExisting(found, candidate, pathExists);
    }
  }
  return found[0] ?? null;
}

export async function resolveClawhubPath({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  execPath = process.execPath,
  pathExists = existsSync,
  isFile = isRegularFile,
  listDir = readdir,
} = {}) {
  const pathApi = pathApiFor(platform);
  const fileNames = candidateFileNames(platform);
  const found = [];

  // Explicit override (same convention as SATI_BASH_PATH), highest priority.
  const configuredPath = String(env.SATI_CLAWHUB_PATH || "").trim();
  if (configuredPath && pathExists(configuredPath) && isFile(configuredPath)) {
    return configuredPath;
  }

  // 1) PATH entries, one directory at a time (matches execFile's PATH lookup).
  for (const entry of String(env.PATH || "").split(pathApi.delimiter)) {
    const directory = String(entry || "")
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    const hit = await probeDirectory(directory, fileNames, pathExists, isFile, platform, found);
    if (hit) return hit;
  }

  // 2) The running node's global bin directory (covers nvm, homebrew and other
  //    node installs whose bin dir is outside the GUI process PATH).
  if (execPath) {
    const hit = await probeDirectory(pathApi.dirname(execPath), fileNames, pathExists, isFile, platform, found);
    if (hit) return hit;
  }

  // 3) Version-manager node installs (nvm / fnm / asdf / mise), newest version
  //    first so the result matches what the user's shell PATH would resolve.
  if (platform !== "win32") {
    const versionManagers = [
      { root: pathApi.join(home, ".nvm", "versions", "node"), bin: version => pathApi.join(version, "bin") },
      {
        root: pathApi.join(home, ".local", "share", "fnm", "node-versions"),
        bin: version => pathApi.join(version, "installation", "bin"),
      },
      { root: pathApi.join(home, ".asdf", "installs", "nodejs"), bin: version => pathApi.join(version, "bin") },
      {
        root: pathApi.join(home, ".local", "share", "mise", "installs", "node"),
        bin: version => pathApi.join(version, "bin"),
      },
    ];
    for (const { root, bin } of versionManagers) {
      let versions = [];
      try {
        versions = await listDir(root);
      } catch {
        continue;
      }
      for (const version of versions.sort((a, b) => compareNodeVersions(b, a))) {
        const hit = await probeDirectory(
          bin(pathApi.join(root, version)),
          fileNames,
          pathExists,
          isFile,
          platform,
          found,
        );
        if (hit) return hit;
      }
    }
  }

  // 4) Common npm global bin directories, which a GUI-launched server cannot
  //    see on PATH.
  const binDirs = [
    pathApi.join(home, ".npm-global", "bin"),
    pathApi.join(home, ".local", "bin"),
    pathApi.join(home, ".local", "share", "pnpm"),
    pathApi.join(home, "Library", "pnpm"),
    pathApi.join(home, ".bun", "bin"),
    pathApi.join(home, "bin"),
    pathApi.join(home, ".volta", "bin"),
  ];
  if (platform === "win32") {
    binDirs.push(pathApi.join(env.APPDATA || pathApi.join(home, "AppData", "Roaming"), "npm"));
  }
  for (const directory of binDirs) {
    const hit = await probeDirectory(directory, fileNames, pathExists, isFile, platform, found);
    if (hit) return hit;
  }

  return null;
}

/**
 * Cache factory, separated from the resolver so tests can drive the caching
 * behavior with a stub resolver.
 */
export function createClawhubPathCache(resolve) {
  let cachedClawhubPath = null;
  return {
    async get(options) {
      if (!options && cachedClawhubPath) return cachedClawhubPath;
      const resolved = await resolve(options);
      if (!options && resolved) cachedClawhubPath = resolved;
      return resolved;
    },
    reset() {
      cachedClawhubPath = null;
    },
  };
}

const clawhubPathCache = createClawhubPathCache(resolveClawhubPath);

/**
 * Cached entry point for the routes. A positive result is reused for the
 * process lifetime (the server restarts when the desktop app relaunches); a
 * negative result is NOT cached so a mid-session `npm install -g clawhub` is
 * picked up without a restart. Passing options skips the cache entirely.
 */
export const getClawhubPath = clawhubPathCache.get;
export const resetClawhubPathCache = clawhubPathCache.reset;
