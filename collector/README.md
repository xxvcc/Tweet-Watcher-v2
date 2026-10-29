# twscrape collector bridge

Install with `bash scripts/install-collector.sh` (Python 3.11+), then run
`.venv/bin/python -m unittest discover -s collector/tests -v`. Node adapter
regressions are included in `npm test`.

The reviewed twscrape source is vendored unchanged from commit
`63f61a518e576ea5c132f1156c03dda0520d76c1`; [source-lock.json](source-lock.json)
records its source hashes and [vendor/TWSCRAPE_LICENSE](vendor/TWSCRAPE_LICENSE)
retains the upstream MIT license. Upstream still declares package version 0.20.1
at this commit. Runtime wheels and hashes are fixed in
[requirements.lock](requirements.lock). The installer executes no source
distributions or package install scripts. The virtual environment contains public
dependencies only; credentials and runtime data belong in the instance's private
state directory. The bridge uses umask `0077`, disables core dumps, and ignores
`SSLKEYLOGFILE`.

[bridge.py](bridge.py) imports the pinned GraphQL operations, features and
transaction signing implementation. It obtains the authenticated bootstrap HTML,
extracts signing keys, and returns one complete GraphQL document per requested
page. It does not invoke upstream pagination, model parsing, the account database,
password login, upstream retry logic, telemetry or debug dumps. Node owns source
selection, strict page validation, bounded pagination and durable catchup. Each
Python process has one immutable Cookie/proxy binding; the application selects
configured Cookie sessions outside Python.

The Python process accepts newline-delimited **protocol 1** JSON on stdin, up to
32 KiB per input line. Credentials must never appear in command-line arguments.
Initialize once with `{"op":"init","authToken":"…","ct0":"…"}` and an
optional `proxy` string. `init` returns `{"ok":true,"protocol":1}`. Requests are
serialized by the Node adapter.

| Python `op` | Request fields | Pinned GraphQL operation / behavior |
|---|---|---|
| `user` | `username` | `UserByScreenName`; verifies source identity before user timeline collection |
| `timeline` | `userId`, optional `count`, `cursor` | `UserTweets` |
| `replies` | `userId`, optional `count`, `cursor` | `UserTweetsAndReplies` |
| `list` | `listId`, optional `count`, `cursor` | `ListLatestTweetsTimeline`; requests article rich content |
| `search` | `query`, optional `count`, `cursor` | `SearchTimeline`, `product: "Latest"` |
| `detail` / `thread` | `tweetId`, optional `cursor` | `TweetDetail` with article field toggles; each Python request returns only one page |
| `list_members` | `listId`, optional `count`, `cursor` | `ListMembers` |
| `begin` | none | Starts another bounded round while retaining transport and signer; returns protocol 1 acknowledgement |
| `close` | none | Returns `{"ok":true}` and exits |

Usernames match `[A-Za-z0-9_]{1,15}`. User, List and tweet IDs must be positive
strings of at most 32 decimal digits, without leading zeroes. When supplied,
`count` is an integer from 1 to 50; Python defaults to 40. It is a request hint,
not permission to discard returned records. `detail`/`thread` validate `count`
if supplied but do not send it to TweetDetail. Cursors are nonempty strings of
at most 4096 characters, without control characters or unpaired surrogates.
Python search input must be nonblank and at most 1024 characters after trimming;
the Node source API accepts at most 512 UTF-16 code units and uses the extra
protocol space for its overlap constraint.

A successful transport response is `{"ok":true,"data":…}` containing the full
GraphQL document, including any `errors`. Recognized GraphQL errors additionally
set `responseError` to `AUTH_REQUIRED` or `RATE_LIMITED`; `ok:true` here does not
mean the page is safe to checkpoint. Node persists the complete response before
classifying errors or parsing coverage. Transport/protocol failures return
`{"ok":false,"code":"…","error":"…"}` with fixed safe messages.

