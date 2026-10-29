#!/usr/bin/env python3
"""Independent real-protocol/TLS/signing checks; synthetic credentials only.

Run: .venv/bin/python scripts/simulation/test_bridge.py -v
No external network endpoint is used. The CONNECT proxy only tunnels back to the
same temporary local TLS fixture server.
"""
from __future__ import annotations

import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import select
import socket
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
AUTH = "SYNTHETIC_SIMULATION_AUTH"
CSRF = "SYNTHETIC_SIMULATION_CSRF"
ANIMATION = "8121c1011eb851eb851ec011eb851eb851ec100"
OPERATIONS = ["UserByScreenName", "UserTweets", "UserTweetsAndReplies", "ListLatestTweetsTimeline",
              "SearchTimeline", "TweetDetail", "ListMembers"]


def valid_transaction(value, path):
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), validate=True)
        decoded = bytes(byte ^ raw[0] for byte in raw[1:])
        if len(raw) != 54 or decoded[:32] != bytes(range(32)) or decoded[-1] != 3:
            return False
        stamp = int.from_bytes(decoded[32:36], "little")
        expected = hashlib.sha256(f"GET!{path}!{stamp}obfiowerehiring{ANIMATION}".encode()).digest()[:16]
        return decoded[36:52] == expected and abs(stamp + 1682924400 - time.time()) < 60
    except (ValueError, TypeError, IndexError):
        return False


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            # Expected for the explicit untrusted-certificate scenario.
            pass

    def do_GET(self):
        parsed = urlsplit(self.path)
        headers = {key.lower(): value for key, value in self.headers.items()}
        operation = parsed.path.rsplit("/", 1)[-1] if parsed.path.startswith("/i/api/graphql/") else None
        with self.server.lock:
            self.server.observed.append({"path": parsed.path, "query": parse_qs(parsed.query), "headers": headers,
                                         "operation": operation, "signatureValid": valid_transaction(headers.get("x-client-transaction-id", ""), parsed.path) if operation else None})
            statuses = self.server.plans.get(operation, [])
            status = statuses.pop(0) if statuses else 200
        if parsed.path == "/tesla":
            body = (HERE / "bootstrap.html").read_bytes()
            mime = "text/html; charset=utf-8"
        elif parsed.path == "/x-web/client/sign.o-simulation.js":
            body = (HERE / "sign.o-simulation.js").read_bytes()
            mime = "application/javascript"
        elif operation in OPERATIONS:
            body = json.dumps({"data": {"synthetic_id": 2111520482914877569, "operation": operation},
                               **({"errors": [{"code": 88}]} if self.server.graphql_error else {})}).encode()
            mime = "application/json"
        else:
            status, body, mime = 404, b"unknown fixture", "text/plain"
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        # Exercise real cookie isolation across the retained curl transport.
        self.send_header("Set-Cookie", "ct0=SYNTHETIC_UPSTREAM_CHANGED; Domain=.x.com; Path=/; Secure")
        if operation and self.server.rate_headers:
            self.send_header("x-rate-limit-remaining", str(self.server.remaining))
            self.send_header("x-rate-limit-reset", str(self.server.reset))
        if self.server.redirect:
            self.send_header("Location", "https://abs.twimg.com/x-web/client/sign.o-simulation.js")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(5)
        document = bytearray()
        try:
            while b"\r\n\r\n" not in document:
                chunk = self.request.recv(4096)
                if not chunk or len(document) + len(chunk) > 16384:
                    return
                document.extend(chunk)
            head, extra = bytes(document).split(b"\r\n\r\n", 1)
            method, target, version = head.split(b"\r\n", 1)[0].decode("ascii").split(" ")
            host, port = target.rsplit(":", 1)
            if method != "CONNECT" or host not in ("x.com", "abs.twimg.com") or int(port) != self.server.tls_port:
                self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return
            self.server.observed.append({"host": host, "port": int(port), "method": method})
            with socket.create_connection(("127.0.0.1", int(port)), timeout=5) as upstream:
                self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                if extra:
                    upstream.sendall(extra)
                streams = (self.request, upstream)
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    readable, _, _ = select.select(streams, [], [], 1)
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.request else self.request).sendall(data)
        except (OSError, ValueError, UnicodeError):
            return


