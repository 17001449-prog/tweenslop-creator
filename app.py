#!/usr/bin/env python3
"""TweenSlop Studio — a tiny local-first editor shell served with the Python stdlib."""
from __future__ import annotations

import argparse
import json
import mimetypes
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
DATA_ROOT = ROOT / "data"
PROJECT_FILE = DATA_ROOT / "project.json"
MAX_PROJECT_BYTES = 8 * 1024 * 1024


class StudioHandler(SimpleHTTPRequestHandler):
    server_version = "TweenSlopStudio/0.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        super().end_headers()

    def _json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/status":
            self._json(200, {"ok": True, "name": "TweenSlop Studio", "version": "0.1.0"})
            return
        if path == "/api/project":
            if PROJECT_FILE.exists():
                try:
                    project = json.loads(PROJECT_FILE.read_text(encoding="utf-8"))
                    self._json(200, {"project": project})
                except (OSError, json.JSONDecodeError):
                    self._json(500, {"error": "Не удалось прочитать сохранённый проект."})
            else:
                self._json(200, {"project": None})
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_PUT(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/api/project":
            self._json(404, {"error": "Маршрут не найден."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_PROJECT_BYTES:
            self._json(413, {"error": "Некорректный размер проекта."})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {"error": "Ожидался корректный JSON."})
            return
        if not isinstance(payload, dict) or not isinstance(payload.get("clips", []), list):
            self._json(400, {"error": "Структура проекта некорректна."})
            return
        try:
            DATA_ROOT.mkdir(parents=True, exist_ok=True)
            temp_path = PROJECT_FILE.with_suffix(".tmp")
            temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            temp_path.replace(PROJECT_FILE)
        except OSError:
            self._json(500, {"error": "Не удалось сохранить проект на сервере."})
            return
        self._json(200, {"ok": True})

    def log_message(self, fmt: str, *args) -> None:
        # Compact, useful local-server logs; avoid leaking request bodies.
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run TweenSlop Studio locally")
    parser.add_argument("--host", default="0.0.0.0", help="bind address (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="port (default: 8000)")
    parser.add_argument("--open", action="store_true", help="open the local editor in your default browser")
    args = parser.parse_args()
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("text/javascript", ".mjs")
    server = ThreadingHTTPServer((args.host, args.port), StudioHandler)
    display_host = "localhost" if args.host in {"0.0.0.0", "::", ""} else args.host
    app_url = f"http://{display_host}:{args.port}/"
    print("TweenSlop Studio is running.")
    print(f"Open this address in your browser: {app_url}")
    print("Do not navigate to 0.0.0.0; it is only the server bind address.")
    print("Media files stay in this browser; project metadata is saved to ./data/project.json.")
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(app_url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping TweenSlop Studio…")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
