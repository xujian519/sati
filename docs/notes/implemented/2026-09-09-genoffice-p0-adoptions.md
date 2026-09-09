# Agent Note: GenOffice P0 设计引入（循环守卫/输入脱敏/输出上限自愈/外链门控）

Status: implemented

## Problem

对 GenOffice（genspark-ai/genoffice，Apache-2.0）的深度调研确认了若干 Sati 缺失的成熟设计，其中 P0 级六项：用户把 API key 粘进会话会原样进入远端模型 API；doomLoop 的工具循环检测器忽略工具输出导致 poll 型工具（同参数、输出会变）被误报；模型的「已验证」类收尾声称无前置一致性校验（registerLeak 只做事后报告）；自定义 endpoint 对超上限的 max_tokens 返回 400 且无恢复路径；压缩摘要可能把模型自产数字固化成「既定事实」；桌面壳 `setWindowOpenHandler` 把任意协议 URL 直通 `shell.openExternal`。

对照 Sati 源码核实后，原清单中三项已有等价或更强机制，不做：MicroCompactionEngine 已覆盖 mid-run 陈旧工具输出瘦身；streamInterruption/getSelfCorrectPrompt/max_output_recovery 已覆盖工具输入反馈与空流恢复；modelFailureAction 已覆盖 overload/credits 分类。

## Decision

六个工作项按五次提交落地（同分支 `feat/genoffice-p0-adoptions`）：

1. **输入脱敏**（`src/agent/turn/sanitizeAgentInput.ts`）：TurnRunner 入口对用户输入做三类正则替换（API key ≥16 字符 / URL userinfo / 密码赋值），脱敏后文本同时进 transcript 与模型可见消息，维持「模型可见 = 已记录」；发生脱敏时发 `warning`（code `payload_redacted`）。
2. **doomLoop 输出感知**（`src/agent/loop/doomLoop.ts`）：ToolCallLoopDetector 窗口键加入 `resultDigest`（长度 + 首段 FNV-1a）；输出变化断链重置，同参数同输出连续 3 次才报。软信号语义（fatal=false）不变。
3. **声称-行动守卫**（`src/agent/loop/claimGuard.ts`）：`handleNoToolCalls` 在 stop hooks 后、元认知检查前，检查收尾文本的验证类声称 vs 本 run 成功执行的支撑工具（`CLAIM_SUPPORT_TOOLS`）；无支撑则经 `continueWithTransientPrompt` 纠正一轮，每 run 至多一次。开关 `SATI_CLAIM_GUARD`（默认关），接线照抄 metacognitiveControl 三件套（env.ts / AgentRuntimeConfig / createLocalGateway）。
4. **输出上限自愈**（`modelErrors.ts parseOutputCapRejection` + `handleModelError` 顶部）：400/422/invalid_request 且文案含 max_tokens 关键词时解析天花板（requested 已知取其下最大「上限形」数字；未知取第二大），写入 `TokenCapManager` 的 session 级 `hardMaxOutputTokens`（跨 turn 保留），`continue` 隐形重试一次。有界一次（`hasAttemptedOutputCapRetry`）。
5. **摘要来源标注**（`summaryBuilders.ts`）：压缩摘要系统提示追加数字来源纪律——用户/工具来源的数字保留出处，模型自产无来源数字标 `(unverified)`。
6. **外链门控**（`apps/desktop/src/safe-external-url.ts`）：`isSafeExternalUrl`（http/https 白名单 + `new URL()` 解析）+ `openExternalSafely`；桌面壳全部 4 处 `shell.openExternal` 收敛到单点，拒绝时仅 warn 不回退原始输入。

## Alternatives considered

- **整体移植 GenOffice agent-core** — 落选：其循环无 durable transcript/审批/事件广播/跨进程续算，history 仅内存数组；Sati AgentLoop 体系更强，只吸收局部机制。
- **声称守卫复用 registerLeak（import 其正则）** — 落选：loop 模块将依赖 context/workspace；改为自含正则（语义对齐、注释注明分工），保持 loop 零 context 依赖可独立测试。两层共存：钩子管收尾前一致性行动，registerLeak/输出门禁管交付后合规。
- **脱敏放 gateway 层** — 落选：gateway 只覆盖网关入口，子代理/团队唤醒等路径旁路；TurnRunner 是所有 turn 的必经点。代价是 transcript 存脱敏版（用户原文仅存于 `user_prompt_submitted` 事件之外不可再取回）——与「模型可见 = 已记录」一致，是刻意选择。
- **新增 turn 级 identical-signature 检测器**（GenOffice 的 [文本+工具+输出] 三元组签名） — 落选：`ToolCallObservation.result` 字段已在，改造现有 ToolCallLoopDetector（加 digest）改动面最小；Sati 已有 TextRepetitionDetector/CycleDetector 覆盖其余维度。
- **在 provider 层解析 400 并填 `error.maxOutputTokens` 协议字段** — 落选（暂缓）：字段已声明但需改 4 个 provider 协议实现；loop 层单点文本解析（message 已归一）覆盖全部 provider，`error.maxOutputTokens` 若未来有产出方会被解析器优先采信。后续若做 provider 层错误归一可迁移。
- **W2 引入 `mutated` 标志贯通工具运行时**（GenOffice 的 mutation 豁免） — 落选：Sati 变更型工具的输出通常含时间戳/路径（输出自然变化），digest 断链已覆盖主要场景；贯通 mutated 标志需改 ToolRuntime 契约，收益不成比例。

## Consequences

- 换来：隐私面（密钥不出本机）、弱模型误报减少、声称-收尾一致性有前置校验、自定义 endpoint 的 400 自愈、压缩摘要数字可追溯、桌面壳 scheme 攻击面关闭。
- 付出：脱敏不可逆（transcript 不再保留原文密钥）；声称守卫接受少量误报（引述用户原话「已验证」也会触发，代价仅一轮，默认关）；上限解析依赖报错文案启发式（有界一次 + ≥1024 门槛兜底）。
- 事件矩阵新增两个 emit 边（TurnRunner `payload_redacted`、AgentLoop `output_cap_learned`），`docs/event-producer-consumer.md` 已随本分支重新生成。
