import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { getRuntimeBaseDir } from "../../apps/desktop/src/server-manager.js";

/**
 * getRuntimeBaseDir 的平台分支：
 *   - win32 → %APPDATA%\Sati\runtime\<version>（APPDATA 缺失时退回
 *     ~\AppData\Roaming\Sati\runtime\<version>）
 *   - 其他平台（darwin 等）→ ~/Library/Application Support/Sati/runtime/<version>
 *
 * process.platform 在 Node 中可经 defineProperty 覆盖（configurable）；
 * os.homedir 不可配置，无法 mock，期望值直接用 os.homedir() 构造。
 * 断言统一用 path.join 构造期望值，避免测试运行平台的分隔符差异
 * （函数内部同样是 path.join）。
 */

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

function withAppData(value: string | undefined, fn: () => void): void {
  const original = process.env.APPDATA;
  if (value === undefined) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = original;
    }
  }
}

test("getRuntimeBaseDir: win32 uses %APPDATA%\\Sati\\runtime\\<version>", () => {
  const appData = "C:\\Users\\tester\\AppData\\Roaming";
  withPlatform("win32", () => {
    withAppData(appData, () => {
      assert.equal(getRuntimeBaseDir("0.0.21"), path.join(appData, "Sati", "runtime", "0.0.21"));
    });
  });
});

test("getRuntimeBaseDir: win32 falls back to ~\\AppData\\Roaming when APPDATA unset", () => {
  withPlatform("win32", () => {
    withAppData(undefined, () => {
      assert.equal(
        getRuntimeBaseDir("0.0.21"),
        path.join(os.homedir(), "AppData", "Roaming", "Sati", "runtime", "0.0.21"),
      );
    });
  });
});

test("getRuntimeBaseDir: darwin keeps ~/Library/Application Support/Sati/runtime/<version>", () => {
  withPlatform("darwin", () => {
    assert.equal(
      getRuntimeBaseDir("0.0.21"),
      path.join(os.homedir(), "Library", "Application Support", "Sati", "runtime", "0.0.21"),
    );
  });
});
