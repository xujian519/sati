# CAP04 检索规划（W-04 patent-search-planner）

## 目标

基于 CAP02 技术分析产出，制定可执行的专利/非专利文献检索策略。

## 输入

- `outputs/technical-analysis-report.md`
- `outputs/technical-deconstruction-target.md`（如有）
- `xiaonuo.md` 中的意图（现有技术调查 / 无效 / 创造性答复等）

## 步骤

1. 提取**核心特征**与**上位概念**（中文 + 英文）
2. 推断 IPC/CPC 分类号（与 CAP02 交叉验证）
3. 构建**分层次检索式**：
   - 宽检索（上位概念 + 分类号）
   - 窄检索（核心特征组合）
   - 引证/同族扩展（如有种子专利）
4. 指定数据库与来源：Google Patents、CNIPA 公布公告、学术库（按技术领域）
5. 日期过滤：现有技术调查/无效须明确申请日/优先权日约束

## 输出

写入 `data/cases/{caseId}/outputs/search-plan.md`，结构：

```markdown
# 检索规划

## 检索目的
## 关键特征摘要（引用 CAP02）
## 关键词（中/英）
## 分类号
## 检索式（分轮次）
## 数据库与来源
## 日期与地域限制
## 预期命中与取舍策略
```

## 约束

- 检索式须可追溯至 CAP02 特征，不得凭空添加技术特征
- 未读 CAP02 报告时只输出阻塞说明，不写检索式
