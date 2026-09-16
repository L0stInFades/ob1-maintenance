#!/usr/bin/env python3
"""Tie saved audit evidence to current artifacts and retain initial failures."""
import datetime
import hashlib
import json
from pathlib import Path
from audit_behavior import cases
from audit_harness import ROOT


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    names = ['runtime-audit', 'static-audit', 'source-equivalence', 'rebuild-audit',
             'behavior-audit', 'search-audit', 'http-audit', 'analysis-summary']
    reports = {name: json.loads((ROOT / f'reports/{name}.json').read_text()) for name in names}
    files = ['original/bin/ob1', 'recovered/ob1.bundle.cjs', 'src/ob1.cjs', 'dist/bin/ob1']
    artifacts = {name: {'bytes': (ROOT / name).stat().st_size, 'sha256': sha(ROOT / name)} for name in files}
    checks = {}
    runtime = reports['runtime-audit']
    checks['actual_v8_sources_exact'] = len(runtime) == 2 and all(
        r['returncode'] == 0 and r['engine_source_equals_file'] and
        r['capture']['sha256'] == r['expected_sha256'] == artifacts[r['expected_file']]['sha256']
        for r in runtime)
    checks['runtime_binary_fingerprints_current'] = all(
        r['binary_sha256'] == artifacts['original/bin/ob1' if r['label'] == 'original' else 'dist/bin/ob1']['sha256']
        for r in runtime)
    static = reports['static-audit']
    checks['independent_static_checks'] = all(c['passed'] for c in static['checks'])
    checks['static_binary_fingerprints_current'] = (
        static['original_sha256'] == artifacts['original/bin/ob1']['sha256'] and
        static['rebuilt_sha256'] == artifacts['dist/bin/ob1']['sha256'])
    ast = reports['source-equivalence']
    checks['formatting_ast_equal'] = (ast['equal'] and ast['extractedAstSha256'] == ast['readableAstSha256'] and
        ast['extractedFileSha256'] == artifacts['recovered/ob1.bundle.cjs']['sha256'] and
        ast['readableFileSha256'] == artifacts['src/ob1.cjs']['sha256'])
    rebuilt = reports['rebuild-audit']
    checks['independent_rebuild_identical'] = (all(rebuilt['checks'].values()) and
        rebuilt['current_binary_sha256'] == rebuilt['fresh_binary_sha256'] == artifacts['dist/bin/ob1']['sha256'] and
        rebuilt['source_sha256'] == artifacts['src/ob1.cjs']['sha256'])

    variants = {'original', 'readable', 'rebuilt'}
    expected = {(case['name'], variant) for case in cases() for variant in variants}
    behavior, retest = reports['behavior-audit'], reports['search-audit']
    initial = {(r['case'], r['variant']): r for r in behavior}
    followup = {(r['case'], r['variant']): r for r in retest}
    checks['behavior_matrix_complete'] = len(behavior) == len(initial) == len(expected) and set(initial) == expected
    checks['search_retest_complete'] = (len(retest) == 3 and
        set(followup) == {('glob-and-grep', variant) for variant in variants} and
        all(r.get('fixture_repository_isolated') for r in retest))
    checks['all_initial_behavior_matches_original'] = all(
        r['comparison'] == initial[(r['case'], 'original')]['comparison'] for r in behavior)
    effective = {**initial, **followup}
    checks['effective_behavior_expectations_and_equivalence'] = all(
        all(r['checks'].values()) and r['comparison'] == effective[(r['case'], 'original')]['comparison']
        for r in effective.values())
    failures = [{'case': r['case'], 'variant': r['variant'],
                 'failed_checks': [key for key, value in r['checks'].items() if not value]}
                for r in behavior if not all(r['checks'].values())]
    checks['initial_failures_accounted_for'] = all(
        r['case'] == 'glob-and-grep' and r['failed_checks'] == ['content_grep'] for r in failures)
    http = reports['http-audit']
    http_by_case = {(r['case'], r['variant']): r for r in http}
    checks['http_matrix_complete'] = (len(http) == len(http_by_case) == 6 and set(http_by_case) ==
        {(case, variant) for case in ['http-stream', 'http-tool-roundtrip'] for variant in variants})
    checks['http_expectations_and_equivalence'] = all(all(r['checks'].values()) and
        r['comparison'] == http_by_case[(r['case'], 'original')]['comparison'] for r in http)
    checks['analysis_index_current'] = reports['analysis-summary']['sourceSha256'] == artifacts['src/ob1.cjs']['sha256']
    record = {
        'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope': 'Installed OB1 0.1.725 macOS x86_64 client recovery baseline',
        'artifacts': artifacts, 'checks': checks, 'passed': all(checks.values()),
        'counts': {
            'runtime_source_captures': len(runtime),
            'independent_static_checks': len(static['checks']),
            'behavior_initial_runs': len(behavior),
            'behavior_initial_expectations_passed': sum(all(r['checks'].values()) for r in behavior),
            'behavior_initial_matches_original': sum(r['equivalent_to_original'] for r in behavior),
            'search_retest_runs': len(retest),
            'effective_behavior_runs': len(effective),
            'effective_behavior_expectations_passed': sum(all(r['checks'].values()) for r in effective.values()),
            'http_runs': len(http), 'http_passed': sum(r['passed'] for r in http),
        },
        'initial_failures_retained': failures,
        'search_fixture_resolution': 'Parent repository .gitignore excludes .work/. git grep --untracked therefore returned no matches in all three versions. Retest uses an independent empty Git repository and keeps the original hit expectations.',
        'report_sha256': {f'reports/{name}.json': sha(ROOT / f'reports/{name}.json') for name in names},
        'limitations': [
            'No overall functionality percentage or branch-coverage claim.',
            'Formatting changes source locations and function source reflection.',
            'HTTP tests use local Google-compatible SSE fixtures, not live providers or real credentials.',
            'Interactive terminal, real MCP servers, OAuth refresh, cloud features and optional native modules are not fully validated.',
            'Original TypeScript project and server source are not recovered; native runtime is preserved, not decompiled.',
        ],
    }
    (ROOT / 'reports/validation-summary.json').write_text(json.dumps(record, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'passed': record['passed'], 'counts': record['counts'],
                      'failed_checks': [k for k, v in checks.items() if not v]}, indent=2))
    if not record['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
