# Agent Note: 法条离线兜底（law_search 不受 knowledge.db 缺失影响）

Status: implemented

## Problem

`law_search` 的唯一数据源是 SQLite 索引（首选 `knowledge.db`，其次 `laws-full.db`）。
两个库都不存在/版本不匹配时，工具只能返回 `law_db_not_found`——法律技能里「查法条、核法条引用」
这一整块能力直接不可用，而 130 个 `legal-*` 技能都把 `law_search` 当作取证入口。

上游 `deepseek-harness/packages/legal/legal-law/assets/legal-law/` 有 7911 份「一法一 YAML」
索引（74MB），但直接随包引入会与 `src/knowledge/legal/law-index.ts` 已落地的
「从 knowledge.db 现算索引 + 选源留痕」形成双份事实源，且 74MB 进仓库不可接受
（见 `2026-10-29-legal-skill-pack-import.md` 的 P3）。

## Decision

**在线优先 + 构建期紧凑快照兜底，快照在每条结果上显式标注来源与时点。**

1. **数据形态**：不改 74MB YAML 的原始形态，新增 `scripts/build-legal-snapshot.mjs` 在构建期
   抽取「有正文的条文」，产出 `assets/legal-snapshot/`：
   - `legal-articles.jsonl.gz`（**35.21MB**）：一行一法 `{n:法名, d:文档名, a:[[条号,正文]], s?:出处, v?:核验日}`
   - `manifest.json`（**~1.5KB**）：`schemaVersion / snapshotAt / source / license / lawCount /
     articleCount / byteSize / sha256 / transcripts{available,lawCount,articleCount} /
     skipped{count,reasons,samples}`

   上游 7911 份 YAML 中 7893 份 `text` 为空（只索引、未转录正文）。补转录走
   `scripts/transcribe-legal-law.mjs`：按 YAML 文件头的 `# 源文件：xxx.md` 精确对回本机
   语料 `~/projects/宝宸知识库_Raw/Laws-1.0.0`（7910/7910 命中），扫描 markdown 中的
   `第X条` 条头重建正文，覆盖率 ≥ 90% 才收录，产出 overlay
   `.cache/legal-transcribe/transcripts.jsonl.gz`（**35.04MB / 7891 法 / 335,598 条**），
   构建快照时按文件名合并。

   体积取舍的实测判据：源目录 74MB（7911 文件）→ `tar.gz` 5.6MB、`tar.zst` 3.4MB；
   不含转录时紧凑 JSONL gzip 仅 0.27MB，**补全正文后为 35.21MB**（gzip 已压到原文约 1/4）。
   选紧凑 JSONL 而非压缩包：clone 成本与 74MB YAML 同量级仍可接受，且 gzip 解压走
   Node 内置 `node:zlib`，零新依赖、只解一层。代价是降级路径首次查询要
   `gunzipSync` 35MB（解压后约 150MB 内存常驻），因此仍保持「在线库可用时永不加载」。

2. **不放双份事实源**：`resolveLawSearchBackend()` 的解析顺序固定为
   `knowledge.db` → `laws-full.db` → 离线快照，任一在线库可用即**不加载**快照
   （快照只在首次降级查询时 `gunzip`，冷启动成本不摊到正常路径）。每条结果与工具输出
   都带 `source: "online" | "offline"`、`snapshotAt`（offline 时）、`degradedReason`，
   调用方与模型都能看出「我现在拿到的是离线快照，截至某日」。

3. **不超出数据声称**：快照没有施行/失效日期，`asOf` 检索返回 `timeFilter: "unsupported"`
   且不回填近似口径；`level` / `category` 过滤不支持，调用方实际用到时通过
   `unsupportedFilters` 回报——降级可见，不静默当成已过滤。

**落点**

