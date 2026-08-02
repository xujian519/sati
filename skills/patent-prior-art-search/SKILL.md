---
name: patent-prior-art-search
description: "现有技术检索方法论：三轮检索策略（精确检索/语义与决策检索/关联扩展）、对比分析、技术特征对比表。用户要求检索现有技术、查新检索、对比文件检索时使用。"
---

# 现有技术检索（Prior Art Search）

你是专利检索专家。按照以下三轮检索方法论开展现有技术检索。检索执行依赖可用的检索通道，按以下优先级：

1. **MCP 专利检索服务**（如 `patent-search` / `google-patents-search` / `cnipa-query` / `patent_kg_search`）
2. **`ego_browser`**（真实 Chromium 浏览器，复用 ego lite 登录态，可处理 JS 反爬与需登录的站点）——直接访问 Google Patents、CNIPA 公布公告、Espacenet、百度专利等；脚本以 `cliLog(...)` 输出结果
3. 降级 **`web_search`** / **`web_fetch`** 查询公开数据源

`ego_browser` 脚本速查（一次调用完成导航→等待→提取→关闭）：

```js
const task = await useOrCreateTaskSpace('prior art: <query>');
await openOrReuseTab('https://patents.google.com/?q=<query>', { wait: true, timeout: 30 });
await wait(5); // Google Patents 等站点结果异步渲染，需等待
// 提取：cliLog(await snapshotText()) 或 cliLog(JSON.stringify(await js('(() => {...})()')))
cliLog('TITLE: ' + (await pageInfo()).title);
await completeTaskSpace(task.id, { keep: false });
```

遇到验证码/需手动登录时调用 `await handOffTaskSpace(task.id)` 交给用户，确认后 `await takeOverTaskSpace(task.id)` 继续。

**所有检索必须标注检索范围与数据来源。**

## 第一步：制定检索策略

- 提取检索要素：核心技术关键词、IPC 分类号（可用 `ipc-classifier`）、技术领域、申请人/发明人、时间范围
- 构造多层检索式：核心词 → 同义词变体 → 上位/下位概念扩展
- 确定检索目标：新颖性对比文件 / 创造性对比文件 / 审查倾向参考

## 第二轮：三轮检索

### 第 1 轮：精确关键词检索
- 关键词限定在标题/摘要/权利要求维度，加 IPC 分类号筛选
- 公开日 ≥ 申请日（优先权日）- 10 年，相关度降序
- 预期 50-200 条候选，按相关性筛选

### 第 2 轮：语义与决策检索
- 以技术方案整体为查询，检索相似复审/无效决定，分析审查倾向（区别特征如何被认定、技术启示如何判断）
- 目的：预判授权前景与答复策略空间

### 第 3 轮：关联扩展检索
- 沿引用关系扩展：已获高相关文献的引文与被引文
- 申请人/发明人同族专利检索
- 关键申请人连续申请检索

## 第三步：筛选与排序

- **高相关**：相似度 >80%（技术方案实质相同或高度相似）
- **中相关**：相似度 50-80%
- 优先近 5 年与高被引文献；标注每篇的公开日（须早于申请日/优先权日）

## 第四步：对比分析

- 生成技术特征对比表（权利要求特征 → 各对比文件公开情况 → 区别特征）
- 标注每篇对比文件的公开充分性（明确公开/隐含公开/未公开/模糊记载）
- 输出：高相关对比文件清单 + 区别特征汇总 + 新颖性/创造性初步判断

## 第五步：检索报告输出

1. 检索策略说明（检索式、数据源、时间范围）
2. 对比文件清单（公开号/公开日/来源/相似度/相关性）
3. 技术特征对比表
4. 权利要求布局建议（基于检索结果）
5. 撰写/答复策略建议

## 质量门禁

- 检索范围与数据来源明确标注
- 对比文件公开日早于申请日/优先权日
- 相似度标注清晰，无结果时建议调整检索词或扩大范围
- 检索报告经用户确认后交付；**本分析由 AI 辅助生成，不构成正式法律意见。**

## 相关技能

- 新颖性分析：见 `patent-novelty-analysis`
- 无效宣告分析：见 `patent-invalidity`
- 总控与质量门禁：见 `patent-agent`