class ThreadedProxy(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


class RealBridgeSimulationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private = tempfile.TemporaryDirectory(prefix="twv2-simulation-bridge-")
        directory = Path(cls.private.name)
        cls.cert, cls.key = directory / "cert.pem", directory / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(cls.key),
                        "-out", str(cls.cert), "-days", "1", "-subj", "/CN=x.com", "-addext",
                        "subjectAltName=DNS:x.com,DNS:abs.twimg.com"], check=True, capture_output=True, timeout=20)
        cls.cert.chmod(0o600)
        cls.key.chmod(0o600)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        cls.server.daemon_threads = True
        cls.server.lock = threading.Lock()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, cls.key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.tls_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.tls_thread.start()
        cls.proxy = ThreadedProxy(("127.0.0.1", 0), ProxyHandler)
        cls.proxy.tls_port = cls.server.server_address[1]
        cls.proxy_thread = threading.Thread(target=cls.proxy.serve_forever, daemon=True)
        cls.proxy_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.proxy.shutdown()
        cls.proxy.server_close()
        cls.proxy_thread.join(timeout=5)
        cls.server.shutdown()
        cls.server.server_close()
        cls.tls_thread.join(timeout=5)
        cls.private.cleanup()

    def setUp(self):
        self.server.observed = []
        self.server.plans = {}
        self.server.rate_headers = True
        self.server.remaining = 49
        self.server.reset = int(time.time()) + 120
        self.server.graphql_error = False
        self.server.redirect = False
        self.proxy.observed = []

    def run_bridge(self, operations, proxy="", certificate=None):
        commands = [{"op": "init", "authToken": AUTH, "ct0": CSRF, **({"proxy": proxy} if proxy else {})},
                    *operations, {"op": "close"}]
        process = subprocess.run([sys.executable, "-I", str(HERE / "bridge.py"), str(self.server.server_address[1]), str(certificate or self.cert)],
                                 input="".join(json.dumps(value) + "\n" for value in commands).encode(),
                                 capture_output=True, timeout=30, check=True)
        self.assertEqual(process.stderr, b"")
        self.assertNotIn(AUTH.encode(), process.stdout)
        self.assertNotIn(CSRF.encode(), process.stdout)
        replies = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual(len(replies), len(commands))
        self.assertEqual(replies[0], {"ok": True, "protocol": 1})
        self.assertEqual(replies[-1], {"ok": True})
        return replies[1:-1]

    def graphql_requests(self):
        return [entry for entry in self.server.observed if entry["operation"]]

    def test_all_operations_use_real_signatures_and_cookie_scope(self):
        operations = [{"op": "user", "username": "alice"}, {"op": "timeline", "userId": "42", "count": 5},
                      {"op": "replies", "userId": "42", "cursor": "A"}, {"op": "list", "listId": "123"},
                      {"op": "search", "query": "from:alice topic"}, {"op": "detail", "tweetId": "120"},
                      {"op": "thread", "tweetId": "120", "cursor": "B"}, {"op": "list_members", "listId": "123"}]
        replies = self.run_bridge(operations)
        self.assertTrue(all(reply["ok"] for reply in replies))
        self.assertTrue(all(reply["data"]["data"]["synthetic_id"] == "2111520482914877569" for reply in replies))
        actual = self.graphql_requests()
        self.assertEqual([item["operation"] for item in actual], ["UserByScreenName", "UserTweets", "UserTweetsAndReplies", "ListLatestTweetsTimeline", "SearchTimeline", "TweetDetail", "TweetDetail", "ListMembers"])
        self.assertTrue(all(item["signatureValid"] for item in actual))
        self.assertEqual(len(self.server.observed), 10, "one real bootstrap plus one signing asset for eight operations")
        for item in self.server.observed:
            headers = item["headers"]
            if item["path"].startswith("/x-web/"):
                self.assertFalse(any(name in headers for name in ("cookie", "authorization", "x-csrf-token", "x-client-transaction-id")))
            else:
                self.assertEqual(headers["cookie"], f"auth_token={AUTH}; ct0={CSRF}")
                self.assertNotIn("SYNTHETIC_UPSTREAM_CHANGED", headers["cookie"])
            if item["operation"]:
                self.assertEqual(headers["x-csrf-token"], CSRF)
                variables = json.loads(item["query"]["variables"][0])
                if item["operation"] != "UserByScreenName":
                    self.assertFalse(variables["includePromotedContent"])
                if item["operation"] == "SearchTimeline":
                    self.assertEqual(variables["product"], "Latest")
                if item["operation"] == "TweetDetail":
                    self.assertIn("fieldToggles", item["query"])

    def test_http_429_preserves_safe_rate_metadata_without_retry(self):
        self.server.plans["UserTweets"] = [429]
        self.server.remaining = 0
        reply = self.run_bridge([{"op": "timeline", "userId": "42"}])[0]
        self.assertEqual(reply["code"], "RATE_LIMITED")
        self.assertEqual(reply["rateLimit"], {"operation": "UserTweets", "remaining": 0, "resetAt": self.server.reset * 1000})
        self.assertEqual(len(self.graphql_requests()), 1)

    def test_429_without_headers_is_classified_without_inventing_metadata(self):
        self.server.plans["UserTweets"] = [429]
        self.server.rate_headers = False
        reply = self.run_bridge([{"op": "timeline", "userId": "42"}])[0]
        self.assertEqual(reply["code"], "RATE_LIMITED")
        self.assertNotIn("rateLimit", reply)
        self.assertEqual(len(self.graphql_requests()), 1)

    def test_502_then_success_and_bounded_persistent_failure(self):
        self.server.plans["UserTweets"] = [502, 200]
        reply = self.run_bridge([{"op": "timeline", "userId": "42"}])[0]
        self.assertTrue(reply["ok"])
        self.assertEqual(len(self.graphql_requests()), 2)
        self.setUp()
        self.server.plans["UserTweets"] = [502, 502, 502, 200]
        reply = self.run_bridge([{"op": "timeline", "userId": "42"}])[0]
        self.assertEqual(reply["code"], "UPSTREAM_HTTP")
        self.assertEqual(len(self.graphql_requests()), 3)
        self.assertEqual(self.server.plans["UserTweets"], [200])

    def test_last_quota_success_and_graphql_error_keep_complete_document(self):
        self.server.remaining = 0
        self.server.graphql_error = True
        reply = self.run_bridge([{"op": "search", "query": "topic"}])[0]
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["responseError"], "RATE_LIMITED")
        self.assertEqual(reply["data"]["errors"], [{"code": 88}])
        self.assertIn("data", reply["data"])
        self.assertEqual(reply["rateLimit"]["remaining"], 0)

    def test_begin_reuses_real_loaded_signer_without_new_bootstrap(self):
        replies = self.run_bridge([{"op": "user", "username": "alice"}, {"op": "begin"}, {"op": "timeline", "userId": "42"}])
        self.assertTrue(all(reply["ok"] for reply in replies))
        self.assertEqual(sum(item["path"] == "/tesla" for item in self.server.observed), 1)
        self.assertEqual(sum(item["path"].startswith("/x-web/") for item in self.server.observed), 1)
        self.assertTrue(all(item["signatureValid"] for item in self.graphql_requests()))

    def test_explicit_http_proxy_uses_connect_and_preserves_verified_tls(self):
        proxy = f"http://127.0.0.1:{self.proxy.server_address[1]}"
        reply = self.run_bridge([{"op": "timeline", "userId": "42"}], proxy=proxy)[0]
        self.assertTrue(reply["ok"], reply)
        self.assertEqual({item["host"] for item in self.proxy.observed}, {"x.com", "abs.twimg.com"})
        self.assertTrue(all(item["signatureValid"] for item in self.graphql_requests()))
        self.assertEqual(len(self.server.observed), 3)

    def test_tls_verification_rejects_an_untrusted_certificate(self):
        wrong = Path(self.private.name) / "wrong.pem"
        wrong_key = Path(self.private.name) / "wrong-key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(wrong_key),
                        "-out", str(wrong), "-days", "1", "-subj", "/CN=wrong.invalid"], check=True, capture_output=True, timeout=20)
        reply = self.run_bridge([{"op": "timeline", "userId": "42"}], certificate=wrong)[0]
        self.assertEqual(reply["code"], "NETWORK_ERROR")
        self.assertEqual(self.server.observed, [])


if __name__ == "__main__":
    unittest.main()
