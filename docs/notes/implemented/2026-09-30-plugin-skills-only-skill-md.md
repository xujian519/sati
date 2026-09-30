# Agent Note: 插件 skills/ 目录只把 SKILL.md 注册为技能

Status: implemented

## Problem

插件的 `skills/` 目录不只是技能本体：技能自己会把素材放在旁边（`README.md`、`references/*.md`）。加载器按目录递归收 `.md`，于是一份技能会连带注册出若干条"技能"——名字来自文件名、描述为空、内容是一段参考文档。技能列表被污染，模型的计划里会出现这些幻影技能。

## Decision

`loadConfiguredMarkdown` 在 `fallbackDir === "skills"` 时按 `LoadedPluginCommand.isSkill` 过滤，只保留 `SKILL.md`；`commands/` 与 `output-styles/` 不过滤。判据直接复用 `PluginCommandLoader` 已有的 `isSkill` 标记，不新增文件名判断。

## Alternatives considered

- **在 `PluginCommandLoader` 里按目录名跳过非 SKILL.md** — 落选：加载器不知道调用方要的是"技能目录"还是"命令目录"，同一个 `loadPluginCommands` 两种用途都走；判据放调用方才有上下文。
- **要求 plugin.json 逐文件列出技能** — 落选：把"约定优于配置"换成显式清单，插件作者（与既有插件）都要改，而 `SKILL.md` 这个约定在技能体系里已经是硬约束。
- **把 `references/*.md` 收进技能内容而不是忽略** — 落选：改变技能内容的语义与体积（内容进提示词），超出"修正注册面"的范围。

## Consequences

- 插件 `skills/` 下非 SKILL.md 的 markdown 不再出现在技能列表；技能素材仍留在磁盘上，由技能正文按需引用。
- `commands/`、`output-styles/` 行为不变，故既有插件（本仓内置插件均未声明 `skills`）无影响。
