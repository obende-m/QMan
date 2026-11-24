# QMan — Completion Report

*Prepared 2026-11-23. Covers the work on local branch `completion`, based on
`frontend-migration` @ `7b905b7`.*

## 1. Where the work happened, and why

| Repository state | Where | Notes |
|---|---|---|
| `origin/main` @ `5fa1f4f` | GitHub, and this clone (`QMan-1`) | 38 commits behind |
| `frontend-migration` @ `7b905b7` | **Only** in `C:\Users\PC\Desktop\QMAN`; never pushed | Includes `5001d7b`; fast-forward of `main`; clean tree |
| `completion` (this work) | `QMan-1`, branched from `frontend-migration` | Not committed, not pushed |

`frontend-migration` was the authoritative code. It already had the platform
layer, session-derived tenancy, API-backed web stores, migrations 007–012 and
deployment guides. It was imported into this clone with
`git fetch <local path> frontend-migration:frontend-migration`, which changed
nothing in the original folder or on GitHub.

> **Risk to act on:** the original `frontend-migration` work exists on one
> disk only. Push it (or this branch) to the remote as soon as you are ready.

The earlier `QMAN-COMPLETE-SYSTEM-REPORT.md` and `QMAN-EXECUTIVE-HANDOVER.md`
describe `main`, and are therefore out of date.

## 2. Baseline (before changes)

On `7b905b7`, after `npm ci`:

- `npm run verify`: typecheck, build and web build pass; 714 tests pass, 81 skipped.
- Database suites (81 tests): **not run**. No PostgreSQL, Docker or WSL
  distribution is available. A portable PostgreSQL was downloaded and its data
  directory initialised in the session scratchpad, but starting the server was
  refused by the session's permission policy.

## 3. Result (after changes)

- `npm run verify`: **green.** Typecheck, `tsc --build`, the web production
  build and every unit/component suite pass. Final counts are in the reply
  that accompanies this report.
- Database suites: **still not run** (same reason). They were updated for
  every behaviour change: migration list, provisioning password flag,
  administration routes in the end-to-end server, call/recall semantics.
  **They must be run before any deployment:**
  `DATABASE_URL=… npm run verify:db -w @qman/api`.
- `npm audit` reports 11 advisories in dev/transitive dependencies
  (4 moderate, 5 high, 2 critical). **Not reviewed or changed.** Dependency
  changes were out of scope for this pass.

## 4. Findings found and fixed

All of these were checked against the code on `7b905b7` before being fixed.
Every fix has tests that run without a database.

| ID | Finding (as found) | Fix | Tests |
|---|---|---|---|
| D-1 | Config audit rows with null branch | Already fixed upstream (migration 012) | existing |
| **NEW** | **Display board and patient tracker called staff-only endpoints, so in production they showed nothing** | Server-side public projections (`public-projection.ts`); new `PublicBoard`/`PublicTracker` on the public API only; old components removed | `PublicBoard.test.tsx` |
| **NEW** | Domain refusals other than invariants (illegal transitions, validation) answered 500 | `act` maps every `DomainError` to 409/422 | `queue-routes.test.ts` |
| **NEW** | Branch-restricted account signing in without a branch got organization-wide access; an organization-wide account could name another organization's branch and admit into it | `#resolveBranch` pins to a held branch and verifies ownership | `auth-scope.test.ts` |
| **NEW** | Suspension did not affect open sessions | Session resolution refuses a suspended organization | `auth-scope.test.ts` |
| S-1 | Server trusted the client's `followedWorkflow` | `resolveRoute` on the visit's workflow; disabled/unknown station 422; off-workflow 403 | `queue-routes.test.ts` |
| S-2 | Identity sent to every staff caller | Per-caller projection; `identityWithheld`; ticket shown instead | domain + API + web |
| S-2b | `visit.created` event stored name and hospital number | Removed from the payload | `visit.test.ts`, API |
| S-3 | Priority unvalidated, one bad row broke a branch | `isPriority` at API and domain, CHECK constraints (013), repair of bad rows; non-normal priority needs `visit.escalate` | domain + API |
| S-4 | No concurrency control on visits | `version` column, conditional update, 409 | repository + HTTP race test |
| S-5 | Branch pinning not applied to list/queue/event reads | Enforced on every read; events forced to the pinned branch | `queue-routes.test.ts` |
| S-6 | No trusted-proxy handling | `QMAN_TRUST_PROXY` (hop count or CIDRs; `true` refused) | `config.test.ts` |
| S-7 | Admission not idempotent | Idempotent; replay reissues a token; nothing secret stored | `queue-routes.test.ts` |
| S-8 | Concurrent config writes; audit for no-op changes; system role "delete" | Organization row lock; 404 for unknown ids without audit; built-in roles refused | `config-write-routes.test.ts` |
| S-9 | Visits never closed, tokens never expired | Maintenance job: close after grace period, abandon stale, prune | `maintenance.test.ts` |
| S-10 | No body type validation on config writes | Shape check against the value being replaced | `config-write-routes.test.ts` |
| S-11 | Call silently became recall | Strict `call`/`recall` in the domain and API | domain + API |
| S-12 | Audit categories readable by anyone with `reports.view` | Administrative/security events need an admin permission | `queue-routes.test.ts` |
| S-13 | Malformed ids reached SQL | UUID check at the boundary; 404 | API |
| S-14 | Unknown permission names accepted in roles | `validateRoles` refuses non-catalogue names | `rbac.test.ts` |
| D-9 | Queue resets used server local time | Hospital time zone via `Intl` | `reset-strategy.test.ts` |
| D-12 | QR encoded the Journey Code | QR encodes the tracking token; reprint reissues | domain + UI |
| — | `limit=abc` passed NaN to SQL | Validated | API |
| — | Health check did not touch the database | `/api/health` checks the DB (503); `/api/live` for liveness | — |
| — | No sign-in / sign-out / failed sign-in records | Security events written | via server |

