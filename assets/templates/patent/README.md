# Sati 专利文书模板目录

本目录存放 Sati 面向专利代理/律师场景的**正式文档交付物模板**。所有模板共享同一份文书品牌契约（`DOCS.md` + `tokens.css`），保证不同交付物在视觉上保持一致、专业、可打印。

## 目录结构

```
assets/templates/patent/
├── DOCS.md                  # 文书品牌契约（设计语言 prose）
├── tokens.css               # 可覆盖的 CSS 语义变量表
├── manifest.json            # 机器可读设计系统清单
├── README.md                # 本文件
└── patentability-opinion/   # 可专利性分析意见书（首个落地模板）
    ├── SKILL.md             # agent 工作流与输入/输出契约
    ├── assets/
    │   └── template.html    # 单文件 HTML 骨架
    ├── example.html         # 虚构填充示例（风格确认用）
    └── references/
        ├── conventions.md   # 版式惯例
        ├── citation-log.md  # 引用日志规范
        └── checklist.md     # P0/P1/P2 自查清单
```

## 设计目标

- **证据优先**：每条关键结论都有来源类型与 pin-cite 定位。
- **层级清晰**：抬头 → 文号 → 元数据 → 章节 → 证据/引用日志 → 落款。
- **A4 打印优先**：屏幕与纸质输出一致。
- **可品牌化**：通过 `tokens.css` 与 `products/<标识>/brand/theme.json` 覆盖。
- **anti-AI-slop**：固定结构、强制引用、置信度徽章，避免空洞长文。

## 使用方式

### 1. agent 渲染

agent 读取对应模板目录下的 `SKILL.md`，按其中「输入要求」补齐材料后：

1. 复制 `assets/template.html` 为输出文件。
2. 填充内容；保留 CSS 变量，不改样式。
3. 按 `references/checklist.md` 自查。
4. 输出 `html`，可选 `pdf`（通过 Playwright/Chromium 打印到 PDF）。

### 3. 模板切换

| 任务 | 使用模板 |
|---|---|
| 评估授权前景 | `patentability-opinion` |
| 出具检索报告 | `search-report` |
| 答复审查意见 | `oa-response` |
| 撰写申请文件 | `claims-spec` |
| 发起/分析无效 | `invalidation-opinion` |

### 2. 品牌覆盖

如需为具体事务所/产品定制品牌：

1. 复制 `products/_example` 为 `products/<标识>`。
2. 在 `products/<标识>/brand/theme.json` 中声明覆盖值。
3. 渲染管线在生成 HTML 时把覆盖后的 CSS 变量注入 `<style>` 块。

当前可覆盖的变量见 `tokens.css`。品牌变更**不改动模板 HTML**。

## 模板清单

| 模板 | 状态 | 场景 |
|------|------|------|
| `patentability-opinion` | ✅ 已落地 | 可专利性分析意见书 / 授权前景分析 |
| `search-report` | ✅ 已落地 | 专利检索报告 |
| `oa-response` | ✅ 已落地 | 审查意见答复 / 意见陈述书 |
| `claims-spec` | ✅ 已落地 | 权利要求书 / 说明书（含内部审稿版与正式提交版切换说明） |
| `invalidation-opinion` | ✅ 已落地 | 无效请求 / 无效宣告意见 |

## 相关

- `assets/prompts/patent/` — 专利分析提示词
- `assets/workflows/patent/` — 专利工作流定义
- `skills/patent-agent/` — 专利 agent 角色与质量门
- `src/patent/claim-chart/` — 特征比对与 pin-cite 校验
- `products/_example/` — 产品白标配置示例
