# -*- coding: utf-8 -*-
"""
CNIPA epub 完整客户端 — 检索、详情、事务查询、PDF下载。

策略: Playwright 仅用于 WAF bypass 获取 session (cookies + CSRF)，
后续所有操作使用 requests (纯HTTP)，参考 XiaoNuo 项目的实现。

PDF下载: 逐页下载 JPEG 图片，再用 Pillow 组装成 PDF（绕过 PDF 端点的 WAF）。

依赖:
  pip install -r tools/requirements-cnipa.txt && python -m playwright install chromium

用法:
  python cnipa_epub_client.py search "人工智能"
  python cnipa_epub_client.py detail CN122072823A
  python cnipa_epub_client.py transaction 202411662208X
  python cnipa_epub_client.py pdf CN122072823A -o /tmp/patent.pdf
"""
from __future__ import annotations

import argparse
import html as html_mod
import io
import json
import logging
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from threading import Lock

import requests
from playwright.sync_api import BrowserContext, Page, sync_playwright

logger = logging.getLogger(__name__)

EPUB_BASE = "http://epub.cnipa.gov.cn"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Session TTL: 服务器端 session 通常在 20-30 分钟过期，保守设 20 分钟
_SESSION_TTL = int(os.environ.get("CNIPA_SESSION_TTL", "1200"))
_WAF_CHECK_INTERVAL = 3.0
_WAF_MAX_WAIT = float(os.environ.get("EPUB_WAF_MAX_WAIT_SEC", "180"))
_PDF_MAX_PAGES = 200

# ---------------------------------------------------------------------------
# 自定义异常
# ---------------------------------------------------------------------------


class CnipaError(Exception):
    """CNIPA 客户端基础异常。"""


class CnipaWafError(CnipaError):
    """WAF 拦截或 session 过期。"""


class CnipaParseError(CnipaError):
    """页面解析失败（可能网站改版）。"""


# ---------------------------------------------------------------------------
# 输入验证
# ---------------------------------------------------------------------------

_PUB_NUMBER_RE = re.compile(r"^(CN|ZL)\d{7,}[A-Z]?$", re.IGNORECASE)
_APP_NUMBER_RE = re.compile(r"^\d{12,13}[A-Z0-9]?$", re.IGNORECASE)


def validate_pub_number(pub_number: str) -> str:
    """验证并标准化公布号。"""
    pub_number = pub_number.strip().upper()
    if not _PUB_NUMBER_RE.match(pub_number):
        raise ValueError(f"无效的公布号格式: {pub_number!r}，期望如 CN122072823A")
    return pub_number


def validate_app_number(app_number: str) -> str:
    """验证并标准化申请号。"""
    app_number = app_number.strip()
    if not _APP_NUMBER_RE.match(app_number):
        raise ValueError(f"无效的申请号格式: {app_number!r}，期望如 202411662208X")
    return app_number


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------


@dataclass
class PatentDetail:
    title: str = ""
    pub_number: str = ""
    pub_date: str = ""
    app_number: str = ""
    app_date: str = ""
    applicant: str = ""
    address: str = ""
    inventor: str = ""
    classification: str = ""
    agency: str = ""
    agent: str = ""
    abstract: str = ""
    first_page_image_url: str = ""
    encrypted_an: str = ""
    pub_type: str = ""


@dataclass
class TransactionRecord:
    index: int = 0
    app_number: str = ""
    date: str = ""
    description: str = ""


@dataclass
class SearchResult:
    keyword: str = ""
    total_hits: int = 0
    patents: list[dict] = field(default_factory=list)


@dataclass
class CnipaSession:
    cookies: dict[str, str] = field(default_factory=dict)
    csrf_token: str = ""
    user_agent: str = UA
    created_at: float = field(default_factory=time.monotonic)

    def is_expired(self) -> bool:
        return time.monotonic() - self.created_at > _SESSION_TTL


# ---------------------------------------------------------------------------
# Session 管理: Playwright 过 WAF → 提取 cookies + CSRF → requests 复用
# ---------------------------------------------------------------------------

_cached_session: CnipaSession | None = None
_session_lock = Lock()


