/**
 * App 图标路径解析（main.ts 与 onboarding-window.ts 共用，避免两份拷贝漂移）。
 * Windows 用 .ico（BrowserWindow / Tray 均支持），macOS 用 .icns。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function resolveAppIconPath(): string | undefined {
  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [
        path.join(__dirname, "..", "resources", "icon.ico"),
        path.join(process.resourcesPath, "icon.ico"),
        path.join(__dirname, "..", "resources", "icon.icns"),
        path.join(process.resourcesPath, "icon.icns"),
      ]
    : [
        path.join(__dirname, "..", "resources", "icon.icns"),
        path.join(process.resourcesPath, "icon.icns"),
        path.join(__dirname, "..", "resources", "icon.ico"),
        path.join(process.resourcesPath, "icon.ico"),
      ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
