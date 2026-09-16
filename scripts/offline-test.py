#!/usr/bin/env python3
"""Exercise inference and real local tools with fixture model responses."""
import json
import shutil
from pathlib import Path
from smoke import ROOT, run_case


def responses(value):
    if isinstance(value, dict):
        if 'functionResponse' in value:
            yield value['functionResponse']
        for child in value.values():
            yield from responses(child)
    elif isinstance(value, list):
        for child in value:
            yield from responses(child)


def main():
    results = []
    targets = [('original', [str(ROOT / 'original/bin/ob1')]),
               ('readable', [shutil.which('node'), str(ROOT / 'src/ob1.cjs')]),
               ('build', [str(ROOT / 'dist/bin/ob1')])]
    for case in ('hello', 'tools'):
        for label, command in targets:
            args = ['--incognito', '--fake-responses', str(ROOT / f'tests/fixtures/{case}.jsonl'),
                    '--model', 'gemini-2.5-flash', '-p', 'Exercise the offline recovery fixture.']
            if case == 'tools':
                args += ['--output-format', 'stream-json', '--allowed-tools', 'run_shell_command']
            result = run_case(label, command, args, case_name='offline-' + case,
                              extra_env={'GEMINI_API_KEY': 'local-test-placeholder-not-a-real-key'},
                              fixture_files={'fixture.txt': 'OB1_FILE_CONTENT\n'})
            checks = {'text_response': result['stdout'].strip() == 'OB1_RECOVERY_OK'}
            if case == 'tools':
                events = [json.loads(line) for line in result['stdout'].splitlines() if line.startswith('{')]
                calls = {e['tool_id']: e for e in events if e.get('type') == 'tool_result'}
                session = next((e['session_id'] for e in events if e.get('type') == 'init'), None)
                read_content = False
                # read_file has an empty UI display; verify its actual model-facing
                # function response in this run's saved conversation instead.
                for file in (Path(result['isolated_home']) / '.ob1/tmp').rglob('*.json'):
                    data = json.loads(file.read_text())
                    if not isinstance(data, dict) or data.get('sessionId') != session:
                        continue
                    read_content |= any(r.get('id') == 'read-fixture' and r.get('name') == 'read_file'
                                        and r.get('response', {}).get('output') == 'OB1_FILE_CONTENT\n'
                                        for r in responses(data))
                shell = calls.get('shell-fixture', {})
                checks = {
                    'final_message': any(e.get('type') == 'message' and e.get('role') == 'assistant' and e.get('content') == 'OB1_TOOLS_OK' for e in events),
                    'read_file_success': calls.get('read-fixture', {}).get('status') == 'success',
                    'read_file_model_content': read_content,
                    'shell_success_and_output': shell.get('status') == 'success' and shell.get('output') == 'OB1_SHELL_CONTENT',
                    'result_success': any(e.get('type') == 'result' and e.get('status') == 'success' for e in events),
                }
            result['checks'] = checks
            result['passed'] = result['returncode'] == 0 and all(checks.values())
            results.append(result)
            (ROOT / 'reports/offline-tests.json').write_text(json.dumps(results, indent=2) + '\n')
            print(case, label, 'PASS' if result['passed'] else 'FAIL', flush=True)
    if not all(r['passed'] for r in results):
        raise SystemExit('Offline test failure; inspect reports/offline-tests.json')


if __name__ == '__main__':
    main()
