import * as cheerio from 'cheerio';
import { AnyNode } from 'domhandler';

/**
 * nuo-patent · 共享类型定义
 */
/** 可配置的日志接口，智能体可传入自定义 logger 控制输出行为 */
interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/** 无操作 logger，默认静默 */
declare const noopLogger: Logger;
/** 引证记录 */
interface Citation {
    patent_number: string;
    priority_date: string;
    pub_date: string;
}
/** 时间线事件 */
interface TimelineEvent {
    type: string;
    date: string;
    title: string;
}
/** 法律状态信息 */
interface LegalStatus {
    status: string;
    ifi_status: string;
    estimated_expiration: string;
    events: TimelineEvent[];
}
/**
 * Google Patents 抓取结果。
 *
 * 注意：`inventor_name`, `assignee_name_orig`, `assignee_name_current`,
 * `classifications`, `forward_cite_*`, `backward_cite_*` 字段存储的是
 * **JSON 字符串**（从 Python 原版继承的约定），使用前需要 `JSON.parse()`。
 */
interface PatentData {
    title: string;
    application_number: string;
    /** @json JSON 字符串，格式: `[{"inventor_name": "..."}]` */
    inventor_name: string;
    /** @json JSON 字符串，格式: `[{"assignee_name": "..."}]` */
    assignee_name_orig: string;
    /** @json JSON 字符串，格式: `[{"assignee_name": "..."}]` */
    assignee_name_current: string;
    pub_date: string;
    filing_date: string;
    priority_date: string;
    grant_date: string;
    expiration_date: string;
    legal_status: string;
    ifi_status: string;
    estimated_expiration: string;
    pdf_url: string;
    /** @json JSON 字符串，IPC/CPC 分类数组 */
    classifications: string;
    /** @json JSON 字符串 */
    forward_cite_no_family: string;
    /** @json JSON 字符串 */
    forward_cite_yes_family: string;
    /** @json JSON 字符串 */
    backward_cite_no_family: string;
    /** @json JSON 字符串 */
    backward_cite_yes_family: string;
    abstract_text: string;
    /** 请求 URL（仅 getScrapedData 设置） */
    url?: string;
    /** 专利号（仅 getScrapedData 设置） */
    patent?: string;
}
/**
 * 解析警告 — 非致命解析问题，告知智能体某些字段可能因页面结构变化而缺失。
 * 区别于错误：有警告时 data 仍然返回（只是部分字段为空）。
 */
