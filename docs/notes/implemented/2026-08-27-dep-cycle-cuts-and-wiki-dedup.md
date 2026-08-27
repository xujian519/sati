# 决策记录：依赖环三刀切割 + 知识库重复树清理（TD-BOUND-003 / TD-KNOWLEDGE-N08）

- 日期：2026-08-27 · 分支：`refactor/dep-cycles-wiki-dup`
- 类别：架构（依赖方向）/ 数据内容清理
- 关联：`docs/technical-debt/backlog.md` TD-BOUND-003、TD-KNOWLEDGE-N08；`docs/technical-debt/audit-report-2026-08-27.md`

## 变更内容

1. **运行时值循环切割（SCC 3→0）**，全部为零行为变化的导入路径改写：
   - SCC-3：新增叶子模块 `src/adapters/channel/tui/app/sessionKey.ts` 承载 `defaultTuiSessionKey`；`TuiChannel.ts` 改为本地导入 + 再导出（公共面不变），`TuiApp.tsx` 直引叶子。
   - SCC-2：`patent/graph/domains/{inventiveness,enablement,novelty}.ts` 对 `GraphBuilder` 由 `../index.js` 改深引 `../engine.js`，类型改自 `../types.js`。
   - SCC-1 运行时闭环边 E1/E5a：`agent/loop/projectToolResults.ts`、`AgentLoop.ts`、`agent/sub/SubAgentSession.ts` 由 `tool/index.js` barrel 改深引 `tool/protocol/{result,types}.js`。
2. **知识库重复树删除**：移除 `src/knowledge/patent/wiki/复审无效/复审无效/`（206 文件 / 2.11MB，其中 205 个与外层同相对路径逐字节相同）。card-index.json 零内层路径引用；`.wiki-meta.json` 的目录摘要失效机制由加载器自愈重建。
3. **复发守卫**：`scripts/measure-techdebt.mjs` 新增 `knowledgeDupMd()`——按内容哈希分组 wiki 全部 md，输出「重复组数 / 冗余文件数 / 冗余字节数」进 JSON 与 metrics.md 异味指标表。

## 验证

- 复扫脚本确认 src 值图 SCC = 0（madge 余量均为编译期擦除的 type-only 链）。
- `pnpm typecheck` ✅ · `pnpm lint`（含 event-matrix 已重生成）✅ · `pnpm format:check` ✅。

## Alternatives considered

- **接口注入反转（在 workflow→agent 边立 port/adapter 接缝）**：protocol 层 seam 本就存在，环的闭环边只是导入路径贪图便利，注入属过度设计——自身即新的偶然复杂度。弃。
- **用 madge 报告作为登记口径**：59 条链中大量 barrel/type-only 幻影，会把良性耦合记成架构债。改为类型感知 SCC 口径（值边才计入），type-only 环留档不治理。
- **只删外层树保留内层**：两层同由 2026-08-02 迁移提交（cad4f61d0）带入，无时间新旧依据；选择保留外层的依据是 card-index.json 与文档引用均只指向外层相对路径，且外层与主题同级目录结构一致，改动面最小。
- **残余 72 组重复卡一并删除**：无法排除有意交叉引用（如同一裁决规则挂两个主题），未获 owner 确认前不动；已由新守卫指标持续可见。
- **守卫做成独立 CI gate**：重复维度低频变化，并入季度性 `measure-techdebt.mjs` 趋势即可，避免再加一条必须绿的提交门禁。

## 后续（不在本批）

- TD-BOUND-003 切割④⑤（workflow/index 去导出 agent 工厂、graph↔workflow 双轨归一）随 WORKFLOW-N01/PATENT-N01 决策批次执行。
- 残余重复卡的 owner 评审。
