#!/usr/bin/env python3
"""Offline probe of the pinned QueueClient._check_rep method only.

The upstream package is never imported. Its method and two pure helper functions
are extracted with AST; response, logging and context teardown are synthetic.
This checks branch behavior, not real HTTP/account-pool integration.

Usage from the project root:
  python3 research/twscrape-20261029-capabilities/verify-transport.py
"""

import ast
import asyncio
import hashlib
import json
from pathlib import Path
import sys
from types import MethodType, SimpleNamespace
from typing import Any


def forbid_external_io(event, args):
    if event in {"socket.connect", "socket.bind", "socket.getaddrinfo", "subprocess.Popen", "os.system"}:
        raise RuntimeError("External IO is forbidden by this offline probe")


sys.addaudithook(forbid_external_io)
source_path = Path(__file__).resolve().parents[2] / "collector/vendor/twscrape/queue_client.py"
source_bytes = source_path.read_bytes()
assert hashlib.sha256(source_bytes).hexdigest() == "bd849590e2077b7de9867d45e91aa2a16c381207f151e2179ad4b687ffcd248e", "Review this dated probe before applying it to changed upstream code"
tree = ast.parse(source_bytes, filename=str(source_path))
helpers = [node for node in tree.body if isinstance(node, ast.FunctionDef)
           and node.name in {"has_data", "has_error"}]
queue_class = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                   and node.name == "QueueClient")
method = next(node for node in queue_class.body if isinstance(node, ast.AsyncFunctionDef)
              and node.name == "_check_rep")
assert len(helpers) == 2


class HandledError(Exception):
    pass


class UnexpectedBranch(Exception):
    pass


class SyntheticResponse:
    status_code = 200

    def __init__(self, body, remaining=25, reset=0):
        self.headers = {"content-type": "application/json",
                        "x-rate-limit-remaining": str(remaining),
                        "x-rate-limit-reset": str(reset)}
        self.body = body
        self.text = "synthetic response"
        self.status_checked = False

    def json(self):
        return self.body

    def raise_for_status(self):
        self.status_checked = True


def noop(*args, **kwargs):
    pass


namespace = {
    "Any": Any, "Response": SyntheticResponse, "json": json,
    "logger": SimpleNamespace(debug=noop, warning=noop, trace=noop, error=noop),
    "LogOnce": SimpleNamespace(throttled=noop, once=noop),
    "req_id": lambda response: "synthetic account",
    "HandledError": HandledError,
    "AbortReqError": UnexpectedBranch, "ApiError": UnexpectedBranch,
    "GqlFeaturesOutdatedError": UnexpectedBranch, "HttpStatusError": UnexpectedBranch,
    "FailKind": SimpleNamespace(LOADSHED="LOADSHED"),
    "utc": SimpleNamespace(ts=lambda: 1700000000),
}
extracted = ast.Module(body=[*helpers, method], type_ignores=[])
exec(compile(ast.fix_missing_locations(extracted), str(source_path), "exec"), namespace)


class SyntheticClient:
    def __init__(self):
        self.debug = False
        self.queue = "UserTweets"
        self.ctx = SimpleNamespace(clt=SimpleNamespace(backend="synthetic"))
        self.closed = []
        self.check = MethodType(namespace["_check_rep"], self)

    async def _close_ctx(self, reset_at=-1, inactive=False, msg=None):
        self.closed.append({"reset_at": reset_at, "inactive": inactive})


async def probe():
    reset = 1700000030
    full_page = {"data": {"user": {"result": {"id": "synthetic-user"}}}}
    client = SyntheticClient()
    rate_response = SyntheticResponse(full_page, remaining=0, reset=reset)
    handled = False
    try:
        await client.check(rate_response)
    except HandledError:
        handled = True
    assert handled, "A successful last-quota response must enter upstream HandledError branch"
    assert client.closed == [{"reset_at": reset, "inactive": False}]

    client = SyntheticClient()
    partial_response = SyntheticResponse({**full_page,
        "errors": [{"code": 9999, "message": "synthetic partial response warning"}]})
    outcome = await client.check(partial_response)
    assert outcome is None, "Upstream accepts HTTP 200 data plus an otherwise unknown GraphQL error"
    assert client.closed == []

    print(json.dumps({
        "probe": "AST-extracted QueueClient._check_rep branch logic only",
        "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
        "network": "forbidden by audit hook; no upstream imports",
        "http_200_remaining_zero": {
            "handled_error": handled,
            "cooldown_until": reset,
            "inactive": False,
            "response_passed_to_caller": False,
        },
        "http_200_data_and_errors": {
            "accepted_without_exception": outcome is None,
            "context_closed": False,
        },
    }, ensure_ascii=False, sort_keys=True))


asyncio.run(probe())
