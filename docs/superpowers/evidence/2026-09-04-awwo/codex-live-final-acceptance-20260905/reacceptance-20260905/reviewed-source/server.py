"""Local preview only. No backend, auth, or external network forwarding."""
import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(Path(__file__).parent), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def api_unavailable(self):
        path = urlsplit(self.path).path
        status = 401 if path == '/api/v1/session' else 503
        data = json.dumps({'data': None, 'error': {
            'code': 'AUTH_REQUIRED' if status == 401 else 'AUTH_DEPENDENCY_UNAVAILABLE',
            'message': '预览服务器未连接业务后端。', 'details': {}, 'retryable': False
        }, 'request_id': 'local-preview-no-backend'}, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlsplit(self.path).path.startswith('/api/'):
            return self.api_unavailable()
        return super().do_GET()

    def do_POST(self):
        return self.api_unavailable()

    do_PATCH = do_POST
    do_DELETE = do_POST
    do_PUT = do_POST


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4173)
    args = parser.parse_args()
    print(f'Preview: http://127.0.0.1:{args.port}/ (demo); ?mode=live (API integration)', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
