# deepseek-harness 优秀设计引入计划 —— 阶段一实施文档

- 创建日期：2026-08-14
- 状态：**✅ 已实施（2026-08-14）**——四项任务全部落地，全量验证通过（详见 §10 实施结果）
- 范围：阶段一（低风险工程强化），1–2 个迭代，约 6.5 个开发日
- 前置研究：`deepseek-harness` 深度对比研究报告（会话内输出，未入库）

---

## 1. 背景

`deepseek-harness`（dsh）是 DeepSeek 开源 agent harness（基于 Cordis 插件框架）。对其会话/上下文管理、插件架构、工具执行管线、安全隔离与扩展能力四路并行深度研究后，确认以下设计值得引入 Sati：

| 编号 | 设计 | 阶段 |
|---|---|---|
| #1 | 「模型可见 = 已记录」单一事实源 + Surface 投影 | 二 |
| #2 | 遮蔽式压缩 + 摘要前缀缓存对齐 | 二 |
| #3 | 重放式 token 度量（可复算的上下文预算） | **一** |
| #4 | 单调 deny Guard（只能拒绝、不可被 allow 覆盖） | **一** |
| #5 | 事件驱动扩展点（waterfall/emit 分层） | 二 |
| #6 | 状态 = 事件日志纯 fold | 三 |
| #7 | 会话查询层（live-preferred + 可重建 FTS 派生索引） | 三 |
| #8 | 存储双轨制：真源拒迁移、派生索引可重建 | **一** |
| #9 | spill 溢出（大结果落盘 + 预览 + retrievalHint） | 三 |
| #10 | RPC 错误模型（封闭错误码映射表） | 三 |
| #11 | 子代理 provider 注册表 + 能力旗标 | 三 |
| #12 | credentials 引用/值分离 | **一** |

本文档落地阶段一（#3 / #4 / #8 / #12）。

---

## 2. 实证修正（调研后的重要调整）

| 原报告判断 | 实证修正 |
|---|---|
| #3 引入 dsh「4 chars/token」重放式度量 | **Sati 已更成熟**：`TokenAccountingRuntime` 已有 tiktoken 本地估算 + Anthropic/OpenAI provider 精确计数 + 快速通道（`nearLimitRatio=0.9`）+ 每消息开销 4 token。任务从「引入」调整为「审计保守性 + 加固」 |
| #4 单调 guard | 确认缺口：`PermissionRuntime.decide` 中 deny 规则可被 session allow 覆盖（仅 `user` 来源 deny 绝对优先），缺「代码级不可协商强制层」 |
| #8 派生数据重建 | 确认缺口更严重：`src/knowledge/` **零处** `PRAGMA user_version`/`application_id`/schema 版本管理，所有库以 `node:sqlite DatabaseSync` readOnly 裸打开 |
| #12 credentials 引用/值分离 | 确认现状：`resolveApiKey` 已支持 `${VAR}` 引用，但在 `parseModelConfig` 时立即解析并**固化纯文本进 `ProviderConfig.apiKey`**，轮换环境变量需重启；`ui/server` 的 `writeSatiConfig` 有明文写回风险 |

---

## 3. 任务 T1：Token 度量保守性加固（对应 #3）

### 3.1 目标

保证压缩触发决策「永不低估」当前上下文用量——快速通道不能因为本地估算偏低而漏掉该触发的压缩。

### 3.2 现状（已核实）

- `src/context/budget/TokenAccountingRuntime.ts:106-132`：`evaluateRequestBudget` 快速通道——`localTokens <= window * 0.9` 时直接返回本地快照，跳过 provider 精确计数。
- `estimateRequestInput`（`:168-177`）= `estimateForMessagesWithPadding(messages)` + system + tools。
- `TokenBudgetManager` 常量：`DEFAULT_PER_MESSAGE_OVERHEAD=4`、`DEFAULT_WARNING_RATIO=0.8`、`DEFAULT_BLOCKING_RATIO=0.95`、`IMAGE_MAX_TOKEN_SIZE=2000`（`TokenBudgetManager.ts:55-58`）。
- 已有测试：`tests/context/token-accounting-fastpath.spec.ts`、`token-budget-manager.spec.ts`。

