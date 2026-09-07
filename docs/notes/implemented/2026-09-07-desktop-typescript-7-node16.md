# Agent Note: desktop TypeScript 7（node16 迁移）与跨树产物判型修复

Status: implemented

## Problem

dependabot 将 `/apps/desktop` 的 typescript 从 6.0.3 升到 7.0.2（PR #264）。TS 7 移除 node10 解析，desktop 原有 `"moduleResolution": "Node"` + `ignoreDeprecations: "6.0"` 的压制路线走不通，必须完成 node16 迁移。迁移后 CI（2026-09-07 run 34114216534）仅剩一处红灯：

- 根 `package.json` 为 `type:module`，根 `dist/` 下一切 `.js` 默认按 ESM 解析；
- 根 tsc 会把 `apps/desktop/src/**` 一并编进 `dist/apps/desktop/src/**`（node16 + 源侧无 type 字段 → CJS 产物，`"use strict"` 开头）；
- 根 ESM 测试 `tests/desktop/server-manager.spec.ts` 对该跨树产物做**静态命名导入**，链接期报 `SyntaxError: The requested module '../../apps/desktop/src/server-manager.js' does not provide an export named 'getRuntimeBaseDir'`（CJS 内容被按 ESM 判型，无静态导出可链）。

## Decision

1. **完成 node16 迁移**：`apps/desktop/tsconfig.json` 用 `module/moduleResolution: node16`；相对导入补显式 `.js` 扩展名（`main.ts`/`onboarding-window.ts`）；删除源侧 `type:module` 标记，使 desktop 产物保持 CJS 语义——Electron main/preload 按 CJS 加载的方式不变（本地验证 `apps/desktop/dist/main.js` 仍为 CJS 输出）。
2. **dist 包级 commonjs 标记修复判型**：新增 `apps/desktop/src/package.json`（显式 `{"type":"commonjs"}`，node16 判型与缺省一致），根 build 脚本在 tsc 后将其 `cpSync` 到 `dist/apps/desktop/src/package.json`。Node 对 dist 内跨树产物据此判为 CJS，cjs-module-lexer 可识别 `exports.x = …`，根 ESM 测试的静态命名导入恢复正常——测试源码零改动。
3. **守卫测试**：`tests/desktop/dist-module-format.spec.ts` 锁定"dist 标记存在且为 commonjs + 源侧拷贝源一致"两端，防止构建步骤被静默移除后红灯复现。

## Alternatives considered

- **保留 `ignoreDeprecations: "6.0"` + node10 硬升 TS 7** — 落选：TS 7 移除 node10 解析，该开关只压制 TS 6 的废弃警告，压不住 TS5108。
- **测试侧改用 `createRequire` 加载跨树产物** — 落选：产物在 root `type:module` 作用域内仍被按 ESM 判型，require(esm) 路径下求值期直接抛 `exports is not defined`，换导入风格治标不治本（实验实测无效）。
- **desktop 整体 ESM 化（保留 type:module，node16 判 ESM）** — 落选：Electron preload 必须为 CJS，dist 变 ESM 会让桌面端启动崩溃；运行时风险不可接受。
- **构建脚本用 `node -e writeFileSync` 生成 dist 标记** — 落选：改为源侧静态文件 + `cpSync`，与 build 脚本既有拷贝步骤风格一致，标记内容进版本库可审。

## Consequences

- desktop 构建工具链进入 TS 7（与 edgeclaw-memory-core 一致）；root/ui 仍在 TS 6，待 typescript-eslint 支持 TS 7 后再升（#268 关闭时结论不变）。
- 根 dist 多出一个拷贝的 `package.json`；未来若有其他 workspace 以 CJS 语义被根 tsc 跨树编译，同需包级标记（守卫测试只覆盖 desktop 一处）。
- 全量验证：本地 4148 测试 0 失败、typecheck/lint（含事件矩阵）/format 绿、CI desktop job 两步（`eslint apps/desktop` + `apps/desktop pnpm build`）本地镜像通过。
