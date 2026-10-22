> **历史资料：第一代版本记录，保留到 v3.5.0。** 第二代版本记录见[当前 CHANGELOG](../CHANGELOG.md)。原有版本号和发布时间保持原样。

# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by Keep a Changelog.

## [Unreleased]

## [3.5.0] - 2026-10-23

### Security
- Revoke open SSE streams immediately after durable session invalidation and check authentication before every event, including expiry and storage failure.
- Resolve Cloudflare visitor addresses only behind the authenticated local proxy and verified Cloudflare peer ranges; reject spoofed, duplicate and malformed visitor headers.
- Add optional `PUBLIC_ORIGIN` enforcement, origin-bound sessions and secure host-only cookies for a dedicated management origin.
- Replace configurable host executables with a checked-in Node collector and pinned Bird library; upgrade Express, proxy-addr, body-parser and qs to patched versions.

### Reliability
- Persist captured message bodies before delivery, acknowledge each successful send atomically, and retain the backlog across retries, restarts, moved fetch windows and X outages.
- Bind pending messages to their Bot/Chat destination, preserve account identity across case-only edits, bound queue capacity and fail closed on damaged/missing state or storage errors.
- Keep a durable initialization marker to prevent stale legacy-ID migration after state loss.
- Migrate legacy IDs before the first poll when configuration is saved, including unchanged timelines; stop before polling or sending if initialization cannot be persisted.
- Validate full raw X timeline pages, support pinned/visibility/module entries, follow bounded catch-up pagination and preserve unresolved gap warnings.
- Never treat unavailable users, partial pages, unrecognized entries or nonterminal empty windows as healthy empty timelines.

### Validation
- Added regression coverage for revocation, old/new cookie modes, proxy spoofing, page completeness, durable backlog, crash/storage faults, destination changes and queue limits.
- Deployment templates preserve BaoTa-managed certificate renewal and isolate the panel from the CMS origin.

### Documentation
- Add a version-pinned twscrape evaluation with pagination, authentication, maintenance and dependency findings, reproducible offline probes, and test evidence. This is research only; the runtime collector remains the pinned Bird library and the application's strict adapter.

## [3.4.2] - 2026-07-26

### Security
- Persisted bcrypt hashes are structurally validated and capped at a conservative accepted work factor before comparison, preventing a tampered cost 15-31 record from turning each login into an extreme CPU task.
- Twitter `auth_token` and `ct0` are passed to bird 0.8.0 through a minimal child environment instead of argv, removing their exposure through cross-UID `/proc/<pid>/cmdline` reads.
- Forwarded client IP and HTTPS headers now require a constant-time-checked proxy token in addition to loopback transport, so another local process cannot rotate forged `X-Forwarded-For` values to bypass login throttling.
- Password changes finish the new bcrypt hash and recheck the session epoch before synchronously revoking sessions and committing it; a logout during either bcrypt phase now cancels the change.

### Fixed
- Account scheduling detects wall-clock rollback and immediately rebuilds its per-account anchor instead of silently waiting for the old timestamp to catch up; future-dated worker heartbeats no longer report healthy.
- Telegram backoff anchors shift with wall-clock rollback, preserving the intended remaining delay instead of extending a 60-second flood wait by the size of the clock correction.
- A successful first fetch with an empty timeline persists a Twitter Snowflake time watermark, so the account's first later tweet is delivered rather than silently becoming a second baseline.
- A failed first secrets write now restores the original absence of `config.json`, preserving supported `sent_ids.json`-only migrations instead of committing an empty config that clears them.
- A configuration conflict that arrives after the settings drawer was closed now reloads the remote version instead of leaving the hidden editor and dashboard stale.
- Static CSS and JavaScript URLs carry the release version so reverse-proxy/CDN asset caching cannot pair a new HTML entrypoint with an older panel script.

