# ego-lite × Sati 集成架构（2026-08）

本文记录 Sati 与 [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) 的集成现状、
能力映射、版本追踪策略与后续演进。配套落地：`src/patent/data/nuo/egoSession.ts`、
`src/tool/builtin/patentPdfDownload.ts`、`skills/ego-browser/learnings/google-patents/`。

## 1. 集成架构（四层）

```
┌─ 技能文档层 ──────────────────────────────────────────────┐
│ skills/**/SKILL.md（20+ 专利技能统一指引 ego_browser 优先） │
├─ 内置工具层 ──────────────────────────────────────────────┤
│ ego_browser（通用脚本透传）                                 │
│ patent_pdf_download（下载拦截批量下载，新）                  │
│ → 共用 egoSession 统一执行封装（新）                        │
├─ 既有数据通道 ────────────────────────────────────────────┤
│ vendor/nuo-patent ego-browser.ts（反爬抓取，独立实现）      │
│ skills/patent-download/scripts/download_patent_ego.py      │
├─ 外部依赖 ────────────────────────────────────────────────┤
│ ego lite app（闭源，macOS）→ `ego-browser` CLI → CDP       │
└───────────────────────────────────────────────────────────┘
```

## 2. ego-lite 能力 → Sati 落地点

| ego-lite 能力 | Sati 落地点 | 状态 |
|---|---|---|
| 任务空间（隔离 + 继承登录态） | 内置 `ego_browser` 工具；`egoSession.taskSpaceName` 会话级复用 | ✅ |
| 快照/定位器（snapshotText/@N/loc） | 内置工具透传脚本 | ✅ |
| **下载拦截** `page.waitForEvent("download")` | `patent_pdf_download` 工具 | ✅ 2026-08 新增 |
| **站点经验包 learnings** | `skills/ego-browser/learnings/google-patents/`（search_patents / get_patent_metadata） | ✅ 2026-08 新增 |
| screencast 录屏留证 | `patent_pdf_download(record: true)`；内置工具 description 指引 | ✅ 2026-08 新增 |
| `--doctor` / `--reload` 诊断 | 内置工具 `doctorCheck` 构造选项（默认关，按需开） | ✅ 2026-08 新增 |
| 多 space 并行 | 内置工具 description 指引（脚本内 Promise.all）；调度器串行保守保留 | ⚠️ 文档级 |
| 进度事件流 | `patent_pdf_download` 输出 `PROGRESS` 行 + 结构化结果；网关推送未做 | ⚠️ 部分 |

## 3. 版本追踪

- **版本追踪**：本机技能包与 ego-lite 官方同步：**v1.2.6**（2026-07-20），CLI `ego-browser 0.4.6.12`。
  注意：**app 内置 harness 可能落后于仓库源码**——本机 0.4.6.12 无 `page` facade
  （`page.waitForEvent("download")` / `page.screencast` / `site` 均不可用，只有顶层 helper）。
  因此 `patent_pdf_download` 在脚本内做**能力探测 + 优雅降级**（无 `page` 时返回 CDN 链接
  `status: "fallback"`），升级后自动获得完整下载拦截能力。升级：`ego-browser upgrade`。
- 升级方式：`git -c http.proxy= clone --depth 1 https://github.com/citrolabs/ego-lite /tmp/ego-lite`，
  再同步 `skills/ego-browser/`（保留本机独有 learnings：github、google-patents）。
- 注意：仓库迭代快（v1.2.3→v1.2.6 仅一个月）。内置工具 description 与 skill 版本需同步维护，
  建议纳入 `scripts/update.sh` 或定期手动检查。

## 4. agentskills spec 对齐

ego-lite 的 learnings 遵循 [agentskills.io](https://agentskills.io/specification)（`spec/agent-skills-spec.md` 指向该 URL）。

- **已对齐**：`manifest.json` 采用 `id/name/domains/notes/nodeTools/browserTools` 结构，
  与 agentskills 站点技能规范一致；nodeTools 为 Node 侧可调用模块（ctx 含 browser/page facade），
  browserTools 为页面上下文内执行的函数。
- **Sati 自有技能体系**（`src/extension/skills/SkillManager`）管理 Sati 的 SKILL.md 技能（角色/工具声明），
  与 ego-browser 的 learnings 是两套生态：learnings 是**浏览器站点经验**，由 ego-browser harness 在脚本内
  通过 `site.runTool(...)` 消费；SKILL.md 是**agent 行为指令**。两者不冲突，互补。
- **建议**：新增浏览器站点经验一律走 learnings 包（`skills/ego-browser/learnings/<site>/`），
  不要写死在 SKILL.md 里；SKILL.md 只负责指引 agent 何时调用 `site.runTool(...)`。

## 5. 已知边界与后续工作

- **三套重复实现收敛**：`vendor/nuo-patent`（vendor 只读，需上游改）与 Python 下载脚本（独立进程）
  维持现状；新增代码统一走 `egoSession.ts`。后续可推动 nuo-patent 上游复用同一会话约定。
- **下载拦截兼容性**：`page.waitForEvent("download")` 依赖浏览器触发真实下载（`<a download>` 点击）。
  站点改为内联预览 PDF 时走 `status: "fallback"` 降级路径。
- **网关进度推送**：批量下载进度目前随工具结果返回；若需 UI 实时进度，需扩展 gateway 协议
  （MINOR 新增方法 + feature-detect），属后续工作。
- **并行配额**：多 space 并行如需调度器级支持，参照 `maxPerSessionMcpInstances` 加配额护栏。
- **平台限制**：ego lite 仅 macOS；Windows/Linux 在官方 roadmap，Sati 侧 `checkAvailability` 已做平台门禁。
