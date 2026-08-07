# Changelog

本文件按版本记录 Sati 的重要变更。桌面端版本号（`release(desktop)`）与根 `package.json` 由 `scripts/bump-version.mjs` 同步维护。

## v0.0.19 - 2026-08-07

### Added
- 复用 XiaoNuo `knowledge.db` 统一知识库：知识图谱（21.5 万+ 节点）/ 法规 / 判例 / embeddings 语义召回（bge-m3，14.4 万向量）单库接入，零重新构建
- `scripts/trim-knowledge-db.ts`：knowledge.db 裁剪版生成器（默认去 embeddings 7G → ~4.2G，`--no-fts` → ~1.6G）

### Changed
- 默认知识库目录迁移至 `~/.sati/knowledge`（`SATI_KNOWLEDGE_DIR` / `SATI_KNOWLEDGE_DB` 可覆盖）
- 全库异味消债：收敛重复实现并修复运行时隐患
- 依赖版本对齐并新增权限模块测试

### Fixed
- 修复 wiki 语义索引首次全量 embed 阻塞检索
- 修复记忆托管文件路径解析，聊天引用可正确打开 MEMORY.md
- 修复 build-knowledge-vectors 未传输出路径导致写入临时库

### Docs
- 新增知识库复用与检索/反思相关设计文档（`docs/design/import-xiaonuo-*.md`）

## v0.0.18 - 2026-08-06

### Added
- 判例全文检索：`patent_case_search` 内置工具、knowledge.db 接入与 FTS5 共享工具，invalidity/oa-response/agent 接线
- 附图智能分析：`analyze_patent_figure` / `search_patent_figure` 工具与索引持久化，draft/validate 自动附图说明与图文一致性校验
- 本地真实附图基准测试运行器与 ground truth 清单
- 知识库运行时能力自检与 gateway 可观测性出口；知识库能力面板与 embedding 语义增强配置表单
- CLI 支持 --version/--help 参数，避免未知参数静默进入交互模式
- 无效宣告特征化逐特征检索方法论技能（无效证据收集场景）

### Changed
- 修正 CONTRIBUTING.md 桌面端平台支持声明

## v0.0.17 - 2026-08-05

### Added
- Gateway 协议升级至 **1.1**：discovery-plan 协议化（`always_on_list_plans` / `always_on_read_report` / `always_on_list_cycles` / `always_on_archive_cycle` / `always_on_apply_cycle`）+ 浏览器直连聊天（P2b）双轨
- 引入 flexible-plan 层：阶段级生命周期管理（增删改/确认/回退/法条判定挂接），经 `toManifest()` 交 workflow 执行
- `patent_kg_query` 知识图谱查询内置工具；kg-store 支持 OR 分词检索与 FTS LIKE 兜底
- 增强说明书实质校验并接入 wiki 知识检索；专利技能接入知识图谱与 wiki 卡片必查清单
- 专利业务评测集（196 用例，6 类业务）+ 可复用评测脚本 `patent-eval`（真实 LLM + 规则门收口）
- 模型目录与 thinking registry 对齐 2026-08 官方文档（DeepSeek V4、Kimi 等）

### Fixed
- 加固 flexible-plan 状态机与存储层（code review 11 项）、workflow-run 持久化与 Mermaid 转义
- FTS5 不可用时降级 LIKE，避免 law_search 崩溃
- 修复模型选择链路与 runtime-config 端点、恢复侧边栏折叠按钮

### Perf
- 白盒记忆 SQLite 索引与热路径语句缓存；KG 检索语句缓存、批量 IN、键集分页与 trigram 迁移
- 工具注册表排序缓存与工具名索引缓存；预算评估快速通道；工作流并行度上限；cron 精确调度
- literature GET 缓存 LRU 上限与 Accept 键隔离；网关事件流批量发送与认证前帧上限防护
- UI 首屏按需加载、渲染短路与死代码清理

### Changed
- 统一版本管理（`src/version.ts` 向上解析根 package.json，协议版本独立维度）

## v0.0.16 - 2026-08-04

### Added
- 接线 workflow-runs 持久化与 DAG 桥接；新增独立专利创造性 workflow
- 桌面端 UI 全面美化：品牌色体系（正念蓝 `#4f9cff`）+「正念智能体」品牌名统一、侧边栏与输入框交互打磨

### Fixed
- 修复 pnpm workspace 启动并消除 memory-core 构建竞态

### Changed
- 去重 IM 渠道渲染与命令样板
- 清除 PilotDeck 残留并补充项目来源说明；新增桌面端 UI 美化实施概览文档（`overview.md`）

### CI
- 加固依赖安装 fetch 重试，规避 node-gyp 头文件下载偶发超时

## v0.0.15 - 2026-08-03

### Added
- 引入 nuo-patent 数据引擎与专利检索/元数据/法律状态三个内置工具（`patent_search` / `patent_metadata` / `patent_legal_status`）
- 补全 dual-track 确定性规则检查器与 disclosure 管线
- patent-retriever 角色检索方法升级为结构化工具优先
- 引入免费无 key 学术论文检索 `paper_search` / `paper_list_sources`（arXiv / OpenAlex / Semantic Scholar / Crossref）
- 知识系统能力自检与启动诊断、语义召回熔断与检索结果短时缓存；短 query 检索回退最近用户消息
- 角色工具域一致性校验提示

### Fixed
- 加固专利输出门禁（pending 时序、否定语境、中文数字、审批守卫）
- 修复压缩后 token budget 在聊天历史中的展示；恢复 vite 8 (rolldown) 下的生产构建
- 移植上游压缩一致性重构

### Changed
- 拆分压缩引擎并去重 compact budget
- 清理 lint 债务、补充核心子系统测试、同步 i18n
- 依赖升级并加固 audit 配置；强制 Node 22 major runtime
- 移除 `.reasonix` 本地会话索引与死掉的 PilotDeck 遗留文件
- 新增 nuo-patent 数据引擎集成方案文档（`docs/patent-data-layer-integration.md`）

## v0.0.13 - 2026-08-03

### Added
- 内置专利技能迁移：patent-search、google-patents-search、cnipa-query、patent-download 进入 builtin skills
- 新增 ego_browser 内置工具并接入专利检索链路
- MCP 模块完善可运行性：resources/status 工具、instructions 接线与健壮性修复
- 迁移 Mady 专利工作流能力（含审查加固质量门禁）

### Fixed
- gateway spawn 前兜底释放被占用端口，避免端口冲突导致启动失败
- PDF 预览改用 pdfjs-dist legacy 构建，兼容缺少 ES2025 Map API 的环境
- react-dom 与 react 18 对齐，移除已废弃的 xterm 选项
- edgeclaw-memory-core 在 dev/server 入口前重建，避免加载旧产物
- gateway 默认端口从 18789 调整为 19789，避免与 openclaw 冲突

### Changed
- 依赖升级：vite 8.2.0、@vitejs/plugin-react v6、@xterm/xterm 6.0.0、react-dom、@fontsource-variable/inter 5.3.0、string-width 8.2.2 等
