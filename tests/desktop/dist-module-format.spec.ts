import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 跨树 desktop 产物的模块判型守卫。
 *
 * 根 package.json 为 type:module，根 dist 下的一切 .js 默认按 ESM 解析；
 * 而 apps/desktop 以 node16+CJS 语义编译（Electron main/preload 按 CJS 加载）。
 * 根 tsc 会把 apps/desktop/src/** 一并编进 dist/apps/desktop/src/**，若无包级
 * commonjs 标记，根 ESM 测试对这些产物的静态命名导入会在链接期报
 * "does not provide an export named …"（2026-09-07 CI 实测）。
 * 构建脚本把 apps/desktop/src/package.json（type:commonjs）拷入 dist 以固定判型；
 * 本测试锁定这条链路的两端都在位。
 */

// 本文件编译后在 <root>/dist/tests/desktop/ 下，相对路径同时可达 dist 内外。
const specDir = dirname(fileURLToPath(import.meta.url));
const distMarkerPath = join(specDir, "../../apps/desktop/src/package.json");
const sourceMarkerPath = join(specDir, "../../../apps/desktop/src/package.json");

test("根 dist 的跨树 desktop 产物带 commonjs 包标记", () => {
  assert.ok(existsSync(distMarkerPath), "dist/apps/desktop/src/package.json 应由构建脚本拷入");
  const marker = JSON.parse(readFileSync(distMarkerPath, "utf8")) as { type?: string };
  assert.strictEqual(marker.type, "commonjs", "dist 标记必须显式 commonjs（root dist 默认 ESM 判型）");
});

test("源侧 desktop 标记与 dist 保持一致（type:commonjs）", () => {
  const sourceMarker = JSON.parse(readFileSync(sourceMarkerPath, "utf8")) as { type?: string };
  assert.strictEqual(sourceMarker.type, "commonjs", "apps/desktop/src/package.json 是 dist 标记的拷贝源");
});