| 文件 | 作用 |
|---|---|
| `scripts/build-legal-snapshot.mjs` | 构建快照（源默认同级 `deepseek-harness`，可用参数/`SATI_LEGAL_LAW_ASSETS` 覆盖；`--transcripts` 指定转录 overlay） |
| `scripts/transcribe-legal-law.mjs` | 从本机语料补转录（只读上游 YAML + 写 `.cache/legal-transcribe/`，不跨仓库改写） |
| `assets/legal-snapshot/{manifest.json,legal-articles.jsonl.gz}` | 生成物（随包分发；7908 法 / 339,189 条 / 35.21MB） |
| `src/knowledge/legal/offline-snapshot/types.ts` | 快照 schema 版本、清单/法条类型、`LegalSnapshotError` |
| `.../engine.ts` | `LegalSnapshotEngine`（`LegalSearchSource` 实现；懒加载 + 线性匹配） |
| `.../locate.ts` | `SATI_LEGAL_SNAPSHOT_DIR` → `cwd/assets/legal-snapshot` → 包根同名目录 |
| `src/knowledge/legal/law-search-tool.ts` | `resolveLawSearchBackend()` 三级降级 + `source`/`snapshotAt`/`snapshotLawCount`/`snapshotArticleCount`/`degradedReason`/`unsupportedFilters`；description 明示离线标注与收录规模回报 |
| `skills/legal-agent/SKILL.md` | 「law_search 在线 / 离线快照」段：看 `source` 再下结论、收录规模以输出字段为准、快照不支持 level/category/asOf |
| `src/knowledge/legal/types.ts` | `LegalTimeFilter` 增加 `"unsupported"` |
| `src/rule/runtime/asset-location.ts` | `packageRoot()` 改为导出（定位快照复用，行为不变） |
| `scripts/copy-build-assets.mjs` | `assets/legal-snapshot` → `dist/assets/legal-snapshot` |
| `tests/knowledge/legal/offline-snapshot.spec.ts` | 7 条单测：快照检索、在线优先、三条降级路径、schema 不符 |

**未改任何 `inputSchema`**（只改 `outputSchema`/description/metadata，`toolSchemaDigest`
不含这些），因此不触发 llm-replay 重录。

**覆盖缺口（谁因此漏了什么）**

- 上游 7911 份 YAML 里 7893 份 `text` 为空；本地语料补转录后 **7,891 部成功**
  （335,598 条，覆盖率 ≥ 90% 的 7,910 个待转录文件中命中 7,910 个源文件），
  加上 YAML 自带的 17 部，快照共 **7,908 部 / 339,189 条**。仍缺 **2 部**：
  - `civil-code-marriage-family.yaml`（YAML 条号本身是乱码 1000-1009/1100/1110-1118，
    与语料里的 79 条对不上）；
  - `最高人民法院关于执行我国加入的…承认及执行外国仲裁裁决公约…的通知.yaml`
    （4 条只有 3 条符合「第X条」体例）。
  缺口写在 manifest 的 `skipped`（计数 + 原因分布 + 样例），**不伪造正文**。
  这两部在离线模式下查不到，需在线库或人工补录。
- **官方站点抓取被 WAF 阻断**：`flk.npc.gov.cn` 搜索/详情接口可用，但连续约 20 次
  详情请求后整站返回 WZWS JS 挑战页（HTTP 200 + HTML），批量抓取不可行；因此转录
  用的是本机语料，而不是线上全量。
- **不回写上游 YAML**：跨仓库、7891 个文件的大规模不可逆改写没有用户明确授权，且会让
  上游与 Sati 的正文来源分叉；改为「上游只读 + Sati 侧 overlay（`.cache/`，gitignore）→
  构建期合并进快照」。谁因此漏了什么：上游 YAML 仍是 `text: null`，其他复用上游的仓库
  拿不到这批正文。
- 离线模式不支持 `level` / `category` / 时点过滤，依赖这些过滤的调用方会拿到
  `unsupportedFilters`，**不会**拿到「已过滤但结果不对」的静默降级。
- 快照是构建时点切片（`snapshotAt`），不含施行/失效信息；时效性判断仍须在线源或人工复核。
- **降级路径首次查询的冷启动成本**：35MB gz 解压 + 逐行 JSON.parse（解压后约 150MB 内存
  常驻）。在线库可用时不触发；纯离线场景的首个 `law_search` 会明显变慢（秒级），
  但仍在工具超时内（单测用临时小快照，未对 35MB 体积做性能断言——谁因此漏了什么：
  「真实快照大小的首次加载耗时」没有回归测试守护）。

