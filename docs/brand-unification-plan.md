# 品牌统一（PilotDeck → Sati）彻底收尾技术方案

- 方案日期：2026-08-13
- 状态：已实施（2026-08-13，对应提交 `3b0099c2..9e348565`）
- 前置背景：`docs/technical-debt-report.md`（2026-08-12 二次审计）标记「品牌双轨（pilotdeck / sati）」与「ui/server 深层 import src/」无进展
- 本方案只解决**品牌统一**这一条债务线；「ui/server 双后端收敛」「深层 import src/ 收敛」为独立专项（见债务报告 §五 第 8 条），不在此范围内

---

## 一、目标与边界

### 目标

消除 `ui/server` 内完整复制的 pilotdeck 双轨死代码与全部品牌残留，使代码库中仅存两类合法 `pilotdeck` 字样：

1. **开源来源声明**（LICENSE / THIRD_PARTY_NOTICES / README 的「源自 PilotDeck」）——法律义务，永不删除
2. **升级兼容层**（老用户 `~/.pilotdeck` 数据 / `PILOTDECK_*` 环境变量迁移回退）——有意保留，统一标注 `legacy(pre-rebrand)`

### 非目标（明确排除，避免误删）

- 不动 `LICENSE` / `THIRD_PARTY_NOTICES.md` / `CHANGELOG.md` / `README.md` / `README.zh.md`（来源声明与历史记录）
- 不动 `apps/desktop/resources/*.tar`、`apps/desktop/dist-electron/`、`.cache/`（均已被 `.gitignore` 覆盖，`git ls-files` 未追踪，为构建产物）
- 不改 `ui/server` 对 `src/` 的深层 import（属「双后端收敛」专项）
- 不删除升级兼容层（老用户数据迁移路径）

---

## 二、已验证的现状清单（2026-08-13 实测）

调研方法：`rg`/`grep` 静态 + 动态 `import()` 引用扫描、`codegraph` caller 查询、`git ls-files` 追踪状态、sati/pilotdeck 双轨函数签名 diff 比对。

### A 类：完全孤立的死代码（11 个文件，可彻底删除）

已逐项验证「运行时零引用」——静态 import、动态 `import()`、React 组件引用均无：

| # | 文件 | 规模 | 死因验证 |
| --- | --- | --- | --- |
| 1 | `ui/server/pilotdeck-bridge.js` | 67KB | 唯一入口 `ui/server/index.js:88` 已切 `sati-bridge.js`（注：index.js 已于 2026-08-17 分片为 entry 组装骨架，行号失效）；函数签名 diff 证明 `sati-bridge.js` 是超集（多出 `readGatewayToken`/`tokenBudgetFromCompact`/`approvalDecideViaGateway`/`approvalListPendingViaGateway`/`loadPersistedStatsFromDiskUncached`） |
| 2 | `ui/server/pilotdeck-message.js` | 1KB | 仅被 #1 引用 |
| 3 | `ui/server/pilotdeck-bridge.test.js` | 5.7KB | #1 的测试 |
| 4 | `ui/server/services/pilotdeckConfig.js` | 27KB | `satiConfig.js` 是超集（多出 provider 全量校验、`SATI_*` 环境变量、旧 home 回退）；仅被 #5/#6 引用 |
| 5 | `ui/server/services/pilotdeckConfigReloader.js` | 0.9KB | 仅被 #6 引用 |
| 6 | `ui/server/services/pilotdeckConfigWatcher.js` | 5KB | 无任何 import 引用 |
| 7 | `ui/server/services/pilotdeckConfig.test.js` | 6.5KB | #4 的测试 |
| 8 | `ui/server/utils/isPilotDeckSessionKey.test.js` | 3.5KB | 对应函数 `isPilotDeckSessionKey` 位于 #1 内 |
| 9 | `ui/src/hooks/usePilotDeckConfig.ts` | 424 行 | `useSatiConfig.ts` 已替代；`ui/src/components/settings/` 全部引用 `useSatiConfig`（`Settings.tsx:2/140-142` 及 11 个 view 子模块） |
| 10 | `ui/src/hooks/usePilotDeckConfig.test.tsx` | — | #9 的测试 |
| 11 | `scripts/bootstrap-pilotdeck-config.mjs` | ~200 行 | `package.json:15/22` + `ui/package.json:13` 的 `prebuild`/`predev` 均已切 `bootstrap-sati-config.mjs` |

