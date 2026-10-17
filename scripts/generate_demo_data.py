#!/usr/bin/env python3
"""Generate a new synthetic dataset without opening any business source file.

Fixed seed and fictional catalog: this is independent simulation, not masking,
sampling, shuffling, scaling, or perturbation of company records.
"""
from __future__ import annotations
import json
import math
import random
import sqlite3
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / 'web/data/dashboard.db'
SEED = 20261017
START = date(2025, 1, 1)
DAYS = 90
FIELDS = '''store date order_hour order_weekday project_department project_owner
book_series book_series_code series_group segment grade subject version merchant_code
product_name match_method source_owner source_type source_detail source_department
source_group source_group_label source_manager influencer_id influencer_name content_type
traffic_channel traffic_type ad_channel price_band aftersale_status province city highlight_type
sales_qty order_count sales_amount highlight_qty'''.split()
CATALOG = [
    ('示例·星轨数学', '小学', '数学', 26, 'growth'),
    ('示例·纸船阅读', '小学', '语文', 32, 'stable'),
    ('示例·青芽英语', '小学', '英语', 19, 'decline'),
    ('示例·几何探险', '初中', '数学', 45, 'growth'),
    ('示例·文字漫游', '初中', '语文', 36, 'decline'),
    ('示例·语感训练', '初中', '英语', 58, 'stable'),
    ('示例·函数旅程', '高中', '数学', 76, 'stable'),
    ('示例·阅读进阶', '高中', '语文', 95, 'growth'),
    ('示例·词汇地图', '高中', '英语', 128, 'decline'),
]
REGIONS = [
    ('北京市', '北京市'), ('上海市', '上海市'), ('浙江省', '杭州市'),
    ('浙江省', '宁波市'), ('广东省', '广州市'), ('广东省', '深圳市'),
    ('四川省', '成都市'), ('江苏省', '南京市'), ('湖北省', '武汉市'),
    ('山东省', '济南市'), ('河南省', '郑州市'), ('陕西省', '西安市'),
]
CHANNELS = [
    ('直播', '自营直播', '演示直播组'),
    ('短视频', '自营短视频', '演示内容组'),
    ('商品卡', '自营商品卡', '演示货架组'),
    ('直播', '精选联盟', '演示合作组'),
]

def band(price):
    for upper, label in [(20, '0-20元'), (40, '20-40元'), (60, '40-60元'), (100, '60-100元'), (200, '100-200元')]:
        if price < upper:
            return label
    return '200元以上'

