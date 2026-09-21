# Agent Note: 知识库路径解析透传调用方 env

Status: implemented

## Problem

`createLocalGateway({ env })` 的 `env` 在大多数下游都被消费（`loadPilotConfig({ env })`、
`brandEnv(deps.env, …)` 等），但**知识库路径解析这一处漏了**：

- `src/cli/projectRuntimeFactory.ts`：`const knowledgePaths = resolveKnowledgeDbPaths();`
  ——同文件其它地方都用 `deps.env`，这一行没传；
- `src/cli/ProjectRuntimeRegistry.ts` 的兜底路径同样。

`resolveKnowledgeDbPaths(env = process.env)` 于是读到**宿主进程**的环境变量。后果：

1. **覆盖被静默忽略**：调用方传 `SATI_KNOWLEDGE_DIR` / `SATI_LAW_DB` / `SATI_CASE_DB` /
   `SATI_PATENT_KG_DB` / `SATI_WIKI_DIR` 都不生效，实际用的是宿主 `process.env`（或无覆盖时的
   `~/.sati/knowledge/`）。
2. **意外读取本机数据**：桌面壳、测试、脚本等以自定义 env 构造网关时，会读到宿主本机的知识库。
3. **测量不可复现**（本 note 的发现路径）：`scripts/measure-fixed-overhead.ts` 的文档口径写着
   「空 pilotHome、空工作区 ⇒ 无知识库」，但实测 system prompt 里混进了本机知识卡片
   （法规/商标卡片，数千 token），且命中内容随检索查询漂移——同一场景两次运行 system prompt
   相差 638 token。该脚本给出的「固定开销下界」因此不是下界，也不是可跨机比较的数字。

## Decision

把调用方 env 透传到两处解析点：`resolveKnowledgeDbPaths(deps.env)`（工厂）与
`resolveKnowledgeDbPaths(this.options.env)`（注册表兜底），并加 spec 钉住行为：用指向缺失目录的
`SATI_KNOWLEDGE_DIR` 构造真实网关，`knowledgeCapabilities` 报出的 `dataDir` 必须是该目录，
且 `patent-kg` / `legal-fts` / `case-law` 都不得为 `ready`。

同时新增 `scripts/measure-assembly-stability.ts`（2.3「系统提示分桶」的先量后改工具）：现有脚本
量首个请求的固定开销（token 数），测不出 2.3 要修的问题（**跨轮缓存前缀稳定性**）。新脚本在同一
会话连跑多轮、逐轮抓 `CanonicalModelRequest`，输出 system prompt 的 token 数与 digest（逐轮是否
逐字节一致）、工具 schema 与消息段 token、以及 anthropic 专有的 `cachePlan`（system 块是否打点、
末尾消息偏移、前缀指纹）。

## Alternatives considered

- **只改测量脚本（在脚本内写 `process.env.SATI_KNOWLEDGE_DIR`）** — 落选：掩盖产品缺陷。自定义
  env 被忽略是真实的接线错误，只让测量看得见结果、调用方仍然拿不到自己的 env。
- **让 `resolveKnowledgeDbPaths` 去掉默认参数、强制所有调用点传 env（编译期强制）** — 落选：另有
  7 个工具侧调用点（`law_search` / `patent_kg_query` / `patent_wiki_search` / `patent_case_search` /
  `knowledge_note_save` 等）在工具执行上下文里，那里没有 env 参数可传。本 note 只修「由网关构造、
  明确带着 env」的两处；工具侧仍读 `process.env`（见 Consequences 的残留限制）。
- **把知识库路径在会话装配时解析一次、塞进工具上下文** — 落选：这是更大的改造（工具上下文协议 +
  7 个工具），且与本次要解决的问题（env 被忽略）不成比例；先修接线，结构性问题另议。
- **在测量脚本里把 `HOME` 指向临时目录来隔离** — 落选：`HOME` 会影响一连串与知识库无关的解析
  （pilotHome 兜底、缓存、日志），副作用面远大于收益；且仍不修调用方缺陷。
- **不动 `measure-fixed-overhead` 的文档** — 落选：它的口径声明在修复前后含义不同（「无知识库」
  从假变真），数字也会变；不写清楚会让后来人拿修复前后的数字直接对比，得出错误结论。

## Consequences

- 换来了：自定义 env 的调用方（桌面壳、测试、脚本、桌面端 bundle）真的能覆盖知识库路径；
  `measure-fixed-overhead` 的「下界」口径成立（本机实测非专利工作区 system prompt 6061 → 5099，
  专利工作区同样会下降）。
- **残留限制（有意保留）**：工具侧（`law_search` 等 7 处）仍调 `resolveKnowledgeDbPaths()`
  （读 `process.env`）。当调用方 env 与 `process.env` 不一致时，会话装配用的知识库路径与工具
  打开的知识库可能不同。要彻底统一需要给工具上下文加 env 通道，属独立改造。
- 测量工具的双轨：`measure-fixed-overhead`（单轮 token 下界）与新 `measure-assembly-stability`
  （多轮装配稳定性）。2.3 落地后应给出**同一脚本**的前后对比（system digest 从「被外部编辑打穿」
  变为「稳定」，动态段出现在尾部）。
- 新脚本暂未在 `package.json` 注册 `measure:*` 入口（本工作区的 package.json 另有无关改动在途），
  目前用 `node --import tsx scripts/measure-assembly-stability.ts` 直接调用。
