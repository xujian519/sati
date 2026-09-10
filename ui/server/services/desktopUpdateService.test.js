import { describe, expect, it } from "vitest";
import { selectDesktopAsset } from "./desktopUpdateService.js";

/**
 * 上游 #544：DMG 从 universal 拆成 mac-arm64 / mac-x64 双产物后，同一 release 里
 * 会同时挂着两个架构的安装包。旧实现里「识别出是别的架构」只得 0 分，与「名字里
 * 根本没写架构」同分，于是只要本架构的包缺失（或命名不符），就会退而选中另一个
 * 架构的包 —— 用户下到装不上的安装包，且更新提示一路显示「可用」。
 */
describe("desktop installer asset selection", () => {
  it("darwin 下按本机架构选中对应的 DMG", () => {
    const release = {
      assets: [
        { name: "Sati-2026.903.0-mac-x64.dmg" },
        { name: "Sati-2026.903.0-mac-arm64.dmg" },
        { name: "Sati-2026.903.0-mac-universal.dmg" },
      ],
    };

    expect(selectDesktopAsset(release, { platform: "darwin", arch: "arm64" })?.name).toBe(
      "Sati-2026.903.0-mac-arm64.dmg",
    );
    expect(selectDesktopAsset(release, { platform: "darwin", arch: "x64" })?.name).toBe("Sati-2026.903.0-mac-x64.dmg");
  });

  it("绝不提供只编译了其他架构的安装包", () => {
    const release = { assets: [{ name: "Sati-2026.903.0-mac-x64.dmg" }] };

    expect(selectDesktopAsset(release, { platform: "darwin", arch: "arm64" })).toBeNull();
  });

  it("universal 包仍对两种架构可用", () => {
    const release = { assets: [{ name: "Sati-2026.903.0-mac-universal.dmg" }] };

    expect(selectDesktopAsset(release, { platform: "darwin", arch: "arm64" })?.name).toBe(
      "Sati-2026.903.0-mac-universal.dmg",
    );
    expect(selectDesktopAsset(release, { platform: "darwin", arch: "x64" })?.name).toBe(
      "Sati-2026.903.0-mac-universal.dmg",
    );
  });

  it("旧命名（名字里不带架构）仍可选，不因架构未知被排除", () => {
    const release = { assets: [{ name: "Sati-0.1.12.dmg" }] };

    expect(selectDesktopAsset(release, { platform: "darwin", arch: "arm64" })?.name).toBe("Sati-0.1.12.dmg");
  });

  it("windows 安装包同样按架构过滤", () => {
    const release = {
      assets: [{ name: "Sati-2026.903.0-win-arm64-setup.exe" }, { name: "Sati-2026.903.0-win-x64-setup.exe" }],
    };

    expect(selectDesktopAsset(release, { platform: "win32", arch: "x64" })?.name).toBe(
      "Sati-2026.903.0-win-x64-setup.exe",
    );
    expect(selectDesktopAsset(release, { platform: "win32", arch: "arm64" })?.name).toBe(
      "Sati-2026.903.0-win-arm64-setup.exe",
    );
  });

  it("拿不到匹配架构的包时不退回另一个平台", () => {
    const release = { assets: [{ name: "Sati-2026.903.0-win-x64-setup.exe" }] };

    expect(selectDesktopAsset(release, { platform: "darwin", arch: "arm64" })).toBeNull();
  });
});
