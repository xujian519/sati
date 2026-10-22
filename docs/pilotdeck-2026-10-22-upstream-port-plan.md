# Sati × PilotDeck 引入方案（2026-10-22 批次）

Status: 本批推荐项已落地（#654、#645 鉴权/Lark 域名/IM 控制器、#665、可选频道 ESM require）

范围基线：上游 **v2026.10.13-r2（`783499f`，2026-10-13）+ #648/#649（2026-10-15）**，即
`pilotdeck-2026-10-13-upstream-port-plan.md` 的实际已消耗边界；评估时点上游 **v2026.10.20**
（`96226d8`，2026-10-20），逐项核对 `merged_at`。

基线校正：上一份文档自述覆盖「#600–#647」，但其评估时点在 10-13，**#637 / #642 / #645
（10-15～10-16 合并）从未进入判定**。其中 #654 取代同日初版 #637，本批按 #654 的最终态移植。

## 一、增量分诊

| PR | 内容 | 判定 | 依据 |
|---|---|---|---|
| #654（#637 为其初版） | tree-sitter 解析 shell 命令与权限缺口 | **P0 已落地** | Sati 可复现换行只读绕过与 allow 跨命令匹配 |
| #645 | IM 回复流式化 + 飞书鉴权/生命周期 + Slack/Telegram 可用 | **P0/P1 已落地（鉴权、Lark 域名、控制器、飞书生命周期、ESM require）** | 飞书 webhook 多种配置下接受未鉴权事件；控制器无节流/取消；ESM `require` 使频道不可用 |
| #665 | 辅助模型请求不再强制关 thinking | **P1 已落地** | 两行；重放键不投影 thinking |
| #642 / #653 | UploadStore 扩展名保留 | 不适用 | Sati 无 `src/gateway/dialog/UploadStore.ts`；`ui/server/services/uploads.js` 已保留原名与扩展名并用 `COPYFILE_EXCL` |
| #650 | 桌面原生缩放指示器 | 不适用 | 桌面端已分叉 |
| #652 | Electron 下载限流 / Linux 包校验 | 不适用 | Sati 不维护 Linux，打包管线已分叉 |
| #655 / #656 / #660 | `standalone_alpha1` 的 SOP / 知识插件 / 模块对齐 | 不适用 | 独立分支与产品线，不是 main 同步对象 |
| #668 | macOS Intel 公证 TCP 修复 | 条件搁置 | 仅在仍产 Intel mac 且走同一公证链时相关 |
| #640 / #670 / #671 / #673 | 华为 OBS 发布同步 CI | 不适用 | Sati 自有发版体系 |

## 二、落地项

### P0-1 #654 bash 权限按解析树判定

- 落点：新增 `src/tool/builtin/bash/parser.ts`；改造 `src/tool/builtin/bash/permissions.ts`、
  `src/permission/policy/matchPermissionRule.ts` 的 bash 分支、`src/tool/execution/ToolRuntime.ts`
  的权限前预加载；新增两组上游回归测试与 Sati 复现用例。
- 保留 Sati 独有语义：`text:` 关键词规则、文件写入的真实落点（软链）校验。
- 决策记录：`docs/notes/implemented/2026-10-22-bash-permission-tree-sitter.md`。
- 负控制：allow 退回整串匹配 → 5 条转红；只读候选截成首条命令 → 3 条转红（含 Sati 换行回归）。
- 验证：定向 34 例、工具/权限/网关面 794 例、全量 `pnpm test` 5907 pass / 0 fail；`pnpm check` green。
- 未验证：桌面安装包内的 WASM 解析（开发态与 `dist` 直跑已验）；漏包时退化为逐次询问（fail-safe）。

### P0-2 #645 飞书 webhook 鉴权与 Lark REST 域名

已落地。要点：

- 鉴权抽到新模块 `src/adapters/channel/feishu/feishu-webhook-auth.ts`：headers 透传、至少一种密钥、
  token 常量时间比较、`x-lark-signature` 覆盖原始 body、加密 `url_verification` 的无签名例外。
- 入站事件解析抽到 `feishu-inbound.ts`，让 `FeishuChannel.ts` 从 1404 行回落到 1286 行（存量文件
  棘轮不再触发）。
- 旧配置迁移口径：**fail closed**。`verifyToken`/`encryptKey` 都为空时回调返回 401，启动打 error；
  设置页新增两个输入框与未配置警告，`/status` 只回布尔值，保存留空保持原值。
