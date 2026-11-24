# QMAN — Executive Handover

> **Superseded.** This document describes `main` @ `5fa1f4f`. The authoritative code was the unpushed `frontend-migration` branch, and later the `completion` branch. See [QMAN-COMPLETION-REPORT.md](QMAN-COMPLETION-REPORT.md) for the current state.

*Snapshot: 2026-11-22. Repository state: `main` @ `5fa1f4f`, clean, synced with `origin/main`, no commits since 2026-08-05. The full evidence, with file and line citations, is in `docs/QMAN-COMPLETE-SYSTEM-REPORT.md`.*

## What QMan is

QMan is a patient-flow system that sits on top of a hospital's existing HMS. The HMS keeps clinical and billing data. QMan only handles how patients move through the building:

- **Visit and Journey Code.** Each visit gets a code (`QM-XXXX`).
- **Per-station tickets** (for example `A-064`). Numbering templates and reset periods are configurable.
- **Configurable workflows** that route a patient between stations.
- **Staff workspaces:** call, recall, skip, start, complete, route.
- **Display boards** with voice announcements.
- **A patient tracker** (QR code or Journey Code, installable PWA, no login).
- **Manager analytics, a Command Centre, an Activity/Audit explorer, and an admin portal.**

## Architecture

TypeScript npm-workspaces monorepo:

| Package | Contents |
|---|---|
| `packages/domain` | Pure engine, no I/O: visit state machine, routing, queues, numbering, config validation, RBAC catalogue, analytics/telemetry |
| `packages/persistence` | Hand-written PostgreSQL SQL, 6 forward-only migrations, migrator with advisory lock and checksums |
| `apps/api` | Fastify 5 + `pg`. Provides:<br>• scrypt auth, hashed cookie sessions, lockout, IP rate limiting<br>• CSRF (origin check + double-submit), RBAC preHandlers, idempotency keys<br>• config create/update/delete with transactional audit<br>• admission and queue actions<br>• public board/tracker endpoints<br>• SSE `/api/v1/stream` |
| `apps/web` | React 18 / Vite / Tailwind. Three builds: staff (`index.html`), display board (`display.html`), tracker PWA (`track.html`) |

**Tenancy:** one API process serves one hospital, set by `QMAN_HOSPITAL_ID`. There is no platform admin, no organization provisioning, and no multi-tenant hosting.

## The single most important fact

**The web app is not connected to the API.**

- All three web apps run on in-memory demo stores, seeded separately in every browser tab (`apps/web/src/data/bootstrap.ts`).
- Login also happens in the browser, against seeded demo accounts.
- The API clients exist (`apps/web/src/api/*`, `data/visits-api.ts`, `data/configuration-api.ts`), but only tests import them.
- Consequences:
  - A display board or tracker on another device never sees what staff do.
  - Admin changes are lost on reload.
  - The "Create Visit" button does nothing, so patients cannot be admitted through the UI.

## Status by area

| Area | Status |
|---|---|
| Domain engine | Mature, heavily tested |
| API security edge | Good: headers, CSRF, CORS, sessions, lockout, parameterised SQL, no committed secrets |
| Config create/update/delete API | Built: validate the whole config, write one entity, audit in the same transaction |
| Queue and admission API | Built, with correctness gaps (see below) |
| UI | Every screen built and polished, but demo-only and partly placeholder: fake stat deltas, dead buttons, a search box with no handler, actions always attributed to `user-doctor` |
| User management, password reset, provisioning, platform admin | Missing |
| Escalate, export, session-admin, branch and announcements APIs | Missing. `GET /sessions` is a stub |
| Notifications (SMS, WhatsApp, push) | Modelled only |
| Public board SSE | Not built. Boards can only poll the snapshot endpoint |
| Visit closure and ops jobs | Missing. Visits are never closed, so tracking tokens and codes never expire and the "active" set grows forever |
| Deployment | `apps/web/vercel.json` only, so a demo deployment is likely. Not verified. No API or database deployment exists, and there is no Dockerfile or manifest |

## Critical and high findings

All of these were found by reading the code. None was confirmed by running it.

- **D-1:** Config writes record audit rows with `branch_id = session.branchId`, but `events.branch_id` is `NOT NULL`. An admin signed in without a branch would get a 500 on every config write.
- **S-1:** Server-side routing ignores the workflow and trusts the client's `followedWorkflow` flag. This bypasses the `queue.route_off_workflow` permission and writes a false audit entry.
- **S-2:** Every staff visit response carries patient name, phone and hospital number, whether or not the caller has `visit.view_identity`. The Manager role was designed not to see identity, but receives it.
- **S-3:** `priority` on admission is not validated. One bad row makes reads for the whole branch throw `MappingError` (board, lists and tracker all return 500).
- **S-4:** Visit updates have no optimistic locking. Concurrent actions silently overwrite each other.
- **S-5:** Tenant isolation only holds if each hospital has its own database:
  - several queries are unscoped (visit by ID, station queue, branch list, event query, config deletes)
  - `requireSignedIn` routes skip the tenant check
  - branch restriction is only advisory
- **S-6:** No `trustProxy`. Behind a proxy, the login limit (20/min) and the tracker limit (6/min) apply to everyone at once.
- **S-7:** Admission is not idempotent, so a retried request creates a duplicate visit and ticket.
- **Also:**
  - Queue resets use the server's local time, not the hospital's timezone.
  - The printed QR encodes the Journey Code, not the secure tracking token.
  - The `visit.created` event payload stores the patient's name.

## Tests

- **Size:** 49 test files, about 663 test cases (static count; the README's "420" is out of date).
- **Skipped without a database:** the 44 PostgreSQL integration tests in `apps/api/src/integration.test.ts`, unless `DATABASE_URL` is set. They run via `npm run verify:db -w @qman/api`.
- **Not run in this inspection:** `node_modules` is absent, installing was not permitted, and no PostgreSQL is available. **Pass or fail status is unknown.**
- **Coverage gaps:** no HTTP tests for queue or public routes, no cross-tenant tests for visits or events, no frontend-to-API tests, no end-to-end tests.

## Docs drift

`README.md`, `docs/HARDENING.md` and the DECISIONS "Open items" list describe an earlier state. Trust the code over them.

## Recommended next steps, in order

1. `npm ci`, then `npm run verify`, then `verify:db` against real PostgreSQL. Record the baseline.
2. Fix D-1 and S-1 through S-7, and add route-level, tenant and concurrency tests.
3. Add a provisioning CLI (hospital, branch, system roles, first admin) and minimal user management (create, disable, role, reset password), plus real session admin.
4. Wire the staff app to the API: auth, config, visits, SSE, an admission form, and error handling. Remove demo seeding from production bundles.
5. Have the board and tracker read the public endpoints. Poll first; add a public stream later. Put the tracking token in the QR code.
6. Add a visit-closure job, pruning, hospital-timezone resets, and a health check that tests the database.
7. Deploy one hospital behind a single origin (required by the cookie and CSRF design), with TLS, managed PostgreSQL with point-in-time recovery, and a restore drill.
8. Write end-to-end tests for the whole patient journey, then run a supervised single-clinic pilot.

**Do not build yet:** multi-tenant SaaS or a platform portal, AI features, appointments, billing or EMR, native apps.
