"""A backend dev template using only Python's standard library."""
import argparse
import os
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/":
            self.send_error(404)
            return
        script = os.environ.get("MEAN_SCRIPT", "") if os.environ.get("NODE_ENV") != "production" else ""
        body = ("<!doctype html><html><head><title>Python standalone fixture</title></head>"
                "<body><main><button>Save</button><input value='input-secret'>"
                "<div contenteditable>editable-secret</div>"
                + ("<section>" + "<div>Plain backend markup</div>" * 100 + "</section>") * 150
                + "</main>" + script + "</body></html>").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
