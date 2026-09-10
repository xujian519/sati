import { afterEach, describe, expect, it, vi } from "vitest";
import { getDesktopUpdateStatus, selectDesktopAsset, startDesktopUpdateDownload } from "./desktopUpdateService.js";

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

/**
 * 状态与资产选择必须同口径：`selectDesktopAsset` 返回 null 时，如果状态仍是
 * 「可更新」，About 页会点亮圆点并给出下载按钮，点下去只得到 404。
 */
describe("desktop update status vs installer asset", () => {
  const ENV = {
    SATI_DESKTOP_VERSION: "0.1.12",
    SATI_COMMIT_SHA: "deadbeef",
    SATI_BUILD_TIME: "2026-09-01T00:00:00.000Z",
  };
  const OPTS = { platform: "darwin", arch: "arm64", force: true, now: new Date("2026-09-10T00:00:00.000Z") };

  function stubLatestRelease(assets, version = "0.1.13") {
    return vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        tag_name: `v${version}`,
        name: version,
        html_url: "https://example.test/releases/v0.1.13",
        published_at: "2026-09-09T00:00:00.000Z",
        assets: assets.map((name, index) => ({
          id: index + 1,
          name,
          size: 1024,
          browser_download_url: `https://example.test/download/${name}`,
          content_type: "application/octet-stream",
        })),
      }),
    }));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("有对应架构的安装包时才报可更新", async () => {
    stubLatestRelease(["Sati-0.1.13-mac-arm64.dmg"]);
    const status = await getDesktopUpdateStatus({ ...OPTS, env: ENV });

    expect(status.status).toBe("update-available");
    expect(status.hasUpdate).toBe(true);
    expect(status.updateAvailable).toBe(true);
    expect(status.assetAvailable).toBe(true);
    expect(status.latest.selectedAsset?.name).toBe("Sati-0.1.13-mac-arm64.dmg");
    expect(status.message).toBeUndefined();
  });

  it("本平台只有别的架构的包时报「无可用安装包」而非可更新", async () => {
    stubLatestRelease(["Sati-0.1.13-mac-x64.dmg"]);
    const status = await getDesktopUpdateStatus({ ...OPTS, env: ENV });

    // 版本确实落后（hasUpdate 为真），但没有能装上的包 —— 不能提示可更新。
    expect(status.hasUpdate).toBe(true);
    expect(status.assetAvailable).toBe(false);
    expect(status.updateAvailable).toBe(false);
    expect(status.status).toBe("asset-unavailable");
    expect(status.latest.selectedAsset).toBeNull();
    expect(status.message).toMatch(/darwin\/arm64/);
  });

  it("无可用安装包时下载入口以 404 收场，状态不再承诺一个做不到的动作", async () => {
    stubLatestRelease(["Sati-0.1.13-mac-x64.dmg"]);
    const status = await getDesktopUpdateStatus({ ...OPTS, env: ENV });

    expect(status.status).toBe("asset-unavailable");
    await expect(startDesktopUpdateDownload({ status })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("版本未前进时既不可更新也无资产诉求", async () => {
    stubLatestRelease(["Sati-0.1.12-mac-arm64.dmg"], "0.1.12");
    const status = await getDesktopUpdateStatus({ ...OPTS, env: ENV });

    expect(status.status).toBe("up-to-date");
    expect(status.hasUpdate).toBe(false);
    expect(status.updateAvailable).toBe(false);
  });
});