def get_session() -> CnipaSession:
    """获取 CNIPA session。优先用未过期缓存，否则启动 Playwright 过 WAF。"""
    global _cached_session
    with _session_lock:
        if _cached_session and _cached_session.csrf_token and not _cached_session.is_expired():
            logger.debug("复用缓存 session (age=%.0fs)", time.monotonic() - _cached_session.created_at)
            return _cached_session
        logger.info("启动 Playwright 获取新 session...")
        new_session = _fetch_session_via_playwright()
        _cached_session = new_session
        return new_session


def _launch_browser_context(p: sync_playwright) -> tuple:
    """启动浏览器并返回 (browser, context, page)。"""
    headless = os.environ.get("PLAYWRIGHT_HEADED", "").strip() not in ("1", "true", "yes")
    browser = p.chromium.launch(
        headless=headless,
        args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    )
    ctx = browser.new_context(
        user_agent=UA, locale="zh-CN", viewport={"width": 1280, "height": 900},
    )
    page = ctx.new_page()
    return browser, ctx, page


def _wait_for_waf(page: Page, selector: str = "#searchStr", timeout: float | None = None) -> None:
    """等待 WAF 验证完成，目标元素出现。超时抛出 CnipaWafError。"""
    limit = timeout or _WAF_MAX_WAIT
    max_attempts = int(limit / _WAF_CHECK_INTERVAL)
    for attempt in range(max_attempts):
        page.wait_for_timeout(int(_WAF_CHECK_INTERVAL * 1000))
        try:
            if page.query_selector(selector):
                logger.debug("WAF bypass 成功 (attempt=%d, selector=%s)", attempt + 1, selector)
                return
        except Exception:
            logger.debug("页面导航中，继续等待 WAF (attempt=%d)", attempt + 1)
            continue
    raise CnipaWafError(
        f"WAF bypass 失败: {limit}s 内未出现 {selector}。"
        f"尝试 PLAYWRIGHT_HEADED=1 或检查网络。"
    )


def _extract_csrf_token(html: str) -> str:
    """从 HTML 提取并验证 CSRF token。"""
    m = re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]{20,200})"', html)
    if not m:
        return ""
    token = html_mod.unescape(m.group(1))
    # CNIPA token 为 Base64-like 字符串
    if re.match(r"^[A-Za-z0-9+/=._-]{20,200}$", token):
        return token
    logger.warning("CSRF token 格式异常: %s...", token[:20])
    return ""


def _extract_session_from_context(ctx: BrowserContext, page: Page) -> CnipaSession:
    """从 Playwright context 提取 session 信息。"""
    cookies = {c["name"]: c["value"] for c in ctx.cookies()}
    html = page.content()
    csrf = _extract_csrf_token(html)
    if not csrf:
        logger.warning("未找到 CSRF token，后续 POST 请求可能失败")
    return CnipaSession(cookies=cookies, csrf_token=csrf)


def _fetch_session_via_playwright() -> CnipaSession:
    """通过 Playwright 访问首页过 WAF，提取 session。"""
    with sync_playwright() as p:
        browser, ctx, page = _launch_browser_context(p)
        try:
            page.goto(f"{EPUB_BASE}/", wait_until="load", timeout=120_000)
            _wait_for_waf(page)
            session = _extract_session_from_context(ctx, page)
            logger.info("Session 获取成功 (cookies=%d, csrf=%s...)",
                        len(session.cookies), session.csrf_token[:8] if session.csrf_token else "NONE")
            return session
        finally:
            ctx.close()
            browser.close()


def _http_client(session: CnipaSession) -> requests.Session:
    """创建带 session 信息的 requests 客户端。"""
    s = requests.Session()
    s.headers.update({
        "User-Agent": session.user_agent,
        "Cookie": "; ".join(f"{k}={v}" for k, v in session.cookies.items()),
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": f"{EPUB_BASE}/",
    })
    return s


def clear_session() -> None:
    """强制清除缓存 session，下次 get_session() 会重新获取。"""
    global _cached_session
    with _session_lock:
        _cached_session = None
        logger.info("Session 已清除")


# ---------------------------------------------------------------------------
# HTML 解析工具
# ---------------------------------------------------------------------------


