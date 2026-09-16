#!/usr/bin/env python3
"""Independently capture the executable's actual JS through its V8 runtime."""
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    parent = ROOT / '.work/runtime-audit'
    parent.mkdir(parents=True, exist_ok=True)
    records = []
    for label, binary, expected in (
        ('original', ROOT / 'original/bin/ob1', ROOT / 'recovered/ob1.bundle.cjs'),
        ('rebuilt', ROOT / 'dist/bin/ob1', ROOT / 'src/ob1.cjs'),
    ):
        work = Path(tempfile.mkdtemp(prefix=label + '-', dir=parent))
        home = work / 'home'
        home.mkdir()
        env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
               'HOME': str(home), 'GEMINI_CLI_HOME': str(home), 'TMPDIR': str(work),
               'CI': '1', 'NO_COLOR': '1', 'TERM': 'dumb', 'SENTRY_ENABLED': 'false',
               'OB1_AUDIT_CAPTURE_DIR': str(work),
               'NODE_OPTIONS': '--require=' + str(ROOT / 'scripts/audit-runtime-probe.cjs')}
        profile = '(version 1)(allow default)(deny network*)(deny file-write*)' + \
                  f'(allow file-write* (subpath {json.dumps(str(work))}) (literal "/dev/null"))' + \
                  '(deny file-read* (subpath "/Users/Apple/.ob1"))'
        process = subprocess.run(['/usr/bin/sandbox-exec', '-p', profile, str(binary), '--version'],
                                 cwd=work, env=env, capture_output=True, text=True, timeout=45)
        capture = json.loads((work / 'capture.json').read_text()) if (work / 'capture.json').exists() else {}
        code = (work / 'engine-source.cjs').read_bytes() if (work / 'engine-source.cjs').exists() else b''
        record = dict(label=label, binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                      expected_file=str(expected.relative_to(ROOT)), expected_sha256=hashlib.sha256(expected.read_bytes()).hexdigest(),
                      returncode=process.returncode, stdout=process.stdout, stderr=process.stderr,
                      capture=capture, engine_source_equals_file=code == expected.read_bytes())
        records.append(record)
        print(label, 'runtime source exact:', record['engine_source_equals_file'],
              'exit:', process.returncode, 'captured bytes:', len(code), flush=True)
    (ROOT / 'reports/runtime-audit.json').write_text(json.dumps(records, indent=2) + '\n')
    if any(r['returncode'] != 0 or not r['engine_source_equals_file'] for r in records):
        raise SystemExit('Runtime source audit failed; inspect reports/runtime-audit.json')


if __name__ == '__main__':
    main()
