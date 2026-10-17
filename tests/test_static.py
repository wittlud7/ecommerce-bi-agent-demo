"""Compare browser-local aggregation to authoritative SQLite calculations."""
import json
import shutil
import sqlite3
import subprocess
import sys
import unittest
from pathlib import Path
from urllib.parse import parse_qs
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from build_static import build
from dashboard_queries import load_dashboard_from_db, query_table_rows, FILTER_FIELD_MAP
from demo_agent import DB

@unittest.skipUnless(shutil.which('node'),'Node.js required for static adapter contract checks')
class StaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):build()
    def query(self,inputs):
        p=subprocess.run(['node','tests/static_contract.cjs'],input=json.dumps(inputs),text=True,capture_output=True,cwd=ROOT,check=True)
        return json.loads(p.stdout)
    def test_dashboard_aggregates_match_sqlite(self):
        queries=['date_start=2025-03-25&date_end=2025-03-31','date_start=2025-03-02&date_end=2025-03-31','date_start=2025-02-01&date_end=2025-02-07&segment=小学','date_start=2025-01-20&date_end=2025-01-26&contentType=直播&store=演示旗舰店A']
        results=self.query([{'url':'./api/dashboard-data?'+q} for q in queries])
        for query,actual in zip(queries,results):
            params=parse_qs(query)
            filters={FILTER_FIELD_MAP[k]:v[0].split(',') for k,v in params.items() if k in FILTER_FIELD_MAP}
            expected=load_dashboard_from_db(params['date_start'][0],params['date_end'][0],'admin',[],filters)
            for key in ['valid_sales_qty','valid_sales_amount','valid_order_count']:
                self.assertEqual(actual['summary'][key],expected['summary'][key])
            for dim in ['region','hour','price_band','aftersale']:
                fields=set(expected['dimensions'][dim][0]) if expected['dimensions'][dim] else set()
                normalized=lambda rows:sorted(json.dumps({k:float(r[k]) if isinstance(r[k],(float,int)) else r[k] for k in fields},sort_keys=True,ensure_ascii=False) for r in rows)
                self.assertEqual(normalized(actual['dimensions'][dim]),normalized(expected['dimensions'][dim]),(query,dim))
    def test_all_table_tabs_match_sqlite(self):
        tabs=['series','source','product','influencer']
        query='date_start=2025-03-25&date_end=2025-03-31&segment=初中'
        results=self.query([{'url':f'./api/table-data?tab={tab}&{query}'} for tab in tabs])
        with sqlite3.connect(DB) as c:
            for tab,actual in zip(tabs,results):
                expected=query_table_rows(c,tab,parse_qs(query),[])
                self.assertEqual(sum(r['sales_qty'] for r in actual['rows']),sum(r['sales_qty'] for r in expected))
                self.assertAlmostEqual(sum(r['sales_amount'] for r in actual['rows']),sum(r['sales_amount'] for r in expected),places=2)
                self.assertEqual(len(actual['rows']),len(expected))
    def test_agent_uses_selected_scope_and_metric(self):
        body={'message':'最近7天成交额排行','context':{'filters':{'segment':['小学']}}}
        result=self.query([{'url':'./api/chat','options':{'method':'POST','body':json.dumps(body)},'text':True}])[0]
        with sqlite3.connect(DB) as c:
            amount=c.execute("SELECT ROUND(SUM(sales_amount),2) FROM facts WHERE segment='小学' AND date BETWEEN '2025-03-25' AND '2025-03-31'").fetchone()[0]
        self.assertIn(f'{amount:,.2f}',result)
        self.assertIn('本期成交额',result)
        self.assertNotIn('示例·几何探险',result)
        self.assertIn('event: done',result)
    def test_no_keys_or_backend_in_static_export(self):
        self.assertFalse(list((ROOT/'site').rglob('*.db')))
        self.assertFalse((ROOT/'site/scripts').exists())
        self.assertIn('./static-runtime.js',(ROOT/'site/index.html').read_text())
