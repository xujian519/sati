/**
 * App 图标路径解析（main.ts 与 onboarding-window.ts 共用，避免两份拷贝漂移）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function resolveAppIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "..", "resources", "icon.icns"),
    path.join(process.resourcesPath, "icon.icns"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
