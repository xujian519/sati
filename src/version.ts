/**
 * Application version — single source of truth is the repo-root package.json#version.
 *
 * This is a distinct dimension from the protocol version
 * (SATI_GATEWAY_PROTOCOL_VERSION in src/gateway/protocol/version.ts); do not mix them:
 *   - Application version: follows the release cadence. The repo-root, apps/desktop and
 *     ui package.json versions are bumped in lockstep (release.sh pre-flight enforces
 *     root == desktop). Consumed by gateway hello frames (clientVersion/serverVersion),
 *     the MCP client identity and the TUI header/status line.
 *   - Protocol version: bumped only on protocol changes (MAJOR.MINOR), used for the
 *     handshake compatibility check, never tracks the application version.
 *
 * Resolution strategy: walk up from a starting directory to the nearest package.json
 * whose `name` is "sati". dev (tsx running src/), dist (node running dist/src/) and the
 * desktop sati-main bundle (repo-root package.json + dist/src/) all resolve to the repo
 * root this way. Falls back to "0.0.0" — an explicit sentinel meaning "unresolved",
 * never a fabricated version (consumers can spot it in logs as clearly-not-a-release).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function resolveAppVersion(fromDir: string): string {
  let dir = fromDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "sati" && typeof pkg.version === "string" && pkg.version.length > 0) {
          return pkg.version;
        }
      } catch {
        // package.json 损坏：跳过该目录继续向上查找，最终兜底 0.0.0（fail-open）。
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

export const APP_VERSION = resolveAppVersion(moduleDir);
