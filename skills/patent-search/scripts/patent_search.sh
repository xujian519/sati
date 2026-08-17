#!/bin/bash
# 专利检索脚本
# 使用 PostgreSQL 数据库 patent_db 进行专利检索
# 统一引用 ~/.infra/infra.env 配置
# 安全（P0-01）：所有用户输入经 psql -v 预定义变量 + SQL 内 :'var' 引号参数化，
# 禁止字符串插值拼 SQL；数值参数在入口做白名单校验。

set -e

# DEPRECATION（P3-05）：本脚本将于 6 个月后移除，请改用 TS 版 CLI：
#   sati patent-search [选项]
# 参数与输出格式保持一致；--json 差异见 sati patent-search --help。
echo "警告: patent_search.sh 已弃用，将于 6 个月后移除，请改用 'sati patent-search'。" >&2

# 加载统一基础设施配置
source ~/.infra/infra.env

# 数据库连接配置（通过 PgBouncer 连接池）
PSQL="/Library/PostgreSQL/17/bin/psql"
DB_HOST="${PGHOST:-localhost}"
DB_PORT="${PG_ATHENA_PORT:-${PGPORT:-5433}}"
DB_USER="${PGUSER:-xujian}"
DB_NAME="patent_db"

# 默认参数
LIMIT=20
OUTPUT_FORMAT="table"

# psql 预定义变量收集（P0-01：参数解析时收集，SQL 内以 :'var' / :var 引用；
# 未使用的变量无害，execute_query 统一透传）
PSQL_VARS=(-v limit_num="$LIMIT")

# 帮助信息
show_help() {
    echo "专利检索工具 - 从 patent_db 检索专利数据"
    echo ""
    echo "用法: $0 [选项]"
    echo ""
    echo "检索选项:"
    echo "  --keyword <关键词>      关键词检索（专利名称、摘要，ILIKE 模糊匹配）"
    echo "  --keyword-indexed <关键词>  关键词检索（走 search_vector 全文索引，性能更好；"
    echo "                              语义为全部词 AND 匹配，适合精确词汇）"
    echo "  --applicant <申请人>    按申请人检索"
    echo "  --inventor <发明人>     按发明人检索"
    echo "  --ipc <IPC分类>         按IPC分类检索"
    echo "  --year <年份>           按年份筛选"
    echo "  --date-range <开始> <结束>  按日期范围筛选"
    echo "  --fulltext <关键词>     全文检索（标题+摘要+权利要求）"
    echo "  --detail <公开号>       查看专利详情"
    echo ""
    echo "统计选项:"
    echo "  --stats                 数据库统计"
    echo "  --top-applicants        热门申请人"
    echo "  --top-ipc               热门IPC分类"
    echo "  --yearly-trend          年度趋势"
    echo ""
    echo "输出选项:"
    echo "  --limit <数量>          限制返回数量 (默认: 20)"
    echo "  --json                  JSON格式输出"
    echo "  --csv                   CSV格式输出"
    echo ""
    echo "示例:"
    echo "  $0 --keyword '人工智能' --limit 10"
    echo "  $0 --applicant '华为' --year 2024"
    echo "  $0 --ipc 'G06' --limit 30"
    echo "  $0 --detail 'CN202310000001'"
    echo "  $0 --stats"
}

# 解析参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --keyword)
            KEYWORD="$2"
            PSQL_VARS+=(-v keyword="$2")
            shift 2
            ;;
        --keyword-indexed)
            KW_INDEXED="$2"
            PSQL_VARS+=(-v kw="$2")
            shift 2
            ;;
        --applicant)
            APPLICANT="$2"
            PSQL_VARS+=(-v applicant="$2")
            shift 2
            ;;
        --inventor)
            INVENTOR="$2"
            PSQL_VARS+=(-v inventor="$2")
            shift 2
            ;;
        --ipc)
            IPC="$2"
            PSQL_VARS+=(-v ipc="$2")
            shift 2
            ;;
        --year)
            YEAR="$2"
            PSQL_VARS+=(-v year="$2")
            shift 2
            ;;
        --date-range)
            DATE_START="$2"
            DATE_END="$3"
            PSQL_VARS+=(-v date_start="$2" -v date_end="$3")
            shift 3
            ;;
        --fulltext)
            FULLTEXT="$2"
            PSQL_VARS+=(-v fulltext="$2")
            shift 2
            ;;
        --detail)
            DETAIL="$2"
            PSQL_VARS+=(-v detail="$2")
            shift 2
            ;;
        --stats)
            STATS=true
            shift
            ;;
        --top-applicants)
            TOP_APPLICANTS=true
            shift
            ;;
        --top-ipc)
            TOP_IPC=true
            shift
            ;;
        --yearly-trend)
            YEARLY_TREND=true
            shift
            ;;
        --limit)
            LIMIT="$2"
            PSQL_VARS+=(-v limit_num="$2")
            shift 2
            ;;
        --json)
            OUTPUT_FORMAT="json"
            shift
            ;;
        --csv)
            OUTPUT_FORMAT="csv"
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "未知选项: $1"
            show_help
            exit 1
            ;;
    esac
