"""Exercise actual curl against a local TLS server; no upstream network traffic."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from curl_cffi import CurlOpt
from curl_cffi.requests import AsyncSession

from test_bridge import b


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.observed.append(dict(self.headers))
        if "redirect=1" in self.path:
            self.send_response(302)
            self.send_header("Location", "https://abs.twimg.com/x-web/redirect-target.js")
            body = b"redirect"
        else:
            self.send_response(200)
            self.send_header("Set-Cookie", "ct0=UPSTREAM_CHANGED_COOKIE; Domain=.x.com; Path=/; Secure")
            body = b"x" * 32768 if "large=1" in self.path else b'{"data":{}}'
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class NativeTransportTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.private = tempfile.TemporaryDirectory(prefix="watcher-collector-tls-")
        root = Path(cls.private.name)
        cls.cert = root / "cert.pem"
        key = root / "key.pem"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cls.cert), "-days", "1",
            "-subj", "/CN=x.com", "-addext", "subjectAltName=DNS:x.com,DNS:abs.twimg.com",
        ], check=True, capture_output=True, timeout=20)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.observed = []
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.private.cleanup()

    async def asyncSetUp(self):
        self.server.observed.clear()
        port = self.server.server_address[1]
        class RoutedSession(AsyncSession):
            async def request(self, method, url, **kwargs):
                url = url.replace("https://x.com/", f"https://x.com:{port}/")
                url = url.replace("https://abs.twimg.com/", f"https://abs.twimg.com:{port}/")
                return await super().request(method, url, **kwargs)
        session = RoutedSession(
            impersonate="chrome", trust_env=False, verify=str(self.cert),
            curl_options={CurlOpt.RESOLVE: [
                f"x.com:{port}:127.0.0.1".encode(),
                f"abs.twimg.com:{port}:127.0.0.1".encode(),
            ]},
        )
        self.transport = b.SafeTransport("SYNTHETIC_NATIVE_AUTH", "SYNTHETIC_NATIVE_CSRF", session)

    async def asyncTearDown(self):
        await self.transport.aclose()

    async def test_native_tls_cookie_and_csrf_scope_across_reused_session(self):
        await self.transport.get("https://x.com/i/api/graphql/op/UserTweets", transaction="test")
        await self.transport.get("https://abs.twimg.com/x-web/main.js")
        await self.transport.get("https://x.com/i/api/graphql/op/UserTweets", transaction="test")
        headers = [{key.lower(): value for key, value in record.items()} for record in self.server.observed]
        self.assertEqual(len(headers), 3)
        for index in (0, 2):
            self.assertIn("SYNTHETIC_NATIVE_AUTH", headers[index]["cookie"])
            self.assertIn("SYNTHETIC_NATIVE_CSRF", headers[index]["cookie"])
            self.assertEqual(headers[index]["x-csrf-token"], "SYNTHETIC_NATIVE_CSRF")
            self.assertNotIn("UPSTREAM_CHANGED_COOKIE", headers[index]["cookie"])
        self.assertNotIn("cookie", headers[1])
        self.assertNotIn("x-csrf-token", headers[1])
        self.assertNotIn("authorization", headers[1])
        self.assertNotIn("x-client-transaction-id", headers[1])

    async def test_native_tls_redirect_does_not_make_second_request(self):
        with self.assertRaises(b.BridgeError) as caught:
            await self.transport.get("https://x.com/tesla?redirect=1")
        self.assertEqual(caught.exception.code, "REDIRECT_BLOCKED")
        self.assertEqual(len(self.server.observed), 1)

    async def test_native_tls_callback_aborts_large_response(self):
        with patch.object(b, "MAX_BODY", 1024):
            with self.assertRaises(b.BridgeError) as caught:
                await self.transport.get("https://x.com/tesla?large=1")
        self.assertEqual(caught.exception.code, "RESPONSE_TOO_LARGE")
        self.assertEqual(len(self.server.observed), 1)
        self.assertLess(self.transport.total_bytes, 32768)


if __name__ == "__main__":
    unittest.main()