Both successful responses and HTTP failures may include
`rateLimit: { operation, remaining, resetAt }`. `operation` names the GraphQL
operation, `remaining` is a bounded nonnegative integer or `null`, and `resetAt`
is Unix epoch **milliseconds** or `null`. Malformed values and resets more than
24 hours ahead are omitted; arbitrary headers and upstream diagnostic text are
not returned. A successful HTTP 200 page with zero quota is retained. Node stops
further requests for that operation when quota is zero and reset is in the
future or unknown. Node results expose the latest metadata per observed operation
as `rateLimits`, with `rateLimit` as a compatibility field. Request failures also
expose `failedOperation`, chosen from the adapter's fixed operation names even
when a 429 response has no rate headers. `failedOperation`, `rateLimits` and the
local replay controls below are Node API fields, not additional Python protocol
operations.

The transport permits HTTPS bootstrap/GraphQL requests to `x.com` and anonymous
JavaScript assets from `abs.twimg.com`. Cookies go only to `x.com`; GraphQL
authorization and CSRF headers never go to assets. Redirects, POST, arbitrary
hosts/paths and environment proxies are blocked. An explicit `proxy` may use
HTTP or HTTPS with a host and explicit port from 1 to 65535; its path must be
empty or `/`. Userinfo, query strings, fragments, whitespace/control characters,
backslashes and malformed Unicode are rejected. Proxy credentials in URLs are
unsupported. TLS certificate verification remains enabled.

Our GET transport permits at most three actual origin GET requests per call,
including libcurl's transparent retries on stale connections or HTTP/2 refused
streams. A native prerequisite callback checks the per-call and per-round budgets
before each request goes out. TCP/TLS handshakes and proxy CONNECT establishment
are not counted as origin GET requests. Counters record send permissions, so a
permitted request may still fail before reaching the peer; they are an upper
bound on sends, not proof of server receipt. Explicit retries for network failures or
HTTP 502/503/504 use 0.25 and 0.5 second delays. Authentication failures, 429,
redirects, other HTTP errors, size failures and exhausted budgets are not retried
inside Python. Every attempt counts against the same request/byte budget and
Node round deadline.

| Layer | Default bound |
|---|---|
| Python response | 8 MiB, enforced while curl receives bytes |
| Python round | 64 MiB total response bytes, 128 actual origin GET requests, 8 GraphQL operations |
| Bootstrap transport | At most 4 concurrent requests; at most 256 asset candidates when searching for the signing script |
| Python timeouts | 18 seconds per HTTP attempt, 60 seconds for signing bootstrap, 80 seconds per protocol operation |
| Node network round | 90 second timer, at most 5 newly requested timeline/inspection pages; user lookup is separate from that page count |
| Node response line | 12 MiB UTF-8 |
| Parsed records | At most 500 tweets per page; 500 unique records for initial acquisitions, inspections or collectors without a catchup store; 1000 accumulated records for checkpointed acquisitions using a collector with a catchup store |

`begin` resets only the per-round operation/request/byte counters. The default
Node adapter reuses a healthy Python session for at most 8 rounds, starts another
round only while its age is below 180 seconds, and closes it after 30 seconds
idle. At most 4 bindings are cached. The 180 second check limits reuse admission;
an already admitted round remains subject to its own 90 second timer. Resolved
user IDs are cached in memory for at most 15 minutes and 128 entries, scoped to
credentials, proxy and username. Changing the binding cannot reuse another
session's transport or identity cache. `close()` on the Node collector clears
these caches and closes retained processes.

[lib/twscrape.js](../lib/twscrape.js) exposes
`fetchTweets({ username, source, count, authToken, ct0, proxy, sessionId, sinceId })`.
Omitting `source` retains the existing username/posts API. Source definitions are
`{source_type:"user",username,timeline_mode:"posts"|"replies"}`,
`{source_type:"list",list_id}` or `{source_type:"search",query}`. Source keys are
lowercase usernames, `replies:<username>`, `list:<id>` or a hash of the exact search
query. `sinceId` is a decimal string of at most 32 digits and may be `"0"`.
The runtime collection gate applies to all operations, including local replay.

