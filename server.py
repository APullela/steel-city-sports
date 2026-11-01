#!/usr/bin/env python3
"""
Steel City Sports - tiny local server.

1. Serves the app's files (index.html, styles.css, js/...).
2. Proxies the public sports APIs at /api?url=<encoded url>, because some of
   the endpoints don't allow direct browser requests (CORS).
3. Caches responses briefly so a page left open doesn't hammer the APIs.

Standard library only. Run:  python3 server.py   then open http://localhost:8000
It also prints an address your phone can use on the same Wi-Fi.
Set a different port with:   PORT=9000 python3 server.py
Keep it to this computer only: HOST=127.0.0.1 python3 server.py
"""
import functools
import gzip
import http.server
import json
import os
import socket
import threading
import time
import urllib.parse
import urllib.request

PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "0.0.0.0")  # 0.0.0.0 = reachable from phones on the same Wi-Fi
ROOT = os.path.dirname(os.path.abspath(__file__))

# Only these hosts can be fetched through the proxy.
ALLOWED_HOSTS = {
    "site.api.espn.com",
    "site.web.api.espn.com",
    "sports.core.api.espn.com",
    "api-web.nhle.com",
    "statsapi.mlb.com",
}

# Seconds to keep a response. Live data is kept just long enough to absorb
# several open tabs refreshing at once; slow-moving data is kept longer.
def cache_seconds(url):
    if any(k in url for k in ("/scoreboard", "/summary", "/score/now", "/gamecenter/")):
        return 8
    if any(k in url for k in ("/standings", "/leaders", "/playoff-bracket", "/postseason")):
        return 300
    return 60


CACHE = {}  # url -> (fetched_at, body bytes)
CACHE_LOCK = threading.Lock()
MAX_ENTRIES = 400


def fetch_upstream(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (SteelCitySports local proxy)",
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
    })
    with urllib.request.urlopen(req, timeout=15) as res:  # follows redirects
        body = res.read()
        if res.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
    return body


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **{
        ".webmanifest": "application/manifest+json", ".js": "text/javascript"})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            return self.send_body(200, b'{"ok": true}')
        if parsed.path == "/api":
            target = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
            return self.proxy(target)
        return super().do_GET()

    def proxy(self, url):
        u = urllib.parse.urlparse(url)
        if u.scheme not in ("http", "https") or u.hostname not in ALLOWED_HOSTS:
            return self.send_body(400, b'{"error": "host not allowed"}')
        url = "https://" + url.split("://", 1)[1]  # ESPN's $ref links are plain http

        now = time.time()
        with CACHE_LOCK:
            hit = CACHE.get(url)
        if hit and now - hit[0] < cache_seconds(url):
            return self.send_body(200, hit[1], {"X-Cache": "hit"})

        try:
            body = fetch_upstream(url)
        except Exception as err:  # upstream down: serve the last good copy if we have one
            if hit:
                return self.send_body(200, hit[1], {"X-Cache": "stale", "X-Stale": "1"})
            code = getattr(err, "code", 502) or 502
            return self.send_body(code if 400 <= code < 600 else 502, json.dumps({"error": str(err)}).encode())

        with CACHE_LOCK:
            CACHE[url] = (now, body)
            if len(CACHE) > MAX_ENTRIES:
                for key, _ in sorted(CACHE.items(), key=lambda kv: kv[1][0])[: len(CACHE) - MAX_ENTRIES]:
                    del CACHE[key]
        self.send_body(200, body, {"X-Cache": "miss"})

    def send_body(self, code, body, extra=None):
        headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
                   "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-Stale, X-Cache"}
        headers.update(extra or {})
        if len(body) > 2048 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, compresslevel=5)
            headers["Content-Encoding"] = "gzip"
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # don't let the browser hold on to old copies of the app's own files
        if not self.path.startswith("/api"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith(("4", "5")):  # only log failures
            super().log_message(fmt, *args)


def lan_address():
    """This computer's address on the local network (what a phone would type)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))  # no data is sent; this just picks the right network interface
            return s.getsockname()[0]
    except OSError:
        return None


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    server = http.server.ThreadingHTTPServer((HOST, PORT), handler)
    print(f"Steel City Sports is running at http://localhost:{PORT}  (Ctrl+C to stop)", flush=True)
    ip = lan_address()
    if HOST == "0.0.0.0" and ip:
        print(f"On your phone (same Wi-Fi): http://{ip}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
