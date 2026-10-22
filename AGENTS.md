# Scope

These instructions apply only to this repository, Tweet-Watcher-v2. It is the second-generation development project, derived from Tweet-Watcher v3.5.0. Read `README.md`, `docs/DEVELOPMENT.md`, and `docs/SESSION_HANDOFF.md` before changes that depend on project history.

## Current state

- Package: `tweet-watcher-v2`, development version `0.1.0-beta.1`.
- twscrape single-page integration is implemented and read-only live-validated. Bird is retained only for explicit legacy-live regression compatibility. Read docs/VERIFICATION.md for tested limits.
- Preserve Node UI, authentication, scheduling, durable outbox, and their safety properties unless the task explicitly changes them.
- Keep current facts, proposals, implemented behavior, and validation results distinct in documentation.

## Isolation

- Work in this repository for second-generation changes. `/www/tweet-watcher` is first-generation production; `/www/tweet-watcher-v1-dev` is its separate development clone.
- Do not copy production runtime data, credentials, session secrets, account databases, dependencies, or backups into this repository.
- Collection and Telegram delivery are disabled by default. Configuration changes and test endpoints must respect the process-level controls.
- Use synthetic data and offline probes for ordinary development. Live collection, message delivery, service deployment, and production migration are separate tasks; follow the user's actual authorization and do not ask again for work already authorized.

## Implementation and validation

- Install Node dependencies with `npm ci --ignore-scripts` and run `npm test` for runtime changes. Run focused regression coverage when suitable; documentation-only changes need link/content checks, not an application restart.
- Fail closed on malformed pages, partial responses, persistence failures, and unknown coverage. Do not advance a checkpoint before the complete page evidence is safely stored.
- Use string IDs at the Python/Node boundary and preserve repost, quote, reply, and edit relationships.
- Do not present upstream test success or synthetic probes as proof of authenticated live collection.
- Pin collector sources and dependencies; restrict credential scope, redirects, diagnostics, and telemetry when the Python integration is added.
- Never print, commit, or put real credentials or unredacted sensitive responses in reports and fixtures.
- Preserve MIT attribution and legacy history. Record source commits when porting fixes between generations.
