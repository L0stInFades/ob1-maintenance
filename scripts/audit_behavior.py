#!/usr/bin/env python3
"""Differential CLI, real tool effects, policy and session-content checks."""
import argparse
import json
import shutil
import subprocess
from audit_harness import ROOT, Context, events, transcript_responses, cli_stderr


def response(parts):
    return {'method': 'generateContentStream', 'response': [
        {'candidates': [{'content': {'role': 'model', 'parts': parts}, 'finishReason': 'STOP', 'index': 0}],
         'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 5, 'totalTokenCount': 15}}]}


def tool(name, args, call_id):
    return {'functionCall': {'id': call_id, 'name': name, 'args': args}}


def cases():
    for name, args, code in [
        ('help', ['--help'], 0), ('mcp-help', ['mcp', '--help'], 0),
        ('extensions-help', ['extensions', '--help'], 0), ('skills-help', ['skills', '--help'], 0),
        ('hooks-help', ['hooks', '--help'], 0), ('unknown-option', ['--audit-unknown-flag'], 1),
        ('prompt-conflict', ['query', '-p', 'prompt'], 1),
        ('approval-conflict', ['-p', 'query', '--yolo', '--approval-mode', 'plan'], 1),
        ('bad-output-format', ['-p', 'query', '--output-format', 'nonsense'], 1),
    ]:
        yield dict(name=name, kind='cli', args=args, code=code)
    for output in ['text', 'json', 'stream-json']:
        yield dict(name='response-' + output, kind='model', output=output, rounds=[])
    yield dict(name='stdin-and-prompt', kind='model', rounds=[], stdin='AUDIT_STDIN\n')
    yield dict(name='unicode-pagination', kind='model',
               files={'中文 空格.txt': '第一行\n第二行😀\n第三行\n第四行\n'},
               rounds=[[tool('read_file', {'file_path': '中文 空格.txt', 'offset': 1, 'limit': 2}, 'read')]],
               statuses={'read': 'success'}, response_contains={'read': ['第二行😀', '第三行']})
    yield dict(name='write-edit-read', kind='model', allow='write_file,replace',
               rounds=[[tool('write_file', {'file_path': 'nested/output.txt', 'content': 'before\n中文😀\n'}, 'write')],
                       [tool('replace', {'file_path': 'nested/output.txt', 'instruction': 'Change the first line from before to after for the fixture.',
                                         'old_string': 'before', 'new_string': 'after', 'expected_replacements': 1}, 'edit')],
                       [tool('read_file', {'file_path': 'nested/output.txt'}, 'read')]],
               statuses={'write': 'success', 'edit': 'success', 'read': 'success'},
               expected_files={'nested/output.txt': 'after\n中文😀\n'}, response_contains={'read': ['after', '中文😀']})
    yield dict(name='missing-file', kind='model',
               rounds=[[tool('read_file', {'file_path': 'missing.txt'}, 'missing')]], statuses={'missing': 'error'})
    yield dict(name='invalid-tool-params', kind='model',
               rounds=[[tool('read_file', {'file_path': 'sample.txt', 'offset': -1, 'limit': 2}, 'invalid')]],
               files={'sample.txt': 'unchanged\n'}, statuses={'invalid': 'error'}, expected_files={'sample.txt': 'unchanged\n'})
    yield dict(name='unknown-tool', kind='model',
               rounds=[[tool('audit_nonexistent_tool', {}, 'unknown')]], statuses={'unknown': 'error'})
    yield dict(name='shell-error-output', kind='model', allow='run_shell_command',
               rounds=[[tool('run_shell_command', {'command': 'printf AUDIT_OUT; printf AUDIT_ERR >&2; exit 7'}, 'shell')]],
               response_contains={'shell': ['AUDIT_OUT', 'AUDIT_ERR', '7']})
    yield dict(name='policy-denial', kind='model',
               files={'deny.toml': '[[rule]]\ntoolName = "run_shell_command"\ndecision = "deny"\npriority = 900\n'},
               policy='deny.toml', absent_files=['should-not-exist.txt'],
               rounds=[[tool('run_shell_command', {'command': 'printf denied > should-not-exist.txt'}, 'denied')]],
               statuses={'denied': 'error'})
    yield dict(name='glob-and-grep', kind='model', isolated_git=True,
               files={'fixtures/a.txt': 'audit_needle_A\n', 'fixtures/deep/b.txt': 'audit_needle_B\n', 'fixtures/ignore.md': 'not a match\n'},
               rounds=[[tool('glob', {'pattern': '**/*.txt', 'dir_path': 'fixtures'}, 'glob'),
                        tool('grep_search', {'pattern': 'audit_needle', 'dir_path': 'fixtures', 'include': '*.txt'}, 'grep')]],
               statuses={'glob': 'success', 'grep': 'success'}, response_contains={'glob': ['a.txt', 'b.txt'], 'grep': ['audit_needle_A']})


def run_model(case, context, command):
    fixture = context.base / 'responses.jsonl'
    rounds = [response(parts) for parts in case['rounds']] + [response([{'text': 'AUDIT_DONE'}])]
    fixture.write_text(''.join(json.dumps(row) + '\n' for row in rounds))
    output = case.get('output', 'stream-json')
    args = ['--incognito', '--fake-responses', str(fixture), '--model', 'gemini-2.5-flash',
            '-p', 'AUDIT_PROMPT', '--output-format', output]
    if case.get('allow'):
        args += ['--allowed-tools', case['allow']]
    if case.get('policy'):
        args += ['--policy', str(context.cwd / case['policy'])]
    record = context.run(command, args, stdin=case.get('stdin', ''))
    checks = {'exit_success': record['returncode'] == 0, 'no_timeout': not record['timed_out']}
    traces = []
    if output == 'text':
        checks['response'] = record['stdout'].strip() == 'AUDIT_DONE'
        observable = record['stdout']
    elif output == 'json':
        try:
            observable = json.loads(record['stdout'])
        except json.JSONDecodeError:
            observable = {'invalid_json': record['stdout']}
        checks['response'] = observable.get('response') == 'AUDIT_DONE'
    else:
        observable = events(record['stdout'])
        checks['response'] = any(e.get('type') == 'message' and e.get('role') == 'assistant' and e.get('content') == 'AUDIT_DONE' for e in observable)
        calls = {e['tool_id']: e for e in observable if e.get('type') == 'tool_result'}
        traces = transcript_responses(context, record['stdout'])
        for call_id, status in case.get('statuses', {}).items():
            checks['status_' + call_id] = calls.get(call_id, {}).get('status') == status
        for call_id, needles in case.get('response_contains', {}).items():
            outputs = json.dumps([r for r in traces if r.get('id') == call_id], ensure_ascii=False)
            checks['content_' + call_id] = all(word in outputs for word in needles)
        if case.get('stdin'):
            text = next((e.get('content', '') for e in observable if e.get('type') == 'message' and e.get('role') == 'user'), '')
            checks['stdin_merged'] = 'AUDIT_STDIN' in text and 'AUDIT_PROMPT' in text
    file_effects = {}
    for name, expected in case.get('expected_files', {}).items():
        file = context.cwd / name
        actual = file.read_text() if file.exists() else None
        checks['file_' + name] = actual == expected
        file_effects[name] = actual
    for name in case.get('absent_files', []):
        checks['absent_' + name] = not (context.cwd / name).exists()
        file_effects[name] = '<absent>' if checks['absent_' + name] else '<unexpected file>'
    record.update(checks=checks, observed=context.normalize(observable),
                  tool_responses=context.normalize(traces), file_effects=file_effects)
    return record


def main():
    definitions = list(cases())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', choices=[case['name'] for case in definitions])
    parser.add_argument('--report', default='behavior-audit.json',
                        help='Output filename inside reports/')
    args = parser.parse_args()
    report = (ROOT / 'reports' / args.report).resolve()
    if report.parent != (ROOT / 'reports').resolve():
        parser.error('--report must be a filename inside reports/')
    targets = [('original', [str(ROOT / 'original/bin/ob1')]),
               ('readable', [shutil.which('node'), str(ROOT / 'src/ob1.cjs')]),
               ('rebuilt', [str(ROOT / 'dist/bin/ob1')])]
    results = []
    for case in definitions:
        if args.case and case['name'] != args.case:
            continue
        reference = None
        for label, command in targets:
            context = Context(case['name'] + '-' + label)
            context.files(case.get('files', {}))
            if case.get('isolated_git'):
                # Parent .gitignore excludes .work/. A fresh repository makes
                # search fixtures independent of the maintenance repository.
                subprocess.run(['/usr/bin/git', '-c', 'init.templateDir=', 'init', '-q'],
                               cwd=context.cwd, check=True, capture_output=True,
                               env={'PATH': '/usr/bin:/bin', 'HOME': str(context.home),
                                    'GIT_CONFIG_NOSYSTEM': '1'})
            if case['kind'] == 'model':
                result = run_model(case, context, command)
                signature = {key: result[key] for key in ['returncode', 'observed', 'tool_responses', 'file_effects']}
            else:
                result = context.run(command, case['args'])
                result['checks'] = {'expected_exit_code': result['returncode'] == case['code'], 'no_timeout': not result['timed_out']}
                signature = dict(returncode=result['returncode'], stdout=context.normalize(result['stdout']), stderr=cli_stderr(result['stderr'], context))
            if reference is None:
                reference = signature
            result.update(case=case['name'], variant=label, equivalent_to_original=signature == reference,
                          comparison=signature, fixture_repository_isolated=case.get('isolated_git', False))
            result['passed'] = all(result['checks'].values()) and result['equivalent_to_original']
            results.append(result)
            report.write_text(json.dumps(results, indent=2, ensure_ascii=False) + '\n')
            print(case['name'], label, 'PASS' if result['passed'] else 'FAIL',
                  [name for name, value in result['checks'].items() if not value],
                  'equivalent=' + str(result['equivalent_to_original']), flush=True)
    if not all(r['passed'] for r in results):
        raise SystemExit(f'Behavioral audit has differences; inspect {report}')


if __name__ == '__main__':
    main()