def _extract_field(html: str, label: str) -> str:
    """从详情页 HTML 的 <dt>/<dd> 结构中提取字段值。"""
    escaped = re.escape(label)
    m = re.search(
        rf'<dt[^>]*>[^<]*{escaped}[^<]*</dt>\s*<dd[^>]*>([^<]+)</dd>',
        html, re.I | re.S,
    )
    return html_mod.unescape(m.group(1).strip()) if m else ""


def _extract_encoded_an(html: str) -> str:
    """提取加密的申请号（用于 zl_xm 函数）。"""
    m = re.search(r"zl_xm\('([^']+)',\s*'[^']*',\s*'[^']*'\)", html)
    return html_mod.unescape(m.group(1)) if m else ""


def _extract_first_page_image(html: str) -> str:
    """提取专利首页图片 URL。"""
    m = re.search(r'<img[^>]+src="([^"]*\/imgs\/[^"]*(?:FMGB|FMSQ|FMZL)[^"]*\.jpg)"', html)
    if not m:
        return ""
    src = m.group(1)
    if src.startswith("../"):
        src = "/" + src[3:]
    if not src.startswith("http"):
        src = EPUB_BASE + src
    return src


# ---------------------------------------------------------------------------
# 1. 检索
# ---------------------------------------------------------------------------


def search(keyword: str) -> SearchResult:
    """关键词/申请号/公布号检索。"""
    session = get_session()
    client = _http_client(session)

    data = {
        "searchStr": keyword,
        "__RequestVerificationToken": session.csrf_token,
    }
    resp = client.post(f"{EPUB_BASE}/Dxb/IndexQuery", data=data, timeout=30)

    if resp.status_code != 200 or len(resp.text) < 1000:
        logger.warning("HTTP 检索被拦截 (status=%d, len=%d)，回退到 Playwright",
                       resp.status_code, len(resp.text))
        return _search_via_playwright(keyword)

    return _parse_search_html(keyword, resp.text)


def _search_via_playwright(keyword: str) -> SearchResult:
    """Playwright 搜索回退。"""
    from cnipa_epub_crawler import search_epub_keyword
    from cnipa_epub_parse import hits_to_jsonable

    _html, hits = search_epub_keyword(keyword)
    patents = hits_to_jsonable(hits)
    return SearchResult(keyword=keyword, total_hits=len(patents), patents=patents)


def _parse_search_html(keyword: str, html: str) -> SearchResult:
    from cnipa_epub_parse import parse_search_result_html, hits_to_jsonable

    hits = parse_search_result_html(html)
    patents = hits_to_jsonable(hits)
    return SearchResult(keyword=keyword, total_hits=len(patents), patents=patents)


# ---------------------------------------------------------------------------
# 2. 专利详情
# ---------------------------------------------------------------------------


def get_detail(pub_number: str) -> PatentDetail:
    """获取专利详情。"""
    pub_number = validate_pub_number(pub_number)
    session = get_session()
    client = _http_client(session)

    resp = client.get(f"{EPUB_BASE}/patent/{pub_number}", timeout=15)
    if resp.status_code != 200 or "申请号" not in resp.text:
        logger.warning("HTTP 详情被拦截 (status=%d)，回退到 Playwright", resp.status_code)
        return _detail_via_playwright(pub_number)

    html = resp.text
    title_m = re.search(r'<h2[^>]*class="title"[^>]*>\s*(.*?)\s*</h2>', html, re.S)
    title = html_mod.unescape(re.sub(r"<[^>]+>", "", title_m.group(1)).strip()) if title_m else ""

    return PatentDetail(
        title=title,
        pub_number=_extract_field(html, "申请公布号") or _extract_field(html, "授权公告号"),
        pub_date=_extract_field(html, "申请公布日") or _extract_field(html, "授权公告日"),
        app_number=_extract_field(html, "申请号"),
        app_date=_extract_field(html, "申请日"),
        applicant=_extract_field(html, "申请人"),
        address=_extract_field(html, "地址"),
        inventor=_extract_field(html, "发明人"),
        classification=_extract_field(html, "分类号"),
        agency=_extract_field(html, "专利代理机构"),
        agent=_extract_field(html, "专利代理师"),
        abstract=_extract_field(html, "摘要"),
        first_page_image_url=_extract_first_page_image(html),
        encrypted_an=_extract_encoded_an(html),
        pub_type=_parse_pub_type(html),
    )


