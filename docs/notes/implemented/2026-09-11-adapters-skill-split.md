# Agent Note: 渠道 SessionMapper 共享化与 Skill 校验族拆分

Status: implemented

## Problem

两处同构复制推高了维护成本，且都属于"改一处要记得改 N 处"的形态：

- **渠道 SessionMapper**：`src/adapters/channel/*/*SessionMapper.ts` 共 19 份，其中 **13 份**在剔除类名与 `channelKey` 字面量后**逐字相同**（36 行/文件）——同为"按 chatId 维护活跃会话 + `/new` 指令 + 快照"的实现。任何语义修正（例如 `/new` 指令的识别规则）都需要在 13 个文件里重复一遍。
- **SkillManager**：915 行单文件里，约 293 行是 `SKILL.md` frontmatter 解析与 bundle 校验（磁盘路径 `validateFromDisk` + manifest 路径 `validateFromManifest` 两条流程共用同一套规模/扩展名/必要字段判定），与类本身的技能 CRUD 职责无关，且该验证族此前**没有直接测试**。

## Decision

1. **渠道 mapper**：在既有共享层 `src/adapters/channel/protocol/` 新增 `ChatSessionMapper`（构造函数接收 `channelKey`），13 个渠道改为**薄壳子类**（各 8 行：以固定渠道名调用 `super`），**保留原类名与 `XxxSessionMapperState` 类型导出**，因此 13 个 `Channel` 的字段注解与 import 面零改动。
2. **Skill 校验族**：从 `SkillManager.ts` 抽出两个模块——`frontmatter.ts`（解析族）与 `validation.ts`（校验族，含 `MAX_*`/`RISKY_EXTS` 常量，它们只被校验族使用）；实现逐字迁移，`SkillManager.ts` 由 916 行降至 623 行。同时为 `validation.ts` 补 6 条直测（manifest 路径的良构/不安全路径/缺 SKILL.md/文件数超限/可执行扩展名告警，磁盘路径的良构/缺源/缺 SKILL.md）。

## Alternatives considered

- **新建 `src/adapters/channel/shared/`** — 落选：仓内 `channel/protocol/` 已经是共享层（已有 render/text/命令注册表/附件/交互/定时投递 6 类共享件），新建第二个约定会让"共享件放哪"变成需要每次判断的问题。
- **删除 13 个 mapper 文件、各渠道直接 `new ChatSessionMapper("xxx")`** — 落选：净减行数相同，但会改动 13 个 `Channel` 的类型注解与 import（`mapper?: XxxSessionMapper` → 共享类型），爆炸半径更大且丢失"每渠道一个可引用的类名"这一既有 API 面。薄壳以 8 行/文件换取零 API 变更。
- **frontmatter 解析族留在 `SkillManager.ts`，由 `validation.ts` 反向 import** — 落选：会形成 `validation → SkillManager → validation` 的循环依赖。
- **顺手合并判例命中项**（`extractText` 的 `string("")` vs `string|null`、`formatError`、`normalizeBaseUrl`、`sendJson`、`sleep` 等 6 处跨文件微重复） — 落选：本仓既有判例「跨文件微重复不合并」（`docs/code-refinement-report.md` 判例 2），这些签名/语义有真实差异，净减仅 4–8 行却要动公共 API 面，收益为负。
- **只删 `render` 薄包装（18 个）** — 落选：它们是"options 未被误改"的回归钉，且被 `tests/adapters/channel-render.spec.ts` 直接 import，删除会拆掉既有回归保护。

## Consequences

- 13 个渠道的会话映射语义此后只有一份实现；`/new` 等规则的修正退化为一处改动。新增渠道时 mapper 只需 8 行薄壳。
- `SkillManager.ts` 从 915 行降到 623 行；frontmatter/校验两族获得独立模块边界与首个直测（此前 `validate/import` 无专门 spec）。
- 未做（明确保留）：`C2` 单轮处理循环的跨渠道抽取——13 个渠道**全部处于无测试集合**，且抽取会把 21 个 `submitTurn` 调用点搬进共享模块、必须同 PR 重生成事件矩阵（`docs/event-producer-consumer.md` 按 `file:line` 硬编码）；该抽取应作为独立 PR，先补测试再动。
- 未做：`kanban.ts` 的 15 个工厂按文件搬运——真债是脚手架重复而非文件长度，先抽共享 helper 才有收益。
