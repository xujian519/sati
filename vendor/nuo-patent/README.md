# nuo-patent · 小诺智能体专利工具包

> 小诺（Xiaonuo）智能体生态的核心专利模块
> 统一专利检索 · 分析 · 下载 · TypeScript 实现

基于开源 `google_patent_scraper` 重构，适配 Google Patents 最新页面结构，
新增 PDF 批量下载、法律状态查询、CNIPA 中国专利查询功能，
作为小诺智能体的专利数据采集层。

**v2.0.0 从 Python 迁移至 TypeScript，性能提升约 2x。** Python 原版归档于 `_archive/python/`。

---

## 📦 安装

```bash
# 基础安装
npm install nuo-patent

# 完整安装（含 CNIPA 中国专利查询）
npm install nuo-patent
npx playwright install chromium

# 或从源码
git clone https://github.com/xujian/nuo-patent.git
cd nuo-patent && npm install && npm run build
```

---

## 🚀 快速开始

### 抓取专利元数据

```typescript
import { GooglePatentsScraper } from 'nuo-patent';

const scraper = new GooglePatentsScraper();

// 单个专利
const [err, $, url] = await scraper.requestSinglePatent('US11452699B2');
if (err === 'Success' && $) {
  const data = scraper.processPatentHtml($);
  console.log(data.title);               // 标题
  console.log(data.legal_status);        // Active
  console.log(data.estimated_expiration);  // 2032-04-08
}

// 批量
scraper.addPatents('US2668287A');
scraper.addPatents('US223898A');
await scraper.scrapeAllPatents();
console.log(scraper.parsed_patents);
```

### 下载 PDF

```typescript
import { PDFDownloader } from 'nuo-patent';

const dl = new PDFDownloader('./pdfs');
await dl.downloadSingle('US11452699B2');                    // 单个
await dl.downloadBatch(['US2668287A', 'US223898A']);         // 批量并发
```

### 法律状态

```typescript
import { LegalStatusChecker } from 'nuo-patent';

const checker = new LegalStatusChecker();
const result = await checker.check('US11452699B2');
console.log(checker.formatStatusReport(result));
// 📋 专利: US11452699B2
//   法律状态: Active
//   预估到期日: 2032-04-08
```

### CNIPA 中国专利

```typescript
import { CNIPAClient } from 'nuo-patent';

const client = new CNIPAClient();
const summary = await client.legalStatusSummary('CN122072823A');
console.log(summary);
```

---

## 📊 输出字段

| 字段 | 来源 | 说明 |
|------|------|------|
| `title` | Google Patents | 专利标题 |
| `filing_date` | Google Patents | 申请日 |
| `legal_status` | Google Patents | 法律状态（Active/Expired/Abandoned） |
| `estimated_expiration` | Google Patents | 预估到期日 |
| `pdf_url` | Google Patents | PDF 下载链接 |
| `abstract_text` | Google Patents | 摘要 |
| `inventor_name` | Google Patents | 发明人（JSON） |
| `assignee_name_current` | Google Patents | 当前受让人（JSON） |
| `forward_cite_*` | Google Patents | 前向引证 |
| `backward_cite_*` | Google Patents | 后向引证 |

---

## 🧩 模块架构

```
nuo-patent                    ← 小诺智能体专利模块
├── GooglePatentsScraper      ← Google Patents 数据采集 (cheerio)
├── PDFDownloader             ← PDF 批量下载引擎 (streaming fetch)
├── LegalStatusChecker        ← 法律状态分析器
├── CNIPAClient               ← 中国专利查询网关 (child_process)
└── bench/                    ← 性能基准测试
```

---

## 📈 性能对比 (Python vs TypeScript)

| 指标 | TypeScript | Python | 倍率 |
|------|-----------|--------|------|
| 平均耗时 | ~1545ms | ~3137ms | **TS 2.03x 更快** |
| 最快单次 | ~1211ms | ~2745ms | **TS 2.27x 更快** |

测试条件：同一专利 US11452699B2，5 轮取均值，同一网络环境。

---

## 🔧 开发

```bash
npm run build        # 构建产物到 dist/
npm run typecheck    # 类型检查
npm run dev          # 监听模式
npm run bench        # 性能基准测试
```

---

## 📄 许可证

MIT License. 基于 [ryanlstevens/google_patent_scraper](https://github.com/ryanlstevens/google_patent_scraper) 重构，
作为小诺（Xiaonuo）智能体项目的一部分。