interface ParseWarning {
    field: string;
    message: string;
}
/** 无状态 scrapePatent() 的选项 */
interface ScrapeOptions {
    /** 取消信号 */
    signal?: AbortSignal;
    /** 请求超时（毫秒），默认 30000 */
    timeout?: number;
    /** 日志接口，默认 noopLogger（静默） */
    logger?: Logger;
    /** 自定义 HTTP 请求头 */
    headers?: Record<string, string>;
    /** 是否提取摘要，默认 true */
    returnAbstract?: boolean;
    /** 是否提取法律状态，默认 true */
    returnLegal?: boolean;
    /** 自定义 fetch 实现（测试注入；缺省用全局 fetch） */
    fetchImpl?: typeof fetch;
}
/** 无状态 scrapePatent() 的统一返回值 — 始终返回此结构，不抛异常 */
interface ScrapeResult {
    /** 是否成功获取并解析 */
    success: boolean;
    /** 请求的专利号 */
    patent: string;
    /** 实际请求的 URL */
    url: string;
    /** 解析后的专利数据，失败时为 null */
    data: PatentData | null;
    /** 错误码（成功时为空字符串） */
    errorCode: '' | 'VALIDATION_ERROR' | 'NETWORK_ERROR' | 'HTTP_ERROR' | 'TIMEOUT' | 'PARSE_ERROR' | 'NOT_FOUND' | 'ABORTED';
    /** 人类可读的错误描述 */
    errorMessage: string;
    /** 非致命解析警告（即使 success=true 也可能存在） */
    parseWarnings: ParseWarning[];
}
/** 法律状态检查结果 */
interface LegalStatusResult {
    patent_number: string;
    title: string;
    status: string;
    ifi_status: string;
    estimated_expiration: string;
    filing_date: string;
    grant_date: string;
    applicant: string;
    inventor: string;
    events_summary: TimelineEvent[];
    url: string;
    error?: string;
}
/** 批量法律状态查询选项 */
interface LegalStatusOptions {
    /** 取消信号 */
    signal?: AbortSignal;
    /** 日志接口 */
    logger?: Logger;
    /** 最大并发数，默认 4 */
    maxConcurrency?: number;
}
/** 年费状态 */
interface AnnuityStatus {
    patent_number: string;
    /** 法律状态（空字符串表示未获取到） */
    status: string;
    /** 预估到期日（空字符串表示未获取到） */
    estimated_expiration: string;
    fee_events: TimelineEvent[];
    note: string;
}
/** 单专利 PDF 下载结果 */
interface DownloadResult {
    patentNumber: string;
    success: boolean;
    /** 成功时为输出文件路径 */
    path?: string;
    /** 失败时为错误描述 */
    error?: string;
}
/** PDF 下载选项 */
interface DownloadOptions {
    /** 取消信号 */
    signal?: AbortSignal;
    /** 日志接口 */
    logger?: Logger;
    /** 最大并发数，默认 4 */
    maxWorkers?: number;
}
/** @deprecated 使用 DownloadResult[] 替代。保留用于向后兼容 */
type BatchDownloadResult = Record<string, string>;
/** CNIPA 中国专利详情 */
interface PatentDetail {
    title: string;
    pub_number: string;
    pub_date: string;
    app_number: string;
    app_date: string;
    applicant: string;
    address: string;
    inventor: string;
    classification: string;
    agency: string;
    agent: string;
    abstract: string;
    first_page_image_url: string;
}
/** CNIPA 事务记录 */
interface TransactionRecord {
    index: number;
    app_number: string;
    date: string;
    description: string;
}
/** CNIPA 检索结果 */
interface SearchResult {
    keyword: string;
    total_hits: number;
    patents: Record<string, unknown>[];
}
/**
 * 专利号校验结果。
 * 可通过 `isValidPatentNumber()` 函数获取。
 */
interface PatentNumberValidation {
    /** 是否通过基本格式校验 */
    valid: boolean;
    /** 规范化后的专利号（去空格、大写），仅 valid=true 时有意义 */
    normalized?: string;
    /** 校验失败原因 */
    reason?: string;
}

/**
 * nuo-patent · Google Patents 核心爬虫 (TypeScript 版本)
 *
 * 抓取 https://patents.google.com/ 的专利元数据。
 * 已适配 2025+ 最新页面结构。
 *
 * 推荐智能体使用无状态 `scrapePatent()` 函数，而非有状态的 `GooglePatentsScraper` 类。
 */

/**
 * 校验并规范化专利号。
 * 智能体可先调用此函数验证用户输入的专利号格式。
 */
declare function validatePatentNumber(input: string): PatentNumberValidation;
/**
 * 规范化专利号：去空格、转大写。
 * 不做格式校验，非法输入原样返回大写形式。
 */
declare function normalizePatentNumber(input: string): string;
interface ProxyConfig {
    host: string;
    port: number;
}
declare function getSystemProxy(): ProxyConfig | undefined;
/** @deprecated Use getSystemProxy() instead. */
declare const systemProxy: typeof getSystemProxy;
interface FetchOptions {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeout?: number;
    logger?: Logger;
    /** 自定义 fetch 实现（测试注入；缺省用全局 fetch） */
    fetchImpl?: typeof fetch;
}
/**
 * 获取 HTML 页面内容，支持代理隧道、超时、取消信号。
 */
declare function fetchHtml(targetUrl: string, options?: FetchOptions): Promise<string>;
/**
 * 解析单个引证 `<tr>` 元素。
 * 解析失败时对应字段保持空字符串（不抛异常）。
 */
