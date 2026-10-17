"""Reusable dashboard SQL queries. This module reads synthetic data only."""
from __future__ import annotations
import json
import re
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
DASHBOARD_DB_FILE = Path(__file__).resolve().parents[1] / "web/data/dashboard.db"
_filter_sync_indexes_ready = False
def recalc_summary(facts: list[dict], original_summary: dict) -> dict:
    """基于过滤后的 facts 重新计算 summary 统计。"""
    if not facts:
        return {**original_summary, "valid_sales_qty": 0, "valid_sales_amount": 0, "valid_order_count": 0,
                "highlight_sales_qty": 0, "highlight_companion_sales_qty": 0, "highlight_standalone_sales_qty": 0,
                "fact_count": 0, "date_min": "", "date_max": "", "_filtered": True, "_filter_note": "当前权限范围内无数据"}
    dates = sorted(set(f["date"] for f in facts if f.get("date")))
    return {
        **original_summary,
        "valid_sales_qty": sum(f.get("sales_qty", 0) for f in facts),
        "valid_sales_amount": sum(f.get("sales_amount", 0) for f in facts),
        "valid_order_count": sum(f.get("order_count", 0) for f in facts),
        "highlight_sales_qty": sum(f.get("highlight_qty", 0) for f in facts),
        "highlight_companion_sales_qty": sum(
            f.get("highlight_qty", 0) for f in facts
            if f.get("highlight_type") == "示例赠品（套装附带）"
        ),
        "highlight_standalone_sales_qty": sum(
            f.get("highlight_qty", 0) for f in facts
            if f.get("highlight_type") == "示例赠品（单独售卖）"
        ),
        "fact_count": len(facts),
        "date_min": dates[0] if dates else original_summary.get("date_min", ""),
        "date_max": dates[-1] if dates else original_summary.get("date_max", ""),
        "_filtered": True,
    }

OVERVIEW_FACT_FIELDS = [
    "date",
    "store",
    "project_department",
    "book_series",
    "content_type",
    "source_type",
    "source_department",
    "source_manager",
    "source_group",
    "source_detail",
    "segment",
    "highlight_type",
]

FILTER_FIELD_MAP = {
    "store": "store",
    "projectDepartment": "project_department",
    "bookSeries": "book_series",
    "contentType": "content_type",
    "sourceType": "source_type",
    "sourceDepartment": "source_department",
    "sourceManager": "source_manager",
    "sourceGroup": "source_group",
    "sourceDetail": "source_detail",
    "segment": "segment",
}

FILTER_SYNC_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_facts_date_project_department ON facts(date, project_department)",
    "CREATE INDEX IF NOT EXISTS idx_facts_date_store ON facts(date, store)",
    "CREATE INDEX IF NOT EXISTS idx_facts_date_source_department ON facts(date, source_department)",
    "CREATE INDEX IF NOT EXISTS idx_facts_date_source_manager ON facts(date, source_manager)",
    "CREATE INDEX IF NOT EXISTS idx_facts_date_source_group ON facts(date, source_group)",
    "CREATE INDEX IF NOT EXISTS idx_facts_date_source_detail ON facts(date, source_detail)",
]

TABLE_GROUP_FIELDS = {
    "series": ["book_series", "project_department", "project_owner", "segment", "subject"],
    "source": ["source_type", "store", "source_department", "source_manager", "source_group", "source_detail", "content_type", "traffic_channel"],
    "product": ["merchant_code", "product_name", "book_series", "project_department", "project_owner", "match_method"],
    "influencer": ["influencer_id", "influencer_name", "source_owner", "source_type", "source_department", "source_manager", "source_group"],
}

def parse_date_param(params: dict[str, list[str]], key: str) -> str:
    value = (params.get(key, [""])[0] or "").strip()
    return value if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) else ""

def load_db_meta(connection: sqlite3.Connection) -> tuple[dict, dict, dict]:
    rows = dict(connection.execute("SELECT key, value FROM meta").fetchall())
    return (
        json.loads(rows.get("summary", "{}")),
        json.loads(rows.get("quality_checks", "{}")),
        json.loads(rows.get("dimensions", "{}")),
    )

def ensure_filter_sync_indexes(connection: sqlite3.Connection) -> None:
    global _filter_sync_indexes_ready
    if _filter_sync_indexes_ready:
        return
    for sql in FILTER_SYNC_INDEXES:
        connection.execute(sql)
    connection.commit()
    _filter_sync_indexes_ready = True

