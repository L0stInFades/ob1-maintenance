#!/usr/bin/env python3
"""Independent binary/resource audit using Apple's otool, not extract_sea.py."""
import datetime
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / 'reports/static-audit.json'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def commands(binary):
    text = subprocess.run(['/usr/bin/otool', '-l', str(binary)], capture_output=True,
                          text=True, check=True).stdout
    result = []
    for block in re.split(r'^Load command \d+\n', text, flags=re.M)[1:]:
        fields = {}
        for line in block.split('\nSection\n')[0].splitlines():
            match = re.match(r'\s*(\w+)\s+(.+?)\s*$', line)
            if match:
                key, value = match.groups()
                try:
                    value = int(value, 0)
                except ValueError:
                    pass
                fields[key] = value
        result.append(fields)
    return result, text


def main():
    original_path, built_path = ROOT / 'original/bin/ob1', ROOT / 'dist/bin/ob1'
    original, built = original_path.read_bytes(), built_path.read_bytes()
    old, old_text = commands(original_path)
    new, new_text = commands(built_path)
    old_segments = {c['segname']: c for c in old if c['cmd'] == 'LC_SEGMENT_64'}
    new_segments = {c['segname']: c for c in new if c['cmd'] == 'LC_SEGMENT_64'}
    old_sea, new_sea = old_segments['NODE_SEA'], new_segments['NODE_SEA']
    old_link, new_link = old_segments['__LINKEDIT'], new_segments['__LINKEDIT']
    delta = new_link['fileoff'] - old_link['fileoff']
    old_sig = next(c for c in old if c['cmd'] == 'LC_CODE_SIGNATURE')
    new_sig = next(c for c in new if c['cmd'] == 'LC_CODE_SIGNATURE')
    checks = []

    def check(name, passed, **detail):
        checks.append(dict(name=name, passed=bool(passed), **detail))

    first_section = min(int(v) for v in re.findall(r'^\s+offset (\d+)$', old_text, flags=re.M) if int(v))
    check('native_file_region_exact', old_sea['fileoff'] == new_sea['fileoff'] and
          original[first_section:old_sea['fileoff']] == built[first_section:new_sea['fileoff']],
          offset=first_section, bytes=old_sea['fileoff'] - first_section)
    old_tables = original[old_link['fileoff']:old_sig['dataoff']]
    new_tables = built[new_link['fileoff']:new_sig['dataoff']]
    check('complete_linkedit_before_signature_exact', old_tables == new_tables,
          bytes=len(old_tables), sha256=sha(old_tables))
    check('sea_file_and_vm_growth_agree', delta == new_sea['vmsize'] - old_sea['vmsize'] and
          delta == new_link['vmaddr'] - old_link['vmaddr'] and delta % 4096 == 0, delta=delta)
    check('load_command_count', len(old) == len(new), count=len(old))
    offsets = {'dataoff', 'symoff', 'stroff', 'tocoff', 'modtaboff', 'extrefsymoff',
               'indirectsymoff', 'extreloff', 'locreloff'}
    for index, (a, b) in enumerate(zip(old, new)):
        expected = dict(a)
        if a['cmd'] == 'LC_SEGMENT_64' and a['segname'] == 'NODE_SEA':
            expected.update(filesize=b['filesize'], vmsize=a['vmsize'] + delta)
            check('sea_size_alignment', (b['filesize'] + 4095) // 4096 * 4096 == b['vmsize'])
        elif a['cmd'] == 'LC_SEGMENT_64' and a['segname'] == '__LINKEDIT':
            expected.update(fileoff=a['fileoff'] + delta, vmaddr=a['vmaddr'] + delta,
                            filesize=b['filesize'], vmsize=b['vmsize'])
            check('linkedit_file_bounds', b['fileoff'] + b['filesize'] == len(built) and
                  b['vmsize'] >= b['filesize'] and b['vmsize'] % 4096 == 0,
                  virtual_padding_bytes=b['vmsize'] - b['filesize'])
        else:
            for field in offsets.intersection(a):
                if a[field]:
                    expected[field] = a[field] + delta
            if a['cmd'] == 'LC_CODE_SIGNATURE':
                expected['datasize'] = b['datasize']
        check(f'load_command_{index}_{a["cmd"]}', expected == b,
              **({} if expected == b else {'expected': expected, 'actual': b}))
    for label, binary in [('original', original_path), ('rebuilt', built_path)]:
        result = subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(binary)], capture_output=True, text=True)
        check(label + '_code_signature', result.returncode == 0, stderr=result.stderr)
    libraries = []
    for binary in (original_path, built_path):
        result = subprocess.run(['/usr/bin/otool', '-L', str(binary)], capture_output=True, text=True, check=True)
        libraries.append(result.stdout.splitlines()[1:])
    check('native_library_dependencies', libraries[0] == libraries[1])
    manifest = json.loads((ROOT / 'reports/original-manifest.json').read_text())
    copies = []
    for item in manifest['files']:
        captured = ROOT / item['path']
        relative = captured.relative_to(ROOT / 'original')
        installed = Path('/Users/Apple/.ob1') / relative
        check('snapshot_' + str(relative), sha(captured.read_bytes()) == item['sha256'])
        check('installed_' + str(relative), installed.is_file() and sha(installed.read_bytes()) == item['sha256'])
        if str(relative) == 'bin/ob1':
            continue
        if relative.parts[0] == 'bin':
            suffix = Path(*relative.parts[1:])
            targets = [ROOT / 'src' / suffix, ROOT / 'dist/bin' / suffix, ROOT / 'dist/bundle' / suffix]
        else:
            targets = [ROOT / relative, ROOT / 'dist' / relative]
        for target in targets:
            equal = target.is_file() and target.read_bytes() == captured.read_bytes()
            copies.append(dict(path=str(target.relative_to(ROOT)), exact=equal))
    check('all_maintained_and_distributed_sidecars_exact', all(c['exact'] for c in copies), files=len(copies))
    source = (ROOT / 'src/ob1.cjs').read_bytes()
    check('node_bundle_exact', (ROOT / 'dist/bundle/gemini-sea.cjs').read_bytes() == source)
    check('source_baseline_unchanged', sha(source) == 'f4dcb43c5e66f043e11a28a398fe6b42248a3ee58a950961d5dc0169971bb527')
    record = dict(checked_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  parser='Apple /usr/bin/otool; no imports from recovery parser/repacker',
                  original_sha256=sha(original), rebuilt_sha256=sha(built),
                  checks=checks, sidecar_copies=copies, passed=all(c['passed'] for c in checks))
    REPORT.write_text(json.dumps(record, indent=2) + '\n')
    print(f'{sum(c["passed"] for c in checks)}/{len(checks)} independent static checks passed')
    for c in checks:
        if not c['passed']:
            print(json.dumps(c))
    if not record['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
