#!/usr/bin/env python3
"""Verify repacking changes only the SEA container, not native program sections."""
import hashlib
import json
from pathlib import Path
from extract_sea import macho_sections, parse_sea

ROOT = Path(__file__).resolve().parent.parent


def main():
    original = (ROOT / 'original/bin/ob1').read_bytes()
    built = (ROOT / 'dist/bin/ob1').read_bytes()
    source = (ROOT / 'src/ob1.cjs').read_bytes()
    sections = {(s['segment'], s['section']): s for s in macho_sections(built)}
    results = []
    # Zero-fill sections do not occupy file bytes. Compare their layout only.
    zerofill = {'__bss', '__common', '__thread_bss'}
    for old in macho_sections(original):
        key = old['segment'], old['section']
        if key[0] == 'NODE_SEA':
            continue
        new = sections[key]
        same_layout = all(old[k] == new[k] for k in ('address', 'offset', 'size'))
        old_bytes = original[old['offset']:old['offset'] + old['size']]
        new_bytes = built[new['offset']:new['offset'] + new['size']]
        same_bytes = None if key[1] in zerofill else old_bytes == new_bytes
        results.append(dict(segment=key[0], section=key[1], layout_equal=same_layout, bytes_equal=same_bytes))
        assert same_layout and same_bytes is not False, key
    sea = sections['NODE_SEA', '__NODE_SEA_BLOB']
    metadata, payload, _, _ = parse_sea(built[sea['offset']:sea['offset'] + sea['size']], 9)
    assert payload == source, 'Repacked source does not match editable source'
    for item in json.loads((ROOT / 'reports/original-manifest.json').read_text())['files']:
        assert hashlib.sha256((ROOT / item['path']).read_bytes()).hexdigest() == item['sha256'], item['path']
    result = dict(native_sections=results, source_payload_equal=True,
                  original_snapshot_intact=True, source_sha256=hashlib.sha256(source).hexdigest())
    (ROOT / 'reports/build-integrity.json').write_text(json.dumps(result, indent=2) + '\n')
    print(f'PASS: {len(results)} native sections preserved, JavaScript payload exact, original snapshot intact')


if __name__ == '__main__':
    main()