### Tests
- Added eleven regression tests for credential transport, both password-change logout windows, proxy authentication, expensive bcrypt metadata, scheduler/Telegram clock rollback, empty timeline watermarks, first-save rollback, late hidden-drawer conflicts, and rollback deletion boundaries (87 total).

### Changed
- The minimum supported Node.js version is now 22, matching the pinned bird 0.8.0 runtime requirement.

## [3.4.1] - 2026-07-26

### Fixed
- Restored reverse-proxy subpath deployments by keeping static assets, API calls, and SSE connections relative to the panel URL. Unknown frontend paths now return 404 instead of a non-functional HTML fallback with the wrong asset base.

## [3.4.0] - 2026-07-26

Fixes from a new three-pass audit, with Node's built-in test runner added for regression coverage.

### Security
- Password-reset startup now revokes every previously issued session before printing a new setup token; authenticated APIs also require a valid password file, closing an old-session setup-token takeover path.
- First-time setup and password changes are single-flight. Password changes revoke old sessions before writing the new hash, and login bcrypt checks have a global concurrency cap.
- Login results are tied to the session epoch captured before bcrypt, so a concurrent logout/password change cannot mint a new valid session from an old hash result.
- New passwords are limited to bcrypt's effective 72-byte UTF-8 input boundary without locking out legacy long-password hashes; eligible old records migrate to a marked input policy after login. Structurally invalid password metadata fails closed.
- Bird output now has bounded ID, item-count, text, time, URL, and author fields; logs and restored dedup IDs are bounded as well.
- Session issue times are type-checked and bounded against future clock skew, so a large system-clock rollback cannot silently extend a signed session beyond its intended lifetime.
- Updated the locked transitive `body-parser` dependency from 1.20.5 to 1.20.6 for GHSA-v422-hmwv-36x6; the application already supplied a valid fixed body limit, but the vulnerable package is no longer shipped.

### Fixed
- Accounts waiting for a worker-pool slot are no longer marked as checked before they actually start, so pausing cannot defer an unprocessed account for a full interval.
- Pause/config changes are rechecked inside Telegram retries. Any 429, including the test endpoint and an in-flight response received during pause, creates per-bot backoff immediately; a failed older tweet blocks newer delivery and leaves the account visibly unhealthy.
- Queued work now binds its config snapshot and generation atomically; cancelled work remains immediately due, so deleted accounts and old Bot/Chat settings cannot resume from the queue.
- Empty restored dedup lists rebuild a baseline instead of mass-pushing the first non-empty timeline.
- Unsafe numeric tweet IDs and completely unrecognized non-empty bird output are rejected instead of being reported as a healthy empty timeline.
- Unsafe numeric Telegram Chat IDs are rejected before string normalization can hide JSON precision loss.
- Atomic JSON writes now handle partial `writeSync` results.
- Frontend API/assets use origin-rooted URLs, panel startup failures are awaited, and permanent SSE failures probe the session and reconnect with backoff instead of blindly reloading.
- Multi-tab configuration requires revisions and optimistic conflict checks; reloads chase consecutive changes without overwriting an actively edited form or accepting an out-of-order response.
- Revision events received while a local save is still loading its result are queued and rechecked, so a narrowly timed external save cannot leave the panel on a stale configuration.
- Configuration revisions are persisted in `config.json`, so a service restart cannot reset the optimistic-lock token and let a stale pre-restart tab overwrite newer settings. Persisted pause values now require a real boolean, and numeric Chat ID `0` round-trips consistently.
- Corrupt or structurally invalid `config.json` / `secrets.json` files now fail closed and are guarded against later overwrite. Once secrets exist, or the running worker has already observed a persisted config, a missing `config.json` also fails closed; this covers a disappearing `data/` mount. A supported dedup-only migration keeps `sent_ids.json` intact until the first config is saved. The web process stays online and worker health turns false until damaged files are repaired; recovery details remain in journald.
- SSE initialization registers cleanup resources before replay and preserves `no-store`; log frames now carry standard SSE IDs and resume from `Last-Event-ID`, with the fallback replay window aligned to the 60-row activity feed. Body-parser client errors retain their 4xx status.
- Asynchronous stdout errors such as `EPIPE` no longer crash the process.
- Newly pinned or newly visible historical tweets are no longer backfilled, stale worker generations cannot recreate removed account state after a delivery, and mixed bird batches fail closed if any entry is malformed or any supplied tweet ID has lost precision.
- Retweets from bird 0.8 compact JSON are recognized through Twitter's standard `RT @handle:` text prefix when no explicit retweet field is present.
- Runtime logs carry an instance-prefixed sequence ID, preventing distinct same-millisecond messages or post-restart sequences from collapsing in a long-lived activity feed.
- A global logout now invalidates a password change whose bcrypt verification was already in flight, so stale authorization cannot rewrite the password and mint a replacement session after revocation.

