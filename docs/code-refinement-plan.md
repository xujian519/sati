# Sati 全仓代码精炼与审阅中期计划（保守档）

- 计划日期：2026-08-18
- 执行深度：**保守档**（用户确认）——只做无行为变化的清理，不拆大文件、不动架构、不升级依赖
- 范围：`src/`、`ui/src`、`ui/server`、`tests/`、`scripts/`（约 1828 个 TS/TSX 文件、31 万行）
- 周期：约 8–9 周，42 张日卡，每天一张

## 一、目标与成功标准

**目标**：对全部代码做一轮全覆盖的「审阅 + 精炼」。审阅先行、精炼后置，**只做无行为变化的清理**，保持全部功能不变。

**成功标准（可量化验收）**：
1. **审阅覆盖率 100%**：42 张日卡全部完成，本进度表可逐卡追溯
2. **每卡门禁全绿**：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`（UI 卡为 `pnpm --filter sati-ui test/typecheck`），零新增 warning
3. **行为不变**：全部提交为 refactor/chore/docs 类，无 feat/fix 混入；全量测试保持全绿
4. **指标目标**（基线见 §六）：裸 console 657 处 → <300；`any`/`@ts-expect-error` 20 处 → ≤10（主链路清零，外围加 `// SAFETY:` 注释）；无参 `catch {}` 485 处显著下降；TODO/FIXME 24 处 → ≤5
5. **产出终审报告** `docs/code-refinement-report.md`：指标对比、遗留清单、未来专项建议（含超长文件拆解候选）

**明确排除（保守档边界）**：不拆 >600 行大文件（仅记录"待拆建议"）、不动 `ui/server` 深层 import 与架构、不升级依赖、不改工具 `inputSchema`（会破坏 LLM replay fixture）、事件面/协议面零改动（`check:event-matrix` 门禁保护）、不触碰 `edgeclaw-memory-core` 的构建方式与 `ui/server/routes/memory.js` 的 lib 直连路径。

## 二、阶段划分

| 阶段 | 周期 | 内容 | 卡数 |
|---|---|---|---|
| 阶段 0 | 第 1 天 | 基线测量 + 建立本计划文档与进度表 | — |
| 阶段 1 | 第 1–2 周 | 核心后端：agent / cli / model / gateway / context / tool | 11 |
| 阶段 2 | 第 3–5 周 | 业务域：patent / adapters / knowledge / router / always-on / session / cron / rule / mcp / extension / web 等 | 15 |
| 阶段 3 | 第 6–7 周 | UI：ui/src 大组件轮转、ui/server 清理、i18n key 对齐 | 9 |
| 阶段 4 | 第 8–9 周 | 测试/脚本审阅 + 横切治理（console / any / catch / TODO）+ 终审报告 | 7 |

**合计 42 张日卡**，每天一张；周五下午留 30 分钟周复盘（卡数、指标变化、下周取卡）。

## 三、每日执行格式（一张"日卡" = 约 2–3 小时）

1. **取卡**：按进度表优先级取未完成卡（大文件多、主链路模块优先）
2. **审阅**：通读该模块全部文件，按审阅清单逐项核查，产出审阅记录（发现分级：P0 行为缺陷 / P1 复杂度 / P2 一致性 / P3 风格）
3. **精炼**：仅执行无行为变化的清理——死代码/孤儿导出删除、命名一致性、重复逻辑合并、类型收窄（`any`→`unknown`/联合类型）、注释治理（删赘注/补必要注释）、嵌套三元改 if/else、i18n 缺失 key 补齐
4. **验证**：对应门禁全绿（后端卡跑 4 件套；UI 卡跑 vitest + typecheck；edgeclaw 子包卡先 `pnpm --filter edgeclaw-memory-core build`）
5. **提交**：Conventional Commits（`refactor(<scope>): …`），一个关注点一个提交；**P0 发现不混入精炼提交**，记录后另开 fix 卡
6. **记录**：更新本进度表（状态 + 发现摘要 + 指标计数）

**审阅清单（每卡必查 10 项）**：
- [ ] 死代码、未使用导出、孤儿文件
- [ ] `any` / `@ts-expect-error` 逃逸（新代码禁 any）
- [ ] 无参 `catch {}` 静默吞错
- [ ] 裸 console（应走 `src/telemetry/` 或结构化错误）
- [ ] 嵌套三元、>100 行函数、过深嵌套
- [ ] 重复代码可提取、冗余抽象
- [ ] 命名与文件命名规范（kebab-case / PascalCase / UPPER_SNAKE）
- [ ] CLAUDE.md 规范一致性（protocol/runtime/config 分层、barrel、错误类、i18n 提取）
- [ ] TODO/FIXME/legacy 标注核实
- [ ] 测试与注释是否随精炼同步更新