def _parse_pub_type(html: str) -> str:
    if "发明专利申请" in html or "发明公布" in html:
        return "3"
    if "发明授权" in html:
        return "4"
    if "实用新型" in html:
        return "6"
    if "外观设计" in html:
        return "9"
    return "3"


def _detail_via_playwright(pub_number: str) -> PatentDetail:
    """Playwright 详情回退。"""
    with sync_playwright() as p:
        browser, ctx, page = _launch_browser_context(p)
        try:
            page.goto(f"{EPUB_BASE}/", wait_until="load", timeout=120_000)
            _wait_for_waf(page)

            page.goto(f"{EPUB_BASE}/patent/{pub_number}", wait_until="domcontentloaded", timeout=120_000)
            page.wait_for_timeout(5000)
            html = page.content()

            # 更新全局 session
            global _cached_session
            with _session_lock:
                _cached_session = _extract_session_from_context(ctx, page)

            title_el = page.query_selector("h2.title")
            title = title_el.inner_text().strip() if title_el else ""

            def _dd_text(label: str) -> str:
                for dt in page.query_selector_all("dt"):
                    if dt.inner_text().strip().rstrip("：:") == label:
                        dd_el = dt.evaluate_handle("el => el.nextElementSibling").as_element()
                        return dd_el.inner_text().strip() if dd_el else ""
                return ""

            img = page.query_selector(".zs_pic img[src]")
            img_url = img.get_attribute("src") or "" if img else ""

            return PatentDetail(
                title=title,
                pub_number=_dd_text("申请公布号") or _dd_text("授权公告号"),
                pub_date=_dd_text("申请公布日") or _dd_text("授权公告日"),
                app_number=_dd_text("申请号"),
                app_date=_dd_text("申请日"),
                applicant=_dd_text("申请人"),
                address=_dd_text("地址"),
                inventor=_dd_text("发明人"),
                classification=_dd_text("分类号"),
                agency=_dd_text("专利代理机构"),
                agent=_dd_text("专利代理师"),
                abstract=_dd_text("摘要"),
                first_page_image_url=img_url,
                encrypted_an=_extract_encoded_an(html),
                pub_type=_parse_pub_type(html),
            )
        finally:
            ctx.close()
            browser.close()


# ---------------------------------------------------------------------------
# 3. 事务数据查询 (XiaoNuo 方式: POST /SW/SWPageQuery)
# ---------------------------------------------------------------------------


def search_transactions(app_number: str, *, page_num: int = 1, page_size: int = 100) -> list[TransactionRecord]:
    """查询指定申请号的事务数据。

    app_number: 13位申请号纯文本，如 202411662208X
    """
    app_number = validate_app_number(app_number)
    session = get_session()
    client = _http_client(session)

    data = {
        "searchSwInfo.PubType": "3",
        "searchSwInfo.An": app_number,
        "searchSwInfo.SwType": "",
        "searchSwInfo.SwPubdate": "",
        "searchSwInfo.SwInfo": "",
        "trsSql": "",
        "pageModel.pageNum": str(page_num),
        "pageModel.pageSize": str(page_size),
        "sortFiled": "ggr_desc",
        "searchAfter": "",
        "__RequestVerificationToken": session.csrf_token,
    }

    resp = client.post(f"{EPUB_BASE}/SW/SWPageQuery", data=data, timeout=30)
    if resp.status_code != 200:
        logger.warning("HTTP 事务查询被拦截 (status=%d)，回退到 Playwright", resp.status_code)
        return _transactions_via_playwright(app_number)

    return _parse_transaction_html(resp.text)


def get_patent_transactions(pub_number: str) -> list[TransactionRecord]:
    """通过公布号查询事务数据（先获取申请号再查）。"""
    detail = get_detail(pub_number)
    if not detail.app_number:
        logger.warning("公布号 %s 未获取到申请号，无法查询事务", pub_number)
        return []
    return search_transactions(detail.app_number)