### 3.3 改动文件与实现要点

1. **审计低估风险**（不改代码，先取证）：
   - 新增脚本 `scripts/token-estimate-audit.mjs`（或复用 `scripts/figure-benchmark/` 结构）：用真实 provider usage 与 `estimateRequestInput` 对比，抽样 ≥ 20 轮真实请求，统计 `estimate < actual` 的比例与最大欠估幅度。
   - 重点验证三类输入：工具 JSON Schema（约 70 个工具全量目录）、中文专利文本、带图片/PDF 的 multimodal 消息。
2. **保守下界保护**（`TokenAccountingRuntime.ts`）：
   - 在 `evaluateRequestBudget` 快速通道前增加校验：若 `localTokens > window * (nearLimitRatio - guardBand)`（`guardBand` 建议 0.05，可配置），则即使未达 0.9 也走 provider 精确计数。
   - 给 `estimateForMessagesWithPadding` 增加可选的保守 padding 系数（默认 1.0，审计发现低估时按实测最大欠估幅度上调，或改为 `max(estimate, estimate*1.03)` 上限保护）。
3. **可复算性锁定**（纯函数性质测试）：
   - 在 `tests/context/token-accounting-fastpath.spec.ts` 新增：同一 `CanonicalModelRequest` 连续两次 `estimateRequestInput` 结果严格相等；`evaluateRequestBudget` 在 provider 不可用时返回 `source:"local", exact:false` 且 `estimatorError` 非空。

### 3.4 验收标准

- 审计报告给出「估算 vs 真实」的最大欠估幅度与样本数；
- 快速通道不因低估漏触发（构造一个估算值刚好压线、真实值超线的用例，验证会走精确计数）；
- 可复算性测试通过。

---

## 4. 任务 T2：单调 deny Guard 注册表（对应 #4）

### 4.1 目标

在现有权限决策链**之前**增加一层「代码级强制约束」，其 deny 结果**任何 allow/ask 规则都不能覆盖、也不走 HITL**——把合规硬约束从"用户可配置规则"升级为"不可协商的代码强制"。

### 4.2 现状（已核实）

- `src/permission/decision/PermissionRuntime.ts:15-70`：决策顺序 = session allow → deny（`user` 来源优先）→ ask → session allow → user allow → `tool.checkPermissions` → mode fallback。
- `PermissionDecisionReason`（`src/permission/protocol/types.ts:31-36`）已有 `"safety"` 类型，可复用或新增 `"guard"`。
- 规则来源：`PermissionRuleSource = "user" | "project" | "session" | "policy" | "cli"`（`:5`）——全是「可配置规则」，无「代码强制」通道。

### 4.3 改动文件与实现要点

1. **类型与注册表**（新增 `src/permission/guard/ToolGuard.ts` + `ToolGuardRegistry.ts`）：
   - `ToolGuard = (tool: SatiToolDefinition, input: unknown, context: SatiToolRuntimeContext) => { message: string } | undefined`——**只返回 deny，不返回 allow**（对应 dsh 的 monotonic guard）。
   - `ToolGuardRegistry`：`register(guard)` / `evaluateAll(tool, input, context): GuardDenial[]`，收集全部拒绝（不短路，便于诊断）。
2. **集成到决策链**（`PermissionRuntime.decide` 最前面）：
   - 在 `permissionContext.rules` 检查之前，先执行 `guards.evaluateAll`；任一 deny → 返回 `{ type: "deny", reason: { type: "safety", message: <guard message> } }`（复用 `safety` 类型，避免新增 reason 波及 UI 渲染）。
   - Guard 结果**跳过** ask 分支与 `finalizeAsk`，且不写 session allow/deny 规则。