declare function parseCitationElement($: cheerio.CheerioAPI, element: AnyNode, logger?: Logger): Citation;
interface ExtractCitationsResult {
    forwardCitesNoFamily: Citation[];
    forwardCitesYesFamily: Citation[];
    backwardCitesNoFamily: Citation[];
    backwardCitesYesFamily: Citation[];
}
/** 提取前后向引证，返回结构化结果 */
declare function extractCitations($: cheerio.CheerioAPI, logger?: Logger): ExtractCitationsResult;
/** 提取时间线事件 */
declare function extractEvents($: cheerio.CheerioAPI, logger?: Logger): {
    priority_date: string;
    filing_date: string;
    grant_date: string;
    expiration_date: string;
    pub_date: string;
};
/** 提取法律状态 */
declare function extractLegalStatus($: cheerio.CheerioAPI, logger?: Logger): LegalStatus;
/** 提取 IPC/CPC 分类 */
declare function extractClassifications($: cheerio.CheerioAPI, logger?: Logger): string[];
interface ProcessResult {
    data: PatentData;
    warnings: ParseWarning[];
}
/**
 * 从 Google Patents HTML 提取所有字段。
 * 与 `GooglePatentsScraper.processPatentHtml` 功能相同，但额外返回
 * `parseWarnings` 数组，告知哪些字段可能因页面结构变化而未能解析。
 */
declare function parsePatentHtml($: cheerio.CheerioAPI, options?: {
    returnAbstract?: boolean;
    returnLegal?: boolean;
    logger?: Logger;
}): ProcessResult;
/**
 * 抓取单个专利的元数据（无状态，推荐智能体使用）。
 *
 * 始终返回 `ScrapeResult`，不抛异常。智能体通过 `result.success` 判断成败，
 * 通过 `result.parseWarnings` 了解非致命解析问题。
 *
 * @example
 * ```typescript
 * import { scrapePatent, validatePatentNumber } from 'nuo-patent';
 *
 * const validation = validatePatentNumber('US11452699B2');
 * if (!validation.valid) throw new Error(validation.reason);
 *
 * const result = await scrapePatent(validation.normalized!, {
 *   timeout: 15000,
 *   signal: abortController.signal,
 * });
 *
 * if (result.success) {
 *   console.log(result.data!.title);
 *   if (result.parseWarnings.length > 0) {
 *     console.warn('解析警告:', result.parseWarnings);
 *   }
 * } else {
 *   console.error(`[${result.errorCode}] ${result.errorMessage}`);
 * }
 * ```
 */
declare function scrapePatent(patentNumber: string, options?: ScrapeOptions): Promise<ScrapeResult>;
declare class GooglePatentsScraper {
    private listOfPatents;
    private scrapeStatus;
    private parsedPatents;
    private returnAbstract;
    private returnLegal;
    constructor(returnAbstract?: boolean, returnLegal?: boolean);
    addPatents(patent: string): void;
    deletePatents(patent: string): void;
    addScrapeStatus(patent: string, value: string): void;
    /**
     * @deprecated 推荐使用无状态的 `scrapePatent()` 函数，避免状态污染。
     */
    requestSinglePatent(patent: string, url?: boolean): Promise<[string, cheerio.CheerioAPI | null, string]>;
    parseCitation($: cheerio.CheerioAPI, element: AnyNode): Citation;
    /**
     * @deprecated 推荐使用无状态的 `parsePatentHtml()` 函数，可获取 parseWarnings。
     */
    processPatentHtml($: cheerio.CheerioAPI): PatentData;
    getScrapedData($: cheerio.CheerioAPI, patent: string, url: string): PatentData;
    /**
     * @deprecated 推荐逐专利调用 `scrapePatent()`，避免实例状态残留。
     */
    scrapeAllPatents(): Promise<void>;
    get list_of_patents(): string[];
    get scrape_status(): Record<string, string>;
    get parsed_patents(): Record<string, PatentData>;
}
/** @deprecated Use `GooglePatentsScraper` directly. */
declare const scraper_class: typeof GooglePatentsScraper;

/**
 * nuo-patent · ego-browser (ego-lite) 抓取后端
 *
 * ego-browser 是基于 Chromium 的浏览器运行时，AI Agent 通过
 * `ego-browser nodejs` 以 stdin 传入 Node.js 脚本驱动真实浏览器。
 * 相比原生 fetch / 代理隧道，浏览器环境能稳定通过 Google Patents
 * 等站点的反爬校验（真实指纹、JS 渲染、Cookie 状态），在 macOS 上
 * 效果更佳，故优先使用；不可用时自动回退原生网络栈。
 */

