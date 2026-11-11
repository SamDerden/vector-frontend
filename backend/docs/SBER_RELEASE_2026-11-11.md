# Sber feedback remediation — 2026-11-11

- Merge primary-1-4-game into the release: elementary interests use interestTags, preserve activity IDs and age policy.
- Production requires a signed, HttpOnly, Secure, SameSite=Strict ownership cookie. A leaked UUID cannot read or mutate a session, or claim an existing session. Old UUID-only sessions remain in the database but cannot be claimed; the client starts a fresh session.
- PostgreSQL atomic budgets: session selection 120/min project and 30/min hashed client bucket; generation requests 30/min project and 5/min session. Project-wide AI admissions capped at 200/day and two concurrent pipelines using advisory locks. These apply without Nginx and across replicas. No increase to external gateway quota.
- Clarifications and generation snapshots are selected for the exact diagnostic ID, preventing mixing old/new surveys.
- Activity link validation uses age-eligible catalog IDs, the same IDs supplied to the LLM. Invented IDs remain rejected.
- Existing one-hour cache policy and non-caching of degraded fallback retained.
- Browser persists selected mode/student/grade; generation retries restore an existing job before any new diagnostic write.
- Recovery worker enabled through Next instrumentation; same AI limits apply. Fix ambiguous joined columns and preserve pg client binding in recovery.
- Only additive schema migration 010; no catalog changes, destructive migration or record deletion.

Validation: backend unit/regression tests, frontend resume/isolation/route tests, production builds, PostgreSQL-compatible concurrent SQL budget test. Public verification recorded separately after deployment.
