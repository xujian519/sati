---
name: legal-civil-answer-natural-person
title: 民事答辩状（公民）
category: litigation
description: 最高人民法院当事人参考样式中的公民民事答辩状。
domain: legal
version: "1.0"
language: zh-CN
use_when: 公民作为被告对民事起诉提出答辩，需要按最高法院样式生成答辩状时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: respondent_info
    type: multiline
    required: false
    description: "答辩人姓名、性别、出生日期、民族、职业、工作单位、住所、联系方式"
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
    description: "受理法院、案号、当事人和案由，例如：××人民法院（2026）……民初……号原告×××诉被告×××……一案"
  - name: defense
    type: multiline
    required: false
    description: "答辩意见"
  - name: evidence
    type: multiline
    required: false
    description: "证据和证据来源，证人姓名和住所"
  - name: court_name
    type: string
    required: false
    description: "受理法院全称"
  - name: copies
    type: string
    required: false
    default: "1份（按原告人数提交）"
    description: "答辩状副本份数及说明，例如：1份（按原告人数提交）"
  - name: signature
    type: string
    required: false
    description: "答辩人签名"
  - name: date
    type: string
    required: false
    description: "答辩日期"
---

# 民事答辩状

答辩人：{{respondent_info}}

法定代理人/指定代理人：{{legal_agent_info}}

委托诉讼代理人：{{agent_info}}

对{{case_reference}}的起诉，答辩如下：

{{defense}}

证据和证据来源，证人姓名和住所：

{{evidence}}

此致

{{court_name}}

附：本答辩状副本{{copies}}。

答辩人（签名）：{{signature}}

{{date}}