/**
 * 判断 ego-browser 是否可用。
 * - 默认仅 macOS (darwin) 平台启用；其他平台需环境变量强制。
 * - NUO_PATENT_EGO_BROWSER=0 显式禁用。
 * - NUO_PATENT_EGO_BROWSER=1 强制启用（跳过平台与命令检测）。
 */
declare function isEgoBrowserAvailable(): boolean;
/** 仅供测试：重置缓存 */
declare function resetEgoBrowserCache(): void;
interface EgoFetchOptions {
    signal?: AbortSignal;
    timeout?: number;
    logger?: Logger;
}
/**
 * 通过 ego-browser 打开页面并取回完整渲染后的 HTML。
 * 使用独立 task space（随机后缀）避免并发请求竞争，取回后立即关闭。
 */
declare function fetchHtmlWithEgoBrowser(targetUrl: string, options?: EgoFetchOptions): Promise<string>;

/**
 * nuo-patent · Google Patents 专利检索
 *
 * 关键词/布尔检索式检索专利（补检索缺口——此前仅支持按专利号点查）。
 *
 * 双路径：
 * 1. 主路径：XHR JSON 接口（https://patents.google.com/xhr/query）——返回结构化
 *    JSON，字段稳定；经 ego-browser / fetch 抓取。
 * 2. 回退路径：HTML 搜索结果页（https://patents.google.com/?q=...）——cheerio 宽松
 *    选择器解析；当 JSON 接口返回空/结构异常时启用。
 *
 * 设计原则与 scraper.ts 一致：纯解析函数独立导出（无网络依赖）、解析失败字段
 * 空字符串兜底、错误抛 NuoPatentError 体系、fetchImpl 可注入（测试与复用）。
 */

/** 单个检索命中 */
interface PatentSearchHit {
    /** 公开号/授权公告号，如 "US11452699B2" */
    patent: string;
    title: string;
    assignee: string;
    publication_date: string;
    priority_date: string;
    abstract: string;
    /** Google Patents 详情页 URL */
    url: string;
}
/** 检索结果 */
interface PatentSearchResult {
    query: string;
    /** 命中总数（来自接口 total_num_results，可能不精确） */
    total: number;
    hits: PatentSearchHit[];
    /** 非致命解析警告（如部分字段缺失） */
    warnings: string[];
}
/** 检索选项 */
interface PatentSearchOptions {
    /** 最大命中数（1-50，默认 10） */
    limit?: number;
    signal?: AbortSignal;
    /** 请求超时（毫秒），默认 30000 */
    timeout?: number;
    logger?: Logger;
    /** 自定义 fetch 实现（测试注入；缺省用全局 fetch） */
    fetchImpl?: typeof fetch;
}
/**
 * 解析 XHR JSON 接口响应。
 * 结构：{ results: { total_num_results, cluster: [{ result: [{ patent: {...} }] }] } }
 * 宽容解析：字段缺失/结构异常时对应字段为空字符串，不抛异常。
 */
declare function parseSearchResultsJson(raw: unknown): {
    total: number;
    hits: PatentSearchHit[];
};
/**
 * 解析 HTML 搜索结果页（回退路径）。
 * 每个结果一个 `<search-result>` 元素；选择器宽松，缺失字段空字符串兜底。
 */
declare function parseSearchResultsHtml($: cheerio.CheerioAPI, logger?: Logger): {
    hits: PatentSearchHit[];
    warnings: string[];
};
/**
 * 按关键词/布尔检索式检索专利（无状态，推荐智能体使用）。
 *
 * 主路径走 XHR JSON 接口（结构化）；解析出 0 条时自动回退 HTML 搜索页解析。
 * 始终返回 PatentSearchResult，不抛异常（网络错误在 warnings 中记录，hits 为空）。
 *
 * @example
 * ```typescript
 * import { searchPatents } from 'nuo-patent';
 *
 * const result = await searchPatents('(phase change material OR PCM) AND thermal', {
 *   limit: 20,
 * });
 * if (result.hits.length > 0) {
 *   console.log(result.hits[0].patent, result.hits[0].title);
 * }
 * ```
 */
