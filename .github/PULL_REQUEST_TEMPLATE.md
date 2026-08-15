## 描述

<!-- 简要描述本 PR 的变更内容与动机。 -->

关联 Issue: #<!-- 填写 Issue 编号，无则删除此行 -->

## 变更类型

- [ ] 🆕 feat: 新功能
- [ ] 🐛 fix: Bug 修复
- [ ] 📝 docs: 文档
- [ ] ♻️ refactor: 重构
- [ ] ✅ test: 测试
- [ ] 🔧 chore: 杂项
- [ ] ⚡ perf: 性能优化
- [ ] 🎨 style: 代码风格

## 测试说明

<!-- 说明如何验证本变更：运行的测试命令、手工测试步骤等。 -->

- [ ] 本地 `pnpm test` 通过
- [ ] `pnpm lint` 与 `pnpm format:check` 通过
- [ ] `pnpm typecheck` 通过
- [ ] 新增/修改了单元测试

## 视觉验证

<!-- 凡涉及 UI 渲染（组件 / 样式 / 布局 / 主题 / 动画）的变更，必须完成视觉验证；
     无 UI 变更则仅勾选“本 PR 不涉及视觉变更”。规范详见 CONTRIBUTING.md。 -->

- [ ] 本 PR 不涉及视觉变更（仅后端 / 文档 / 配置等）

**若涉及 UI 变更，请完成以下验证并附证据：**

- [ ] 已附 **Before / After 对比截图**（或录屏），置于下方"证据"折叠区
- [ ] 已在 **亮色 + 暗色** 两种主题下验证（`DarkModeToggle`）
- [ ] 已在 **中文 (zh-CN) + 英文 (en)** 两种语言下验证（i18n 文案无截断 / 溢出）
- [ ] 已检查关键交互状态：默认 / hover / disabled / loading / empty / error
- [ ] 已检查响应式断点（桌面 ≥1280 / 平板 / 移动）下无布局错位或溢出
- [ ] 桌面端（Electron）变更已在目标平台（mac / win）验证（如适用）
- [ ] 浏览器控制台无新增 error / warning

**截图规范**

- 视口：Web 端默认 1280×800；移动态请标注视口宽度
- 格式：PNG 优先；录屏用 GIF / MP4
- 标注：每张图注明「页面 / 主题 / 语言 / 状态」

<details>
<summary>证据（Before / After 截图或录屏）</summary>

<!-- 在此粘贴截图或录屏链接 -->

</details>

## 自查清单

- [ ] 遵循项目开发规范（见 [CONTRIBUTING.md](../CONTRIBUTING.md)）
- [ ] 未引入 `any` 或 `@ts-ignore`
- [ ] 新增用户可见文案已提取到 i18n（`ui/src/i18n/`，en + zh-CN）
- [ ] Commit 遵循 Conventional Commits 规范
- [ ] 更新了相关文档（如需）