def default_recent_window(summary: dict, days: int = 7) -> tuple[str, str]:
    date_end = str(summary.get("date_max", "") or "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_end):
        return ("", "")
    try:
        end = datetime.strptime(date_end, "%Y-%m-%d").date()
    except ValueError:
        return ("", "")
    # The refresh keeps the current partial day in the database for the next
    # import, but the default dashboard window must end at the latest complete
    # day. Cap first, then subtract six days so the table and sparkline share
    # the same seven-day scope (e.g. 2026-09-07 through 2026-09-13).
    latest_complete = datetime.now().date() - timedelta(days=1)
    if end >= datetime.now().date():
        end = latest_complete
    date_end = end.isoformat()
    date_start = (end - timedelta(days=days - 1)).isoformat()
    date_min = str(summary.get("date_min", "") or "")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_min) and date_start < date_min:
        date_start = date_min
    return (date_start, date_end)

def query_overview_facts(connection: sqlite3.Connection, date_start: str, date_end: str, segments: list[str]) -> list[dict]:
    where: list[str] = []
    values: list[object] = []
    if date_start:
        where.append("date >= ?")
        values.append(date_start)
    if date_end:
        where.append("date <= ?")
        values.append(date_end)
    if segments:
        where.append(f"segment IN ({','.join('?' for _ in segments)})")
        values.extend(segments)
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    available_columns = {row[1] for row in connection.execute("PRAGMA table_info(facts)").fetchall()}
    available_fields = [field for field in OVERVIEW_FACT_FIELDS if field in available_columns]
    fields_sql = ", ".join(available_fields)
    select_prefix = f"{fields_sql}," if fields_sql else ""
    group_sql = f"GROUP BY {fields_sql}" if fields_sql else ""
    order_sql = "ORDER BY date, sales_qty DESC" if "date" in available_fields else "ORDER BY sales_qty DESC"
    highlight_select = "SUM(highlight_qty) AS highlight_qty" if "highlight_qty" in available_columns else "0 AS highlight_qty"
    sql = f"""
        SELECT {select_prefix}
               SUM(sales_qty) AS sales_qty,
               SUM(order_count) AS order_count,
               ROUND(SUM(sales_amount), 2) AS sales_amount,
               {highlight_select}
        FROM facts
        {where_sql}
        {group_sql}
        {order_sql}
    """
    cursor = connection.execute(sql, values)
    rows = []
    for raw in cursor.fetchall():
        row = dict(zip([*available_fields, "sales_qty", "order_count", "sales_amount", "highlight_qty"], raw))
        for field in OVERVIEW_FACT_FIELDS:
            row.setdefault(field, "")
        row.setdefault("grade", "")
        row.setdefault("merchant_code", "")
        row.setdefault("product_name", "")
        row.setdefault("project_owner", "")
        row.setdefault("subject", "")
        row.setdefault("match_method", "")
        row.setdefault("source_owner", "")
        row.setdefault("source_group_label", row.get("source_group", ""))
        row.setdefault("influencer_id", "")
        row.setdefault("influencer_name", row.get("source_detail", ""))
        row.setdefault("traffic_channel", "")
        row.setdefault("traffic_type", "")
        row.setdefault("ad_channel", "")
        row.setdefault("highlight_type", "")
        row.setdefault("highlight_qty", 0)
        rows.append(row)
    return rows

def query_daily_report_trend(
    connection: sqlite3.Connection,
    date_end: str,
    segments: list[str],
    filters: dict[str, list[str]] | None = None,
) -> list[dict]:
    """Return a compact seven-day book-series trend for the daily report."""
    if not date_end:
        return []
    try:
        end = datetime.strptime(date_end, "%Y-%m-%d")
    except ValueError:
        return []
    date_start = (end - timedelta(days=6)).strftime("%Y-%m-%d")
    where_sql, values = build_dashboard_filter_where(
        date_start,
        date_end,
        segments,
        filters,
        required_fields=["book_series", "segment"],
    )
    rows = []
    for raw in connection.execute(
        f"""
        SELECT date, book_series, segment,
               SUM(sales_qty) AS sales_qty,
               SUM(highlight_qty) AS highlight_qty
        FROM facts
        {where_sql}
        GROUP BY date, book_series, segment
        ORDER BY date, book_series, segment
        """,
        values,
    ).fetchall():
        rows.append(
            {
                "date": raw[0],
                "book_series": raw[1],
                "segment": raw[2],
                "sales_qty": raw[3] or 0,
                "highlight_qty": raw[4] or 0,
            }
        )
    return rows