## 5. Features built in this pass

| Feature | Original status | Now | Remaining limitation |
|---|---|---|---|
| Reception admission | UI button dead | Dialog: validation, workflow choice, priority by permission, one idempotency key per form, ticket printed with secure token | No HMS patient lookup (no integration exists) |
| Reprint ticket | Printed the code | Reissues token | Old QR stops working, by design |
| Priority change | Permission existed, no endpoint | `POST /visits/:id/priority`, and a per-visit control in Reception for `visit.escalate` holders | — |
| Visit cancellation | Endpoint only | Reception control with a deliberate second click and an optional reason, for `visit.cancel` holders | — |
| Staff names on dashboards | Ids only | `GET /staff` (`reports.view`, names only) feeds workload panels and the activity log | — |
| Visit detail and history | None | `GET /visits/:id` with its events | No dedicated UI page |
| Staff accounts | None | API + Administration → Staff Accounts: create, role, branches, enable/disable, reset, unlock | No bulk import; no directory (SSO) provider |
| Password change | None | `POST /auth/password`, forced for temporary passwords | No self-service "forgot password" by email (no mail integration) |
| Sessions admin | Stub returning `[]` | List and revoke, scoped | — |
| Branches | No API | Create, rename, make default | No delete (visits reference branches) |
| Visit closure | None | Background job | Policy is per deployment, not per organization |
| Public board | Broken without a session | Public projection, polling, stale state, voice | No public push stream |
| Patient tracker | Broken without a session | Token or typed code, position, wait, journey, expiry message | No push notifications to the patient |
| Header search | Input with no handler | Opens the journey in the Activity Explorer | Searches Journey Codes only |
| Glass design system | Flat cards | Tokens, three glass strengths, reduced-transparency and no-blur fallbacks, glass shell/cards/buttons/dialogs, redesigned board and tracker | Individual staff screens inherit the system through `Card`/`Button`; they were not each re-laid out |

Removed because they did nothing: the header bell with a permanently lit dot,
the "Support" link, the header "Call Next" button, the Reception filter/more
buttons, "View full queues", and the invented "vs yesterday" deltas. The
hard-coded "AO" avatar now shows the signed-in user's initials.

## 6. Not done

Stated plainly, so none of it is mistaken for done:

1. **The PostgreSQL suites have not been run.** Neither has a real deployment,
   nor a browser end-to-end test of the 22-step journey in the brief. Most of
   that journey is covered by `end-to-end.integration.test.ts`, which needs a
   database.
2. A **public event stream** for boards and trackers. They poll.
3. **Notifications** (SMS, WhatsApp, push), **reports and exports**,
   **escalation workflows** beyond priority change, **device health** beyond
   what the staff stream already reports, and **subscription/plan** structure.
4. **Per-screen redesign** of the staff dashboards (manager, command centre,
   workspace, admin sections). They use the new glass primitives but keep
   their existing layouts.
5. **CI is written but has never run.** `.github/workflows/ci.yml` runs
   `verify` and the PostgreSQL suites against a `postgres:13` service. It takes
   effect only once pushed.
6. **Dependency advisories** (§3) not triaged.
7. `HARDENING.md` and `RUNBOOK.md` were not rewritten. ADR-058 to 065 and
   DEPLOYMENT §9 describe this release.

## 7. Readiness

| Level | Status |
|---|---|
| Development complete (for a supervised single-clinic pilot) | **Largely yes**: the items in §6.2–6.5 are outside a pilot's critical path |
| Technically verified | **No**: database suites not run |
| Deployment-ready | **No**: needs a verified build against PostgreSQL and a staging deploy |
| Ready for supervised pilot | **No**: after the two above, plus the smoke test and a restore drill |
| Ready for wider production | **No** |

## 8. Next steps, in order

1. Push `frontend-migration` (and this branch, once reviewed) to the remote.
2. Run `npm run verify:db -w @qman/api` against PostgreSQL 13+ (or push and let CI run it); fix failures.
3. Review and commit this branch.
4. Staging deploy per `docs/DEPLOYMENT.md`, with `QMAN_TRUST_PROXY` set; run the §6 smoke test with a board on a second device and a tracker on a phone.
5. Triage `npm audit`.
6. Pilot.