declare function searchPatents(query: string, options?: PatentSearchOptions): Promise<PatentSearchResult>;

/**
 * nuo-patent · PDF 批量下载引擎
 *
 * 参考 wenyalintw/Google-Patents-Scraper 方案：
 * - 从 meta[name=citation_pdf_url] 提取 PDF URL
 * - 流式下载 + 进度显示
 * - 单专利 / 批量并发 / 家族 PDF 下载
 */

/**
 * Download PDFs from Google Patents.
 *
 * Usage:
 * ```ts
 * const downloader = new PDFDownloader('./patent_pdfs');
 * await downloader.downloadSingle('US11452699B2');
 *
 * // 批量下载，获得结构化结果
 * const results = await downloader.downloadBatchWithResults(
 *   ['US2668287A', 'US11452699B2'],
 *   { signal: abortController.signal }
 * );
 * for (const r of results) {
 *   if (r.success) console.log(`✅ ${r.path}`);
 *   else console.error(`❌ ${r.patentNumber}: ${r.error}`);
 * }
 * ```
 */
declare class PDFDownloader {
    private outputDir;
    private scraper;
    private maxWorkers;
    constructor(outputDir?: string, scraper?: GooglePatentsScraper, maxWorkers?: number);
    /**
     * 确保输出目录存在。
     */
    private ensureOutputDir;
    /**
     * 获取专利 PDF URL。
     */
    private getPdfUrl;
    /**
     * 流式下载文件（带进度和取消支持）。
     */
    private downloadFile;
    private fetchBinary;
    /**
     * 格式化字节为人类可读字符串。
     */
    private formatBytes;
    /**
     * 下载单个专利 PDF。
     *
     * @param patentNumber - 专利号（如 'US11452699B2'）
     * @param outputPath - 可选完整输出路径；默认 `{outputDir}/{patentNumber}.pdf`
     * @param signal - 可选的 AbortSignal 用于取消下载
     * @param logger - 可选日志接口
     * @returns 下载后的 PDF 文件路径
     */
    downloadSingle(patentNumber: string, outputPath?: string, signal?: AbortSignal, logger?: Logger): Promise<string>;
    /**
     * 批量下载 PDF（返回结构化结果，推荐智能体使用）。
     *
     * @param patentNumbers - 专利号列表
     * @param options - 下载选项（signal, logger, maxWorkers）
     * @returns 每个专利的 DownloadResult 数组，不抛异常
     */
    downloadBatchWithResults(patentNumbers: string[], options?: DownloadOptions): Promise<DownloadResult[]>;
    /**
     * 批量下载 PDF（返回 Record，保留向后兼容）。
     *
     * @deprecated 推荐使用 `downloadBatchWithResults()` 获得结构化结果。
     */
    downloadBatch(patentNumbers: string[]): Promise<BatchDownloadResult>;
    /**
     * 下载专利及其家族成员的 PDF。
     *
     * @param patentNumber - 专利号
     * @param outputDir - 可选子目录
     * @returns 下载后的 PDF 文件路径
     */
    downloadFamily(patentNumber: string, outputDir?: string): Promise<string>;
}
/**
 * 便捷函数：快速下载单个专利 PDF。
 *
 * @param patentNumber - 专利号
 * @param outputDir - 输出目录（默认 './patent_pdfs'）
 * @returns 下载后的 PDF 文件路径
 */
declare function downloadPdf(patentNumber: string, outputDir?: string): Promise<string>;

/**
 * nuo-patent · 法律状态 & 年费查询器
 */