def build_fact_where(params: dict[str, list[str]], segments: list[str]) -> tuple[str, list[object]]:
    where: list[str] = []
    values: list[object] = []
    date_start = parse_date_param(params, "date_start")
    date_end = parse_date_param(params, "date_end")
    if date_start:
        where.append("date >= ?")
        values.append(date_start)
    if date_end:
        where.append("date <= ?")
        values.append(date_end)
    if segments:
        where.append(f"segment IN ({','.join('?' for _ in segments)})")
        values.extend(segments)
    for param_key, column in FILTER_FIELD_MAP.items():
        value = (params.get(param_key, ["__all__"])[0] or "__all__").strip()
        if value and value != "__all__":
            selected = [part.strip() for part in value.split(",") if part.strip() and part.strip() != "__all__"]
            if not selected:
                continue
            if len(selected) == 1:
                where.append(f"{column} = ?")
                values.append(selected[0])
            else:
                where.append(f"{column} IN ({','.join('?' for _ in selected)})")
                values.extend(selected)
    return (f"WHERE {' AND '.join(where)}" if where else "", values)

def query_table_rows(connection: sqlite3.Connection, tab: str, params: dict[str, list[str]], segments: list[str]) -> list[dict]:
    group_fields = TABLE_GROUP_FIELDS.get(tab)
    if not group_fields:
        return []
    where_sql, values = build_fact_where(params, segments)
    fields_sql = ", ".join(group_fields)
    sql = f"""
        SELECT {fields_sql},
               SUM(sales_qty) AS sales_qty,
               ROUND(SUM(sales_amount), 2) AS sales_amount,
               SUM(order_count) AS order_count
        FROM facts
        {where_sql}
        GROUP BY {fields_sql}
        ORDER BY sales_qty DESC
        LIMIT 2000
    """
    rows = []
    for raw in connection.execute(sql, values).fetchall():
        row = dict(zip([*group_fields, "sales_qty", "sales_amount", "order_count"], raw))
        if tab == "product":
            row["matched_label"] = row.get("match_method") or "未匹配"
        if tab == "influencer":
            row.setdefault("top_book_series", "")
            row.setdefault("top_content_type", "")
        rows.append(row)
    return rows

def load_agg_table(
    connection: sqlite3.Connection,
    table_name: str,
    text_fields: list[str],
    num_fields: list[str],
    filters: dict[str, list[str]] | None = None,
) -> list[dict[str, Any]]:
    """Load an aggregation table from the database, optionally filtered."""
    try:
        all_fields = [*text_fields, *num_fields]
        sql = f"SELECT {', '.join(all_fields)} FROM {table_name}"
        where_clauses = []
        params_list: list[str] = []
        if filters:
            # Only apply filters where the column exists in this table
            table_cols = set(text_fields)
            for filter_key, values in filters.items():
                if filter_key in table_cols and values:
                    placeholders = ",".join(["?" for _ in values])
                    where_clauses.append(f"[{filter_key}] IN ({placeholders})")
                    params_list.extend(values)
        if where_clauses:
            sql += " WHERE " + " AND ".join(where_clauses)
        cursor = connection.execute(sql, params_list)
        rows = []
        for row in cursor:
            record: dict[str, Any] = {}
            for i, field in enumerate(all_fields):
                record[field] = row[i]
            rows.append(record)
        return rows
    except sqlite3.OperationalError:
        return []

def build_dashboard_filter_where(
    date_start: str,
    date_end: str,
    segments: list[str],
    filters: dict[str, list[str]] | None = None,
    required_fields: list[str] | None = None,
    filter_fields: list[str] | None = None,
) -> tuple[str, list[object]]:
    where: list[str] = []
    values: list[object] = []
    if date_start:
        where.append("date >= ?")
        values.append(date_start)
    if date_end:
        where.append("date <= ?")
        values.append(date_end)
    if segments:
        where.append(f"segment IN ({','.join('?' for _ in segments)})")
        values.extend(segments)
    for field in required_fields or []:
        where.append(f"[{field}] IS NOT NULL AND [{field}] != ''")
    allowed_filter_fields = set(filter_fields or FILTER_FIELD_MAP.values())
    for column, selected in (filters or {}).items():
        if column not in allowed_filter_fields or column not in FILTER_FIELD_MAP.values() or not selected:
            continue
        cleaned = [value for value in selected if value and value != "__all__"]
        if not cleaned:
            continue
        where.append(f"[{column}] IN ({','.join('?' for _ in cleaned)})")
        values.extend(cleaned)
    return (f"WHERE {' AND '.join(where)}" if where else "", values)

