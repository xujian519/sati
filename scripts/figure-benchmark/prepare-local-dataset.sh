#!/bin/bash
# scripts/figure-benchmark/prepare-local-dataset.sh
#
# 从本地真实案件目录准备附图基准数据集到 ~/.sati/benchmark/figures/。
# 该脚本仅在用户本地运行，不进入 Sati 仓库；真实附图不会提交。

set -euo pipefail

SOURCE_BASE="/Users/xujian/工作/01_专利申请"
BENCH_DIR="${HOME}/.sati/benchmark"
FIGURES_DIR="${BENCH_DIR}/figures"

mkdir -p "${FIGURES_DIR}"

echo "正在准备本地附图基准数据集到 ${FIGURES_DIR} ..."

# 山东大齐 / 管壳式换热器（6 张 PNG）
for i in {1..6}; do
  cp "${SOURCE_BASE}/山东大齐4件/课题一_管壳式换热器/CN202420XXXXXX.7_Figure_${i}.png" \
     "${FIGURES_DIR}/daqi_figure_${i}.png"
done

# 济南东盛 / 供热管道阴极保护系统用电位采集优化装置（4 张 PNG）
cp "${SOURCE_BASE}/济南东盛热电有限公司/02_专利管理/专利撰写/供热管道阴极保护系统用电位采集优化装置/图1_整体结构示意图.png" \
   "${FIGURES_DIR}/dongsheng_figure_1.png"
cp "${SOURCE_BASE}/济南东盛热电有限公司/02_专利管理/专利撰写/供热管道阴极保护系统用电位采集优化装置/图2_噪声滤波电路原理图.png" \
   "${FIGURES_DIR}/dongsheng_figure_2.png"
cp "${SOURCE_BASE}/济南东盛热电有限公司/02_专利管理/专利撰写/供热管道阴极保护系统用电位采集优化装置/图3_自动校准流程图.png" \
   "${FIGURES_DIR}/dongsheng_figure_3.png"
cp "${SOURCE_BASE}/济南东盛热电有限公司/02_专利管理/专利撰写/供热管道阴极保护系统用电位采集优化装置/图4_分布式采集布置图.png" \
   "${FIGURES_DIR}/dongsheng_figure_4.png"

# 博信物流 / 重型厢式货车锁紧器（3 张图）
cp "${SOURCE_BASE}/博信物流1件/说明书附图/图1.jpg" "${FIGURES_DIR}/boxin_figure_1.jpg"
cp "${SOURCE_BASE}/博信物流1件/说明书附图/图2.png" "${FIGURES_DIR}/boxin_figure_2.png"
cp "${SOURCE_BASE}/博信物流1件/说明书附图/图3.png" "${FIGURES_DIR}/boxin_figure_3.png"

# 山东蓝沐（1 张 PDF 转 PNG）
pdftoppm -png -r 200 -singlefile "${SOURCE_BASE}/山东蓝沐/说明书附图.pdf" "${FIGURES_DIR}/lanmu_figure_1"

# 孙俊霞 / 幼苗保护（1 张 PDF 转 PNG）
pdftoppm -png -r 200 -singlefile "${SOURCE_BASE}/孙俊霞1件/说明书附图-幼苗保护.pdf" "${FIGURES_DIR}/sunjunxia_figure_1"

# 李艳 / 滴灌带防堵塞自清洁装置（1 张 PNG）
cp "${SOURCE_BASE}/李艳/fig1_overall_structure.png" "${FIGURES_DIR}/liyan_figure_1.png"

echo "附图准备完成："
ls -lh "${FIGURES_DIR}"
echo ""
echo "下一步："
echo "  1. 确认 ~/.sati/benchmark/manifest.json 已存在并包含 ground truth。"
echo "  2. 运行：pnpm tsx scripts/figure-benchmark/run.ts --provider moonshot --model kimi-k3"
