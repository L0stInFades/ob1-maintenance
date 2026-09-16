#!/usr/bin/env python3
"""Rebuild in an independent directory and compare the resulting executable."""
import datetime
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    output = ROOT / 'dist/bin/ob1'
    before = digest(output)
    work = Path(tempfile.mkdtemp(prefix='rebuild-audit-', dir=ROOT / '.work'))
    for name in ['original', 'recovered', 'src']:
        (work / name).symlink_to(ROOT / name, target_is_directory=True)
    (work / 'scripts').mkdir()
    (work / 'reports').mkdir()
    for name in ['build.cjs', 'repack_macho.py']:
        shutil.copy2(ROOT / 'scripts' / name, work / 'scripts' / name)
    (work / 'scripts/optimize').symlink_to(ROOT / 'scripts/optimize', target_is_directory=True)
    result = subprocess.run([shutil.which('node'), str(work / 'scripts/build.cjs')], cwd=work,
                            capture_output=True, text=True, timeout=60)
    fresh = work / 'dist/bin/ob1'
    checks = {'build_succeeded': result.returncode == 0,
              'current_distribution_untouched': digest(output) == before,
              'independent_build_byte_identical': fresh.is_file() and digest(fresh) == before}
    record = dict(checked_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  workspace=str(work), stdout=result.stdout, stderr=result.stderr,
                  current_binary_sha256=before, fresh_binary_sha256=digest(fresh) if fresh.is_file() else None,
                  source_sha256=digest(ROOT / 'src/ob1.cjs'), checks=checks, passed=all(checks.values()))
    (ROOT / 'reports/rebuild-audit.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(checks))
    if not record['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