### Tests And Documentation
- Added focused tests for authentication boundaries, malformed config, bird normalization, atomic-write fault injection, Telegram classification, worker concurrency/retry ordering, logging, and HTTP/static routing.
- Deployment now uses reproducible `npm ci` installs, a dedicated service account, a pre-created `0700` data directory, systemd hardening, bounded restart attempts, and the explicitly verified bird version. Upgrade guidance warns against enabling two service units on the same port.
- Corrected stale version, proxy-header, security-reporting, and syntax-check instructions.

## [3.3.0] - 2026-07-10

Fixes from a second full line-by-line audit (all ~1800 lines of `server.js`, `lib/`, and `public/`). No feature changes. Every finding below was reproduced before the fix and verified after it.

> ⚠️ **Action required when upgrading from 3.2.x behind Nginx.** Replace `proxy_set_header X-Real-IP $remote_addr;` with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. Express's `trust proxy` only reads `X-Forwarded-For`; without it every client's `req.ip` collapses to `127.0.0.1`.

### Security
- **Login rate limiting was globally shared, not per-IP** (with the Nginx config this project documented). `trust proxy` reads `X-Forwarded-For`, but the documented reverse-proxy snippet only injected `X-Real-IP` — which the server stopped reading in 3.1.0 — so `req.ip` was `127.0.0.1` for every client. Five failed logins by anyone locked out *everyone* for five minutes: an unauthenticated denial of service. Fixed in the documented Nginx config, with a prominent upgrade warning.
- **Lockout escalation tiers were unreachable dead code.** A blocked request returned 429 *before* `recordFail`, and an expired lockout deleted the counter entirely, so `count` never exceeded 5 — the documented 10-failure (30 min) and 20-failure (60 min) tiers could never trigger, leaving a flat 5-attempts-per-5-minutes forever. An expired lockout now releases the next attempt without clearing the counter; the counter is cleared on successful login or after an hour with no new failures. A six-hour brute-force run now yields ~21 attempts instead of ~360.
- **Telegram `retry_after` was an unbounded sleep on the scheduler's await chain.** A `retry_after: 86400` (flood wait) would park the worker for a day, holding a concurrency slot and stalling every account. Retry waits are now capped at 60 s; anything longer sets a bounded global backoff window (max 1 h) and defers the tweets instead of sleeping.
- `cookieSecure` read the raw `x-forwarded-proto` header, bypassing the `trust proxy` decision it was supposed to respect. It now uses `req.secure`.
- CSP no longer needs `style-src 'unsafe-inline'` (the two inline `style=` attributes moved to CSS classes) and now sets `form-action 'none'`.
- All `/api/*` responses send `Cache-Control: no-store` (they carry session state and credential-presence flags).
- Unknown `/api/*` paths return a JSON 404 instead of falling through to the SPA catch-all and returning `200 text/html`.
- Removed `express.urlencoded` — no route consumed it.
- `bumpEpoch` now persists the new epoch *before* updating the in-memory cache; previously a failed write left sessions revoked in-process but resurrected them on restart.
- Exception messages logged from the tick loop and per-account catch are now credential-redacted; the redaction threshold dropped from >6 to >=4 characters.
- Documented the one risk that cannot be fixed in-repo: bird 0.8.0 accepts credentials only via `--auth-token`/`--ct0` argv (no env, stdin, or credential file), so the X session cookie is visible in `/proc/<pid>/cmdline` to other local users. Mitigation: dedicated user, `hidepid=2`.

