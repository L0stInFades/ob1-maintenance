#!/usr/bin/env python3
"""Recompare captured evidence after explicitly normalizing per-run metadata.

This does not run applications or change any case expectation. Exit status,
tool checks, file effects and all nonvolatile observations remain required.
"""
import argparse
import datetime
import json
from pathlib import Path
from audit_harness import ROOT, Context


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs='+', choices=['behavior', 'http'])
    args = parser.parse_args()
    for name in args.reports:
        file = ROOT / f'reports/{name}-audit.json'
        rows = json.loads(file.read_text())
        reference = {}
        for row in rows:
            context = Context.__new__(Context)
            context.cwd = Path(row['workspace'])
            context.home = Path(row['isolated_home'])
            context.session_ids = []
            context.observe_session_ids(row['stdout'])
            comparison = context.normalize(row['comparison'])
            if row['variant'] == 'original':
                reference[row['case']] = comparison
            equal = comparison == reference[row['case']]
            row['comparison'] = comparison
            row['wire_equivalent_to_original' if name == 'http' else 'equivalent_to_original'] = equal
            row['passed'] = all(row['checks'].values()) and equal
            row['comparison_metadata'] = {
                'compared_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'observed_session_ids': context.session_ids,
                'normalizations': ['temporary HOME and workspace paths', 'event timestamp/session ID fields',
                                   'explicit duration/latency statistic fields', "this run's observed session ID inside strings",
                                   'run_shell_command response trailing Process Group PGID field'],
                'case_expectations_changed': False,
            }
        file.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + '\n')
        print(name, sum(r['passed'] for r in rows), '/', len(rows), 'cases passed')
        if not all(r['passed'] for r in rows):
            raise SystemExit(1)


if __name__ == '__main__':
    main()