def query_fact_aggregation(
    connection: sqlite3.Connection,
    group_fields: list[tuple[str, str]],
    date_start: str,
    date_end: str,
    segments: list[str],
    filters: dict[str, list[str]] | None = None,
    required_fields: list[str] | None = None,
    filter_fields: list[str] | None = None,
    table_name: str = "facts",
) -> list[dict]:
    where_sql, values = build_dashboard_filter_where(date_start, date_end, segments, filters, required_fields, filter_fields)
    select_fields = [f"[{source}] AS [{alias}]" for source, alias in group_fields]
    group_sql = ", ".join(f"[{source}]" for source, _ in group_fields)
    sql = f"""
        SELECT {', '.join(select_fields)},
               SUM(sales_qty) AS sales_qty,
               SUM(order_count) AS order_count,
               ROUND(SUM(sales_amount), 2) AS sales_amount
        FROM {table_name}
        {where_sql}
        GROUP BY {group_sql}
        ORDER BY sales_qty DESC
    """
    aliases = [alias for _, alias in group_fields]
    rows = []
    for raw in connection.execute(sql, values).fetchall():
        rows.append(dict(zip([*aliases, "sales_qty", "order_count", "sales_amount"], raw)))
    return rows

def load_dashboard_from_db(date_start: str, date_end: str, role: str, segments: list[str], dim_filters: dict[str, list[str]] | None = None) -> dict:
    connection = sqlite3.connect(DASHBOARD_DB_FILE)
    try:
        ensure_filter_sync_indexes(connection)
        summary, quality_checks, dimensions = load_db_meta(connection)
        if not date_start and not date_end:
            date_start, date_end = default_recent_window(summary)
        allowed_segments = segments if role == "project_leader" and segments else []
        if role not in {"admin", "project_leader"}:
            facts: list[dict] = []
        elif role == "project_leader" and not allowed_segments:
            facts = []
        else:
            facts = query_overview_facts(connection, date_start, date_end, allowed_segments)
        can_query_dimensions = bool(role == "admin" or (role == "project_leader" and allowed_segments))
        dimension_filters = dim_filters or {}
        filtered_summary = recalc_summary(facts, summary)
        filtered_summary.update(
            {
                "date_min": summary.get("date_min", filtered_summary.get("date_min", "")),
                "date_max": summary.get("date_max", filtered_summary.get("date_max", "")),
                "fact_rows": len(facts),
                "_fact_grain": "overview_sql",
            }
        )
        dimensions = {
            **dimensions,
            "products": [],
            "influencers": [],
            "flows": [],
            "sources": [],
            "region": query_fact_aggregation(
                connection,
                [("province", "province"), ("city", "city"), ("date", "date"), ("book_series", "book_series"), ("segment", "segment")],
                date_start,
                date_end,
                allowed_segments,
                dimension_filters,
                ["province", "city"],
            ) if can_query_dimensions else [],
            "hour": query_fact_aggregation(
                connection,
                [("order_hour", "hour"), ("order_weekday", "weekday"), ("date", "date"), ("book_series", "book_series"), ("source_type", "source_type")],
                date_start,
                date_end,
                allowed_segments,
                dimension_filters,
                ["order_hour", "order_weekday"],
            ) if can_query_dimensions else [],
            "price_band": query_fact_aggregation(
                connection,
                [("price_band", "price_band"), ("book_series", "book_series"), ("segment", "segment")],
                date_start,
                date_end,
                allowed_segments,
                dimension_filters,
                ["price_band"],
            ) if can_query_dimensions else [],
            "aftersale": query_fact_aggregation(
                connection,
                [("aftersale_status", "aftersale_status"), ("book_series", "book_series"), ("store", "store"), ("province", "province"), ("date", "date")],
                date_start,
                date_end,
                allowed_segments,
                dimension_filters,
                [],
                ["book_series", "store", "segment"],
                "agg_aftersale",
            ) if can_query_dimensions else [],
        }
        daily_report_trend = (
            query_daily_report_trend(connection, date_end, allowed_segments, dimension_filters)
            if can_query_dimensions
            else []
        )
        return {
            "summary": filtered_summary,
            "facts": facts,
            "daily_report_trend": daily_report_trend,
            "dimensions": dimensions,
            "quality_checks": quality_checks,
        }
    finally:
        connection.close()
