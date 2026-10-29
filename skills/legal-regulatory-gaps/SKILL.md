---
name: legal-regulatory-gaps
description: "开放差距跟踪器——已标记但尚未关闭的事项。适用于用户询问\"有哪些开放的差距\"、\"差距跟踪器\"、\"整改状态\"，或想关闭（--close GAP-ID）或风险接受（--accept GAP-ID）一个已跟踪的差距时。"
---

# /legal-regulatory-gaps

1. 读取位于 `./.legal/regulatory-legal/gap-tracker.yaml` 的差距跟踪器。
2. 如果 `--close`：标记差距已关闭，附解决方案说明。
3. 如果 `--accept`：记录风险接受理由和接受人，状态 → risk-accepted。
4. 否则：按年龄和重要度报告开放差距。

> 详细的跟踪器 schema、状态报告格式、负责人通知逻辑（逐次发送确认，无例外）、提醒频率、关闭/风险接受模式以及后果性行动闸门位于 **gap-surfacer** 参考技能中——在实质工作前加载它。

## Sati 检索接线

- 在本项目中，法条原文优先用 `law_search` 检索（宝宸知识库，含法律层级过滤与现行/失效标注）；引用成稿前用 `law_verify` 逐条做形式核验。
- `law_search` / `law_verify` 不可用或未命中时，如实标注「未检索到 / 未做形式核验」，不得以模型记忆补法条。