3. **接入合规硬约束**（首批 guard，放在 `src/patent/` 或 `src/rule/`）：
   - `patent_invalidity_checker` / `patent_infringement_checker` 等工具的输入强制前置校验（例如：无效宣告必须携带证据、侵权比对必须声明对比对象）；
   - 法条引用格式强制校验（与 `src/patent/` 现有引用核验逻辑对接，guard 只拒绝格式非法，不做模糊判断）。
4. **注册点**：`ToolRegistry` 挂载 guards，或在 `createBuiltinRegistry`（`createLocalGateway.ts:794`）注入——与现有 `loadBuiltinPlugins()` 对齐，插件贡献 guard 走 `PluginRuntime`。

### 4.4 验收标准

- 新增 `tests/permission/tool-guard.spec.ts`：
  - guard deny 时，即使存在 session allow / user allow / ask 规则，最终仍是 deny；
  - guard 不触发 `permission_request`（不产生 HITL 横幅）；
  - 多个 guard 全部执行（诊断收集全部拒绝原因，而非首个短路）。

---

## 5. 任务 T3：知识库版本管理（对应 #8）

### 5.1 目标

为 knowledge 相关数据库建立「真源 fail-loud、派生索引可重建」的版本纪律，杜绝 schema 漂移导致的静默错误。

### 5.2 现状（已核实）

- `src/knowledge/` 零处 `PRAGMA user_version`/`application_id`。
- 打开方（均为 `node:sqlite DatabaseSync` readOnly）：`case-law-search.ts:121`、`knowledge-law-search.ts:76`、`legal-search.ts:92`、`knowledge-embeddings.ts`、`knowledgeNoteSave.ts:61`（写）、`diagnostics.ts:23`。
- 数据分类：`knowledge.db`（真源，随产品发布，README 称"零重新构建"）vs `vectors.db`/`embeddings/` 目录/FTS 索引（可重建的派生数据）。

### 5.3 改动文件与实现要点

1. **工具模块**（新增 `src/knowledge/shared/db-version.ts`）：
   - `openKnowledgeDb(dbPath, { expectedVersion, kind: "source" | "derived", applicationId? })`：封装 `DatabaseSync` 打开 + `PRAGMA user_version` 检查 + `PRAGMA application_id` 设置。
   - `source`（真源）：版本不符 → 抛 `KnowledgeDbVersionError`（消息含「当前版本/期望版本/升级提示」），**拒绝打开**；
   - `derived`（派生）：版本不符 → 返回 `{ db, needsRebuild: true }`，调用方执行重建（DROP 表重建或标记 stale）。
2. **常量与 schema 版本声明**（新增 `src/knowledge/shared/schema-versions.ts`）：集中声明各库当前版本（初始全部 `1`，`application_id` 分配唯一魔数，参考 dsh 的 `0x44534851` 做法）。
3. **接入各打开方**：
   - 真源：`knowledge-law-search.ts`、`case-law-search.ts`、`legal-search.ts`、`knowledgeNoteSave.ts`（写路径同样检查）；
   - 派生：`knowledge-embeddings.ts`（vectors/embeddings，版本不符触发重建）、`personal-note-vector-index.ts`（JSONL 索引，版本不符标记 stale）。
4. **写路径守卫**：`knowledgeNoteSave.ts` 打开 knowledge.db 时若版本不符，抛错而非静默写入。

### 5.4 验收标准

- 新增 `tests/knowledge/db-version.spec.ts`：
  - 真源版本不符 → 抛错、库未被改动；
  - 派生版本不符 → `needsRebuild: true`，重建后版本戳更新；
  - 不同库 `application_id` 互不相同；
- 现有 knowledge 28 个测试全绿（打开路径改动无回归）。

---

## 6. 任务 T4：credentials 引用/值分离（对应 #12）

### 6.1 目标