## Alternatives considered

- **原样把 74MB / 7911 份 YAML 放进仓库** — clone 成本、包体积、lint 遍历成本都不可接受，
  且运行期要解析 7911 个文件；落选。
- **打包成 tar.gz / tar.zst 压缩包分发** — 5.6MB / 3.4MB，仍需运行期解 tar + 逐 YAML 解析；
  同体积量级下紧凑 JSONL 零依赖、只解一层，落选压缩包方案。
- **官方站点（`flk.npc.gov.cn`）批量抓取正文** — 搜索/详情接口可用，但连续约 20 次请求后
  整站返回 WZWS JS 挑战页，批量抓取不可行；落选，改用本机语料。
- **把转录结果回写上游 7891 个 YAML** — 跨仓库大规模不可逆改写、未获明确授权，且会让
  上游与 Sati 的正文来源分叉；落选，改为 Sati 侧 overlay 构建期合并。
- **按需构建（首次降级时下载/生成）** — 断网或离线恰是兜底最需要生效的场景，按需构建在
  该场景下大概率失败；落选。
- **全量收录含 `text` 为空的条目（只存元数据）** — 会让「有条目但无正文」冒充可检索，
  模型可能报告「查到了但内容为空的法条」；落选，缺口改为显式 `skipped` 统计。
- **运行期直接读 YAML 目录（若用户自备源）** — 增加一条代码路径与解析依赖，且与
  快照的紧凑格式重复；落选（用户自备源时用构建脚本生成快照即可）。
- **让快照成为并列第一数据源（在线/离线都读）** — 即「双份事实源」：同一法条可能出现
  两个版本（在线库含修正、快照含旧文），排序与时点口径都会打架；落选，快照只兜底。

## Consequences

- `law_search` 的 `outputSchema` 新增**可选**字段 `source` / `snapshotAt` / `snapshotLawCount` /
  `snapshotArticleCount` / `degradedReason` / `unsupportedFilters`，`required` 仍为
  `["total","results"]`：按 required 严格校验的旧消费者不需要改动；需要区分在线/离线的调用方
  自行读取 `source`。**消费方审计结论（2026-10-29）**：仓库内无任何按旧字段集合严格校验
  `law_search` 输出的消费者——`ui/` 侧无 `law_search` 消费面（grep 全仓无命中，该工具结果只经
  gateway 作为模型工具结果流转，UI 不解析其字段），后端仅注册处与测试引用；`source` 保持可选
  不破坏任何消费者，「缺省时语义为 online」由执行层 `backend.source ?? "online"` 保证。
- 降级可见性落在三处（不只 manifest）：工具 description 明示「离线时附
  snapshotLawCount/snapshotArticleCount 回报收录规模」；`skills/legal-agent/SKILL.md` 新增
  「law_search 在线 / 离线快照」行为段（看 source 再下结论、规模以输出字段为准、快照不支持
  level/category/asOf）；输出字段本身（source/snapshotAt/unsupportedFilters/degradedReason）。
  i18n 不适用：该链路无 UI 展示面，文案面向模型，不走 `ui/src/i18n`。
- 新增 `assets/legal-snapshot/` 生成物（**35.21MB**）进入构建产物；重建顺序是
  `node scripts/transcribe-legal-law.mjs`（可选，需本机语料）→
  `node scripts/build-legal-snapshot.mjs`（源目录不在本机时失败并显式报错）。
  没有 `assets/legal-snapshot/` 时 `law_search` 仍会在在线库上正常工作，只是断网/无库时
  退回 `setup_required`。
- 降级路径由 7 条单测覆盖（快照缺失 / knowledge.db 缺失 / knowledge.db schema 版本过高 /
  快照 schemaVersion 不符），断言均检查「可区分」而非只查「不抛异常」。
- 法律文本依《著作权法》第五条不受著作权保护，源包 MIT；`license` 字段随 manifest 分发。