### Fixed
- **A partial config save silently wiped every monitored account.** `POST /api/config` without an `accounts` field normalized `undefined` to `[]` and persisted it — while `bird_path` and `tg_chat_id` correctly kept their previous values on omission, and no warning was emitted. Absent `accounts` now preserves the stored list; a non-array value is rejected with a warning; an explicit `[]` still clears.
- **A pinned tweet was re-pushed every 200 pushes.** The dedup table evicted by insertion order, but a pinned tweet stays at the top of the fetch window forever, so its baseline ID was eventually pushed out of the 200-entry window and the tweet looked new again. Eviction now retains IDs still present in the current fetch window, and drops accumulated duplicates.
- **A corrupt `sent_ids.json` entry caused a mass re-push.** If an account's value was not an array, `isFirst` was false (the key existed) while `known` silently degraded to an empty set, so the entire fetched timeline was pushed as new. A non-array value is now treated as a first run (rebuild the baseline, push nothing).
- **"Pushes today" never rolled over at midnight** unless a tweet happened to be pushed that day; the reset lived only inside `addPush`. It now rolls over on every status read and write.
- **The panel froze silently when a session expired.** `/api/stream` returns 401, which per spec closes an `EventSource` permanently with no reconnect — but `onerror` was an empty function commented "EventSource auto-reconnects" (true only for network-level drops). The panel now returns to the login page on a closed stream, and any 401 from `api()` does the same.
- Message truncation at 4000 UTF-16 units could split a surrogate pair, corrupting the trailing emoji into U+FFFD. Truncation now drops a dangling high surrogate.
- `text: ""` on a media-only tweet no longer swallows the `full_text` fallback (`??` only skips null/undefined); same for the `created_at`/`time` chain. A non-string `url` now falls back to the constructed permalink instead of `String()`-ing an object into the message.
- The panel's next-check countdown drifted by the duration of a check: the scheduler anchors on check *start*, but the UI was fed the check *end* timestamp. Both now use the start time.

### Performance
- **Status broadcasts were O(accounts × clients × accounts).** Each `setAccount`/`pushHistory`/`setStatus` re-emitted the entire status object (containing every account) to every SSE client. At the configured maxima (100 accounts, 25 clients) one tick emitted 302 frames and serialized 70 MB. Emissions are now coalesced into one frame per 200 ms window: 1 frame, 0.25 MB — a 99.6% reduction.
- `lastTickAt` now updates after each account completes, not only when the whole tick finishes, so a long tick (100 accounts × a 30 s bird timeout) no longer reports the worker as unhealthy.
- The dedup table is written only when at least one tweet was actually pushed.
- SSE connections with more than 1 MB of unflushed data are dropped rather than buffering without bound.

### Changed
- `.secret` fields fall back to `type=password` when CSS masking (`-webkit-text-security`) is unsupported or the stylesheet failed to load, instead of rendering credentials in plaintext.
- Removed dead exports: `store.exists` / `store.dataPath` / `store.ensureDir` / `store.DATA_DIR`, `config.DEFAULT_BIRD` / `config.clampInt`; dropped the unused `timer` binding in the worker.
- `GET /api/status` and `GET /api/logs` are documented as external health-check / log-scraping endpoints (the panel itself uses SSE only).

## [3.2.0] - 2026-07-09

Web panel redesigned as a monitoring cockpit, plus theme switching and bird-path auto-detection. The backend gains read-only per-account metrics to power the dashboard; monitoring and push behavior are unchanged.

