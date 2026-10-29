# Agent Note: 引入上游 dsh 法律技能库（130 个 legal-* 技能）

Status: implemented

## Problem

Sati 的法律面此前只有一枚 `skills/legal-agent` 技能 + `law_search` / `law_verify` 两个确定性工具，覆盖「查法条、核法条引用」。源仓库 `deepseek-harness` 的法律域是三块：
`packages/legal/legal-knowledge`（法条/判例检索服务）、`legal-law`（法条索引 + 引用核验）、
`legal-evidence`（八类法定证据三性评分）；另有 `packages/bundle/web-app/skills/legal` 下
130 个按领域组织的法律实务技能（AI 治理、商事、公司并购、刑事、劳动、知识产权、诉讼、隐私、
政府采购、产品合规、监管、法律检索、案件工作区）。Sati 缺的主要是**后者这份实务技能库**——
用户提出「把法律领域的 skill/工具/资产引入 Sati」。

## Decision

**P1 已落地（本次）：技能库整体导入**

- 130 个 `SKILL.md` 目录平铺到 `skills/<slug>/`（`SkillManager.listSkillsIn` 只扫一层，
  嵌套目录里的技能不会被列出，故不能保留源端的 `legal/<domain>/<slug>/` 层级）。
  目录名与 frontmatter `name` 逐一核对一致，无重名。
- 每个技能末尾追加「Sati 检索接线」段（中文 126 个 / 英文 4 个各用对应语言），把源端
  「ego lite 浏览器 + 可选 Yuandian MCP 取官方法源」的检索姿势接到 Sati 已有的
  `law_search` / `law_verify`，并保留「未检索到/未做形式核验」的降级标注要求。
  这不是装饰：`scripts/validate-skills.mjs` 对 `legal-*` 技能强制要求引用
  `patent_wiki_search` / `patent_case_search` / `law_search` 之一，缺引用即 `warn`，
  而 `warn` 会让该脚本以 exit 2 结束、`pnpm lint` 变红。
- 唯一超过 500 行的技能 `legal-employment-internal-investigation`（759 行）按行数门禁拆分：
  `## Mode 2` 之后的内容原样迁到 `references/investigation-modes.md`，`SKILL.md` 保留指针，
  内容零删减。
- 上游 `LICENSE` / `NOTICE` / `SOURCES.md` 原样落在 `docs/third-party/legal-skill-pack/`，
  并在 `THIRD_PARTY_NOTICES.md` 增列来源与义务（Apache-2.0；105 份最高法诉讼文书样式为
  国家机关官方文件，非 Apache 语料）。

**P2 未落地：`evaluate_legal_evidence` 工具**

- Sati 已有 `evaluate_evidence`（`src/patent/evidence/`，三性 + 规则集 + 举证责任/证明标准），
  但证据类型枚举是专利导向（15 类，含 `internet_publication` / `prior_art_date` 等），
  不含《民事诉讼法》第 66 条的 `documentary` / `physical` / `audio_visual` /
  `party_statement` / `inspection_record`。补齐需要扩 `inputSchema` 的 enum，
  会使 llm-replay fixture 失配，必须重录；本次不做。

**P3 未落地：`legal-law` 的 74MB 随包法条资产**

- Sati 的 `src/knowledge/legal/law-index.ts` 明确选择「从 knowledge.db 现算索引」，
  并写明了原因（上游 `patent-law` 用人工填的 `maxArticle` / `topics`；Sati 无这份资产，
  只能用 `1..N` 连续上界选权威源）。直接塞 7910 份 YAML 会与这条已落地的选源判定冲突，
  且 74MB 进入仓库。

## Alternatives considered

- **保留源端 `skills/legal/<domain>/<slug>/` 层级** — 落选：`SkillManager.listSkillsIn`
  只 readdir 一层，嵌套技能不会出现在技能列表/模型可见技能面，等于没导入。
- **不追加「Sati 检索接线」段，改为把 130 个技能整批加入 `validate-skills.mjs` 的
  `KNOWLEDGE_EXEMPT`** — 落选：豁免名单会把「技能文本脱离知识系统」这条防漂移规则整体关掉，
  且属于「降级且静默」；追加两行接线既过门禁，又让模型知道本项目该调哪个工具。
- **把 `legal-employment-internal-investigation` 删减到 500 行以内** — 落选：删上游正文
  比拆分更容易丢内容；拆到 `references/` 后 `SKILL.md` 与原内容合计仍是 773 行，
  validate-skills 对 `references/` 不做行数门禁。
- **同时移植 `legal-evidence` 并注册新工具** — 落选（本次）：新工具会改默认工具清单与
  `toolSchemaDigest`，llm-replay 必须按 `pnpm record:replay` 重录，而重录需要真实模型调用；
  在无法重录时静默新增会让重放门禁由「未核验」变成「假通过」。
- **同时移植 `legal-law` 随包资产做 `law_verify` 的离线兜底** — 落选：与
  `law-index.ts` 已落地的「现算索引 + 选源留痕」冲突（两套权威源会互相打架），且 74MB。

## Consequences

- 内置技能数 107 → 237（`docs/code-facts.md` 由 `pnpm gen:doc-claims` 回填），模型可见技能面
  翻倍；技能描述的长度/触发重叠可能让模型选错技能，需要后续用真实会话观察触发质量。
- 技能正文是上游内容（`claude-for-legal-ZH` v1.1.0），法律时点、条号与程序要求仍以运行时
  `law_search` / `law_verify` 复核为准；导入不改变这一点，也没有新增运行时门禁。
- 未改 `AgentEvent` / gateway frames / 任何工具 `inputSchema`，`pnpm check:event-matrix` 与
  llm-replay 不受影响。
- 谁因此漏了什么：本次没有法律域的确定性证据评分（八类法定证据）与离线法条资产；
  法律技能里涉及证据三性的步骤仍只能靠模型推理，直到 P2 落地。

## Follow-ups（后补状态，不改写上面的历史结论）

- **P2 已落地**：`evaluate_legal_evidence`（八类法定证据三性评分）见
  `2026-10-29-legal-evidence-tool.md`。采取的是「新增独立工具 + 复用底层
  evaluator 结构」，而不是扩 `evaluate_evidence` 的 enum——上文所说的
  「会使 llm-replay fixture 失配」在落地时按 `pnpm record:replay` 真实重录解决。
- **P3 已落地**：法条离线兜底见 `2026-10-29-law-offline-snapshot.md`。74MB YAML
  没有原样入库，改为构建期抽取「已转录正文」的紧凑 gzip-jsonl 快照（0.27MB），
  在线索引优先、快照只兜底，并在结果里显式标注 `source` / `snapshotAt`。
  与 `law-index.ts` 的「现算索引 + 选源留痕」不冲突：快照从不参与在线选源。
- **技能面后续调整**：`<available-skills>` 改为按域分组渲染（10.3k → 4.9k tokens），
  见 `2026-10-29-skill-grouping.md`；上文「模型可见技能面翻倍…需要后续观察触发质量」
  的观察点在该 note 的 Consequences 里继续跟踪。
