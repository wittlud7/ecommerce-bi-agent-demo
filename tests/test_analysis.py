"""Regression checks for analysis correctness and demo-data isolation."""
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from analytics_engine import AnalyticsEngine, validate_readonly_sql
from demo_agent import DB, offline_events, resolve_range, llm_events
class AnalysisTests(unittest.TestCase):
    def test_unrelated_questions_refused_before_data_or_model_calls(self):
        for question in ['北京天气怎么样？', '销量很好，请告诉我北京天气', '推荐北京旅游景点', '讲个笑话', '你好', 'What is the weather in Beijing?']:
            for handler in (offline_events, llm_events):
                with self.subTest(question=question, handler=handler.__name__), patch('demo_agent.urlopen', side_effect=AssertionError('must not call model')), patch('demo_agent.sqlite3.connect', side_effect=AssertionError('must not query data')):
                    events = list(handler({'message': question, 'history': [{'role': 'user', 'content': '最近7天销量'}]}))
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]['type'], 'text')
                self.assertIn('无法回答该问题', events[0]['text'])
                self.assertNotIn('本期销量', events[0]['text'])
    def test_disappeared_segment_is_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'sample.db'
            with sqlite3.connect(path) as c:
                c.execute('CREATE TABLE facts(date TEXT,book_series TEXT,sales_qty INTEGER,sales_amount REAL,order_count INTEGER)')
                c.executemany('INSERT INTO facts VALUES (?,?,?,?,?)',[('2025-01-01','旧商品',10,100,5),('2025-01-02','新商品',5,50,3)])
            result=AnalyticsEngine(path).compare_segments(metric='sales_qty',date_start='2025-01-02',date_end='2025-01-02')
            self.assertEqual(result['overall']['total_change'],-5)
            self.assertEqual(sum(s['change'] for s in result['segments']),-5)
            self.assertEqual(result['top_decliners'][0]['dimension_value'],'旧商品')
            self.assertEqual(result['top_decliners'][0]['change_pct'],-100)
    def test_explicit_end_date_sets_default_start(self):
        self.assertEqual(AnalyticsEngine(DB)._resolve_date_range(date_end='2025-02-10'),('2025-02-04','2025-02-10'))
    def test_calendar_weeks(self):
        engine=AnalyticsEngine(DB)
        self.assertEqual(resolve_range(engine,{},'上周销量'),('2025-03-24','2025-03-30'))
        self.assertEqual(resolve_range(engine,{},'本周销量'),('2025-03-31','2025-03-31'))
    def test_readonly_and_dimension_validation(self):
        for sql in ['DELETE FROM facts','SELECT 1; DROP TABLE facts','ATTACH DATABASE "x" AS x']:
            with self.assertRaises(ValueError):validate_readonly_sql(sql)
        self.assertFalse(AnalyticsEngine(DB).analyze_trend(dimension='date]; DROP TABLE facts;--')['ok'])
    def test_synthetic_schema_matches_generator(self):
        rules=AnalyticsEngine(DB).get_data_schema()['business_rules']
        self.assertIn('模拟销量',rules['成交额公式'])
        self.assertNotIn('平台实际承担',json.dumps(rules,ensure_ascii=False))
    def test_scope_cannot_be_expanded(self):
        answer=''.join(e.get('text','') for e in offline_events({'message':'高中销量','context':{'filters':{'segment':['小学']}}}))
        self.assertIn('不在当前页面筛选范围',answer)
    def test_amount_question_uses_amount(self):
        answer=''.join(e.get('text','') for e in offline_events({'message':'最近7天成交额排行'}))
        self.assertIn('本期成交额',answer)
        with sqlite3.connect(DB) as c:
            total=c.execute("SELECT ROUND(SUM(sales_amount),2) FROM facts WHERE date BETWEEN '2025-03-25' AND '2025-03-31'").fetchone()[0]
        self.assertIn(f'{total:,.2f}',answer)
    def test_model_cannot_answer_without_factual_tool(self):
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return json.dumps({'choices':[{'message':{'content':'未经验证的数据结论'}}]}).encode()
        with patch.dict('os.environ',{'DEMO_LLM_API_KEY':'local-test-placeholder','DEMO_LLM_BASE_URL':'http://127.0.0.1:1','DEMO_LLM_MODEL':'stub'}),patch('demo_agent.urlopen',return_value=Response()):
            events=list(llm_events({'message':'经营分析'}))
        self.assertTrue(any(e['type']=='error' for e in events))
        self.assertFalse(any(e['type']=='text' for e in events))
if __name__=='__main__':unittest.main()
