#!/usr/bin/env python3
"""Compare real client HTTP serialization, streaming and a tool round trip."""
import json
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from audit_harness import ROOT, Context, events, transcript_responses


def handler(requests, with_tool):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            requests.append({'method': 'POST', 'path': self.path, 'body': json.loads(body),
                             'content_type': self.headers.get('Content-Type'),
                             'test_key_received': self.headers.get('x-goog-api-key') == 'audit-dummy-key-not-a-real-credential'})
            if 'streamGenerateContent' not in self.path:
                self.send_response(404)
                self.end_headers()
                return
            if with_tool and len(requests) == 1:
                parts = [[{'functionCall': {'id': 'http-read', 'name': 'read_file', 'args': {'file_path': 'http-fixture.txt'}}}]]
            else:
                parts = [[{'text': 'AUDIT_HTTP_'}], [{'text': 'OK😀'}]]
            chunks = []
            for index, values in enumerate(parts):
                candidate = {'content': {'role': 'model', 'parts': values}, 'index': 0}
                if index == len(parts) - 1:
                    candidate['finishReason'] = 'STOP'
                chunk = {'candidates': [candidate], 'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 5, 'totalTokenCount': 15}}
                chunks.append(('data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\n').encode())
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Connection', 'close')
            self.end_headers()
            for chunk in chunks:
                # Send several writes so the SDK must process a genuine stream.
                self.wfile.write(chunk)
                self.wfile.flush()
    return Handler


def main():
    targets = [('original', [str(ROOT / 'original/bin/ob1')]),
               ('readable', [shutil.which('node'), str(ROOT / 'src/ob1.cjs')]),
               ('rebuilt', [str(ROOT / 'dist/bin/ob1')])]
    results = []
    for with_tool in (False, True):
        reference = None
        for label, command in targets:
            context = Context('http-' + label)
            context.files({'http-fixture.txt': 'HTTP_FILE_CONTENT_中文😀\n'})
            requests = []
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler(requests, with_tool))
            port = server.server_address[1]
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                result = context.run(command, ['--incognito', '--model', 'gemini-2.5-flash',
                                               '-p', 'AUDIT_HTTP_PROMPT', '--output-format', 'stream-json'],
                                     extra_env={'GOOGLE_GEMINI_BASE_URL': f'http://127.0.0.1:{port}'},
                                     port=port)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
            observed = events(result['stdout'])
            assistant = ''.join(e.get('content', '') for e in observed if e.get('type') == 'message' and e.get('role') == 'assistant')
            checks = {'exit_success': result['returncode'] == 0, 'no_timeout': not result['timed_out'],
                      'http_requests': len(requests) == (2 if with_tool else 1),
                      'actual_stream_parsed': assistant == 'AUDIT_HTTP_OK😀',
                      'dummy_key_used': bool(requests) and all(r['test_key_received'] for r in requests)}
            if with_tool:
                checks['tool_success'] = any(e.get('type') == 'tool_result' and e.get('tool_id') == 'http-read' and e.get('status') == 'success' for e in observed)
                checks['read_content_sent_back_to_model'] = len(requests) == 2 and 'HTTP_FILE_CONTENT_中文😀' in json.dumps(requests[-1]['body'], ensure_ascii=False)
            normalized = context.normalize({'requests': requests, 'events': observed,
                                            'tool_responses': transcript_responses(context, result['stdout'])})
            if reference is None:
                reference = normalized
            result.update(variant=label, case='http-tool-roundtrip' if with_tool else 'http-stream',
                          checks=checks, wire_equivalent_to_original=normalized == reference,
                          comparison=normalized, raw_requests=requests)
            result['passed'] = all(checks.values()) and result['wire_equivalent_to_original']
            results.append(result)
            (ROOT / 'reports/http-audit.json').write_text(json.dumps(results, indent=2, ensure_ascii=False) + '\n')
            print(result['case'], label, 'PASS' if result['passed'] else 'FAIL',
                  [k for k, v in checks.items() if not v], 'wire_equal=' + str(result['wire_equivalent_to_original']), flush=True)
    if not all(r['passed'] for r in results):
        raise SystemExit('HTTP audit has differences; inspect reports/http-audit.json')


if __name__ == '__main__':
    main()
