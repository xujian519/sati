/**
 * 样式预设持久化：可复用排版参数存为 products/<产品>/brand/style-presets/<name>.json。
 * 与 theme.json（默认品牌）分离，作为「事务所样式」的可复用变体。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StylePreset } from "./types.js";

/** 安全预设名：字母、数字、下划线、连字符、点、中文；不含路径分隔符与 `..`。 */
const SAFE_PRESET_NAME = /^(?!.*\.\.)[A-Za-z0-9._\-\u4e00-\u9fa5]{1,80}$/;

function assertSafeName(name: string): void {
  if (!SAFE_PRESET_NAME.test(name)) {
    throw new Error(`非法预设名: ${JSON.stringify(name)}`);
  }
}

/** 从品牌 theme.json 的绝对路径推导 style-presets 目录。 */
export function resolvePresetDirFromBrandPath(brandAbsPath: string): string {
  return join(dirname(brandAbsPath), "style-presets");
}

/** 写预设文件（原子写：先 tmp 再 rename）。返回落盘绝对路径。 */
export function saveStylePreset(presetDir: string, preset: StylePreset): string {
  assertSafeName(preset.name);
  mkdirSync(presetDir, { recursive: true });
  const file = join(presetDir, `${preset.name}.json`);
  const payload: StylePreset = {
    ...preset,
    updatedAt: preset.updatedAt ?? new Date().toISOString(),
  };
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return file;
}

/** 列出所有预设（按名称排序），缺目录返回空数组。 */
export function listStylePresets(presetDir: string): StylePreset[] {
  if (!existsSync(presetDir)) return [];
  const files = readdirSync(presetDir).filter((f) => f.endsWith(".json"));
  const presets: StylePreset[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(presetDir, f), "utf8");
      const parsed = JSON.parse(raw) as StylePreset;
      if (typeof parsed?.name === "string" && parsed.style !== undefined) {
        presets.push(parsed);
      }
    } catch {
      // 忽略损坏的预设文件。
    }
  }
  return presets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 读取单个预设；不存在则抛错。 */
export function loadStylePreset(presetDir: string, name: string): StylePreset {
  assertSafeName(name);
  const file = join(presetDir, `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`样式预设不存在: ${name}`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as StylePreset;
}

/** 删除单个预设；返回是否删除成功（不存在返回 false）。 */
export function deleteStylePreset(presetDir: string, name: string): boolean {
  assertSafeName(name);
  const file = join(presetDir, `${name}.json`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
