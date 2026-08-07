# CAP02 技术分析 — Workflow 步骤 input_template 共用片段

复制到各模板 `input_template` 中，替换 `{scenario}` 与 `{focus}`。

---

案卷：{{case_dir}}

**场景**：{scenario}

执行 **CAP02 三级技术分析**（`patent-technical-analyzer` 能力层，不可降级为简单特征罗列）：

1. 读取 `sati.md` 与 `converted/` 材料（优先于 source 二进制）
2. **一级**：提取全部技术特征清单
3. **二级**：对每个特征做手段拆解（结构、原理、连接、控制）
4. **三级**：分析技术效果实现机制与问题-手段-效果因果链
5. **对比维度**（如有对比文件/D1）：完成七维解构 + 四级对比矩阵 + 四层区别特征分析
6. **图分析**（≥3 特征或存在因果链时 **必须**）：
   - 写入 `data/cases/{{case_id}}/outputs/tech-graph-spec.json`
   - 运行 `python3.11 assets/scripts/patent/tech-graph-analyze.py build --spec ... --out .../tech-graph-report.md`
7. **HITL**：解构与区别特征清单完成后暂停，请求用户确认再继续

**必须写入** `data/cases/{{case_id}}/outputs/`：
- `technical-deconstruction-target.md` — 目标专利/本发明/交底 {focus}
- `technical-deconstruction-d1.md`（及 d2、d3…，每篇对比文件一篇）
- `technical-comparison-matrix.md`
- `distinctive-features.md`
- `tech-graph-spec.json` + `tech-graph-report.md`（适用时）
- `technical-analysis-report.md` — 综合报告（含 HITL 确认摘要）

**下游约束**：新颖性/创造性/撰写/侵权判定 worker **必须**引用上述 artifacts，不得在无 CAP02 产出时直接下结论。
