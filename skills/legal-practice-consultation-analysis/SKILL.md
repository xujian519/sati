---
name: legal-practice-consultation-analysis
description: "当用户需要就中国法问题形成可追溯的咨询分析、客户答复或正式意见草稿时使用；仅核对一条法规原文时改用 legal-research-cn 的 authority-check。"
---

# 法律咨询分析

先读 `./.legal/practice/law-practice-cn.md`、`./.legal/references/consulting-workflow.md` 和目标工作区规则。共享参考中的固定建目录步骤仅在项目尚无目录且用户要求保存底稿时执行；已有项目按其文件契约存放，不迁移原件。确认服务对象、利益冲突状态、事实发生日、所问法律关系和交付深度。

1. 将原始问题、客户真正要决定的事项、已知事实与待核事实分开；复杂问题拆成有依赖顺序的子问题。发现紧迫期限时先标记，尚无送达或知悉证据时不作确定计算。
2. 按工作区来源策略研究；用 `authority-check` 的方法核对关键规范原文、版本与时点，用 `case-comparison` 的方法处理类案。检索摘要和模型记忆仅作线索。记录查询式、工具、来源定位、失败和未覆盖项。
3. 依据使用场景选择简答、单问题分析、综合咨询或正式法律意见草稿。输出“条件化结论—已知/待证事实—法律依据—相反解释—风险—可行动方案—待确认事项”。不得将客户叙述直接写成已查明事实。
4. 正式交付前做来源覆盖、时效、程序、期限和证据自检；关键依据不可得时停止对应确定性结论，交律师复核。未经授权不对外发送客户材料或答复。

逐项检查 task_context、`jurisdiction`、`temporal`、`actors`、`matter`、claims_and_elements、authority_and_interpretation、`proof`、`procedure`、outcomes_and_enforcement、strategy_and_uncertainty、`governance`；适用项写最低结论，不适用项写本案理由，受阻项列缺口和停止路径。

## 作者与来源

- 作者：CSlawyer
- 主页：https://chenshi.ai
- 编制方法：legal-meta-skill；具体法律依据与项目规则须在运行时核验。

## Sati 检索接线

- 在本项目中，法条原文优先用 `law_search` 检索（宝宸知识库，含法律层级过滤与现行/失效标注）；引用成稿前用 `law_verify` 逐条做形式核验。
- `law_search` / `law_verify` 不可用或未命中时，如实标注「未检索到 / 未做形式核验」，不得以模型记忆补法条。
