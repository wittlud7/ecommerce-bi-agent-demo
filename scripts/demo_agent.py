"""Inspectable tool workflow, with offline demo and optional LLM tool calling."""
from __future__ import annotations
import inspect
import json
import os
import re
import sqlite3
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from analytics_engine import AnalyticsEngine
from dashboard_queries import FILTER_FIELD_MAP

DB = Path(__file__).resolve().parents[1] / 'web/data/dashboard.db'
DIMENSIONS = {'book_series', 'store', 'source_type', 'source_group', 'province', 'subject', 'segment', 'content_type', 'project_department', 'source_department', 'source_manager', 'grade', 'version', 'traffic_channel', 'price_band', 'order_hour', 'order_weekday'}
TOOL_SPECS = {
    'get_data_schema': ('读取模拟数据字典和日期范围。', {}),
    'get_summary_stats': ('读取期间汇总和维度排行。', {'date_start': 'string', 'date_end': 'string', 'dimension': 'string', 'top_n': 'integer'}),
    'compare_segments': ('比较当前周期和上一等长周期，返回各维度增减贡献。', {'date_start': 'string', 'date_end': 'string', 'dimension': 'string', 'metric': 'string'}),
    'drill_down': ('对指定模拟对象做多维下钻，传整体或已存在的名称。', {'date_start': 'string', 'date_end': 'string', 'target': 'string'}),
    'analyze_trend': ('计算日/周/月趋势与波动。', {'date_start': 'string', 'date_end': 'string', 'dimension': 'string', 'dimension_value': 'string', 'metric': 'string', 'granularity': 'string'}),
    'run_sql_query': ('对已按页面维度限定的模拟事实执行单条只读 SELECT，不允许写入。', {'sql': 'string'}),
}
TOOLS = [{'type': 'function', 'function': {'name': name, 'description': desc, 'parameters': {'type': 'object', 'properties': {k: {'type': v} for k, v in args.items()}, 'additionalProperties': False}}} for name, (desc, args) in TOOL_SPECS.items()]

UNRELATED = re.compile(r'天气|气温|下雨|降雨|气象|旅游|景点|机票|酒店|笑话|写诗|作文|翻译|星座|八字|股票|股价|基金|彩票|比特币|新闻|政治|总统|菜谱|做饭|医疗|疾病|写代码|编程|系统提示词|system\s*prompt|weather|forecast\s+weather', re.I)
BUSINESS = re.compile(r'销售|销量|成交|金额|渠道|书系|店铺|负责人|账号|达人|商品|产品|订单|售后|退货|库存|地域|地区|省份|学段|小学|初中|高中|日报|周报|月报|环比|同比|对比|趋势|下滑|增长|排行|排名|前十|来源|贡献|经营|数据字典|数据结构|字段|客单价|价格带|时段')
SCOPE_REFUSAL = '无法回答该问题：本助手仅支持本演示数据范围内的经营分析，不回答天气、旅游、新闻等无关问题。请明确期间、指标或分析对象，例如“最近7天哪个书系下滑最多？”或“最近7天小学成交额排行”。'

def outside_business_scope(payload):
    message = str(payload.get('message', ''))[:3000]
    return bool(UNRELATED.search(message)) or not BUSINESS.search(message)

def context_scope(payload):
    context = payload.get('context')
    context = context if isinstance(context, dict) else {}
    filters = context.get('filters', {})
    filters = filters if isinstance(filters, dict) else {}
    clean = {}
    for key, column in FILTER_FIELD_MAP.items():
        values = filters.get(key, [])
        if isinstance(values, list):
            selected = [str(v)[:100] for v in values[:20] if v and v != '__all__']
            if selected:
                clean[column] = selected
    return context, clean

@contextmanager
def scoped_engine(filters):
    # Materialize ONLY the public demo rows in the requested dimension scope.
    # Date scope stays available for the previous-period comparison tool.
    with tempfile.TemporaryDirectory(prefix='synthetic-agent-') as temp:
        path = Path(temp) / 'scope.db'
        conn = sqlite3.connect(path)
        conn.execute('ATTACH DATABASE ? AS source', (str(DB),))
        clauses, args = [], []
        for col, values in filters.items():
            if col not in FILTER_FIELD_MAP.values():
                continue
            clauses.append(f'[{col}] IN ({",".join("?" for _ in values)})')
            args.extend(values)
        where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
        conn.execute('CREATE TABLE facts AS SELECT * FROM source.facts' + where, args)
        conn.commit()
        conn.close()
        yield AnalyticsEngine(path)

