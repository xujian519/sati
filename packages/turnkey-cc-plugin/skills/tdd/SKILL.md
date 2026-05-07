---
name: turnkey:tdd
description: Phase 4 of turnkey (OPTIONAL) — TDD plan. 把 spec (或 design) 拆成"先写哪几个测试 / 这些测试应该 fail / 然后逐个让它们 pass"的 micro-step list. 适合核心业务逻辑或有现成测试框架的 codebase. 跳过条件: design 阶段 junior 选"不走 tdd". 触发: turnkey 主 skill 路由到 tdd.
---

# turnkey-tdd — 阶段 4（可选）

> 目的：在 develop 阶段开始之前，把"实现路径"拆成"测试驱动的 micro-step"。
> 这阶段**不**写 production code，**只**写 test 文件 stub + 让它们 fail（红）。

## Context Inputs

> 见 `CONTEXT-PROTOCOL.md`。**按顺序读以下文件**。

| # | path | 为什么 |
|---|------|--------|
| 1 | `~/.turnkey/runlog.json` | `funnel.onboard.commands.test` / `context_budget.level` |
| 2 | `~/.turnkey/artifacts/<ticket_id>/02-design-doc.md` | §3 选定 Option / §6 risks |
| 3 | (optional) `~/.turnkey/artifacts/<ticket_id>/03-spec.md` | 如果 spec 阶段没跳过，spec 是 micro-step 的主输入 |
| 4 | `~/.turnkey/artifacts/<ticket_id>/00-onboard-summary.md` | 测试框架 / 命名约定（test_*.py vs *_test.py vs *.spec.ts） |
| 5 | (optional) `~/.turnkey/artifacts/<ticket_id>/digest/cumulative.md` | P1+ 才会自动生成 |

**Budget pre-flight**：进 Phase 1 前看 `runlog.context_budget.level`。≥`orange` → 回主 `turnkey/SKILL.md` Phase 0.5 处理。

## 何时该跳过

design 阶段 junior 选了"不走 tdd"。直接 mark skipped → 进 develop。

## Phase 1: 装载上下文

```bash
TICKET_ID="$(jq -r .ticket_id ~/.turnkey/runlog.json)"
DESIGN="${HOME}/.turnkey/artifacts/${TICKET_ID}/02-design-doc.md"
SPEC="${HOME}/.turnkey/artifacts/${TICKET_ID}/03-spec.md"     # 可能不存在
ONBOARD="${HOME}/.turnkey/artifacts/${TICKET_ID}/00-onboard-summary.md"
OUT="${HOME}/.turnkey/artifacts/${TICKET_ID}/04-tdd-plan.md"
```

从 onboard 找测试框架（jest / vitest / pytest / rspec / go test / ...）。
从 spec（如有）抽 §7 验证清单。从 design 抽 success criteria。

## Phase 2: 写 TDD plan

```markdown
# TDD Plan — ticket <ticket_id>

## 测试框架
- runner: <jest/pytest/...>
- 测试文件路径约定: <从 onboard 抽，例 `__tests__/<name>.test.ts`>
- 跑命令: <从 clarify Q1 取>

## micro-step 列表（按依赖顺序）

### Step 1: <最小验证点>
- test 文件: <path>
- test name: `should <expectation>`
- 当前状态: 红 / 绿
- 实现需要: <最少改动描述>
- 预计时间: <X min>

### Step 2: ...

## 测试金字塔分布预估
- unit: N 个
- integration: N 个
- e2e: N 个

## 不写 test 的部分（明示）
- <例: glue code / config 改动 / 文档 — 这些在 review 阶段过 lint 即可>

## 给 develop 阶段的输入
- 按上述 step 顺序逐个让 test 转绿
- 每转绿一个 test → 提交一个 atomic commit
```

## Phase 3: 写第一批 test stub（让它们红）

按 Step 1-N，**只**创建 test 文件 + test stub（assertion 写好但被测函数不存在或返回 placeholder）。

```bash
# 例（pytest）
mkdir -p tests/turnkey/
cat > tests/turnkey/test_<feature>.py <<'EOF'
import pytest

def test_should_<expectation>():
    # given
    ...
    # when
    result = <module>.<function>(...)  # 不存在 / 返回 placeholder
    # then
    assert result == <expected>
EOF

# 跑一次确认它们确实红
$(jq -r '.funnel.clarify.test_command // "<from clarify>"' ~/.turnkey/runlog.json) tests/turnkey/ || true
```

把"哪些 test 红了 / 怎么红的"记进 `${OUT}` 的 §当前状态 段。

## Phase 4: junior 校对

调用 AskUserQuestion：
- step 顺序合理吗？
- 有没有漏掉某个边界情况？
- 测试金字塔分布对吗（不要 e2e-heavy）？

## Phase 5: 推进

```bash
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.turnkey/runlog.json`;
const r = JSON.parse(fs.readFileSync(path, "utf8"));
r.funnel.tdd.status = "done";
r.funnel.tdd.ended = new Date().toISOString();
r.funnel.tdd.artifacts = [process.env.OUT];
r.current_stage = "develop";
fs.writeFileSync(path, JSON.stringify(r, null, 2));
fs.appendFileSync(process.env.HOME+"/.turnkey/inbox.jsonl",
  JSON.stringify({ts:new Date().toISOString(),type:"stage_exit",stage:"tdd"})+"\n");
'
```

## 不要做

- ❌ 不要写 production 代码（只 test 文件 + 必要的 type stub）
- ❌ 不要让 test 在 stub 阶段就 pass（那不是 TDD，是 tautology）
- ❌ 不要写 100 个 test step——超过 ~15 个 step 说明应该回 design 阶段拆成 sub-feature
- ❌ 不要忽略 onboard 里的测试 convention（命名 / 文件位置 / mock 库）

## 三盲扫描钩子

- 如果 junior 想跳过某个看起来"不需要测"的 step——trust-blindness signal（"AI 写的不会错"）
- 如果某个 test 需要 mock 团队内部库——可能 context-blindness（mock 错了等于在测错的东西）