def _parse_transaction_html(html: str) -> list[TransactionRecord]:
    records: list[TransactionRecord] = []
    row_re = re.compile(
        r'<tr[^>]*>[\s\S]*?<td[^>]*>(\d+)</td>[\s\S]*?<td[^>]*>(\d{13}X?)</td>'
        r'[\s\S]*?<td[^>]*>(\d{4}\.\d{2}\.\d{2})</td>[\s\S]*?<td[^>]*>([^<]+)</td>',
    )
    for m in row_re.finditer(html):
        records.append(TransactionRecord(
            index=int(m.group(1)),
            app_number=m.group(2),
            date=m.group(3),
            description=m.group(4).strip(),
        ))

    # 回退: 通用表格解析
    if not records:
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.I | re.S):
            cells = [
                re.sub(r"<[^>]+>", "", c).strip()
                for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.I | re.S)
            ]
            if len(cells) >= 4 and cells[0].isdigit():
                records.append(TransactionRecord(
                    index=int(cells[0]),
                    app_number=cells[1],
                    date=cells[2],
                    description=cells[3],
                ))
    return records


def _transactions_via_playwright(app_number: str) -> list[TransactionRecord]:
    """Playwright 事务查询回退。"""
    with sync_playwright() as p:
        browser, ctx, page = _launch_browser_context(p)
        try:
            page.goto(f"{EPUB_BASE}/", wait_until="load", timeout=120_000)
            _wait_for_waf(page)

            page.goto(f"{EPUB_BASE}/SW", wait_until="domcontentloaded", timeout=120_000)
            _wait_for_waf(page, selector="#an")

            page.fill("#an", app_number)
            with page.expect_navigation(timeout=120_000, wait_until="domcontentloaded"):
                page.evaluate("document.getElementById('flzt').submit()")
            page.wait_for_timeout(5000)

            html = page.content()
            return _parse_transaction_html(html)
        finally:
            ctx.close()
            browser.close()


# ---------------------------------------------------------------------------
# 4. PDF 下载 (XiaoNuo 方式: 逐页 JPEG → Pillow 组装 PDF)
# ---------------------------------------------------------------------------


def _scan_page_urls(client: requests.Session, first_url: str) -> list[str]:
    """从首页图片 URL 推断后续页面 URL 列表。"""
    urls = [first_url]
    dir_match = re.search(r"/(\d+)/([^/]+\.jpg)$", first_url)
    if not dir_match:
        return urls

    start_dir = int(dir_match.group(1))
    image_name = dir_match.group(2)
    consecutive_miss = 0

    for p_num in range(1, _PDF_MAX_PAGES):
        page_dir = str(start_dir + p_num).zfill(6)
        next_url = re.sub(
            r"/\d+/([^/]+\.jpg)$",
            f"/{page_dir}/{image_name}",
            first_url,
        )
        try:
            check = client.head(next_url, timeout=10, allow_redirects=True)
            if check.status_code == 200 and "image" in check.headers.get("content-type", ""):
                urls.append(next_url)
                consecutive_miss = 0
            else:
                consecutive_miss += 1
                if consecutive_miss >= 3:
                    break
        except requests.RequestException:
            consecutive_miss += 1
            if consecutive_miss >= 3:
                break

    logger.info("扫描到 %d 页图片 URL", len(urls))
    return urls


