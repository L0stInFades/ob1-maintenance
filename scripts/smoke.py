#!/usr/bin/env python3
"""Compare local CLI behavior with network denied and disposable state."""
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_case(label, command, args, case_name=None, extra_env=None, fixture_files=None):
    scratch = ROOT / '.work' / 'smoke' / label / (case_name or '_'.join(args).replace('/', '_'))
    scratch.mkdir(parents=True, exist_ok=True)
    state = scratch / 'home'
    state.mkdir(exist_ok=True)
    for name, content in (fixture_files or {}).items():
        (scratch / name).write_text(content)
    profile = scratch / 'sandbox.sb'
    profile.write_text('\n'.join([
        '(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)',
        f'(allow file-write* (subpath {json.dumps(str(scratch))}) (literal "/dev/null"))',
        '(deny file-read* (subpath "/Users/Apple/.ob1"))',
    ]) + '\n')
    # Supply a fresh child-process environment, without inherited account tokens.
    env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
           'HOME': str(state), 'GEMINI_CLI_HOME': str(state),
           'TMPDIR': str(scratch), 'XDG_CONFIG_HOME': str(state / '.config'),
           'CI': '1', 'NO_COLOR': '1', 'TERM': 'dumb', 'SENTRY_ENABLED': 'false'}
    env.update(extra_env or {})
    result = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), *command, *args],
                            cwd=scratch, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=45, text=True)
    record = dict(label=label, args=args, returncode=result.returncode,
                  stdout=result.stdout, stderr=result.stderr,
                  network='denied by macOS sandbox-exec', isolated_home=str(state))
    return record


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--include-build', action='store_true')
    args = parser.parse_args()
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js is required')
    targets = [('original', [str(ROOT / 'original/bin/ob1')]),
               ('extracted', [node, str(ROOT / 'recovered/ob1.bundle.cjs')])]
    if (ROOT / 'src/ob1.cjs').exists():
        targets.append(('readable', [node, str(ROOT / 'src/ob1.cjs')]))
    if args.include_build:
        targets.append(('build', [str(ROOT / 'dist/bin/ob1')]))
    results = []
    for options in (['--version'], ['--help'], ['mcp', '--help']):
        reference = None
        for label, command in targets:
            result = run_case(label, command, options)
            if reference is None:
                reference = result
            result['matches_original_stdout'] = result['stdout'] == reference['stdout']
            results.append(result)
            print(label, options, 'exit', result['returncode'],
                  'stdout_matches', result['matches_original_stdout'], flush=True)
    (ROOT / 'reports/smoke.json').write_text(json.dumps(results, indent=2) + '\n')
    if any(r['returncode'] != 0 or not r['matches_original_stdout'] for r in results):
        raise SystemExit('Smoke tests failed; inspect reports/smoke.json')


if __name__ == '__main__':
    main()
