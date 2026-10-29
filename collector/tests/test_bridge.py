import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("watcher_bridge", ROOT / "bridge.py")
b = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(b)


class FakeSession:
    def __init__(self, status=200, chunks=None, error=None):
        self.status = status
        self.chunks = chunks if chunks is not None else [b'{"data":{}}']
        self.calls = []
        self.error = error
        self.closed = False

    async def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.error:
            raise self.error
        for chunk in self.chunks:
            if kwargs["content_callback"](chunk) != len(chunk):
                raise RuntimeError("native callback aborted")
        return SimpleNamespace(status_code=self.status)

    async def close(self):
        self.closed = True


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session = FakeSession()
        self.transport = b.SafeTransport("SYNTHETIC_AUTH", "SYNTHETIC_CSRF", self.session)

    async def asyncTearDown(self):
        await self.transport.aclose()

    async def assertCode(self, code, awaitable):
        with self.assertRaises(b.BridgeError) as caught:
            await awaitable
        self.assertEqual(caught.exception.code, code)

    async def test_credential_scope_and_request_safety(self):
        await self.transport.get("https://x.com/i/api/graphql/operation/UserTweets", transaction="signed")
        opts = self.session.calls[-1][1]
        self.assertEqual(opts["headers"]["cookie"], "auth_token=SYNTHETIC_AUTH; ct0=SYNTHETIC_CSRF")
        self.assertEqual(opts["headers"]["x-csrf-token"], "SYNTHETIC_CSRF")
        self.assertEqual(opts["headers"]["x-client-transaction-id"], "signed")
        self.assertFalse(opts["allow_redirects"])
        self.assertEqual(opts["max_redirects"], 0)
        self.assertEqual(opts["proxy"], "")
        self.assertTrue(opts["verify"])
        self.assertTrue(opts["discard_cookies"])
        await self.transport.get("https://abs.twimg.com/x-web/client/main.js")
        headers = self.session.calls[-1][1]["headers"]
        self.assertEqual(headers, {"accept": "*/*"})

    async def test_bootstrap_does_not_send_graphql_headers(self):
        await self.transport.get("https://x.com/tesla")
        self.assertEqual(set(self.session.calls[-1][1]["headers"]), {"accept", "cookie"})

    async def test_all_redirects_are_terminal(self):
        for status in (301, 302, 303, 307, 308):
            self.session.status = status
            await self.assertCode("REDIRECT_BLOCKED", self.transport.get("https://x.com/tesla"))
        self.assertEqual(len(self.session.calls), 5)

    async def test_http_error_classification(self):
        for status, code in ((401, "AUTH_REQUIRED"), (403, "AUTH_REQUIRED"), (429, "RATE_LIMITED"), (500, "UPSTREAM_HTTP")):
            self.session.status = status
            await self.assertCode(code, self.transport.get("https://x.com/tesla"))

    async def test_arbitrary_hosts_rejected_before_network(self):
        urls = ["http://x.com/tesla", "https://x.com.attacker.invalid/tesla", "https://evil.invalid/x-web/main.js", "https://x.com@evil.invalid/tesla", "https://x.com:8443/tesla", "https://api.x.com/tesla", "file:///etc/passwd", "https://127.0.0.1/tesla", "https://x.com./tesla", "https://x.com/tesla#fragment", "https://x.com/tesla\r\nCookie: leak", "https://x.com:bad/tesla"]
        for url in urls:
            await self.assertCode("URL_BLOCKED", self.transport.get(url))
        self.assertEqual(self.session.calls, [])

    async def test_only_expected_paths_allowed(self):
        for url in ("https://x.com/i/flow/login", "https://x.com/x/migrate", "https://abs.twimg.com/private.json", "https://abs.twimg.com/x-web/../secret.js", "https://abs.twimg.com/x-web/main.js?leak=1"):
            await self.assertCode("URL_BLOCKED", self.transport.get(url))
        await self.transport.get("https://abs.twimg.com/responsive-web/client-web/shared~feature.abc123a.js")
        self.assertEqual(len(self.session.calls), 1)

    async def test_post_never_reaches_network(self):
        await self.assertCode("URL_BLOCKED", self.transport.post("https://x.com/x/migrate", json={}))
        self.assertEqual(self.session.calls, [])

    async def test_size_cap_aborts_before_buffering_entire_body(self):
        self.session.chunks = [b"12345", b"67890", b"ignored"]
        with patch.object(b, "MAX_BODY", 8):
            await self.assertCode("RESPONSE_TOO_LARGE", self.transport.get("https://x.com/tesla"))
        self.assertEqual(self.transport.total_bytes, 10)

    async def test_aggregate_response_budget(self):
        self.session.chunks = [b"12345"]
        with patch.object(b, "MAX_TOTAL_BODY", 8):
            await self.transport.get("https://x.com/tesla")
            await self.assertCode("REQUEST_BUDGET", self.transport.get("https://x.com/tesla"))

    async def test_request_budget_stops_before_next_request(self):
        self.transport.requests = b.MAX_REQUESTS
        await self.assertCode("REQUEST_BUDGET", self.transport.get("https://x.com/tesla"))
        self.assertEqual(self.session.calls, [])

    async def test_exception_text_is_not_exposed(self):
        self.session.error = RuntimeError("Cookie: auth_token=SYNTHETIC_AUTH; ct0=SYNTHETIC_CSRF")
        with self.assertRaises(b.BridgeError) as caught:
            await self.transport.get("https://x.com/tesla")
        self.assertEqual(caught.exception.code, "NETWORK_ERROR")
        self.assertNotIn("SYNTHETIC", str(caught.exception))

    async def test_close_drops_credentials(self):
        await self.transport.aclose()
        self.assertTrue(self.session.closed)
        self.assertEqual(self.transport.auth_token, "")
        self.assertEqual(self.transport.ct0, "")


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session = FakeSession()
        self.transport = b.SafeTransport("a", "b", self.session)
        self.bridge = b.Bridge(lambda _auth, _csrf: self.transport)

    async def asyncTearDown(self):
        await self.bridge.close()

    async def initialize(self):
        self.assertEqual(await self.bridge.handle({"op": "init", "authToken": "a", "ct0": "b"}), {"ok": True, "protocol": 1})
        self.bridge.signer = b.XClIdGen([1, 2, 3], "synthetic-animation")

    async def assertCode(self, code, request):
        with self.assertRaises(b.BridgeError) as caught:
            await self.bridge.handle(request)
        self.assertEqual(caught.exception.code, code)

    async def test_requires_init(self):
        await self.assertCode("NOT_INITIALIZED", {"op": "user", "username": "example"})
        self.assertEqual(self.session.calls, [])

    async def test_rejects_reinitialization(self):
        await self.initialize()
        await self.assertCode("ALREADY_INITIALIZED", {"op": "init", "authToken": "a", "ct0": "b"})

    async def test_rejects_cookie_header_injection(self):
        for token in (None, 1, "", "a;b=c", "a\r\nx: injected", "a b", "a" * 4097):
            await self.assertCode("INVALID_REQUEST", {"op": "init", "authToken": token, "ct0": "b"})
        self.assertIsNone(self.bridge.transport)

    async def test_page_and_errors_preserved_without_filtering(self):
        await self.initialize()
        data = {"data": {"instructions": [{"type": "TimelinePinEntry", "entry": {"id": 123}}]}, "errors": [{"code": 88, "message": "synthetic"}]}
        self.session.chunks = [json.dumps(data).encode()]
        result = await self.bridge.handle({"op": "timeline", "userId": "9007199254740993", "count": 50, "cursor": "A+B=="})
        self.assertEqual(result["data"]["errors"], data["errors"])
        self.assertEqual(result["data"]["data"]["instructions"][0]["entry"]["id"], "123")
        args, opts = self.session.calls[-1]
        self.assertIn(b.OP_UserTweets, args[1])
        self.assertEqual(json.loads(opts["params"]["variables"])["cursor"], "A+B==")
        self.assertEqual(json.loads(opts["params"]["variables"])["userId"], "9007199254740993")
        self.assertIs(json.loads(opts["params"]["variables"])["includePromotedContent"], False)

    async def test_user_uses_pinned_operation_and_features(self):
        await self.initialize()
        await self.bridge.handle({"op": "user", "username": "example"})
        args, opts = self.session.calls[-1]
        self.assertTrue(args[1].endswith(b.OP_UserByScreenName))
        self.assertEqual(json.loads(opts["params"]["variables"])["screen_name"], "example")
        self.assertIn("highlights_tweets_tab_ui_enabled", json.loads(opts["params"]["features"]))

    async def test_username_path_injection_and_invalid_count_blocked(self):
        await self.initialize()
        for name in ("a/b", "@example", "a" * 16, None):
            await self.assertCode("INVALID_REQUEST", {"op": "user", "username": name})
        for count in (0, 51, True, "50", 1.5):
            await self.assertCode("INVALID_REQUEST", {"op": "timeline", "userId": "123", "count": count})
        self.assertEqual(self.session.calls, [])

    async def test_numeric_ids_must_arrive_as_strings(self):
        await self.initialize()
        for user_id in (123, "0", "01", "-1", "1/anything", "1" * 26):
            await self.assertCode("INVALID_REQUEST", {"op": "timeline", "userId": user_id})

    async def test_cursor_validation(self):
        await self.initialize()
        for cursor in ("", 1, "bad\nline", "a" * 4097):
            await self.assertCode("INVALID_REQUEST", {"op": "timeline", "userId": "1", "cursor": cursor})

    async def test_operation_budget(self):
        await self.initialize()
        self.bridge.operations = b.MAX_OPERATIONS
        await self.assertCode("REQUEST_BUDGET", {"op": "user", "username": "example"})
        self.assertEqual(self.session.calls, [])

    async def test_invalid_json_document_fails(self):
        await self.initialize()
        for body in (b"not JSON", b"[]", b"null", b'{"invalid":'):
            self.session.chunks = [body]
            await self.assertCode("INVALID_RESPONSE", {"op": "user", "username": "example"})

    async def test_logged_out_signing_fails_explicitly(self):
        await self.initialize()
        self.bridge.signer = None
        self.session.chunks = [b'<script src="https://abs.twimg.com/x-web/client-web/entry-client-logged-out-abc.js"></script>']
        await self.assertCode("AUTH_REQUIRED", {"op": "user", "username": "example"})
        self.assertEqual(len(self.session.calls), 1)

    async def test_signing_asset_injection_never_reaches_network(self):
        await self.initialize()
        self.bridge.signer = None
        self.session.chunks = [b'<script src="https://attacker.invalid/x-web/sign.o-secret.js"></script>']
        await self.assertCode("URL_BLOCKED", {"op": "user", "username": "example"})
        self.assertEqual(len(self.session.calls), 1)

    async def test_signing_asset_task_budget(self):
        await self.initialize()
        self.bridge.signer = None
        self.session.chunks = ["".join(f'<script src="https://abs.twimg.com/x-web/a{i}.js"></script>' for i in range(257)).encode()]
        await self.assertCode("REQUEST_BUDGET", {"op": "user", "username": "example"})
        self.assertEqual(len(self.session.calls), 1)

    async def test_large_manifest_with_direct_signing_script_needs_no_chunk_search(self):
        await self.initialize()
        self.bridge.signer = None
        html = "".join(f'<script src="https://abs.twimg.com/x-web/a{i}.js"></script>' for i in range(1000))
        html += '<script src="https://abs.twimg.com/x-web/sign.o-direct.js"></script>'
        self.session.chunks = [html.encode()]
        async def fake_load(soup, transport):
            return [1, 2, 3], "test-animation"
        with patch.object(b, "load_keys", fake_load):
            signer = await self.bridge.signing()
        self.assertIsInstance(signer, b.XClIdGen)
        self.assertEqual(len(self.session.calls), 1)


