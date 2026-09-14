import {
  CLICK_DOWNLOAD_PDF_JS,
  escapeTemplateContent,
  FIND_DOWNLOAD_PDF_JS,
  loadPdfLinkExtractJs,
} from "./browserScripts.js";

type DownloadScriptParams = {
  spaceName: string;
  patents: string[];
  outputDir: string;
  pageTimeoutSec: number;
  downloadTimeoutMs: number;
  record: boolean;
  recordPath?: string;
};

/**
 * 构造批量下载的 ego-browser 脚本。
 * 每条专利：打开专利页 → SPA URL 校验 → 提取 CDN PDF 链接 → 拦截下载落盘。
 * 拦截统一走 `downloadVia(trigger)`：注册下载监听后执行触发（优先点页面
 * "Download PDF" 按钮，失效则用 CDN URL 锚点触发），`saveAs` 落盘。
 * 若 harness 不提供 `page.waitForEvent('download')`（较旧 ego lite），返回
 * `status: "fallback"` 与 CDN URL，由 Sati 侧 fetch 兜底。screencast 同理
 * 按能力探测（`typeof page !== 'undefined'`）。
 */
export async function buildDownloadScript(params: DownloadScriptParams): Promise<string> {
  const { spaceName, patents, outputDir, pageTimeoutSec, downloadTimeoutMs, record, recordPath } = params;
  const numsJson = JSON.stringify(patents);
  const outDirJson = JSON.stringify(outputDir);
  const lines: string[] = [];

  lines.push(`const task = await useOrCreateTaskSpace(${JSON.stringify(spaceName)});`);
  lines.push(`const nums = ${numsJson};`);
  lines.push(`const outDir = ${outDirJson};`);
  lines.push("const results = [];");
  lines.push("const canIntercept = typeof page !== 'undefined' && typeof page.waitForEvent === 'function';");
  lines.push("const canRecord = typeof page !== 'undefined' && typeof page.screencast !== 'undefined';");
  lines.push("// 统一下载拦截：监听下载事件 → 执行触发 → saveAs 落盘。");
  lines.push("async function downloadVia(trigger, num, pdfUrl) {");
  lines.push(`  const dlPromise = page.waitForEvent('download', { timeout: ${downloadTimeoutMs} });`);
  lines.push("  await trigger();");
  lines.push("  const download = await dlPromise;");
  lines.push("  const target = outDir + '/' + num + '.pdf';");
  lines.push("  await download.saveAs(target);");
  lines.push("  results.push({ patent: num, status: 'ok', path: target, pdfUrl: pdfUrl });");
  lines.push("  return true;");
  lines.push("}");
  lines.push("// CDN URL 锚点触发下载（按钮 href 为空时的备用触发方式）。");
  lines.push(
    "async function triggerAnchorDownload(url) { await js(\"(() => { const a = document.createElement('a'); a.href = \" + JSON.stringify(url) + \"; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); return true; })()\"); }",
  );
  if (record && recordPath) {
    lines.push("if (canRecord) {");
    lines.push("  try {");
    lines.push(`    await page.screencast.start({ path: ${JSON.stringify(recordPath)}, size: 720 });`);
    lines.push("  } catch (e) {");
    lines.push("    cliLog('EGO_RECORD_FAILED:' + String(e && e.message || e));");
    lines.push("  }");
    lines.push("} else {");
    lines.push(
      "  cliLog('EGO_RECORD_FAILED:record unsupported by this ego-browser build; run `ego-browser upgrade`');",
    );
    lines.push("}");
  }
  lines.push("try {");
  lines.push("  for (let i = 0; i < nums.length; i++) {");
  lines.push("    const num = nums[i];");
  lines.push("    let pdfUrl = null;");
  lines.push("    try {");
  lines.push(
    `      await openOrReuseTab('https://patents.google.com/patent/' + num, { wait: true, timeout: ${pageTimeoutSec} });`,
  );
  lines.push("      let onPage = false;");
  lines.push("      const numLower = num.toLowerCase();");
  lines.push("      for (let attempt = 0; attempt < 3 && !onPage; attempt++) {");
  lines.push("        const href = await js(String.raw`location.href.toLowerCase()`);");
  lines.push("        const marker = '/patent/' + numLower;");
  lines.push("        const idx = href.indexOf(marker);");
  lines.push("        if (idx !== -1) {");
  lines.push("          const after = href.charAt(idx + marker.length);");
  lines.push("          onPage = after === '' || after === '/' || after === '?';");
  lines.push("        }");
  lines.push("        if (!onPage) await wait(1);");
  lines.push("      }");
  lines.push("      if (!onPage) throw new Error('page mismatch');");
  // 先提取 CDN PDF 链接：按钮/锚点两条触发路径与 Sati 侧 fetch 兜底共用。
  lines.push(`      pdfUrl = await js(String.raw\`${escapeTemplateContent(await loadPdfLinkExtractJs())}\`);`);
  lines.push("      if (!pdfUrl) throw new Error('no pdf link');");
  lines.push("      if (!canIntercept) {");
  lines.push(
    "        results.push({ patent: num, status: 'fallback', pdfUrl: pdfUrl, error: 'download interception unavailable; run `ego-browser upgrade`' });",
  );
  lines.push("      } else {");
  // 优先点页面 "Download PDF" 按钮（复用浏览器会话），失败则用 CDN URL 锚点触发。
  lines.push("        try {");
  lines.push(`          const hasBtn = await js(String.raw\`${FIND_DOWNLOAD_PDF_JS}\`);`);
  lines.push("          let saved = false;");
  lines.push("          if (hasBtn) {");
  lines.push("            try {");
  lines.push(`              saved = await downloadVia(() => js(String.raw\`${CLICK_DOWNLOAD_PDF_JS}\`), num, pdfUrl);`);
  lines.push("            } catch (interceptErr) {");
  lines.push(
    "              cliLog('EGO_DOWNLOAD_WARN: button click intercept failed for ' + num + ': ' + interceptErr.message);",
  );
  lines.push("            }");
  lines.push("          }");
  lines.push("          if (!saved) {");
  lines.push("            await downloadVia(() => triggerAnchorDownload(pdfUrl), num, pdfUrl);");
  lines.push("          }");
  lines.push("        } catch (e) {");
  lines.push(
    "          results.push({ patent: num, status: 'fallback', pdfUrl: pdfUrl, error: String(e && e.message || e) });",
  );
  lines.push("        }");
  lines.push("      }");
  lines.push("    } catch (e) {");
  lines.push(
    "      results.push({ patent: num, status: 'fallback', pdfUrl: pdfUrl, error: String(e && e.message || e) });",
  );
  lines.push("    }");
  lines.push("    cliLog('PROGRESS:' + (i + 1) + '/' + nums.length + ':' + num);");
  lines.push("  }");
  if (record) {
    lines.push(
      "  if (canRecord) { try { await page.screencast.stop(); } catch (e) { cliLog('EGO_RECORD_FAILED:' + String(e && e.message || e)); } }",
    );
  }
  lines.push("} finally {");
  lines.push("  await completeTaskSpace(task.id, { keep: false });");
  lines.push("}");
  lines.push("cliLog('EGO_DOWNLOAD_RESULTS:' + JSON.stringify(results));");
  return lines.join("\n");
}
