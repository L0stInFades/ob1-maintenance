import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
from audit_harness import Context


class ComparisonControls(unittest.TestCase):
    def setUp(self):
        self.context = Context.__new__(Context)
        self.context.home = Path('/audit/home')
        self.context.cwd = Path('/audit/workspace')
        self.context.session_ids = ['observed-session-id']

    def test_observed_session_only(self):
        self.assertEqual(self.context.normalize('observed-session-id unrelated-id'),
                         '<SESSION> unrelated-id')

    def test_tool_metadata_does_not_hide_output_or_exit_code(self):
        def result(output, code, pgid):
            return {'name': 'run_shell_command', 'response': {
                'output': f'Output: {output}\nExit Code: {code}\nProcess Group PGID: {pgid}'}}
        norm = self.context.normalize
        self.assertEqual(norm(result('ok', 7, 123)), norm(result('ok', 7, 456)))
        self.assertNotEqual(norm(result('ok', 7, 123)), norm(result('bad', 7, 123)))
        self.assertNotEqual(norm(result('ok', 7, 123)), norm(result('ok', 0, 123)))

    def test_process_ids_inside_user_output_are_preserved(self):
        value = {'name': 'run_shell_command', 'response': {
            'output': 'Output: a\nProcess Group PGID: 42\nExit Code: 0\nProcess Group PGID: 99'}}
        self.assertEqual(self.context.normalize(value)['response']['output'],
                         'Output: a\nProcess Group PGID: 42\nExit Code: 0\nProcess Group PGID: <PGID>')
        self.assertEqual(self.context.normalize('Process Group PGID: 99'), 'Process Group PGID: 99')

    def test_statistics_keep_token_counts(self):
        value = {'type': 'result', 'timestamp': 'volatile',
                 'stats': {'duration_ms': 40, 'total_tokens': 15,
                           'models': {'test': {'api': {'totalLatencyMs': 2, 'totalErrors': 0}}}}}
        normalized = self.context.normalize(value)
        self.assertEqual(normalized, {'type': 'result', 'stats': {
            'total_tokens': 15, 'models': {'test': {'api': {'totalErrors': 0}}}}})

    def test_tool_arguments_and_order_are_not_metadata(self):
        value = {'type': 'tool_use', 'tool_id': 'read-1', 'parameters': {
            'timestamp': 'important', 'sessionId': 'a', 'session_id': 'b',
            'stats': {'totalLatencyMs': 9}, 'paths': ['a', 'b']}}
        self.assertEqual(self.context.normalize(value), value)
        changed = {**value, 'tool_id': 'read-2'}
        self.assertNotEqual(self.context.normalize(value), self.context.normalize(changed))


if __name__ == '__main__':
    unittest.main()
