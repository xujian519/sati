# Agent Note: token 计数放行特殊 token 字面量（上游 #574 移植）

Status: implemented

## Problem

`src/context/budget/tokenizer.ts` 的 `countTokens` 在文本包含特殊 token 字面量时**抛异常**，
而不是返回一个数：

```
getTokenizer().encode("a <|endoftext|> b")
→ The text contains a special token that is not allowed: <|endoftext|>
getTokenizer().encode("a <|endoftext|> b", [], [])
→ [64, 464, 91, 419, 1440, 919, 91, 29, 287]   // 9 个 token
```

根因是 `js-tiktoken/lite` 的默认参数 `encode(text, allowedSpecial = new Set(), disallowedSpecial = "all")`
——`disallowedSpecial = "all"` 表示「任何特殊 token 拼写都视为非法输入」。这不是可选的严格模式，
而是库的默认行为，因此每处调用都继承了它。

触发面不是边缘用例：**工具输出与文件正文里出现这类字面量是常态**。模型把
`<|endoftext|>` / `<|im_start|>` / `<|end_of_text|>` 写进文件、或工具回显了含这类标记的内容时，
预算计算即失败。计数是本进程最热的路径之一，其下游都是"预算"这类安全网：

- `src/context/budget/ToolResultBudget.ts`（工具结果溢出判定）
- `src/context/budget/TokenBudgetManager.ts`（上下文预算）
- `src/tool/builtin/filesystem/read-file/text.ts`（读文件的分片决策）
- `src/router/utils/countTokens.ts`（路由的 token 估算）

**计数不是校验**。它只需要一个数，没有任何理由因输入形状而整条失败。

## Decision

`tokenizer.ts` 内新增私有 helper `countEncodedTokens(text)`，统一以 `encode(text, [], [])`
调用（两个集合均为空 ⇒ 特殊 token 拼写按普通文本计数），三处编码点改走它：

- 抽样兜底分支的样本编码
- 抽样判定为正常文本后的全量编码
- 短文本（≤ 512 字符）的全量编码

收敛成 helper 而不是在三处重复 `[], []`：这个参数对不是"随手写的字面量"，它的存在理由
（默认值会抛）必须只写一遍，否则下一次有人"顺手简化"掉它时不会有任何提示。

**对不含字面量的文本，结果与默认参数完全一致**——`disallowedSpecial` 只影响校验，不参与
普通文本的编码。测试里为此留了显式锚（"等价性锚"用例），因为它正是本次改动的风险边界。

顺带修正 `tests/context/budget/tokenizer-cache.spec.ts` 里 4 处 `tok.encode` 包装器：
它们原本写成 `(text: string) => original(text)`，会吞掉新调用形状的后两个参数、把放行
**静默还原**成抛错行为。改为转发全部参数（`(...args) => original(...args)`）。不修的话那 4 个
用例仍会通过（其文本不含字面量），却会掩盖真实调用形状——这正是"测试假绿"的形态。

## Alternatives considered

- **在调用方 catch 后回退到字符数估算** — 落选：预算会静默失真（估算值随文本构成漂移，
  且没有任何信号），比抛错更难发现。抛错至少是显式的。
- **编码前 strip 掉特殊 token 拼写** — 落选：改变了被计数的文本。同一个文本会因不同
  的 strip 实现得到不同的 token 数，而计数结果进内容哈希缓存（`cacheKey` 用 `sha1(text)`），
  两套"清理后文本"的语义会让缓存键与实际计数对象不一致。
- **换一个 tokenizer 实现** — 落选：超出缺陷范围。`o200k_base` 与项目对接的厂商
  （含 kimi / deepseek / qwen / glm 等 OpenAI 兼容端点）的用法一致，换实现会同时改变所有
  历史预算数字。
- **保留抛错，在上层把特殊 token 当成不可计数内容跳过** — 落选：跳过等于把这段文本的
  预算记成 0，会让溢出判定低估，方向恰好是危险的那一侧。
- **只改 helper 覆盖的两处全量编码，抽样样本那处不改** — 落选：样本区间就是文本前缀，
  字面量落在前 512 字符内同样触发抛错，漏改等于缺陷仍在（测试里两条长文本用例分别覆盖
  "字面量在样本内"与"在样本外"）。

## Consequences

**换来**：工具输出/文件正文含特殊 token 字面量时，预算链路不再中断。上游 #574 的
`fix: count special token literals as ordinary text`（commit `f2b2b3f0`）正是此变更。

**付出**：

- 这类文本的 token 数此前从未被成功计算过（一算就抛），因此不存在"旧值 → 新值"的迁移；
  但对下游预算而言，这是**新增了一段此前不可表示的输入**——预算从"炸掉"变成"给一个数"，
  首个含字面量的长工具结果会真实占用上下文预算。
- `countTokens` 的契约从此是"对任意字符串都返回一个数"，调用方不再需要防御性 try/catch；
  反过来，任何依赖"非法输入会抛"的调用方（未发现）会失去该信号。

**仍未覆盖**：`countTokensGuarded` 的抽样外推（高重复度文本）仍按样本密度估算，
这是既有的性能兜底（`PATHOLOGICAL_SAMPLE_THRESHOLD_MS = 80`），与本次改动无关。

## 相关

- 上游：PilotDeck #574（commit `f2b2b3f0`）
- 同 PR 的另两个切片**未移植**，理由见 `docs/pilotdeck-2026-09-upstream-port-plan.md`
  §四非目标：删除文本→工具调用兜底（产品契约变更）、删除 `thinkFsm`（Sati 对接的
  OpenAI 兼容端点会把推理内联在 `content`，照删会回归）
- 验收：`tests/context/budget/tokenizer-special-tokens.spec.ts`（新增 8 例）
  + `tokenizer-cache.spec.ts`（6 例，含参数转发修正）