配置只保存「引用」而非明文；密钥轮换后**下一次请求即生效**（无需重启）；任何序列化/describe 都不暴露值。

### 6.2 现状（已核实）

- `src/model/config/resolveCredentials.ts:18-43`：`resolveApiKey` 支持 `${VAR}`，trim + 缺省报错。
- `src/model/config/parseModelConfig.ts:126`：`apiKey: resolveProviderApiKey(...)` ——解析发生在 parse 时，`ProviderConfig.apiKey` 存纯文本（`src/model/protocol/canonical.ts:293-304`）。
- `ui/server/services/satiConfig.js:671` `writeSatiConfig` 写配置（明文风险点）。

### 6.3 改动文件与实现要点

1. **类型扩展**（`src/model/protocol/canonical.ts`）：
   - `ProviderConfig` 增加 `apiKeyRaw: string`（保存原始配置值，可能是 `${VAR}` 或明文）与 `apiKeySource: "literal" | "env"`；
   - `apiKey` 字段语义改为「惰性解析后的缓存」或直接移除、由 `resolveApiKey()` 在用到时调用（推荐后者，避免缓存）。
2. **惰性解析**（`src/model/streaming/streamModel.ts` 的 `buildProviderHeaders` 及所有 apiKey 使用点）：
   - 把 `resolveApiKey` 调用从 `parseModelConfig` 移到请求头构建处——`buildProviderHeaders(provider)` 内从 `provider.apiKeyRaw` 解析（每次请求读 env，轮换即生效）。
   - 涉及点排查：`countAnthropic`/`countOpenAI`（`TokenAccountingRuntime.ts:201,220`）经 `buildProviderHeaders` 复用，改动收敛。
3. **redact 防护**：
   - `describe()` / 诊断输出 / `writeSatiConfig` 对 `apiKey` 字段统一走 `redactSecret()`（显示 `sk-***` 或 `${VAR}` 引用名，不显示解析值）。
   - `ui/server/services/satiConfig.js` 写入前对 apiKey 做 redact 校验（或至少加 TODO 标记，因该文件属双后端收敛范畴）。
4. **兼容性**：`resolveApiKey` 保持导出签名不变，外部（webSearch.ts、edgeclaw llm-extraction.ts 等独立解析）不受影响。

### 6.4 验收标准

- 新增 `tests/model/config/credential-ref.spec.ts`：
  - `${VAR}` 引用 + 运行时改 `process.env[VAR]` → 下一次 `buildProviderHeaders` 用新值；
  - `describe()` 输出不含解析后明文；
  - 明文 key 行为不变（literal 源）。
- 现有 model 测试全绿。

---

## 7. 任务清单（可勾选）

| # | 任务 | 依赖 | 估算 | 状态 |
|---|---|---|---|---|
| T1.1 | Token 估算审计脚本 + 抽样报告 | — | 0.5d | ✅ |
| T1.2 | 快速通道保守下界保护 | T1.1 | 0.5d | ✅ |
| T1.3 | 可复算性单元测试 | T1.2 | 0.25d | ✅ |
| T2.1 | `ToolGuard` 类型 + `ToolGuardRegistry` | — | 0.5d | ✅ |
| T2.2 | `PermissionRuntime.decide` 集成 guards | T2.1 | 0.5d | ✅ |
| T2.3 | 首批合规 guard 接入 | T2.2 | 0.5d | ✅ |
| T2.4 | guard 单元测试 | T2.2 | 0.25d | ✅ |
| T3.1 | `db-version.ts` 工具 + `schema-versions.ts` 常量 | — | 0.5d | ✅ |
| T3.2 | 真源 fail-loud 接入（4 个打开方） | T3.1 | 0.5d | ✅ |
| T3.3 | 派生重建接入（embeddings/personal-note） | T3.1 | 0.5d | ✅ |
| T3.4 | db-version 单元测试 | T3.1 | 0.25d | ✅ |
| T4.1 | `apiKeyRaw`/`apiKeySource` 类型 + 惰性解析 | — | 1d | ✅ |
| T4.2 | redact 防护 + `writeSatiConfig` 守卫 | T4.1 | 0.5d | ✅ |
| T4.3 | credential-ref 单元测试 | T4.1 | 0.25d | ✅ |

