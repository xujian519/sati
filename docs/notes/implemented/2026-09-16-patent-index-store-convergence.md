# Agent Note: patent 两个索引存储收敛为单一实现（并清退 upsert 队列）

Status: implemented

## Problem

`src/patent/chemistry/index-store.ts` 与 `src/patent/figure/index-store.ts` 实现同一套逻辑
（读容错、版本守卫、逐条 shape 守卫、队列串行化 upsert、损坏备份），是**同构复制**：

- 收敛前 chem 133 行 / fig 131 行（`wc -l` 口径），逐字节相同 **85 行**，并集 **179 行**
  （issue #352 实测，本次用 `difflib.SequenceMatcher` 复核一致）；
- 且已**靠人工维持同步**：`upsertFigureIndex` 的排序键多一个附图编号维度，
  `isFigureIndexEntry` 多校验两个标量字段——差异本身是真实差异，但没有一处代码承载
  「哪些差异是刻意的」。

**差异点恰好 5 项**，收敛必须参数化而不是归一：

| 差异点 | 化学索引 | 附图索引 |
|---|---|---|
| warning 文案前缀 | 化学索引 | 附图索引 |
| `keyOf` | `sourceKey` | `imagePath` |
| `compare` | 来源键字典序 | 先附图编号、再路径 |
| `isValidEntry` | `kind`/`chosenIndex`/`candidates`/`names`/`warnings` | `figureNumber`/`figureType`/`components`/`connections`/`warnings` |
| version 常量名与默认路径 | `CHEMISTRY_INDEX_VERSION` / `.sati/chemistry-index.json` | `FIGURE_INDEX_VERSION` / `.sati/figures-index.json` |

同节的 `TD-PATENT-N24` 记了两条「无上限」：`upsertQueues` 进程级 Map 无淘汰（写入完成后
从不 `delete`，长驻进程跨大量 case 后无界增长），以及 `.corrupt-<ts>` 备份无保留策略。

**核账更正（备份半边不成立）**：issue 与台账都称「反复 upsert 一个坏索引会持续堆积备份
文件」，这条**不可达**——`upsert` 命中 `warning` 时会 `save` 一份**过滤掉无效条目、版本已被
归一**的合法文件，于是第二次 `upsert` 的 `load` 不再产生 `warning`，备份只发生一次。可达的
堆积路径需要「两次 upsert 之间由外部把索引重新改坏」，这不是自动化路径。本条已由判据
钉住（`tests/patent/shared/index-store.spec.ts` 的「损坏备份不堆积」用例：连续三次 upsert
一个已损坏的索引，目录里恰好 1 个 `.corrupt-*`）。

## Decision

**新建 `src/patent/shared/index-store.ts`（151 行）**：导出 `createIndexStore(spec)`，把上述
5 项作为 spec 注入（`label` / `version` / `keyOf` / `compare` / `isValidEntry`），其余逻辑
（ENOENT 与 readFile 容错整段、版本+数组守卫、逐条过滤与 dropped 计数、原子写、队列串行化、
损坏备份）只此一处。

**两个模块退化为「域声明 + 薄包装」**（chem 83 / fig 81 行）：保留全部导出名与类型名
（`*_INDEX_VERSION`、`DEFAULT_*_INDEX_RELATIVE_PATH`、`*IndexEntry`、`*IndexFile`、
`Load*IndexResult`、`load*`/`save*`/`upsert*`），`chemistry/index.ts`、`figure/index.ts`、
`src/patent/index.ts` 三处 barrel 与全部外部引用路径**逐字不变**。两个域各自的
`is*IndexEntry` 留在本域（它是本域知识），文件级 JSDoc 改为指认共享模块。

**每个 `createIndexStore` 实例持有自己的队列**，与收敛前「每模块一份 `upsertQueues`」等价：
不同索引即使共用同一路径也互不阻塞。

**`TD-PATENT-N24` 队列侧**：`settle` 后**仅在自己仍是队尾**（`upsertQueues.get(filePath) === settled`）
时清退该键。无条件 `delete` 会删掉后继的链——后继的 `previous` 指向的 promise 已不在表里，
它会与本次**并发**执行，读-改-写竞态回归。为让这条实现选择**可观测**，实例暴露
`pendingWrites()`（返回仍有排队写入的文件路径数）；不暴露的话这条选择没有任何外部可观测
差异（条目数、产物字节都一样）。

**备份侧不改**，另加一条判据把「首次 upsert 即修复 ⇒ 不堆积」钉住。

## Alternatives considered

- **不收敛，只加跨副本一致性测试** — 落选：同语言内的重复应当**真收敛**，只加一致性判据
  等于在测两份注定漂移的副本（#348 的教训）。跨实现一致性判据留给「无法共用一份文件」的
  场景（TS 运行时 vs shell/mjs 验证脚本）。
- **收敛但不改队列，把 N24 留作下一个 PR** — 落选：队列实现本来就要在收敛中重写，
  「刻意保留一处已知的无界增长」需要在代码里写注释解释为什么保留缺陷；issue 也明确建议
  N23 与 N24 同 PR（N24 的缺陷在两个副本里都存在，收敛后只需修一次）。
