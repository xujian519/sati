# 专利附图真实基准测试

本地真实附图数据集与 `analyze_patent_figure` 的评估运行器。所有真实客户附图仅保存在 `~/.sati/benchmark/figures/`，**不进入 Sati 仓库**，避免泄露。

## 数据集

- `~/.sati/benchmark/manifest.json`：ground truth（附图类型、预期标号、关键组件名、来源案件）。
- `~/.sati/benchmark/figures/*.png|jpg`：16 张真实专利附图。
- `~/.sati/benchmark/results/run-*.json`：每次运行结果。

## 来源（本地）

从 `/Users/xujian/工作/01_专利申请` 选取，覆盖机械、流程、电路、方框图等多种类型：

| 案件 | 图数 | 类型 |
|---|---|---|
| 山东大齐 / 管壳式换热器 | 6 | structure / block_diagram |
| 济南东盛 / 电位采集优化装置 | 4 | block_diagram / circuit / flowchart / schematic |
| 博信物流 / 货车锁紧器 | 3 | structure |
| 山东蓝沐 | 1 | structure |
| 孙俊霞 / 幼苗保护 | 1 | structure（一纸双图） |
| 李艳 / 滴灌自清洁装置 | 1 | block_diagram（英文标注） |

## 运行评估

```bash
pnpm tsx scripts/figure-benchmark/run.ts --provider moonshot --model kimi-k3
```

可选参数：

- `--provider moonshot`
- `--model kimi-k3`
- `--limit N`  只跑前 N 张

示例（冒烟）：

```bash
pnpm tsx scripts/figure-benchmark/run.ts --provider moonshot --model kimi-k3 --limit 1
```

## 指标说明

- **typeAccuracy**：附图类型分类准确率（与 humanFigureType 对比）。
- **avgRefPrecision / Recall / F1**：基于 `expectedRefNumbers` 的标号检测平均精确/召回/F1。
- **avgConfidence**：模型返回的平均置信度。
- **usableRate**：`usable=true` 的比例。

## 维护

新增图幅时：

1. 将附图复制/渲染到 `~/.sati/benchmark/figures/`。
2. 在 `~/.sati/benchmark/manifest.json` 中追加条目。
3. 重新运行评估。

## 数据保密

`~/.sati/benchmark/` 在用户主目录，不在 Git 工作区内。运行器仅输出结果 JSON 到该目录，不会把附图提交到仓库。
