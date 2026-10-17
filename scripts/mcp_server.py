#!/usr/bin/env python3
"""
MCP Server — 电商直播销售数据分析 Agent

将 dashboard.db 的分析能力通过 MCP 协议暴露给 Claude，
实现自然语言驱动的深度数据分析（不只是查数据，而是策略级分析建议）。

Usage:
    python scripts/mcp_server.py --db web/data/dashboard.db
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from mcp.server.fastmcp import FastMCP

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from analytics_engine import AnalyticsEngine

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[1]
_engine: AnalyticsEngine | None = None


def _get_engine() -> AnalyticsEngine:
    if _engine is None:
        raise RuntimeError("Engine not initialized")
    return _engine


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "dashboard-analyst",
    instructions="""你是一个电商直播销售数据分析助手，仅连接本项目独立生成的模拟销售数据库；所有结果都是演示数据。

## 分析工作流

当用户提出分析问题时，按以下框架思考：

1. **理解数据语境** — 如果不确定某个维度的含义或指标口径，先调用 `get_data_schema`
2. **掌握全局** — 调用 `get_summary_stats` 了解整体 KPI 情况
3. **定位关键点** — 调用 `compare_segments` 找出增长/下滑最显著的分段
4. **深挖根因** — 调用 `drill_down` 进行多维度交叉下钻，定位变化来源
5. **给出策略建议** — 结合数据发现，向用户提供可操作的业务建议

## 重要提示

- 成交额 = 订单应付金额 + 平台实际承担优惠金额 + 达人实际承担优惠金额
- 数据已被处理：套装商品已拆分（每学科单独计数），订单金额已等比分配
- date 格式始终为 YYYY-MM-DD
- 未匹配商品（book_series="未匹配商品"）是正常的，表示无法通过自编码/标题识别归属的商品
- 来源分类中，content_type="待更新" 表示流量体裁字段因数据延迟暂不可用
""",
)


# ---------------------------------------------------------------------------
# Tool 1: get_data_schema
# ---------------------------------------------------------------------------

@mcp.tool()
def get_data_schema() -> str:
    """返回完整的数据字典，包括所有表结构、维度含义、指标口径和业务规则。"""
    return json.dumps(_get_engine().get_data_schema(), ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Tool 2: run_sql_query
# ---------------------------------------------------------------------------

@mcp.tool()
def run_sql_query(sql: str) -> str:
    """执行只读 SQL 查询（仅允许 SELECT）。"""
    result = _get_engine().run_sql_query(sql)
    return json.dumps(result, ensure_ascii=False, default=str)


@mcp.tool()
def get_summary_stats(
    date_start: str = "",
    date_end: str = "",
    dimension: str = "",
    top_n: int = 20,
) -> str:
    """获取核心 KPI 概览和维度排名。"""
    result = _get_engine().get_summary_stats(
        date_start=date_start, date_end=date_end,
        dimension=dimension, top_n=top_n,
    )
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
def analyze_trend(
    metric: str = "sales_amount",
    dimension: str = "",
    dimension_value: str = "",
    granularity: str = "day",
    date_start: str = "",
    date_end: str = "",
) -> str:
    """分析时间序列趋势。"""
    result = _get_engine().analyze_trend(
        metric=metric, dimension=dimension,
        dimension_value=dimension_value, granularity=granularity,
        date_start=date_start, date_end=date_end,
    )
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
def compare_segments(
    metric: str = "sales_amount",
    dimension: str = "book_series",
    date_start: str = "",
    date_end: str = "",
) -> str:
    """多维度对比分析——比较当前周期与上一周期的各分段表现。"""
    result = _get_engine().compare_segments(
        metric=metric, dimension=dimension,
        date_start=date_start, date_end=date_end,
    )
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
def drill_down(
    target: str = "整体",
    date_start: str = "",
    date_end: str = "",
) -> str:
    """多维度下钻分析——从多个角度交叉拆解数据，定位变化的根因。"""
    result = _get_engine().drill_down(
        target=target, date_start=date_start, date_end=date_end,
    )
    return json.dumps(result, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="MCP Server — 电商直播销售数据分析 Agent")
    parser.add_argument(
        "--db",
        type=str,
        default=str(ROOT / "web" / "data" / "dashboard.db"),
        help="SQLite 数据库路径 (默认: web/data/dashboard.db)",
    )
    args = parser.parse_args()

    global _engine
    db_path = Path(args.db).resolve()
    if db_path != (ROOT / 'web/data/dashboard.db').resolve():
        raise SystemExit('公开展示版仅允许使用本仓库生成的模拟数据库。')
    import sqlite3
    with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True) as conn:
        info = json.loads(conn.execute("SELECT value FROM meta WHERE key='summary'").fetchone()[0])
        if info.get('data_kind') != 'synthetic':
            raise SystemExit('数据库缺少模拟数据标记，请先运行生成器。')
    _engine = AnalyticsEngine(db_path)

    print(f"[mcp_server] 数据库: {db_path}", flush=True, file=sys.stderr)
    print(f"[mcp_server] MCP Server 启动中...", flush=True, file=sys.stderr)

    # Run with stdio transport (for Claude Code integration)
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
