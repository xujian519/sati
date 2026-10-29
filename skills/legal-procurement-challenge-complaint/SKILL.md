---
name: legal-procurement-challenge-complaint
description: "当用户需要分析或起草政府采购质疑、质疑答复、投诉及相关期限和证据时使用；普通售后争议改用 contract-performance。"
---

# 质疑与投诉审查

先读领域 `实务画像` 并确认制度与角色。逐件记录公告、采购文件、澄清、响应、评审结果、质疑函、答复和送达凭证的来源、版本、日期及签收状态。将每个争点映射为“程序资格—已质疑事项—事实—证据—法律依据—请求—可能处理”。区分供应商提出、采购人/代理答复和财政部门投诉三个角色的职责。

对期限只列候选：确认起算事件、知悉证据、工作日/自然日规则、节假日、送达方式、前置质疑及例外，然后用适用时点的财政部与有权机关原文核算。关键日期缺失、规则未核验或送达争议未解决时，不断言尚在期限内或已逾期；立即提示保全原件并人工核对。

输出受理条件表、逐争点攻防表、证据缺口、候选期限计算底稿、拟提交文书草稿及送达前复核清单。不得自动提交、发送或向外部检索源上传未脱敏材料。投诉范围与既有质疑范围的关系须单列，不用一段概括带过。

逐一检查 task_context、`jurisdiction`、`temporal`、`actors`、`matter`、claims_and_elements、authority_and_interpretation、`proof`、`procedure`、outcomes_and_enforcement、strategy_and_uncertainty、`governance`。特别展开时间、请求要件、证据、程序与人工复核；其余模块给具体状态及理由，关键依据受阻时停止确定性程序结论。

## 作者与来源

- 作者：CSlawyer
- 主页：https://chenshi.ai
- 编制方法：legal-meta-skill；法律依据与项目规则均须在运行时复核。

## Sati 检索接线

- 在本项目中，法条原文优先用 `law_search` 检索（宝宸知识库，含法律层级过滤与现行/失效标注）；引用成稿前用 `law_verify` 逐条做形式核验。
- `law_search` / `law_verify` 不可用或未命中时，如实标注「未检索到 / 未做形式核验」，不得以模型记忆补法条。