def download_pdf(pub_number: str, save_path: str | Path) -> Path:
    """下载专利 PDF。

    策略: 从详情页获取首页图片 URL → 逐页扫描 JPEG → Pillow 组装 PDF。
    这绕过了 PDF 端点的 WAF 保护。
    """
    pub_number = validate_pub_number(pub_number)
    save_path = Path(save_path)
    save_path.parent.mkdir(parents=True, exist_ok=True)

    detail = get_detail(pub_number)
    if not detail.first_page_image_url:
        raise CnipaError(f"无法获取 {pub_number} 的首页图片 URL")

    session = get_session()
    client = _http_client(session)
    # 图片请求不需要 form content-type
    client.headers.pop("Content-Type", None)

    # 扫描页面 URL
    image_urls = _scan_page_urls(client, detail.first_page_image_url)

    # 下载图片
    page_images: list[bytes] = []
    for i, url in enumerate(image_urls):
        try:
            resp = client.get(url, timeout=15)
            if resp.status_code == 200 and len(resp.content) > 500:
                page_images.append(resp.content)
            else:
                logger.debug("页面 %d 下载异常 (status=%d, size=%d)", i, resp.status_code, len(resp.content))
        except requests.RequestException as e:
            logger.warning("页面 %d 下载失败: %s", i, e)

    if not page_images:
        raise CnipaError(f"未能下载任何专利页面图片: {pub_number}")

    # Pillow 组装 PDF，显式管理资源
    from PIL import Image

    images: list[Image.Image] = []
    buffers: list[io.BytesIO] = []
    try:
        for img_bytes in page_images:
            buf = io.BytesIO(img_bytes)
            buffers.append(buf)
            try:
                img = Image.open(buf)
                img.load()  # 立即解码，后续 buf.close() 安全
                if img.mode != "RGB":
                    img = img.convert("RGB")
                images.append(img)
            except Exception as e:
                logger.warning("图片解码失败: %s", e)

        if not images:
            raise CnipaError(f"无法解码任何专利页面图片: {pub_number}")

        first = images[0]
        rest = images[1:] if len(images) > 1 else []
        first.save(str(save_path), "PDF", save_all=True, append_images=rest, resolution=150)
        logger.info("PDF 已保存: %s (%d 页, %.1f KB)", save_path, len(images), save_path.stat().st_size / 1024)
    finally:
        for img in images:
            img.close()
        for buf in buffers:
            buf.close()

    return save_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _ensure_utf8() -> None:
    for s in (sys.stdout, sys.stderr):
        try:
            if hasattr(s, "reconfigure"):
                s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _setup_logging() -> None:
    level_name = os.environ.get("CNIPA_LOG", "WARNING").upper()
    level = getattr(logging, level_name, logging.WARNING)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


def main() -> int:
    _ensure_utf8()
    _setup_logging()
    os.environ.setdefault("EPUB_WAF_MAX_WAIT_SEC", "180")

    parser = argparse.ArgumentParser(description="CNIPA epub 专利工具")
    sub = parser.add_subparsers(dest="cmd")

    p_search = sub.add_parser("search", help="专利检索")
    p_search.add_argument("keyword")

    p_detail = sub.add_parser("detail", help="专利详情")
    p_detail.add_argument("pub_number")

    p_trans = sub.add_parser("transaction", help="事务数据查询(申请号)")
    p_trans.add_argument("app_number")

    p_trans2 = sub.add_parser("patent-transactions", help="事务数据查询(公布号)")
    p_trans2.add_argument("pub_number")

    p_pdf = sub.add_parser("pdf", help="下载PDF")
    p_pdf.add_argument("pub_number")
    p_pdf.add_argument("-o", "--output", default="")

    args = parser.parse_args()
    if not args.cmd:
        parser.print_help()
        return 1

    def _json(obj: object) -> str:
        return json.dumps(
            obj if isinstance(obj, list) else asdict(obj),
            ensure_ascii=False, indent=2, default=str,
        )

    try:
        if args.cmd == "search":
            r = search(args.keyword)
            print(f"EPUB_HITS_JSON: {_json(r.patents)}")
            print(f"EPUB_NOTE: keyword={args.keyword!r} hits={r.total_hits}", file=sys.stderr)

        elif args.cmd == "detail":
            d = get_detail(args.pub_number)
            print(_json(d))

        elif args.cmd == "transaction":
            records = search_transactions(args.app_number)
            print(_json(records))
            print(f"EPUB_NOTE: transactions={len(records)}", file=sys.stderr)

        elif args.cmd == "patent-transactions":
            records = get_patent_transactions(args.pub_number)
            print(_json(records))
            print(f"EPUB_NOTE: transactions={len(records)}", file=sys.stderr)

        elif args.cmd == "pdf":
            out = args.output or f"/tmp/{args.pub_number}.pdf"
            path = download_pdf(args.pub_number, out)
            size_kb = path.stat().st_size / 1024
            print(f"PDF saved: {path} ({size_kb:.1f} KB)", file=sys.stderr)
            print(f"EPUB_PDF_PATH: {path}")

        return 0
    except CnipaError as e:
        print(f"CNIPA_EPUB_ERROR: {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"INVALID_INPUT: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        logger.exception("未预期的错误")
        print(f"CNIPA_EPUB_ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
