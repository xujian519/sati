---
name: legal-research-lecture-source-pack
description: "当用户准备中国法律主题讲座、培训或公开分享，需建立来源包、案例清单和讲述提纲时使用；单个法条核对改用 authority-check。"
---

# 法律讲座来源包

先读领域 `实务画像` 和目标工作区规则，明确听众、时长、目的、地区、拟讲日期与是否公开传播。保留用户已有的主题、议程和文案；个人实务案例须先取得使用授权并脱敏，不能把案卷发送到商业检索库。

1. 将主题拆为听众必须理解的法律问题、常见误区、示例与可执行动作，建立主张清单。每项重要主张连接原始法源或已核实案例；记录版本、生效日和讲座日期的关系。
2. 用 `legal-research-authority-check` 方法核验法条，用 `legal-research-case-comparison` 方法核验案例身份、状态与适用差异。政策解读与法律义务分开；未决草案、征求意见稿及商业数据库摘要显著标注，不写成现行法。
3. 输出讲述提纲、来源台账、案例/示例使用状态、幻灯片建议、问答备选和讲前复核表。讲座日期前复查可能变化的法规与监管口径；无法核验的事实或数字从公开版删除或显著保留。
4. 公开发布、发送讲义、使用客户或第三方素材须另有授权；本技能只制作可供讲者审核的材料。

逐项检查 task_context、`jurisdiction`、`temporal`、`actors`、`matter`、claims_and_elements、authority_and_interpretation、`proof`、`procedure`、outcomes_and_enforcement、strategy_and_uncertainty、`governance`；与主题无关的模块说明理由，时效或案例授权受阻时暂停对应内容。

## 作者与来源

- 作者：CSlawyer
- 主页：https://chenshi.ai
- 编制方法：legal-meta-skill；讲座内容须在交付及公开前复核。

## Sati 检索接线

- 在本项目中，法条原文优先用 `law_search` 检索（宝宸知识库，含法律层级过滤与现行/失效标注）；引用成稿前用 `law_verify` 逐条做形式核验。
- `law_search` / `law_verify` 不可用或未命中时，如实标注「未检索到 / 未做形式核验」，不得以模型记忆补法条。