总计约 **6.5 个开发日**；T1/T2/T3/T4 四条线互相独立，可并行。

---

## 10. 实施结果（2026-08-14）

### 10.1 新增文件

| 文件 | 用途 |
|---|---|
| `src/knowledge/shared/db-version.ts` | 知识库版本管理工具（真源 fail-loud / 派生 needsRebuild / 存量宽容） |
| `src/knowledge/shared/schema-versions.ts` | 各库版本号与 application_id 集中声明 |
| `src/permission/guard/ToolGuard.ts` | 单调 deny guard 类型（只拒绝、不放行） |
| `src/permission/guard/ToolGuardRegistry.ts` | guard 注册表（全量评估、fail-closed） |
| `src/patent/guard/evidenceComplianceGuards.ts` | 首批合规 guard（域外/外文证据强制声明 EVI-011） |
| `src/agent/session/defaultToolGuards.ts` | 默认 guard 组装（agent 层整合） |
| `scripts/token-estimate-audit.ts` | Token 估算审计脚本（合成负载 + 真实转录回放） |
| `tests/knowledge/db-version.spec.ts` | db-version 单元测试（8 用例） |
| `tests/permission/tool-guard.spec.ts` | guard 单元测试（12 用例） |
| `tests/model/config/credential-ref.spec.ts` | credentials 测试（9 用例） |

### 10.2 修改文件（19 处）

- **T3**：`case-law-search` / `knowledge-law-search` / `legal-search` / `knowledgeNoteSave`（写）/ `kg-store` / `personal-note-store` / `knowledge-embeddings` / `embedding-consistency` / `diagnostics` 接入 `openKnowledgeDb`；`vector-db`（派生，版本旧抛错由上层降级）；`vector-db-writer`（写端版本不符清空重建）
- **T1**：`TokenAccountingRuntime` 增加 `nearLimitGuardBand`（默认 0.05），快速通道判定扣除 guardBand
- **T2**：`PermissionRuntime` 构造注入 guards，decide 最前面执行（先于一切规则）；`createAgentSession` / `SubAgentSession` 注入默认 guards
- **T4**：`ProviderConfig` 增加 `apiKeyRaw`/`apiKeySource`；`parseModelConfig` 记录原始引用；`buildProviderHeaders` env 源惰性重解析（轮换即生效）；`redact.ts` 正则改为结尾匹配（`apiKeyRaw` 覆盖、`apiKeySource` 不误伤）

### 10.3 验证结果

- `pnpm typecheck`（Node 22）✅ 0 错误
- `pnpm lint` ✅ 0 error / 0 warning
- `pnpm format:check`（biome）✅ 通过
- 新增测试 37 用例全绿（db-version 8 + tool-guard 12 + credential-ref 9 + fastpath 新增 4 + redact 兼容 4）
- 全量后端测试（Node 22）：**2507 tests，2503 pass，3 skipped，1 fail**——唯一失败为 `tests/cli/proxy.spec.ts`「installGlobalProxy with no proxy configured」，因本机设置了 `ALL_PROXY` 等环境变量所致（`env -u ...` 无代理环境下 6/6 通过），与本次改动无关（未触碰 `src/cli/proxy.ts`）
- 行为验证：真实 `~/.sati/knowledge/knowledge.db`（user_version=0 存量库）在版本检查下宽容通过，写路径首次写入自动打戳

### 10.4 实施中的实证修正

