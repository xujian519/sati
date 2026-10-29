---
name: legal-jurisdiction-objection
title: 异议书（管辖权异议）
category: litigation
description: 最高人民法院当事人参考样式中的管辖权异议书。
domain: legal
version: "1.0"
language: zh-CN
use_when: 被告对受诉法院的管辖权有异议，依据民事诉讼法提出管辖权异议时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: objector_info
    type: multiline
    required: false
    description: "异议人的身份信息"
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
  - name: case_reference
    type: multiline
    required: false
    description: "受诉法院、案号、当事人和案由，例如：××人民法院（2026）……号原告×××诉被告×××……（不要写“一案”，模板会补）"
  - name: target_court
    type: string
    required: false
    description: "请求移送的法院全称"
  - name: objection_reasons
    type: multiline
    required: false
    description: "提出管辖权异议的事实和理由"
  - name: court_name
    type: string
    required: false
    description: "受诉法院全称"
  - name: signature
    type: string
    required: false
    description: "异议人签名或盖章"
  - name: date
    type: string
    required: false
    description: "提出异议的日期"
---

# 异议书

异议人（被告）：{{objector_info}}

法定代理人/指定代理人：{{legal_agent_info}}

委托诉讼代理人：{{agent_info}}

请求事项：

将{{case_reference}}一案移送{{target_court}}管辖。

事实和理由：

{{objection_reasons}}

此致

{{court_name}}

异议人（签名或者盖章）：{{signature}}

{{date}}
