---
name: legal-civil-retrial-application
title: 民事再审申请书
category: litigation
description: 最高人民法院当事人参考样式中的民事再审申请书。
domain: legal
version: "1.0"
language: zh-CN
use_when: 当事人对已经生效的民事判决、裁定或调解书向法院申请再审时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: applicant_info
    type: multiline
    required: false
    description: "再审申请人的一、二审诉讼地位与身份信息"
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
  - name: respondent_info
    type: multiline
    required: false
    description: "被申请人的一、二审诉讼地位与身份信息"
  - name: original_parties_info
    type: multiline
    required: false
    default: "无"
    description: "原审原告、被告、第三人的一审诉讼地位与身份信息；没有则填“无”"
  - name: applicant_name
    type: string
    required: false
    description: "再审申请人姓名或名称"
  - name: respondent_name
    type: string
    required: false
    description: "被申请人姓名或名称"
  - name: cause
    type: string
    required: false
    description: "案由"
  - name: original_court
    type: string
    required: false
    description: "原审法院全称"
  - name: original_judgment_date
    type: string
    required: false
    description: "原审裁判作出日期"
  - name: original_case_number
    type: string
    required: false
    description: "原审案号，不含括号"
  - name: original_document_type
    type: string
    required: false
    default: "民事判决"
    description: "原审文书类型"
  - name: retrial_requests
    type: multiline
    required: false
    description: "再审请求"
  - name: retrial_facts
    type: multiline
    required: false
    description: "申请再审的法定情形及事实和理由"
  - name: court_name
    type: string
    required: false
    description: "受理再审申请的法院全称"
  - name: copies
    type: string
    required: false
    default: "1份（按对方当事人人数提交）"
    description: "再审申请书副本份数及说明，例如：1份（按对方当事人人数提交）"
  - name: signature
    type: string
    required: false
    description: "再审申请人签名或盖章"
  - name: date
    type: string
    required: false
    description: "申请日期"
---

# 再审申请书

再审申请人（一、二审诉讼地位）：{{applicant_info}}

法定代理人/指定代理人：{{legal_agent_info}}

委托诉讼代理人：{{agent_info}}

被申请人（一、二审诉讼地位）：{{respondent_info}}

原审原告/被告/第三人（一审诉讼地位）：{{original_parties_info}}

{{applicant_name}}因与{{respondent_name}}{{cause}}一案，不服{{original_court}}{{original_judgment_date}}作出的（{{original_case_number}}）{{original_document_type}}，现提出再审申请。

再审请求：

{{retrial_requests}}

事实和理由：

{{retrial_facts}}

此致

{{court_name}}

附：本民事再审申请书副本{{copies}}。

再审申请人（签名或者盖章）：{{signature}}

{{date}}
