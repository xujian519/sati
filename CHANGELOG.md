# Changelog

## v0.0.18 - 2026-08-06

### Added
- 判例全文检索：patent_case_search 内置工具、knowledge.db 接入与 FTS5 共享工具，invalidity/oa-response/agent 接线
- 附图智能分析：analyze_patent_figure / search_patent_figure 工具与索引持久化，draft/validate 自动附图说明与图文一致性校验
- 本地真实附图基准测试运行器与 ground truth 清单
- 知识库运行时能力自检与 gateway 可观测性出口；知识库能力面板与 embedding 语义增强配置表单
- CLI 支持 --version/--help 参数，避免未知参数静默进入交互模式
- 无效宣告特征化逐特征检索方法论技能（无效证据收集场景）

### Changed
- 修正 CONTRIBUTING.md 桌面端平台支持声明

## v0.0.16 - 2026-08-04

### Added
- 引入 nuo-patent 数据引擎与专利检索/元数据/法律状态三个内置工具（patent_search / patent_metadata / patent_legal_status）
- 新增独立专利创造性 workflow，并接线 workflow-runs 持久化与 DAG 桥接
- 补全 dual-track 确定性规则检查器与 disclosure 管线
- patent-retriever 角色检索方法升级为结构化工具优先
- 引入免费无 key 学术论文检索 paper_search / paper_list_sources（arXiv / OpenAlex / Semantic Scholar / Crossref）
- 知识系统能力自检与启动诊断、语义召回熔断与检索结果短时缓存
- 短 query 检索回退最近用户消息
- 桌面端 UI 全面美化：品牌色体系 + 「正念智能体」品牌名统一、侧边栏与输入框交互打磨

### Fixed
- 修复 pnpm workspace 启动并消除 memory-core 构建竞态
- 修复压缩后 token budget 在聊天历史中的展示
- 加固专利输出门禁（pending 时序、否定语境、中文数字、审批守卫）

### Changed
- 去重 IM 渠道渲染与命令样板
- 拆分压缩引擎并去重 compact budget
- 依赖升级并加固 audit 配置；强制 Node 22 major runtime
- 清理 lint 债务、补充核心子系统测试、同步 i18n
- 文档：新增 nuo-patent 数据引擎集成方案、桌面端 UI 美化概览；清除 PilotDeck 残留

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
