---
name: google-patents-search
description: Google Patents 专利检索工具。触发场景：(1) 用户需要检索专利 (2) "专利检索"、"搜索专利"、"谷歌专利"、"查找专利" (3) 关键词检索、布尔检索式、专利号检索、申请人+日期检索 (4) 从文档/PDF/图片理解后构建检索式。结果保存为 Markdown。
---

# Google Patents 专利检索

从 Google Patents 检索专利信息，支持多种检索方式。

## 交互流程

检索完成后，**询问用户是否下载原文**：

```
检索完成！找到 X 个结果，已保存到：
📄 {output_dir}/2026-03-21/xxx.md

需要下载这些专利的 PDF 原文吗？
- Y → 执行 patent-download
- 指定专利号 → 只下载指定篇
- N → 不下载
```

### 下载命令示例

```bash
# 下载检索结果中的所有专利
patent-download US11739244B2 US11563056B2 US12189219B2 ...

# 只下载部分
patent-download US11739244B2
```

---

## 快速使用

> **执行通道（优先级）**：
> 1. **`ego_browser` 工具（首选）**——Sati 内置真实浏览器，复用本地浏览器登录态与插件，直接访问 `https://patents.google.com/?q=<检索式>` 抓取结果；脚本以 `cliLog` 输出。适用于反爬 / 网络隔离场景。**推荐用站点工具**：`site.runTool('google-patents', 'search_patents', { query, maxResults })` 直接出结构化结果（`get_patent_metadata` 取著录项；learnings 包已随技能安装，页面内提取用 `site.runBrowserTool('google-patents', 'extract_search_results', { maxResults })`）。
> 2. **`scripts/patent-search.py`（次选）**——Playwright 驱动浏览器自动化；需 `pip install playwright` 且代理可达 Google Patents。
> 3. 降级 `web_search` / `web_fetch`。
> 4. **本地 `patent-search` 库（最后兜底）**——本机 PostgreSQL 库，仅中国专利；以上通道均不可用或失效时使用。

**执行方式**：脚本在 `scripts/patent-search.py`，使用 `python3` 运行。
> 如需 `patent-search` 命令，创建 alias：`alias patent-search='python3 /path/to/scripts/patent-search.py'`

```bash
cd <本 skill 目录，仓库内为 skills/google-patents-search/>

# 关键词检索
python3 scripts/patent-search.py "phase change material"

# 布尔检索式
python3 scripts/patent-search.py "(phase change OR PCM) AND (thermal OR heat)"

# 专利号检索
python3 scripts/patent-search.py "US11739244B2"

# 申请人+日期
python3 scripts/patent-search.py "assignee:(Samsung) after:20200101"

# 指定结果数量
python3 scripts/patent-search.py "battery technology" --limit 30

# 只返回搜索结果（更快）
python3 scripts/patent-search.py "solar panel" --no-details

# 输出 JSON 格式
python3 scripts/patent-search.py "AI chip" --json
```

## 输出

默认保存到（可通过 `PATENT_SEARCH_OUTPUT` 环境变量修改）：
```
{output_dir}/YYYY-MM-DD/{查询词}_{时间戳}.md
```

Markdown 包含：
- 公开号/授权公告号
- 标题
- 申请人
- 发明人
- 公开日期
- 申请号
- 摘要
- Google Patents 链接
- PDF 下载链接

## 检索语法

Google Patents 支持以下检索语法：

| 语法 | 示例 |
|------|------|
| 关键词 | `battery` |
| 短语 | `"lithium ion battery"` |
| AND | `battery AND electric` |
| OR | `battery OR accumulator` |
| NOT | `battery NOT phone` |
| 申请人 | `assignee:(Samsung)` |
| 发明人 | `inventor:(Wang)` |
| 日期范围 | `after:20200101 before:20231231` |
| 专利号 | `US11739244B2` |

## 代理配置

Google Patents 需科学上网。脚本默认使用 `http://127.0.0.1:9981` 代理。

- `--proxy http://host:port` 指定其他代理
- `--no-proxy` 不使用代理

也可通过环境变量配置：
```bash
# 默认代理
export PATENT_SEARCH_PROXY="http://127.0.0.1:9981"

# 输出目录
export PATENT_SEARCH_OUTPUT="$HOME/Documents/patent-search"
```

## 从文档构建检索式

当需要从 PDF/图片/文档理解后构建检索式时，使用以下工作流：

### 工作流

```
步骤1: 分析文档 → 提取技术特征
步骤2: 生成关键词（中英文）
步骤3: 构建布尔检索式
步骤4: 执行检索
```

### 技术特征提取框架

分析文档时，提取以下维度的信息：

| 维度 | 内容 | 示例 |
|------|------|------|
| 技术领域 | 所属技术领域 | 相变材料、热管理 |
| 技术问题 | 解决的技术问题 | 散热效率低、温度控制不精确 |
| 技术方案 | 核心技术手段 | PCM胶囊、复合散热结构 |
| 关键参数 | 关键参数/材料 | 正十八烷、SEBS共聚物 |
| 技术效果 | 达到的技术效果 | 热导率提升50%、温度稳定性 |

### 关键词生成规则

1. **核心关键词**: 技术方案的核心术语（2-5个）
2. **同义词扩展**: 包含同义词、近义词
3. **中英文对照**: 同时生成中英文关键词
4. **分类号**: 推断 IPC/CPC 分类号（可选）

### 检索式构建模板

```
# 简单检索
"关键词1" OR "关键词2"

# 组合检索（推荐）
(关键词1 OR 同义词1) AND (关键词2 OR 同义词2)

# 精确检索
(关键词1 OR 同义词1) AND (关键词2 OR 同义词2) AND assignee:(公司名)

# 排除检索
关键词1 AND NOT (不相关词1 OR 不相关词2)
```

### 示例

**输入**: 一份关于"相变材料热管理"的技术交底书

**AI 分析后提取**:
- 技术领域: 相变材料、热管理、散热
- 核心技术: PCM胶囊、聚合物基体
- 关键材料: 正十八烷、正十六烷
- 技术效果: 热稳定性、循环寿命

**生成的检索式**:
```
(phase change material OR PCM OR 相变材料) AND (thermal management OR heat dissipation OR 热管理 OR 散热)
```

**执行**:
```bash
patent-search "(phase change material OR PCM OR 相变材料) AND (thermal management OR heat dissipation OR 热管理 OR 散热)" --limit 30
```

## 参考资料

- `references/google-patents-syntax.md` — Google Patents 检索语法详解
- `references/IPC-classification.md` — IPC 国际专利分类号参考
- `references/search-methodology.md` — 检索方法论

## 脚本位置

```
scripts/patent-search.py
```
