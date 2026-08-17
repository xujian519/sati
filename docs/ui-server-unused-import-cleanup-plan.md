# ui/server 未使用 import 与死代码治理方案

> 状态：执行中（2026-08）｜范围：`ui/server/`（不含 `ui/src/`）
> 来源：用户发现 ui/server 存在大量历史遗留未使用 import（projects.js/agent.js/commands.js 等约 40+ 处，含 CURSOR_MODELS 等死常量），要求制订方案并执行。

## 一、根因

ui/server 在所有 lint 门禁的盲区：

- 根 `eslint.config.mjs` 显式 `ignores: ["ui/**"]`
- `ui/package.json` `lint` 脚本只跑 `eslint src/`（CI "Lint (ui)" job 同一脚本）
- `ui/eslint.config.js` 的 `server/**` 配置块只挂了 `import-x/no-restricted-paths`，未启用 unused-imports 规则

结论：ui/server 的未使用 import/死代码完全不被任何门禁捕获，随重构（轨道 A/B 拆解）与功能迭代持续累积。

## 二、基线清单（scout 全量，102 warnings / 27 文件）

| 类别 | 数量 | 说明 |
|---|---|---|
| A. 未使用 import | 15 处 / 8 文件 | projects.js(os、sessionManager)、sati-bridge.js:1、routes/commands.js:8(CURSOR_MODELS/CODEX_MODELS)+:10、routes/project-files.js×2、routes/projects.js:6、routes/taskmaster.js:18(os)、services/cron-daemon-owner.js:1(crypto) |
| B. 死常量/死本地函数 | 6 处 | gateway.js FEISHU_OPEN_URLS、agent.js createGitHubBranch、memory.js isExternalRecordPath、skills.js expandHome、update.js execInProject、memoryService.js enqueueWorkspaceTask |
| C. catch 子句未用绑定 | ~60 处 | 改可选 catch 绑定 `catch {`（ES2019，语义等价） |
| D. 未用 handler 形参 | 17 处 | commands.js builtInHandlers 统一签名 (args, context) 中未用者直接删除形参 |
| E. 解构未用字段 | 4 处 | memory.js:144 故意剔除字段模式 → `_` 前缀保留语义 |
| F. 赋值未用 | 4 处 | agent.js stdout×2、taskmaster.js errorOutput、sessionManager.js id |
| G. 死文件 | 2 个 | cli.js（旧入口，被 dist/src/cli/sati.js 取代）、always-on-slash.js（always-on 旧 web 路径遗留） |
| H. 测试残留 | 1 处 | commands.test.js vi.doMock(modelConstants) 的 CURSOR_MODELS |
| 附带 | 2 个死 export | shared/modelConstants.js 的 CURSOR_MODELS/CODEX_MODELS 全仓库零消费者（CLAUDE_MODELS 存活） |

## 三、实施顺序（每类一个 commit）

- P1a 类别 A：删 15 处未使用 import
- P1b 类别 C：~60 处 `catch {`
- P1c 类别 D：commands.js 形参瘦身
- P1d 类别 B+F：6 处死常量/死函数删除 + 4 处赋值未用（删除前人工复核函数体）
- P1e 类别 E：memory.js `_` 前缀
- P1f 类别 H + 死 export：test mock 清理 + modelConstants.js
- P2 类别 G：git rm cli.js / always-on-slash.js（先 git log 核对）
- P0 门禁：ui/eslint.config.js server 块启用 unused-imports（warn，与 src 一致）+ lint 脚本扩到 `src/ server/`
- P3 收紧：`--max-warnings 0`（确认 ui/src 与 server 全归零后）

顺序理由：先清理（无门禁噪音）再开闸，一个 PR 内"清理完 + 门禁绿"闭环。

## 四、验证

- 每个改动文件 `node --check`
- `pnpm --filter sati-ui test`（vitest 全量，含 commands/gateway/memory/config/user/sati-bridge 测试）
- `cd ui && pnpm lint && pnpm typecheck`
- 根 `pnpm lint`（防事件矩阵等误伤）＋ `pnpm format:check`

## 五、风险与回滚

| 风险 | 缓解 |
|---|---|
| 死函数删除误伤（实为未接线 bug） | 删除前人工读函数体 + `git log -S <函数名>` 查引入背景 |
| cli.js 被外部脚本/文档路径调用 | 删除前全仓库 grep + 文档检查 |
| 门禁启用后 102 warning 噪音 | 先 P1 全清再 P0 开闸 |