## 四、日卡清单

### 阶段 1 — 核心后端（W1–W2）

| 卡 | 模块 | 规模/热点 | 状态 |
|---|---|---|---|
| C01 | src/agent | 44 文件/8.1K 行；AgentLoop.ts 2127（loop 模块族） | ⬜ |
| C02 | src/cli | 15/5.3K；createLocalGateway.ts 1942、sati.ts 1021（console 热点 54 处） | 🔄 |
| C03 | src/model/catalog | providers.ts 1766 | ⬜ |
| C04 | src/model 其余 | streaming/streamModel.ts 995、embedding、resolveModelInfo | ⬜ |
| C05 | src/gateway | 32/5.9K；InProcessGateway.ts 1057、protocol/server | ⬜ |
| C06 | src/context 非 memory | projection、budget、compression、vectors | ⬜ |
| C07 | src/context/memory 主包 | EdgeClawMemoryProvider 等（不含子包） | ⬜ |
| C08 | edgeclaw-memory-core 子包 | sqlite.ts 1716、llm-extraction.ts 1573、file-memory.ts 1147、llm-prompts.ts 997；独立 build 验证 | ⬜ |
| C09 | src/tool registry/execution/audit | createBuiltinRegistry、ToolRuntime | ⬜ |
| C10 | src/tool/builtin 上半 | readFile.ts 988、filesystem 组 | ⬜ |
| C11 | src/tool/builtin 下半 | patentPdfDownload.ts 945、patentWorkflow 等 | ⬜ |

### 阶段 2 — 业务域（W3–W5）

| 卡 | 模块 | 规模/热点 | 状态 |
|---|---|---|---|
| C12 | src/patent workflow+flexible-plan+plantask | 126 文件/20.5K 总分 3 卡 | ⬜ |
| C13 | src/patent evidence+problem+atoms | evidence/engine.ts 844 | ⬜ |
| C14 | src/patent graph+claim-chart+document | | ⬜ |
| C15 | src/patent data/nuo+figure+evaluate 其余 | | ⬜ |
| C16 | src/adapters 大渠道 | wecom 1760、weixin 1459、feishu 1332 | ⬜ |
| C17 | src/adapters 其余 18 渠道+protocol | ImLiveReplyController.ts 1016 | ⬜ |
| C18 | src/knowledge | 44/7.1K；case-law、legal、kg-store、wiki | ⬜ |
| C19 | src/router | 26/4.3K；RouterRuntime.ts 1258 | ⬜ |
| C20 | src/always-on | 38/8K；DiscoveryFire.ts 1252 | ⬜ |
| C21 | src/session + task + status + pilot | 34/4.8K + 3 小模块 | ⬜ |
| C22 | src/cron + src/rule | 18/3K + 11/1.9K | ⬜ |
| C23 | src/mcp + literature + methodology | 16/1.4K + 13/1.3K + 13/0.7K | ⬜ |
| C24 | src/extension + permission + lifecycle | SkillManager.ts 904 | ⬜ |
| C25 | src/web + workflow + telemetry | 12/3.5K + 11/1.8K + 5/0.8K | ⬜ |
| C26 | 小模块合卡 | network/shared/fs/browser/test-support | ⬜ |

### 阶段 3 — UI（W6–W7）

| 卡 | 模块 | 规模/热点 | 状态 |
|---|---|---|---|
| C27 | main-content-v2 组 | SkillsV2.tsx 2502、DashboardV2.tsx 1351 | ⬜ |
| C28 | chat-v2 组 | MessagesPaneV2.tsx 1375、ComposerV2.tsx 1061、processGrouping.ts 1231 | ⬜ |
| C29 | chat/hooks | useChatComposerState.ts 1596、useChatSessionState.ts 1168、useChatRealtimeHandlers.ts 973 | ⬜ |
| C30 | chat/view + stores | MessageComponent.tsx 969、useSessionStore.ts 1435 | ⬜ |
| C31 | code-editor/view | PdfDocumentPreview.tsx 1860、CodeEditorBinaryFile.tsx 1522 | ⬜ |
| C32 | app-shell + hooks | SidebarV2.tsx 1273、AppShellV2.tsx 887、useProjectsState.ts 898 | ⬜ |
| C33 | main-content 其余 | MainContent.tsx 1051、CronV2.tsx 1097、FilesV2.tsx 960 | ⬜ |
| C34 | ui/server | 98 JS/29.7K 行；只做行为不变清理（死代码、重复、命名），深层 import 仅记录 | ⬜ |
| C35 | ui i18n + e2e | en/zh-CN key 对齐、Playwright 用例审阅 | ⬜ |

### 阶段 4 — 横切与收尾（W8–W9）

