# Agent Note: figuregen barrel 收敛（#646 sweep P1.5）

Status: implemented

## Problem

`src/patent/figuregen` 的 barrel（`index.ts` + `cad/index.ts`）对外声明 235 个导出名，其中 **84 个在模块外零消费**——没有 tool / patent 流程消费者，也没有测试消费者。逐名核验（`as 84`）：**0 个「仅测试使用」、0 个「完全死声明」**——每个名字都至少在其声明文件内部有真实引用，说明这批导出是「内部实现被顺手承诺成了公开面」，而不是死代码。

同时 6 个外部文件（4 个 tool + `atoms/handlers/builtin/figure.ts` + `figure/bridge.ts`）绕过 barrel 直接深引子模块路径——barrel 与深引两套入口并存，公开面边界不完整。

度量事实（`scripts/measure-figuregen-exports.mjs`，P0.2 入库）：
- 首跑基线 **235 导出 / 84 零消费**；取代此前两次一次性人工口径（2026-10-11 侦察记 88、issue #541 记 92/196 与 #541 正文记 225/92 的混杂口径差，本脚本为 M9 唯一判据）。
- `TD-EXTENSION-N08` 前身曾判「barrel 收敛：**不做**」——条件是「公开面变更须决策记录、收益为 0 而成本最高」。本次 sweep 明列 P1.5/M9 并以本 note 满足「决策记录」前提，故执行。

## Decision

1. **裁剪 barrel 导出面**：84 个零消费名从两个 barrel 导出表移除（主 barrel 58 + cad barrel 26）。声明保留在各自源文件——它们仍被模块内部使用（84/84 核验），删除的只是「不必要的对外承诺」。
2. **深引全部归口 barrel**：6 个外部文件的深引换成 barrel 导入；为 `pixel-gate` 补出 3 个**已被消费**的名（`analyzeImageBuffer` / `PixelFinding` / `PixelMetrics`）进 barrel——**只补有消费的名，不补全量 API**（否则会制造新的零消费导出）。其依赖仅 `office-profile` / `page-contract` / `check` 三个轻模块，无新增重加载。
3. 收敛后判据：**154 导出名 / 154 全消费 / 0 零消费**（净减 81 名，`src` −85 行）。

## Alternatives considered

- **保留 84 名 + 逐条 note「有意公开 API」**：无任何消费方支持「公开承诺」的说法；写 note 等于把未被使用的承诺美化成设计。否决。
- **连带删除 84 个声明本体**：核验 0/84 为完全死声明（全部被所在文件使用），删本体误伤内部实现。否决。
- **只裁 barrel、不归口深引**：深引是「第二个入口」，半收敛意味着边界依然不完整；且所需名大多已在 barrel（当年深引为历史遗留），归口近乎零成本。否决。
- **pixel-gate 例外保留深引**：计划要求「深引归一」，其依赖又轻；例外没有依据。否决。
- **本次顺带挂 CI 门禁防回潮**：属于「新增门禁」的口径扩展（需另立条目与豁免评估），不在 P1.5 范围。留候选。

## Verification

- 判据脚本：`node scripts/measure-figuregen-exports.mjs` → **零消费 0**（154/154）；深引残留 grep = 空。
- `pnpm typecheck`（root + edgeclaw）全绿；biome + eslint 对全部被改文件 green。
- `pnpm check:event-matrix` fresh（被改文件含 tool/atoms 行号变化，矩阵无漂移）；`check-architecture-boundaries` fresh。
- 定向测试：`dist/tests/patent/figuregen/*.spec.js`（31 文件）+ `figure-bridge.spec` + `figure-gate.spec` = **383 例（382 pass / 1 skipped / 0 fail）**。
