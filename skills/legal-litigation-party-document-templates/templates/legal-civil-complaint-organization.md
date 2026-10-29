---
name: legal-civil-complaint-organization
title: 民事起诉状（法人或者其他组织）
category: litigation
description: 最高人民法院当事人参考样式中的法人或者其他组织民事起诉状。
domain: legal
version: "1.0"
language: zh-CN
use_when: 法人或其他组织作为原告向法院提起民事诉讼，需要按最高法院样式生成起诉状时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: plaintiff_info
    type: multiline
    required: false
    description: "原告名称、住所等信息"
  - name: legal_representative_info
    type: multiline
    required: false
    description: "法定代表人或者主要负责人的姓名、职务、联系方式"
  - name: agent_info
    type: multiline
    required: false
    default: "无"
    description: "委托诉讼代理人信息；没有则填“无”"
  - name: defendant_info
    type: multiline
    required: false
    description: "被告姓名或名称、住所等信息"
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
    description: "起诉人盖章与法定代表人签名"
  - name: date
    type: string
    required: false
    description: "起诉日期"
---

# 民事起诉状

原告：{{plaintiff_info}}

法定代表人/主要负责人：{{legal_representative_info}}

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

起诉人（公章和签名）：{{signature}}

{{date}}
