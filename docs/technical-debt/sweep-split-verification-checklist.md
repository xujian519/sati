# sweep 拆分验证 checklist（P0.2 · 全库可维护性优化专用）

> 适用：issue #646（45 红线工作日 + 5 余额档）全部拆分 PR——计划 §4.3 验证协议的操作化展开。
> 提炼自 #159 已验证先例：PR #457（`useChatComposerState` 六层拆分）/ #458（`MessagesPaneV2`）/ #460（`ImportFromFolder`），与 notes：`2026-09-20-session-store-actions-extraction` · `2026-09-18-composer-hook-split` · `2026-09-20-code-editor-binary-file-split`。
> 用法：开工前定类型（§0）→ 按类型逐项执行（§1–§4）→ 五件套收尾（§5）。

## 0. 先定这刀属于哪类

| 类型 | 判据 | 验收面 |
|---|---|---|
| **A 状态层重构** | hook/store 逻辑外移，渲染路径不动 | jsdom（vitest + colocated tests）+ 逐 token + 负控制；**不需要浏览器**（先例结论：无 UI 变化时 jsdom 即验收面） |
| **B 渲染路径变更** | 组件树 / JSX 搬移、条件分支重排 | A 全部 + 真实本地栈双视口 A/B（§3） |
| **C 机械收敛** | console / catch / i18n / 类型断言 | typecheck + 定向测试 + 门禁全绿；无 A/B |
| **D 后端拆分** | `src/` 主链路（agent/router/tool/session/gateway） | `pnpm test` 全量 + 重放 seam（触 LLM 回路）+ `check:event-matrix`（触事件面） |

## 1. 逐 token 证明（搬迁等价的核心证据）

1. **基线取起点 commit，不是 HEAD**——分批提交后 HEAD 前移、被搬代码从 HEAD 消失，守卫会「基线漂移」（先例：PR #457 缝 2 提交后立即暴露）。
2. **区间定位用 AST**（TS parser 的 `getStart/getEnd`），不用行号切片——先例三次 off-by-one：切片右界含/不含、`biome format` 让行号漂移、字符串去重误删依赖数组里 3 处合法条目。从缝 4b 起先例改用的组合：**AST 定位 + TS parser 校验零解析错误 + 组装/打补丁固化为可重复脚本**。
3. 判据：搬迁段**逐 token 相同 = 报 `N/N`**；一并核对 hook 创建顺序（先例：`useRef,useRef,useState,useRef` 不变）与 return 对象键序（先例：28 键顺序一致）。
4. 不可避免的改写（补 `export`、两行写操作合并为一次调用等）走**精确重建校验**，逐字符确认，列进 PR 正文。
5. 证明脚本可放 `/tmp`（先例）；**方法 + N/N + 改写清单必须写进 PR 正文**——脚本会丢，正文不会。
6. **格式陷阱（2026-10-12 sweep P1.1 实证）**：`catch {` **行内**注释会被 biome 重排为**独立行**，而 lint-staged 在 pre-commit 对暂存文件执行同样的格式化——若该文件在 file-size 棘轮上（`architecture-baseline.json` 有行数上限），+1 行即触顶违规；且**基线在格式化之前生成**会造成 metrics.md 漂移（CI `measure-techdebt --check` 红）。对策：① 棘轮文件的注释用**代码行尾**形态（biome 不改）；② 任何注释/格式改动提交后**复跑** `node scripts/measure-techdebt.mjs --check docs/technical-debt/metrics.md` 与 `node scripts/check-architecture-boundaries.mjs` 再推——别信提交前的那次绿。 ③ 大文件（棘轮内）的注释/文档增行同样受棘轮约束——块注释超预算时改**行尾注释或单行形态**（净增 ≤0 行），完整理由放 PR 与 backlog；④ 行号漂移后**必须**跑 `pnpm gen:event-matrix`（矩阵按 `file:line` 硬编码）再提交。

## 2. 负控制（守卫之外的第二类证据）

1. 每拆一处挑 1–4 个关键语义翻掉 → **预期的那几条**测试变红；红/绿数量记入 PR（先例 10 处，每处都触发预期用例）。
2. **两类对照都要有**：
   - 「只改一句文案 / 一个 className」→ 守卫红而**测试绿**（守卫与测试覆盖不同失效类型，先例实测）；
   - 「关键不变量翻掉」→ 测试红（先例：per-session 隔离换成单一共享键 ⇒ 18/18 全红）。
3. 负控制是入口条件不是可选项：没有负控制的拆分 PR 不算「已验证」。

## 3. 浏览器 A/B（仅类型 B）

1. 真实本地栈（`pnpm dev` 或既有本地栈），**桌面 1440×900 + 移动 390×844 双视口**。
2. `main` ↔ 分支 **A/B 行为等价**：对关键交互路径做布局断言 + 行为断言。
   - ⚠️ **自动化程度实测（P0.2 结论）**：本环境 CDP `Page.captureScreenshot` 超时、截图不可得（先例原话）；不存在像素级指纹流水线。等价证据 = **布局断言 + 行为断言**，半手工执行（ego-browser）。P0.2 据此更新成本模型：每件 B 类拆分的浏览器验证 ≈ 0.5–1 小时机时。
3. 记录：验证路径清单 + 结论 + **有意未验证的路径**（先例：真实发送消息会在本机真实项目上跑 agent，有意跳过，由测试与负控制承担）。**「未验证」必须显式写出，不得静默**（铁律 11）。

## 4. 「先补测试再拆」的 16 个零测试条目

1. 补测必须能在**当前实现**上绿（钉行为，不为拆分预写）。
2. 补测暴露缺陷 → 按铁律 11 登记降级项、转正常 issue 流，**不占 sweep 工期**（计划 §9 R8）；不为了「让补测绿」而改行为。
3. `*.test.ts` 必须 `git add -f`（`.gitignore` 忽略 `*.test.ts`）+ 同 PR `pnpm measure:update`（tests 基线 629 会变）；**不在 CI 跑的测试 = 没测**（#449 前车之鉴）。

## 5. 每 PR 五件套（= 计划 §4.3，缺一即债）

1. `pnpm measure:update`（影响指标时）
2. 消除 file-size 豁免时 `node scripts/check-architecture-boundaries.mjs --update-baseline`（打印 Δ）
3. backlog `§38` 勾选 + commit 短 hash + 行数 before/after
4. decision note（里程碑级一篇，含 `## Alternatives considered`，铁律 7）
5. 新增 `*.test.ts` → `git add -f` + `measure:update`

## 6. B1.1 专属红线（useSessionStore）

- **绝不拆子 hook**：主闭包的 `useRef(new Map())` 是 per-session store 的**唯一句柄**；拆成 `useSessionFetch()` 之类子 hook 会让每个子 hook 各建一份 Map ⇒ **28 个方法静默失效**（不抛错、日志干净、既有测试全绿）。
- 允许的形态：模块级**普通函数**工厂继续按职责切分（先例方案 B：33 个 `useCallback` 整体外化、主闭包 727→20 行、工厂体内零 hook 调用），同一 `storeRef` 经 deps 传入。
- 负控制（先例已用，须复跑）：`getSlot` 改单一共享键 ⇒ 18/18 用例应全红。

## 7. 记录去向

| 证据 | 去向 |
|---|---|
| N/N 逐 token 证明 · 负控制 · A/B 结论（含未验证路径）· 行数 before/after | **PR 正文** |
| 里程碑决策与 Alternatives | `docs/notes/implemented/` decision note |
| 条目状态（勾选 + commit + 行数） | `backlog.md` §38 |