- **队列改 LRU（对照 `TranscriptReader.TAIL_STATE_MAX`）** — 落选：队列的键是「**正在**写的
  文件路径」，语义上根本不需要容量上限——写完即应消失，上限只是给内存泄漏加个天花板。
  更关键的是 LRU 会引入新风险面：淘汰一条**仍在排队**的路径后，后续写入不再等待它，
  串行化被破坏。`settled` 即删把队列不变量从「不超过 N 条」加强成「恰好等于进行中的文件数」。
- **备份改为「仅当不存在同名 `.corrupt` 时创建」或「限保留 N 份」** — 落选：核账后该缺陷
  不可达（见 Problem），改它反而把「每次损坏都有独立备份」这一有价值的性质换成有损策略；
  「限保留 N 份」还需引入 `unlink` 与一个没有客观依据的上限取值。
- **备份文件名改为固定 `.corrupt`（每次覆盖）** — 落选：仓内 `CronTaskStore` 与
  `BoardStore` 已用 `.corrupt-<ts>` 命名，专利侧单独改成固定名会造成同类惯用名分叉；
  且固定名会丢失「哪次损坏」这一信息。
- **把备份逻辑一并抽到 `persist-utils.backupCorruptFile()`（与 cron/board 共用）** — 落选：
  三处语义不同——cron/`BoardStore` 用 `rename` 把损坏文件**移出原位**后 fail-closed，
  专利侧用 `copyFile` **保留原位**并继续写入。共用会造出一个「两种语义都要有」的模块。
  本次仅记录该观察（三处 `.corrupt-<ts>` 实现的语义差异），不立项。
- **共享模块放 `src/patent/index-store.ts`（顶层，与 `persist-utils.ts` 同级）** — 落选：
  `src/patent/` 顶层是 barrel 与领域无关工具，`index-store` 与 `index.ts` 命名过于接近；
  `src/knowledge/shared/` 已有「跨模块共享目录」的先例，`shared/` 能直接表达「两侧共用」。

## Consequences

- **总行数上升是常态**：chem/fig 133+131 → 83+81，新增 shared 151，合计 264 → 315（+51）。
  本类改动的验收判据不是行数，而是「实现只有一处」+ 新判据承重。
- 新增 `tests/patent/shared/index-store.spec.ts`（11 例）：注入点承重 4 例、队列清退与备份
  核证 4 例、结构判据 3 例（两个域模块不再出现 `copyFile(` / `atomicWriteJson` / `new Map<`，
  共享模块必须持有）。
- **既有 15 例（chem 5 + fig 10）是等价性证据之一**：它们锁的读容错、版本守卫、shape 过滤、
  覆盖与排序、并发串行化、备份文件命名，全部在收敛后保持绿。
- **产物字节比对是等价性证据之二**（覆盖 11 类产物）：用同一临时脚本分别经 HEAD 版与收敛后版
  生成产物——化学/附图索引文件本体、条目序列化结果、损坏 / 版本不兼容 / 无效条目三种 warning
  文案、损坏备份的文件名形态与内容、无效条目保留集——`updatedAt` 与 `.corrupt-<ts>` 两处
  时间戳按**同一变换**归一后，两侧 `diff -r` **逐字节一致**。（脚本按仓内惯例用完即删；方法即
  本段描述。）
- **负控制 7 组**（逐条核对转红名单、相邻用例仍绿、还原复绿）：删队尾清退→队列 3 例；
  无条件清退→仅「仍是队尾」1 例；`label` 硬编码→完整文案断言 2 例；`compare` 不注入→
  排序 1 例；shape 守卫失效→4 例（含两侧既有）；备份脱离 `warning` 门控→备份核证 1 例；
  域模块出现实现细节→结构判据 1 例。
- **负控制暴露的一处判据独立价值**：fig 既有排序用例的数据（`图1`/`图2` 按路径与按编号
  同序）**无法区分** `compare` 注入与「内建按路径排序」——注入后它保持绿。新 spec 用
  逆序比较器才会转红，故该用例不是冗余。
- **结构判据必须与编译产物同语言**：它按「同名双候选 + 存在性择一」定位模块源码（tsx 直跑读
  `.ts`、`pnpm test` 读 `dist/**.js`）。首轮把某个实现细节写成 TypeScript 泛型形态
  （`new Map<`），在 dist 布局下**假红**——泛型在编译时被擦除；而改成 `new Map(` 后反过来在
  tsx 布局下假红（源码形态是 `new Map<…>(`，有 `<` 无 `(`）。两种形态互斥，正解是只写到
  `new Map`（不带 `<`/`(`）。凡「读产物做文本判据」的地方，都要先确认该文本在两种布局下
  都存在。
- `pendingWrites()` 的语义是「仍有排队写入的**文件数**」而非「请求数」：同一文件的 N 次
  并发 upsert 共享一条队尾链，探针恒为 1。这个语义写进了 JSDoc，也写进了判据（用例同时
  断言同路径与异路径两种形态）。
- 未做：`.corrupt-<ts>` 三处实现（`CronTaskStore` / `BoardStore` / 专利侧）的语义差异收敛，
  见 Alternatives。

## 相关

- issue #352（本 note 对应）、台账 `TD-PATENT-N23`（同构复制）与 `TD-PATENT-N24`（队列无淘汰）
- `src/patent/shared/index-store.ts`、`src/patent/{chemistry,figure}/index-store.ts`
- `tests/patent/{shared,chemistry,figure}/index-store.spec.ts`
- `../../../src/patent/persist-utils.ts`（原子写工具，共享模块的依赖）
