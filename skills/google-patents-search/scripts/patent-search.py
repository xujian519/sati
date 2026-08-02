#!/usr/bin/env python3
"""
Google Patents 检索工具
支持关键词、布尔检索式、专利号、申请人+日期等多种检索方式
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import sync_playwright


# 默认配置
DEFAULT_PROXY = "http://127.0.0.1:9981"
DEFAULT_OUTPUT_DIR = Path(os.getenv('PATENT_SEARCH_OUTPUT', str(Path.home() / 'Documents' / 'Patent-Search')))
GOOGLE_PATENTS_SEARCH_URL = "https://patents.google.com/?q={query}"
GOOGLE_PATENTS_DETAIL_URL = "https://patents.google.com/patent/{patent_id}/en"


class PatentSearcher:
    """Google Patents 检索器"""
    
    def __init__(self, proxy: str = DEFAULT_PROXY, headless: bool = True):
        self.proxy = proxy
        self.headless = headless
        self.browser = None
        self.page = None
    
    def start(self):
        """启动浏览器"""
        self.playwright = sync_playwright().start()
        proxy_config = {"server": self.proxy} if self.proxy else None
        self.browser = self.playwright.chromium.launch(
            headless=self.headless,
            proxy=proxy_config
        )
        self.page = self.browser.new_page()
    
    def close(self):
        """关闭浏览器"""
        if self.browser:
            self.browser.close()
        if self.playwright:
            self.playwright.stop()
    
    def search(self, query: str, limit: int = 20) -> list:
        """
        执行搜索
        
        Args:
            query: 搜索查询（关键词、布尔检索式、专利号等）
            limit: 返回结果数量限制
        
        Returns:
            搜索结果列表
        """
        url = GOOGLE_PATENTS_SEARCH_URL.format(query=quote(query))
        
        self.page.goto(url, timeout=60000, wait_until="domcontentloaded")
        
        # 等待搜索结果加载
        try:
            self.page.wait_for_selector('article.result', timeout=20000)
        except:
            print("⚠️ 未找到搜索结果")
            return []
        
        # 滚动加载更多结果
        results = []
        last_count = 0
        scroll_attempts = 0
        max_scroll_attempts = 10
        
        while len(results) < limit and scroll_attempts < max_scroll_attempts:
            results = self.page.query_selector_all('article.result')
            
            if len(results) >= limit:
                break
            
            if len(results) == last_count:
                scroll_attempts += 1
            else:
                scroll_attempts = 0
                last_count = len(results)
            
            # 滚动到页面底部
            self.page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
            time.sleep(1)
        
        # 解析结果
        parsed_results = []
        for r in results[:limit]:
            result = self._parse_search_result(r)
            if result:
                parsed_results.append(result)
        
        return parsed_results
    
    def _parse_search_result(self, element) -> dict:
        """解析单个搜索结果"""
        result = {}
        
        # 标题
        title_el = element.query_selector('.result-title h3')
        result['title'] = title_el.inner_text().strip() if title_el else ''
        
        # 公开号（从 data-result 属性提取）
        link_el = element.query_selector('.result-title')
        if link_el:
            data_result = link_el.get_attribute('data-result') or ''
            result['publication_number'] = data_result.replace('patent/', '').replace('/en', '')
            result['url'] = f"https://patents.google.com/{data_result}"
        
        # 元数据（包含发明人、申请人等）
        metadata_el = element.query_selector('h4.metadata')
        if metadata_el:
            result['metadata_raw'] = metadata_el.inner_text().strip()
        
        return result if result.get('publication_number') else None
    
    def get_patent_detail(self, patent_id: str) -> dict:
        """
        获取专利详细信息
        
        Args:
            patent_id: 专利号（如 US11739244B2）
        
        Returns:
            专利详细信息字典
        """
        url = GOOGLE_PATENTS_DETAIL_URL.format(patent_id=patent_id)
        
        self.page.goto(url, timeout=60000, wait_until="domcontentloaded")
        
        try:
            self.page.wait_for_selector('dl', timeout=20000)
        except:
            return {'error': f'无法加载专利页面: {patent_id}'}
        
        # 通过 meta 标签提取信息
        def get_meta(name):
            el = self.page.query_selector(f'meta[name="{name}"]')
            return el.get_attribute('content') if el else None
        
        data = {
            'publication_number': patent_id,
            'title': get_meta('DC.title'),
            'pdf_url': get_meta('citation_pdf_url'),
            'application_number': get_meta('citation_patent_application_number'),
            'citation_patent_number': get_meta('citation_patent_number'),
            'google_url': url,
        }
        
        # 清理标题
        if data['title']:
            data['title'] = ' '.join(data['title'].split())
        
        # 公开日期
        date_els = self.page.query_selector_all('meta[name="DC.date"]')
        for el in date_els:
            scheme = el.get_attribute('scheme')
            if scheme == 'issue':
                data['publication_date'] = el.get_attribute('content')
        
        # 优先权日
        for el in date_els:
            scheme = el.get_attribute('scheme')
            if scheme == 'dateSubmitted':
                data['priority_date'] = el.get_attribute('content')
        
        # 发明人
        data['inventors'] = []
        inventor_els = self.page.query_selector_all('meta[name="DC.contributor"]')
        for el in inventor_els:
            if el.get_attribute('scheme') == 'inventor':
                data['inventors'].append(el.get_attribute('content'))
        
        # 摘要
        abstract = get_meta('DC.description')
        if abstract:
            data['abstract'] = ' '.join(abstract.split())
        
        # 申请人（从 dl/dt/dd 结构提取）
        dts = self.page.query_selector_all('dt')
        for dt in dts:
            dt_text = dt.inner_text().strip().lower()
            if 'assignee' in dt_text or '申请人' in dt_text:
                dd = dt.evaluate_handle('el => el.nextElementSibling')
                if dd.as_element():
                    data['assignee'] = dd.as_element().inner_text().strip()
                    break
        
        return data
    
    def search_with_details(self, query: str, limit: int = 20) -> list:
        """
        搜索并获取详细信息
        
        Args:
            query: 搜索查询
            limit: 结果数量限制
        
        Returns:
            包含详细信息的搜索结果列表
        """
        # 先执行搜索
        results = self.search(query, limit)
        
        # 获取每个结果的详细信息
        for i, result in enumerate(results):
            print(f"  获取详情 {i+1}/{len(results)}: {result['publication_number']}")
            detail = self.get_patent_detail(result['publication_number'])
            result.update(detail)
            time.sleep(0.5)  # 避免请求过快
        
        return results


def format_markdown(results: list, query: str) -> str:
    """将结果格式化为 Markdown"""
    lines = [
        f"# 专利检索结果",
        f"",
        f"**检索词**: {query}",
        f"**检索时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"**结果数量**: {len(results)}",
        f"",
        "---",
        f"",
    ]
    
    for i, r in enumerate(results, 1):
        lines.append(f"## {i}. {r.get('publication_number', 'N/A')}")
        lines.append(f"")
        
        if r.get('title'):
            lines.append(f"**标题**: {r['title']}")
            lines.append(f"")
        
        if r.get('assignee'):
            lines.append(f"**申请人**: {r['assignee']}")
            lines.append(f"")
        
        if r.get('inventors'):
            lines.append(f"**发明人**: {', '.join(r['inventors'])}")
            lines.append(f"")
        
        if r.get('publication_date'):
            lines.append(f"**公开日期**: {r['publication_date']}")
            lines.append(f"")
        
        if r.get('application_number'):
            lines.append(f"**申请号**: {r['application_number']}")
            lines.append(f"")
        
        if r.get('abstract'):
            abstract = r['abstract'][:500] + '...' if len(r['abstract']) > 500 else r['abstract']
            lines.append(f"**摘要**: {abstract}")
            lines.append(f"")
        
        lines.append(f"**链接**:")
        lines.append(f"- [Google Patents]({r.get('google_url', '')})")
        if r.get('pdf_url'):
            lines.append(f"- [PDF原文]({r['pdf_url']})")
        lines.append(f"")
        lines.append(f"---")
        lines.append(f"")
    
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(
        description='Google Patents 专利检索工具',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 关键词检索
  %(prog)s "phase change material"
  
  # 布尔检索式
  %(prog)s "(phase change OR PCM) AND (thermal OR heat)"
  
  # 专利号检索
  %(prog)s "US11739244B2"
  
  # 申请人+日期
  %(prog)s "assignee:(Samsung) after:20200101"
  
  # 指定结果数量
  %(prog)s "battery technology" --limit 30
  
  # 不获取详细信息（更快）
  %(prog)s "solar panel" --no-details
"""
    )
    
    parser.add_argument(
        'query',
        help='检索词或检索式'
    )
    parser.add_argument(
        '--limit', '-l',
        type=int,
        default=20,
        help='返回结果数量（默认: 20）'
    )
    parser.add_argument(
        '--output', '-o',
        help='输出文件路径（默认: 自动生成到专利检索目录）'
    )
    parser.add_argument(
        '--proxy',
        default=DEFAULT_PROXY,
        help=f'代理地址（默认: {DEFAULT_PROXY}）'
    )
    parser.add_argument(
        '--no-proxy',
        action='store_true',
        help='不使用代理'
    )
    parser.add_argument(
        '--no-details',
        action='store_true',
        help='不获取详细信息（只返回搜索结果）'
    )
    parser.add_argument(
        '--json',
        action='store_true',
        help='输出 JSON 格式'
    )
    
    args = parser.parse_args()
    
    proxy = None if args.no_proxy else args.proxy
    
    # 创建搜索器
    searcher = PatentSearcher(proxy=proxy)
    
    try:
        print(f"🔍 检索: {args.query}")
        searcher.start()
        
        if args.no_details:
            print("获取搜索结果...")
            results = searcher.search(args.query, args.limit)
        else:
            print("获取搜索结果及详情...")
            results = searcher.search_with_details(args.query, args.limit)
        
        print(f"\n✅ 找到 {len(results)} 个结果")
        
        # 输出
        if args.json:
            output = json.dumps(results, ensure_ascii=False, indent=2)
            print(output)
        else:
            markdown = format_markdown(results, args.query)
            
            if args.output:
                output_path = Path(args.output)
            else:
                # 自动生成输出路径
                date_dir = DEFAULT_OUTPUT_DIR / datetime.now().strftime('%Y-%m-%d')
                date_dir.mkdir(parents=True, exist_ok=True)
                
                # 生成文件名（从查询词）
                safe_query = re.sub(r'[^\w\s-]', '', args.query)[:30]
                safe_query = re.sub(r'[\s]+', '_', safe_query)
                timestamp = datetime.now().strftime('%H%M%S')
                output_path = date_dir / f"{safe_query}_{timestamp}.md"
            
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(markdown)
            
            print(f"\n📄 结果已保存到: {output_path}")
        
    except Exception as e:
        print(f"❌ 错误: {e}", file=sys.stderr)
        sys.exit(1)
    
    finally:
        searcher.close()


if __name__ == '__main__':
    main()
