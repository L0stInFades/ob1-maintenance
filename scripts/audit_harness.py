"""Fresh, bounded, isolated processes shared by behavioral audit programs."""
import json
import os
import re
import signal
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUDIT_ROOT = ROOT / '.work/validation'


class Context:
    def __init__(self, name):
        AUDIT_ROOT.mkdir(parents=True, exist_ok=True)
        self.base = Path(tempfile.mkdtemp(prefix=name + '-', dir=AUDIT_ROOT))
        self.cwd, self.home = self.base / 'workspace', self.base / 'home'
        self.cwd.mkdir()
        self.home.mkdir()
        self.session_ids = []

    def files(self, files):
        for name, content in files.items():
            target = self.cwd / name
            if not target.resolve().is_relative_to(self.cwd):
                raise ValueError('Fixture path outside workspace')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)

    def run(self, command, args, stdin='', extra_env=None, port=None, timeout=35):
        env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
               'HOME': str(self.home), 'GEMINI_CLI_HOME': str(self.home),
               'TMPDIR': str(self.base), 'XDG_CONFIG_HOME': str(self.home / '.config'),
               'CI': '1', 'NO_COLOR': '1', 'TERM': 'dumb', 'SENTRY_ENABLED': 'false',
               'GEMINI_API_KEY': 'audit-dummy-key-not-a-real-credential'}
        env.update(extra_env or {})
        profile = '(version 1)(allow default)(deny network*)(deny file-write*)' + \
                  f'(allow file-write* (subpath {json.dumps(str(self.base))}) (literal "/dev/null"))' + \
                  '(deny file-read* (subpath "/Users/Apple/.ob1"))'
        if port:
            profile += f'(allow network-outbound (remote tcp "localhost:{int(port)}"))'
        process = subprocess.Popen(['/usr/bin/sandbox-exec', '-p', profile, *command, *args],
                                   cwd=self.cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, start_new_session=True)
        timed_out = False
        try:
            stdout, stderr = process.communicate(stdin, timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        self.observe_session_ids(stdout)
        return dict(returncode=process.returncode, stdout=stdout, stderr=stderr,
                    timed_out=timed_out, isolated_home=str(self.home), workspace=str(self.cwd),
                    network='denied' if not port else f'loopback TCP port {port} only')

    def observe_session_ids(self, stdout):
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and event.get('type') == 'init' and event.get('session_id'):
                self.session_ids.append(event['session_id'])

    def normalize(self, value, path=()):
        if isinstance(value, dict):
            volatile = set()
            if value.get('type') in {'init', 'message', 'tool_use', 'tool_result', 'result'}:
                volatile.add('timestamp')
            if value.get('type') == 'init' or {'response', 'stats'}.issubset(value):
                volatile.add('session_id')
            if 'stats' in path and not {'parameters', 'args', 'tool_responses'}.intersection(path):
                volatile.update({'duration_ms', 'durationMs', 'totalDurationMs',
                                 'totalLatencyMs', 'toolLatency', 'latency_ms'})
            result = {key: self.normalize(child, (*path, key))
                      for key, child in value.items() if key not in volatile}
            if value.get('name') == 'run_shell_command' and isinstance(value.get('response'), dict):
                output = result['response'].get('output')
                if isinstance(output, str) and '\nExit Code: ' in output:
                    # Only the tool's trailing process metadata, never command output
                    # lines, tool arguments, exit codes or arbitrary numeric text.
                    result['response']['output'] = re.sub(
                        r'\nProcess Group PGID: [1-9]\d*\Z', '\nProcess Group PGID: <PGID>', output)
            return result
        if isinstance(value, list):
            return [self.normalize(child, path) for child in value]
        if isinstance(value, str):
            value = value.replace(str(self.home), '<HOME>').replace(str(self.cwd), '<WORKSPACE>')
            for session_id in self.session_ids:
                value = value.replace(session_id, '<SESSION>')
            return value
        return value


def events(stdout):
    return [json.loads(line) for line in stdout.splitlines() if line.startswith('{')]


def function_responses(value):
    if isinstance(value, dict):
        if 'functionResponse' in value:
            yield value['functionResponse']
        for child in value.values():
            yield from function_responses(child)
    elif isinstance(value, list):
        for child in value:
            yield from function_responses(child)


def transcript_responses(context, stdout):
    session_id = next((e.get('session_id') for e in events(stdout) if e.get('type') == 'init'), None)
    if not session_id:
        return []
    for file in (context.home / '.ob1/tmp').rglob('*.json'):
        data = json.loads(file.read_text())
        if isinstance(data, dict) and data.get('sessionId') == session_id:
            # Tool responses may appear in more than one serialized history view.
            unique = {}
            for response in function_responses(data):
                unique[json.dumps(response, sort_keys=True)] = response
            return list(unique.values())
    return []


def cli_stderr(text, context):
    text = context.normalize(text)
    text = re.sub(r'\(node:\d+\)', '(node:<PID>)', text)
    # Formatting changes physical stack locations; Node hosts also name their
    # deprecation hint differently. Raw stderr is preserved in the evidence.
    return '\n'.join(line for line in text.splitlines()
                     if not line.lstrip().startswith('at ') and not line.startswith('(Use '))
