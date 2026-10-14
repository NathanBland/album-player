#!/usr/bin/env python3
"""Local server for the album player.

Plain `python3 -m http.server` doesn't answer HTTP Range requests, which
Safari needs to play audio at all and every browser needs to seek. This adds
Range support and serves albums/library.json live from a fresh scan.

    python3 scripts/serve.py [--port 5173]
"""
import argparse
from io import BytesIO
import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
from scan_library import ROOT, scan  # noqa: E402

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript",
        ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac", ".opus": "audio/ogg",
        ".oga": "audio/ogg", ".ogg": "audio/ogg", ".webm": "audio/webm", ".webp": "image/webp",
    }

    def __init__(self, *args, **kwargs):
        self._range_left = None
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        if self.path.split("?")[0] == "/albums/library.json":
            body = json.dumps({"albums": scan()}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return BytesIO(body)

        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        m = RANGE_RE.match(rng.strip()) if rng else None
        if not m or os.path.isdir(path) or m.groups() == ("", ""):
            return super().send_head()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        size = os.fstat(f.fileno()).st_size
        first, last = m.groups()
        if first == "":  # suffix range: last N bytes
            start, end = max(0, size - int(last)), size - 1
        else:
            start, end = int(first), min(int(last) if last else size - 1, size - 1)
        if start >= size or start > end:
            f.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        f.seek(start)
        self._range_left = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        try:
            if self._range_left is None:
                return super().copyfile(source, outputfile)
            left = self._range_left
            while left > 0:
                chunk = source.read(min(64 * 1024, left))
                if not chunk:
                    break
                outputfile.write(chunk)
                left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browsers routinely drop media connections mid-stream

    def log_message(self, fmt, *args):
        if not self.path.startswith("/albums/") or "library.json" in self.path:
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5173)))
    args = ap.parse_args()
    (ROOT / "albums").mkdir(exist_ok=True)
    print(f"Album player on http://localhost:{args.port}  ({len(scan())} album(s) in albums/)")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
