---
name: cnipa-query
description: CNIPA 公布公告网站查询工具 - 仅限专利法律状态/事务查询。触发场景：(1) "法律状态"、"事务查询"、"实质审查"、"授权"、"驳回" (2) "cnipa"、"公布公告" (3) 专利事务性查询。基于 http://epub.cnipa.gov.cn/ 构建。
priority: high
layer: core
conflict_with: [patent-search, google-patents-search]
preferred_over: [patent-search, google-patents-search]
limitations: 仅中国专利法律状态/事务查询，需 Playwright + Chromium。如需专利详情或PDF下载请用专利检索相关技能。
---

# CNIPA 事务/状态查询（精简版）

基于 CNIPA 公布公告网站（http://epub.cnipa.gov.cn/）的**专利法律状态和事务查询**专用工具。

> **本技能仅用于查询专利事务/法律状态**。如需检索专利、查看详情或下载 PDF，请用对应的专业技能。

## 触发场景

✅ **必须使用**：
- 查询专利法律状态（实质审查、授权、驳回、撤回、无效等）
- 查询专利事务数据/事务记录
- 通过申请号或公布号查询事务

✅ **触发关键词**：
- "法律状态"、"事务查询"、"实质审查"、"授权"、"驳回"、"撤回"、"视为撤回"、"无效"
- "cnipa"、"公布公告"
- 任何涉及中国专利实务状态的查询

❌ **不适用场景**（请转用其他技能）：
- 关键词检索专利 → 用 `patent-search` 或 `google-patents-search`
- 查看专利详情/著录项目 → 用 `patent-search` 或 `google-patents-search`
- 下载专利 PDF → 用 `patent-download`
- 美国/欧洲/海外专利 → 用 `google-patents-search`

## 与相似工具的分工

| 工具 | 职责 | 本技能是否适用 |
|------|------|:------------:|
| **cnipa-query** | **仅法律状态/事务查询** | ✅ **核心** |
| patent-search | 中国专利关键词/语义检索（本地） | ❌ 不适用 |
| google-patents-search | 全球专利在线检索 | ❌ 不适用 |
| patent-download | 专利 PDF 下载 | ❌ 不适用 |

## 决策树

```
需要查询中国专利？
  └─ 需要法律状态/事务？
       └─ 是 → cnipa-query（transaction / patent-transactions）
       └─ 否 → 使用 patent-search-{local|global}
```

## 工具信息

- **工具路径**：`scripts/cnipa_epub_client.py`（本 skill 目录，仓库内 `skills/cnipa-query/scripts/`）
- **工作目录**：先 `cd` 到本 skill 目录（含 `scripts/`），再以相对路径调用；或直接用仓库内绝对路径
- **运行方式**：`python3 scripts/cnipa_epub_client.py <command> <args>`
- **依赖**：Playwright + Chromium（首次需 `python -m playwright install chromium`）；专利页面图片转 PDF 功能另需 Pillow（`pip install pillow`）

## 命令详解

### 1. 事务/法律状态查询（通过申请号）— 推荐

```bash
python3 scripts/cnipa_epub_client.py transaction 2023113560975
```

- **申请号格式**：13 位纯数字，去掉小数点
  - `202311356097.5` → `2023113560975`
  - `202411662208X` → 保持原样（末位是校验位字母）
- **返回**：事务记录列表（序号、申请号、日期、描述）
- **常见事务描述**：公布、实质审查的生效、授权、驳回、撤回、视为撤回、专利权终止等

### 2. 事务查询（通过公布号）— 更方便

```bash
python3 scripts/cnipa_epub_client.py patent-transactions CN122072823A
```

先自动获取申请号，再查询事务。用户只需提供公布号（如 CN122072823A）。

## 使用示例

```bash
# 用户问："202311356097.5 的法律状态是什么？"
python3 scripts/cnipa_epub_client.py transaction 2023113560975

# 用户问："CN122072823A 授权了吗？"
python3 scripts/cnipa_epub_client.py patent-transactions CN122072823A
```

## 注意事项

- 首次运行需通过 Playwright 过 CNIPA WAF，耗时约 10-30 秒
- Session 有效期约 20 分钟，过期后自动重新获取
- 申请号务必去掉小数点，如 `202311356097.5` → `2023113560975`
- 公布号需带 CN 前缀，如 `CN122072823A`
- 环境变量 `CNIPA_LOG=DEBUG` 可开启详细日志
- 环境变量 `PLAYWRIGHT_HEADED=1` 可打开浏览器窗口调试
