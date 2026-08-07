#!/usr/bin/env node

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
var TimeoutError = class extends NuoPatentError {
  /** 超时阈值（毫秒） */
  timeoutMs;
  constructor(message, timeoutMs, patentNumber) {
    super(message, patentNumber);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
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
      const output2 = execSync("scutil --proxy", { encoding: "utf8", timeout: 3e3 });
      const enabled = output2.match(/HTTPSEnable\s*:\s*1/);
      const host = output2.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = output2.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
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

// src/cli.ts
var HELP = `nuo-patent v2.2.0 \xB7 \u5C0F\u8BFA\u667A\u80FD\u4F53\u4E13\u5229\u5DE5\u5177\u5305 CLI

\u7528\u6CD5:
  nuo-patent <command> [options]

\u547D\u4EE4:
  scrape <patent>         \u6293\u53D6\u4E13\u5229\u5143\u6570\u636E\uFF0C\u8F93\u51FA ScrapeResult JSON
  validate <patent>       \u6821\u9A8C\u5E76\u89C4\u8303\u5316\u4E13\u5229\u53F7
  download <patent...>    \u4E0B\u8F7D PDF\uFF0C\u8F93\u51FA DownloadResult[] JSON
  legal-status <patent...> \u67E5\u8BE2\u6CD5\u5F8B\u72B6\u6001\uFF0C\u8F93\u51FA JSON

\u9009\u9879\uFF08scrape\uFF09:
  --timeout <ms>          \u8BF7\u6C42\u8D85\u65F6\u6BEB\u79D2\u6570\uFF08\u9ED8\u8BA4 30000\uFF09
  --no-abstract           \u4E0D\u63D0\u53D6\u6458\u8981
  --no-legal              \u4E0D\u63D0\u53D6\u6CD5\u5F8B\u72B6\u6001

\u9009\u9879\uFF08download\uFF09:
  --output <dir>          \u8F93\u51FA\u76EE\u5F55\uFF08\u9ED8\u8BA4 ./patent_pdfs\uFF09
  --max-workers <n>       \u6700\u5927\u5E76\u53D1\u6570\uFF08\u9ED8\u8BA4 4\uFF09

\u9009\u9879\uFF08legal-status\uFF09:
  --max-concurrency <n>   \u6700\u5927\u5E76\u53D1\u6570\uFF08\u9ED8\u8BA4 4\uFF09

\u901A\u7528:
  --pretty                \u683C\u5F0F\u5316 JSON \u8F93\u51FA
  --help, -h              \u663E\u793A\u6B64\u5E2E\u52A9

\u793A\u4F8B:
  nuo-patent scrape US11452699B2 --pretty
  nuo-patent validate "US 11452699 B2"
  nuo-patent download CN201559953U CN220010945U --output /tmp/pdfs
  nuo-patent legal-status US11452699B2 US2668287A

\u9000\u51FA\u7801:
  0  \u6210\u529F
  1  \u8C03\u7528\u5931\u8D25\uFF08\u8BE6\u60C5\u89C1 stderr \u6216\u8FD4\u56DE JSON \u4E2D\u7684 error \u5B57\u6BB5\uFF09
`;
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let command = "";
  let pretty = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (arg === "--pretty") {
      pretty = true;
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key.startsWith("no-")) {
        flags[key.slice(3)] = false;
        i++;
        continue;
      }
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        const nextVal = argv[i + 1];
        const num = Number(nextVal);
        flags[key] = isNaN(num) ? nextVal : num;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
      continue;
    }
    if (!command) {
      command = arg;
      i++;
      continue;
    }
    positional.push(arg);
    i++;
  }
  return { command, positional, flags, pretty };
}
function output(data, pretty) {
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  process.stdout.write(json + "\n");
}
function die(message, code = 1) {
  process.stderr.write(`[nuo-patent] ${message}
`);
  process.exit(code);
}
async function cmdScrape(args) {
  if (args.positional.length === 0) {
    die("scrape \u9700\u8981 1 \u4E2A\u4E13\u5229\u53F7\u53C2\u6570", 1);
  }
  const patentNumber = args.positional[0];
  const options = {};
  if (typeof args.flags["timeout"] === "number") {
    options.timeout = args.flags["timeout"];
  }
  if (args.flags["abstract"] === false) {
    options.returnAbstract = false;
  }
  if (args.flags["legal"] === false) {
    options.returnLegal = false;
  }
  const result = await scrapePatent(patentNumber, options);
  output(result, args.pretty);
  if (!result.success) {
    process.exit(1);
  }
}
async function cmdValidate(args) {
  if (args.positional.length === 0) {
    die("validate \u9700\u8981 1 \u4E2A\u4E13\u5229\u53F7\u53C2\u6570", 1);
  }
  const result = validatePatentNumber(args.positional[0]);
  output(result, args.pretty);
  if (!result.valid) {
    process.exit(1);
  }
}
async function cmdDownload(args) {
  if (args.positional.length === 0) {
    die("download \u9700\u8981\u81F3\u5C11 1 \u4E2A\u4E13\u5229\u53F7\u53C2\u6570", 1);
  }
  const outputDir = typeof args.flags["output"] === "string" ? args.flags["output"] : "./patent_pdfs";
  const maxWorkers = typeof args.flags["max-workers"] === "number" ? args.flags["max-workers"] : 4;
  const downloader = new PDFDownloader(outputDir, void 0, maxWorkers);
  const results = await downloader.downloadBatchWithResults(args.positional, {
    maxWorkers
  });
  output(results, args.pretty);
  const hasFailure = results.some((r) => !r.success);
  if (hasFailure) {
    process.exit(1);
  }
}
async function cmdLegalStatus(args) {
  if (args.positional.length === 0) {
    die("legal-status \u9700\u8981\u81F3\u5C11 1 \u4E2A\u4E13\u5229\u53F7\u53C2\u6570", 1);
  }
  const maxConcurrency = typeof args.flags["max-concurrency"] === "number" ? args.flags["max-concurrency"] : 4;
  const checker = new LegalStatusChecker();
  const results = await checker.checkBatch(args.positional, { maxConcurrency });
  output(results, args.pretty);
  const hasError = Object.values(results).some((r) => r.error);
  if (hasError) {
    process.exit(1);
  }
}
async function main() {
  console.log = (...args2) => process.stderr.write(args2.map(String).join(" ") + "\n");
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const args = parseArgs(rawArgs);
  switch (args.command) {
    case "scrape":
      return await cmdScrape(args);
    case "validate":
      return await cmdValidate(args);
    case "download":
      return await cmdDownload(args);
    case "legal-status":
      return await cmdLegalStatus(args);
    default:
      die(`\u672A\u77E5\u547D\u4EE4: ${args.command}
\u4F7F\u7528 --help \u67E5\u770B\u53EF\u7528\u547D\u4EE4`, 1);
  }
}
main().catch((err) => {
  die(err instanceof Error ? err.message : String(err), 1);
});
//# sourceMappingURL=cli.mjs.map