def run_tool(engine, name, args):
    if name not in TOOL_SPECS or not isinstance(args, dict):
        return {'ok': False, 'error': '不支持的分析工具'}
    allowed = TOOL_SPECS[name][1]
    args = {k: v for k, v in args.items() if k in allowed}
    if args.get('dimension') and args['dimension'] not in DIMENSIONS:
        return {'ok': False, 'error': '不支持的分析维度'}
    try:
        if 'top_n' in args:
            args['top_n'] = min(20, max(1, int(args['top_n'])))
        result = getattr(engine, name)(**args)
        result.pop('database_path', None)
        return result
    except Exception:
        return {'ok': False, 'error': '工具参数不合法或查询未完成，请检查期间、维度与对象。'}

def resolve_range(engine, context, message):
    result = engine.run_sql_query('SELECT MIN(date) earliest, MAX(date) latest FROM facts')
    bounds = [dict(zip(result.get('columns', []), row)) for row in result.get('rows', [])]
    if not bounds or not bounds[0].get('latest'):
        return '', ''
    latest = datetime.strptime(bounds[0]['latest'], '%Y-%m-%d')
    earliest = bounds[0]['earliest']
    explicit = re.findall(r'20\d{2}-\d{2}-\d{2}', message)
    if len(explicit) >= 2:
        return explicit[0], explicit[1]
    if '昨日' in message or '昨天' in message:
        # Demonstration dates are anchored to the latest complete dataset day.
        return latest.strftime('%Y-%m-%d'), latest.strftime('%Y-%m-%d')
    if '本周' in message or '上周' in message:
        monday = latest - timedelta(days=latest.weekday())
        start = monday - timedelta(days=7) if '上周' in message else monday
        end = monday - timedelta(days=1) if '上周' in message else latest
        return max(earliest, start.strftime('%Y-%m-%d')), end.strftime('%Y-%m-%d')
    days = 30 if '30天' in message or '30 天' in message else 7
    if '全量' in message or '全部日期' in message:
        return earliest, latest.strftime('%Y-%m-%d')
    if not re.search(r'最近|近[七7三30]|本周|上周|周期|昨日|昨天', message):
        start, end = context.get('date_start', ''), context.get('date_end', '')
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(start)) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(end)):
            return start, end
    return max(earliest, (latest - timedelta(days=days-1)).strftime('%Y-%m-%d')), latest.strftime('%Y-%m-%d')

