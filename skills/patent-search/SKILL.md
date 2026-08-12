---
name: patent-search
description: 本地专利检索（兜底）- 7520万中国专利，毫秒级响应。触发：(1) 本地浏览器（ego_browser）与浏览器自动化通道不可用或失效时的中国专利兜底检索 (2) 关键词/申请人/IPC检索 (3) 批量统计。优先级：本地浏览器 → 浏览器自动化 → 本地库（最后兜底）。
layer: fallback
limitations: 仅中国专利，无美国/欧洲专利；需本机 PostgreSQL 已启动
---

# 专利检索技能（本地，兜底）

> **兜底方案**：仅当本地浏览器（`ego_browser`，复用登录态/插件）与浏览器自动化通道不可用或失效时，作为**最后兜底**检索中国专利（速度快、无需代理）

## 核心优势

- **速度**：本地数据库，毫秒级响应
- **数据量**：7520万中国专利
- **无需代理**：不依赖外网
- **语义检索**：支持向量相似度搜索

## 触发场景

✅ **适用场景**（浏览器通道不可用时的兜底）：
- 检索中国专利（CN开头）
- 关键词检索（中文）
- 申请人检索（中国企业/个人）
- IPC分类检索
- 批量统计分析
- 快速预检索

❌ **不适用场景**：
- 美国专利（US开头）→ 用 `google-patents-search` 或 `ego_browser`
- 欧洲专利（EP开头）→ 用 `google-patents-search` 或 `ego_browser`
- PCT 专利 → 用 `google-patents-search` 或 `ego_browser`
- 需要原文 PDF → 先检索，再用 `patent-download`

## 与相似工具的区别

| 工具 | 数据范围 | 通道 | 适用场景 |
|------|---------|------|---------|
| **ego_browser** | 全球专利 | 本地浏览器（复用登录态/插件） | **所有检索首选** |
| google-patents-search | 全球专利 | Playwright 浏览器自动化 | 浏览器自动化次选 |
| patent-search | 中国专利 | 本机 PostgreSQL 库 | **最后兜底**（仅浏览器通道不可用时） |

## 决策树

```
需要检索专利？
  ├─ 首选：本地浏览器 ego_browser（复用登录态/插件，处理反爬）
  │      → 直接访问 Google Patents / CNIPA / Espacenet 检索
  ├─ 次选：浏览器自动化（google-patents-search 的 Playwright 脚本等）
  └─ 兜底：本地 patent-search（本机 PG 库，仅中国专利）
       └─ 数据库未启动时先执行启动命令再检索
```

## 数据库信息

- **数据库名**: patent_db
- **表名**: patents
- **数据量**: ~7520 万条专利
- **连接**: 直连 PostgreSQL `postgresql://127.0.0.1:5433/patent_db`（数据目录在移动硬盘 `/Volumes/AthenaData/backup_from_pro/postgresql@17`）
- **启动命令**: `/Library/PostgreSQL/17/bin/pg_ctl start -D /Volumes/AthenaData/backup_from_pro/postgresql@17 -o "-p 5433" -l /tmp/pg_patent.log -w`

## 主要字段

| 字段 | 说明 |
|------|------|
| patent_name | 专利名称 |
| application_number | 申请号 |
| publication_number | 公开号 |
| authorization_number | 授权号 |
| applicant | 申请人 |
| inventor | 发明人 |
| abstract | 摘要 |
| claims | 权利要求 |
| ipc_code | IPC分类号 |
| ipc_main_class | IPC主分类 |
| application_date | 申请日期 |
| source_year | 年份 |

## 检索方式

### 1. 关键词检索
```bash
./scripts/patent_search.sh --keyword "人工智能" --limit 10
```

### 2. 申请人检索
```bash
./scripts/patent_search.sh --applicant "华为" --limit 20
```

### 3. IPC分类检索
```bash
./scripts/patent_search.sh --ipc "G06" --limit 20
```

### 4. 日期范围检索
```bash
./scripts/patent_search.sh --year 2024 --limit 50
./scripts/patent_search.sh --date-range 2023-01-01 2024-12-31 --limit 50
```

### 5. 全文检索
```bash
./scripts/patent_search.sh --fulltext "深度学习 神经网络" --limit 20
```

### 6. 方案理解检索（生成检索式与链接）

```bash
python3 scripts/search_patents.py "自动驾驶技术" -n 20
# 或直接给检索式
python3 scripts/search_patents.py -q "(人工智能 OR 深度学习) AND 图像识别" -n 20
```

### 7. 专利详情
```bash
./scripts/patent_search.sh --detail "CN202310000001"
```

### 8. 统计分析
```bash
./scripts/patent_search.sh --stats
./scripts/patent_search.sh --top-applicants --limit 20
./scripts/patent_search.sh --top-ipc --limit 20
```

## 使用示例

### 检索人工智能相关专利
```bash
cd <本 skill 目录，含 scripts/>
./scripts/patent_search.sh --keyword "人工智能" --limit 10
```

### 检索华为的专利
```bash
./scripts/patent_search.sh --applicant "华为" --limit 20
```

### 检索2024年G06类专利
```bash
./scripts/patent_search.sh --year 2024 --ipc "g06" --limit 30
```

### 获取专利详情
```bash
./scripts/patent_search.sh --detail "CN202310000001"
```

## 注意事项

- **优先级**：本技能是**最后兜底**。检索专利时先尝试本地浏览器 `ego_browser`（复用登录态/插件），其次浏览器自动化（`google-patents-search` 的 Playwright 脚本），两者均不可用或失效时才使用本技能。
- **执行前先解析本 skill 目录**（含 `scripts/` 的目录，仓库内为 `skills/patent-search/`），用 `cd` 进入后再以相对路径调用脚本，或直接用该绝对路径调用。
- 依赖本机 PostgreSQL（见"数据库信息"）；数据库未启动时先执行启动命令再检索。
- 数据量大（7520万条），建议使用 limit 限制返回数量
- 全文检索使用 PostgreSQL 的中文分词功能 (zhparser)
- 语义检索（向量相似度）由 `search_patents.py` 的方案理解模式生成检索式后，在 Google Patents 等在线源执行；`patent_search.sh` 本身不提供 `--semantic` 选项
- 日期格式: YYYY-MM-DD