declare class LegalStatusChecker {
    private scraper;
    constructor(scraper?: GooglePatentsScraper);
    /**
     * 查询单个专利的法律状态。
     *
     * @param patentNumber - 专利号
     * @param signal - 可选的 AbortSignal
     * @param logger - 可选日志接口
     */
    check(patentNumber: string, signal?: AbortSignal, logger?: Logger): Promise<LegalStatusResult>;
    /**
     * 批量查询法律状态（并发执行）。
     *
     * @param patentNumbers - 专利号列表
     * @param options - 查询选项（signal, logger, maxConcurrency）
     */
    checkBatch(patentNumbers: string[], options?: LegalStatusOptions): Promise<Record<string, LegalStatusResult>>;
    /**
     * 格式化法律状态报告（面向人类可读输出）。
     */
    formatStatusReport(result: LegalStatusResult): string;
    /**
     * 查询年费状态。
     *
     * @param patentNumber - 专利号
     * @param signal - 可选的 AbortSignal
     * @param logger - 可选日志接口
     */
    checkAnnuityStatus(patentNumber: string, signal?: AbortSignal, logger?: Logger): Promise<AnnuityStatus>;
    private extractEvents;
}

/**
 * nuo-patent · CNIPA 中国专利查询客户端
 *
 * 封装 CNIPA 公布公告网站 (http://epub.cnipa.gov.cn/) 的查询功能。
 * 基于小诺项目中的 cnipa_epub_client.py 工具。
 *
 * 支持:
 * - search(keyword)           — 关键词检索
 * - detail(pubNumber)         — 专利详情
 * - transaction(appNumber)    — 事务数据查询（法律状态）
 * - patentTransactions(pub)   — 通过公布号查法律状态
 * - downloadPdf(pubNumber, outputDir)  — PDF 下载
 * - legalStatusSummary(pub)   — 法律状态摘要
 *
 * 注意：此模块通过 child_process 调用 Python 脚本，需要 python3 和
 * cnipa_epub_client.py（来自 YunXi 项目）。
 */

declare class CNIPAClient {
    /** CNIPA 公布公告查询客户端。 */
    private toolPath;
    private workDir;
    private logger;
    /**
     * 创建 CNIPA 客户端实例。
     *
     * 构造函数不会因找不到工具脚本而抛异常——可用 `isAvailable()` 预先检查。
     * 实际查询时如果工具脚本不存在，会抛出 `CNIPAQueryError`。
     *
     * @param toolPath - 可选的 cnipa_epub_client.py 脚本路径
     * @param workDir - 可选的工作目录
     * @param logger - 可选的日志接口
     *
     * @example
     * ```typescript
     * const client = new CNIPAClient();
     * if (!client.isAvailable()) {
     *   console.error('CNIPA 查询不可用，请安装 YunXi 项目');
     *   return;
     * }
     *
     * // 搜索
     * const result = await client.search('人工智能');
     *
     * // 查法律状态
     * const summary = await client.legalStatusSummary('CN122072823A');
     * ```
     */
    constructor(toolPath?: string, workDir?: string, logger?: Logger);
    private _run;
    /**
     * 解析 CLI 输出的 JSON 数据。
     * 按行扫描，取第一个成功解析的 JSON 对象/数组。
     */
    private _parseJsonOutput;
    /**
     * 关键词检索。
     *
     * @param keyword - 关键词、申请号或公布号
     * @returns SearchResult 对象
     */
    search(keyword: string): Promise<SearchResult>;
    /**
     * 查询专利详情。
     *
     * @param pubNumber - 公布号，如 'CN122072823A'
     * @returns PatentDetail 对象
     */
    detail(pubNumber: string): Promise<PatentDetail>;
    /**
     * 查询法律状态/事务数据。
     *
     * @param appNumber - 13位申请号（纯数字，去掉小数点）
     * @returns TransactionRecord 列表
     */
    transaction(appNumber: string): Promise<TransactionRecord[]>;
    /**
     * 通过公布号查询法律状态。
     *
     * @param pubNumber - 公布号，如 'CN122072823A'
     * @returns TransactionRecord 列表
     */
    patentTransactions(pubNumber: string): Promise<TransactionRecord[]>;
    /**
     * 下载中国专利 PDF。
     *
     * @param pubNumber - 公布号，如 'CN122072823A'
     * @param outputDir - 输出目录，默认 '/tmp'
     * @returns PDF 文件路径，失败返回 null
     */
    downloadPdf(pubNumber: string, outputDir?: string): Promise<string | null>;
    /**
     * 检查 CNIPA 工具是否可用。
     *
     * 仅检查脚本文件和 python3 是否可执行，不实际发起网络请求（避免触发 WAF）。
     *
     * @returns 是否可用
     */
    isAvailable(): boolean;
    /**
     * 格式化事务记录为可读文本。
     *
     * @param records - 事务记录列表
     * @returns 格式化的文本
     */
    formatTransactions(records: TransactionRecord[]): string;
    /**
     * 返回法律状态摘要文本。
     *
     * @param pubNumber - 公布号
     * @returns 可读的法律状态摘要
     */
    legalStatusSummary(pubNumber: string): Promise<string>;
}

