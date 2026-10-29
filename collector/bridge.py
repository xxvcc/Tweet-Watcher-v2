#!/usr/bin/env python3
"""Bounded JSON-lines bridge using pinned twscrape signing and operation metadata.

Only this transport touches the network. Upstream API pagination, account pools,
model parsing, login, diagnostics and telemetry are deliberately never invoked.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
SOURCE_COMMIT = "63f61a518e576ea5c132f1156c03dda0520d76c1"
VERSION = "0.20.1+63f61a5"
MAX_INPUT = 32768
MAX_BODY = 8 * 1024 * 1024
MAX_TOTAL_BODY = 64 * 1024 * 1024
MAX_REQUESTS = 128
REQUEST_TIMEOUT = 18
MAX_OPERATIONS = 8

# Set before importing upstream modules. No environment setting can enable dumps
# or telemetry through this bridge, and no upstream network client is created.
os.environ["TWS_TELEMETRY"] = "0"
os.environ["DO_NOT_TRACK"] = "1"
os.environ["TWS_LOG_LEVEL"] = "CRITICAL"
os.environ["TWS_HTTP_BACKEND"] = "curl"
os.environ.pop("SSLKEYLOGFILE", None)
os.umask(0o077)
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
except (ImportError, ValueError, OSError):
    pass


def verify_source():
    lock = json.loads((ROOT / "source-lock.json").read_text())
    if lock.get("commit") != SOURCE_COMMIT:
        raise RuntimeError("source mismatch")
    for name, expected in lock["files"].items():
        path = ROOT / name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError("source mismatch")


verify_source()
sys.path.insert(0, str(ROOT / "vendor"))
from curl_cffi.requests import AsyncSession  # noqa: E402
from curl_cffi.curl import CURL_WRITEFUNC_ERROR  # noqa: E402
import bs4  # noqa: E402
from twscrape.account import TOKEN  # noqa: E402
from twscrape.api import GQL_FEATURES, OP_UserByScreenName, OP_UserTweets  # noqa: E402
from twscrape.logger import logger  # noqa: E402
from twscrape.xclid import XClIdGen, XClIdAccountError, load_keys, get_scripts_list, INDICES_FILE_RE  # noqa: E402

logger.remove()


MESSAGES = {
    "INVALID_REQUEST": "Invalid collector request",
    "NOT_INITIALIZED": "Collector credentials are not initialized",
    "ALREADY_INITIALIZED": "Collector credentials are already initialized",
    "URL_BLOCKED": "Collector blocked an unapproved upstream URL",
    "REDIRECT_BLOCKED": "Upstream redirected the request; collection stopped",
    "AUTH_REQUIRED": "X session is expired, restricted, or not signed in",
    "RATE_LIMITED": "X rate limit reached; retry later",
    "UPSTREAM_HTTP": "X returned an unsuccessful HTTP response",
    "NETWORK_ERROR": "Could not complete the upstream request",
    "RESPONSE_TOO_LARGE": "Upstream response exceeded the size budget",
    "REQUEST_BUDGET": "Collector request or response budget exhausted",
    "TIMEOUT": "Collector operation exceeded its time budget",
    "SIGNING_FAILED": "Could not initialize X request signing",
    "INVALID_RESPONSE": "Upstream returned an invalid JSON document",
    "INTERNAL_ERROR": "Collector failed safely",
}


class BridgeError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(MESSAGES[code])


def validate_url(url):
    if not isinstance(url, str) or len(url) > 4096 or any(ord(c) < 33 for c in url):
        raise BridgeError("URL_BLOCKED")
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
            raise BridgeError("URL_BLOCKED")
    except ValueError:
        raise BridgeError("URL_BLOCKED") from None
    if parsed.hostname == "x.com":
        if parsed.path != "/tesla" and not re.fullmatch(r"/i/api/graphql/[A-Za-z0-9_-]+/[A-Za-z0-9_]+", parsed.path):
            raise BridgeError("URL_BLOCKED")
        return True
    if parsed.hostname == "abs.twimg.com" and re.fullmatch(r"/(?:x-web|responsive-web/client-web)/[A-Za-z0-9_./~-]+\.js", parsed.path) and not parsed.query:
        if any(part in (".", "..") for part in parsed.path.split("/")):
            raise BridgeError("URL_BLOCKED")
        return False
    raise BridgeError("URL_BLOCKED")


class SafeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self.body = body
        self.text = body.decode("utf-8", errors="replace")

    def raise_for_status(self):
        if 300 <= self.status_code < 400:
            raise BridgeError("REDIRECT_BLOCKED")
        if self.status_code in (401, 403):
            raise BridgeError("AUTH_REQUIRED")
        if self.status_code == 429:
            raise BridgeError("RATE_LIMITED")
        if not 200 <= self.status_code < 300:
            raise BridgeError("UPSTREAM_HTTP")


class SafeTransport:
    def __init__(self, auth_token, ct0, session=None):
        self.auth_token = auth_token
        self.ct0 = ct0
        self.session = session or AsyncSession(max_clients=4, trust_env=False, impersonate="chrome", timeout=REQUEST_TIMEOUT)
        self.semaphore = asyncio.Semaphore(4)
        self.requests = 0
        self.total_bytes = 0

    async def get(self, url, *, params=None, transaction=None):
        authenticated = validate_url(url)
        headers = {"accept": "*/*"}
        if authenticated:
            headers["cookie"] = f"auth_token={self.auth_token}; ct0={self.ct0}"
            if "/i/api/graphql/" in urlsplit(url).path:
                headers.update({
                    "authorization": TOKEN,
                    "x-csrf-token": self.ct0,
                    "x-twitter-active-user": "yes",
                    "x-twitter-client-language": "en",
                    "content-type": "application/json",
                })
                if transaction:
                    headers["x-client-transaction-id"] = transaction
        async with self.semaphore:
            if self.requests >= MAX_REQUESTS or self.total_bytes >= MAX_TOTAL_BODY:
                raise BridgeError("REQUEST_BUDGET")
            self.requests += 1
            chunks = bytearray()
            failure = None

            def receive(chunk):
                nonlocal failure
                self.total_bytes += len(chunk)
                if len(chunks) + len(chunk) > MAX_BODY:
                    failure = "RESPONSE_TOO_LARGE"
                    return CURL_WRITEFUNC_ERROR
                if self.total_bytes > MAX_TOTAL_BODY:
                    failure = "REQUEST_BUDGET"
                    return CURL_WRITEFUNC_ERROR
                chunks.extend(chunk)
                return len(chunk)

            try:
                rep = await self.session.request(
                    "GET", url, params=params, headers=headers,
                    allow_redirects=False, max_redirects=0, timeout=REQUEST_TIMEOUT,
                    verify=True, proxy="", discard_cookies=True,
                    content_callback=receive,
                )
                if failure:
                    raise BridgeError(failure)
            except BridgeError:
                raise
            except asyncio.CancelledError:
                raise
            except Exception:
                raise BridgeError(failure or "NETWORK_ERROR") from None
            result = SafeResponse(rep.status_code, bytes(chunks))
            result.raise_for_status()
            return result

    async def post(self, *args, **kwargs):
        raise BridgeError("URL_BLOCKED")

    async def aclose(self):
        await self.session.close()
        self.auth_token = self.ct0 = ""


def preserve_ids(value, key=""):
    """Avoid loss of Snowflake precision when raw JSON crosses into JavaScript."""
    if isinstance(value, dict):
        return {k: preserve_ids(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [preserve_ids(v, key) for v in value]
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 9007199254740991 or key == "id" or key.endswith(("_id", "_ids")):
            return str(value)
    return value


USER_FEATURES = {
    "highlights_tweets_tab_ui_enabled": True,
    "hidden_profile_likes_enabled": True,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "hidden_profile_subscriptions_enabled": True,
    "subscriptions_verification_info_verified_since_enabled": True,
    "subscriptions_verification_info_is_identity_verified_enabled": False,
    "responsive_web_twitter_article_notes_tab_enabled": False,
    "subscriptions_feature_can_gift_premium": False,
    "profile_label_improvements_pcf_label_in_post_enabled": False,
}


class Bridge:
    def __init__(self, transport_factory=SafeTransport):
        self.transport_factory = transport_factory
        self.transport = None
        self.signer = None
        self.operations = 0

    async def signing(self):
        if self.signer is not None:
            return self.signer
        try:
            async with asyncio.timeout(60):
                response = await self.transport.get("https://x.com/tesla")
                # A legacy page can advertise >1,000 chunks while naming the
                # signing script directly. Upstream fetches only that one.
                # Bound task creation only when a chunk search is necessary.
                scripts = get_scripts_list(response.text)
                scripts = [url for url in scripts if "/x-web/" in url] or scripts
                if not any(INDICES_FILE_RE.search(url) for url in scripts) and len(scripts) > 256:
                    raise BridgeError("REQUEST_BUDGET")
                soup = bs4.BeautifulSoup(response.text, "html.parser")
                key, animation = await load_keys(soup, self.transport)
                self.signer = XClIdGen(key, animation)
        except BridgeError:
            raise
        except XClIdAccountError:
            raise BridgeError("AUTH_REQUIRED") from None
        except TimeoutError:
            raise BridgeError("TIMEOUT") from None
        except Exception:
            raise BridgeError("SIGNING_FAILED") from None
        return self.signer

    async def graphql(self, operation, variables, features=None):
        signer = await self.signing()
        path = f"/i/api/graphql/{operation}"
        params = {
            "variables": json.dumps(variables, separators=(",", ":")),
            "features": json.dumps({**GQL_FEATURES, **(features or {})}, separators=(",", ":")),
        }
        response = await self.transport.get("https://x.com" + path, params=params, transaction=signer.calc("GET", path))
        try:
            data = json.loads(response.body)
            if not isinstance(data, dict):
                raise ValueError()
            return {"ok": True, "data": preserve_ids(data)}
        except (ValueError, RecursionError, UnicodeError):
            raise BridgeError("INVALID_RESPONSE") from None

    async def handle(self, request):
        if not isinstance(request, dict):
            raise BridgeError("INVALID_REQUEST")
        op = request.get("op")
        if op == "init":
            if self.transport is not None:
                raise BridgeError("ALREADY_INITIALIZED")
            auth_token, ct0 = request.get("authToken"), request.get("ct0")
            if not all(isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9_%.-]{1,4096}", x) for x in (auth_token, ct0)):
                raise BridgeError("INVALID_REQUEST")
            self.transport = self.transport_factory(auth_token, ct0)
            return {"ok": True, "protocol": 1}
        if self.transport is None:
            raise BridgeError("NOT_INITIALIZED")
        if self.operations >= MAX_OPERATIONS:
            raise BridgeError("REQUEST_BUDGET")
        if op == "user":
            username = request.get("username")
            if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,15}", username):
                raise BridgeError("INVALID_REQUEST")
            self.operations += 1
            return await self.graphql(OP_UserByScreenName, {"screen_name": username, "withSafetyModeUserFields": True}, USER_FEATURES)
        if op == "timeline":
            user_id, count, cursor = request.get("userId"), request.get("count", 40), request.get("cursor")
            if not isinstance(user_id, str) or not re.fullmatch(r"[1-9][0-9]{0,24}", user_id):
                raise BridgeError("INVALID_REQUEST")
            if type(count) is not int or not 1 <= count <= 50:
                raise BridgeError("INVALID_REQUEST")
            if cursor is not None and (not isinstance(cursor, str) or not 1 <= len(cursor) <= 4096 or any(ord(c) < 32 for c in cursor)):
                raise BridgeError("INVALID_REQUEST")
            variables = {"userId": user_id, "count": count, "includePromotedContent": False, "withQuickPromoteEligibilityTweetFields": True, "withVoice": True, "withV2Timeline": True}
            if cursor is not None:
                variables["cursor"] = cursor
            self.operations += 1
            return await self.graphql(OP_UserTweets, variables)
        raise BridgeError("INVALID_REQUEST")

    async def close(self):
        if self.transport:
            await self.transport.aclose()


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


async def run():
    bridge = Bridge()
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_INPUT + 1)
            if not line:
                return
            if len(line) > MAX_INPUT or not line.endswith(b"\n"):
                emit({"ok": False, "code": "INVALID_REQUEST", "error": MESSAGES["INVALID_REQUEST"]})
                return
            try:
                request = json.loads(line)
                if isinstance(request, dict) and request.get("op") == "close":
                    emit({"ok": True})
                    return
                async with asyncio.timeout(80):
                    emit(await bridge.handle(request))
            except BridgeError as exc:
                emit({"ok": False, "code": exc.code, "error": MESSAGES[exc.code]})
            except TimeoutError:
                emit({"ok": False, "code": "TIMEOUT", "error": MESSAGES["TIMEOUT"]})
            except (ValueError, UnicodeError, RecursionError):
                emit({"ok": False, "code": "INVALID_REQUEST", "error": MESSAGES["INVALID_REQUEST"]})
            except Exception:
                emit({"ok": False, "code": "INTERNAL_ERROR", "error": MESSAGES["INTERNAL_ERROR"]})
    finally:
        await bridge.close()


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="strict", newline="\n")
        if sys.argv[1:] == ["--version"]:
            emit({"protocol": 1, "version": VERSION, "sourceCommit": SOURCE_COMMIT})
        elif len(sys.argv) == 1:
            asyncio.run(run())
        else:
            raise BridgeError("INVALID_REQUEST")
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    except Exception:
        # Never expose exception text, response bodies, Cookie, or request headers.
        sys.exit(1)