def offline_events(payload):
    if outside_business_scope(payload):
        yield {'type': 'text', 'text': SCOPE_REFUSAL}
        return
    message = str(payload.get('message', ''))[:3000]
    context, filters = context_scope(payload)
    # Explicit names in the question refine the page's scope, without invented entities.
    with sqlite3.connect(DB) as conn:
        for column in ('book_series', 'store', 'source_manager', 'province', 'segment', 'content_type'):
            names = [r[0] for r in conn.execute(f'SELECT DISTINCT [{column}] FROM facts')]
            selected = [name for name in names if name and name in message]
            if selected:
                if column in filters:
                    selected = [name for name in selected if name in filters[column]]
                    if not selected:
                        yield {'type': 'text', 'text': '提问对象不在当前页面筛选范围内。请先修改对应筛选后再提问，不会自动扩大查询范围。'}
                        return
                filters[column] = selected
    yield {'type': 'status', 'message': '离线规则演示：识别问题、当前筛选和模拟数据日期范围'}
    with scoped_engine(filters) as engine:
        start, end = resolve_range(engine, context, message)
        if not start:
            yield {'type': 'text', 'text': '当前筛选没有模拟数据。请清除部分条件后重试；不会自动扩大到未选择的业务对象。'}
            return
        dimension = 'content_type' if any(k in message for k in ('渠道', '直播', '短视频', '商品卡')) else 'province' if any(k in message for k in ('地区', '省份', '地域')) else 'source_manager' if '负责人' in message else 'book_series'
        scope_note = '；'.join(f'{k}={"、".join(v)}' for k, v in filters.items()) or '全部模拟业务对象'
        yield {'type': 'tool', 'tool': 'get_summary_stats', 'message': f'只读查询 get_summary_stats：{start} 至 {end}'}
        summary = run_tool(engine, 'get_summary_stats', {'date_start': start, 'date_end': end, 'dimension': dimension, 'top_n': 5})
        yield {'type': 'tool', 'tool': 'compare_segments', 'message': f'执行 compare_segments：按 {dimension} 对比上一等长周期'}
        metric = 'sales_amount' if any(w in message for w in ('金额', '成交额', '销售额')) else 'sales_qty'
        metric_label = '成交额' if metric == 'sales_amount' else '销量'
        comparison = run_tool(engine, 'compare_segments', {'date_start': start, 'date_end': end, 'dimension': dimension, 'metric': metric})
        yield {'type': 'tool', 'tool': 'analyze_trend', 'message': '执行 analyze_trend：核对期间走势，区分数据变化与原因假设'}
        trend = run_tool(engine, 'analyze_trend', {'date_start': start, 'date_end': end, 'metric': metric})
        overall = summary.get('overall', {})
        segments = comparison.get('segments', [])
        current_total = comparison.get('overall', {}).get('current_total', 0)
        previous_total = comparison.get('overall', {}).get('previous_total', 0)
        diff = current_total - previous_total
        change = f'{diff / previous_total:+.1%}' if previous_total else '前期为零，不计算增长率'
        is_daily = any(k in message for k in ('日报', '昨日', '昨天', '排名', '排行', '前十'))
        limit = 10 if is_daily else {'concise': 3, 'executive': 5, 'detailed': 8}.get(payload.get('output_style'), 5)
        selected = sorted(segments, key=lambda r: r['current_value'], reverse=True)[:limit] if is_daily else sorted(segments, key=lambda r: r['change'])[:limit] if any(x in message for x in ('下滑', '下降', '减少')) else sorted(segments, key=lambda r: r['change'], reverse=True)[:limit]
        lines = [
            '> 公开模拟数据 · 离线规则演示（未调用大模型，不代表真实经营建议）',
            '', '## 核心结论',
            f'{start} 至 {end}，当前筛选模拟销量 **{overall.get("total_sales_qty", 0):,}**，模拟成交额 **¥{overall.get("total_sales_amount", 0):,.2f}**。相比上一等长周期，{metric_label}变化 **{diff:+,.2f}（{change}）**。',
            '', f'范围：{scope_note}。本期日序列走势：{trend.get("trend_analysis", {}).get("direction", "暂无数据")}（与跨周期环比是不同观察角度）。',
            '', '## 数据证据', f'| 模拟对象 | 本期{metric_label} | 前期{metric_label} | 净变化 |', '|---|---:|---:|---:|',
        ]
        lines.extend(f'| {s["dimension_value"]} | {s["current_value"]:,.2f} | {s["previous_value"]:,.2f} | {s["change"]:+,.2f} |' for s in selected)
        if is_daily and dimension == 'book_series':
            yield {'type': 'tool', 'tool': 'get_summary_stats', 'message': '按当前学段范围汇总商品排行和主要渠道'}
            result = engine.run_sql_query('SELECT book_series, segment FROM facts GROUP BY book_series, segment')
            stages = dict(result.get('rows', []))
            lines += ['', '## 学段与商品排行（模拟）', '| 学段 | 商品 | 销量 | 成交额 |', '|---|---|---:|---:|']
            for stage in ('小学', '初中', '高中'):
                for item in [r for r in selected if stages.get(r['dimension_value']) == stage][:10]:
                    lines.append(f'| {stage} | {item["dimension_value"]} | {item["sales_qty"]:,} | ¥{item["sales_amount"]:,.2f} |')
            channel = run_tool(engine, 'get_summary_stats', {'date_start': start, 'date_end': end, 'dimension': 'content_type', 'top_n': 5})
            lines += ['', '主要渠道（模拟）：' + '；'.join(f'{r["value"]} {r["sales_qty"]:,} 件' for r in channel.get('top_segments', [])) + '。']
        lines += ['', '## 风险与待验证假设',
                  '- 上表是模拟数据的维度拆解，贡献变化本身不证明因果。',
                  '- 活动排期、流量、库存和人员调整未在演示数据中提供，不能据此断言原因。',
                  '- 日期锚定模拟数据最新完整日；“昨日”演示为该最新日，不使用电脑当天日期。',
                  '', '## 优先动作',
                  '- 优先复核变化最大的对象及同口径数据，再讨论销售方向。',
                  '- 如需解释原因，补充活动、流量、价格与库存证据；负责人和完成时间由业务方确认。',
                  '', '## 工具过程',
                  '`范围识别 → get_summary_stats → compare_segments → analyze_trend → 证据与建议`',
                  '', '可信度：模拟查询结果为演示事实；维度变化为计算结果；业务原因为待验证假设。']
        answer = '\n'.join(lines)
        for offset in range(0, len(answer), 140):
            yield {'type': 'text', 'text': answer[offset:offset+140]}

