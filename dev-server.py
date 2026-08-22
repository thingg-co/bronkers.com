#!/usr/bin/env python3
"""Local dev server that resolves clean URLs the way GitHub Pages does:
/app -> app.html, /docs/whitepaper -> docs/whitepaper.html, / -> index.html.
Usage: python3 dev-server.py [port]   (default 8000)
"""
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class CleanURLHandler(SimpleHTTPRequestHandler):
    # never let the browser cache during development: the Terminal is ES
    # modules, and a stale floor.js next to a fresh stylesheet is confusing
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path):
        fs_path = super().translate_path(path)
        bare = path.split("?")[0].split("#")[0].rstrip("/")
        if bare and not os.path.exists(fs_path) and os.path.exists(fs_path + ".html"):
            return fs_path + ".html"
        return fs_path


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
print(f"serving with clean URLs on http://127.0.0.1:{port}")
HTTPServer(("127.0.0.1", port), CleanURLHandler).serve_forever()
