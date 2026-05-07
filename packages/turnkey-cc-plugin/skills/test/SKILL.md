---
name: turnkey:test
description: Phase 6 of turnkey — 测试 (unit / integration / e2e). 跑全套测试 (不只 develop 阶段触动的部分), 补缺口测试, 跑 CI 模拟 (lint+type+test+build), 录测试报告. 区别于 develop 阶段的 step-level test, 这阶段是 ticket-level overall verification. 触发: turnkey 主 skill 路由到 test.
---

# turnkey-test — 阶段 6

> 目的：在交给 senior review 之前，让 junior 知道"我这个 PR 在 CI 上会不会过"+ "测试覆盖度有没有明显空洞"。
> 这阶段是 ticket-level 的整体校验，**不**只跑 develop 阶段触动的部分。

## Context Inputs

> 见 `CONTEXT-PROTOCOL.md`。**按顺序读以下文件**。

| # | path | 为什么 |
|---|------|--------|
| 1 | `~/.turnkey/runlog.json` | `funnel.onboard.commands.{test,lint,build}` / `funnel.develop.commits` / `context_budget.level` |
| 2 | `~/.turnkey/artifacts/<ticket_id>/05-develop-log.md` | step list / scope-creep / pre-existing-failures / trust-check 汇总 |
| 3 | (optional) `~/.turnkey/artifacts/<ticket_id>/04-tdd-plan.md` | 当时计划的 test 覆盖跟实际跑的对比 |
| 4 | (optional) `~/.turnkey/artifacts/<ticket_id>/03-spec.md` | 接口契约 → 是否需要补 contract test |
| 5 | `~/.turnkey/artifacts/<ticket_id>/00-onboard-summary.md` | 测试入口 + CI 配置 |
| 6 | (optional) `~/.turnkey/artifacts/<ticket_id>/digest/cumulative.md` | P1+ 才会自动生成 |

**Budget pre-flight**：进 Phase 1 前看 `runlog.context_budget.level`。≥`orange` → 回主 `turnkey/SKILL.md` Phase 0.5 处理。

## Phase 1: 装载上下文

```bash
TICKET_ID="$(jq -r .ticket_id ~/.turnkey/runlog.json)"
ONBOARD="${HOME}/.turnkey/artifacts/${TICKET_ID}/00-onboard-summary.md"
SPEC="${HOME}/.turnkey/artifacts/${TICKET_ID}/03-spec.md"     # 可能不存在
TDD="${HOME}/.turnkey/artifacts/${TICKET_ID}/04-tdd-plan.md"  # 可能不存在
DEV_LOG="${HOME}/.turnkey/artifacts/${TICKET_ID}/05-develop-log.md"
OUT="${HOME}/.turnkey/artifacts/${TICKET_ID}/06-test-report.md"
```

## Phase 2: 跑全套（CI 模拟）

按 onboard 抽到的命令逐个跑：

```bash
# 1. lint （全仓，不只新文件）
echo "=== LINT ==="
$(jq -r '.funnel.onboard.commands.lint // "echo no-lint"' ~/.turnkey/runlog.json) 2>&1 | tee /tmp/turnkey-lint.log

# 2. type check
echo "=== TYPE ==="
$(jq -r '.funnel.onboard.commands.type // "echo no-type"' ~/.turnkey/runlog.json) 2>&1 | tee /tmp/turnkey-type.log

# 3. unit test (全仓)
echo "=== UNIT ==="
$(jq -r '.funnel.onboard.commands.test // "echo no-test"' ~/.turnkey/runlog.json) 2>&1 | tee /tmp/turnkey-unit.log

# 4. integration / e2e（如果项目有独立命令）
INT_CMD="$(jq -r '.funnel.onboard.commands.integration // ""' ~/.turnkey/runlog.json)"
[[ -n "${INT_CMD}" ]] && eval "${INT_CMD}" 2>&1 | tee /tmp/turnkey-int.log
E2E_CMD="$(jq -r '.funnel.onboard.commands.e2e // ""' ~/.turnkey/runlog.json)"
[[ -n "${E2E_CMD}" ]] && eval "${E2E_CMD}" 2>&1 | tee /tmp/turnkey-e2e.log

# 5. build
BUILD_CMD="$(jq -r '.funnel.onboard.commands.build // ""' ~/.turnkey/runlog.json)"
[[ -n "${BUILD_CMD}" ]] && eval "${BUILD_CMD}" 2>&1 | tee /tmp/turnkey-build.log
```

