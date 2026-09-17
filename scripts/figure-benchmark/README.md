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

---

## 生成侧合规基准（`gen-compliance.ts`）

上述 `run.ts` 是**分析侧**基准（栅格图 → 结构理解，需私有数据集 + 真实模型）。生成侧基准
（`gen-cases.ts` + `gen-compliance.ts`）走相反方向：**入库的固定 FigureSpec 集合 → 渲染 + 核验**，
全部确定性、无模型调用，因此可在 CI 中作回归护栏（`docs/patent-figure-hardening-plan.md` §6.2）。

指标口径：

- **画幅**：每图纸面毫米（`layoutFigure` → `pxToMm`）与是否单独落进 A4 可印区（V7 `page_fit` 的原始素材）；
- **版式**：同文档统一缩放系数（`uniformFigureZoom`，与 `html.ts` A4 版式同源）与缩放后打印字高分布；
- **规则**：V1–V11 命中数（按严重度）与文字面分节覆盖率（V10/V11 是否真正生效）。

```bash
# 与入库基线比对（漂移则列出"哪一例、哪一项、从多少到多少"，非零退出）
pnpm tsx scripts/figure-benchmark/gen-compliance.ts

# 确认漂移符合预期后刷新基线（PR 内须说明理由）
pnpm tsx scripts/figure-benchmark/gen-compliance.ts --update
```

基线文件 `tests/fixtures/patent/figuregen-bench/baseline.json`；断言在
`tests/scripts/figure-benchmark/gen-compliance.spec.ts`（除基线比对外，另有不随基线放宽的
语义锚点：超框判定、打印字高 warn、V4 不误报、V10/V11 分面、LR 画幅落进可印区）。

新增用例：在 `gen-cases.ts` 追加后必须 `--update` 刷新基线（否则 spec 的用例覆盖断言会红）。

