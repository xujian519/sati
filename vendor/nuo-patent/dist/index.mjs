// src/scraper.ts
import * as cheerio from "cheerio";
import https from "https";
import http from "http";
import { URL } from "url";
import { execSync } from "child_process";

// src/types.ts
var noopLogger = {
  debug() {
  },
  info() {
  },
  warn() {
  },
  error() {
  }
};

// src/ego-browser.ts
import { exec, execFile } from "child_process";
var EGO_ENV_KEY = "NUO_PATENT_EGO_BROWSER";
var _egoAvailable = null;
function isEgoBrowserAvailable() {
  if (_egoAvailable !== null) return _egoAvailable;
  const env = process.env[EGO_ENV_KEY];
  if (env === "0") {
    _egoAvailable = false;
    return false;
  }
  if (env === "1") {
    _egoAvailable = true;
    return true;
  }
  if (process.platform !== "darwin") {
    _egoAvailable = false;
    return false;
  }
  try {
    execFile("which", ["ego-browser"], { timeout: 3e3 });
    _egoAvailable = true;
  } catch {
    _egoAvailable = false;
  }
  return _egoAvailable;
}
function resetEgoBrowserCache() {
  _egoAvailable = null;
}
function fetchHtmlWithEgoBrowser(targetUrl, options = {}) {
  const { signal, timeout = 3e4, logger = noopLogger } = options;
  const spaceName = `nuo-patent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tabTimeoutSec = Math.max(10, Math.floor(timeout / 1e3));
  const script = [
    `const task = await useOrCreateTaskSpace(${JSON.stringify(spaceName)})`,
    `try {`,
    `  await openOrReuseTab(${JSON.stringify(targetUrl)}, { wait: true, timeout: ${tabTimeoutSec} })`,
    `  const status = await js(String.raw\`performance.getEntriesByType('navigation')[0]?.responseStatus ?? 0\`)`,
    `  if (!status || status >= 400) throw new Error('HTTP ' + status)`,
    `  const html = await js(String.raw\`document.documentElement.outerHTML\`)`,
    `  cliLog('NUO_START')`,
    `  cliLog(Buffer.from(html, 'utf8').toString('base64'))`,
    `  cliLog('NUO_END')`,
    `} finally {`,
    `  await completeTaskSpace(task.id, { keep: false })`,
    `}`
  ].join("\n");
  return new Promise((resolve, reject) => {
    logger.info(`[ego-browser] \u6253\u5F00 ${targetUrl}`);
    const child = exec(
      "ego-browser nodejs",
      {
        timeout: timeout + 15e3,
        // 子进程整体多给 15s（浏览器启动、页面加载）
        maxBuffer: 128 * 1024 * 1024,
        // HTML base64 可能达数 MB，放宽 stdout 上限
        signal
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || "").trim().split("\n").pop() || err.message;
          reject(new Error(`ego-browser \u6293\u53D6\u5931\u8D25: ${detail}`));
          return;
        }
        try {
          resolve(extractHtmlFromStdout(`${stdout}
${stderr}`));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    );
    child.stdin?.write(script + "\n");
    child.stdin?.end();
    if (signal) {
      const onAbort = () => {
        child.kill("SIGKILL");
        reject(new Error("Request aborted"));
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}
function extractHtmlFromStdout(stdout) {
  const start = stdout.indexOf("NUO_START");
  const end = stdout.lastIndexOf("NUO_END");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("ego-browser \u8F93\u51FA\u4E2D\u672A\u627E\u5230\u6709\u6548 HTML \u6807\u8BB0");
  }
  const b64 = stdout.slice(start + "NUO_START".length, end).replace(/\s+/g, "");
  return Buffer.from(b64, "base64").toString("utf8");
}

// src/errors.ts
var NuoPatentError = class extends Error {
  /** 关联的专利号（如适用） */
  patentNumber;
  constructor(message, patentNumber) {
    super(message);
    this.name = "NuoPatentError";
    this.patentNumber = patentNumber;
  }
};
var PatentClassError = class extends NuoPatentError {
  constructor(message, patentNumber) {
    super(message, patentNumber);
    this.name = "PatentClassError";
  }
};
var NoPatentsError = class extends NuoPatentError {
  constructor(message) {
    super(message);
    this.name = "NoPatentsError";
  }
};
var PDFDownloadError = class extends NuoPatentError {
  constructor(message, patentNumber) {
    super(message, patentNumber);
    this.name = "PDFDownloadError";
  }
};
var CNIPAQueryError = class extends NuoPatentError {
  constructor(message) {
    super(message);
    this.name = "CNIPAQueryError";
  }
};
var TimeoutError = class extends NuoPatentError {
  /** 超时阈值（毫秒） */
  timeoutMs;
  constructor(message, timeoutMs, patentNumber) {
    super(message, patentNumber);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
};
var ParseError = class extends NuoPatentError {
  /** 解析失败的字段名 */
  field;
  constructor(message, field, patentNumber) {
    super(message, patentNumber);
    this.name = "ParseError";
    this.field = field;
  }
};

// src/scraper.ts
var PATENT_NUMBER_RE = /^([A-Z]{2})(\d{1,14}[A-Z]?\d*)$/i;
function validatePatentNumber(input) {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { valid: false, reason: "\u4E13\u5229\u53F7\u4E0D\u80FD\u4E3A\u7A7A" };
  }
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, "");
  if (cleaned.length < 4) {
    return { valid: false, reason: `\u4E13\u5229\u53F7\u8FC7\u77ED: "${cleaned}"\uFF08\u81F3\u5C11\u9700\u8981 4 \u4E2A\u5B57\u7B26\uFF09` };
  }
  const match = cleaned.match(PATENT_NUMBER_RE);
  if (!match) {
    return {
      valid: false,
      reason: `\u4E13\u5229\u53F7\u683C\u5F0F\u4E0D\u6B63\u786E: "${cleaned}"\uFF08\u671F\u671B\u683C\u5F0F: 2\u4E2A\u5B57\u6BCD\u56FD\u5BB6\u7801 + \u6570\u5B57\uFF0C\u5982 US11452699B2\uFF09`
    };
  }
  return { valid: true, normalized: cleaned };
}
function normalizePatentNumber(input) {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}
function detectSystemProxy() {
  const envUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (envUrl) {
    try {
      const u = new URL(envUrl);
      return { host: u.hostname, port: parseInt(u.port) || 8080 };
    } catch {
    }
  }
  if (process.platform === "darwin") {
    try {
      const output = execSync("scutil --proxy", { encoding: "utf8", timeout: 3e3 });
      const enabled = output.match(/HTTPSEnable\s*:\s*1/);
      const host = output.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (enabled && host && port) return { host, port: parseInt(port) };
    } catch {
    }
  }
  return void 0;
}
var _cachedProxy = null;
function getSystemProxy() {
  if (_cachedProxy === null) {
    _cachedProxy = detectSystemProxy();
  }
  return _cachedProxy;
}
var systemProxy = getSystemProxy;
async function fetchHtml(targetUrl, options = {}) {
  const { headers = {}, signal, timeout = 3e4, logger = noopLogger, fetchImpl } = options;
  if (isEgoBrowserAvailable()) {
    try {
      return await fetchHtmlWithEgoBrowser(targetUrl, { signal, timeout, logger });
    } catch (e) {
      logger.warn(`[ego-browser] \u6293\u53D6\u5931\u8D25\uFF0C\u56DE\u9000\u539F\u751F fetch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (signal?.aborted) {
    throw new Error("Request aborted");
  }
  const proxy = getSystemProxy();
  if (!proxy) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error("timeout")), timeout);
    if (signal) {
      signal.addEventListener("abort", () => controller.abort(signal.reason));
    }
    try {
      const resp = await (fetchImpl ?? fetch)(targetUrl, {
        headers,
        signal: controller.signal
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return await resp.text();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        if (signal?.aborted) throw new Error("Request aborted");
        throw new TimeoutError(`\u8BF7\u6C42\u8D85\u65F6 (${timeout}ms)`, timeout);
      }
      if (e instanceof Error && e.message === "Request aborted") {
        throw e;
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: `${target.hostname}:443`
    });
    const proxyTimeout = timeout + 5e3;
    const proxyTimer = setTimeout(() => {
      connectReq.destroy(new Error("Proxy CONNECT timeout"));
    }, proxyTimeout);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(proxyTimer);
        connectReq.destroy(new Error("Request aborted"));
      });
    }
    connectReq.on("connect", (res, socket) => {
      clearTimeout(proxyTimer);
      if (res.statusCode !== 200) {
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      const req = https.request({
        socket,
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: "GET",
        headers
      }, (httpsRes) => {
        if (httpsRes.statusCode && httpsRes.statusCode >= 300 && httpsRes.statusCode < 400 && httpsRes.headers.location) {
          resolve(fetchHtml(httpsRes.headers.location, options));
          return;
        }
        if (httpsRes.statusCode && httpsRes.statusCode >= 400) {
          reject(new Error(`HTTP ${httpsRes.statusCode}`));
          return;
        }
        let data = "";
        httpsRes.on("data", (chunk) => data += chunk.toString());
        httpsRes.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.end();
    });
    connectReq.on("error", (err) => {
      clearTimeout(proxyTimer);
      reject(err);
    });
    connectReq.end();
  });
}
function parseCitationElement($, element, logger = noopLogger) {
  const result = {
    patent_number: "",
    priority_date: "",
    pub_date: ""
  };
  const $el = $(element);
  try {
    const pubNum = $el.find('span[itemprop="publicationNumber"]').first();
    if (pubNum.length > 0) {
      result.patent_number = pubNum.text().trim();
    }
  } catch (e) {
    logger.warn("\u89E3\u6790\u5F15\u8BC1\u4E13\u5229\u53F7\u5931\u8D25", e);
  }
  try {
    const priorityDate = $el.find('td[itemprop="priorityDate"]').first();
    if (priorityDate.length > 0) {
      result.priority_date = priorityDate.text().trim();
    }
  } catch (e) {
    logger.warn("\u89E3\u6790\u5F15\u8BC1\u4F18\u5148\u6743\u65E5\u5931\u8D25", e);
  }
  try {
    const pubDate = $el.find('td[itemprop="publicationDate"]').first();
    if (pubDate.length > 0) {
      result.pub_date = pubDate.text().trim();
    }
  } catch (e) {
    logger.warn("\u89E3\u6790\u5F15\u8BC1\u516C\u5F00\u65E5\u5931\u8D25", e);
  }
  return result;
}
function extractCitations($, logger = noopLogger) {
  const selectors = [
    ["forwardCitesNoFamily", 'tr[itemprop="forwardReferencesOrig"]'],
    ["forwardCitesYesFamily", 'tr[itemprop="forwardReferencesFamily"]'],
    ["backwardCitesNoFamily", 'tr[itemprop="backwardReferences"]'],
    ["backwardCitesYesFamily", 'tr[itemprop="backwardReferencesFamily"]']
  ];
  const result = {};
  for (const [key, selector] of selectors) {
    const citations = [];
    $(selector).each((_i, elem) => {
      citations.push(parseCitationElement($, elem, logger));
    });
    result[key] = citations;
  }
  return result;
}
function extractEvents($, logger = noopLogger) {
  const result = {
    priority_date: "",
    filing_date: "",
    grant_date: "",
    expiration_date: "",
    pub_date: ""
  };
  $('dd[itemprop="events"]').each((_index, appEvent) => {
    try {
      const $event = $(appEvent);
      const titleInfo = $event.find('span[itemprop="type"]').first();
      if (titleInfo.length === 0) return;
      const titleText = titleInfo.text().trim();
      const timeTag = $event.find('time[itemprop="date"]').first();
      if (timeTag.length === 0) return;
      const timeEvent = timeTag.text().trim();
      switch (titleText) {
        case "priority":
          result.priority_date = timeEvent;
          break;
        case "filed":
          result.filing_date = timeEvent;
          break;
        case "granted":
          result.grant_date = timeEvent;
          break;
        case "publication":
          if (!result.pub_date) result.pub_date = timeEvent;
          break;
      }
      const titleSpan = $event.find('span[itemprop="title"]').first();
      if (titleSpan.length > 0 && titleSpan.text().toLowerCase().includes("expiration")) {
        result.expiration_date = timeEvent;
      }
    } catch (e) {
      logger.warn("\u89E3\u6790\u65F6\u95F4\u7EBF\u4E8B\u4EF6\u5931\u8D25", e);
    }
  });
  return result;
}
function extractLegalStatus($, logger = noopLogger) {
  const legal = {
    status: "",
    ifi_status: "",
    estimated_expiration: "",
    events: []
  };
  try {
    const ifiElem = $('dd[itemprop="legalStatusIfi"]').first();
    if (ifiElem.length > 0) {
      const ifiText = ifiElem.text().trim();
      legal.ifi_status = ifiText;
      if (ifiText.includes(",")) {
        const parts = ifiText.split(",");
        legal.status = parts[0].trim();
        if (parts.length > 1) {
          const expMatch = ifiText.match(/expires?\s*(\d{4}-\d{2}-\d{2})/);
          if (expMatch) {
            legal.estimated_expiration = expMatch[1];
          }
        }
      }
    }
  } catch (e) {
    logger.warn("\u89E3\u6790 IFI \u6CD5\u5F8B\u72B6\u6001\u5931\u8D25", e);
  }
  $('dd[itemprop="events"]').each((_index, appEvent) => {
    try {
      const $event = $(appEvent);
      const titleInfo = $event.find('span[itemprop="type"]').first();
      if (titleInfo.length === 0) return;
      const titleText = titleInfo.text().trim();
      if (titleText !== "legal-status") return;
      const timeTag = $event.find('time[itemprop="date"]').first();
      if (timeTag.length === 0) return;
      const dateText = timeTag.text().trim();
      if (dateText === "Status") {
        const titleSpan = $event.find('span[itemprop="title"]').first();
        if (titleSpan.length > 0) {
          const statusText = titleSpan.text().trim();
          legal.status = statusText.replace("Current", "").trim();
        }
      } else if (dateText && /^\d/.test(dateText)) {
        legal.estimated_expiration = dateText;
        const titleSpan = $event.find('span[itemprop="title"]').first();
        if (titleSpan.length > 0) {
          legal.events.push({
            type: titleSpan.text().trim(),
            date: dateText,
            title: ""
          });
        }
      }
    } catch (e) {
      logger.warn("\u89E3\u6790\u6CD5\u5F8B\u72B6\u6001\u4E8B\u4EF6\u5931\u8D25", e);
    }
  });
  return legal;
}
function extractClassifications($, logger = noopLogger) {
  const clsArray = [];
  try {
    $('dd[itemprop="classifications"]').each((_index, elem) => {
      clsArray.push($(elem).text().trim());
    });
  } catch (e) {
    logger.warn("\u89E3\u6790\u5206\u7C7B\u4FE1\u606F\u5931\u8D25", e);
  }
  return clsArray;
}
function parsePatentHtml($, options = {}) {
  const { returnAbstract = true, returnLegal = true, logger = noopLogger } = options;
  const warnings = [];
  let titleText = "";
  try {
    const title = $('meta[name="DC.title"]').first();
    if (title.length > 0) {
      titleText = title.attr("content")?.trim() ?? "";
    }
    if (!titleText) {
      warnings.push({ field: "title", message: "\u672A\u627E\u5230 DC.title meta \u6807\u7B7E" });
    }
  } catch (e) {
    warnings.push({ field: "title", message: `\u89E3\u6790\u5F02\u5E38: ${e}` });
    logger.warn("\u89E3\u6790\u6807\u9898\u5931\u8D25", e);
  }
  let inventorName = "";
  try {
    const inventors = [];
    $('dd[itemprop="inventor"]').each((_index, elem) => {
      inventors.push({ inventor_name: $(elem).text().trim() });
    });
    inventorName = JSON.stringify(inventors);
  } catch (e) {
    warnings.push({ field: "inventor_name", message: `\u89E3\u6790\u5F02\u5E38: ${e}` });
    inventorName = "[]";
    logger.warn("\u89E3\u6790\u53D1\u660E\u4EBA\u5931\u8D25", e);
  }
  let assigneeNameOrig = "";
  try {
    const assignees = [];
    $('dd[itemprop="assigneeOriginal"]').each((_index, elem) => {
      assignees.push({ assignee_name: $(elem).text().trim() });
    });
    assigneeNameOrig = JSON.stringify(assignees);
  } catch (e) {
    warnings.push({ field: "assignee_name_orig", message: `\u89E3\u6790\u5F02\u5E38: ${e}` });
    assigneeNameOrig = "[]";
    logger.warn("\u89E3\u6790\u539F\u59CB\u53D7\u8BA9\u4EBA\u5931\u8D25", e);
  }
  let assigneeNameCurrent = "";
  try {
    const assignees = [];
    $('dd[itemprop="assigneeCurrent"]').each((_index, elem) => {
      assignees.push({ assignee_name: $(elem).text().trim() });
    });
    assigneeNameCurrent = JSON.stringify(assignees);
  } catch (e) {
    warnings.push({ field: "assignee_name_current", message: `\u89E3\u6790\u5F02\u5E38: ${e}` });
    assigneeNameCurrent = "[]";
    logger.warn("\u89E3\u6790\u5F53\u524D\u53D7\u8BA9\u4EBA\u5931\u8D25", e);
  }
  let pubDate = "";
  try {
    const pubDateElem = $('dd[itemprop="publicationDate"]').first();
    if (pubDateElem.length > 0) {
      pubDate = pubDateElem.text().trim();
    }
  } catch (e) {
    warnings.push({ field: "pub_date", message: `\u89E3\u6790\u5F02\u5E38: ${e}` });
    logger.warn("\u89E3\u6790\u516C\u5F00\u65E5\u5931\u8D25", e);
  }
  let applicationNumber = "";
  try {
    const appNumElem = $('dd[itemprop="applicationNumber"]').first();
    if (appNumElem.length > 0) {
      applicationNumber = appNumElem.text().trim();
    }
  } catch (e) {
    warnings.push({ field: "application_number", message: `\u89E3\u6790\u5F02\u5E38: ${e}` });
    logger.warn("\u89E3\u6790\u7533\u8BF7\u53F7\u5931\u8D25", e);
  }
  const events = extractEvents($, logger);
  if (!pubDate && events.pub_date) {
    pubDate = events.pub_date;
  }
  let legal;
  if (returnLegal) {
    legal = extractLegalStatus($, logger);
  } else {
    legal = { status: "", ifi_status: "", estimated_expiration: "", events: [] };
  }
  const citations = extractCitations($, logger);
  const forwardCitesNoFamily = JSON.stringify(citations.forwardCitesNoFamily);
  const forwardCitesYesFamily = JSON.stringify(citations.forwardCitesYesFamily);
  const backwardCitesNoFamily = JSON.stringify(citations.backwardCitesNoFamily);
  const backwardCitesYesFamily = JSON.stringify(citations.backwardCitesYesFamily);
  let abstractText = "";
  if (returnAbstract) {
    try {
      const abstract = $('meta[name="DC.description"]').first();
      if (abstract.length > 0) {
        abstractText = abstract.attr("content")?.trim() ?? "";
      }
      if (!abstractText) {
        warnings.push({ field: "abstract_text", message: "\u672A\u627E\u5230 DC.description meta \u6807\u7B7E" });
      }
    } catch (e) {
      warnings.push({ field: "abstract_text", message: `\u89E3\u6790\u5F02\u5E38: ${e}` });
      logger.warn("\u89E3\u6790\u6458\u8981\u5931\u8D25", e);
    }
  }
  let pdfUrl = "";
  try {
    const pdfMeta = $('meta[name="citation_pdf_url"]').first();
    if (pdfMeta.length > 0) {
      pdfUrl = pdfMeta.attr("content") ?? "";
    }
    if (!pdfUrl) {
      warnings.push({ field: "pdf_url", message: "\u672A\u627E\u5230 citation_pdf_url meta \u6807\u7B7E" });
    }
  } catch (e) {
    warnings.push({ field: "pdf_url", message: `\u89E3\u6790\u5F02\u5E38: ${e}` });
    logger.warn("\u89E3\u6790 PDF URL \u5931\u8D25", e);
  }
  const classifications = JSON.stringify(extractClassifications($, logger));
  const data = {
    title: titleText,
    application_number: applicationNumber,
    inventor_name: inventorName,
    assignee_name_orig: assigneeNameOrig,
    assignee_name_current: assigneeNameCurrent,
    pub_date: pubDate,
    filing_date: events.filing_date,
    priority_date: events.priority_date,
    grant_date: events.grant_date,
    expiration_date: events.expiration_date,
    legal_status: legal.status,
    ifi_status: legal.ifi_status,
    estimated_expiration: legal.estimated_expiration,
    pdf_url: pdfUrl,
    classifications,
    forward_cite_no_family: forwardCitesNoFamily,
    forward_cite_yes_family: forwardCitesYesFamily,
    backward_cite_no_family: backwardCitesNoFamily,
    backward_cite_yes_family: backwardCitesYesFamily,
    abstract_text: abstractText
  };
  return { data, warnings };
}
async function scrapePatent(patentNumber, options = {}) {
  const {
    signal,
    timeout = 3e4,
    logger = noopLogger,
    headers = {},
    returnAbstract = true,
    returnLegal = true,
    fetchImpl
  } = options;
  const validation = validatePatentNumber(patentNumber);
  if (!validation.valid) {
    return {
      success: false,
      patent: patentNumber,
      url: "",
      data: null,
      errorCode: "VALIDATION_ERROR",
      errorMessage: validation.reason ?? "\u4E13\u5229\u53F7\u6821\u9A8C\u5931\u8D25",
      parseWarnings: []
    };
  }
  const normalizedPatent = validation.normalized;
  const requestUrl = `https://patents.google.com/patent/${normalizedPatent}`;
  let html;
  try {
    logger.info(`\u6B63\u5728\u8BF7\u6C42 ${requestUrl}`);
    html = await fetchHtml(requestUrl, {
      headers: { "User-Agent": "Mozilla/5.0", ...headers },
      signal,
      timeout,
      logger,
      fetchImpl
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const message = err.message;
    if (message === "Request aborted" || signal?.aborted) {
      return {
        success: false,
        patent: normalizedPatent,
        url: requestUrl,
        data: null,
        errorCode: "ABORTED",
        errorMessage: "\u8BF7\u6C42\u5DF2\u88AB\u53D6\u6D88",
        parseWarnings: []
      };
    }
    if (err instanceof TimeoutError || message.includes("timeout")) {
      return {
        success: false,
        patent: normalizedPatent,
        url: requestUrl,
        data: null,
        errorCode: "TIMEOUT",
        errorMessage: `\u8BF7\u6C42\u8D85\u65F6 (${timeout}ms)`,
        parseWarnings: []
      };
    }
    if (message.includes("HTTP 404") || message.includes("HTTP 410")) {
      return {
        success: false,
        patent: normalizedPatent,
        url: requestUrl,
        data: null,
        errorCode: "NOT_FOUND",
        errorMessage: `\u4E13\u5229 ${normalizedPatent} \u672A\u627E\u5230 (404)`,
        parseWarnings: []
      };
    }
    if (message.startsWith("HTTP ")) {
      return {
        success: false,
        patent: normalizedPatent,
        url: requestUrl,
        data: null,
        errorCode: "HTTP_ERROR",
        errorMessage: message,
        parseWarnings: []
      };
    }
    return {
      success: false,
      patent: normalizedPatent,
      url: requestUrl,
      data: null,
      errorCode: "NETWORK_ERROR",
      errorMessage: message,
      parseWarnings: []
    };
  }
  try {
    const $ = cheerio.load(html);
    const { data, warnings } = parsePatentHtml($, { returnAbstract, returnLegal, logger });
    if (!data.title && !data.application_number && !data.abstract_text) {
      return {
        success: false,
        patent: normalizedPatent,
        url: requestUrl,
        data: null,
        errorCode: "NOT_FOUND",
        errorMessage: `\u4E13\u5229 ${normalizedPatent} \u7684\u9875\u9762\u65E0\u6709\u6548\u6570\u636E\uFF08\u53EF\u80FD\u4E0D\u5B58\u5728\u6216\u9875\u9762\u7ED3\u6784\u8C03\u6574\uFF09`,
        parseWarnings: warnings
      };
    }
    return {
      success: true,
      patent: normalizedPatent,
      url: requestUrl,
      data: { ...data, patent: normalizedPatent, url: requestUrl },
      errorCode: "",
      errorMessage: "",
      parseWarnings: warnings
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      patent: normalizedPatent,
      url: requestUrl,
      data: null,
      errorCode: "PARSE_ERROR",
      errorMessage: `HTML \u89E3\u6790\u5931\u8D25: ${message}`,
      parseWarnings: []
    };
  }
}
var GooglePatentsScraper = class {
  listOfPatents = [];
  scrapeStatus = {};
  parsedPatents = {};
  returnAbstract;
  returnLegal;
  constructor(returnAbstract = true, returnLegal = true) {
    this.returnAbstract = returnAbstract;
    this.returnLegal = returnLegal;
  }
  addPatents(patent) {
    if (typeof patent !== "string") {
      throw new PatentClassError("'patent' variable must be a string");
    }
    this.listOfPatents.push(patent);
  }
  deletePatents(patent) {
    const index = this.listOfPatents.indexOf(patent);
    if (index !== -1) {
      this.listOfPatents.splice(index, 1);
    } else {
      console.log(`Patent ${patent} not in patent list`);
    }
  }
  addScrapeStatus(patent, value) {
    this.scrapeStatus[patent] = value;
  }
  /**
   * @deprecated 推荐使用无状态的 `scrapePatent()` 函数，避免状态污染。
   */
  async requestSinglePatent(patent, url = false) {
    try {
      let requestUrl;
      if (!url) {
        requestUrl = `https://patents.google.com/patent/${patent}`;
      } else {
        requestUrl = patent;
      }
      const html = await fetchHtml(requestUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const $ = cheerio.load(html);
      return ["Success", $, requestUrl];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`Patent: ${patent}, Error: ${errorMessage}`);
      return [errorMessage, null, patent];
    }
  }
  parseCitation($, element) {
    return parseCitationElement($, element);
  }
  /**
   * @deprecated 推荐使用无状态的 `parsePatentHtml()` 函数，可获取 parseWarnings。
   */
  processPatentHtml($) {
    const { data } = parsePatentHtml($, {
      returnAbstract: this.returnAbstract,
      returnLegal: this.returnLegal
    });
    return data;
  }
  getScrapedData($, patent, url) {
    const parsing = this.processPatentHtml($);
    parsing.url = url;
    parsing.patent = patent;
    return parsing;
  }
  /**
   * @deprecated 推荐逐专利调用 `scrapePatent()`，避免实例状态残留。
   */
  async scrapeAllPatents() {
    if (this.listOfPatents.length === 0) {
      throw new NoPatentsError(
        "no patents to scrape specified in 'patent' variable: add patent using class.addPatents([<PATENTNUMBER>])"
      );
    }
    for (const patent of this.listOfPatents) {
      const [errorStatus, soup, url] = await this.requestSinglePatent(patent);
      this.addScrapeStatus(patent, errorStatus);
      if (errorStatus === "Success" && soup) {
        this.parsedPatents[patent] = this.getScrapedData(soup, patent, url);
      } else {
        this.parsedPatents[patent] = {};
      }
    }
  }
  // Getters
  get list_of_patents() {
    return this.listOfPatents;
  }
  get scrape_status() {
    return this.scrapeStatus;
  }
  get parsed_patents() {
    return this.parsedPatents;
  }
};
var scraper_class = GooglePatentsScraper;

// src/search.ts
import * as cheerio2 from "cheerio";
function extractAssignee(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    const first = value[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "name" in first) {
      const name = first.name;
      return typeof name === "string" ? name : "";
    }
    return "";
  }
  if (value && typeof value === "object" && "name" in value) {
    const name = value.name;
    return typeof name === "string" ? name : "";
  }
  return "";
}
function parseSearchResultsJson(raw) {
  const hits = [];
  let total = 0;
  if (!raw || typeof raw !== "object") return { total, hits };
  const results = raw.results;
  if (!results || typeof results !== "object") return { total, hits };
  const r = results;
  if (typeof r.total_num_results === "number") total = r.total_num_results;
  if (!Array.isArray(r.cluster)) return { total, hits };
  for (const cluster of r.cluster) {
    if (!cluster || typeof cluster !== "object") continue;
    const resultList = cluster.result;
    if (!Array.isArray(resultList)) continue;
    for (const item of resultList) {
      const patent = item && typeof item === "object" ? item.patent : void 0;
      if (!patent || typeof patent !== "object") continue;
      const p = patent;
      const publicationNumber = typeof p.publication_number === "string" ? p.publication_number : "";
      if (!publicationNumber) continue;
      hits.push({
        patent: publicationNumber,
        title: typeof p.title === "string" ? p.title : "",
        assignee: extractAssignee(p.assignee_current),
        publication_date: typeof p.publication_date === "string" ? p.publication_date : "",
        priority_date: typeof p.priority_date === "string" ? p.priority_date : "",
        abstract: typeof p.abstract === "string" ? p.abstract : "",
        url: `https://patents.google.com/patent/${publicationNumber}`
      });
    }
  }
  return { total, hits };
}
function parseSearchResultsHtml($, logger = noopLogger) {
  const hits = [];
  const warnings = [];
  $("search-result").each((_i, elem) => {
    const $el = $(elem);
    let patent = "";
    try {
      const link = $el.find("h3 a[href*='/patent/']").first();
      const href = link.attr("href") ?? "";
      patent = href.replace(/^\/patent\//, "").trim();
    } catch (e) {
      logger.warn("\u89E3\u6790\u641C\u7D22\u7ED3\u679C\u4E13\u5229\u53F7\u5931\u8D25", e);
    }
    if (!patent) return;
    let title = "";
    try {
      title = $el.find("h3").first().text().trim();
    } catch (e) {
      logger.warn("\u89E3\u6790\u641C\u7D22\u7ED3\u679C\u6807\u9898\u5931\u8D25", e);
    }
    let assignee = "";
    try {
      assignee = $el.find('dd[itemprop="assigneeCurrent"]').first().text().trim();
    } catch (e) {
      logger.warn("\u89E3\u6790\u641C\u7D22\u7ED3\u679C\u53D7\u8BA9\u4EBA\u5931\u8D25", e);
    }
    let publicationDate = "";
    try {
      publicationDate = $el.find('dd[itemprop="publicationDate"]').first().text().trim();
    } catch (e) {
      logger.warn("\u89E3\u6790\u641C\u7D22\u7ED3\u679C\u516C\u5F00\u65E5\u5931\u8D25", e);
    }
    let priorityDate = "";
    try {
      priorityDate = $el.find('dd[itemprop="priorityDate"]').first().text().trim();
    } catch (e) {
      logger.warn("\u89E3\u6790\u641C\u7D22\u7ED3\u679C\u4F18\u5148\u6743\u65E5\u5931\u8D25", e);
    }
    let abstract = "";
    try {
      abstract = $el.find(".abstract, dd[itemprop='abstract']").first().text().trim();
    } catch (e) {
      logger.warn("\u89E3\u6790\u641C\u7D22\u7ED3\u679C\u6458\u8981\u5931\u8D25", e);
    }
    if (!title) warnings.push(`\u7ED3\u679C ${patent} \u7F3A\u5C11\u6807\u9898`);
    hits.push({
      patent,
      title,
      assignee,
      publication_date: publicationDate,
      priority_date: priorityDate,
      abstract,
      url: `https://patents.google.com/patent/${patent}`
    });
  });
  if (hits.length === 0) {
    warnings.push("\u641C\u7D22\u7ED3\u679C\u9875\u672A\u89E3\u6790\u5230\u4EFB\u4F55\u7ED3\u679C\uFF08\u9875\u9762\u7ED3\u6784\u53EF\u80FD\u53D8\u5316\uFF09");
  }
  return { hits, warnings };
}
async function searchPatents(query, options = {}) {
  const {
    limit = 10,
    signal,
    timeout = 3e4,
    logger = noopLogger,
    fetchImpl
  } = options;
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { query, total: 0, hits: [], warnings: ["\u67E5\u8BE2\u6761\u4EF6\u4E3A\u7A7A"] };
  }
  const clampedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
  const xhrUrl = `https://patents.google.com/xhr/query?url=${encodeURIComponent(`q=${trimmed}`)}&exp=&num=${clampedLimit}`;
  try {
    logger.info(`\u6B63\u5728\u68C0\u7D22 ${trimmed}`);
    const raw = await fetchJson(xhrUrl, { signal, timeout, logger, fetchImpl });
    const { total, hits } = parseSearchResultsJson(raw);
    if (hits.length > 0) {
      return { query, total, hits, warnings: [] };
    }
    logger.warn("XHR JSON \u63A5\u53E3\u8FD4\u56DE 0 \u6761\uFF0C\u56DE\u9000 HTML \u641C\u7D22\u9875\u89E3\u6790");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`XHR JSON \u68C0\u7D22\u5931\u8D25\uFF0C\u56DE\u9000 HTML \u641C\u7D22\u9875: ${message}`);
    if (signal?.aborted) {
      return { query, total: 0, hits: [], warnings: ["\u8BF7\u6C42\u5DF2\u88AB\u53D6\u6D88"] };
    }
  }
  const htmlUrl = `https://patents.google.com/?q=${encodeURIComponent(trimmed)}&num=${clampedLimit}`;
  try {
    const html = await fetchHtml(htmlUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal,
      timeout,
      logger,
      fetchImpl
    });
    const $ = cheerio2.load(html);
    const { hits, warnings } = parseSearchResultsHtml($, logger);
    return { query, total: hits.length, hits, warnings };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (signal?.aborted) {
      return { query, total: 0, hits: [], warnings: ["\u8BF7\u6C42\u5DF2\u88AB\u53D6\u6D88"] };
    }
    const warning = err instanceof TimeoutError ? `\u68C0\u7D22\u8D85\u65F6 (${timeout}ms)` : `\u68C0\u7D22\u5931\u8D25: ${err.message}`;
    return { query, total: 0, hits: [], warnings: [warning] };
  }
}
async function fetchJson(targetUrl, options) {
  const text = await fetchHtml(targetUrl, options);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`\u54CD\u5E94\u4E0D\u662F\u6709\u6548 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// src/pdf-downloader.ts
import { mkdir, access, writeFile } from "fs/promises";
import { join, basename } from "path";
import https2 from "https";
import http2 from "http";
import { URL as URL2 } from "url";
var PDFDownloader = class {
  outputDir;
  scraper;
  maxWorkers;
  constructor(outputDir = "./patent_pdfs", scraper, maxWorkers = 4) {
    this.outputDir = outputDir;
    this.scraper = scraper ?? new GooglePatentsScraper(false, false);
    this.maxWorkers = maxWorkers;
  }
  /**
   * 确保输出目录存在。
   */
  async ensureOutputDir() {
    await mkdir(this.outputDir, { recursive: true });
  }
  /**
   * 获取专利 PDF URL。
   */
  async getPdfUrl(patentNumber) {
    const [err, soup, _url] = await this.scraper.requestSinglePatent(patentNumber);
    if (err !== "Success") {
      throw new PDFDownloadError(
        `\u83B7\u53D6\u4E13\u5229 ${patentNumber} \u9875\u9762\u5931\u8D25: ${err}`,
        patentNumber
      );
    }
    if (!soup) {
      throw new PDFDownloadError(
        `\u89E3\u6790\u4E13\u5229 ${patentNumber} HTML \u5931\u8D25`,
        patentNumber
      );
    }
    const data = this.scraper.processPatentHtml(soup);
    const pdfUrl = data.pdf_url ?? "";
    if (!pdfUrl) {
      throw new PDFDownloadError(
        `\u672A\u627E\u5230\u4E13\u5229 ${patentNumber} \u7684 PDF URL`,
        patentNumber
      );
    }
    return pdfUrl;
  }
  /**
   * 流式下载文件（带进度和取消支持）。
   */
  async downloadFile(url, outputPath, label = "", signal, logger = noopLogger) {
    try {
      const desc = label || basename(outputPath);
      logger.info(`\u5F00\u59CB\u4E0B\u8F7D: ${desc}`);
      const { chunks } = await this.fetchBinary(url, label, signal, logger);
      logger.info(`\u4E0B\u8F7D\u5B8C\u6210: ${desc}`);
      const buffer = Buffer.concat(chunks);
      await writeFile(outputPath, buffer);
      return outputPath;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      throw new PDFDownloadError(
        `\u4E0B\u8F7D\u5931\u8D25 ${label}: ${error.message}`,
        label
      );
    }
  }
  async fetchBinary(url, label = "", signal, logger = noopLogger) {
    const requestHeaders = { "User-Agent": "Mozilla/5.0" };
    const proxy = getSystemProxy();
    if (!proxy) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error("timeout")), 6e4);
      if (signal) {
        signal.addEventListener("abort", () => controller.abort(signal.reason));
      }
      try {
        const resp = await fetch(url, {
          headers: requestHeaders,
          signal: controller.signal
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        return { chunks: [new Uint8Array(buf)], totalSize: buf.byteLength };
      } finally {
        clearTimeout(timeoutId);
      }
    }
    const target = new URL2(url);
    return new Promise((resolve, reject) => {
      const connectReq = http2.request({
        host: proxy.host,
        port: proxy.port,
        method: "CONNECT",
        path: `${target.hostname}:443`
      });
      const proxyTimer = setTimeout(() => {
        connectReq.destroy(new Error("Proxy CONNECT timeout"));
      }, 35e3);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(proxyTimer);
          connectReq.destroy(new Error("Request aborted"));
        });
      }
      connectReq.on("connect", (res, socket) => {
        clearTimeout(proxyTimer);
        if (res.statusCode !== 200) {
          reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
          return;
        }
        const req = https2.request({
          socket,
          hostname: target.hostname,
          path: target.pathname + target.search,
          method: "GET",
          headers: requestHeaders
        }, (httpsRes) => {
          if (httpsRes.statusCode && httpsRes.statusCode >= 400) {
            reject(new Error(`HTTP ${httpsRes.statusCode}`));
            return;
          }
          const totalSize = Number(httpsRes.headers["content-length"] ?? 0);
          const chunks = [];
          let downloaded = 0;
          httpsRes.on("data", (chunk) => {
            chunks.push(new Uint8Array(chunk));
            downloaded += chunk.length;
            if (totalSize > 0) {
              const pct = Math.round(downloaded / totalSize * 100);
              logger.debug(`${label}: ${pct}% (${this.formatBytes(downloaded)}/${this.formatBytes(totalSize)})`);
            }
          });
          httpsRes.on("end", () => resolve({ chunks, totalSize }));
        });
        req.on("error", reject);
        req.end();
      });
      connectReq.on("error", (err) => {
        clearTimeout(proxyTimer);
        reject(err);
      });
      connectReq.end();
    });
  }
  /**
   * 格式化字节为人类可读字符串。
   */
  formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${Math.round(bytes / Math.pow(k, i) * 100) / 100} ${sizes[i]}`;
  }
  /**
   * 下载单个专利 PDF。
   *
   * @param patentNumber - 专利号（如 'US11452699B2'）
   * @param outputPath - 可选完整输出路径；默认 `{outputDir}/{patentNumber}.pdf`
   * @param signal - 可选的 AbortSignal 用于取消下载
   * @param logger - 可选日志接口
   * @returns 下载后的 PDF 文件路径
   */
  async downloadSingle(patentNumber, outputPath, signal, logger = noopLogger) {
    await this.ensureOutputDir();
    const resolvedPath = outputPath ?? join(this.outputDir, `${patentNumber}.pdf`);
    try {
      await access(resolvedPath);
      logger.info(`${patentNumber}.pdf \u5DF2\u5B58\u5728\uFF0C\u8DF3\u8FC7`);
      return resolvedPath;
    } catch {
    }
    const pdfUrl = await this.getPdfUrl(patentNumber);
    return await this.downloadFile(pdfUrl, resolvedPath, patentNumber, signal, logger);
  }
  /**
   * 批量下载 PDF（返回结构化结果，推荐智能体使用）。
   *
   * @param patentNumbers - 专利号列表
   * @param options - 下载选项（signal, logger, maxWorkers）
   * @returns 每个专利的 DownloadResult 数组，不抛异常
   */
  async downloadBatchWithResults(patentNumbers, options = {}) {
    const { signal, logger = noopLogger, maxWorkers = this.maxWorkers } = options;
    const results = [];
    logger.info(`\u5F00\u59CB\u6279\u91CF\u4E0B\u8F7D ${patentNumbers.length} \u7BC7\u4E13\u5229 PDF`);
    for (let i = 0; i < patentNumbers.length; i += maxWorkers) {
      if (signal?.aborted) {
        const remaining = patentNumbers.slice(i);
        for (const pn of remaining) {
          results.push({
            patentNumber: pn,
            success: false,
            error: "\u8BF7\u6C42\u5DF2\u88AB\u53D6\u6D88"
          });
        }
        break;
      }
      const batch = patentNumbers.slice(i, i + maxWorkers);
      const batchResults = await Promise.allSettled(
        batch.map(async (pn) => {
          try {
            const filePath = await this.downloadSingle(pn, void 0, signal, logger);
            return { patentNumber: pn, success: true, path: filePath };
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            logger.warn(`${pn} \u4E0B\u8F7D\u5931\u8D25: ${error}`);
            return { patentNumber: pn, success: false, error };
          }
        })
      );
      for (const settled of batchResults) {
        if (settled.status === "fulfilled") {
          results.push(settled.value);
        } else {
          const error = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          results.push({ patentNumber: "(unknown)", success: false, error });
        }
      }
    }
    const succeeded = results.filter((r) => r.success).length;
    logger.info(`\u6279\u91CF\u4E0B\u8F7D\u5B8C\u6210: ${succeeded}/${results.length} \u6210\u529F`);
    return results;
  }
  /**
   * 批量下载 PDF（返回 Record，保留向后兼容）。
   *
   * @deprecated 推荐使用 `downloadBatchWithResults()` 获得结构化结果。
   */
  async downloadBatch(patentNumbers) {
    const results = {};
    for (let i = 0; i < patentNumbers.length; i += this.maxWorkers) {
      const batch = patentNumbers.slice(i, i + this.maxWorkers);
      const batchResults = await Promise.allSettled(
        batch.map(async (pn) => {
          try {
            const filePath = await this.downloadSingle(pn);
            return { patentNumber: pn, result: filePath, error: null };
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { patentNumber: pn, result: null, error };
          }
        })
      );
      for (const settledResult of batchResults) {
        if (settledResult.status === "fulfilled") {
          const { patentNumber, result, error } = settledResult.value;
          if (error) {
            results[patentNumber] = error;
          } else {
            results[patentNumber] = result;
          }
        }
      }
    }
    return results;
  }
  /**
   * 下载专利及其家族成员的 PDF。
   *
   * @param patentNumber - 专利号
   * @param outputDir - 可选子目录
   * @returns 下载后的 PDF 文件路径
   */
  async downloadFamily(patentNumber, outputDir) {
    const resolvedDir = outputDir ?? join(this.outputDir, `${patentNumber}_family`);
    await mkdir(resolvedDir, { recursive: true });
    const outputPath = join(resolvedDir, `${patentNumber}.pdf`);
    return await this.downloadSingle(patentNumber, outputPath);
  }
};
async function downloadPdf(patentNumber, outputDir = "./patent_pdfs") {
  const downloader = new PDFDownloader(outputDir);
  return await downloader.downloadSingle(patentNumber);
}

// src/legal-status.ts
var LegalStatusChecker = class {
  scraper;
  constructor(scraper) {
    this.scraper = scraper ?? new GooglePatentsScraper(false, true);
  }
  /**
   * 查询单个专利的法律状态。
   *
   * @param patentNumber - 专利号
   * @param signal - 可选的 AbortSignal
   * @param logger - 可选日志接口
   */
  async check(patentNumber, signal, logger = noopLogger) {
    const [error, soup, url] = await this.scraper.requestSinglePatent(patentNumber);
    if (error !== "Success" || !soup) {
      logger.warn(`\u67E5\u8BE2 ${patentNumber} \u6CD5\u5F8B\u72B6\u6001\u5931\u8D25: ${error}`);
      return {
        patent_number: patentNumber,
        title: "",
        status: "UNKNOWN",
        ifi_status: "",
        estimated_expiration: "",
        filing_date: "",
        grant_date: "",
        applicant: "",
        inventor: "",
        events_summary: [],
        url,
        error: String(error)
      };
    }
    if (signal?.aborted) {
      return {
        patent_number: patentNumber,
        title: "",
        status: "UNKNOWN",
        ifi_status: "",
        estimated_expiration: "",
        filing_date: "",
        grant_date: "",
        applicant: "",
        inventor: "",
        events_summary: [],
        url,
        error: "\u8BF7\u6C42\u5DF2\u88AB\u53D6\u6D88"
      };
    }
    const data = this.scraper.processPatentHtml(soup);
    const eventsSummary = this.extractEvents(soup);
    return {
      patent_number: patentNumber,
      title: data.title || "",
      status: data.legal_status || "",
      ifi_status: data.ifi_status || "",
      estimated_expiration: data.estimated_expiration || "",
      filing_date: data.filing_date || "",
      grant_date: data.grant_date || "",
      applicant: data.assignee_name_current || "",
      inventor: data.inventor_name || "",
      events_summary: eventsSummary,
      url
    };
  }
  /**
   * 批量查询法律状态（并发执行）。
   *
   * @param patentNumbers - 专利号列表
   * @param options - 查询选项（signal, logger, maxConcurrency）
   */
  async checkBatch(patentNumbers, options = {}) {
    const { signal, logger = noopLogger, maxConcurrency = 4 } = options;
    const results = {};
    logger.info(`\u5F00\u59CB\u6279\u91CF\u67E5\u8BE2 ${patentNumbers.length} \u7BC7\u4E13\u5229\u6CD5\u5F8B\u72B6\u6001 (\u5E76\u53D1\u6570: ${maxConcurrency})`);
    for (let i = 0; i < patentNumbers.length; i += maxConcurrency) {
      if (signal?.aborted) {
        for (const pn of patentNumbers.slice(i)) {
          results[pn] = {
            patent_number: pn,
            title: "",
            status: "UNKNOWN",
            ifi_status: "",
            estimated_expiration: "",
            filing_date: "",
            grant_date: "",
            applicant: "",
            inventor: "",
            events_summary: [],
            url: "",
            error: "\u8BF7\u6C42\u5DF2\u88AB\u53D6\u6D88"
          };
        }
        break;
      }
      const batch = patentNumbers.slice(i, i + maxConcurrency);
      const batchPromises = batch.map(
        (pn) => this.check(pn, signal, logger)
      );
      const batchResults = await Promise.allSettled(batchPromises);
      for (let j = 0; j < batch.length; j++) {
        const settled = batchResults[j];
        if (settled.status === "fulfilled") {
          results[batch[j]] = settled.value;
        } else {
          const error = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          logger.warn(`${batch[j]} \u67E5\u8BE2\u5931\u8D25: ${error}`);
          results[batch[j]] = {
            patent_number: batch[j],
            title: "",
            status: "UNKNOWN",
            ifi_status: "",
            estimated_expiration: "",
            filing_date: "",
            grant_date: "",
            applicant: "",
            inventor: "",
            events_summary: [],
            url: "",
            error
          };
        }
      }
    }
    return results;
  }
  /**
   * 格式化法律状态报告（面向人类可读输出）。
   */
  formatStatusReport(result) {
    const lines = [];
    lines.push(`\u{1F4CB} \u4E13\u5229: ${result.patent_number}`);
    lines.push(`  \u6807\u9898: ${result.title || "N/A"}`);
    lines.push(`  \u6CD5\u5F8B\u72B6\u6001: ${result.status || "N/A"}`);
    lines.push(`  \u9884\u4F30\u5230\u671F\u65E5: ${result.estimated_expiration || "N/A"}`);
    lines.push(`  \u7533\u8BF7\u65E5: ${result.filing_date || "N/A"}`);
    lines.push(`  \u6388\u6743\u65E5: ${result.grant_date || "N/A"}`);
    const expiration = result.estimated_expiration;
    if (expiration) {
      try {
        const expDate = new Date(expiration);
        const now = /* @__PURE__ */ new Date();
        if (expDate < now) {
          lines.push(`  \u26A0\uFE0F  \u5DF2\u8FC7\u671F (${expiration})`);
        } else {
          const remainingDays = Math.ceil(
            (expDate.getTime() - now.getTime()) / (1e3 * 60 * 60 * 24)
          );
          lines.push(`  \u2705 \u6709\u6548, \u5269\u4F59 ${remainingDays} \u5929`);
        }
      } catch {
      }
    }
    return lines.join("\n");
  }
  /**
   * 查询年费状态。
   *
   * @param patentNumber - 专利号
   * @param signal - 可选的 AbortSignal
   * @param logger - 可选日志接口
   */
  async checkAnnuityStatus(patentNumber, signal, logger = noopLogger) {
    const result = await this.check(patentNumber, signal, logger);
    const feeEvents = [];
    for (const event of result.events_summary) {
      const eventText = `${event.title} ${event.type}`.toLowerCase();
      const feeKeywords = ["fee", "maintenance", "annuity", "payment"];
      if (feeKeywords.some((keyword) => eventText.includes(keyword))) {
        feeEvents.push(event);
      }
    }
    return {
      patent_number: patentNumber,
      status: result.status || "",
      estimated_expiration: result.estimated_expiration || "",
      fee_events: feeEvents,
      note: "\u5E74\u8D39\u8BE6\u60C5\u5EFA\u8BAE\u67E5\u8BE2 USPTO Patent Maintenance Fee Store \u6216\u5BF9\u5E94\u56FD\u5BB6\u4E13\u5229\u5C40"
    };
  }
  extractEvents($) {
    const eventsSummary = [];
    $('dd[itemprop="events"]').each((_i, ev) => {
      try {
        const $ev = $(ev);
        const evType = $ev.find('span[itemprop="type"]').first();
        const evTime = $ev.find('time[itemprop="date"]').first();
        const evTitle = $ev.find('span[itemprop="title"]').first();
        if (evType.length > 0 && evTime.length > 0) {
          eventsSummary.push({
            type: evType.text().trim(),
            date: evTime.text().trim(),
            title: evTitle.length > 0 ? evTitle.text().trim() : ""
          });
        }
      } catch {
      }
    });
    return eventsSummary;
  }
};

// src/cnipa-client.ts
import { execFile as execFile2 } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { dirname, join as join2 } from "path";
import { fileURLToPath } from "url";
var execFileAsync = promisify(execFile2);
function _getModuleDir() {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}
var _TOOL_CANDIDATE_PATHS = [
  join2(_getModuleDir(), "../cnipa_tool/cnipa_epub_client.py"),
  typeof process !== "undefined" && process.env.CNIPA_TOOL_PATH ? process.env.CNIPA_TOOL_PATH : ""
];
function _findTool() {
  for (const p of _TOOL_CANDIDATE_PATHS) {
    if (p && existsSync(p)) {
      return p;
    }
  }
  return null;
}
function _toolWorkdir(toolPath) {
  return dirname(toolPath);
}
var CNIPAClient = class {
  /** CNIPA 公布公告查询客户端。 */
  toolPath;
  workDir;
  logger;
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
  constructor(toolPath, workDir, logger) {
    this.logger = logger ?? noopLogger;
    const resolvedPath = toolPath ?? _findTool() ?? "";
    this.toolPath = resolvedPath;
    if (resolvedPath) {
      this.workDir = workDir ?? _toolWorkdir(resolvedPath) ?? dirname(resolvedPath);
    } else {
      this.workDir = workDir ?? process.cwd();
    }
  }
  // ------------------------------------------------------------------
  // 底层执行
  // ------------------------------------------------------------------
  async _run(...args) {
    if (!this.toolPath) {
      throw new CNIPAQueryError(
        "\u627E\u4E0D\u5230 CNIPA \u67E5\u8BE2\u5DE5\u5177\u3002\u8BF7\u901A\u8FC7\u73AF\u5883\u53D8\u91CF CNIPA_TOOL_PATH \u6307\u5B9A\uFF0C\n\u6216\u5B89\u88C5 YunXi \u9879\u76EE (https://github.com/xujian/YunXi)"
      );
    }
    const cmd = ["python3", this.toolPath, ...args];
    this.logger.debug(`\u6267\u884C\u547D\u4EE4: ${cmd.join(" ")}`);
    try {
      const { stdout, stderr } = await execFileAsync(cmd[0], cmd.slice(1), {
        timeout: 18e4,
        cwd: this.workDir
      });
      if (stdout.trim()) {
        return stdout.trim();
      }
      if (stderr.trim()) {
        throw new CNIPAQueryError(`CNIPA \u67E5\u8BE2\u5931\u8D25: ${stderr.trim()}`);
      }
      return stdout.trim();
    } catch (error) {
      if (error instanceof CNIPAQueryError) {
        throw error;
      }
      if (error instanceof Error) {
        if ("killed" in error && "signal" in error) {
          this.logger.warn("CNIPA \u67E5\u8BE2\u8D85\u65F6 (180s)");
          throw new CNIPAQueryError(
            "CNIPA \u67E5\u8BE2\u8D85\u65F6 (180s)\uFF0C\u7F51\u7EDC\u6216 WAF \u9A8C\u8BC1\u53EF\u80FD\u8FC7\u6162"
          );
        }
        if ("code" in error && error.code === "ENOENT") {
          throw new CNIPAQueryError(
            `\u627E\u4E0D\u5230\u811A\u672C\u6216 Python3: ${this.toolPath}\u3002\u8BF7\u786E\u8BA4 python3 \u5DF2\u5B89\u88C5\u4E14\u811A\u672C\u8DEF\u5F84\u6B63\u786E\u3002`
          );
        }
        if ("stderr" in error && typeof error.stderr === "string") {
          const stderrText = error.stderr.trim();
          this.logger.warn(`CNIPA stderr: ${stderrText}`);
          throw new CNIPAQueryError(`CNIPA \u67E5\u8BE2\u5931\u8D25: ${stderrText}`);
        }
        throw new CNIPAQueryError(`CNIPA \u67E5\u8BE2\u5931\u8D25: ${error.message}`);
      }
      throw new CNIPAQueryError("CNIPA \u67E5\u8BE2\u5931\u8D25: \u672A\u77E5\u9519\u8BEF");
    }
  }
  /**
   * 解析 CLI 输出的 JSON 数据。
   * 按行扫描，取第一个成功解析的 JSON 对象/数组。
   */
  _parseJsonOutput(output) {
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length >= 4) {
        try {
          return JSON.parse(trimmed);
        } catch {
          continue;
        }
      }
    }
    this.logger.warn("_parseJsonOutput: \u672A\u627E\u5230\u6709\u6548 JSON \u884C");
    return null;
  }
  // ------------------------------------------------------------------
  // 高级 API
  // ------------------------------------------------------------------
  /**
   * 关键词检索。
   *
   * @param keyword - 关键词、申请号或公布号
   * @returns SearchResult 对象
   */
  async search(keyword) {
    const output = await this._run("search", keyword);
    const data = this._parseJsonOutput(output);
    if (data && Array.isArray(data)) {
      return {
        keyword,
        total_hits: data.length,
        patents: data
      };
    }
    return {
      keyword,
      total_hits: 0,
      patents: []
    };
  }
  /**
   * 查询专利详情。
   *
   * @param pubNumber - 公布号，如 'CN122072823A'
   * @returns PatentDetail 对象
   */
  async detail(pubNumber) {
    const output = await this._run("detail", pubNumber);
    const data = this._parseJsonOutput(output);
    if (data && typeof data === "object") {
      const validFields = {};
      const detailFields = [
        "title",
        "pub_number",
        "pub_date",
        "app_number",
        "app_date",
        "applicant",
        "address",
        "inventor",
        "classification",
        "agency",
        "agent",
        "abstract",
        "first_page_image_url"
      ];
      for (const field of detailFields) {
        if (field in data) {
          validFields[field] = data[field];
        }
      }
      return {
        title: "",
        pub_number: pubNumber,
        pub_date: "",
        app_number: "",
        app_date: "",
        applicant: "",
        address: "",
        inventor: "",
        classification: "",
        agency: "",
        agent: "",
        abstract: "",
        first_page_image_url: "",
        ...validFields
      };
    }
    return {
      title: "",
      pub_number: pubNumber,
      pub_date: "",
      app_number: "",
      app_date: "",
      applicant: "",
      address: "",
      inventor: "",
      classification: "",
      agency: "",
      agent: "",
      abstract: "",
      first_page_image_url: ""
    };
  }
  /**
   * 查询法律状态/事务数据。
   *
   * @param appNumber - 13位申请号（纯数字，去掉小数点）
   * @returns TransactionRecord 列表
   */
  async transaction(appNumber) {
    const output = await this._run("transaction", appNumber);
    const data = this._parseJsonOutput(output);
    if (data && Array.isArray(data)) {
      return data.map((item) => ({
        index: item.index ?? 0,
        app_number: item.app_number ?? "",
        date: item.date ?? "",
        description: item.description ?? ""
      }));
    }
    return [];
  }
  /**
   * 通过公布号查询法律状态。
   *
   * @param pubNumber - 公布号，如 'CN122072823A'
   * @returns TransactionRecord 列表
   */
  async patentTransactions(pubNumber) {
    const output = await this._run("patent-transactions", pubNumber);
    const data = this._parseJsonOutput(output);
    if (data && Array.isArray(data)) {
      return data.map((item) => ({
        index: item.index ?? 0,
        app_number: item.app_number ?? "",
        date: item.date ?? "",
        description: item.description ?? ""
      }));
    }
    return [];
  }
  /**
   * 下载中国专利 PDF。
   *
   * @param pubNumber - 公布号，如 'CN122072823A'
   * @param outputDir - 输出目录，默认 '/tmp'
   * @returns PDF 文件路径，失败返回 null
   */
  async downloadPdf(pubNumber, outputDir = "/tmp") {
    const outputPath = join2(outputDir, `${pubNumber}.pdf`);
    try {
      await this._run("pdf", pubNumber, "-o", outputPath);
      if (existsSync(outputPath)) {
        return outputPath;
      }
      this.logger.warn(`PDF \u547D\u4EE4\u6267\u884C\u6210\u529F\u4F46\u6587\u4EF6\u4E0D\u5B58\u5728: ${outputPath}`);
    } catch (error) {
      this.logger.warn(`PDF \u4E0B\u8F7D\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
  /**
   * 检查 CNIPA 工具是否可用。
   *
   * 仅检查脚本文件和 python3 是否可执行，不实际发起网络请求（避免触发 WAF）。
   *
   * @returns 是否可用
   */
  isAvailable() {
    if (!this.toolPath || !existsSync(this.toolPath)) {
      return false;
    }
    return true;
  }
  /**
   * 格式化事务记录为可读文本。
   *
   * @param records - 事务记录列表
   * @returns 格式化的文本
   */
  formatTransactions(records) {
    const lines = [];
    for (const r of records) {
      lines.push(`  #${r.index}  [${r.date}] ${r.description}`);
    }
    return lines.join("\n");
  }
  // ------------------------------------------------------------------
  // 法律状态快捷方法
  // ------------------------------------------------------------------
  /**
   * 返回法律状态摘要文本。
   *
   * @param pubNumber - 公布号
   * @returns 可读的法律状态摘要
   */
  async legalStatusSummary(pubNumber) {
    const detail = await this.detail(pubNumber);
    const records = await this.patentTransactions(pubNumber);
    const lines = [
      `\u{1F4CB} \u4E2D\u56FD\u4E13\u5229: ${pubNumber}`,
      `  \u6807\u9898: ${detail.title}`,
      `  \u7533\u8BF7\u4EBA: ${detail.applicant}`,
      `  \u7533\u8BF7\u65E5: ${detail.app_date}`,
      `  \u7533\u8BF7\u53F7: ${detail.app_number}`
    ];
    if (records.length > 0) {
      const last = records[records.length - 1];
      lines.push(`  \u6700\u8FD1\u4E8B\u52A1: [${last.date}] ${last.description}`);
      const desc = last.description;
      if (desc.includes("\u6388\u6743") && !desc.includes("\u9A73\u56DE")) {
        lines.push("  \u72B6\u6001\u63A8\u65AD: \u2705 \u5DF2\u6388\u6743");
      } else if (desc.includes("\u9A73\u56DE")) {
        lines.push("  \u72B6\u6001\u63A8\u65AD: \u274C \u5DF2\u9A73\u56DE");
      } else if (desc.includes("\u64A4\u56DE")) {
        lines.push("  \u72B6\u6001\u63A8\u65AD: \u23F9\uFE0F \u5DF2\u64A4\u56DE");
      } else if (desc.includes("\u7EC8\u6B62") || desc.includes("\u5931\u6548")) {
        lines.push("  \u72B6\u6001\u63A8\u65AD: \u26A0\uFE0F \u5DF2\u7EC8\u6B62/\u5931\u6548");
      } else {
        lines.push(`  \u72B6\u6001\u63A8\u65AD: \u{1F504} \u5F85\u786E\u8BA4 (\u6700\u65B0: ${desc})`);
      }
      lines.push(`  \u4E8B\u52A1\u8BB0\u5F55 (${records.length} \u6761):`);
      for (const r of records.slice(-5)) {
        lines.push(`    [${r.date}] ${r.description}`);
      }
    } else {
      lines.push("  \u72B6\u6001: \u672A\u67E5\u8BE2\u5230\u4E8B\u52A1\u6570\u636E");
    }
    return lines.join("\n");
  }
};

// src/index.ts
var VERSION = "2.3.1";
var AUTHOR = "\u5C0F\u8BFA\u56E2\u961F \xB7 Xiaonuo Team";
var LICENSE = "MIT";
export {
  AUTHOR,
  CNIPAClient,
  CNIPAQueryError,
  GooglePatentsScraper,
  LICENSE,
  LegalStatusChecker,
  NoPatentsError,
  NuoPatentError,
  PDFDownloadError,
  PDFDownloader,
  ParseError,
  PatentClassError,
  TimeoutError,
  VERSION,
  downloadPdf,
  extractCitations,
  extractClassifications,
  extractEvents,
  extractLegalStatus,
  fetchHtml,
  fetchHtmlWithEgoBrowser,
  getSystemProxy,
  isEgoBrowserAvailable,
  noopLogger,
  normalizePatentNumber,
  parseCitationElement,
  parsePatentHtml,
  parseSearchResultsHtml,
  parseSearchResultsJson,
  resetEgoBrowserCache,
  scrapePatent,
  scraper_class,
  searchPatents,
  systemProxy,
  validatePatentNumber
};
//# sourceMappingURL=index.mjs.map