/**
 * nuo-patent · 自定义错误类
 *
 * 所有错误继承自 NuoPatentError，智能体可通过 `instanceof` 或 `error.name` 做分类处理。
 * 每个错误携带 `patentNumber` 上下文（如适用），方便智能体定位问题。
 */
declare class NuoPatentError extends Error {
    /** 关联的专利号（如适用） */
    patentNumber?: string;
    constructor(message: string, patentNumber?: string);
}
declare class PatentClassError extends NuoPatentError {
    constructor(message: string, patentNumber?: string);
}
declare class NoPatentsError extends NuoPatentError {
    constructor(message: string);
}
declare class PDFDownloadError extends NuoPatentError {
    constructor(message: string, patentNumber?: string);
}
declare class CNIPAQueryError extends NuoPatentError {
    constructor(message: string);
}
/** 网络请求超时 */
declare class TimeoutError extends NuoPatentError {
    /** 超时阈值（毫秒） */
    timeoutMs: number;
    constructor(message: string, timeoutMs: number, patentNumber?: string);
}
/** HTML 解析失败（页面结构不匹配） */
declare class ParseError extends NuoPatentError {
    /** 解析失败的字段名 */
    field?: string;
    constructor(message: string, field?: string, patentNumber?: string);
}

/**
 * nuo-patent · 小诺智能体专利工具包 (TypeScript 版本)
 *
 * 功能：
 * - Google Patents 元数据抓取（标题、发明人、受让人、引证等）
 * - PDF 批量下载（含进度反馈、并发下载）
 * - 法律状态查询（Active/Expired、预估到期日）
 * - CNIPA 中国专利查询（法律状态、详情、PDF）
 *
 * 推荐智能体使用无状态 API:
 * - `scrapePatent()` — 无状态专利元数据抓取
 * - `parsePatentHtml()` — 纯解析函数（含 parseWarnings）
 * - `validatePatentNumber()` / `normalizePatentNumber()` — 专利号工具
 * - `PDFDownloader.downloadBatchWithResults()` — 结构化批量下载结果
 * - `LegalStatusChecker.checkBatch()` — 并发法律状态查询
 */

declare const VERSION = "2.3.1";
declare const AUTHOR = "\u5C0F\u8BFA\u56E2\u961F \u00B7 Xiaonuo Team";
declare const LICENSE = "MIT";

export { AUTHOR, type AnnuityStatus, type BatchDownloadResult, CNIPAClient, CNIPAQueryError, type Citation, type DownloadOptions, type DownloadResult, GooglePatentsScraper, LICENSE, type LegalStatus, LegalStatusChecker, type LegalStatusOptions, type LegalStatusResult, type Logger, NoPatentsError, NuoPatentError, PDFDownloadError, PDFDownloader, ParseError, type ParseWarning, PatentClassError, type PatentData, type PatentDetail, type PatentNumberValidation, type PatentSearchHit, type PatentSearchOptions, type PatentSearchResult, type ProxyConfig, type ScrapeOptions, type ScrapeResult, type SearchResult, type TimelineEvent, TimeoutError, type TransactionRecord, VERSION, downloadPdf, extractCitations, extractClassifications, extractEvents, extractLegalStatus, fetchHtml, fetchHtmlWithEgoBrowser, getSystemProxy, isEgoBrowserAvailable, noopLogger, normalizePatentNumber, parseCitationElement, parsePatentHtml, parseSearchResultsHtml, parseSearchResultsJson, resetEgoBrowserCache, scrapePatent, scraper_class, searchPatents, systemProxy, validatePatentNumber };