def generate():
    rng = random.Random(SEED)
    rows = []
    for day in range(DAYS):
        current = START + timedelta(days=day)
        for idx, (series, segment, subject, price, scenario) in enumerate(CATALOG):
            # Scenario patterns are authored here, never fitted to real sales.
            trend = 1 + day / 110 if scenario == 'growth' else max(.3, 1.4 - day / 90) if scenario == 'decline' else 1
            for shop in range(3):
                for channel_id, (content, source, group) in enumerate(CHANNELS):
                    campaign = 1.8 if (day % 21 in (12, 13) and channel_id == 0) else 1
                    weekday = 1.25 if current.weekday() >= 5 else 1
                    qty = max(1, round(rng.randint(12, 48) * trend * campaign * weekday * (1 + .12 * math.sin(day / 3 + idx))))
                    orders = max(1, math.ceil(qty / rng.uniform(1.05, 1.6)))
                    unit_price = round(price * rng.uniform(.86, 1.08), 2)
                    amount = round(qty * unit_price, 2)
                    province, city = rng.choice(REGIONS)
                    person = f'演示负责人{chr(65 + (shop + channel_id) % 4)}'
                    account = f'演示账号-{shop + 1}{channel_id + 1}'
                    matching = '标题识别' if rng.random() < .07 else '自编码匹配'
                    status = rng.choices(['-', '退款成功', '退款处理中', '退货成功', '售后关闭'], weights=[88, 4, 2, 4, 2])[0]
                    companion = rng.random() < .1
                    record = {
                        'store': f'演示旗舰店{chr(65 + shop)}', 'date': current.isoformat(),
                        'order_hour': str(rng.choice([9, 10, 11, 12, 14, 16, 18, 19, 20, 21, 22])),
                        'order_weekday': str((current.weekday() + 1) % 7),
                        'project_department': f'演示{segment}产品组', 'project_owner': f'演示产品负责人{idx // 3 + 1}',
                        'book_series': series, 'book_series_code': f'DEMO-S{idx + 1:03d}',
                        'series_group': f'演示{segment}系列', 'segment': segment, 'grade': f'{segment}示例年级',
                        'subject': subject, 'version': '演示2025版', 'merchant_code': f'DEMO-P{idx + 1:04d}',
                        'product_name': f'{series}·{subject}演示单册', 'match_method': matching,
                        'source_owner': person, 'source_type': source, 'source_detail': account,
                        'source_department': f'演示销售{shop + 1}部', 'source_group': group,
                        'source_group_label': group, 'source_manager': person,
                        'influencer_id': f'DEMO-A{shop + 1}{channel_id + 1}', 'influencer_name': account,
                        'content_type': content, 'traffic_channel': f'演示{content}流量',
                        'traffic_type': '演示自然流量', 'ad_channel': '不适用（模拟）', 'price_band': band(unit_price),
                        'aftersale_status': status, 'province': province, 'city': city,
                        'highlight_type': '示例赠品（套装附带）' if companion else '',
                        'sales_qty': qty, 'order_count': orders, 'sales_amount': amount,
                        'highlight_qty': qty if companion else 0,
                    }
                    rows.append(record)
    # Always create a brand-new SQLite file, including its empty pages.
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    new_path = DB_PATH.with_suffix('.new.db')
    new_path.unlink(missing_ok=True)
    c = sqlite3.connect(new_path)
    definitions = ', '.join(f'[{f}] ' + ('INTEGER' if f in ('sales_qty', 'order_count', 'highlight_qty') else 'REAL' if f == 'sales_amount' else 'TEXT') for f in FIELDS)
    c.execute(f'CREATE TABLE facts ({definitions})')
    c.executemany(f"INSERT INTO facts VALUES ({','.join('?' for _ in FIELDS)})", [tuple(row[f] for f in FIELDS) for row in rows])
    for table, dims in {
        'agg_region': ['province', 'city', 'date', 'book_series', 'segment'],
        'agg_hour': ['order_hour AS hour', 'order_weekday AS weekday', 'book_series', 'source_type'],
        'agg_price_band': ['price_band', 'book_series', 'segment'],
        'agg_aftersale': ['aftersale_status', 'book_series', 'store', 'province', 'date', 'segment'],
    }.items():
        group = ','.join(d.split(' AS ')[0] for d in dims)
        c.execute(f"CREATE TABLE {table} AS SELECT {','.join(dims)}, SUM(sales_qty) sales_qty,SUM(order_count) order_count,ROUND(SUM(sales_amount),2) sales_amount FROM facts GROUP BY {group}")
    qty, orders, amount = c.execute('SELECT SUM(sales_qty),SUM(order_count),ROUND(SUM(sales_amount),2) FROM facts').fetchone()
    attribution = sum(r['sales_qty'] for r in rows if r['match_method'] == '自编码匹配') / qty
    summary = {
        'data_kind': 'synthetic', 'date_min': START.isoformat(), 'date_max': (START + timedelta(days=DAYS - 1)).isoformat(),
        'import_batch_id': 'SYNTHETIC-SEED-20261017', 'valid_sales_qty': qty, 'valid_sales_amount': amount,
        'valid_order_count': orders, 'fact_count': len(rows), 'product_match_rate': attribution,
        'series_attribution_rate': 1, 'sales_amount_formula': '模拟销量 × 独立生成的模拟单价（不代表企业成交额）',
        'roi_note': '演示未生成广告费用，暂不计算 ROI',
    }
    checks = {
        'daily_total_equals_valid_qty': sum(r[0] for r in c.execute('SELECT SUM(sales_qty) FROM facts GROUP BY date')) == qty,
        'fact_total_equals_valid_qty': sum(r['sales_qty'] for r in rows) == qty,
        'source_total_equals_valid_qty': sum(r[0] for r in c.execute('SELECT SUM(sales_qty) FROM facts GROUP BY source_type')) == qty,
        'fact_total_equals_valid_amount': round(sum(r['sales_amount'] for r in rows), 2) == amount,
        'date_count': DAYS, 'segment_keyword_conflict_sales_qty': 0,
        'top_segment_keyword_conflicts': [], 'top_unmatched_products': [], 'top_unrecognized_sources': [],
    }
    c.execute('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    c.executemany('INSERT INTO meta VALUES (?,?)', [(k, json.dumps(v, ensure_ascii=False)) for k, v in [('summary', summary), ('quality_checks', checks), ('dimensions', {})]])
    c.execute('CREATE INDEX idx_facts_date ON facts(date)')
    c.commit()
    c.close()
    new_path.replace(DB_PATH)
    provenance = {
        'data_kind': 'independently_generated_synthetic_data', 'seed': SEED,
        'row_count': len(rows), 'days': DAYS, 'date_start': START.isoformat(),
        'date_end': (START + timedelta(days=DAYS - 1)).isoformat(),
        'source_business_files_read': 0, 'original_record_mapping': False,
        'description': '全部商品、店铺、人员、账号、价格、数量、日期分布及售后数据由固定种子独立生成；没有原始记录映射，不保留企业真实分布。省市边界是通用地理底图。',
        'scenarios': ['示例增长', '示例下滑', '示例平稳', '人为设定的周期峰值'],
    }
    (ROOT / 'web/data/provenance.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n')
    print(f'Generated {len(rows):,} synthetic fact rows, {DAYS} days, {len(CATALOG)} fictional products.')

if __name__ == '__main__':
    generate()
