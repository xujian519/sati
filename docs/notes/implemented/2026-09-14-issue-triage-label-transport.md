# Agent Note: issue-triage 标签传输改为行协议

Status: implemented

## Problem

`issue-triage.yml`（2026-09-14 随 #315 合并）**首次真实运行即失败**。issue #316 创建时触发，日志：

```
env: LABELS: status: triage
run: gh issue edit "$ISSUE_NUMBER" --add-label "$(echo "$LABELS" | tr ' ' ',')"
→ failed to update https://github.com/xujian519/sati/issues/316: 'status:' not found
```

分类器 `scripts/classify-issue.mjs` 以**空格分隔**输出待添加标签，workflow 侧再用 `tr ' ' ','` 把它们拼成 `gh --add-label` 能吃的逗号串。但标签名合法地包含空格——`status:` 维度的三个取值（`triage`/`in-progress`/`blocked`）全带空格，`good first issue`、`help wanted` 也是。于是 `status: triage` 被拆成 `status:` 与 `triage` 两个不存在的标签，打标签失败。

**为什么测试没拦住**：`classify-issue.test.mjs` 只测纯函数 `classifyIssue()`（返回数组），从未测 CLI 的 stdout 格式——而缺陷恰好就在"脚本 → workflow"这条传输契约上。同批的 `sync-labels.test.mjs` 同理。两个脚本都有测试，但都没有覆盖自己作为 CLI 被消费时的接口。

## Decision

1. **分类器输出改行协议**：`console.log(labels.join("\n"))`——每个标签独占一行。行分隔是这里唯一无歧义的选择：GitHub 标签名不能含换行，但可以含空格与逗号。
2. **workflow 逐行打标签**：读一行调一次 `gh issue edit --add-label "$label"`，**彻底不使用任何分隔符拼接**（既不再 `tr ' ' ','`，也不判空串分隔）。shell 里 `"$label"` 作为单个 argv 传递，空格天然安全。
3. **job 级 `if: github.event.issue.state == 'open'`**：已关闭议题是终态。关闭纪律要求"补一句结论"，而补结论会触发 `edited` 事件——没有这道守卫，编辑已关闭议题会被重新糊上 `status: triage`。
4. **补 CLI 级回归测试**：新增两条以 workflow 同款环境变量 `execFileSync` 起子进程的测试，断言逐行输出与空输出，其中一条明确断言 `status: triage` 独占一行。

## Alternatives considered

- **保留空格分隔，只改 workflow 侧解析**（如用 `sed` 按 `scope:`/`status:` 前缀切）— 落选：这是在用启发式反推分隔符，而标签名的空格位置本来就不受控；换一个 `priority: p1` 或 `good first issue` 就得再写一条规则。
- **改逗号分隔** — 落选：能过当前清单，但只是把一个空格假设换成逗号假设；将来清单里出现含逗号的标签名（GitHub 允许）会重演同一种静默失败。行协议没有这个自由度。
- **标签名转义/加引号后仍走单次 `--add-label`** — 落选：`gh` 没有可用的转义约定，且逗号本身是 `--add-label` 的多值分隔符，无法同时表达"名字里有逗号"。
- **让 `sync-labels.mjs --check` 禁止标签名含空格** — 落选：与设计冲突——`status: triage` 这类带空格的标签名是既有体系的一部分（也是 GitHub 常见的 `good first issue` 命名习惯），禁止空格等于为了让传输方便而改数据模型。
- **只加纯函数测试** — 落选：缺陷不在纯函数里，`classifyIssue()` 的返回值一直是对的；非 CLI 级测试无法覆盖。
- **给 workflow 加 `workflow_dispatch` 以便回填既有议题** — 落选（本轮）：`workflow_dispatch` 下 `github.event.issue` 为空，需要按事件类型分叉取数（`gh issue view` 兜底），会把刚出过 bug 的 shell 段复杂度推高；先只修缺陷本身。

## Consequences

- 标签逐个 `gh issue edit`（典型 1–3 次 API 调用），换取传输层零歧义；打标签失败时 `bash -e` 直接让步骤红，不会静默漏打。
- 已关闭议题不再被自动补 `status: triage`（编辑关闭议题去补结论是常态化操作）。
- 脚本↔workflow 的契约首次有测试覆盖：任何"把标签拼成分隔串"的改法都会被 `CLI 契约：带空格的标签独占一行` 拦下。
- 遗留：`issue-triage.yml` 的 shell 段本身仍无自动化测试（YAML + shell 不适合放进 `node --test`）；本轮以 `gh` 替身手工验证（3 个标签 → 3 次调用、名字含空格完整传递）。若后续这段逻辑继续增长，应考虑抽成 `scripts/` 下的可测函数，让 workflow 只做参数转发。
- 事故残迹：issue #316 在这次失败中未被打上任何标签（该议题随后因 PR 合并而关闭，按新守卫属终态，不再回填）。
