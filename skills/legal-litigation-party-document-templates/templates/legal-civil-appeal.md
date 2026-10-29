---
name: legal-civil-appeal
title: 民事上诉状
category: litigation
description: 最高人民法院当事人参考样式中的民事上诉状。
domain: legal
version: "1.0"
language: zh-CN
use_when: 当事人不服第一审民事判决或裁定，向上一级人民法院提起上诉时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: appellant_info
    type: multiline
    required: false
    description: "上诉人的原审诉讼地位与身份信息"
  - name: legal_agent_info
    type: multiline
    required: false
    default: "无"
    description: "法定代理人/指定代理人信息；没有则填“无”"
  - name: agent_info
    type: multiline
    required: false
    default: "无"
    description: "委托诉讼代理人信息；没有则填“无”"
  - name: appellee_info
    type: multiline
    required: false
    description: "被上诉人的原审诉讼地位与身份信息"
  - name: appellant_name
    type: string
    required: false
    description: "上诉人姓名或名称"
  - name: appellee_name
    type: string
    required: false
    description: "被上诉人姓名或名称"
  - name: cause
    type: string
    required: false
    description: "案由，例如：侵害发明专利权纠纷"
  - name: original_court
    type: string
    required: false
    description: "原审法院全称"
  - name: judgment_date
    type: string
    required: false
    description: "原审判决或裁定作出日期"
  - name: case_number
    type: string
    required: false
    description: "原审案号，不含括号，例如：2026……民初……号"
  - name: judgment_type
    type: string
    required: false
    default: "民事判决"
    description: "原审文书类型"
  - name: appeal_requests
    type: multiline
    required: false
    description: "上诉请求"
  - name: appeal_reasons
    type: multiline
    required: false
    description: "上诉理由"
  - name: court_name
    type: string
    required: false
    description: "二审法院全称"
  - name: copies
    type: string
    required: false
    default: "1份（按对方当事人人数提交）"
    description: "上诉状副本份数及说明，例如：1份（按对方当事人人数提交）"
  - name: signature
    type: string
    required: false
    description: "上诉人签名或盖章"
  - name: date
    type: string
    required: false
    description: "上诉日期"
---

# 民事上诉状

上诉人（原审诉讼地位）：{{appellant_info}}

法定代理人/指定代理人：{{legal_agent_info}}

委托诉讼代理人：{{agent_info}}

被上诉人（原审诉讼地位）：{{appellee_info}}

{{appellant_name}}因与{{appellee_name}}{{cause}}一案，不服{{original_court}}{{judgment_date}}作出的（{{case_number}}）{{judgment_type}}，现提起上诉。

上诉请求：

{{appeal_requests}}

上诉理由：

{{appeal_reasons}}

此致

{{court_name}}

附：本上诉状副本{{copies}}。

上诉人（签名或者盖章）：{{signature}}

{{date}}