done

# P0-01 白名单校验（纵深防御：参数化之外，数值/格式类输入先拒绝再进 SQL）
validate_positive_int() { # $1=值 $2=参数名
    if ! [[ "$1" =~ ^[0-9]+$ ]]; then
        echo "错误: $2 必须为正整数（收到: $1）" >&2
        exit 1
    fi
}
validate_date() { # $1=值 $2=参数名
    if ! [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
        echo "错误: $2 日期格式必须为 YYYY-MM-DD（收到: $1）" >&2
        exit 1
    fi
}
validate_ipc() { # $1=值
    # IPC 主分类形如 G06F1/16；支持完整分类号（含 /NN 小类后缀），统一转大写
    if ! [[ "$1" =~ ^[A-H][0-9]{2}[A-Z]?[0-9]*(/[0-9]+)?$ ]]; then
        echo "错误: --ipc 格式不合法（应为如 G06F1 或 G06F1/16，收到: $1）" >&2
        exit 1
    fi
}

validate_positive_int "$LIMIT" "--limit"
if [[ -n "$YEAR" ]]; then validate_positive_int "$YEAR" "--year"; fi
if [[ -n "$DATE_START" ]]; then validate_date "$DATE_START" "--date-range 开始"; fi
if [[ -n "$DATE_END" ]]; then validate_date "$DATE_END" "--date-range 结束"; fi
if [[ -n "$IPC" ]]; then
    # macOS 自带 bash 3.2 不支持 ${var^^}，用 tr 转大写（兼容真实用户环境）
    IPC="$(printf '%s' "$IPC" | tr 'a-z' 'A-Z')"
    validate_ipc "$IPC"
fi

# 执行检索
execute_query() {
    local query="$1"
    # P2-01：统一限定单条查询超时 5s，防止失控的全表扫描拖住连接池
    query="SET statement_timeout = '5s'; $query"
    # 查询经 stdin 管道送入：psql -c 模式不做 :'var' 变量插值（实测 EDB 17），
    # stdin 模式插值正常且支持多语句（SET 前缀 + 查询体）
    if [[ "$OUTPUT_FORMAT" == "json" ]]; then
        printf '%s\n' "$query" | $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME "${PSQL_VARS[@]}" -q -t -A | jq '.' 2>/dev/null || printf '%s\n' "$query" | $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME "${PSQL_VARS[@]}" -q -t -A
    elif [[ "$OUTPUT_FORMAT" == "csv" ]]; then
        printf '%s\n' "$query" | $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME "${PSQL_VARS[@]}" -q -t -A -F','
    else
        printf '%s\n' "$query" | $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME "${PSQL_VARS[@]}" -q
    fi
}

# 1. 关键词检索
if [[ -n "$KEYWORD" ]]; then
    echo "🔍 关键词检索: $KEYWORD"
    execute_query "
    SELECT 
        patent_name AS 专利名称,
        application_number AS 申请号,
        applicant AS 申请人,
        ipc_main_class AS IPC主分类,
        application_date AS 申请日期
    FROM patents
    WHERE patent_name ILIKE '%' || :'keyword' || '%'
       OR abstract ILIKE '%' || :'keyword' || '%'
    ORDER BY application_date DESC
    LIMIT :limit_num;
    "
fi

# 1b. 关键词检索（全文索引模式）
# plainto_tsquery：把输入分词后 AND 连接，无语法报错风险（to_tsquery 遇
# 特殊符号会报错）；search_vector 有 GIN 索引时可走索引扫描
if [[ -n "$KW_INDEXED" ]]; then
    echo "🔍 关键词检索（索引）: $KW_INDEXED"
    execute_query "
    SELECT
        patent_name AS 专利名称,
        application_number AS 申请号,
        applicant AS 申请人,
        ipc_main_class AS IPC主分类,
        application_date AS 申请日期
    FROM patents
    WHERE search_vector @@ plainto_tsquery('chinese', :'kw')
    ORDER BY application_date DESC
    LIMIT :limit_num;
    "
fi

# 2. 申请人检索
if [[ -n "$APPLICANT" ]]; then
    echo "🏢 申请人检索: $APPLICANT"
    execute_query "
    SELECT 
        patent_name AS 专利名称,
        application_number AS 申请号,
        applicant AS 申请人,
        ipc_main_class AS IPC主分类,
        application_date AS 申请日期
    FROM patents
    WHERE applicant ILIKE '%' || :'applicant' || '%'
    ORDER BY application_date DESC
    LIMIT :limit_num;
    "
fi

# 3. 发明人检索
if [[ -n "$INVENTOR" ]]; then
    echo "👤 发明人检索: $INVENTOR"
    execute_query "
    SELECT 
        patent_name AS 专利名称,
        application_number AS 申请号,
        inventor AS 发明人,
        applicant AS 申请人,
        application_date AS 申请日期
    FROM patents
    WHERE inventor ILIKE '%' || :'inventor' || '%'
    ORDER BY application_date DESC
    LIMIT :limit_num;
    "
fi

# 4. IPC分类检索
if [[ -n "$IPC" ]]; then
    echo "📊 IPC分类检索: $IPC"
    execute_query "
    SELECT 
        patent_name AS 专利名称,
        application_number AS 申请号,
        ipc_code AS IPC分类,
        applicant AS 申请人,
        application_date AS 申请日期
    FROM patents
    WHERE ipc_code ILIKE :'ipc' || '%'
       OR ipc_main_class ILIKE :'ipc' || '%'
    ORDER BY application_date DESC
    LIMIT :limit_num;
    "
fi

# 5. 年份检索
if [[ -n "$YEAR" ]]; then
    echo "📅 年份检索: $YEAR"
    execute_query "
    SELECT 
        patent_name AS 专利名称,
        application_number AS 申请号,
        applicant AS 申请人,
        ipc_main_class AS IPC主分类,
        application_date AS 申请日期
    FROM patents
    WHERE source_year = :year
    ORDER BY application_date DESC
    LIMIT :limit_num;
    "
fi

# 6. 日期范围检索
if [[ -n "$DATE_START" && -n "$DATE_END" ]]; then
    echo "📅 日期范围检索: $DATE_START 至 $DATE_END"
    execute_query "
    SELECT 
        patent_name AS 专利名称,
        application_number AS 申请号,
        applicant AS 申请人,
        ipc_main_class AS IPC主分类,
        application_date AS 申请日期
    FROM patents
    WHERE application_date BETWEEN :'date_start' AND :'date_end'
    ORDER BY application_date DESC
    LIMIT :limit_num;
    "
fi

# 7. 全文检索
if [[ -n "$FULLTEXT" ]]; then
    echo "📚 全文检索: $FULLTEXT"
    execute_query "
    SELECT 
        patent_name AS 专利名称,
        application_number AS 申请号,
        applicant AS 申请人,
        ipc_main_class AS IPC主分类,
        application_date AS 申请日期
    FROM patents
    WHERE search_vector @@ to_tsquery('chinese', :'fulltext')
    ORDER BY application_date DESC
    LIMIT :limit_num;
    "
fi

# 8. 专利详情
if [[ -n "$DETAIL" ]]; then
    echo "📄 专利详情: $DETAIL"
    execute_query "
    SELECT 
        patent_name AS 专利名称,
        application_number AS 申请号,
        publication_number AS 公开号,
        authorization_number AS 授权号,
        application_date AS 申请日期,
        publication_date AS 公开日期,
        authorization_date AS 授权日期,
        applicant AS 申请人,
        applicant_address AS 申请人地址,
        current_assignee AS 当前权利人,
        inventor AS 发明人,
        ipc_code AS IPC分类号,
        ipc_main_class AS IPC主分类,
        abstract AS 摘要,
        citation_count AS 引用次数,
        cited_count AS 被引次数
    FROM patents
    WHERE publication_number = :'detail'
       OR application_number = :'detail'
       OR authorization_number = :'detail'
    LIMIT 1;
    "
fi

# 9. 统计分析
if [[ "$STATS" == true ]]; then
    echo "📊 数据库统计"
    execute_query "
    SELECT 
        (SELECT COUNT(*) FROM patents) AS 总专利数,
        (SELECT COUNT(DISTINCT applicant) FROM patents) AS 申请人数,
        (SELECT COUNT(DISTINCT ipc_main_class) FROM patents) AS IPC分类数,
        (SELECT MIN(application_date) FROM patents) AS 最早申请日期,
        (SELECT MAX(application_date) FROM patents) AS 最新申请日期,
        (SELECT COUNT(*) FROM patents WHERE embedding_combined IS NOT NULL) AS 向量化专利数;
    "
fi

# 10. 热门申请人
if [[ "$TOP_APPLICANTS" == true ]]; then
    echo "🏢 热门申请人 TOP $LIMIT"
    execute_query "
    SELECT 
        applicant AS 申请人,
        COUNT(*) AS 专利数量
    FROM patents
    GROUP BY applicant
    ORDER BY COUNT(*) DESC
    LIMIT :limit_num;
    "
fi

# 11. 热门IPC分类
if [[ "$TOP_IPC" == true ]]; then
    echo "📊 热门IPC分类 TOP $LIMIT"
    execute_query "
    SELECT 
        ipc_main_class AS IPC主分类,
        COUNT(*) AS 专利数量
    FROM patents
    WHERE ipc_main_class IS NOT NULL
    GROUP BY ipc_main_class
    ORDER BY COUNT(*) DESC
    LIMIT :limit_num;
    "
fi

# 12. 年度趋势
if [[ "$YEARLY_TREND" == true ]]; then
    echo "📈 年度申请趋势"
    execute_query "
    SELECT 
        source_year AS 年份,
        COUNT(*) AS 申请数量
    FROM patents
    WHERE source_year IS NOT NULL
    GROUP BY source_year
    ORDER BY source_year;
    "
fi