class StaticAndProcessTests(unittest.TestCase):
    def test_source_manifest_matches(self):
        b.verify_source()

    def test_id_conversion_preserves_counts_and_bools(self):
        item = {"id": 123, "reply_to_id": 42, "edit_tweet_ids": [123, 456], "counter": 9, "huge": 9007199254740993, "bool": True}
        self.assertEqual(b.preserve_ids(item), {"id": "123", "reply_to_id": "42", "edit_tweet_ids": ["123", "456"], "counter": 9, "huge": "9007199254740993", "bool": True})

    def test_version_and_isolated_startup(self):
        proc = subprocess.run([sys.executable, "-I", str(ROOT / "bridge.py"), "--version"], capture_output=True, timeout=10, check=True)
        self.assertEqual(json.loads(proc.stdout), {"protocol": 1, "version": b.VERSION, "sourceCommit": b.SOURCE_COMMIT})
        self.assertEqual(proc.stderr, b"")

    def test_protocol_never_echoes_credentials_or_bad_input(self):
        secret = "SYNTHETIC_SECRET_NEVER_ECHO"
        requests = [{"op": "init", "authToken": secret, "ct0": secret}, {"op": "bad", "content": secret}, {"op": "close"}]
        proc = subprocess.run([sys.executable, "-I", str(ROOT / "bridge.py")], input="".join(json.dumps(x) + "\n" for x in requests).encode(), capture_output=True, timeout=10, check=True)
        self.assertNotIn(secret.encode(), proc.stdout + proc.stderr)
        output = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertTrue(output[0]["ok"])
        self.assertEqual(output[1]["code"], "INVALID_REQUEST")
        self.assertTrue(output[2]["ok"])
        self.assertEqual(proc.stderr, b"")

    def test_oversized_input_terminates(self):
        proc = subprocess.run([sys.executable, "-I", str(ROOT / "bridge.py")], input=b"x" * (b.MAX_INPUT + 1) + b"\n", capture_output=True, timeout=10, check=True)
        self.assertEqual(json.loads(proc.stdout)["code"], "INVALID_REQUEST")
        self.assertEqual(proc.stderr, b"")

    def test_telemetry_forced_disabled(self):
        self.assertEqual(os.environ["TWS_TELEMETRY"], "0")
        self.assertEqual(os.environ["DO_NOT_TRACK"], "1")

    def test_unicode_output_is_utf8_once_and_one_protocol_line(self):
        # Exercise a real pipe with a large UTF-8 document and embedded newlines.
        # ASCII escaping would grow this 6 MiB string beyond Node's 12 MiB cap.
        program = (
            "import sys;sys.path.insert(0,sys.argv[1]);import bridge;"
            "sys.stdout.reconfigure(encoding='utf-8',errors='strict',newline='\\n');"
            "bridge.emit({'ok':True,'text':'中文😀\\n'*524288})"
        )
        proc = subprocess.run([sys.executable, "-I", "-c", program, str(ROOT)], capture_output=True, timeout=10, check=True)
        self.assertLess(len(proc.stdout), 12 * 1024 * 1024)
        self.assertEqual(proc.stdout.count(b"\n"), 1)
        decoded = json.loads(proc.stdout)
        self.assertEqual(decoded["text"], "中文😀\n" * 524288)
        self.assertIn("中文😀".encode(), proc.stdout)
        self.assertNotIn(b"\\u4e2d", proc.stdout)
        self.assertEqual(proc.stderr, b"")


if __name__ == "__main__":
    unittest.main()
