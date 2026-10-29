---
name: legal-procurement-contract-performance
description: "当用户需要审查政府采购或招标项目中标后的签约、变更、验收、付款或履行争议时使用；投标资格与评分审查改用 bid-review。"
---

# 采购合同履行审查

先读领域 `实务画像`，确认项目适用制度、服务角色、合同主体与当前阶段。建立公告/采购文件—中标/成交结果—响应文件—正式合同—变更—履约—验收—付款的版本与证据链。逐项比对标的、规格、数量、价格、工期、质量、验收、违约、解除和争议解决条款。

区分技术性澄清、合同允许的调整与可能改变采购实质条件的变更。对每项差异记录文件定位、签署/授权、履行事实、适用规范原文、可能法律效果及补救动作；不能凭“双方同意”直接断言变更合法。核对履约保证、验收组织、付款前提和财政预算约束时按具体地区、时点核验。

输出履约风险矩阵、待核实证据、优先行动和可逆性。法律上可主张的款项与实际拨付或执行可能性分开。不得自行生成或发送变更指令、验收结论、付款审批。

逐一检查 task_context、`jurisdiction`、`temporal`、`actors`、`matter`、claims_and_elements、authority_and_interpretation、`proof`、`procedure`、outcomes_and_enforcement、strategy_and_uncertainty、`governance`。重点展开法律关系、规范、证据、效果和执行，其他模块记录不适用理由或受阻路径。

## 作者与来源

- 作者：CSlawyer
- 主页：https://chenshi.ai
- 编制方法：legal-meta-skill；法律依据与项目规则均须在运行时复核。

## Sati 检索接线

- 在本项目中，法条原文优先用 `law_search` 检索（宝宸知识库，含法律层级过滤与现行/失效标注）；引用成稿前用 `law_verify` 逐条做形式核验。
- `law_search` / `law_verify` 不可用或未命中时，如实标注「未检索到 / 未做形式核验」，不得以模型记忆补法条。