### B 类：升级兼容层（13 处，保留 + 统一标注）

| # | 位置 | 性质 |
| --- | --- | --- |
| 1 | `src/adapters/channel/weixin/WeixinChannel.ts:1008` | `~/.pilotdeck/weixin-credentials.json` 回退 |
| 2 | `src/cli/proxy.ts:24` | `PILOTDECK_PROXY` 环境变量兼容 |
| 3 | `src/web/server/listProjects.ts:30` | `~/.pilotdeck/projects` 旧项目回退 |
| 4 | `src/context/memory/edgeclaw-memory-core/src/core/general-projects.ts:16` | `LEGACY_GENERAL_WORKSPACE_DIR` |
| 5 | `ui/server/load-env.js:19-34` | `PILOTDECK_*` → `SATI_*` 环境映射 |
| 6 | `ui/server/constants/config.js:13-22` | `PILOTDECK_DISABLE_LOCAL_AUTH` |
| 7 | `ui/server/database/db.js:61-63` | 旧 `~/.pilotdeck/auth.db` 迁移 |
| 8 | `ui/server/routes/agent.js:888-894` | `provider:"pilotdeck"` 别名归一为 `sati` |
| 9 | `ui/server/utils/proxy.js:22` | `PILOTDECK_PROXY` 回退 |
| 10 | `apps/desktop/src/server-manager.ts:945,978-979` | 清理子进程 `PILOTDECK_*` env |
| 11 | `scripts/bootstrap-sati-config.mjs:214-216` | 旧 `~/.pilotdeck/pilotdeck.yaml` 迁移 |
| 12 | `scripts/check-node-runtime.mjs:46-51` | 测试 hook（`PILOTDECK_RUNTIME_CHECK_TEST_MODE`） |
| 13 | `src/env.ts:7-9` | 注释（指向 `docs/pilotdeck-merge-plan.md`） |

### C 类：数据层 provider 标识（12 处，需统一为 `sati`）

`src/web/server/readSessionMessages.ts` 内 12 处硬编码 `provider: "pilotdeck"`（`:222` `:309` `:384` `:398` `:425` `:446` `:470` `:500` `:517` `:750` `:807` `:844`）。经查为**新生成的历史消息帧**品牌标签（`source: "history"` / `role: "system"`，如 `createIncompleteTurnStatusMessage`），并非从历史 jsonl 透传；前端 `ui/src` 无任何 `provider === "pilotdeck"` 判断 → 可安全统一为 `"sati"`。

### D 类：注释/文档残留（更新，非删除）

- `src/web/client/eventMapping.ts:6` 注释（提及 `pilotdeck-bridge.js`，删除后需同步）
- `docs/design/gateway-chat-direct-connect.md:146`（提及 pilotdeck-bridge 退役计划）
- `docs/technical-debt-report.md`（本次修复后更新状态）

---

## 三、分阶段实施计划

### 阶段 0：基线快照（可复现验收基准）

```bash
git status && git log --oneline -1          # 记录起点
pnpm typecheck                               # 期望 0 错误
pnpm lint                                    # 期望 ≤1 warning（evaluator.ts:121，与本次无关）
cd ui && pnpm test                           # 期望全绿
```

### 阶段 1：删除 A 类死代码（核心动作，风险最高）

**步骤**：`git rm` 11 个文件 → 全量验证。

**DoD**：
- `git status` 显示仅 11 文件被删，无其他改动
- `pnpm typecheck` 0 错误
- `pnpm lint` 无新增告警
- `cd ui && pnpm test` 全绿（重点：`satiConfig.test.js`、`sati-bridge.test.js`、`useSatiConfig` 相关仍通过）
- 桌面端 `apps/desktop` 无引用报错

