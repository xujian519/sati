#!/bin/bash
# 专利检索脚本
# 使用 PostgreSQL 数据库 patent_db 进行专利检索
# 统一引用 ~/.infra/infra.env 配置

set -e

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

# 帮助信息
show_help() {
    echo "专利检索工具 - 从 patent_db 检索专利数据"
    echo ""
    echo "用法: $0 [选项]"
    echo ""
    echo "检索选项:"
    echo "  --keyword <关键词>      关键词检索（专利名称、摘要）"
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
            shift 2
            ;;
        --applicant)
            APPLICANT="$2"
            shift 2
            ;;
        --inventor)
            INVENTOR="$2"
            shift 2
            ;;
        --ipc)
            IPC="$2"
            shift 2
            ;;
        --year)
            YEAR="$2"
            shift 2
            ;;
        --date-range)
            DATE_START="$2"
            DATE_END="$3"
            shift 3
            ;;
        --fulltext)
            FULLTEXT="$2"
            shift 2
            ;;
        --detail)
            DETAIL="$2"
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

# 执行检索
execute_query() {
    local query="$1"
    if [[ "$OUTPUT_FORMAT" == "json" ]]; then
        $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -A -c "$query" | jq '.' 2>/dev/null || $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -A -c "$query"
    elif [[ "$OUTPUT_FORMAT" == "csv" ]]; then
        $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -A -F',' -c "$query"
    else
        $PSQL -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "$query"
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
    WHERE patent_name ILIKE '%${KEYWORD}%'
       OR abstract ILIKE '%${KEYWORD}%'
    ORDER BY application_date DESC
    LIMIT $LIMIT;
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
    WHERE applicant ILIKE '%${APPLICANT}%'
    ORDER BY application_date DESC
    LIMIT $LIMIT;
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
    WHERE inventor ILIKE '%${INVENTOR}%'
    ORDER BY application_date DESC
    LIMIT $LIMIT;
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
    WHERE ipc_code ILIKE '${IPC}%'
       OR ipc_main_class ILIKE '${IPC}%'
    ORDER BY application_date DESC
    LIMIT $LIMIT;
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
    WHERE source_year = $YEAR
    ORDER BY application_date DESC
    LIMIT $LIMIT;
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
    WHERE application_date BETWEEN '$DATE_START' AND '$DATE_END'
    ORDER BY application_date DESC
    LIMIT $LIMIT;
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
    WHERE search_vector @@ to_tsquery('chinese', '${FULLTEXT}')
    ORDER BY application_date DESC
    LIMIT $LIMIT;
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
    WHERE publication_number = '$DETAIL'
       OR application_number = '$DETAIL'
       OR authorization_number = '$DETAIL'
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
    LIMIT $LIMIT;
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
    LIMIT $LIMIT;
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