## Phase 3: 解析结果

按以下分类统计每个命令的产出：
- ✅ pass
- ❌ fail (本 ticket 引入的)
- ⚠️ pre-existing fail（develop 阶段已记入 pre-existing-failures 的）
- ❓ unknown / 没跑成（命令不存在 / 配置缺失）

## Phase 4: 测试覆盖缺口分析

针对本 ticket 触动的每个文件 / 接口：

```bash
git diff $(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || git merge-base HEAD master) HEAD --name-only
```

对每个改动文件：
1. 查它有没有对应 test 文件
2. 查 spec（如有）§7 验证清单里的项是不是都有对应 test
3. 查 design doc §6 risk 列表里有没有"会触发某种 race / 边界"，是不是有 test 覆盖

把发现的覆盖缺口写进 `${OUT}` 的 §coverage-gaps，每条带：
- gap 描述
- 严重度（block-ship / nice-to-have）
- 写 test 的预估时间

## Phase 5: 补关键缺口（仅 block-ship 级）

对每条 block-ship 级的 gap：
- 写出对应的 test
- 跑确认它绿
- 加进当前 commit 或新 commit

nice-to-have 级的 gap **不写**，但记进 §nice-to-have-tests-deferred 留给 ship 后或 senior review 决定。

## Phase 6: 测试报告

`${OUT}` 完整结构：

```markdown
# Test Report — ticket <ticket_id>

## CI 模拟结果

| 命令 | 状态 | 耗时 | 备注 |
|------|------|------|------|
| lint | ✅ | 12s | — |
| type | ✅ | 8s | — |
| unit | ⚠️ | 45s | 2 pre-existing failures, 0 new |
| integration | ✅ | 2m | — |
| e2e | ❓ | — | not configured in this repo |
| build | ✅ | 30s | — |

## 本 ticket 触动文件 / 测试覆盖情况
| 文件 | 关联 test | 覆盖率（如有工具） |

## Coverage Gaps
### Block-ship (已补)
- ...
### Nice-to-have (deferred)
- ...

## 给 review 阶段的输入
- 哪些 fail 是 pre-existing 的，需要在 PR description 说明
- 哪些 nice-to-have test 应在 PR description 里 explicit defer
```

## Phase 7: 推进

```bash
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.turnkey/runlog.json`;
const r = JSON.parse(fs.readFileSync(path, "utf8"));
r.funnel.test.status = "done";
r.funnel.test.ended = new Date().toISOString();
r.funnel.test.artifacts = [process.env.OUT];
r.current_stage = "review";
fs.writeFileSync(path, JSON.stringify(r, null, 2));
fs.appendFileSync(process.env.HOME+"/.turnkey/inbox.jsonl",
  JSON.stringify({ts:new Date().toISOString(),type:"stage_exit",stage:"test"})+"\n");
'
```

## 不要做

- ❌ 不要在测试报告里把"❓ unknown"伪装成"✅ pass"
- ❌ 不要为了让一个测试 pass 而改 assertion（assertion 是 spec 的反映，不是测试本身可调的）
- ❌ 不要补 nice-to-have test 然后 push（review 阶段没看到的 commit 是 senior alarm 的源头）
- ❌ 不要跳过 build 命令（很多 type 错误只在 build 时显形）

## 三盲扫描钩子

- 如果某个 fail 看起来像 "snapshot 没更新"——junior 极容易直接接受 update-snapshot 而不看 diff（trust-blindness）。**强制** AskUserQuestion 让 junior 看 diff 后才 update。
- 如果整个项目第一次跑 e2e 失败但 lint+unit 都过——可能是 context-blindness（不知道项目要先 `docker compose up` 才能跑 e2e）
