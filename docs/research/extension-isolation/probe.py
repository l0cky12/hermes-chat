import sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, GLib, WebKit2

T0 = time.time()
LOG = []
PAGE = open(sys.argv[1]).read()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        LOG.append((round(time.time() - T0, 2), 'GET', self.path))
        body = PAGE.encode() if self.path == '/' else b'ok'
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', 'text/html' if self.path == '/' else 'text/plain')
        self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0)); data = self.rfile.read(n).decode()
        LOG.append((round(time.time() - T0, 2), 'POST', self.path, data))
        self.send_response(204); self.send_header('Access-Control-Allow-Origin', '*'); self.end_headers()
    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in [('Access-Control-Allow-Origin', '*'), ('Access-Control-Allow-Headers', '*'), ('Access-Control-Allow-Methods', '*')]:
            self.send_header(k, v)
        self.end_headers()

srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

w = Gtk.Window(); w.set_default_size(800, 600)
v = WebKit2.WebView(); v.get_settings().set_enable_write_console_messages_to_stdout(True); w.add(v); w.show_all()
v.load_uri(f'http://127.0.0.1:{port}/')
GLib.timeout_add_seconds(int(sys.argv[2]) if len(sys.argv) > 2 else 14, Gtk.main_quit)
Gtk.main()
for row in LOG:
    print(*row)
