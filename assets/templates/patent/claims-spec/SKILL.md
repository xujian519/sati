---
name: patent-claims-specification
description: |
  权利要求书与说明书模板（专利律师场景交付物）。将技术交底书转化为符合中国专利法
  及专利审查指南格式的权利要求书、说明书、摘要，支持内部审稿版与正式提交版切换。
triggers:
  - "权利要求书"
  - "说明书"
  - "专利申请文件"
  - "patent claims specification"
template:
  kind: patent-document
  mode: draft
  scenario: patent-drafting
  preview:
    type: html
    entry: assets/template.html
  exports: [html, pdf]
---

# 权利要求书与说明书模板

将技术交底书转化为**符合中国专利法及专利审查指南格式的权利要求书、说明书与摘要**。本模板同时输出内部审稿版（带密级/免责声明）与正式提交版（去除内部标识）。

## 输入要求

渲染前必须已具备：

1. 技术交底书（技术领域、背景技术、发明内容、附图、实施例）。
2. 技术方案分解表（PFE 三元组）与特征层级。
3. 现有技术检索结果（用于撰写背景技术和权利要求时避让）。
4. 附图清单（图号、图名、对应说明）。
5. 申请人信息、发明人信息（用于扉页）。

## 工作流

1. 读 `references/conventions.md`。
2. 复制 `assets/template.html` 为 `claims-spec.html`。
3. 填充：案件信息 → 权利要求书 → 说明书（技术领域/背景技术/发明内容/附图说明/具体实施方式）→ 摘要 → 落款/页脚。
4. 权利要求书采用层级递进：独立权利要求 → 从属权利要求；从属引用用「如权利要求 X 所述的……」。
5. 说明书五部分顺序固定：技术领域 → 背景技术 → 发明内容 → 附图说明 → 具体实施方式。
6. 按 `references/checklist.md` 自查后定稿。

## 输出契约

```
文件：claims-spec.html（单文件、内联 CSS）
可选：claims-spec.pdf（A4 打印）
     claims-spec.md（源稿）

模式切换：
- 内部审稿版：默认渲染，保留抬头密级与免责声明。
- 正式提交版：渲染前覆盖 `--sati-doc-confidential` 为空字符串，并删除页脚 disclaimer 区块。
```

品牌变量由 `assets/templates/patent/tokens.css` 注入；agent 不修改样式。
