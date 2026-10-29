#!/usr/bin/env python3
"""Bounded JSON-lines bridge using pinned twscrape signing and operation metadata.

Only this transport touches the network. Upstream API pagination, account pools,
model parsing, login, diagnostics and telemetry are deliberately never invoked.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
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
from curl_cffi import CurlOpt  # noqa: E402
from curl_cffi.requests import AsyncSession as CurlAsyncSession  # noqa: E402
from curl_cffi.curl import CURL_WRITEFUNC_ERROR, ffi, lib  # noqa: E402
import bs4  # noqa: E402
from twscrape.account import TOKEN  # noqa: E402
from twscrape.api import (GQL_FEATURES, OP_UserByScreenName, OP_UserTweets,  # noqa: E402
    OP_UserTweetsAndReplies, OP_ListLatestTweetsTimeline, OP_SearchTimeline,
    OP_TweetDetail, OP_ListMembers, ARTICLE_FIELD_TOGGLES)
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
    def __init__(self, code, rate_limit=None):
        self.code = code
        self.rate_limit = rate_limit
        super().__init__(MESSAGES[code])


def valid_proxy(value):
    if value == "":
        return True
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f\\?#\ud800-\udfff]", value):
        return False
    try:
        parsed = urlsplit(value)
        return (parsed.scheme in ("http", "https") and bool(parsed.hostname)
                and parsed.username is None and parsed.password is None and not parsed.query
                and not parsed.fragment and parsed.path in ("", "/")
                and parsed.port is not None and 1 <= parsed.port <= 65535)
    except ValueError:
        return False


def rate_metadata(url, headers):
    if "/i/api/graphql/" not in urlsplit(url).path:
        return None
    operation = urlsplit(url).path.rsplit("/", 1)[-1]
    if not re.fullmatch(r"[A-Za-z0-9_]{1,64}", operation):
        return None
    def number(name, maximum):
        value = headers.get(name)
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,13}", value):
            return None
        parsed = int(value)
        return parsed if parsed <= maximum else None
    remaining = number("x-rate-limit-remaining", 10000000)
    reset = number("x-rate-limit-reset", int(time.time()) + 86400)
    if remaining is None and reset is None:
        return None
    return {"operation": operation, "remaining": remaining, "resetAt": reset * 1000 if reset is not None else None}


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
    def __init__(self, status, body, rate_limit=None):
        self.status_code = status
        self.body = body
        self.text = body.decode("utf-8", errors="replace")
        self.rate_limit = rate_limit

    def raise_for_status(self):
        if 300 <= self.status_code < 400:
            raise BridgeError("REDIRECT_BLOCKED")
        if self.status_code in (401, 403):
            raise BridgeError("AUTH_REQUIRED", self.rate_limit)
        if self.status_code == 429:
            raise BridgeError("RATE_LIMITED", self.rate_limit)
        if not 200 <= self.status_code < 300:
            raise BridgeError("UPSTREAM_HTTP", self.rate_limit)


class AsyncSession(CurlAsyncSession):
    """Count native retries before libcurl can send another origin request.

    The pinned curl_cffi setopt wrapper does not expose PREREQFUNCTION, so use
    its native binding and check the result. Keep each callback alive until its
    own handle has been removed/reset; concurrent bootstrap requests have
    independent closures even though they share the connection pool.
    """
    def __init__(self, *args, **kwargs):
        kwargs["retry"] = 0
        super().__init__(*args, **kwargs)
        self._request_guard = ContextVar("collector_request_guard", default=None)

    async def request_with_guard(self, method, url, *, guard, **kwargs):
        token = self._request_guard.set(guard)
        try:
            return await self.request(method, url, **kwargs)
        finally:
            self._request_guard.reset(token)

    async def pop_curl(self):
        guard = self._request_guard.get()
        if not callable(guard):
            raise BridgeError("REQUEST_BUDGET")
        curl = await super().pop_curl()

        def before_request(_client, _primary_ip, _local_ip, _primary_port, _local_port):
            try:
                return 0 if guard() else 1
            except BaseException:
                return 1

        try:
            callback = ffi.callback("int(void *, char *, char *, int, int)", before_request,
                                    error=1, onerror=lambda *_: 1)
            curl._collector_request_guard = callback
            if lib._curl_easy_setopt(curl._curl, CurlOpt.PREREQFUNCTION, callback) != 0:
                raise BridgeError("REQUEST_BUDGET")
        except BaseException:
            self.release_curl(curl)
            raise BridgeError("REQUEST_BUDGET") from None
        return curl

    def release_curl(self, curl):
        # Native callbacks can no longer run only after remove/reset/close has
        # completed. On cleanup failure retain the reference and fail closed.
        super().release_curl(curl)
        curl._collector_request_guard = None


class SafeTransport:
    def __init__(self, auth_token, ct0, session=None, proxy=""):
        if not valid_proxy(proxy):
            raise BridgeError("INVALID_REQUEST")
        self.auth_token = auth_token
        self.ct0 = ct0
        self.proxy = proxy
        self.session = session or AsyncSession(max_clients=4, trust_env=False, impersonate="chrome", timeout=REQUEST_TIMEOUT)
        self.semaphore = asyncio.Semaphore(4)
        self.requests = 0
        self.total_bytes = 0

    async def get(self, url, *, params=None, transaction=None):
        # Retry only bounded, idempotent GET failures. Never retry authentication,
        # rate limits, redirects or size/persistence failures inside this layer.
        budget = {"sent": 0, "failure": None}
        for attempt in range(3):
            try:
                return await self._get_once(url, params=params, transaction=transaction, budget=budget)
            except BridgeError as exc:
                if attempt == 2 or budget["sent"] >= 3 or exc.code not in ("NETWORK_ERROR", "UPSTREAM_HTTP"):
                    raise
                if exc.code == "UPSTREAM_HTTP" and getattr(exc, "status", 0) not in (502, 503, 504):
                    raise
                await asyncio.sleep(0.25 * (2 ** attempt))

    async def _get_once(self, url, *, params=None, transaction=None, budget):
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
            chunks = bytearray()
            failure = None

            def allow_request():
                try:
                    if budget["sent"] >= 3 or self.requests >= MAX_REQUESTS or self.total_bytes >= MAX_TOTAL_BODY:
                        budget["failure"] = "REQUEST_BUDGET"
                        return False
                    # This synchronous callback is also invoked for libcurl's
                    # stale-connection and HTTP/2 REFUSED_STREAM retries.
                    budget["sent"] += 1
                    self.requests += 1
                    return True
                except BaseException:
                    budget["failure"] = "REQUEST_BUDGET"
                    return False

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
                guarded = getattr(self.session, "request_with_guard", None)
                if guarded is None:
                    # Injected synthetic sessions have no native transport.
                    # A real curl session must never silently bypass the guard.
                    if isinstance(self.session, CurlAsyncSession) or not allow_request():
                        raise BridgeError("REQUEST_BUDGET")
                    request, extra = self.session.request, {}
                else:
                    request, extra = guarded, {"guard": allow_request}
                rep = await request(
                    "GET", url, params=params, headers=headers,
                    allow_redirects=False, max_redirects=0, timeout=REQUEST_TIMEOUT,
                    verify=True, proxy=self.proxy, discard_cookies=True,
                    content_callback=receive, **extra,
                )
                if failure:
                    raise BridgeError(failure)
            except BridgeError:
                raise
            except asyncio.CancelledError:
                raise
            except Exception:
                raise BridgeError(failure or budget["failure"] or "NETWORK_ERROR") from None
            result = SafeResponse(rep.status_code, bytes(chunks), rate_metadata(url, getattr(rep, "headers", {})))
            try:
                result.raise_for_status()
            except BridgeError as exc:
                exc.status = rep.status_code
                raise
            return result

    async def post(self, *args, **kwargs):
        raise BridgeError("URL_BLOCKED")

    async def aclose(self):
        await self.session.close()
        self.auth_token = self.ct0 = ""
        self.proxy = ""


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
        self.rounds = 1
        self.started = time.monotonic()

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

    async def graphql(self, operation, variables, features=None, toggles=None):
        signer = await self.signing()
        path = f"/i/api/graphql/{operation}"
        params = {
            "variables": json.dumps(variables, separators=(",", ":")),
            "features": json.dumps({**GQL_FEATURES, **(features or {})}, separators=(",", ":")),
        }
        if toggles:
            params["fieldToggles"] = json.dumps(toggles, separators=(",", ":"))
        response = await self.transport.get("https://x.com" + path, params=params, transaction=signer.calc("GET", path))
        try:
            data = json.loads(response.body)
            if not isinstance(data, dict):
                raise ValueError()
            # Preserve all error-page evidence for Node's fail-closed parser.
            # Classification adds only fixed codes; it never discards partial data.
            codes = {x.get("code") for x in data.get("errors", []) if isinstance(x, dict) and type(x.get("code")) is int} if isinstance(data.get("errors", []), list) else set()
            error_code = "AUTH_REQUIRED" if codes.intersection({32, 89, 215, 326}) else "RATE_LIMITED" if 88 in codes else None
            return {"ok": True, "data": preserve_ids(data),
                    **({"rateLimit": response.rate_limit} if getattr(response, "rate_limit", None) else {}),
                    **({"responseError": error_code} if error_code else {})}
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
            proxy = request.get("proxy", "")
            if not valid_proxy(proxy):
                raise BridgeError("INVALID_REQUEST")
            self.transport = self.transport_factory(auth_token, ct0, proxy=proxy) if proxy else self.transport_factory(auth_token, ct0)
            return {"ok": True, "protocol": 1}
        if self.transport is None:
            raise BridgeError("NOT_INITIALIZED")
        if op == "begin":
            if self.rounds >= 8 or time.monotonic() - self.started > 180:
                raise BridgeError("REQUEST_BUDGET")
            self.operations = 0
            self.transport.requests = self.transport.total_bytes = 0
            self.rounds += 1
            return {"ok": True, "protocol": 1}
        if self.operations >= MAX_OPERATIONS:
            raise BridgeError("REQUEST_BUDGET")
        if op == "user":
            username = request.get("username")
            if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,15}", username):
                raise BridgeError("INVALID_REQUEST")
            self.operations += 1
            return await self.graphql(OP_UserByScreenName, {"screen_name": username, "withSafetyModeUserFields": True}, USER_FEATURES)
        if op in ("timeline", "replies", "list", "search", "detail", "thread", "list_members"):
            user_id, count, cursor = request.get("userId"), request.get("count", 40), request.get("cursor")
            if op in ("timeline", "replies") and (not isinstance(user_id, str) or not re.fullmatch(r"[1-9][0-9]{0,31}", user_id)):
                raise BridgeError("INVALID_REQUEST")
            if type(count) is not int or not 1 <= count <= 50:
                raise BridgeError("INVALID_REQUEST")
            if cursor is not None and (not isinstance(cursor, str) or not 1 <= len(cursor) <= 4096 or any(ord(c) < 32 or ord(c) == 127 or 0xd800 <= ord(c) <= 0xdfff for c in cursor)):
                raise BridgeError("INVALID_REQUEST")
            variables = {"userId": user_id, "count": count, "includePromotedContent": False, "withQuickPromoteEligibilityTweetFields": True, "withVoice": True, "withV2Timeline": True}
            operation, toggles = OP_UserTweets, None
            if op == "replies":
                operation = OP_UserTweetsAndReplies
                variables["withCommunity"] = True
            elif op in ("list", "list_members"):
                list_id = request.get("listId")
                if not isinstance(list_id, str) or not re.fullmatch(r"[1-9][0-9]{0,31}", list_id):
                    raise BridgeError("INVALID_REQUEST")
                operation = OP_ListMembers if op == "list_members" else OP_ListLatestTweetsTimeline
                variables = {"listId": list_id, "count": count, "includePromotedContent": False}
                toggles = {"withArticleRichContentState": True} if op == "list" else None
            elif op == "search":
                query = request.get("query")
                if not isinstance(query, str) or not 1 <= len(query.strip()) <= 1024 or any(ord(c) < 32 or ord(c) == 127 or 0xd800 <= ord(c) <= 0xdfff for c in query):
                    raise BridgeError("INVALID_REQUEST")
                operation = OP_SearchTimeline
                variables = {"rawQuery": query, "count": count, "product": "Latest", "querySource": "typed_query", "includePromotedContent": False}
            elif op in ("detail", "thread"):
                tweet_id = request.get("tweetId")
                if not isinstance(tweet_id, str) or not re.fullmatch(r"[1-9][0-9]{0,31}", tweet_id):
                    raise BridgeError("INVALID_REQUEST")
                operation = OP_TweetDetail
                variables = {"focalTweetId": tweet_id, "referrer": "profile", "with_rux_injections": False,
                             "includePromotedContent": False, "withCommunity": True, "withBirdwatchNotes": True,
                             "withVoice": True, "withV2Timeline": True, "withQuickPromoteEligibilityTweetFields": True}
                toggles = ARTICLE_FIELD_TOGGLES
            if cursor is not None:
                variables["cursor"] = cursor
            self.operations += 1
            return await self.graphql(operation, variables, toggles=toggles)
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
                emit({"ok": False, "code": exc.code, "error": MESSAGES[exc.code],
                      **({"rateLimit": exc.rate_limit} if exc.rate_limit else {})})
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