Initial acquisition requires an ordinary chronological boundary or explicit
exhaustion. Pins and reply modules cannot by themselves establish that boundary.
Subsequent acquisitions must reach the prior checkpoint or explicit exhaustion;
unknown shapes, partial documents, identity conflicts and cursor loops fail
closed. Search uses a 24-hour Snowflake overlap below `sinceId` and reports
`coverage.discovery:true` with `windowStartId`. Callers deduplicate discovered IDs,
including late results below the previous maximum; this does not prove X search
is exhaustive or captures results indexed after that overlap window.

With a prior checkpoint, the default adapter persists catchup across rounds.
Each complete page and its cursor are committed together before another request.
The stage binds the source, old checkpoint, credentials/proxy fingerprint and
optional session ID. Its full redacted raw pages have page hashes and a stage
integrity hash; ordinary evidence retention cannot evict these embedded pages.
Stages are private files under `DATA_DIR`, limited to 100 pages, 1000 records,
6 MiB and 7 days each, with 32 stages / 64 MiB globally. Incomplete rounds return
`INCOMPLETE_COVERAGE`, `tweets:null` and safe progress metadata, preserving the old
checkpoint. Capacity, corruption, expiration, write failures or changed bindings
stop progress explicitly. `catchup:false` bypasses stage loading and creation for
an isolated manual acquisition.

Completed stages remain `ready` until the caller durably captures the result in
the outbox and calls `ackCatchup(sourceKey)`. `getCatchups()`/`getDiagnostics()`
return safe progress metadata. `resetCatchup(sourceKey)` explicitly removes a
stage without changing the outbox or acquisition checkpoint and rejects calls
while the collector is busy; `pruneCatchups(activeKeys)` removes inactive sources
only while idle. A normal acquisition can also clean up a completed stage when
the supplied checkpoint exactly matches its recorded newest ID, covering a crash
between outbox capture and acknowledgement.

`fetchTweets({ …, localOnly:true })` only validates and replays an existing complete
`ready` stage. Supply the original source, credentials/proxy and session ID, plus
the old checkpoint or the stage's already committed newest checkpoint. For the
latter, the adapter replays against the original lower boundary and verifies the
newest ID from the protected pages before returning the result. This lets callers
repeat an idempotent outbox capture and acknowledgement after a crash or failed
cleanup. Missing/incomplete stages or a request that would need a new network
round return `CATCHUP_NOT_READY`. No Python session or profile request is started,
and this mode never removes the stage. Existing corruption, expiration and
binding/checkpoint mismatch codes remain distinct. Local replay supplies no fresh
rate metadata and must not be treated as proof that the X login is healthy.

`inspectTweet({ id, kind:"detail"|"thread", limit, …credentials })` requests a
known tweet, retaining full page evidence before parsing. Detail mode reads one
page; thread mode follows verified conversation/reply links and may request the
conversation root after reading the target. All root and continuation requests
share the 5-page / 500-record / 90-second budget. `limit` is 1–50 additional
related tweets, default 50. Thread reading stops when the target plus that limit
is available, and returns `complete:false, truncated:true`; a valid focal response
without a thread boundary also remains incomplete. Returned context must not be
presented as an exhaustive conversation. `listMembers({ listId, …credentials })`
uses the same bounded inspection budget and exposes `complete` for its returned
member list. These inspection operations do not advance acquisition checkpoints.

IDs and integers outside JavaScript's safe range cross the Python/Node boundary
as strings. Output uses UTF-8 without expanding Chinese text or emoji into ASCII
escapes; embedded newlines remain JSON escapes. No credentials are saved in this
collector directory. `.venv/bin/python -I collector/bridge.py --version` checks
the pinned source hashes and dependency imports without making a network request.
Test and production validation results are recorded separately in
[docs/VERIFICATION.md](../docs/VERIFICATION.md).
