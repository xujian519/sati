---
name: patent-search
description: 本地专利检索 - 7520万中国专利，毫秒级响应。触发：(1) 中国专利检索 (2) 关键词/申请人/IPC检索 (3) 批量统计。优先于 google-patents-search（本地更快）。
priority: high
layer: core
conflict_with: [google-patents-search]
preferred_over: google-patents-search
limitations: 仅中国专利，无美国/欧洲专利
---

# 专利检索技能（本地）

> **首选方案**：检索中国专利时，优先使用本技能（速度快、无需代理）

## 核心优势

- **速度**：本地数据库，毫秒级响应
- **数据量**：7520万中国专利
- **无需代理**：不依赖外网
- **语义检索**：支持向量相似度搜索

## 触发场景

✅ **适用场景**：
- 检索中国专利（CN开头）
- 关键词检索（中文）
- 申请人检索（中国企业/个人）
- IPC分类检索
- 批量统计分析
- 快速预检索

❌ **不适用场景**：
- 美国专利（US开头）→ 用 `google-patents-search`
- 欧洲专利（EP开头）→ 用 `google-patents-search`
- PCT 专利 → 用 `google-patents-search`
- 需要原文 PDF → 先检索，再用 `patent-download`

## 与相似工具的区别

| 工具 | 数据范围 | 速度 | 代理 | 适用场景 |
|------|---------|------|------|---------|
| **patent-search** | 中国专利 | ⚡ 毫秒级 | ❌ 不需要 | **中国专利首选** |
| google-patents-search | 全球专利 | 🐢 秒级 | ✅ 需要 | 美国专利、欧洲专利 |

## 决策树

```
需要检索专利？
  ├─ 是中国专利？
  │    └─ 是 → patent-search（首选）
  │    └─ 否（美国/欧洲/PCT）→ google-patents-search
  └─ 不确定？
       └─ 先用 patent-search 预检索，再用 google-patents-search 补充
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

- **执行前先解析本 skill 目录**（含 `scripts/` 的目录，仓库内为 `skills/patent-search/`），用 `cd` 进入后再以相对路径调用脚本，或直接用该绝对路径调用。
- 依赖本机 PostgreSQL（见"数据库信息"）；数据库未启动时先执行启动命令再检索。
- 数据量大（7520万条），建议使用 limit 限制返回数量
- 全文检索使用 PostgreSQL 的中文分词功能 (zhparser)
- 语义检索（向量相似度）由 `search_patents.py` 的方案理解模式生成检索式后，在 Google Patents 等在线源执行；`patent_search.sh` 本身不提供 `--semantic` 选项
- 日期格式: YYYY-MM-DD
