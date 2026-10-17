#!/usr/bin/env python3
"""Local pre-publication check for this synthetic portfolio (no network)."""
from __future__ import annotations
import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_NAMES = {'.env', '.mcp.json', 'users.json', 'permissions.json', '.codex', '.claude', '.agents'}
FORBIDDEN_SUFFIXES = {'.xlsx', '.xls', '.csv', '.7z', '.zip', '.log', '.bak', '.pem', '.key', '.pyc'}
SECRET_PATTERNS = [
    re.compile(rb'(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{24,}'),
    re.compile(rb'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----'),
    re.compile(rb'(?i)(?:api[_-]?key|access[_-]?token|password[_-]?hash)\s*[=:]\s*[\x22\x27][A-Za-z0-9_+/-]{24,}[\x22\x27]'),
]

def check():
    errors = []
    ignored = []
    for path in ROOT.rglob('*'):
        rel = path.relative_to(ROOT)
        if '.git' in rel.parts:
            continue  # Fresh repository metadata is local, never part of release archives.
        if '__pycache__' in rel.parts or '.DS_Store' in rel.parts:
            ignored.append(str(rel))
            continue
        if path.is_symlink():
            errors.append(f'不允许符号链接: {rel}')
        if path.name in FORBIDDEN_NAMES or path.suffix.lower() in FORBIDDEN_SUFFIXES:
            errors.append(f'存在不应发布的文件/目录: {rel}')
        if path.is_file() and path.suffix == '.db' and str(rel) != 'web/data/dashboard.db':
            errors.append(f'存在额外数据库: {rel}')
        if path.is_file():
            data = path.read_bytes()
            if any(pattern.search(data) for pattern in SECRET_PATTERNS):
                errors.append(f'检测到疑似凭据: {rel}（不会输出其内容）')
    provenance = json.loads((ROOT / 'web/data/provenance.json').read_text())
    if provenance.get('source_business_files_read') != 0 or provenance.get('original_record_mapping') is not False:
        errors.append('数据来源声明不符合独立模拟要求')
    with sqlite3.connect(f'file:{ROOT / "web/data/dashboard.db"}?mode=ro', uri=True) as c:
        if c.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            errors.append('模拟库完整性检查未通过')
        summary = json.loads(c.execute("SELECT value FROM meta WHERE key='summary'").fetchone()[0])
        rows, first, last = c.execute('SELECT COUNT(*),MIN(date),MAX(date) FROM facts').fetchone()
        if rows != provenance['row_count'] or first != provenance['date_start'] or last != provenance['date_end'] or summary.get('data_kind') != 'synthetic':
            errors.append('数据库与模拟数据来源声明不一致')
        for field, prefix in {
            'store': '演示', 'book_series': '示例·', 'product_name': '示例·',
            'project_owner': '演示', 'source_owner': '演示', 'source_manager': '演示',
            'source_detail': '演示', 'influencer_name': '演示', 'influencer_id': 'DEMO-',
            'merchant_code': 'DEMO-', 'book_series_code': 'DEMO-',
        }.items():
            count = c.execute(f'SELECT COUNT(*) FROM facts WHERE [{field}] IS NULL OR [{field}] NOT LIKE ?', (prefix+'%',)).fetchone()[0]
            if count:
                errors.append(f'{field} 有 {count} 行缺少明确的虚构标识')
        qty, amount = c.execute('SELECT SUM(sales_qty),ROUND(SUM(sales_amount),2) FROM facts').fetchone()
        if qty != summary['valid_sales_qty'] or amount != summary['valid_sales_amount']:
            errors.append('模拟事实与指标汇总不一致')
    report = {'ok': not errors, 'errors': errors, 'synthetic_rows': rows,
              'ignored_local_runtime_files': len(ignored), 'network_requests': 0}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(1 if errors else 0)

if __name__ == '__main__':
    check()
