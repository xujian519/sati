---
name: legal-legal-representative-certificate
title: 法定代表人身份证明书
category: litigation
description: 最高人民法院当事人参考样式中的法定代表人身份证明书。
domain: legal
version: "1.0"
language: zh-CN
use_when: 法人当事人向法院证明法定代表人身份时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: representative_name
    type: string
    required: false
    description: "法定代表人姓名"
  - name: company_name
    type: string
    required: false
    description: "单位名称"
  - name: position
    type: string
    required: false
    description: "法定代表人在单位担任的职务"
  - name: contact_address
    type: string
    required: false
    description: "法定代表人联系地址"
  - name: contact_phone
    type: string
    required: false
    description: "联系电话"
  - name: date
    type: string
    required: false
    description: "出具日期"
---

# 法定代表人身份证明书

{{representative_name}}在我单位{{company_name}}担任{{position}}职务，系我单位{{company_name}}的法定代表人。

特此证明。

附：法定代表人联系地址：{{contact_address}}

联系电话：{{contact_phone}}

{{date}}

（公章）
