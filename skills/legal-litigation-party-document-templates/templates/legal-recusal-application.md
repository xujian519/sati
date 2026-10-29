---
name: legal-recusal-application
title: 申请书（申请回避）
category: litigation
description: 最高人民法院当事人参考样式中的回避申请书。
domain: legal
version: "1.0"
language: zh-CN
use_when: 当事人认为审判人员或其他诉讼参与人具有法定回避情形，向法院申请其回避时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: applicant_info
    type: multiline
    required: false
    description: "申请人的身份信息"
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
  - name: recused_person
    type: string
    required: false
    description: "被申请回避人的诉讼地位和姓名，例如：审判员×××"
  - name: recusal_reasons
    type: multiline
    required: false
    description: "申请回避的事实和理由"
  - name: court_name
    type: string
    required: false
    description: "受诉法院全称"
  - name: signature
    type: string
    required: false
    description: "申请人签名或盖章"
  - name: date
    type: string
    required: false
    description: "申请日期"
---

# 申请书

申请人：{{applicant_info}}

法定代理人/指定代理人：{{legal_agent_info}}

委托诉讼代理人：{{agent_info}}

请求事项：

申请你院{{case_reference}}一案的{{recused_person}}回避。

事实和理由：

{{recusal_reasons}}

此致

{{court_name}}

申请人（签名或者盖章）：{{signature}}

{{date}}