### Added
- **Monitoring-cockpit panel**: the panel opens on a live dashboard instead of a config form — per-account status cards (status light, last check / last push, most-recent pushed tweet, a push-count sparkline, and a next-check countdown), a top metrics strip (accounts, pushes today, uptime, next check), and a real-time activity feed. All configuration moved into a slide-over Settings drawer.
- **Theme switching**: dark / light / follow-system toggle in the header, remembered across sessions; auto-follows the OS when set to system.
- **bird path auto-detection**: a detect button (and auto-detect when the configured path is missing) locates the bird binary via common locations and `which`, confirming it with `--version`; falls back to an install hint or manual entry. New `POST /api/detect-bird` (auth + CSRF, single-flight) and a `birdOk` flag on `/api/config`.
- Read-only per-account metrics on `/api/status`: pushes-today counter, per-account total pushes, last-pushed timestamp, last pushed tweet preview, and recent per-check push history (for the sparkline).

### Changed
- Secret fields (auth_token / ct0 / bot token) no longer use `type=password` (which made browser password managers autofill the login password); they mask via CSS with a readonly-until-focus guard, show a row of dots when a value is saved and blank when not, and reveal with 👁.
- Account status cards update in place on each SSE event instead of rebuilding the grid — no flicker, smooth countdown.

### Fixed
- Activity feed no longer shows duplicate rows after an SSE reconnect (log lines de-duplicated by timestamp).
- Never-checked accounts show "待检查" instead of a misleading "0:00" with a full progress bar.
- The "pushes today" counter rolls over on the display timezone (Asia/Shanghai) rather than UTC.
- Bird `--version` output is rendered via textContent, not innerHTML (defense-in-depth against HTML injection in the hint).

Verified with a jsdom end-to-end harness (login → dashboard render → SSE → settings → detect → save, 18/18) and an adversarial self-review of the diff.

## [3.1.0] - 2026-07-09

Security and correctness hardening release following a full three-round audit. Backward-compatible for existing installs (which already have a password); only fresh setups and password resets now require a one-time setup token.

