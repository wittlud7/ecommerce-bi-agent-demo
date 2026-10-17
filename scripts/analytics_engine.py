#!/usr/bin/env python3
"""
共享分析引擎 — 电商直播销售数据分析

MCP Server 和 Web Chat 共用的数据查询层。
所有函数都是纯函数：接受 db_path，返回 JSON 可序列化的 dict。

Usage:
    from scripts.analytics_engine import AnalyticsEngine
    engine = AnalyticsEngine("web/data/dashboard.db")
    result = engine.get_summary_stats(date_start="2025-03-25", date_end="2025-03-31")
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# SQL safety
# ---------------------------------------------------------------------------

FORBIDDEN_SQL = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|ATTACH|DETACH|PRAGMA)\b",
    re.IGNORECASE,
)

MAX_ROWS = 5000
QUERY_TIMEOUT = 30.0


def validate_readonly_sql(sql: str) -> None:
    """Ensure the SQL is a read-only SELECT."""
    cleaned = sql.strip()
    if not cleaned:
        raise ValueError("SQL 不能为空")
    cleaned = re.sub(r"--.*$", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"/\*.*?\*/", "", cleaned, flags=re.DOTALL).strip()
    if ";" in cleaned.rstrip(";"):
        raise ValueError("只允许单条 SELECT 查询")
    if FORBIDDEN_SQL.search(cleaned):
        raise ValueError("只允许 SELECT 查询，禁止 INSERT/UPDATE/DELETE/DROP/ALTER 等写操作")
    if not re.match(r"^\s*(SELECT|WITH)\b", cleaned, re.IGNORECASE):
        raise ValueError("只允许 SELECT 或 WITH (CTE) 查询")


def _serialize_value(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, (int, float, bool)):
        return v
    if isinstance(v, bytes):
        return v.decode("utf-8", errors="replace")
    return str(v)


# ---------------------------------------------------------------------------
# AnalyticsEngine
# ---------------------------------------------------------------------------


class AnalyticsEngine:
    """Shared analytics engine used by both MCP Server and Web Chat."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path).resolve()
        if not self.db_path.exists():
            raise FileNotFoundError(f"数据库文件不存在: {self.db_path}")

    # -----------------------------------------------------------------------
    # Internal helpers
    # -----------------------------------------------------------------------

    def _connect_readonly(self) -> sqlite3.Connection:
        db_uri = self.db_path.resolve().as_uri()
        conn = sqlite3.connect(f"{db_uri}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    def _query_one(self, sql: str, params: list | tuple = ()) -> sqlite3.Row | None:
        conn = self._connect_readonly()
        try:
            return conn.execute(sql, params).fetchone()
        finally:
            conn.close()

    def _query_all(self, sql: str, params: list | tuple = ()) -> list[sqlite3.Row]:
        conn = self._connect_readonly()
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    def _resolve_date_range(
        self, date_start: str = "", date_end: str = "", default_days: int = 7
    ) -> tuple[str, str]:
        """Resolve date range, defaulting to last N days from latest date."""
        if date_start and date_end:
            return date_start, date_end
        dr = self._query_one("SELECT MIN(date), MAX(date) FROM facts")
        latest = str(dr[1] or "")
        earliest = str(dr[0] or "")
        if latest:
            if not date_end:
                date_end = latest
            if not date_start:
                try:
                    end_dt = datetime.strptime(date_end, "%Y-%m-%d")
                    date_start = (end_dt - timedelta(days=default_days - 1)).strftime("%Y-%m-%d")
                except ValueError:
                    date_start = latest
        return date_start, date_end

    def _prev_period(self, date_start: str, date_end: str) -> tuple[str, str]:
        try:
            s = datetime.strptime(date_start, "%Y-%m-%d")
            e = datetime.strptime(date_end, "%Y-%m-%d")
            days = (e - s).days + 1
            pe = s - timedelta(days=1)
            ps = pe - timedelta(days=days - 1)
            return ps.strftime("%Y-%m-%d"), pe.strftime("%Y-%m-%d")
        except ValueError:
            return date_start, date_end

    @staticmethod
    def _segment_scope(segments: list[str] | None) -> tuple[str, list[str]]:
        """Return a reusable SQL fragment that enforces the requested school stages."""
        values = list(dict.fromkeys(str(value).strip() for value in (segments or []) if str(value).strip()))
        if not values:
            return "", []
        placeholders = ",".join("?" for _ in values)
        return f" AND segment IN ({placeholders})", values

    # -----------------------------------------------------------------------
    # Tool 1: get_data_schema
    # -----------------------------------------------------------------------

    def get_data_schema(self) -> dict:
        """返回完整的数据字典，包括所有表结构、维度含义、指标口径和业务规则。"""
        conn = self._connect_readonly()
        try:
            tables = {}
            for (table_name,) in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall():
                row_count = conn.execute(
                    f"SELECT COUNT(*) FROM [{table_name}]"
                ).fetchone()[0]
                columns = [
                    {"name": col["name"], "type": col["type"], "nullable": not col["notnull"]}
                    for col in conn.execute(f"PRAGMA table_info([{table_name}])").fetchall()
                ]
                tables[table_name] = {"row_count": row_count, "columns": columns}

            date_range = conn.execute(
                "SELECT MIN(date) as d_min, MAX(date) as d_max FROM facts"
            ).fetchone()

            dimension_samples = {}
            dim_columns = [
                "store", "book_series", "segment", "subject", "grade",
                "source_type", "source_group", "content_type", "traffic_channel",
                "price_band", "province",
            ]
            for dim in dim_columns:
                facts_cols = {c["name"] for c in tables.get("facts", {}).get("columns", [])}
                if dim not in facts_cols:
                    continue
                try:
                    rows = conn.execute(
                        f"""SELECT [{dim}], SUM(sales_qty) as qty, COUNT(*) as cnt
                            FROM facts GROUP BY [{dim}] ORDER BY qty DESC LIMIT 15"""
                    ).fetchall()
                    dimension_samples[dim] = [
                        {"value": r[dim] or "(空)", "sales_qty": r["qty"], "row_count": r["cnt"]}
                        for r in rows
                    ]
                except Exception:
                    pass

            return {
                "ok": True,
                "database": "synthetic-demo",
                "tables": tables,
                "date_range": {
                    "earliest_date": date_range["d_min"] if date_range else "未知",
                    "latest_date": date_range["d_max"] if date_range else "未知",
                },
                "dimension_samples": dimension_samples,
                "business_rules": {
                    "成交额公式": "sales_amount = 模拟销量 × 独立生成的模拟单价；不对应企业交易口径",
                    "数据粒度": "独立生成的商品、店铺、渠道、日期模拟记录；不是订单明细",
                    "订单数": "由生成器独立模拟；不代表真实套装拆分或订单核算规则",
                    "星期编码": "0=周日, 1=周一, ..., 6=周六",
                },
                "common_sql_patterns": {
                    "按书系汇总": """SELECT book_series, segment, subject, SUM(sales_qty) as qty, ROUND(SUM(sales_amount),2) as amount FROM facts WHERE date BETWEEN 'start' AND 'end' GROUP BY book_series ORDER BY qty DESC LIMIT 20""",
                    "按日期趋势": """SELECT date, SUM(sales_qty) as qty, ROUND(SUM(sales_amount),2) as amount FROM facts WHERE date BETWEEN 'start' AND 'end' GROUP BY date ORDER BY date""",
                    "按来源分类": """SELECT source_type, content_type, source_group, SUM(sales_qty) as qty, ROUND(SUM(sales_amount),2) as amount FROM facts WHERE date BETWEEN 'start' AND 'end' GROUP BY source_type, content_type, source_group ORDER BY amount DESC""",
                    "时段分析": """SELECT order_hour, order_weekday, SUM(sales_qty) as qty FROM facts WHERE content_type='直播' AND date BETWEEN 'start' AND 'end' GROUP BY order_hour, order_weekday ORDER BY order_weekday, order_hour""",
                },
            }
        finally:
            conn.close()

    # -----------------------------------------------------------------------
    # Tool 2: run_sql_query
    # -----------------------------------------------------------------------

    def run_sql_query(self, sql: str, max_rows: int = MAX_ROWS) -> dict:
        """执行只读 SQL 查询（仅允许 SELECT/WITH）。"""
        validate_readonly_sql(sql)

        if not re.search(r"LIMIT\s+\d+", sql, re.IGNORECASE):
            sql = sql.rstrip(";").strip() + f" LIMIT {max_rows}"
        else:
            sql = re.sub(
                r"LIMIT\s+(\d+)",
                lambda m: f"LIMIT {min(int(m.group(1)), max_rows)}",
                sql,
                flags=re.IGNORECASE,
            )

        conn = self._connect_readonly()
        try:
            start = time.monotonic()

            def timeout_check():
                if time.monotonic() - start > QUERY_TIMEOUT:
                    return 1

            conn.set_progress_handler(timeout_check, 1000)
            cursor = conn.execute(sql)
            columns = [desc[0] for desc in cursor.description] if cursor.description else []
            rows = []
            for row in cursor.fetchall():
                rows.append([_serialize_value(v) for v in row])
                if len(rows) >= max_rows:
                    break

            return {
                "ok": True,
                "columns": columns,
                "rows": rows,
                "row_count": len(rows),
                "truncated": len(rows) >= max_rows,
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}
        finally:
            conn.close()

    # -----------------------------------------------------------------------
    # Tool 3: get_summary_stats
    # -----------------------------------------------------------------------

    def get_summary_stats(
        self,
        date_start: str = "",
        date_end: str = "",
        dimension: str = "",
        top_n: int = 20,
        segments: list[str] | None = None,
    ) -> dict:
        """获取核心 KPI 概览和维度排名。"""
        date_start, date_end = self._resolve_date_range(date_start, date_end)
        segment_sql, segment_params = self._segment_scope(segments)

        kpi = self._query_one(
            "SELECT SUM(sales_qty) as qty, ROUND(SUM(sales_amount),2) as amount, "
            "SUM(order_count) as orders, COUNT(DISTINCT date) as days "
            f"FROM facts WHERE date >= ? AND date <= ?{segment_sql}",
            [date_start, date_end] + segment_params,
        )

        daily_avg = self._query_one(
            "SELECT ROUND(AVG(daily_qty),0) as avg_qty, ROUND(AVG(daily_amount),2) as avg_amount "
            "FROM (SELECT date, SUM(sales_qty) as daily_qty, SUM(sales_amount) as daily_amount "
            f"FROM facts WHERE date >= ? AND date <= ?{segment_sql} GROUP BY date)",
            [date_start, date_end] + segment_params,
        )

        result = {
            "ok": True,
            "period": {"date_start": date_start, "date_end": date_end},
            "overall": {
                "total_sales_qty": kpi["qty"] or 0,
                "total_sales_amount": kpi["amount"] or 0,
                "total_order_count": kpi["orders"] or 0,
                "coverage_days": kpi["days"] or 0,
            },
            "daily_average": {
                "avg_sales_qty": daily_avg["avg_qty"] or 0,
                "avg_sales_amount": daily_avg["avg_amount"] or 0,
            },
        }

        if dimension:
            allowed_dims = {
                "book_series", "store", "source_type", "source_group",
                "province", "subject", "segment", "content_type",
                "project_department", "source_department", "source_manager",
                "grade", "version", "traffic_channel", "price_band",
            }
            if dimension in allowed_dims:
                rows = self._query_all(
                    f"""SELECT [{dimension}] as dim_val,
                               SUM(sales_qty) as qty,
                               ROUND(SUM(sales_amount),2) as amount,
                               SUM(order_count) as orders,
                               COUNT(DISTINCT date) as active_days
                        FROM facts WHERE date >= ? AND date <= ?{segment_sql}
                        GROUP BY [{dimension}]
                        ORDER BY qty DESC LIMIT ?""",
                    [date_start, date_end] + segment_params + [top_n],
                )
                result["top_segments"] = [
                    {
                        "value": r["dim_val"] or "(空)",
                        "sales_qty": r["qty"],
                        "sales_amount": r["amount"],
                        "order_count": r["orders"],
                        "active_days": r["active_days"],
                    }
                    for r in rows
                ]
                total_top = sum(r["qty"] for r in rows)
                total_all = result["overall"]["total_sales_qty"]
                if total_all > 0:
                    result["top_concentration"] = round(total_top / total_all * 100, 1)

        return result

    # -----------------------------------------------------------------------
    # Tool 4: analyze_trend
    # -----------------------------------------------------------------------

    def analyze_trend(
        self,
        metric: str = "sales_amount",
        dimension: str = "",
        dimension_value: str = "",
        granularity: str = "day",
        date_start: str = "",
        date_end: str = "",
        segments: list[str] | None = None,
    ) -> dict:
        """分析时间序列趋势。"""
        if dimension and dimension not in {"book_series", "store", "source_type", "source_group", "province", "subject", "segment", "content_type", "project_department", "source_department", "source_manager", "grade", "version", "traffic_channel", "price_band", "order_hour", "order_weekday"}:
            return {"ok": False, "error": "不支持的分析维度"}
        date_start, date_end = self._resolve_date_range(date_start, date_end, default_days=30)

        metric_col = metric if metric in ("sales_qty", "sales_amount", "order_count") else "sales_amount"
        metric_expr = (
            f"ROUND(SUM({metric_col}),2)" if metric_col == "sales_amount"
            else f"SUM({metric_col})"
        )

        where_parts = ["date >= ?", "date <= ?"]
        params: list[Any] = [date_start, date_end]
        if segments:
            placeholders = ",".join("?" for _ in segments)
            where_parts.append(f"segment IN ({placeholders})")
            params.extend(segments)
        if dimension and dimension_value:
            where_parts.append(f"[{dimension}] = ?")
            params.append(dimension_value)
        where_clause = "WHERE " + " AND ".join(where_parts)

        if granularity == "week":
            group_expr = "strftime('%Y-W%W', date)"
        elif granularity == "month":
            group_expr = "strftime('%Y-%m', date)"
        else:
            group_expr = "date"

        sql = f"""
            SELECT {group_expr} as period,
                   {metric_expr} as metric_value,
                   SUM(sales_qty) as sales_qty,
                   ROUND(SUM(sales_amount),2) as sales_amount,
                   SUM(order_count) as order_count
            FROM facts {where_clause}
            GROUP BY period ORDER BY period
        """
        rows = self._query_all(sql, params)

        series = [{
            "period": r["period"],
            "metric_value": r["metric_value"] or 0,
            "sales_qty": r["sales_qty"] or 0,
            "sales_amount": r["sales_amount"] or 0,
            "order_count": r["order_count"] or 0,
        } for r in rows]

        # Trend analysis
        trend_direction = "平稳"
        volatility = 0
        if len(series) >= 3:
            values = [s["metric_value"] for s in series]
            n = len(values)
            x_mean = (n - 1) / 2
            y_mean = sum(values) / n
            numerator = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(values))
            denominator = sum((i - x_mean) ** 2 for i in range(n))
            if denominator > 0 and y_mean > 0:
                slope_pct = (numerator / denominator) / y_mean * 100
                if slope_pct > 1:
                    trend_direction = "上升"
                elif slope_pct < -1:
                    trend_direction = "下降"
            if y_mean > 0:
                variance = sum((v - y_mean) ** 2 for v in values) / n
                volatility = round((variance ** 0.5) / y_mean * 100, 1)

        total = sum(s["metric_value"] for s in series)
        avg = total / len(series) if series else 0
        max_point = max(series, key=lambda s: s["metric_value"]) if series else None
        min_point = min(series, key=lambda s: s["metric_value"]) if series else None
        first_val = series[0]["metric_value"] if series else 0
        last_val = series[-1]["metric_value"] if series else 0
        change_pct = round((last_val - first_val) / first_val * 100, 1) if first_val > 0 else 0

        return {
            "ok": True,
            "parameters": {
                "metric": metric_col,
                "dimension": dimension or "整体",
                "dimension_value": dimension_value or "全部",
                "granularity": granularity,
                "date_start": date_start,
                "date_end": date_end,
            },
            "series": series,
            "trend_analysis": {
                "direction": trend_direction,
                "volatility_pct": volatility,
                "total": total,
                "average_per_period": round(avg, 2),
                "max_point": {"period": max_point["period"], "value": max_point["metric_value"]} if max_point else None,
                "min_point": {"period": min_point["period"], "value": min_point["metric_value"]} if min_point else None,
                "first_period": first_val,
                "last_period": last_val,
                "change_pct": change_pct,
            },
        }

    # -----------------------------------------------------------------------
    # Tool 5: compare_segments
    # -----------------------------------------------------------------------

    def compare_segments(
        self,
        metric: str = "sales_amount",
        dimension: str = "book_series",
        date_start: str = "",
        date_end: str = "",
        segments: list[str] | None = None,
    ) -> dict:
        """多维度对比分析——比较当前周期与上一周期的各分段表现。"""
        date_start, date_end = self._resolve_date_range(date_start, date_end)

        metric_col = metric if metric in ("sales_qty", "sales_amount", "order_count") else "sales_amount"
        metric_expr = (
            f"ROUND(SUM({metric_col}),2)" if metric_col == "sales_amount"
            else f"SUM({metric_col})"
        )

        allowed_dims = {
            "book_series", "store", "source_type", "source_group",
            "province", "subject", "segment", "content_type",
            "project_department", "source_department", "source_manager",
        }
        if dimension not in allowed_dims:
            return {"ok": False, "error": f"不支持的维度: {dimension}"}

        prev_start_str, prev_end_str = self._prev_period(date_start, date_end)
        segment_sql, segment_params = self._segment_scope(segments)

        curr_rows = self._query_all(
            f"""SELECT [{dimension}] as dim_val, {metric_expr} as metric_value,
                       SUM(sales_qty) as sales_qty, ROUND(SUM(sales_amount),2) as sales_amount,
                       SUM(order_count) as order_count
                FROM facts WHERE date >= ? AND date <= ?{segment_sql}
                GROUP BY [{dimension}] ORDER BY metric_value DESC""",
            [date_start, date_end] + segment_params,
        )

        prev_rows = self._query_all(
            f"""SELECT [{dimension}] as dim_val, {metric_expr} as metric_value
                FROM facts WHERE date >= ? AND date <= ?{segment_sql}
                GROUP BY [{dimension}]""",
            [prev_start_str, prev_end_str] + segment_params,
        )
        prev_map = {r["dim_val"] or "(空)": r["metric_value"] or 0 for r in prev_rows}

        curr_total = sum(r["metric_value"] or 0 for r in curr_rows)
        segments = []
        curr_map = {r["dim_val"] or "(空)": dict(r) for r in curr_rows}
        for missing in prev_map.keys() - curr_map.keys():
            curr_map[missing] = dict(dim_val=missing, metric_value=0, sales_qty=0, sales_amount=0, order_count=0)
        for r in curr_map.values():
            val = r["metric_value"] or 0
            prev_val = prev_map.get(r["dim_val"] or "(空)", 0)
            change = val - prev_val
            change_pct = round(change / prev_val * 100, 1) if prev_val > 0 else (100.0 if val > 0 else 0)
            segments.append({
                "dimension_value": r["dim_val"] or "(空)",
                "current_value": val,
                "previous_value": prev_val,
                "change": round(change, 2),
                "change_pct": change_pct,
                "share_pct": round(val / curr_total * 100, 1) if curr_total > 0 else 0,
                "sales_qty": r["sales_qty"] or 0,
                "sales_amount": r["sales_amount"] or 0,
                "order_count": r["order_count"] or 0,
            })

        sorted_by_change = sorted(segments, key=lambda s: s["change"], reverse=True)
        top_gainers = [s for s in sorted_by_change if s["change"] > 0][:5]
        top_decliners = sorted(
            [s for s in sorted_by_change if s["change"] < 0], key=lambda s: s["change"]
        )[:5]

        prev_total = sum(r["metric_value"] or 0 for r in prev_rows)
        for s in segments:
            prev_share = round(s["previous_value"] / prev_total * 100, 1) if prev_total > 0 else 0
            s["previous_share_pct"] = prev_share
            s["share_shift_ppt"] = round(s["share_pct"] - prev_share, 1)

        return {
            "ok": True,
            "parameters": {
                "metric": metric_col,
                "dimension": dimension,
                "current_period": f"{date_start} ~ {date_end}",
                "previous_period": f"{prev_start_str} ~ {prev_end_str}",
            },
            "overall": {
                "current_total": round(curr_total, 2),
                "previous_total": round(prev_total, 2),
                "total_change": round(curr_total - prev_total, 2),
            },
            "segments": segments,
            "top_gainers": top_gainers,
            "top_decliners": top_decliners,
            "total_segments": len(segments),
        }

    # -----------------------------------------------------------------------
    # Tool 6: drill_down
    # -----------------------------------------------------------------------

    def drill_down(
        self,
        target: str = "整体",
        date_start: str = "",
        date_end: str = "",
        segments: list[str] | None = None,
    ) -> dict:
        """多维度下钻分析——从多个角度交叉拆解数据，定位变化的根因。"""
        date_start, date_end = self._resolve_date_range(date_start, date_end, default_days=14)
        prev_start_str, prev_end_str = self._prev_period(date_start, date_end)
        segment_sql, segment_params = self._segment_scope(segments)

        # Build target filter
        target_filter = ""
        target_params: list[str] = []
        if target and target not in ("整体", "全部"):
            for dim in ["book_series", "store", "source_type", "source_group",
                        "segment", "subject", "province", "content_type", "project_department"]:
                match = self._query_one(
                    f"SELECT DISTINCT [{dim}] FROM facts WHERE [{dim}] LIKE ?{segment_sql} LIMIT 1",
                    [f"%{target}%"] + segment_params,
                )
                if match:
                    target_filter = f"AND [{dim}] = ?"
                    target_params = [match[dim]]
                    break
            if not target_filter:
                return {"ok": False, "error": f"无法匹配 '{target}' 到任何已知维度值"}

        def drill_dim(dimension: str) -> dict:
            base_where = "WHERE date >= ? AND date <= ?" + segment_sql + " " + target_filter
            base_params = [date_start, date_end] + segment_params + target_params

            curr = self._query_all(
                f"""SELECT [{dimension}] as dim_val,
                           SUM(sales_qty) as qty,
                           ROUND(SUM(sales_amount),2) as amount,
                           SUM(order_count) as orders
                    FROM facts {base_where}
                    GROUP BY [{dimension}] ORDER BY amount DESC LIMIT 20""",
                base_params,
            )

            prev_params = [prev_start_str, prev_end_str] + segment_params + target_params
            prev = self._query_all(
                f"""SELECT [{dimension}] as dim_val,
                           ROUND(SUM(sales_amount),2) as amount
                    FROM facts WHERE date >= ? AND date <= ?{segment_sql} {target_filter}
                    GROUP BY [{dimension}]""",
                prev_params,
            )
            prev_map = {r["dim_val"] or "(空)": r["amount"] or 0 for r in prev}

            total = sum((r["amount"] or 0) for r in curr)
            items = []
            for r in curr:
                val = r["amount"] or 0
                pv = prev_map.get(r["dim_val"] or "(空)", 0)
                change = val - pv
                items.append({
                    "value": r["dim_val"] or "(空)",
                    "sales_amount": val,
                    "sales_qty": r["qty"] or 0,
                    "order_count": r["orders"] or 0,
                    "prev_amount": pv,
                    "change": round(change, 2),
                    "change_pct": round(change / pv * 100, 1) if pv > 0 else None,
                    "share_pct": round(val / total * 100, 1) if total > 0 else 0,
                })
            return {"total": round(total, 2), "items": items, "items_count": len(items)}

        drill_dims = [
            "source_type", "store", "source_group", "content_type",
            "traffic_channel", "province", "book_series", "subject",
            "segment", "order_hour", "order_weekday", "price_band",
        ]

        dimensions_result = {}
        for dim_col in drill_dims:
            try:
                dimensions_result[dim_col] = drill_dim(dim_col)
            except Exception as e:
                dimensions_result[dim_col] = {"error": str(e)}

        overall_curr = self._query_one(
            f"""SELECT SUM(sales_qty) as qty, ROUND(SUM(sales_amount),2) as amount,
                       SUM(order_count) as orders, COUNT(DISTINCT date) as days
                FROM facts WHERE date >= ? AND date <= ?{segment_sql} {target_filter}""",
            [date_start, date_end] + segment_params + target_params,
        )
        overall_prev = self._query_one(
            f"""SELECT SUM(sales_qty) as qty, ROUND(SUM(sales_amount),2) as amount
                FROM facts WHERE date >= ? AND date <= ?{segment_sql} {target_filter}""",
            [prev_start_str, prev_end_str] + segment_params + target_params,
        )

        curr_amount = overall_curr["amount"] or 0
        prev_amount = overall_prev["amount"] or 0

        return {
            "ok": True,
            "target": target,
            "matched_filter": target_filter.replace("AND [", "").replace("] = ?", "") if target_filter else "无筛选",
            "period": {
                "current": f"{date_start} ~ {date_end}",
                "previous": f"{prev_start_str} ~ {prev_end_str}",
            },
            "overall": {
                "current_sales_qty": overall_curr["qty"] or 0,
                "current_sales_amount": curr_amount,
                "current_order_count": overall_curr["orders"] or 0,
                "current_days": overall_curr["days"] or 0,
                "previous_sales_amount": prev_amount,
                "amount_change": round(curr_amount - prev_amount, 2),
                "amount_change_pct": round((curr_amount - prev_amount) / prev_amount * 100, 1) if prev_amount > 0 else None,
            },
            "drill_dimensions": dimensions_result,
        }
