---
name: legal-research-authority-check
description: "当用户要核验中国法法条、司法解释、规范性文件或案例的原文、版本、效力和引用姿态时使用；一般文书润色不触发。"
---

# 法源与版本核验

先读本领域 `实务画像`。研究画像未建立时先运行 `legal-research-cold-start-interview`，再进行核验。

1. 逐条提取待核引用的名称、发布机关、条号或案号、引用文字、事实发生日、分析截至日、适用地域。不得把文本中的错误引用默认为正确。
2. 先用公开官方来源找原文和发布、施行、修改、废止记录；有权访问的元典/北大法宝（若 ego lite 已登录） 可辅助发现和交叉定位。记录工具调用时间与返回 ID。数据库摘要须回读全文。
3. 逐条比对引用文字与原文，核实效力层级、特别法关系、过渡条款和事实时点。案例另外核实裁判层级、是否生效、是否被再审或撤销、指导性/参考性身份及案情可比性。
4. 输出核验表：`source_id｜待核表述｜原始来源与定位｜版本和适用时点｜核验状态｜差异｜建议引用方式`。状态仅用“已核验”“部分核验”“未核验”“不适用”；不可将商用库命中自动记为已核验。
5. 核心条文或案例原文不可得时，说明失败的工具与时间、替代路径和受影响结论；停止该结论的确定性表述。

对本次任务逐一检查 task_context、`jurisdiction`、`temporal`、`actors`、`matter`、claims_and_elements、authority_and_interpretation、`proof`、`procedure`、outcomes_and_enforcement、strategy_and_uncertainty、`governance`。适用项给最低结论或待核动作；不适用项说明与本次核验范围有关的理由；受阻项记缺口与停止路径。简短核验可用一行状态表，不扩张为全案意见。

## 作者与来源

- 作者：CSlawyer
- 主页：https://chenshi.ai
- 编制方法：legal-meta-skill；法律依据与项目规则均须在运行时复核。

## Sati 检索接线

- 在本项目中，法条原文优先用 `law_search` 检索（宝宸知识库，含法律层级过滤与现行/失效标注）；引用成稿前用 `law_verify` 逐条做形式核验。
- `law_search` / `law_verify` 不可用或未命中时，如实标注「未检索到 / 未做形式核验」，不得以模型记忆补法条。
