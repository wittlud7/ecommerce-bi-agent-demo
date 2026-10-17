#!/usr/bin/env python3
"""Build a self-contained static demo from independently generated data only."""
import json
import shutil
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def build():
    provenance = json.loads((ROOT / 'web/data/provenance.json').read_text())
    if provenance.get('source_business_files_read') != 0 or provenance.get('original_record_mapping') is not False:
        raise ValueError('Static export requires independently generated synthetic data')
    target = ROOT / 'site'
    if target.exists():
        shutil.rmtree(target)
    target.mkdir()
    # Explicit assets only: no DB, credentials, Python server, local outputs or Git history.
    for name in ('index.html', 'app.js', 'styles.css', 'static-runtime.js'):
        shutil.copy2(ROOT / 'web' / name, target / name)
    for name in ('assets', 'vendor'):
        shutil.copytree(ROOT / 'web' / name, target / name)
    with sqlite3.connect(f'file:{ROOT / "web/data/dashboard.db"}?mode=ro', uri=True) as db:
        columns = [r[1] for r in db.execute('PRAGMA table_info(facts)')]
        rows = db.execute('SELECT * FROM facts ORDER BY date,book_series,store,source_detail').fetchall()
        meta = {key: json.loads(value) for key, value in db.execute('SELECT key,value FROM meta')}
    if meta['summary'].get('data_kind') != 'synthetic' or len(rows) != provenance['row_count']:
        raise ValueError('Unexpected dataset; export stopped')
    dictionaries, lookup = {}, {}
    for index, key in enumerate(columns):
        if isinstance(rows[0][index], str):
            dictionaries[key] = sorted({row[index] for row in rows})
            lookup[key] = {value: i for i, value in enumerate(dictionaries[key])}
    encoded = [[lookup[key][row[i]] if key in lookup else row[i] for i, key in enumerate(columns)] for row in rows]
    (target / 'demo-data.json').write_text(json.dumps({'columns': columns, 'dictionaries': dictionaries, 'rows': encoded, **meta}, ensure_ascii=False, separators=(',', ':')))
    html = (target / 'index.html').read_text()
    html = html.replace('    <script src="./app.js', '    <script src="./static-runtime.js"></script>\n    <script src="./app.js')
    (target / 'index.html').write_text(html)
    (target / '.nojekyll').write_text('')
    print(f'Static demo: {target} ({len(rows):,} synthetic rows; no model credentials)')

if __name__ == '__main__':
    build()