- REST base URL 跟随 `domainName`（`open.feishu.cn` / `open.larksuite.com`）。
- 决策记录：`docs/notes/implemented/2026-10-22-feishu-webhook-auth.md`。
- 负控制：移除「无密钥拒绝」→ 1 条转红；允许缺 token → 2 条；跳过签名 → 4 条；域名硬编码回
  Feishu → 1 条。
- 验证：定向 10 例（含既有权限回复用例）、UI 全量 1486 pass、全量 `pnpm test` 5916 pass /
  5 skipped / 0 fail、`pnpm check` green。
- 未验证：未用真实飞书/Lark 租户发起回调；签名/AES 用本地等价报文验证，字段不符时表现为 401。

### P1-1 #665 辅助请求不再强制关 thinking

已落地。删除 `CompactionEngine` 摘要请求与 `classifyAndRoute` judge 请求中的
`thinking: { enabled: false }`，让辅助请求继承模型默认 thinking 策略；不支持的模型不再因该字段
被 provider 拒绝。回归断言见 `tests/context/compaction-engine.spec.ts` 与
`tests/router/tokenSaver/classifyAndRoute.spec.ts`；负控制（加回覆写）对应 2 条转红；
验证：定向 28 例、全量 `pnpm test` 5916 pass / 5 skipped / 0 fail、`pnpm check` green。
决策记录：`docs/notes/implemented/2026-10-22-aux-thinking-policy.md`。

### P1-2 #645 IM 回复控制器与频道生命周期

已落地。

- 控制器：非阻塞缓冲 + 合并调度、`minEditIntervalMs`（飞书 1.5s）、`maxEditsPerMessage`（飞书 20，
  预留最终编辑后换新消息）、工具边界后台定稿、`cancel()`、FIFO `runExclusive`、代码围栏切分；
  新增 `src/adapters/channel/protocol/ImCodeFences.ts` 与 4 例控制器测试（`im-live-reply-controller.spec.ts`）。
- 飞书生命周期：`stopped`/`stopAbort`、`stop()` 取消 active reply/watchdog/入站批次并在 5s 上限内
  中止在途回合、transport 校验当前回合、处理中表情并行发起、REST 经 `fetchApi` 继承停止信号；
  新增 `tests/adapters/feishu-lifecycle.spec.ts`。
- 负控制：旧控制器 → 3 条控制器用例转红；移除 `stopped = true` → 生命周期用例转红；恢复后定向
  5 例、IM 相关 28 例全绿；全量 `pnpm test` 5921 pass / 5 skipped / 0 fail、`pnpm check` green。
- 技术债：按门禁显式追认 `architecture-baseline.json`（控制器 1017→1241、FeishuChannel 1337→1388）。
- 决策记录：`docs/notes/implemented/2026-10-22-im-reply-controller-lifecycle.md`。
- 未验证：真实飞书 20 次编辑上限/节流；代码围栏保护尚无 Sati 频道 opt-in。

### P1-3 可选频道 ESM `require`

已落地。8 处裸 `require` 改为模块级 `createRequire(import.meta.url)`，覆盖 discord/matrix/
dingtalk/slack/email/sms/telegram 与 `ws` 回退路径；保持可选 SDK 的惰性加载与「未安装可捕获」
语义。回归判据 `tests/adapters/channel-esm-require.spec.ts`：静态锁定 8 个文件的声明顺序，
运行期断言 `resolveWebSocketImpl()` 返回 `ws.WebSocket`。负控制：回退源文件后 2 例均转红；
恢复后 2/2 绿；全量 `pnpm test` 5923 pass / 5 skipped / 0 fail、`pnpm check` green。
决策记录：`docs/notes/implemented/2026-10-22-esm-optional-channel-require.md`。
未验证：七个可选 SDK 不在依赖内，CI 不建立真实连接。

## 三、明确不做

- 不整包移植 #645 的 Slack Socket Mode 与 UI 工作台改动；先恢复现有 Webhook/轮询路径的可用性。
- 不引入 #642/#653 的上传存储重构（Sati 无对应模块且现有实现更强）。
- 不引入桌面、Linux、standalone 分支与发布 CI 改动。

## 四、验证口径

- 每项：定向测试 + 受影响的邻近套件 + `pnpm check`；涉及核心执行链的跑全量 `pnpm test`。
- 每项附负控制：临时退回旧行为，确认新增回归用例转红，再恢复。
- 生成物：`pnpm gen:event-matrix`、`pnpm measure:update`、`pnpm gen:doc-claims` 随代码变更提交。
