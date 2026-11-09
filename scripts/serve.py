#!/usr/bin/env python3
"""Server for the album player.

Plain `python3 -m http.server` doesn't answer HTTP Range requests, which Safari needs to play audio
at all and every browser needs to seek. This adds Range support, serves the music folder under
/albums/, and serves /albums/library.json from a scan of it.

    python3 scripts/serve.py [--host 127.0.0.1] [--port 5173] [--rescan SECONDS] [--quiet]

Every option can also come from the environment (the Docker image sets these):
    HOST, PORT        where to listen (HOST=0.0.0.0 to accept connections from other machines)
    MUSIC_DIR         the music collection (default: albums/ next to the app)
    RESCAN_SECONDS    0 (default): rescan on every library.json request, handy while adding music.
                      >0: scan once in the background, cache it, refresh every N seconds.
                      GET /albums/library.json?rescan=1 forces a fresh scan either way.
    QUIET=1           log only errors, not every request
/healthz answers 200 without touching the library, for container health checks.
"""
import argparse
import json
import os
import posixpath
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from urllib.parse import unquote

sys.path.insert(0, os.path.dirname(__file__))
import scan_library  # noqa: E402
from scan_library import ROOT  # noqa: E402

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")
# Only the app and the music are served, never the rest of the checkout (.git, scripts, ...)
PUBLIC_FILES = ("/", "/index.html")
PUBLIC_DIRS = ("/css/", "/js/", "/vendor/", "/albums/")


def is_public(url_path):
    """True for the app's own files and the music; checked after decoding and resolving '..'."""
    p = posixpath.normpath(unquote(url_path))
    p = p + "/" if p != "/" and url_path.endswith("/") else p
    return p in PUBLIC_FILES or p.startswith(PUBLIC_DIRS)


class Library:
    """library.json, either scanned per request or cached and refreshed in the background."""

    def __init__(self, ttl):
        self.ttl = ttl
        self.body = None
        self.lock = threading.Lock()

    def _scan(self):
        t = time.time()
        albums = scan_library.scan()
        self.body = json.dumps({"albums": albums}).encode()
        print(f"library: {len(albums)} folder(s) with {sum(len(a['tracks']) for a in albums)} track(s) "
              f"scanned in {time.time() - t:.1f}s", flush=True)

    def get(self, force=False):
        with self.lock:  # one scan at a time; requests during a scan wait for its result
            if force or self.ttl <= 0 or self.body is None:
                self._scan()
            return self.body

    def start_refresh(self):
        def loop():
            while True:
                try:
                    self.get(force=True)
                except Exception as e:  # keep serving the last good scan
                    print(f"library: rescan failed: {e}", file=sys.stderr, flush=True)
                time.sleep(self.ttl)
        threading.Thread(target=loop, daemon=True).start()


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript",
        ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac", ".opus": "audio/ogg",
        ".oga": "audio/ogg", ".ogg": "audio/ogg", ".webm": "audio/webm", ".webp": "image/webp",
        ".aif": "audio/aiff", ".aiff": "audio/aiff",
    }
    library = None
    quiet = False

    def __init__(self, *args, **kwargs):
        self._range_left = None
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def translate_path(self, path):
        # /albums/... is the music folder, wherever MUSIC_DIR points
        p = path.split("?", 1)[0].split("#", 1)[0]
        if p == "/albums" or p.startswith("/albums/"):
            saved = self.directory
            self.directory = str(scan_library.ALBUMS)
            try:
                return super().translate_path(p[len("/albums"):] or "/")
            finally:
                self.directory = saved
        return super().translate_path(path)

    def list_directory(self, path):
        # no browsable index of the app or the music collection
        self.send_error(404, "Not found")
        return None

    def _send_bytes(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        return BytesIO(body)

    def send_head(self):
        path, _, query = self.path.partition("?")
        if path == "/healthz":
            return self._send_bytes(b"ok\n", "text/plain")
        if path == "/albums/library.json":
            return self._send_bytes(self.library.get(force="rescan=1" in query), "application/json")

        if not is_public(path):
            self.send_error(404, "Not found")
            return None

        rng = self.headers.get("Range")
        fs_path = self.translate_path(self.path)
        m = RANGE_RE.match(rng.strip()) if rng else None
        if not m or os.path.isdir(fs_path) or m.groups() == ("", ""):
            return super().send_head()
        try:
            f = open(fs_path, "rb")
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
        self.send_header("Content-Type", self.guess_type(fs_path))
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
        if self.quiet:
            return
        if not self.path.startswith("/albums/") or "library.json" in self.path:
            super().log_message(fmt, *args)

    def log_error(self, fmt, *args):
        super().log_message(fmt, *args)  # errors are logged even when quiet


def main():
    env = os.environ.get
    ap = argparse.ArgumentParser(description="Serve the album player.")
    ap.add_argument("--host", default=env("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(env("PORT", 5173)))
    ap.add_argument("--rescan", type=int, default=int(env("RESCAN_SECONDS", 0)),
                    help="cache the library scan and refresh it every N seconds (0: scan per request)")
    ap.add_argument("--quiet", action="store_true", default=env("QUIET", "") not in ("", "0", "false"))
    args = ap.parse_args()

    music = scan_library.ALBUMS
    if not music.is_dir():
        try:
            music.mkdir(parents=True)
        except OSError as e:
            print(f"warning: music folder {music} doesn't exist and can't be created: {e}", file=sys.stderr)
    Handler.library = Library(args.rescan)
    Handler.quiet = args.quiet
    if args.rescan > 0:
        Handler.library.start_refresh()  # first scan in the background; requests wait for it
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    shown = "localhost" if args.host in ("127.0.0.1", "0.0.0.0", "::") else args.host
    mode = f"cached, rescanned every {args.rescan}s" if args.rescan > 0 else "scanned on every request"
    print(f"Album player on http://{shown}:{args.port}  (music: {music}, {mode})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