| 卡 | 内容 | 状态 |
|---|---|---|
| C36 | tests/ 审阅 A：agent/tool/context（伪测试治理、断言质量） | ⬜ |
| C37 | tests/ 审阅 B：patent/knowledge/gateway/session 等其余 | ⬜ |
| C38 | scripts/ 32 文件审阅精炼 | ⬜ |
| C39 | 裸 console 收束（→telemetry wrapper，行为不变） | ⬜ |
| C40 | any/类型逃逸收敛（主链路优先 + SAFETY 注释） | ⬜ |
| C41 | 无参 catch 治理 + TODO/FIXME 核实 | ⬜ |
| C42 | 终审：docs/code-refinement-report.md + 技术债报告追加注记 | ⬜ |

## 五、进度表（每日更新）

| 日期 | 卡号 | 模块 | 审阅发现摘要 | 提交数 | 状态 |
|---|---|---|---|---|---|
| 2026-08-18 | C02 | src/cli | 见日卡记录 | — | 🔄 |

### 日卡记录

#### C02 src/cli（2026-08-18）

- **审阅发现**：
  - P1 sati.ts：渠道构建逻辑在 server 启动与 adapter 热重载两处重复（feishu/qq/wecom 各 2 份，约 90 行）→ 已提取 4 个构建函数收敛
  - P1 gatewaySetup.ts：`attemptFeishuQRCreation` 的 try/catch 为死代码（try 体不可能抛错，两分支均 return null）→ 已删除
  - P2 createLocalGateway.ts：2 处 `(err as Error).message` 强转（非 Error 时丢信息）→ 统一为 `instanceof Error` 模式
  - P2 discoveryIo.ts：项目名解析逻辑重复 2 份 → 提取 `resolveProjectRoot` 辅助函数
  - P3 satiServer.ts：同模块重复 import 3 处 → 合并；gatewaySetup.ts 横幅边框错位（45 vs 52 宽）→ 对齐
  - P2 记录不处理：patentSearch.ts `DEFAULT_USER = "xujian"`（开发者个人默认值，改默认值属行为变化，需人工决策）；chatSearch.ts 与 sati.ts 各有一份语义不同的 readStringFlag（不合并避免行为漂移）
  - P0：无行为缺陷
- **精炼项**：sati.ts 渠道构建去重（-90 行）、gatewaySetup.ts 死代码+横幅、createLocalGateway.ts 错误格式化 ×2、discoveryIo.ts 去重、satiServer.ts import 合并
- **验证**：`pnpm typecheck` ✅ 0 错误；`pnpm lint`（eslint src/cli）✅ 0 error/0 warning；`biome check src/cli` ✅；cli 测试 30/30 ✅（tsx 直跑）
- **提交**：`refactor(cli): dedupe channel construction and clean up CLI entry helpers`

## 六、基线（2026-08-18 实测）

| 指标 | 基线值 | 目标 | 备注 |
|---|---|---|---|
| 裸 console（src + ui/server，含 .ts/.tsx/.js） | 657 处 / 83 文件 | <300 | 含 ui/server 手写 JS 大量输出 |
| `any`/`@ts-expect-error`（src + ui/src） | 20 处 | ≤10 | 主链路清零，外围加 SAFETY 注释 |
| 无参 `catch {`（src + ui/src） | 485 处 | 显著下降 | 含防御式（有注释）与隐患（无注释）两类 |
| TODO/FIXME/HACK（src + ui + ui/server + tests） | 24 处 | ≤5 | 需逐条核实业务语义 |
| TS/TSX 文件数 | 1828 | — | 全仓 |
| 测试文件数 | 458 | — | tests/ + ui/src + ui/e2e |
| 后端 >600 行文件 | 42 | 不强制下降（保守档） | 记录待拆建议 |
| UI >600 行文件 | 26 | 不强制下降（保守档） | 记录待拆建议 |
| ui/server JS 文件 | 98 / 29.7K 行 | — | 只做行为不变清理 |

## 七、风险与护栏

- **inputSchema 红线**：任何工具 `inputSchema` 改动都会使 LLM replay fixture 失配（CLAUDE.md 明示）——精炼时禁止改动，说明性文字只放工具顶层 description
- **事件面红线**：AgentEvent/gateway frames 零改动，每卡过 `pnpm check:event-matrix`
- **子包独立验证**：C08 涉及 edgeclaw-memory-core，须先 `pnpm --filter edgeclaw-memory-core build` 再 typecheck/test
- **P0 分流**：审阅发现的行为缺陷只登记，单独开 fix 卡处理，不混入精炼提交
- **提交纪律**：一个关注点一个提交；每日至少 1 个 commit；禁一次性大杂烩提交
- **周复盘**：每周五核对指标计数变化，异常（门禁红、指标反弹）当周修复