def llm_events(payload):
    if outside_business_scope(payload):
        yield {'type': 'text', 'text': SCOPE_REFUSAL}
        return
    api_key = os.environ.get('DEMO_LLM_API_KEY', '')
    base = os.environ.get('DEMO_LLM_BASE_URL', '').rstrip('/')
    model = os.environ.get('DEMO_LLM_MODEL', '')
    if not api_key or not model or not base:
        yield {'type': 'error', 'message': 'LLM 模式需要自行配置 DEMO_LLM_API_KEY、DEMO_LLM_BASE_URL 和 DEMO_LLM_MODEL。'}
        return
    if not base.startswith('https://') and not base.startswith(('http://127.0.0.1:', 'http://localhost:')):
        yield {'type': 'error', 'message': '模型地址必须使用 HTTPS，或本机回环地址。'}
        return
    context, filters = context_scope(payload)
    with scoped_engine(filters) as engine:
        start, end = resolve_range(engine, context, str(payload.get('message', '')))
        prompt = f'''你是公开作品 Demo Agent，所有数据均为独立生成的模拟数据。当前分析期间 {start} 至 {end}；页面维度筛选已在查询数据库强制执行。
先用工具查询再回答。优先使用汇总、周期对比、下钻与趋势工具；仅在必要时使用只读 SQL。需要查询历史时可使用模拟数据库内的其他期间。
每个回答明确标注模拟数据。按核心结论、数据证据、维度拆解、待验证假设、优先动作组织；区分事实、推导与假设；不得虚构活动/库存/投流原因、负责人、日期或工具结果。
图表只在本地看板展示，Markdown 表格最多4列。输出风格为 {payload.get('output_style', 'concise')}。不要提供执行采购、改库或回写业务的操作。'''
        messages = [{'role': 'system', 'content': prompt}]
        history = payload.get('history', [])
        if isinstance(history, list):
            for entry in history[-6:]:
                if isinstance(entry, dict) and entry.get('role') in ('user', 'assistant'):
                    messages.append({'role': entry['role'], 'content': str(entry.get('content', ''))[:2000]})
        messages.append({'role': 'user', 'content': str(payload.get('message', ''))[:3000]})
        factual_tool_ok = False
        for turn in range(6):
            yield {'type': 'status', 'message': f'LLM 工具调用模式 · 第 {turn+1} 轮（仅模拟数据）'}
            body = {'model': model, 'messages': messages, 'tools': TOOLS, 'tool_choice': 'auto', 'max_tokens': 2000, 'stream': False}
            request = Request(base + '/chat/completions', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + api_key, 'Content-Type': 'application/json'})
            try:
                with urlopen(request, timeout=45) as response:
                    result = json.loads(response.read(2_000_000))
                message = result['choices'][0]['message']
            except Exception:
                yield {'type': 'error', 'message': '模型请求失败，请在本机检查配置和供应商服务。错误信息不会回显密钥或请求头。'}
                return
            calls = message.get('tool_calls') or []
            if not calls:
                if not factual_tool_ok:
                    yield {'type': 'error', 'message': '模型未成功查询业务数据，本次不输出未经工具支持的经营结论。请重试。'}
                    return
                answer = '> 公开模拟数据 · LLM 工具调用模式\n\n' + str(message.get('content') or '模型未返回正文。')
                for offset in range(0, len(answer), 140):
                    yield {'type': 'text', 'text': answer[offset:offset+140]}
                return
            messages.append({'role': 'assistant', 'content': message.get('content'), 'tool_calls': calls[:6]})
            for call in calls[:6]:
                name = call.get('function', {}).get('name', '')
                yield {'type': 'tool', 'tool': name, 'message': f'正在执行只读模拟数据工具：{name}'}
                try:
                    args = json.loads(call['function'].get('arguments', '{}'))
                    output = run_tool(engine, name, args)
                except Exception:
                    output = {'ok': False, 'error': '工具参数无法解析'}
                # Keep model context bounded without chopping valid JSON in half.
                content = json.dumps(output, ensure_ascii=False)
                within_limit = len(content) <= 18000
                if not within_limit:
                    content = json.dumps({'ok': False, 'error': '查询结果过大，请缩小查询范围或使用汇总工具。'}, ensure_ascii=False)
                if output.get('ok') and name != 'get_data_schema' and within_limit:
                    factual_tool_ok = True
                messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': content})
        yield {'type': 'error', 'message': '已达到工具调用轮数限制，请缩小问题范围。'}
