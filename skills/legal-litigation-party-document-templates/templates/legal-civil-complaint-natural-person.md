---
name: legal-civil-complaint-natural-person
title: 民事起诉状（公民）
category: litigation
description: 最高人民法院当事人参考样式中的公民民事起诉状。
domain: legal
version: "1.0"
language: zh-CN
use_when: 公民作为原告向法院提起民事诉讼，需要按最高法院样式生成起诉状时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: plaintiff_info
    type: multiline
    required: false
    description: "原告姓名、性别、出生日期、民族、职业、工作单位、住所、联系方式"
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
  - name: defendant_info
    type: multiline
    required: false
    description: "被告姓名或名称、住所等信息；多名被告按顺序续写"
  - name: claims
    type: multiline
    required: false
    description: "诉讼请求，逐项写明可执行的请求"
  - name: facts
    type: multiline
    required: false
    description: "事实和理由"
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
    default: "1份（按被告人数提交）"
    description: "起诉状副本份数及说明，例如：1份（按被告人数提交）"
  - name: signature
    type: string
    required: false
    description: "起诉人签名"
  - name: date
    type: string
    required: false
    description: "起诉日期，写成“××××年××月××日”"
---

# 民事起诉状

原告：{{plaintiff_info}}

法定代理人/指定代理人：{{legal_agent_info}}

委托诉讼代理人：{{agent_info}}

被告：{{defendant_info}}

诉讼请求：

{{claims}}

事实和理由：

{{facts}}

证据和证据来源，证人姓名和住所：

{{evidence}}

此致

{{court_name}}

附：本起诉状副本{{copies}}。

起诉人（签名）：{{signature}}

{{date}}
