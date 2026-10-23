# Agent Note: 说明书章节识别接受提交格式的纯文本标题

Status: implemented

## Problem

`validate_specification` 的必需章节只用 `/^#{1,3}\s*技术领域/m` 这类 Markdown 标题正则识别。CNIPA 提交格式的标准说明书是纯文本标题，于是完整说明书被判「技术领域、背景技术、发明内容、附图说明、具体实施方式」五节全缺、`score` 降到 0.4。附图说明正文提取同样只认 `#`，图文标号核验也跟着失效。仓库里另有一套 `src/patent/spec/checks.ts` 的 `checkSectionCompleteness` 注释自称与工具层一致，实际是第二份 Markdown-only 正则。

## Decision

抽出 `matchSectionHeading(line)` 与 `isMarkdownHeading(line)`，下沉到 `src/patent/spec/checks.ts`，由工具层 import 后 re-export。识别分两支：

- Markdown 标题 `#`–`######`：保留历史前缀语义，`## 技术领域（Technical Field）`、`## 技术领域：……` 仍算标题；
- 纯文本标题：整行匹配，支持编号（`一、` / `1.` / `（一）`）、方括号（`【技术领域】`）、行首行尾空白与行尾冒号。

结构检查、draft-spec 原子的 `checkSectionCompleteness` 与附图说明正文提取共用同一识别函数。附图说明的结束边界改为「任意 Markdown 标题或任一已识别章节标题」，避免 `## 有益效果` 之后的正文被吞进附图说明、把「范围：3-5 mm」误读成附图标记 3。

## Alternatives considered

- **只改必需章节、不改附图说明提取** — 结构检查会通过，但图文标号核验仍拿不到纯文本章节正文，形成半修。
- **识别任意包含章节名的行** — 正文提及「技术领域」会被当成标题，产生假通过；纯文本分支必须保持整行匹配。
- **把 Markdown 分支也改成整行匹配** — `## 技术领域（Technical Field）` 这类中英对照标题会从命中变成漏判，相对现状是回归。
- **先把纯文本说明书规范化成 Markdown 再校验** — 需要改写入参或临时文本，且无法可靠区分标题与正文，副作用大于收益。
- **只接受纯文本、放弃 Markdown** — 现有草稿与测试都使用 Markdown，会造成向后不兼容。
- **同时要求每个章节标题后必须有正文** — 能挡住「目录式五行标题」的假通过，但附图说明允许为空（另有 warning），且会改变既有评分语义；本次只记录该取舍，未收紧。

## Consequences

标准提交格式的纯文本说明书可通过结构检查；Markdown 标题的既有前缀语义保留，并扩展到 4–6 级标题。标题识别更宽松后，形如 `1. 技术领域` 的列表行也会被视为标题，形如「五行章节名 + 一句实施例」的目录/提纲式文本仍会通过结构检查——这是采纳纯文本标题的已知取舍，收紧需要单独定义「章节正文非空」的判定。工具顶层描述补充了支持的标题格式；`inputSchema` 未变（属性描述仍写 markdown，单独走契约变更与 fixture 重录，不在本 PR 顺手改），不需要重录 llm-replay。
