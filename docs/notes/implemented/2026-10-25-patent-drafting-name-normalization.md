# Agent Note: 权利要求/说明书名称归一化与结构化前序特征

Status: implemented

## Problem

`draft_claims` 无条件在名称前加「一种」，输入「一种相变储热装置」会产出「一种一种相变储热装置」；从属权利要求写成「根据权利要求1所述的一种…」；software 域又无条件追加「的实现方法」，产生「一种数据处理方法的实现方法」。`prior_art` 自由文本被直接塞进「包括：」当作技术特征，等于把一段描述伪装成特征。

## Decision

新增 `normalizeInventionName()`：剥离开头的「一种/一件/一款/一项」（含重复前缀），权利要求与说明书模板统一补「一种」，从属权利要求使用裸名称。software 域名称已以「方法」结尾时不再追加「的实现方法」。`draft_specification` 同步归一化，并扩充领域关键词（装置/设备/机构/结构等），修正「一种相变储热装置」被识别为 general 的问题。

`prior_art` 保留字符串兼容，但不再写入权利要求：新增可选 `shared_features: string[]` 承载与现有技术共有的结构化特征，放在独立权利要求前序部分；只给 `prior_art` 时输出 warning，提示改用 `shared_features`。

## Alternatives considered

- **只在输出文本上做正则替换** — 「一种一种」可以去掉，但从属引用与 software 后缀仍会各自漂移；名称归一化必须在构造 claim 之前完成。
- **把 `prior_art` 原样放进前序** — 这正是当前缺陷；自由文本没有特征边界，无法保证「包括：」后面的每一项都是技术特征。
- **直接删除 `prior_art` 入参** — 会破坏已有提示词与调用方；保留并降级为提示更平滑。
- **software 域一律去掉「方法」后缀** — 会误伤名称本身不以「方法」结尾的方案；只在已以「方法」结尾时跳过追加。

## Consequences

三类病句消失，输出对同一输入稳定。`shared_features` 进入 `inputSchema`，llm-replay fixture 已重录。调用方若仍依赖 `prior_art` 作为特征来源，会看到 warning 而不是静默得到一段被当成特征的描述。