**关键安全网**：删除前执行
`rg "pilotdeck-bridge|pilotdeckConfig|usePilotDeckConfig|pilotdeck-message" ui/ src/ apps/ scripts/ --stats`
确认仅命中「被删文件自身 + 待改注释」，无活引用。

### 阶段 2：统一 C 类 provider 标识

`readSessionMessages.ts` 12 处 `provider: "pilotdeck"` → `"sati"`（单文件全局替换）。

**DoD**：
- `grep -n '"pilotdeck"' src/web/server/readSessionMessages.ts` 返回 0
- `pnpm typecheck` 通过
- `tests/web/` 相关 spec 全绿

### 阶段 3：B 类兼容层统一标注

对 13 处兼容代码，将注释规范化为统一标签（不改逻辑）：

```ts
// legacy(pre-rebrand): 兼容 PilotDeck 旧 home/环境变量，升级用户数据迁移用
```

**DoD**：
- `grep -rn "legacy(pre-rebrand)" src/ ui/server/ scripts/ apps/desktop/` 覆盖 13 处
- 纯注释改动，`pnpm typecheck` 通过即确认零行为变化

### 阶段 4：D 类注释/文档更新

- `src/web/client/eventMapping.ts:6`：注释删除 `pilotdeck-bridge.js` 提及，仅保留 `sati-bridge.js`
- `docs/design/gateway-chat-direct-connect.md:146`：更新为「pilotdeck-bridge 已删除（2026-08-13 品牌统一收尾）」

### 阶段 5：全量验证 + 报告更新

```bash
pnpm typecheck && pnpm lint && pnpm format:check
cd ui && pnpm typecheck && pnpm test
pnpm build                                   # 确认 dist 构建链无残留引用
```

更新 `docs/technical-debt-report.md` 的品牌双轨条目状态。

---

## 四、风险与回滚

| 风险 | 概率 | 缓解 |
| --- | --- | --- |
| `pilotdeck-bridge.js` 存在未被 grep 捕获的运行时引用（如 `require` 拼接路径） | 低 | 阶段 0 先 `rg` + `codegraph` 双确认；删除后立即 `pnpm build` |
| `usePilotDeckConfig` 被某懒加载/动态路径引用 | 极低 | 已确认无静态/动态 import；`cd ui && pnpm typecheck && pnpm test` 兜底 |
| `readSessionMessages` provider 改动影响前端历史会话展示 | 低 | 前端无 `provider==="pilotdeck"` 判断；异常则仅回滚阶段 2 单文件 |
| 删除后 `satiConfig.test.js` 依赖被误删的共享代码 | 无 | `satiConfig.js` 与 `pilotdeckConfig.js` 是独立副本，非共享 |

**回滚**：每阶段独立 commit（Conventional Commits，`chore(brand): ...`），任一阶段验收失败即 `git revert` 该 commit。

---

## 五、提交规划

```
阶段1: chore(brand): remove pilotdeck dead-code bridge/config/hook (11 files)
阶段2: chore(brand): unify history-message provider label to "sati"
阶段3: chore(brand): tag pre-rebrand compat shims as legacy(pre-rebrand)
阶段4: chore(brand): update stale pilotdeck references in comments/docs
```

---

## 六、最终验收标准

```bash
# 除来源声明/兼容层/构建产物外，pilotdeck 残留应仅剩 B 类兼容层所在文件
rg -il "pilotdeck" src/ ui/ scripts/ apps/desktop/src/ \
  | grep -vE "THIRD_PARTY|LICENSE|CHANGELOG|README"

# 死代码文件已全部移除
test ! -e ui/server/pilotdeck-bridge.js \
  && test ! -e ui/server/services/pilotdeckConfig.js \
  && test ! -e ui/src/hooks/usePilotDeckConfig.ts \
  && echo "A 类死代码清除完成"

# 全量质量门禁
pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && (cd ui && pnpm typecheck && pnpm test)
```
