#!/usr/bin/env node
/**
 * 编译后资产复制 —— 构建产物 `dist/` 布局的单一事实源。
 *
 * 根 `build` 脚本与 `apps/desktop/scripts/build-win.bat` 都调用本脚本，使
 * macOS / Windows 的 `dist/` 内容由同一份清单定义。
 *
 * 为什么需要它：此前两平台各自手写复制清单，macOS 走根 `pnpm run build`
 * （含全部 cpSync），Windows 只跑裸 `tsc` + 一处 xcopy。于是 Windows 产物缺
 * `dist/assets`（专利文书模板）、`dist/skills`、`dist/src` 下的 data 目录（方法论数据）
 * 等资产 —— `render_patent_document`、TRIZ 查表在打包运行时失效。两份清单
 * 天然会漂移，故收敛为一处（#349）。
 *
 * 用法：node scripts/copy-build-assets.mjs
 */

import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * [源, 目标] 复制清单（相对仓库根）。tsc 只处理 .ts/.tsx，不搬运非 TS 资产，
 * 而这些资产在运行期按模块位置解析，必须与编译产物相邻。
 */
const COPIES = [
  ["apps/desktop/src/package.json", "dist/apps/desktop/src/package.json"],
  ["src/extension/plugins/builtin", "dist/src/extension/plugins/builtin"],
  ["src/knowledge/patent/ipc-standards.yaml", "dist/src/knowledge/patent/ipc-standards.yaml"],
  ["src/patent/figure/symbols/electrical-symbols.yaml", "dist/src/patent/figure/symbols/electrical-symbols.yaml"],
  ["src/knowledge/patent/wiki", "dist/src/knowledge/patent/wiki"],
  ["src/methodology/runtime/components/data", "dist/src/methodology/runtime/components/data"],
  ["assets/templates/patent", "dist/assets/templates/patent"],
  ["assets/patent", "dist/assets/patent"],
  ["assets/prompts/html", "dist/assets/prompts/html"],
  ["scripts/export-html.mjs", "dist/scripts/export-html.mjs"],
  ["skills", "dist/skills"],
];

for (const [from, to] of COPIES) {
  const source = resolve(REPO_ROOT, from);
  const target = resolve(REPO_ROOT, to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
