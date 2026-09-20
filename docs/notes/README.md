# 决策记录（Agent Notes-lite）

> 定位：Sati 的**决策记忆**——记录"为什么这么做、放弃过什么、后果是什么"，防止非平凡决策被后人重新争论。这是参考底稿两处共同强调的"最有移植价值的实践"。
>
> 规则：**每个非平凡变更（改行为/架构/跨文件契约/流程/测试策略/磁盘或线上格式）同一 PR 带/更新一条 note**。纯机械本地编辑豁免。

## 路径即元数据

```
docs/notes/{status}/{yyyy-mm-dd}-{topic}.md
```

`status` 三值（与文件内 `Status:` 行一致）：

| 目录 | 含义 | 时态 |
|---|---|---|
| `proposed/` | 评审中的提案 | 未来/建议 |
| `implemented/` | 已落地（代码移动/改名/改默认值时**同变更同步更新**） | 现在时描述现实 |
| `rejected/` | 被拒（仅在理由能防一个有诱惑力的错误时保留） | 提案冻结，裁决只在 Status 行 |

**税务实况（2026-09-20 审计核对）**：`implemented/` 148 篇、`proposed/` 0 篇、`rejected/` 0 篇。三值目录仍按上表保留（税则不因暂时为空而删）；但 `proposed/` 为空意味着**「评审中的提案」目前只存在于 `## Alternatives considered` 段与 plan 文档里**——提案已落地后请迁目录并把 `Status:` 改为 `implemented`（此前有一条 `2026-08-26-p0-model-deepseek-v4-thinking-default` 长期留在 `proposed/` 而代码早已落地，正是本行纪律要防的形态）。

`Status:` 行允许在值后带一个括号注记（如 `implemented（2026-09-17）`），但**值本身必须是三值之一**——校验以值前缀为准，注记不进语义。

## 统一格式

前三行固定：

```markdown
# Agent Note: <title>

Status: implemented
```

`implemented/` 骨架（现在时）：

```markdown
# Agent Note: <title>

Status: implemented

## Problem
<不依赖解决方案也能读懂的问题>

## Decision
<已落地现实，现在时>

## Alternatives considered
- **方案 A** — 为什么落选
- **方案 B** — 为什么落选

## Consequences
<换来了什么，付出了什么>
```

`proposed/` 骨架：`## Problem` / `## Proposal` / `## Alternatives considered` / `## Acceptance criteria` / `## Risks`。

## 纪律

1. **`## Alternatives considered` 强制**：每个真实备选 + 为何落选（一备选一段粗体开头）。"没记录打败过什么的决策，会被重新争论"。
2. **编辑 note 禁止改成另一个决策**：另写新 note 并交叉链接；完全被顶替的 note 可合并进新 owner（保留全部独特理由）。
3. **禁 spec-speak / 迁移计划 / 验收清单**：note 只记"决策背景 + 放弃物 + 后果"，实施计划归 `docs/*-plan.md`。
4. **交叉引用用相对路径**：指向 `docs/` 内文件或源码文件。

## 示例（已落地）

见 `docs/notes/implemented/2026-08-22-development-standards.md`（首个已落地 note，含 `## Alternatives considered`）。
