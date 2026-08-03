# Changelog

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
