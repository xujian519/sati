# Agent Note: Pilot 配置校验错误统一汇入诊断通道

Status: implemented

## Problem

Pilot 配置加载的设计契约是「**宽容加载 + 结构化诊断**」：配置有问题时不崩，而是收集诊断让 UI 呈现可读错误。这条契约有一个隐含前提——**所有 fatal 校验错误都必须进入诊断数组**。

但值校验器（`readString` / `readBoolean` / `readOptionalPositiveInteger` / `readOptionalNonNegativeInteger` / `readOptionalPositiveNumber` / `parseStringArray` / `readOptionalRerankStyle` / `readMemoryApiType` / `readOptionalMemoryReasoningMode` / `readCaptureStrategy`，以及 `parseAgentSubagents` / `parseKnowledgeProfile` / `parseMemoryEmbeddingConfig` / `parseMemoryRerankConfig` / `parseMemorySchedule` / `parseMemoryModelRef`）用**裸 `throw new PilotConfigError(code, message)`** 表达 fatal，而 `loadPilotConfig` 只对 `parseModel` 包了 try/catch。

后果是异常绕过诊断通道直接冒泡，且携带的 `diagnostics` 是构造函数的默认空数组：

1. `PilotConfigStore.reload` 捕获后执行 `lastReloadDiagnostics = error.diagnostics`，记下的是**空数组**；
2. 于是 `getDiagnostics()` 只返回上一代成功加载的（通常为空的）诊断 —— 用户看到的错误信息取决于「是哪个校验器先发现问题」，这是纯粹的实现偶然；
3. 契约被破坏：`diagnostics` 为空**不再意味着**配置没问题；
4. 未预期异常（非 `PilotConfigError`）同样绕过该通道，调用方只剩一个原始异常。

## Decision

在 `loadPilotConfig` 的各配置段解析外加一层兜底（`parseConfigSectionsSafely`），把逃逸的异常转写成 fatal 诊断后再抛出：

- 抽出 `parseConfigSections(rawConfig, model, pilotHome, diagnostics)` 承载「逐段解析 + `throwConfigErrorIfFatal`」，`loadPilotConfig` 改为调用 `parseConfigSectionsSafely` 并解构其返回值（顺带把单函数编排的段落边界显式化，向 TD-PILOT-N01 的方向前进一小步）。
- `configFailureDiagnostics(error)` 负责三种输入形态的转写：已携带诊断的 `PilotConfigError` 原样透出副本；**未携带诊断的按 `code` / `message` 转写为 fatal**；其他异常记为 `CONFIG_UNEXPECTED_ERROR` 并留 `logger.warn`（不静默）。
- 转写后统一走既有的 `throwConfigErrorIfFatal(diagnostics)` 抛出，因此**对外可见的 `code` / `message` 与兜底前逐字一致**（`throwConfigErrorIfFatal` 用同一条诊断重建错误）——唯一变化是 `error.diagnostics` 不再为空。
- `pushEscapedConfigFailure` 用 `includes` 去重并入：`throwConfigErrorIfFatal` 抛出的错误其 `diagnostics` 与传入数组是同一引用，此时并入是恒等变换。

不变量恢复为「**存在 fatal 诊断 ⇔ `error.diagnostics` 非空**」。值校验器保持纯函数（仍以 throw 表达 fatal），`PilotConfigError` 的签名不变。

## Alternatives considered

- **让每个值校验器改成 `push` diagnostic 而不 throw（台账「方向 1」，更彻底）** — 落选。需要给 10 个纯 helper 加 `diagnostics` 形参并改约 45 处调用点，且会改变中止语义：坏值不再立即终止该段解析，后续字段会在缺失上下文中继续解析，可能产出语义不通的半成品配置（需额外为每个调用点补 `return undefined` 分支）。收益（多个 fatal 一次性回报）在实践中有限——同一段内的 fatal 本就已被 `throwConfigErrorIfFatal` 批量收集。留作后续选项而非本次范围。
- **给 `PilotConfigError` 加 `path` 字段并在 21 处 throw 点传入** — 落选。诊断的 `path` 是 UI 用来前缀 `path: message` 的，但**每条消息本身已是可读的**：参数化校验器的消息就把 `path` 写进了模板（`agent.maxContextTokens must be a positive integer.`），字面量校验器的消息也自述字段（`memory.embedding requires model.`）。为无实际消费者（仓内暂无读取配置诊断 `path` 的代码）的字段改 21 处 throw，性价比不足。
- **只兜住 `PilotConfigError`，不处理未预期异常** — 落选。那样「非 `PilotConfigError` 绕过诊断通道」这个同源缺口会留下：`PilotConfigStore` 对非 `PilotConfigError` 连 `error.diagnostics` 都读不到，用户仍然只见一个原始异常。代价（可能把编程错误伪装成配置问题）用**独立错误码 `CONFIG_UNEXPECTED_ERROR` + `logger.warn` 留存原始 error** 来对冲。
- **在 `PilotConfigStore.reload` 侧兜底（把空诊断替换为通用消息）** — 落选。那是把信息缺口往下游推：store 拿不到 code 与字段级消息，只能编造一条笼统提示；且 `createPilotConfigStoreSync` 的首载路径根本不经过 store 的 catch。

## Consequences

换来的是：`getDiagnostics()` 的公开契约变可信——诊断为空确实意味着配置没问题；配置错误不再因「走哪个校验器」而呈现不同质量的信息；未预期异常有迹可循（`CONFIG_UNEXPECTED_ERROR` + 日志）。

付出与遗留：

- `parseConfigSections` 的长参数列表（4 个）与 `PilotConfigSections` 的 `ReturnType<typeof ...>` 类型拼装，是「不做 `RuntimeDeps` 式依赖注入」的折中；TD-PILOT-N01 的 monolith 拆分若立项，这里是最自然的切入口。
- **边界情形**：若某段先 `push` 了一条 fatal **但未立即抛出**（如 `parseMemoryConfig` 的 `CONFIG_MEMORY_INVALID` 只 push 不 throw），随后才发生裸 throw，则最终抛出的错误 `code` / `message` 会是**先前那条** fatal 的（`throwConfigErrorIfFatal` 取 `fatalDiagnostics[0]`），而非裸 throw 的那条。两条都在诊断数组里，信息不丢；这是比原先「后者覆盖前者」更正确的次序，但确实是可观察的差异。
- 阈值：`loadPilotConfig.ts` 因此增长约 111 行（兜底逻辑 + 段落抽取的签名与类型）。
