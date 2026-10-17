#!/usr/bin/env python3
"""Local portfolio server. No production accounts, credentials or connectors."""
from __future__ import annotations
import argparse
import gzip
import json
import mimetypes
import sqlite3
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from dashboard_queries import load_dashboard_from_db, query_overview_facts, query_table_rows, FILTER_FIELD_MAP
from demo_agent import offline_events, llm_events
from generate_demo_data import generate

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'web'
DB = WEB / 'data/dashboard.db'

class DemoHandler(BaseHTTPRequestHandler):
    server_version = 'SyntheticPortfolio/1.0'
    def log_message(self, fmt, *args):
        # Do not persist questions, headers or payloads to a file.
        pass

    def send_json(self, obj, status=200):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        compressed = 'gzip' in self.headers.get('Accept-Encoding', '')
        data = gzip.compress(raw) if compressed else raw
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if compressed:
            self.send_header('Content-Encoding', 'gzip')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ('/api/me', '/api/health'):
            return self.send_json({'ok': True, 'username': 'demo-viewer', 'role': 'admin', 'must_change': False,
                                   'agent_mode': self.server.agent_mode, 'data_kind': 'synthetic'})
        params = parse_qs(parsed.query)
        try:
            if parsed.path == '/api/dashboard-data':
                filters = {}
                for key, col in FILTER_FIELD_MAP.items():
                    value = params.get(key, params.get(col, ['']))[0]
                    if value:
                        filters[col] = [v for v in value.split(',') if v and v != '__all__'][:20]
                payload = load_dashboard_from_db(params.get('date_start', [''])[0], params.get('date_end', [''])[0], 'admin', [], filters)
                end = params.get('date_end', [''])[0] or payload['summary']['date_max']
                start = (datetime.strptime(end, '%Y-%m-%d') - timedelta(days=13)).strftime('%Y-%m-%d')
                with sqlite3.connect(DB) as conn:
                    payload['comparison_facts'] = query_overview_facts(conn, start, end, [])
                return self.send_json(payload)
            if parsed.path == '/api/table-data':
                with sqlite3.connect(DB) as conn:
                    rows = query_table_rows(conn, params.get('tab', ['series'])[0], params, [])
                return self.send_json({'ok': True, 'rows': rows, 'data_kind': 'synthetic'})
        except Exception:
            return self.send_json({'ok': False, 'message': '模拟数据查询失败，请重新生成演示数据。'}, 500)
        # Explicit static-file allowlist: never expose .env, private files, scripts or DB.
        path = unquote(parsed.path).lstrip('/') or 'index.html'
        file = (WEB / path).resolve()
        permitted = path in {'index.html', 'app.js', 'styles.css'} or path.startswith(('assets/', 'vendor/'))
        if not permitted or not file.is_relative_to(WEB.resolve()) or not file.is_file() or any(part.startswith('.') for part in Path(path).parts):
            return self.send_json({'ok': False, 'message': 'Not found'}, 404)
        raw = file.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store' if file.suffix in {'.html', '.js'} else 'public, max-age=3600')
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        if urlparse(self.path).path != '/api/chat':
            return self.send_json({'ok': False, 'message': 'Not found'}, 404)
        # Prevent other origins from using a locally configured model key.
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            return self.send_json({'ok': False, 'message': 'Origin rejected'}, 403)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 32768:
                return self.send_json({'ok': False, 'message': '请求过大或为空'}, 400)
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict) or not str(payload.get('message', '')).strip():
                return self.send_json({'ok': False, 'message': '请输入分析问题'}, 400)
        except (ValueError, TypeError):
            return self.send_json({'ok': False, 'message': '请求格式不正确'}, 400)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()
        start = time.monotonic()
        def send(event, obj):
            self.wfile.write(f'event: {event}\ndata: {json.dumps(obj, ensure_ascii=False)}\n\n'.encode())
            self.wfile.flush()
        try:
            events = llm_events(payload) if self.server.agent_mode == 'llm' else offline_events(payload)
            for event in events:
                send('message', event)
            send('done', {'elapsed_ms': round((time.monotonic()-start)*1000), 'data_kind': 'synthetic', 'agent_mode': self.server.agent_mode})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            try:
                send('message', {'type': 'error', 'message': '分析未完成，请缩小范围后重试。'})
                send('done', {'elapsed_ms': round((time.monotonic()-start)*1000)})
            except (BrokenPipeError, ConnectionResetError):
                pass

def main():
    parser = argparse.ArgumentParser(description='公开模拟数据 BI 与 Agent 演示')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--llm', action='store_true', help='显式启用外部模型；须自行配置 DEMO_LLM_* 环境变量')
    parser.add_argument('--regenerate', action='store_true', help='从固定种子重新生成模拟数据库')
    args = parser.parse_args()
    if args.regenerate or not DB.exists():
        generate()
    with sqlite3.connect(DB) as conn:
        record = conn.execute("SELECT value FROM meta WHERE key='summary'").fetchone()
        if not record or json.loads(record[0]).get('data_kind') != 'synthetic':
            raise SystemExit('演示服务只允许读取本项目生成的模拟数据库。')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), DemoHandler)
    server.agent_mode = 'llm' if args.llm else 'offline'
    print(f'Portfolio: http://127.0.0.1:{args.port} | synthetic data | agent: {server.agent_mode}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
