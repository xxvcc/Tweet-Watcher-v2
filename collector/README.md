# twscrape collector bridge

Install with `bash scripts/install-collector.sh` (Python 3.11+), then run
`.venv/bin/python -m unittest discover -s collector/tests -v`.

The reviewed twscrape source is vendored unchanged from commit
`63f61a518e576ea5c132f1156c03dda0520d76c1`; `source-lock.json` records every source
hash and `vendor/TWSCRAPE_LICENSE` retains the upstream MIT license. Upstream
still declares package version 0.20.1 at this commit; this is not a claim that
0.21.0 was released. Runtime wheels and hashes are fixed in `requirements.lock`.
No source distributions or package install scripts are executed by our installer.
The virtual environment contains public dependencies only and is readable by a
dedicated service user after a root installation. Runtime credentials and data
must be outside it; the bridge uses a private `0077` runtime umask, disables core
dumps and ignores `SSLKEYLOGFILE`.

`bridge.py` imports the original GraphQL operation IDs/features and transaction
signing implementation. Our transport obtains the authenticated bootstrap HTML,
uses upstream signing-key extraction, and issues a single raw GraphQL response
per requested page. It does not invoke the upstream API pagination, model parser,
account pool, automatic login, request retry, telemetry flush, or debug dumps.

The process accepts newline-delimited protocol 1 JSON on stdin. Initialize once
with `{ "op": "init", "authToken": "…", "ct0": "…" }`; then request `user`
with `username`, or `timeline` with string `userId`, integer `count` (1–50), and
optional `cursor`. Successful requests return `{ "ok": true, "data": … }`,
containing the entire GraphQL document. `close` exits; `--version` verifies source
hashes and dependency imports without making a network request. Credentials must
never be command-line arguments. Failures return a fixed code and safe message.

The private transport permits HTTPS `x.com` bootstrap/GraphQL requests and
anonymous JavaScript assets from `abs.twimg.com` only. Cookies are sent only to
`x.com`; GraphQL authorization/CSRF headers are never sent to assets. Redirects,
POST, proxies inherited from the environment, and arbitrary URLs are blocked.
Response bytes are bounded while curl receives them (8 MiB per response, 64 MiB
per process), with 128 network requests, 4 concurrent asset requests, 8 GraphQL
operations, 18 seconds per request, 60 seconds for signing bootstrap, and 80
seconds per protocol operation. The Node parent imposes its own whole-round
deadline and page/output budgets. Upstream response errors remain in raw JSON
so Node can reject partial data and preserve page evidence before checkpoints.

All integer IDs and integers exceeding JavaScript's safe range become strings.
Protocol lines use UTF-8 without expanding Chinese text or emoji into ASCII
escapes; embedded newlines remain JSON escapes and never split a response line.
No credentials are saved here. This initial version uses a single supplied
Cookie session, not the upstream multi-account database or password login flow.
