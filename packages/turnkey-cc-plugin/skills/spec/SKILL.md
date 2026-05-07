---
name: turnkey:spec
description: Phase 3 of turnkey (OPTIONAL) — spec-driven 工程. 在写实现前先把"接口契约"钉死 (输入/输出/错误码/状态机). 适合接口边界复杂或有外部 consumer 的 ticket. 跳过条件: design 阶段 junior 选了"不走 spec". 触发: turnkey 主 skill 路由到 spec.
---

# turnkey-spec — 阶段 3（可选）

> 目的：把 design 里的 "Option X" 落实到一份**机器/人都能读懂的接口契约**，让 develop 阶段不用反复猜"这个函数应该返回什么"。

## Context Inputs

> 见 `CONTEXT-PROTOCOL.md`。**按顺序读以下文件**。design / clarify / onboard 的细节去对应 artifact 找，不要回滚 chat scrollback。

| # | path | 为什么 |
|---|------|--------|
| 1 | `~/.turnkey/runlog.json` | `current_stage` / `funnel.design.chosen_option` / `context_budget.level` |
| 2 | `~/.turnkey/artifacts/<ticket_id>/02-design-doc.md` | §3 选定 Option / §6 risks / §9 deferred |
| 3 | (optional) `~/.turnkey/artifacts/<ticket_id>/01-clarify-summary.md` | 仅当需要回查 success criteria |
| 4 | (optional) `~/.turnkey/artifacts/<ticket_id>/digest/cumulative.md` | P1+ 才会自动生成 |

**Budget pre-flight**：进 Phase 1 前看 `runlog.context_budget.level`。≥`orange` → 回主 `turnkey/SKILL.md` Phase 0.5 处理。

## 何时该跳过这个阶段

design 阶段 junior 已经选了"不走 spec"。这阶段直接 mark skipped → 进 tdd 或 develop。

## Phase 1: 装载上下文

```bash
TICKET_ID="$(jq -r .ticket_id ~/.turnkey/runlog.json)"
DESIGN="${HOME}/.turnkey/artifacts/${TICKET_ID}/02-design-doc.md"
OUT="${HOME}/.turnkey/artifacts/${TICKET_ID}/03-spec.md"
```

从 design doc §3 抽出选定的 Option，识别：
- 它要新增 / 修改的接口（HTTP route / function / class / CLI / message）
- 它的输入参数 / 输出 schema
- 错误码 / 异常 / fallback

## Phase 2: 写 spec

按 `templates/spec.md` 的模板写 `${OUT}`：

```markdown
# Spec — ticket <ticket_id>

## 1. 范围（精确到接口名）
- 新增: <list>
- 修改: <list>
- 删除: <list>（如有 — 必须在 design 已经标记为 breaking）

## 2. 每个接口的契约

### 接口 1: <name>
- **签名**: `function name(args) -> return | throws`
- **输入**:
  - <参数名>: <类型>, <语义>, <约束>
- **输出**:
  - 成功: <类型 / schema>
  - 失败: <错误类型 / 错误码>
- **副作用**: <数据库写 / 网络调用 / 文件 IO / 状态变更>
- **idempotent?**: yes / no
- **invariant**: <调用前后必须保持的不变量>

### 接口 2: ...

## 3. 状态机（如有）
（用 ASCII 图或 mermaid，描述状态转换）

## 4. 数据模型变更（如有）
- 表 / 字段新增: <DDL 草稿>
- 迁移策略: forward-only / reversible

## 5. 兼容性
- 是否 break 现有调用方？<list>
- deprecation timeline (如有)

## 6. spec 之外的 explicit non-goals
（防 develop 阶段 scope creep）
- 这个 spec 不包含: ...

## 7. 验证清单（给 tdd / test 阶段消费）
- [ ] 接口 1 happy path test
- [ ] 接口 1 每种错误输出 test
- [ ] 接口 1 idempotent test (如果声明了)
- [ ] 状态机每条边 test
- [ ] 兼容性 regression test
```

## Phase 3: spec sanity check

agent 自检：
- 每个接口都有签名 + 输入 + 输出 + 错误？
- 副作用一栏有没有"未列出但代码会做的"事情？
- invariant 是不是真的能 enforce（不是空话）？

如果发现 spec 跟 design doc 矛盾 → 不要悄悄改 spec 来匹配 design，而是回到 design 阶段（rewind current_stage 到 design），告诉 junior 哪里矛盾。

## Phase 4: junior review

调用 AskUserQuestion 摆出 spec 的关键决策点（错误码命名 / 是否 idempotent / breaking changes）让 junior 确认。

如果 spec 里有任何"agent 不确定但写了一个默认值"的字段，**显式标 `[NEEDS CONFIRM]`** 让 junior 决策。

## Phase 5: 推进

```bash
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.turnkey/runlog.json`;
const r = JSON.parse(fs.readFileSync(path, "utf8"));
r.funnel.spec.status = "done";
r.funnel.spec.ended = new Date().toISOString();
r.funnel.spec.artifacts = [process.env.OUT];
// 接下来去 tdd（如果 design 选了）或 develop
r.current_stage = (r.funnel.tdd.status === "skipped") ? "develop" : "tdd";
fs.writeFileSync(path, JSON.stringify(r, null, 2));
fs.appendFileSync(process.env.HOME+"/.turnkey/inbox.jsonl",
  JSON.stringify({ts:new Date().toISOString(),type:"stage_exit",stage:"spec"})+"\n");
'
```

## 不要做

- ❌ 不要写 implementation 代码（只允许写 type/interface stub 文件，零运行逻辑）
- ❌ 不要为了让 spec "看起来完整"而瞎填字段（agent 不确定的就标 `[NEEDS CONFIRM]`）
- ❌ 不要在 spec 里写测试用例（那是 tdd / test 阶段的事，spec 只列"应被测试什么"）

## 三盲扫描钩子

- 如果 spec 里某接口跟现有同名接口签名冲突——convention-blindness signal
- 如果 spec 里假设"AI 写的实现一定满足 invariant"——trust-blindness signal，加显式 verification step
- 如果接口涉及的领域名词（账户 / 订单 / 库存等）跟 codebase 现有用法不一致——context-blindness signal
