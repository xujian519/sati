---
name: legal-authorization-letter-natural-person
title: 授权委托书（公民）
category: litigation
description: 最高人民法院当事人参考样式中的公民授权委托书。
domain: legal
version: "1.0"
language: zh-CN
use_when: 公民当事人、法定代理人或共同诉讼代表人委托诉讼代理人参加诉讼时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: principal_info
    type: multiline
    required: false
    description: "委托人的身份信息"
  - name: agent_names
    type: string
    required: false
    description: "受委托人姓名，多人用顿号分隔，例如：×××、×××"
  - name: recipients
    type: multiline
    required: false
    description: "受委托人信息，逐行写，每行以“受委托人：”开头；一人一行"
  - name: case_reference
    type: multiline
    required: false
    description: "当事人和案由，例如：原告×××诉被告×××……一案"
  - name: authority_scope
    type: multiline
    required: false
    description: "各受委托人的代理事项与权限，逐人写明"
  - name: signature
    type: string
    required: false
    description: "委托人签名"
  - name: date
    type: string
    required: false
    description: "委托日期"
---

# 授权委托书

委托人：{{principal_info}}

{{recipients}}

现委托{{agent_names}}在{{case_reference}}中，作为我方参加诉讼的委托诉讼代理人。

委托事项与权限如下：

{{authority_scope}}

委托人（签名）：{{signature}}

{{date}}
