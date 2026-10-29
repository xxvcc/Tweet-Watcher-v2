"""Exercise actual curl against a local TLS server; no upstream network traffic."""
import asyncio
from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from curl_cffi import CurlOpt
from curl_cffi.requests import AsyncSession as UnguardedSession

from test_bridge import b


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            # Expected when cancellation, size bounds, or a denied send permit
            # closes the local TLS connection before a response is written.
            pass

    def do_GET(self):
        self.server.observed.append(dict(self.headers))
        self.server.peers.append(self.client_address)
        if "disconnect=1" in self.path:
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
            return
        if "slow=1" in self.path:
            self.server.slow_started.set()
            self.server.slow_release.wait(5)
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
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass


def routed_session(port, certificate):
    class RoutedSession(b.AsyncSession):
        async def request(self, method, url, **kwargs):
            url = url.replace("https://x.com/", f"https://x.com:{port}/")
            url = url.replace("https://abs.twimg.com/", f"https://abs.twimg.com:{port}/")
            return await super().request(method, url, **kwargs)
    return RoutedSession(
        impersonate="chrome", trust_env=False, verify=str(certificate),
        curl_options={CurlOpt.RESOLVE: [
            f"x.com:{port}:127.0.0.1".encode(),
            f"abs.twimg.com:{port}:127.0.0.1".encode(),
        ]},
    )


class NativeTransportTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.private = tempfile.TemporaryDirectory(prefix="watcher-collector-tls-")
        root = Path(cls.private.name)
        cls.cert = root / "cert.pem"
        cls.key = key = root / "key.pem"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cls.cert), "-days", "1",
            "-subj", "/CN=x.com", "-addext", "subjectAltName=DNS:x.com,DNS:abs.twimg.com",
        ], check=True, capture_output=True, timeout=20)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
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
        self.server.peers = []
        self.server.slow_started = threading.Event()
        self.server.slow_release = threading.Event()
        port = self.server.server_address[1]
        session = routed_session(port, self.cert)
        self.transport = b.SafeTransport("SYNTHETIC_NATIVE_AUTH", "SYNTHETIC_NATIVE_CSRF", session)

    async def asyncTearDown(self):
        self.server.slow_release.set()
        await self.transport.aclose()

    def assert_callbacks_released(self, session):
        self.assertEqual(session.pool.qsize(), session.max_clients)
        for handle in session.pool._queue:
            if handle is not None:
                self.assertIsNone(getattr(handle, "_collector_request_guard", None))

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

    async def test_reused_http1_socket_disconnect_stays_within_three_requests(self):
        await self.transport.get("https://x.com/tesla")
        with self.assertRaises(b.BridgeError) as caught:
            await self.transport.get("https://x.com/tesla?disconnect=1")
        self.assertEqual(caught.exception.code, "NETWORK_ERROR")
        self.assertEqual(len(self.server.observed), 4)
        self.assertEqual(self.server.peers[0], self.server.peers[1])
        self.assertEqual(self.transport.requests, 4)
        self.assert_callbacks_released(self.transport.session)

    async def test_concurrent_http1_requests_share_round_send_budget(self):
        with patch.object(b, "MAX_REQUESTS", 5):
            results = await asyncio.gather(*(
                self.transport.get("https://x.com/tesla") for _ in range(12)
            ), return_exceptions=True)
        self.assertEqual(sum(isinstance(result, b.SafeResponse) for result in results), 5)
        self.assertEqual([result.code for result in results if isinstance(result, b.BridgeError)], ["REQUEST_BUDGET"] * 7)
        self.assertEqual(len(self.server.observed), 5)
        self.assertEqual(self.transport.requests, 5)
        self.assert_callbacks_released(self.transport.session)

    async def test_guard_is_required_and_unguarded_native_session_cannot_bypass_it(self):
        with self.assertRaises(b.BridgeError) as caught:
            await self.transport.session.request("GET", "https://x.com/tesla")
        self.assertEqual(caught.exception.code, "REQUEST_BUDGET")
        async with UnguardedSession(trust_env=False) as session:
            transport = b.SafeTransport("SYNTHETIC_AUTH", "SYNTHETIC_CSRF", session)
            with self.assertRaises(b.BridgeError) as caught:
                await transport.get("https://x.com/tesla")
            self.assertEqual(caught.exception.code, "REQUEST_BUDGET")
        self.assertEqual(self.server.observed, [])
        self.assert_callbacks_released(self.transport.session)

    async def test_guard_install_failure_sends_nothing_and_returns_handle(self):
        with patch.object(b, "lib", SimpleNamespace(_curl_easy_setopt=lambda *_: 1)):
            with self.assertRaises(b.BridgeError) as caught:
                await self.transport.get("https://x.com/tesla")
        self.assertEqual(caught.exception.code, "REQUEST_BUDGET")
        self.assertEqual(self.server.observed, [])
        self.assertEqual(self.transport.requests, 0)
        self.assert_callbacks_released(self.transport.session)
        await self.transport.get("https://x.com/tesla")
        self.assertEqual(len(self.server.observed), 1)

    async def test_guard_exception_fails_closed_without_logging_exception_text(self):
        def broken_guard():
            raise RuntimeError("SYNTHETIC_PRIVATE_GUARD_MARKER")
        diagnostics = io.StringIO()
        with redirect_stderr(diagnostics):
            with self.assertRaises(Exception):
                await self.transport.session.request_with_guard(
                    "GET", "https://x.com/tesla", guard=broken_guard, proxy="",
                )
        self.assertEqual(diagnostics.getvalue(), "")
        self.assertEqual(self.server.observed, [])
        self.assert_callbacks_released(self.transport.session)
        await self.transport.get("https://x.com/tesla")
        self.assertEqual(len(self.server.observed), 1)

    async def test_cancellation_releases_guard_before_reusing_handle(self):
        task = asyncio.create_task(self.transport.get("https://x.com/tesla?slow=1"))
        self.assertTrue(await asyncio.to_thread(self.server.slow_started.wait, 5))
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.server.slow_release.set()
        self.assert_callbacks_released(self.transport.session)
        await self.transport.get("https://x.com/tesla")
        self.assertEqual(len(self.server.observed), 2)
        self.assertEqual(self.transport.requests, 2)
        self.assert_callbacks_released(self.transport.session)

    async def test_http2_refused_stream_retries_obey_per_get_and_concurrent_round_budgets(self):
        fixture = Path(__file__).with_name("native_h2_fixture.cjs")
        child = await asyncio.create_subprocess_exec(
            "node", str(fixture), str(self.cert), str(self.key),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        session = None
        try:
            info = json.loads(await asyncio.wait_for(child.stdout.readline(), 5))
            session = routed_session(info["port"], self.cert)
            transport = b.SafeTransport("SYNTHETIC_AUTH", "SYNTHETIC_CSRF", session)
            with self.assertRaises(b.BridgeError) as caught:
                await transport.get("https://x.com/tesla?refuse=1")
            self.assertEqual(caught.exception.code, "REQUEST_BUDGET")
            self.assertEqual(transport.requests, 3)
            self.assert_callbacks_released(session)

            # Two independent gets contend for the same remaining 5 permits.
            with patch.object(b, "MAX_REQUESTS", 8):
                results = await asyncio.gather(*(
                    transport.get("https://x.com/tesla?refuse=1") for _ in range(2)
                ), return_exceptions=True)
            self.assertEqual([result.code for result in results], ["REQUEST_BUDGET"] * 2)
            self.assertEqual(transport.requests, 8)
            self.assert_callbacks_released(session)
            child.stdin.write(b"stats\n")
            await child.stdin.drain()
            observed = json.loads(await asyncio.wait_for(child.stdout.readline(), 5))
            self.assertEqual(observed, {"requests": 8, "http2": True})
        finally:
            if session is not None:
                await session.close()
            if child.returncode is None:
                child.stdin.write(b"close\n")
                await child.stdin.drain()
            try:
                _, stderr = await asyncio.wait_for(child.communicate(), 5)
            except asyncio.TimeoutError:
                child.kill()
                await child.wait()
                raise
            self.assertEqual(child.returncode, 0)
            self.assertEqual(stderr, b"")


if __name__ == "__main__":
    unittest.main()