### Security
- **First-run takeover (TOFU) closed**: `/api/setup` now requires a one-time `setup_token` that is printed to the server log at startup while no password exists, preventing an unauthenticated attacker from claiming the panel during the pre-setup window. A corrupt `password.json` is treated fail-closed (as "password set") instead of silently re-opening setup.
- **Logout DoS closed**: `/api/logout` only bumps the session epoch (global revocation) when the request carries a valid session + CSRF token; unauthenticated requests can no longer force a global logout.
- **Login rate-limit bypass fixed**: the failure counter is incremented synchronously before password verification, closing the concurrency window that let parallel requests slip past the lockout gate. The limiter is keyed on `req.ip` (not the forgeable `X-Real-IP`), clears when the lockout expires, and is bounded (lazy eviction + hard cap).
- Password hashing/verification moved to **async bcrypt** so bursts of login attempts no longer block the event loop.
- `bird_path` validation now also requires the basename to be `bird`, preventing an authenticated user from pointing it at `/bin/sh` or other host binaries.
- Added security response headers (CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`) and disabled `X-Powered-By`.
- The SSE stream re-verifies the session on each keepalive (closing on logout/expiry) and enforces a connection cap.
- Malformed cookies and session tokens now return 400/401 instead of leaking a 500 stack trace; a global error handler returns generic messages.

### Fixed
- **Silent mis-push on empty first fetch**: a new account whose first fetch returns an empty list no longer records an empty baseline, which previously made the next fetch push the entire timeline.
- **Fetch errors no longer masquerade as success**: a non-zero exit / timeout from bird is treated as a failure instead of "no new tweets".
- JSON is extracted from **stdout only**, so bracket characters in bird's stderr diagnostics can no longer corrupt parsing and drop a successful fetch.
- Tweet IDs prefer the string `id_str`/`rest_id` fields (avoiding 64-bit float rounding collisions that dropped tweets); object-typed IDs are skipped.
- Telegram 429 responses honor `retry_after`; permanent (4xx) errors are no longer retried.
- Duplicate IDs within a single fetch (e.g. a pinned tweet appearing twice) are de-duplicated so they are not pushed twice.
- Offset-less tweet timestamps are interpreted as UTC instead of the server's local timezone.
- Usernames are de-duplicated case-insensitively; reserved names such as `__proto__` no longer corrupt the dedup table (null-prototype maps).
- The "checking…" badge no longer sticks on error paths (reset in `finally`).

### Changed
- Password reset now requires stop → delete `password.json` → restart, then reading the new one-time setup token from the logs.
- Account checks run with bounded concurrency (max 4) so one slow/dead account no longer stalls the others; pause now takes effect immediately, mid-tick.
- Config saves return a `warnings` list for silently-ignored invalid values; a `MAX_ACCOUNTS` cap (100) is enforced and duplicate accounts are merged.
- Per-account dedup is flushed once per check instead of per tweet, reducing write amplification.

### Robustness
- Atomic writes now `fsync` the file and the directory, so the "safe against power loss" guarantee actually holds; corrupt data files are surfaced (logged and preserved) rather than silently reset to defaults.
- `uncaughtException` / `unhandledRejection` now log and `exit(1)` so systemd restarts cleanly instead of the process limping on in an undefined state; the worker loop reschedules in `finally`, and stdout write failures can no longer stall it.
- Added a `lastTickAt` heartbeat and a `healthy` flag on `/api/status` to detect a silently dead worker.

## [3.0.0] - 2026-07-08

Initial public release. A single Node process serves the web panel and runs the monitoring worker in-process.

### Added
- Web management panel (static `public/`, no build step) to configure monitored accounts, Twitter/X credentials, the Telegram bot, and the bird CLI path — with pause/resume, live status + logs, and test buttons.
- In-process monitoring worker: a 5-second tick that checks each account when its `check_interval` is due, fetches tweets via the bird CLI, deduplicates against a persisted `sent_ids` table, and forwards new tweets to Telegram.
- Telegram delivery with up to 3 attempts (2 s apart); each successful push is flushed to `sent_ids.json` immediately, so a crash won't cause a re-send.
- Real-time SSE stream (`/api/stream`) for status and logs; logs are an in-memory ring buffer (500 lines) that is also written to stdout for journald.
- Message formatting: 🐦 新推文 / 🔁 转推 label, publish time converted to `Asia/Shanghai`, X link, and content; messages over 4000 characters are truncated.
- Per-account deduplication: the first run records existing tweet IDs without pushing; at most 200 IDs are retained per account; removing an account cleans up its dedup table and status.
- Forgot-password reset by deleting `data/password.json`.

### Security
- First-run password (>= 8 characters) hashed with bcrypt (cost 12); legacy `$2y$` hashes are normalized to `$2b$`; wrong-password responses use a fixed 1-second delay.
- Login rate limiting keyed on the Nginx-injected `X-Real-IP`: 5 consecutive failures lock for 5 minutes, 10 for 30 minutes, and 20 for 60 minutes.
- Stateless HMAC-SHA256-signed session cookies (7-day lifetime) with an `epoch`, so logout or a password change invalidates all issued sessions immediately.
- CSRF double-submit tokens verified with constant-time comparison on every state-mutating endpoint.
- Credentials are redacted from logs; `trust proxy` is restricted to loopback; the `data/` directory is `0700` and its files `0600`, lives outside the site root, and is never served statically.

### Robustness
- All configuration and runtime state is written atomically (temp file + `rename`) at mode `0600`, preventing corruption on crash or power loss.

Runtime dependencies: `express` and `bcryptjs`. Requires Node.js >= 20 and the bird CLI (`@steipete/bird`).