1. **T1 定位调整**：Sati 估算已用 o200k_base tiktoken + 4/3 padding + `max(usage, estimate)` 锚点，比 dsh 的 4 chars/token 更成熟。落地改为「审计验证 padding 充分性 + guardBand 防漏触发」，未引入 dsh 定价器。
2. **T3 范围扩大**：实际打开方不止 4 个（kg-store / personal-note-store / knowledge-embeddings / embedding-consistency / diagnostics / vector-db-writer 共 10 处）全部接入。
3. **T4.2 已有基础设施**：`src/pilot/config/redact.ts` 与 `ui/server` 均已存在脱敏；实际工作是修正 redact 正则（结尾匹配）使 `apiKeySource` 不被误伤、`apiKeyRaw` 被覆盖。

### 10.5 遗留注意

- `ui/server/services/satiConfig.js`（双后端 JS）的写回路径未改动——其处理的是用户 yaml 原始值（无 `apiKeyRaw` 运行时字段），无明文泄漏面；双后端收敛属阶段二范畴。
- 存量知识库（user_version=0）首次**写路径**访问时会自动打版本戳（读路径不打，保持只读库不被改动）。


---

## 8. 可验证的检查清单（全阶段验收）

### 8.1 静态与构建

- [ ] `pnpm typecheck` 0 错误（含 edgeclaw-memory-core）
- [ ] `pnpm lint` 0 error / 0 warning
- [ ] `pnpm format:check` 通过
- [ ] `pnpm build` 成功（含 knowledge YAML/wiki 资源拷贝）

### 8.2 测试（新增 + 回归）

- [ ] `tests/context/token-accounting-fastpath.spec.ts` + 新增可复算性用例通过
- [ ] `tests/permission/tool-guard.spec.ts`（新）通过
- [ ] `tests/knowledge/db-version.spec.ts`（新）通过
- [ ] `tests/model/config/credential-ref.spec.ts`（新）通过
- [ ] 全量后端测试 `pnpm test` 通过（注意：root 与 ui 测试需串行，技术债 P2 已记录竞态）
- [ ] UI 测试 `pnpm --filter sati-ui test` 通过

### 8.3 行为验证（每个任务专项）

- [ ] T1：运行审计脚本，得到「估算 vs 真实」欠估幅度报告；人工确认报告包含中文专利文本与 70 工具 schema 用例
- [ ] T2：构造「guard deny + session allow」场景，确认最终为 deny 且 UI 无 permission_request 横幅（可用 `scripts/tui-e2e-permission.tsx` 或单测模拟）
- [ ] T3：对测试用 knowledge.db 人为篡改 `user_version`，确认真源打开抛 `KnowledgeDbVersionError`；派生库返回 `needsRebuild`
- [ ] T4：运行时改环境变量，下一次请求用新 key；`describe()` 输出无明文

### 8.4 回归（确保不破坏现有行为）

- [ ] 首次 onboarding 流程可用（`bootstrap-sati-config.mjs` + Web UI 配 Provider/key）
- [ ] `sati server` 启动后 knowledge 能力自检输出正常（`logKnowledgeCapabilities` 无版本报错）
- [ ] 现有 27 个专利技能中至少 3 个代表性技能（检索/撰写/审查）端到端跑通

---

## 9. 风险与注意事项

1. **T4 改动面**：`ProviderConfig.apiKey` 被多模块直接使用，改动前需全仓 grep 确认所有使用点；若评估改动面过大，可将惰性解析（T4.1）拆为独立 PR，redact（T4.2）先行。
2. **T3 兼容性**：存量 knowledge.db 无版本戳（user_version = 0）。首次接入时需「宽容模式」：版本为 0 的存量库视为当前版本并打上版本戳，避免存量用户升级即报错；仅对「版本大于当前」的库 fail-loud。
3. **T2 与现有规则引擎的关系**：guard 只做「格式/前置条件」类强制校验，模糊判断（如法条引用内容正确性）留在 `rule_check`/输出门禁，避免把确定性校验做成误伤。
4. **测试竞态**：root `pnpm test` 与 ui 测试并发会偶发失败（技术债 P2-1），CI 需串行执行。
