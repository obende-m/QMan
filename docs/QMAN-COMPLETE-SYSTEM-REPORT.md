# QMAN — Complete System Report

> **Superseded.** This document describes `main` @ `5fa1f4f`. The authoritative code was the unpushed `frontend-migration` branch, and later the `completion` branch. See [QMAN-COMPLETION-REPORT.md](QMAN-COMPLETION-REPORT.md) for the current state.

**Inspection date:** 2026-11-22
**Commit inspected:** `5fa1f4f` on `main` ("Add the visit API client", 2026-08-05), working tree clean, in sync with `origin/main` (`github.com/obende-m/QMan`).
**Method:** Static reading of the code, schema, configuration, tests and documents in this repository. **No checks were executed.** The reason is in §12.

Every finding cites a file, usually with a line number (`path:line`). Each one is marked as either:

- **Verified (code):** confirmed by reading the code. It was not executed.
- **Suspected:** inferred, but it needs a running system to confirm.

The older documents in the repo (`README.md`, `docs/HARDENING.md`, `docs/DECISIONS.md` open items) are **out of date** compared with the code. Where they disagree with the code, this report follows the code and points out the difference (§16.6).

---

## Table of contents

1. Project overview
2. Technology stack and architecture
3. Repository structure
4. Implemented features inventory
5. User roles and permission matrix
6. Organization and multi-tenancy
7. Database and data model
8. API and backend capabilities
9. Frontend and user experience
10. Real-time system and event architecture
11. Security assessment
12. Testing and quality status
13. Deployment and infrastructure status
14. What is currently being built
15. Future enhancements
16. Known issues, risks and technical debt
17. Product assessment
18. Recommended roadmap
19. Final executive summary

---

## 1. Project overview

### 1.1 What QMan is

QMan calls itself an "Intelligent Patient Flow & Operations Platform" (`package.json:6`, `README.md:1-8`). It is software that manages **how patients move through a hospital or clinic**:

- arrival and registration of a *visit*
- placement in a station queue
- being called, served, and sent to the next station
- completion

It is meant to sit **on top of** an existing Hospital Management System (HMS). The HMS keeps registration, billing and medical records. QMan keeps only the movement (`README.md:5-7`, `packages/persistence/migrations/001_initial.sql:218-221`, "Clinical data stays in the HMS").

### 1.2 Problem it addresses

The PRD summary (`design/qman_prd_summary.md`) describes the problem as replacing "manual shouting and fragmented communication" with a coordinated, real-time workflow. Five things support that:

- each visit's journey is tracked across stations
- patients see their position on their own phone without logging in
- waiting-room boards show who is being called
- staff get per-station worklists
- managers see bottlenecks and SLA breaches

### 1.3 Intended users

From the PRD, `packages/domain/src/configuration/rbac.ts:84-139` and the screens:

| User | Intended use |
|---|---|
| Receptionist | Create visits, assign workflow, print tickets, see priority patients |
| Clinician (doctor, nurse, lab, pharmacy) | Station workspace: call next, recall, skip, start, complete, route |
| Manager | Live operational dashboard, bottlenecks, SLA status; designed **not** to see patient identities |
| Administrator | Configure stations, workflows, boards, tickets, announcements, roles, sessions |
| Patient | Track their position and wait with a Journey Code or QR code, no login |
| Waiting room (unattended) | Display board with called and waiting tickets and voice announcements |

### 1.4 How it differs from a simple queue system

The design has six ideas a plain ticket queue does not.

1. **Visit-centric, multi-station journeys.** A visit owns many queue entries, one per station leg. Queues are a *projection* of where visits currently are (`README.md:108-114`, `packages/domain/src/visit/visit.ts`).
2. **Configurable workflows.** A workflow is an ordered sequence plus permitted branches, with a routing engine (`packages/domain/src/workflow/workflow.ts`, `routing.ts`).
3. **Two identities.** A permanent Journey Code (`QM-XXXX`) for the whole visit, and a per-station ticket (`A-064`) that is stored as issued, with configurable templates and reset periods (`packages/domain/src/queue/queue-number.ts`).
4. **Configuration as data.** Stations, SLAs, numbering, boards, privacy policy, ticket layouts and roles are validated in the domain (`packages/domain/src/configuration/hospital-config.ts:106-288`).
5. **Durable business event log.** Feeds activity and audit, operations analytics, and a Command Centre with telemetry: device health, staff presence, notification channel health.
6. **Privacy policy as domain logic.** Name visibility per surface is decided in `packages/domain/src/privacy/patient-name.ts`.

### 1.5 Intended operational workflow, from arrival to departure

1. Reception creates a visit. The server picks the workflow (default or given), generates a Journey Code unique among open visits in the branch, and allocates a ticket at the workflow's first station (`apps/api/src/admission.ts:527-574`).
2. A ticket is printed with a QR code containing a one-time **tracking token** (`apps/api/src/queue-routes.ts:314-319`).
3. The station calls the patient (`visit.called`), possibly recalls, skips (the patient keeps their place, ADR-007), or starts service.
4. The station routes to the next station, which allocates a new ticket there, or completes the visit.
5. Boards, tracker and dashboards update from the event stream.
6. The visit should eventually be *closed*. **No code path closes a visit** (§16.1, D-7).

### 1.6 Multi-hospital intent versus reality

- **Intended:** `resolveHospital` is a function so that "a hosted one will read a subdomain" (`apps/api/src/server.ts:48-56`). The schema has `hospitals` and `branches`, and most tables carry `hospital_id` or a branch.
- **Actual:** each API process serves **exactly one hospital**, fixed by the `QMAN_HOSPITAL_ID` environment variable (`apps/api/src/config.ts:239-243`, `apps/api/src/index.ts:63`). There is:
  - no platform-level administrator
  - no organization provisioning
  - no subdomain resolution
  - no platform portal

  §6 covers this in detail.

### 1.7 Implemented versus intended, in one paragraph

There are three layers:

- **Domain engine** (`packages/domain`). Extensive and well tested.
- **Backend** (`apps/api` + `packages/persistence`). A real Fastify + PostgreSQL server with server-side authentication, RBAC, CSRF, idempotency, configuration create/update/delete, admission, queue actions, public board and tracker endpoints, and an SSE stream.
- **Frontend** (`apps/web`). Three polished React applications.

**The frontend is not connected to the backend.** Every screen runs on stores that live in browser memory, seeded with a demo clinic and demo accounts (`apps/web/src/data/bootstrap.ts`). The typed API clients (`apps/web/src/api/client.ts`, `apps/web/src/data/visits-api.ts`, `apps/web/src/data/configuration-api.ts`) and the SSE client (`apps/web/src/api/stream.ts`) exist, but **only tests import them**. QMan today is a working demo plus a separate backend that has never been used through a UI.

---

## 2. Technology stack and architecture

### 2.1 Stack

| Concern | Technology | Evidence |
|---|---|---|
| Language | TypeScript 5.7, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` | `tsconfig.base.json` |
| Runtime | Node ≥ 20 (local machine has Node 22.16) | `package.json:11-13` |
| Monorepo | npm workspaces (`packages/*`, `apps/*`), TS project references | `package.json:7-10`, `tsconfig.json` |
| Frontend | React 18.3, Vite 5.4, Tailwind 3.4, lucide-react icons, `qrcode-generator`, local fonts (Inter, JetBrains Mono) | `apps/web/package.json` |
| Backend | Fastify 5.2, `pg` 8.13 | `apps/api/package.json` |
| Database | PostgreSQL 13+ (core only, no extensions; ADR-051) | `packages/persistence/migrations/*.sql` |
| Persistence approach | Hand-written SQL behind a one-method `SqlExecutor` port; no ORM | `packages/persistence/src/sql.ts`, ADR-045/046 |
| Password hashing (server) | scrypt N=16384, r=8, p=1, 64-byte key, per-user salt | `apps/api/src/passwords.ts:308` |
| Password hashing (browser demo) | PBKDF2, 210,000 iterations | `apps/web/src/runtime/local-provider.ts:10` |
| Real-time | Server-Sent Events (`GET /api/v1/stream`) with a 20 s heartbeat | `apps/api/src/stream.ts:49` |
| Tests | Vitest 2.1, jsdom, Testing Library | `vitest.config.ts` |
| Frontend hosting config | Vercel (`apps/web/vercel.json`) | |
| API hosting config | **None** (no Dockerfile, compose, Procfile or platform manifest) | file list |

### 2.2 Architecture diagram (as implemented)

```
                      ┌──────────────────────────────────────────────────────┐
                      │                    apps/web (Vite)                   │
                      │  index.html  → Staff app   (main.tsx → App.tsx)      │
                      │  display.html→ Board app   (display.tsx)             │
                      │  track.html  → Tracker PWA (track.tsx, sw.js)        │
                      │                                                      │
 ALL THREE ENTRIES →  │  data/bootstrap.ts  ── in-memory, per browser tab:   │
                      │    clinicStore (demo visits via real domain engine)  │
                      │    configStore (demo configuration)                  │
                      │    authStore + LocalIdentityProvider (PBKDF2 in tab) │
                      │    operationsStore (audit, telemetry, announcements) │
                      │    EventBus (in-process pub/sub)                     │
                      │                                                      │
                      │  api/client.ts, api/stream.ts, data/visits-api.ts,   │
                      │  data/configuration-api.ts  ← BUILT, USED ONLY BY    │
                      │                                TESTS (not wired)     │
                      └──────────────────────────────────────────────────────┘
                                         ┆  (no runtime connection today)
                                         ┆
                      ┌──────────────────▼───────────────────────────────────┐
                      │                  apps/api (Fastify)                  │
                      │  index.ts: loadConfig → connect → migrate → listen   │
                      │  server.ts: headers/CORS → CSRF → routes             │
                      │   /api/v1/auth/*   AuthService (scrypt, lockout)     │
                      │   /api/v1/config, /roles + config CRUD routes        │
                      │   /api/v1/visits/* queue actions, admission, route   │
                      │   /api/v1/public/* board + tracker (no auth)         │
                      │   /api/v1/stream   SSE (EventStream, in-process)     │
                      │   /api/health                                        │
                      └───────────────┬──────────────────────────────────────┘
                                      │ @qman/persistence (SQL, migrator)
                      ┌───────────────▼──────────────────────────────────────┐
                      │ PostgreSQL: hospitals, branches, roles, users,       │
                      │ sessions, stations, workflows, workflow_stages,      │
                      │ display_boards, ticket_templates, hospital_settings, │
                      │ visits, queue_entries, queue_number_sequences,       │
                      │ events, notification_attempts, login_throttle,       │
                      │ idempotency_keys, schema_migrations (runner)         │
                      └──────────────────────────────────────────────────────┘

            @qman/domain (pure, no I/O) is used by web, api and persistence alike.
```

### 2.3 How the parts interact (as coded)

- **Domain** (`packages/domain`) has no dependencies. Time, IDs and randomness come in through ports (`shared/clock.ts`, `shared/ids.ts`, `journey/journey-code.ts:33`). It owns:
  - the Visit aggregate and its transition table
  - routing rules
  - queue ordering and wait estimates
  - queue numbering
  - configuration validation
  - RBAC catalogue
  - analytics, telemetry and connection models
  - announcements, ticket templates
  - identity, password and session policies
- **Persistence** maps domain objects to rows and back by hand. The mapping is strict: unknown enum values throw `MappingError` (`packages/persistence/src/mappers.ts:56-80`). It also provides the migration runner, which takes an advisory lock and verifies checksums (`packages/persistence/src/migrator.ts`).
- **API** handlers do four things in order: load the aggregate, call the domain method, save visit plus events in one transaction, then publish to the in-process `EventStream` after commit (`apps/api/src/queue-routes.ts:124-212`).
- **Web** runs the same domain engine inside the browser against demo data. Each HTML entry imports `data/bootstrap.ts`, so **every tab has its own independent clinic** (`apps/web/src/display.tsx:5`, `apps/web/src/track.tsx:5`).
- **Platform portal:** does not exist.

### 2.4 Build and tooling

| Script | What it does | File |
|---|---|---|
| `npm run build` | `tsc --build` (domain, persistence, api) | `package.json:15` |
| `npm run typecheck` | Build, then check test files (`tsconfig.check.json`), then check web | `package.json:19` |
| `npm test` | `vitest run` over every `*.test.ts(x)` | |
| `npm run verify` | typecheck + build + web build + tests | `package.json:21` |
| `npm run verify:db -w @qman/api` | Runs only `apps/api/src/integration.test.ts`; skipped unless `DATABASE_URL` is set | `apps/api/package.json:11`, `integration.test.ts:47` |
| `npm run migrate -w @qman/api` | Applies migrations and exits | `apps/api/src/migrate.ts` |
| `npm run dev` | Vite dev server for the web app only | |

There is no root-level `verify:db` script. It only exists in the `@qman/api` workspace.

---

## 3. Repository structure

218 tracked files and about 39,000 lines (including tests and the lockfile, excluding PNGs). The history is 27 commits from 2026-08-04 to 2026-08-05. There have been no commits since.

### 3.1 Map

| Path | Contents and responsibility | Status |
|---|---|---|
| `package.json`, `tsconfig*.json`, `vitest.config.ts` | Workspace, TS project references, test config (aliases `@qman/*` to source) | Active |
| `.env.example` | API and web environment variables, documented | Active |
| `README.md` | Product intro and status table | **Stale** (claims 420 tests and an unverified DB; see §16.6) |
| `design/` | Stitch design screenshots (4 PNGs), `DESIGN.md` visual language, PRD summary | Reference |
| `docs/DECISIONS.md` | ADR-001…057 plus "Open items" | Active, but the open-items list is partly stale |
| `docs/HARDENING.md` | Pre-pilot checklist | Partly stale (still says auth is browser-only) |
| `docs/RUNBOOK.md` | Operator runbook for clinic staff | Active (describes a target state) |
| **`packages/domain/src/`** | Pure engine | Active, the core |
| ├ `visit/` | `visit.ts` (aggregate), `visit-status.ts` (transition table), `priority.ts`, `queue-entry.ts`, `visit-wire.ts` (JSON form) | Active |
| ├ `workflow/` | `workflow.ts` (definitions, validation), `routing.ts` (`resolveRoute`, `availableDestinations`) | Active. **The API does not use `routing.ts`** (§11, S-1) |
| ├ `queue/` | `station-queue.ts` (ordering, worklists, wait estimates), `queue-number.ts` (templates, reset periods, recovery) | Active |
| ├ `journey/` | Journey Code generation, normalisation, parsing | Active |
| ├ `configuration/` | `hospital-config.ts` (validation), `rbac.ts` (permission catalogue, default roles) | Active |
| ├ `events/` | Event envelope, visit events, `EventRecord` and query matching | Active |
| ├ `analytics/`, `telemetry/` | Pure projections: pulse, bottlenecks, station health, device/presence/channel health, connection model | Active (only in the browser at runtime) |
| ├ `announcements/`, `printing/`, `privacy/` | Announcement rendering, ticket templates, name policy | Active (browser only at runtime) |
| ├ `identity/` | Identity provider port, password policy, session and lockout policy | Active (used by both API and browser) |
| └ `testing/fixtures.ts` | Deterministic fixtures | Test support |
| **`packages/persistence/`** | | |
| ├ `migrations/001…006.sql` | Schema | Active |
| ├ `src/repositories.ts` | Visit, event, session, account, lockout, idempotency repositories; ticket allocator | Active |
| ├ `src/configuration.ts` | Configuration loader, board directory | Active |
| ├ `src/configuration-writer.ts` | Config create/update/delete SQL, usage counts | Active |
| ├ `src/mappers.ts`, `rows.ts` | Row ↔ domain mapping | Active |
| ├ `src/migrator.ts` | Migration runner (advisory lock, checksums, one transaction) | Active |
| ├ `src/pg.ts`, `sql.ts` | Postgres adapter, `FakeDatabase` test double, `WhereBuilder` | Active |
| **`apps/api/src/`** | | |
| ├ `index.ts` | **API entry point** (config → connect → migrate → listen; graceful shutdown) | Active |
| ├ `server.ts` | Hooks (request id, headers, CORS, CSRF, access log), auth routes, `/sessions` stub, `/stream`, `/api/health` | Active |
| ├ `auth.ts`, `authorization.ts`, `passwords.ts`, `tokens.ts`, `csrf.ts`, `rate-limit.ts`, `http-security.ts` | **Authentication and authorization** | Active |
| ├ `queue-routes.ts`, `admission.ts`, `visit-events.ts` | **Queue and workflow processing** | Active |
| ├ `config-routes.ts`, `config-write-routes.ts`, `configuration-service.ts` | Configuration read and create/update/delete | Active |
| ├ `public-routes.ts` | **Display board and patient tracking** API | Active (not consumed) |
| ├ `stream.ts` | SSE fan-out and audience projections | Active |
| ├ `idempotency.ts`, `logging.ts`, `config.ts`, `database.ts`, `migrations.ts`, `migrate.ts`, `version.ts` | Infrastructure | Active |
| ├ `config-fixtures.ts` | Fake repositories for tests (compiled into `dist`; not test-excluded) | Test support |
| └ `*.test.ts` (16 files) | Unit and route tests; `integration.test.ts` needs PostgreSQL | Active |
| **`apps/web/`** | | |
| ├ `index.html`, `display.html`, `track.html`, `vite.config.ts` | **Three build entries** (staff, board, tracker) | Active |
| ├ `src/main.tsx`, `src/App.tsx` | **Staff app entry** and tab navigation (state-based, no router) | Active |
| ├ `src/display.tsx` | **Display board entry** | Active (demo data) |
| ├ `src/track.tsx`, `public/sw.js`, `public/manifest.webmanifest`, `src/runtime/pwa.ts` | **Patient tracker entry** and PWA | Active (demo data) |
| ├ `src/data/bootstrap.ts` | Wires the in-memory stores and seeds demo accounts | Active, but **demo-only** |
| ├ `src/data/clinic-store.ts`, `demo-clinic.ts`, `config-store.ts`, `auth-store.ts`, `operations-store.ts`, `event-bus.ts`, `display-boards.ts` | In-memory stores | Active, but **demo-only** |
| ├ `src/api/client.ts`, `src/api/stream.ts`, `src/data/visits-api.ts`, `src/data/configuration-api.ts` | HTTP and SSE clients | **Built, not wired** (tests only) |
| ├ `src/features/*` | Screens: reception, station, manager, command, activity, admin (8 sections), auth, display, track, printing | Active (demo data) |
| ├ `src/runtime/*` | Ports for browser capabilities: speech, chime, notifications; `VoiceAnnouncer`, `Notifier`, local identity provider | Active |
| ├ `src/components/*`, `src/design/tokens.ts` | UI primitives, app shell, design tokens | Active |
| └ `vercel.json` | Vercel build and output | **Deployment config** |

### 3.2 Entry points, quick reference

| Concern | Entry |
|---|---|
| Web (staff) | `apps/web/index.html` → `src/main.tsx` → `src/App.tsx` |
| API | `apps/api/src/index.ts` → `buildServer` in `apps/api/src/server.ts:131` |
| Domain | `packages/domain/src/index.ts` |
| Migrations | `packages/persistence/migrations/`, run by `apps/api/src/migrate.ts` or automatically at API start (`index.ts:40`) |
| Authentication | `apps/api/src/auth.ts` (server); `apps/web/src/data/auth-store.ts` + `runtime/local-provider.ts` (browser demo) |
| Platform portal | **None** |
| Display boards | `apps/web/src/display.tsx`, `features/display/DisplayBoard.tsx`; API `GET /api/v1/public/boards/:boardId` (`apps/api/src/public-routes.ts:336`) |
| Patient tracking | `apps/web/src/track.tsx`, `features/track/PatientJourney.tsx`; API `public-routes.ts:368,394` |
| Queue and workflow | `apps/api/src/queue-routes.ts`, `admission.ts`; domain `visit/visit.ts`, `workflow/routing.ts` |
| Tests | `vitest.config.ts` (root), `apps/api/src/integration.test.ts` (database) |
| Deployment | `apps/web/vercel.json` only |

---

## 4. Implemented features inventory

**Legend:**
- **Complete:** complete and implemented.
- **Incomplete:** implemented but incomplete.
- **Limited:** implemented with limitations.
- **BE only:** backend implemented, frontend missing.
- **FE only:** frontend present, backend incomplete or not wired.
- **Planned:** planned but not implemented.
- **Absent:** no trace in code.

> Global caveat: because the web app is not wired to the API, every **FE** feature below runs only against in-browser demo data in a single tab. Every **BE** feature has never been exercised by a real user interface.

### 4.1 Platform administration

| Feature | Status | Evidence |
|---|---|---|
| Platform super-administrator | **Absent** | No role, table, route or screen |
| Platform authentication | **Absent** | Only hospital-scoped login exists |
| Organization (hospital) management, creation and provisioning | **Absent** | No endpoint or script. Provisioning means hand-written SQL (pattern in `apps/api/src/integration.test.ts:156-188`) |
| Suspension and reactivation | **Absent** | No `status` column on `hospitals` |
| Administrator reset | **Absent** | No password reset anywhere (server or UI) |
| Platform audit logs | **Absent** | Audit is per hospital (`events`) |
| Platform health monitoring | **Limited** | `GET /api/health` returns `ok` without checking the database (`server.ts:401-403`) |
| Platform permissions | **Absent** | |

### 4.2 Hospital administration

| Feature | Status | Evidence and notes |
|---|---|---|
| Hospital profile (name, code, timezone, phone, brand colour) | **BE only** (API) / **FE only** (portal edits the local store) | `PATCH /api/v1/profile` (`config-write-routes.ts:727`); `features/admin/HospitalSection.tsx`. Timezone is stored but not used for queue resets (§16.1, D-9) |
| Branch management | **Absent** (create, update, delete); read-only via config | No branch endpoints. Branches come back in `GET /config` |
| Station management (create, update, delete, SLA, numbering, public/enabled) | **BE complete** / **FE only** | API `config-write-routes.ts:242-385`; reference-checked delete (ADR-056); UI `StationsSection.tsx` uses `configStore` |
| Workflow configuration | **BE complete** / **FE only** | `config-write-routes.ts:387-480`; UI `WorkflowsSection.tsx` |
| Ticket configuration (templates, conditions, QR, paper size) | **BE complete** / **FE only** | `config-write-routes.ts:610-725`; UI `TicketsSection.tsx`, printing via isolated iframe (`features/printing/*`) |
| Display board management | **BE complete** / **FE only** | `config-write-routes.ts:482-608`; UI `DisplayBoardsSection.tsx` |
| Announcements configuration (voice templates) | **FE only** | `AnnouncementsSection.tsx` over the local `operationsStore`/`configStore`. No API, no persistence |
| Hospital defaults (name policy, default template) | **BE complete** / **FE only** | `PATCH /api/v1/settings` (`config-write-routes.ts:859`) |
| Role and permission management | **BE complete** / **FE only** | `POST/PATCH/DELETE /api/v1/roles` (`config-write-routes.ts:755-853`); `validateRoles` keeps at least one role with `admin.users` (`rbac.ts:152`) |
| Staff and user administration (create, disable, assign role or branch, reset password) | **Planned** | Explicitly deferred in the UI (`features/admin/RolesSection.tsx:132-143`). No API |
| Session administration (list, terminate) | **FE only** (local); **BE stub** | UI `SessionsSection.tsx` over `authStore`. `GET /api/v1/sessions` returns `[]` (`server.ts:310-316`). No terminate endpoint. `signOutEverywhere` exists (`auth.ts:271`) but no route uses it |
| Configuration validation with problems shown in the UI | **Complete** (domain), used by both | `hospital-config.ts:106-288`, `AdminPortal.tsx` |

### 4.3 Patient operations

| Feature | Status | Evidence and notes |
|---|---|---|
| Patient admission (create visit, Journey Code, first ticket, tracking token) | **BE only**. UI button **does nothing** | API `POST /api/v1/visits` (`queue-routes.ts:229-320`). Reception's "Create Visit" button has no handler (`features/reception/ReceptionDashboard.tsx:123-125`). The demo store has no create method |
| Queue management (worklists, ordering by priority then arrival, wait estimates) | **Complete** (domain); **Limited** (API) | Domain `queue/station-queue.ts`. API `GET /stations/:id/queue` returns raw visits. Ordering is left to the client |
| Calling patients | **BE complete** / **FE only** | `POST /visits/:id/call`; `StationWorkspace.tsx:91` (demo, key **N**) |
| Recall | **Limited** | `POST /visits/:id/recall` runs the same aggregate method as call (`queue-routes.ts:393-397`). Permission separation is not real (§11, S-11) |
| Start service | **BE complete** / **FE only** | `queue-routes.ts:399` |
| Complete | **BE complete** / **FE only** | `queue-routes.ts:411` |
| Skip (keeps place) | **BE complete** / **FE only** | `queue-routes.ts:405`; ADR-007 |
| Route between stations | **Limited** | `POST /visits/:id/route`. **No workflow enforcement on the server.** `followedWorkflow` is trusted from the client (`queue-routes.ts:347`; `visit.ts` `routeTo` has no workflow check). The demo UI does use `resolveRoute` (`clinic-store.ts:316`) |
| Reopen a completed visit | **Limited** | Allowed by the transition table (`visit-status.ts:92-98`) through route. Not gated by the workflow |
| Cancellation | **BE only** | `POST /visits/:id/cancel`. No cancel control found in the station UI |
| Escalate / change priority | **FE only** | Demo `clinic.escalate` (`StationWorkspace.tsx:122`). **No API endpoint** although `Visit.changePriority` and the `visit.escalate` permission exist |
| Close a visit | **Absent** in practice | `Visit.close` exists (`visit.ts` ~415) but nothing calls it. `closed_at` is never set |
| Patient status tracking (visit and entry status) | **Complete** (domain) | `visit-status.ts` |
| Ticket number recovery after restore | **BE only** (library) | `PostgresTicketAllocator.reconcileSeries/advanceTo` (`repositories.ts:814-866`). No CLI or route to run it |

### 4.4 Patient experience

| Feature | Status | Evidence and notes |
|---|---|---|
| Journey Codes | **Complete** | 4 characters from a 30-symbol alphabet, crypto RNG, repair of misread characters (`journey/journey-code.ts`) |
| QR tracking token (hashed, one-time display) | **BE only** | `admission.ts:572`, `repositories.ts:201-209`, `public-routes.ts:368-381`. The web ticket QR encodes the tracker URL with the **code**, not a token (demo) |
| Public tracking page | **FE only** (demo) + **BE only** (API) | `features/track/PatientJourney.tsx` reads the tab-local `clinicStore`, so in a real deployment it shows only demo visits. API: token and code lookup (code lookup limited to 6/min per IP) |
| PWA install, shell caching | **Limited** | `public/sw.js`, `runtime/pwa.ts`. Not verified on devices (HARDENING §4) |
| Patient alerts ("your turn" browser notification) | **FE only** | `features/track/PatientAlerts.tsx`, `runtime/notifier.ts`. Driven by the local bus |
| Display boards | **FE only** (demo) + **BE only** (snapshot API) | `DisplayBoard.tsx` reads the tab-local store, so **it will never reflect staff actions on another machine.** API board snapshot exists. **There is no public SSE endpoint** for boards |
| Live queue updates across screens | **Planned** (not wired) | §10 |
| Voice announcements (speech synthesis + chime, serialised) | **FE only** | `runtime/announcer.ts`, wired only on the board (`display.tsx:40-46`) |
| SMS, WhatsApp, email | **Planned** | Modelled as channels in `telemetry/operational-health.ts:99-101`. No implementation |

### 4.5 Operational management

| Feature | Status | Evidence and notes |
|---|---|---|
| Reception dashboard | **FE only**, partly static | `ReceptionDashboard.tsx`. Stat deltas are hard-coded ("+12 vs yesterday", "−8"), lines 133, 141. "View full queues", Filter and More options have no handlers. The header patient search has no handler (`AppShell.tsx:144-151`) |
| Priority Patients panel | **FE only** | `features/reception/PriorityPatients.tsx` |
| Station workspace (every station type, keyboard shortcuts) | **FE only** | `StationWorkspace.tsx`, `station-profiles.tsx`. **Actor is the hard-coded `CURRENT_USER = "user-doctor"`** (`clinic-store.ts:412`; used at `StationWorkspace.tsx:91-142`), not the signed-in user |
| Manager dashboard | **FE only** | `ManagerDashboard.tsx`, domain analytics |
| Command Centre (bottlenecks, unstaffed stations, device health, channel health, presence) | **FE only**, telemetry mostly empty in practice | Device heartbeats are only reported by a board rendered **in the same tab** (`DisplayBoard.tsx:69`). Notification attempts are recorded locally. Across real machines the Command Centre would show no devices |
| Activity and Audit Explorer | **FE only** (local); **BE** query exists | UI over `operationsStore`. API `GET /api/v1/events` (`queue-routes.ts:423`) unused |
| Audit history (server) | **Limited** | Config changes and visit events are written to `events` in the same transaction. Sign-in and sign-out security events are **not** written to `events` on the server (only logged) |
| Analytics and reports, export | **Planned** (export); local projections only | No report endpoints. `reports.export` permission is unused |
| Connection honesty (Live / Reconnecting / Stale / Offline) | **FE complete** (model + UI); fed by a local keepalive | `telemetry/connection.ts`, `components/ui/ConnectionStatus.tsx`, `bootstrap.ts:166-168` |

### 4.6 Infrastructure features (backend)

| Feature | Status |
|---|---|
| Migrations (advisory lock, checksums, single transaction, applied at start) | **Complete** (`migrator.ts`) |
| Idempotency keys for queue actions and config writes | **Limited**: **admission is not guarded** (`queue-routes.ts:229` never calls `guard`) |
| Structured JSON logging with redaction | **Complete** (`logging.ts`) |
| Graceful shutdown | **Complete** (`index.ts:109-124`) |
| API versioning `/api/v1` | **Complete** (`version.ts`) |
| Security headers, CORS allow-list | **Complete** (`http-security.ts`) |

---

## 5. User roles and permission matrix

### 5.1 Where permissions are defined

- **Catalogue (closed set):** `packages/domain/src/configuration/rbac.ts:13-32`, 18 permissions.
- **Default roles:** `rbac.ts:84-139`. These are browser seed data. On the server, roles are rows in `roles` that a hospital must provision. The default role IDs (`role-receptionist` and so on) are not UUIDs and cannot be inserted into `roles.id uuid` as they stand.
- **Server enforcement:** `requirePermission` preHandler (`apps/api/src/authorization.ts:392-429`), declared per route.
- **Frontend enforcement:** navigation filter only (`apps/web/src/components/layout/AppShell.tsx:216`). Individual action buttons are not gated.

### 5.2 Default roles × permissions (browser seed; the intended defaults)

| Permission | Receptionist | Clinician | Manager | Administrator | Enforced on server by |
|---|:-:|:-:|:-:|:-:|---|
| `visit.create` | ✔ | | | ✔ | `POST /visits` |
| `visit.cancel` | ✔ | | | ✔ | `POST /visits/:id/cancel` |
| `visit.view_identity` | ✔ | ✔ | ✖ (deliberate) | ✔ | **Nothing**: no code references it outside the catalogue (§11, S-2) |
| `visit.escalate` | ✔ | ✔ | | ✔ | **No endpoint** |
| `queue.call` | ✔ | ✔ | | ✔ | `/call`, `GET /stations/:id/queue` |
| `queue.recall` | ✔ | ✔ | | ✔ | `/recall` (same effect as `/call`) |
| `queue.skip` | ✔ | ✔ | | ✔ | `/skip` |
| `queue.start` | ✔ | ✔ | | ✔ | `/start` |
| `queue.complete` | ✔ | ✔ | | ✔ | `/complete` |
| `queue.route` | ✔ | ✔ | | ✔ | `/route` |
| `queue.route_off_workflow` | | ✔ | | ✔ | Only if the client sends `followedWorkflow:false` (bypassable) |
| `reports.view` | | ✔ | ✔ | ✔ | `GET /branches/:id/visits`, `GET /events` |
| `reports.export` | | | ✔ | ✔ | **No endpoint** |
| `admin.stations` | | | | ✔ | Station create/update/delete |
| `admin.workflows` | | | | ✔ | Workflow create/update/delete |
| `admin.display_boards` | | | ✔ | ✔ | Board create/update/delete |
| `admin.users` | | | | ✔ | Roles create/update/delete, `GET /roles`, `GET /sessions` (stub) |
| `admin.settings` | | | | ✔ | Profile, settings, ticket templates; also gates the Admin nav entry |

**Signed-in-only routes** (no permission needed): `GET /auth/me`, `GET /config`, `GET /stream`.

### 5.3 What each role can and cannot do, through the API

- **Receptionist:**
  - Can: admit, cancel, perform every queue action, route within the workflow, and route outside it by sending `followedWorkflow:true`. Sees full patient identity in responses.
  - Cannot: see reports or the event log, or administer anything.
- **Clinician:**
  - Can: everything a receptionist does on the queue, plus see reports.
  - Cannot: admit or cancel.
  - Through `reports.view`, can read **every active visit with full identity** for any branch ID (§11, S-2, S-5).
- **Manager:**
  - Designed not to see identities. Actually receives names, phone numbers and hospital numbers via `GET /branches/:id/visits` (`queue-routes.ts:375-379` returns `describeVisit` → `state: visitToWire(visit)` → `patient{name,hospitalNumber,phone}`, `packages/domain/src/visit/visit-wire.ts`).
  - Can administer display boards.
- **Administrator:** all permissions.
- **Patient / board (public):** may only read `GET /public/boards/:id` (tickets, statuses, times) and the tracker lookups. The board projection excludes name, Journey Code and visit ID (`public-routes.ts:274-292`).

### 5.4 Platform-level versus hospital-level permissions

There are **no platform-level permissions**. All permissions are hospital-scoped. A server has one hospital. "Administrator" means hospital administrator.

### 5.5 Gaps and inconsistencies

1. `visit.view_identity` is not enforced anywhere (S-2).
2. `visit.escalate` and `reports.export` guard nothing (no endpoints).
3. `queue.recall` and `queue.call` are not truly separate (S-11).
4. `queue.route_off_workflow` can be bypassed (S-1).
5. `GET /stream` and `GET /config` require only a session. Any role, including a future "kiosk" role, gets the whole hospital's event stream for its branch, or all branches if the session has no branch.
6. Frontend gating is navigation-only. In the demo, a user who reaches the station workspace can perform every action regardless of individual permissions.
7. Role lockout protection checks that *a role* keeps `admin.users`, not that *a user* holds it (`rbac.ts:155`). An administrator can move `admin.users` to a new empty role and strip it from their own role, which locks everyone out. Today this matters little, because there is no user management at all.
8. Role permissions are not validated against the catalogue on write. Unknown strings are stored and silently dropped on read (`packages/persistence/src/configuration.ts:129-131`).

---

## 6. Organization and multi-tenancy

### 6.1 How it works today

| Question | Answer from the code |
|---|---|
| How are hospitals created? | Not by the application. A row must be inserted into `hospitals` manually, along with `branches`, `roles`, `users` (with scrypt hash and salt), `ticket_templates` and `hospital_settings`. There is no seed or bootstrap script. |
| How are IDs assigned? | `uuid DEFAULT gen_random_uuid()` in SQL. Entities created through the API use `randomUUID()` on the server (ADR-057, `config-write-routes.ts:247`). |
| How is the tenant identified at login? | It is not identified from the request. `resolveHospital: () => config.hospitalId` (`index.ts:63`) is a constant from `QMAN_HOSPITAL_ID`. |
| How are sessions associated with a tenant? | Indirectly: `sessions.user_id → users.hospital_id`. `AuthService.resolve` returns the account's `hospitalId` (`auth.ts:253-259`). |
| How do requests get their tenant scope? | Always the configured constant. `requirePermission` compares it to the account's hospital and refuses with 403 on mismatch (`authorization.ts:397-409`). **`requireSignedIn` does not make this comparison** (`authorization.ts:432-436`), so `GET /config`, `GET /stream` and `GET /auth/me` skip the tenant check. |
| How do repositories enforce ownership? | **Inconsistently.** See below. |
| Branches → hospital | `branches.hospital_id` FK, with one default branch per hospital (partial unique index). |
| Stations, workflows, boards → branch | `branch_id` FK (no `hospital_id`). |
| Visits → hospital | `visits.branch_id` only. **No `hospital_id` column on `visits` or `queue_entries`.** |
| Platform admins | Do not exist. |

### 6.2 Tenant-scoping audit of queries (Verified, code)

| Query | Scoped by hospital? | File |
|---|---|---|
| Account by username | Yes | `repositories.ts:551-557` |
| Account by ID | No, but the caller compares hospital | `repositories.ts:563-565` |
| Configuration load (all parts) | Yes | `configuration.ts:136-188` |
| Roles load | Yes | `configuration.ts:119-123` |
| Idempotency keys, login throttle | Yes | `repositories.ts:610-771` |
| **Visit by ID** (all queue actions) | **No** | `repositories.ts:135-137` |
| **Open visits at station** | **No**, and **no branch check in the route** | `repositories.ts:157-169`, `queue-routes.ts:369-373` |
| **Active visits in branch** (caller-supplied branch ID) | **No** hospital check, **no** session-branch check | `repositories.ts:171-179`, `queue-routes.ts:375-379` |
| **Event query** (`GET /events`) | **No** `hospital_id` predicate at all | `repositories.ts:368-415` |
| Session `activeForHospital()` | **No** predicate, despite the name | `repositories.ts:478-481` (unused) |
| **Delete station, workflow or board** | **No** (only `WHERE id = $1`) | `configuration-writer.ts:238-249` |
| Update station, workflow or board | No, but `apply` only produces entities from this hospital's config | `configuration-writer.ts:320-391` |
| Ticket templates, roles (update and delete) | Yes | `configuration-writer.ts:252-308, 405-415` |
| Public board lookup | No (by UUID; public by design) | `configuration.ts:264-270` |

### 6.3 What prevents one hospital reaching another's data

In the intended deployment (one database per hospital), **physical separation** does. If two hospitals ever share a database, which the schema and the `resolveHospital` comment invite, these become reachable by any authenticated staff member of hospital A who knows (or obtains) a UUID from hospital B:

- acting on another hospital's visits (call, complete, cancel, route)
- listing another hospital's active visits with patient identity
- reading another hospital's event log
- deleting another hospital's unused stations, workflows or boards (see §11, S-5)

A session token from hospital B presented to A's server would also pass `requireSignedIn` routes and read A's configuration and event stream.

### 6.4 Branch-level isolation inside one hospital

- Queue actions check the visit's branch only when the session has a branch (`queue-routes.ts:163`).
- A session's branch is chosen by the client at login, and is null if omitted (`server.ts:239`, `auth.ts:290-295`).
- Listing endpoints ignore the session's branch entirely.

**Branch restriction is therefore advisory.**

### 6.5 Cross-tenant tests that exist

- `auth.test.ts:247`: an account from another hospital is not authenticated.
- `security.test.ts:203`: a session whose account belongs to a different hospital is refused (`requirePermission` path).
- `idempotency.test.ts:112`: idempotency is scoped to a hospital.
- `integration.test.ts:222`: account lookup does not cross hospitals.
- `stream.test.ts:178`: branch filtering of SSE.

**Missing:** any test that a visit, event, station or branch of hospital B cannot be read or modified through hospital A's server; any test of `requireSignedIn` routes across tenants; any branch-isolation test for listing routes.

---

## 7. Database and data model

### 7.1 Migrations

Six forward-only SQL files in `packages/persistence/migrations/`:

| # | Purpose |
|---|---|
| 001_initial | Full schema (16 tables) |
| 002_session_tokens | `sessions.token_hash` + unique and open indexes |
| 003_login_throttle | `login_throttle` |
| 004_idempotency | `idempotency_keys` |
| 005_tracking_tokens | `visits.tracking_token_hash` + indexes |
| 006_deferred_current_entry | Makes `visits_current_entry_fk` `DEFERRABLE INITIALLY DEFERRED` |

How they run:

- The runner applies them in one transaction under `pg_advisory_xact_lock`.
- It records names and checksums, and refuses modified or unknown migrations (`migrator.ts`).
- The API migrates on every start (`index.ts:40`).
- `migrations.test.ts` rejects `CREATE EXTENSION`, `CONCURRENTLY` and transaction control.
- There are **no down migrations**.

**Whether the live schema matches the migrations cannot be verified.** No database is reachable. The comments in 006 and ADR-051 say an integration run against real PostgreSQL found and fixed two DDL defects. That run cannot be reproduced here.

### 7.2 Entities

| Table | Purpose | Key fields and constraints | Tenant |
|---|---|---|---|
| `hospitals` | Tenant | `code UNIQUE`, `timezone`, `brand_color` | itself |
| `branches` | Site | `UNIQUE(hospital_id, code)`; one default per hospital (partial unique) | hospital FK, CASCADE |
| `roles` | Role with `permissions text[]` | `UNIQUE(hospital_id, key)`, `is_system` | hospital |
| `users` | Staff accounts | Unique index `(hospital_id, lower(username))`; nullable hash and salt for directory accounts; `role_id` RESTRICT | hospital |
| `user_branches` | Branch grants (empty = all) | PK(user, branch) | via user |
| `sessions` | Server sessions | `token_hash` unique (partial), open index, `branch_id` nullable | via user |
| `stations` | Service points | `UNIQUE(branch_id, code)`; CHECKs on staffing, estimates, SLA; `queue_template`, `queue_reset` (no CHECK) | branch |
| `workflows` | Pathways | One default per branch (partial unique) | branch |
| `workflow_stages` | Ordered stages | `UNIQUE(workflow_id, sequence)`, `UNIQUE(workflow_id, station_id)`, `station_id` RESTRICT, `branches_to uuid[]` (no FK) | via workflow |
| `display_boards` | Board config | `station_ids uuid[]` (no FK), `name_policy` text (no CHECK) | branch |
| `ticket_templates` | Printed ticket layout | `elements jsonb` | hospital |
| `hospital_settings` | Singletons (`settings jsonb`) | PK hospital | hospital |
| `visits` | A patient's visit | `patient_name`, `hospital_number`, `phone` (plaintext PII); `status`, `priority` (**no CHECK**); `current_queue_entry_id` (deferred FK); `closed_at`; `tracking_token_hash` unique | **branch only** |
| `queue_entries` | One station leg | `UNIQUE(visit_id, sequence)`; `queue_label` as issued; `queue_period`; `station_id` RESTRICT | via visit |
| `queue_number_sequences` | Ticket counters | PK(station, period) | via station |
| `events` | Durable business log | `sequence bigserial`, unique (hospital, sequence); `category` CHECK; **`branch_id NOT NULL`**; `payload jsonb`; `summary` | hospital + branch |
| `notification_attempts` | Delivery outcomes | | branch (**never written by any code**) |
| `login_throttle` | Lockout state | PK(hospital, username_key), no FK to users (deliberate) | hospital |
| `idempotency_keys` | Retry store | PK(hospital, key) | hospital |

### 7.3 ER diagram

```
hospitals 1─* branches 1─* stations 1─* queue_number_sequences
    │            │  │  └─* workflows 1─* workflow_stages *─1 stations
    │            │  └──* display_boards (station_ids uuid[] → stations, no FK)
    │            └─────* visits 1─* queue_entries *─1 stations
    │                       ↑ current_queue_entry_id (deferred FK)
    ├─* roles 1─* users 1─* sessions (*─0..1 branches)
    │              └─* user_branches *─1 branches
    ├─* ticket_templates
    ├─1 hospital_settings
    ├─* events (*─1 branches, *─0..1 visits, *─0..1 users as actor)
    ├─* login_throttle
    └─* idempotency_keys
branches 1─* notification_attempts (unused)
```

### 7.4 Lifecycle, deletion and retention

- **Visits are never closed and never deleted** by the application (D-7). `closed_at` stays NULL, so:
  - the "active" partial indexes grow without bound
  - `activeInBranch` returns every visit ever admitted, completed and cancelled included (`repositories.ts:171-176`)
  - the board endpoint and branch list slow down over time
  - tracking tokens and Journey Codes resolve forever
- **Events** are never deleted by the application. `ON DELETE CASCADE` from hospital and branch means deleting a branch would erase its audit history.
- **Pruning** for `login_throttle` and `idempotency_keys` exists as repository methods (`repositories.ts:645, 769`) but **nothing calls them** (no scheduler).
- **Sessions:** ended sessions remain as rows. There is no pruning.
- **Station, workflow and role deletion** is refused with a reason while still referenced (ADR-056).

### 7.5 Schema risks and observations

1. `events.branch_id NOT NULL` conflicts with administrative audit entries whose `branchId` is the session's branch, which can be null (`configuration-service.ts:335`). **Configuration writes by an admin whose session has no branch would fail with a NOT NULL violation (500).** Verified (code); not executed. The Postgres integration suite exercises the writer directly, not `ConfigurationService` (`integration.test.ts:549+`). The service tests use `FakeDatabase`, which has no constraints.
2. No CHECK constraints on `visits.status`, `visits.priority`, `queue_entries.status`, `stations.queue_reset`, `name_policy` columns. Invalid values are caught only when read (`MappingError`), which turns one bad row into failed reads for every query that touches it (S-3).
3. No `hospital_id` on `visits` or `queue_entries`. Tenant scoping needs a join through `branches`, which no visit query does.
4. Array references (`display_boards.station_ids`, `workflow_stages.branches_to`) have no referential integrity.
5. `visits_hospital_number` index is global, not per branch or hospital.
6. Duplicate indexes: `visits_open_journey_code` (005) duplicates the column set of the unique `visits_active_journey_code` (001).
7. No optimistic-concurrency column (version) on `visits`. See D-3.
8. PII (`patient_name`, `phone`, `hospital_number`) is stored in plaintext. Encryption at rest depends on the provider.
9. `notification_attempts` is never written.
10. Entities likely to need expansion:
    - `hospitals.status` (suspension)
    - users or staff management fields (email, last login, must-change-password)
    - per-station ticket-template ID
    - persisted announcement config
    - visit closure and retention policy
    - an appointments link
    - an HMS external ID

---

## 8. API and backend capabilities

Base prefix `/api/v1`. Shared rules:

- **Unsafe methods** must pass origin and CSRF checks once a session cookie exists (`csrf.ts:101-122`).
- **"Perm"** means `requirePermission` (which includes the tenant check).
- **"Signed-in"** means `requireSignedIn` (no tenant check).
- **Tenant** is always the configured `QMAN_HOSPITAL_ID`.
- **Status:** every endpoint below is implemented. "Unused" means no runtime frontend code calls it (true of **all** of them).

### 8.1 Authentication and sessions

| Method | Route | Auth | Payload → Response | Notes |
|---|---|---|---|---|
| POST | `/auth/login` | none (origin check) | `{username,password,branchId?}` → `{user, csrfToken}` + cookies `qman_session` (HttpOnly), `qman_csrf` | IP rate limit 20/min; lockout per username in DB; 401 uniform, 429 locked (`server.ts:218-287`) |
| POST | `/auth/logout` | cookie | → 204 | Always 204 |
| GET | `/auth/me` | Signed-in | → `{user}` | |
| GET | `/sessions` | Perm `admin.users` | → `{sessions: []}` | **Stub** (`server.ts:310-316`) |
| *missing* | terminate a session, sign out everywhere, change or reset password, user create/update/delete | | | `AuthService.signOutEverywhere` exists without a route |

### 8.2 Configuration

| Method | Route | Permission | Notes |
|---|---|---|---|
| GET | `/config` | Signed-in | Whole `HospitalConfiguration` + `problems` |
| GET | `/roles` | `admin.users` | |
| POST / PATCH / DELETE | `/stations[/:id]` | `admin.stations` | Delete refused while referenced (stages, entries, boards) |
| POST / PATCH / DELETE | `/workflows[/:id]` | `admin.workflows` | Delete refused while visits reference it |
| POST / PATCH / DELETE | `/display-boards[/:id]` | `admin.display_boards` | |
| POST / PATCH / DELETE | `/ticket-templates[/:id]` | `admin.settings` | |
| PATCH | `/profile` | `admin.settings` | |
| PATCH | `/settings` | `admin.settings` | Default name policy and ticket template |
| POST / PATCH / DELETE | `/roles[/:id]` | `admin.users` | System roles cannot be deleted (but see S-8) |

Every write:

1. loads the whole configuration in a transaction
2. applies a pure change
3. runs `validateHospitalConfiguration`, returning 422 with `problems` on failure
4. persists one entity
5. appends an audit `events` row in the same transaction
6. returns `{configuration, warnings}` (`configuration-service.ts:208-260`)

Idempotency keys are honoured. **Missing:** branch create/update/delete, announcement config, user management.

### 8.3 Visits and queue operations

| Method | Route | Permission | Notes |
|---|---|---|---|
| POST | `/visits` | `visit.create` | Body `{patientName, hospitalNumber?, phone?, priority?, workflowId?}` → 201 `{visit, trackingToken}`. **Not idempotent.** **Priority unvalidated.** Unknown workflow or station gives 500 (plain `Error`, `admission.ts:536-544, 489-491`) |
| POST | `/visits/:id/call` | `queue.call` | 409 on illegal transition |
| POST | `/visits/:id/recall` | `queue.recall` | Same aggregate call as `/call` |
| POST | `/visits/:id/start` | `queue.start` | |
| POST | `/visits/:id/skip` | `queue.skip` | |
| POST | `/visits/:id/complete` | `queue.complete` | |
| POST | `/visits/:id/cancel` | `visit.cancel` | |
| POST | `/visits/:id/route` | `queue.route` (+ `queue.route_off_workflow` only if `followedWorkflow:false`) | Body `{stationId, followedWorkflow?}`. The ticket is allocated before the aggregate validates, so a refused route uses up a number |
| GET | `/stations/:stationId/queue` | `queue.call` | Visits with an open entry at the station, unordered; full state incl. PII |
| GET | `/branches/:branchId/visits` | `reports.view` | All visits with `closed_at IS NULL` (that is, all visits ever); full PII |
| *missing* | change priority/escalate, close, search by name, hospital number or code, get one visit, assign | | |

Every visit response includes `state: visitToWire(visit)`: patient name, hospital number, phone and all queue entries (`queue-routes.ts:73-112`).

### 8.4 Events, activity, stream

| Method | Route | Auth | Notes |
|---|---|---|---|
| GET | `/events?branchId&correlationId&limit` | `reports.view` | **No hospital predicate**; category, type, search and actor filters exist in the repository but are not exposed by the route (`queue-routes.ts:423-431`) |
| GET | `/stream` | Signed-in | SSE; branch filter = session branch (null = all); 20 s heartbeat; no replay; no permission |

### 8.5 Public (no authentication)

| Method | Route | Notes |
|---|---|---|
| GET | `/public/boards/:boardId` | Tickets, status, queued and called times for the board's stations. `room` is always `null` (`public-routes.ts:353`). Ignores `waitingToShow`. A non-UUID ID would likely give 500 (Suspected) |
| GET | `/public/track/token/:token` | Token hash lookup; status, Journey Code, current station and ticket |
| POST | `/public/track/code` | `{code, branchId}`; 6/min per IP; uniform 404 |
| *missing* | public board SSE stream; tracker position, ahead-count or estimate (the tracker would have to compute them, but cannot because the queue is not exposed); hospital branding for the tracker | |

### 8.6 Health

`GET /api/health` returns `{status:"ok", at}` without checking the database.

### 8.7 Frontend functionality with no backend endpoint

- escalate (priority change)
- announcement settings
- session listing and termination
- users
- branches
- the Command Centre's telemetry (device heartbeats, presence, notification attempts)
- report export
- visit search
- ticket reprint lookup
- tracker position and estimated wait

---

## 9. Frontend and user experience

### 9.1 Applications and navigation

There are three Vite entries. The staff app has no router: `App.tsx` holds an `active` tab in React state. Navigation entries are filtered by permission (`AppShell.tsx:45-81`).

| Nav | Required permission |
|---|---|
| Reception | `visit.create` |
| Clinical | `queue.call` |
| Manager | `reports.view` |
| Command | `reports.view` |
| Activity | `reports.view` |
| Admin | `admin.settings` |

### 9.2 Screens

**Data source for all screens below: in-browser demo stores** (`clinicStore`, `configStore`, `operationsStore`, `authStore`), seeded per tab by `bootstrap.ts` and `demo-clinic.ts`. Demo visits are produced by driving the real domain aggregate (`demo-clinic.ts:216-290`). Nothing below is API-driven or SSE-driven.

| Screen | File | Users | Actions | Notes |
|---|---|---|---|---|
| Sign in | `features/auth/SignIn.tsx` | Staff | Username and password against the in-browser PBKDF2 provider; lockout and messages | Seed users `ifeoma`, `adams`, `admin`; password random per load, printed to the console only in dev (`bootstrap.ts:125-156`) |
| Reception Dashboard | `features/reception/ReceptionDashboard.tsx`, `PriorityPatients.tsx` | Reception | Print ticket for a visit | **"Create Visit" does nothing** (line 123); fake deltas; filter and more-options no-ops; header "Call Next" no-op (`App.tsx:92`) |
| Station Workspace | `features/station/StationWorkspace.tsx` | Clinicians | Call next (N), recall (R), skip (K), start (S), complete (C), escalate (E), route to workflow-allowed destinations | Actor hard-coded to `user-doctor`; station switcher shows demo stations from `demo-clinic.ts` (`App.tsx:157`) |
| Manager Dashboard | `features/manager/ManagerDashboard.tsx` | Managers | Drill into a station | Locally derived analytics |
| Command Centre | `features/command/CommandCentre.tsx` | Managers, admins | Open a station | Impact-ordered alerts. Device and channel telemetry is effectively empty across machines |
| Activity and Audit Explorer | `features/activity/ActivityExplorer.tsx` | Supervisors, admins | Filter, search, journey view; separate audit tab | Local log of this tab's session only |
| Admin Portal (8 sections) | `features/admin/*.tsx` | Admins | Hospital, Stations, Workflows, Display Boards, Announcements, Printed Tickets, Roles & Permissions, Sessions | Validation problems flagged per section. Changes are local and lost on reload. Users section is a placeholder |
| Ticket print dialog | `features/printing/*` | Reception | Print 58 mm, 80 mm or A4 through an isolated iframe with QR | QR encodes a tracker URL with the Journey Code, not the server tracking token |
| Display Board | `features/display/DisplayBoard.tsx` | Waiting room | none | Shows now-calling and waiting from **its own tab's demo clinic**; voice announcements; honest connection badge. **Cannot reflect another machine's actions** |
| Patient Journey Tracker | `features/track/PatientJourney.tsx`, `PatientAlerts.tsx` | Patients | Enter or scan code; enable alerts; install the PWA | Looks up the code in its own tab's demo clinic. In production it would not find real visits |

### 9.3 UX gaps and observations

1. **No admission flow.** The single most important reception action is missing.
2. **No shared state.** Two tabs or machines show different clinics. A "board in the waiting room" cannot work.
3. **Admin edits do not persist** (lost on reload). Users section is a placeholder.
4. **Placeholder buttons and fake numbers** on Reception (hard-coded deltas).
5. **Actor attribution wrong** in the station workspace (always "Dr Adams").
6. **No cancel control** in the station workspace. **Visit search is non-functional:** the header has a "Search patient (code, name, phone)…" input with no change or submit handler (`components/layout/AppShell.tsx:111,144-151`). The runbook's "lost ticket" procedure depends on this search.
7. **Station switcher hard-wired to demo stations** (`demo-clinic.ts`), not to configuration.
8. **Accessibility:** groundwork exists (`aria-live` announcer, `role="tablist"`, focus retained, reduced motion), but there has been no audit (HARDENING §4). The station switcher uses `role="tab"` without the arrow-key handling the tab pattern requires (Suspected; not exhaustively checked).
9. **Empty states:** not systematically reviewed. With a real empty database, many demo-tuned panels are untested.
10. **Error UX for API failures** (401, 403, 409, 422, offline) is designed in `api/client.ts` (`ApiError`, `failure`, `problems`) but no screen consumes it yet.

---

## 10. Real-time system and event architecture

### 10.1 Two separate event systems exist

**A. Browser (what actually runs).** `EventBus` (`apps/web/src/data/event-bus.ts`) is an in-process pub/sub inside one tab.

- `ClinicStore` performs a domain action, pulls the aggregate's events and publishes them to the bus.
- Subscribers on the bus:
  - `operationsStore`: announcements, notification-attempt intent, audit, presence (`operations-store.ts:265, 335-350`)
  - `VoiceAnnouncer`: board tab only (`display.tsx:40-46`)
  - `Notifier`: staff per-station and tracker (`App.tsx:55-58`, `track.tsx`)
  - React views via `useClinic` and `useOperations`
- Freshness comes from `clinicStore.keepAlive()` every 15 s (`bootstrap.ts:166-168`), so the connection model always reads "Live" in a single tab.

**B. Server (built, unused).**

- After a visit is saved with its events in one transaction, the handler publishes each record to `EventStream` (`queue-routes.ts:197-209`).
- `EventStream` renders a **per-audience payload**:
  - staff: event ID, type, time, branch, visit ID, correlation (Journey Code), station, ticket, summary; never a patient name (`stream.ts:90-107`)
  - public: no Journey Code, visit ID or summary (`stream.ts:127-143`)
- Delivery is filtered by branch. Failing subscribers are dropped. A 20 s heartbeat is sent.
- `GET /api/v1/stream` subscribes only the `staff` audience. **There is no public SSE route**, so the board projection is unreachable.
- Client side: `EventStreamClient` (`apps/web/src/api/stream.ts`) uses `EventSource` with credentials, exponential backoff and connection-state reporting. **Not used.**

### 10.2 What happens when a patient is admitted, called, served, completed or routed

| Step | In the running demo (one tab) | In the built server (if a client used it) |
|---|---|---|
| Admitted | **Not possible** in the UI | `POST /visits`: Journey Code → ticket allocated (`INSERT … ON CONFLICT … RETURNING`, a separate statement **outside** the save transaction) → `visit.created`, `visit.queued` saved with the visit → published to staff SSE subscribers in the branch → 201 with tracking token |
| Called | `clinic.callNext` → `visit.called` on the bus → announcer (board tab only), operations log, notifier, views re-render | `POST /visits/:id/call` → load → `visit.call` → save + event → SSE publish |
| Served | `startService` → `visit.service_started` | same pattern |
| Completed | `complete` → `visit.completed` | same pattern |
| Routed | `route` (uses `resolveRoute`) → `visit.routed` + `visit.queued` | `ticketForRoute` allocates a ticket → `routeTo` (no workflow check) → save → publish |

### 10.3 Real-time properties of the server path

| Property | Status |
|---|---|
| Updates in real time | Staff SSE subscribers in the same API process, same branch |
| Polling | None implemented. The board and tracker would have to poll the public endpoints |
| After interruption | `EventSource` reconnects; the client backs off; **no replay**. The server ignores `Last-Event-ID`; published IDs are synthetic (`${visitId}-${ms}-${type}`, `queue-routes.ts:205`), not the DB `sequence` |
| Events retained | Yes, durably in `events` (the audit and history source) |
| Events lost? | **Yes, for live delivery**: anything published during a client's disconnection is missed and must be re-fetched by a snapshot. Process-local fan-out means **a second API instance would not see the first's events** (no Postgres `LISTEN/NOTIFY` or broker) |
| Replay or history | Only by `GET /events` query; no stream resume |
| Tenant scoping | Branch filter per session; one hospital per process |
| SSE security | Requires a session; no permission; no tenant check; a session terminated after connecting keeps receiving until disconnect |
| Missing | Public board stream; tracker stream; resume from sequence; multi-instance fan-out; a client wiring to any of it |

---

## 11. Security assessment

### 11.1 Controls in place (Verified, code)

| Control | Assessment |
|---|---|
| Password hashing | scrypt with per-user salt, parameters stored with the hash, rehash on login, timing-safe compare, dummy hash for unknown users (`passwords.ts`, `auth.ts:162-172`). **Good.** |
| Session tokens | 32 random bytes, SHA-256 hashed at rest, HttpOnly + SameSite=Lax + Secure (forced in production) (`tokens.ts`, `server.ts:102-122`, `config.ts:271-277`). Idle 12 h / absolute 24 h policy (ADR-042), checked per request. **Good.** |
| CSRF | Origin/Referer allow-list + double-submit token, enforced before body processing (`csrf.ts`, `server.ts:177-189`). **Good.** |
| CORS | Origin echo from allow-list with credentials; `Vary: Origin` (`http-security.ts:460-490`). **Good.** |
| Security headers | CSP `default-src 'none'`, XFO, nosniff, no-referrer, CORP, `Cache-Control: no-store`, HSTS when HTTPS. **Good.** |
| Login throttling | DB-backed per-username lockout + in-memory per-IP limit. **Good design**, with a proxy caveat (S-6). |
| SQL injection | All queries parameterised; `WhereBuilder` uses placeholders; `LIMIT` is a placeholder (`repositories.ts:404-410`). **No injection found.** |
| Error handling | 500s return a generic message and request ID; logs carry the detail (`server.ts:204-216`). Secrets redacted in logs (`logging.ts:359-367`). **Good.** |
| Secrets | All from the environment; startup refuses unsafe production config (no origins, insecure cookies). DB TLS verifies certificates by default (`database.ts:193-195`). `.env` is git-ignored. **No secrets committed** (checked `.env.example` and the file list). |
| Public endpoints | Board projection excludes identity; tracker uses a hashed long token; code path rate-limited with uniform errors. **Good shape.** |
| Body size | 64 KB limit (`server.ts:136`). |

### 11.2 Findings

No finding is rated **Critical** in the strict sense. Nothing is deployed with real patient data, and the backend is not yet reachable by any UI. The ratings below assume a pilot with real data.

**S-1 · High · Verified (code): routing bypasses workflow rules and the off-workflow permission, and falsifies the audit trail**

- **Where:** `apps/api/src/queue-routes.ts:329-367` (`followedWorkflow = body.followedWorkflow !== false`), `packages/domain/src/visit/visit.ts` `routeTo` (no workflow lookup), `apps/api/src/admission.ts:576-596` (comment claims "the aggregate… refuses a route the stages do not allow"; it does not). `resolveRoute` is used only by the browser demo (`clinic-store.ts:316`).
- **Harm:** any holder of `queue.route` can send a patient to any configured station, including disabled ones, or reopen a completed visit. They can omit `followedWorkflow` so the event says "routed onward" (within workflow). `queue.route_off_workflow` becomes meaningless, and the audit trail records an off-workflow move as compliant.
- **Fix:** on the server, load the workflow and call `resolveRoute` / `availableDestinations`; derive `followedWorkflow` server-side; require the off-workflow permission when it is false; refuse disabled stations. Add route tests.

**S-2 · High · Verified (code): patient identity exposed regardless of `visit.view_identity`**

- **Where:** `queue-routes.ts:73-112` (`state: visitToWire(visit)` includes `patient.name/hospitalNumber/phone`), served by `/stations/:id/queue` (`queue.call`), `/branches/:id/visits` (`reports.view`) and every action response. `visit.view_identity` is referenced nowhere outside `rbac.ts`.
- **Harm:** the Manager role, explicitly designed not to see identities (`rbac.ts:126-129`, ADR-025), receives full PII for every active visit. Data-minimisation and privacy commitments are not met.
- **Fix:** build staff projections per permission. Omit `patient` unless `visit.view_identity`. Consider a separate identity endpoint with audit-on-read.

**S-3 · High · Verified (code), not executed: unvalidated `priority` on admission can make a whole branch unreadable**

- **Where:** `queue-routes.ts:277-279` (`body.priority as never`), `Visit.create` does not validate priority, `visits.priority` has no CHECK, `mappers.ts:201-206` throws `MappingError` on read.
- **Harm:** one request with `priority:"x"` from any `visit.create` holder stores a row that makes `activeInBranch` throw. That takes down the board endpoint, branch list, tracker lookups and station queues for that branch (500) until someone fixes the row with SQL. The same pattern applies to other unchecked enum columns.
- **Fix:** validate against `PRIORITIES` at the API and in `Visit.create`; add CHECK constraints; consider tolerant reads that quarantine bad rows.

**S-4 · High · Verified (code): no concurrency control on visit updates (lost updates, double actions)**

- **Where:** `queue-routes.ts:156-195` (load, mutate, `save` upsert); `repositories.ts:218-298` (no version column, no `SELECT … FOR UPDATE`).
- **Harm:** two stations calling at once, or reception cancelling while a clinician starts service, both succeed. The last write wins on `visits` and `queue_entries`, and both events are recorded. State and audit disagree; a patient can be "called" by two stations. The idempotency layer does not protect against *different* concurrent requests.
- **Fix:** optimistic version column checked in `UPDATE … WHERE version = $n` (409 on mismatch), or row lock in the same transaction as load and save.

**S-5 · Medium (latent; High if a database is ever shared) · Verified (code): tenant and branch isolation depend on deployment topology, not on code**

- **Where:** §6.2 table. Unscoped `find`, `openAtStation`, `activeInBranch(caller branch)`, event `query`, deletes in `configuration-writer.ts:238-249`, `requireSignedIn` without a tenant check (`authorization.ts:432-436`), and route-level branch checks only when the session has a branch (`queue-routes.ts:163`).
- **Harm:** in a shared database, staff of one hospital could read PII, audit logs and events of another, act on their visits, or delete their unused configuration by UUID. Within a hospital, a branch-restricted user can read other branches' visits and events.
- **Fix:** add `hospital_id` to visit queries (join `branches`) or columns; scope every repository method by tenant; enforce session branch on list endpoints; add the tenant check to `requireSignedIn`; cross-tenant integration tests.

**S-6 · Medium · Verified (code): rate limits keyed on `request.ip` without `trustProxy`**

- **Where:** `server.ts:136` (`Fastify({ logger:false, bodyLimit })`, no `trustProxy`), `server.ts:224`, `public-routes.ts:319-321`.
- **Harm:** behind any reverse proxy or PaaS router, every client shares the proxy's address. Twenty failed or slow logins a minute hospital-wide lock everyone out of sign-in. Six tracker code lookups a minute **total** lock every patient out. Per-attacker limiting is lost, and an attacker can lock out all patients trivially.
- **Fix:** configure `trustProxy` for the known proxy hop; key by the client IP it supplies; consider per-branch tracker limits.

**S-7 · Medium · Verified (code): admission is not idempotent**

- **Where:** `queue-routes.ts:229-320` has no `guard` / `record`. The client sends an `Idempotency-Key` on every unsafe request (`api/client.ts:160`).
- **Harm:** a retried admission (lost response on wireless) creates a second visit, a second Journey Code and a second ticket. This is exactly the duplicate-ticket scenario the design aims to prevent.
- **Fix:** guard admission with the same idempotency mechanism (store the tracking token response carefully).

**S-8 · Medium · Verified (code): audit integrity defects in configuration writes**

- **Where:** `config-write-routes.ts`. PATCH or DELETE on an ID not in the configuration still validates, "persists" (no-op, or an unscoped DELETE) and writes an audit entry, returning 200. DELETE of a **system role** filters nothing, the SQL deletes nothing (`is_system = false`), yet records `config.role_deleted` "Role X deleted" and returns 200 (`config-write-routes.ts:825-853`). Separately, `ConfigurationService` uses default READ COMMITTED with no lock (`configuration-service.ts:212-259`, `pg.ts:144`), so two concurrent admins can each validate against a configuration the other is changing. ADR-054's guarantee is not enforced.
- **Harm:** the audit log records changes that did not happen, contrary to ADR-047's "a trail that records changes which did not happen is worse than no trail". There is also a race to an invalid configuration.
- **Fix:** 404 when the target is absent; 409 or 422 for system-role delete; `SELECT … FOR UPDATE` on the hospital row or an advisory lock per hospital inside the transaction.

**S-9 · Medium · Verified (code): visits never close, so tokens and codes never expire**

- **Where:** no caller of `Visit.close`. Lookups filter on `closed_at IS NULL` (`repositories.ts:144-150, 201-205`).
- **Harm:** a QR link or Journey Code from weeks ago still resolves to that visit's status. The "active" Journey Code space (30⁴ = 810,000; `journey-code.ts:18-21`) fills steadily, which raises collision retries and, at saturation, silently lengthens codes. Migration 005's comment ("six characters — around 810 million") is wrong. The enumeration surface for code lookup grows over time.
- **Fix:** close visits (end of day, or N hours after completion or cancellation); expire tokens.

**S-10 · Medium · Verified (code): configuration write bodies are not type-validated**

- **Where:** `config-write-routes.ts:58` (`patched` casts), validator assumes types (`hospital-config.ts:117, 137, 145`).
- **Harm:** wrong-typed fields produce 500s (TypeError) or persisted garbage (for example, `namePolicy` arbitrary strings, which are silently read back as `ticket_only`). Only administrators can do this, so impact is limited to availability and integrity.
- **Fix:** schema-validate request bodies (Fastify JSON schema) before `apply`.

**S-11 · Low · Verified (code): `queue.recall` and `queue.call` are interchangeable**

Both endpoints call `visit.call`, which chooses call or recall from the current status (`visit.ts` `call`; `queue-routes.ts:381-397`). Enforce the intended transition per endpoint.

**S-12 · Low · Verified (code): SSE authorization is coarse**

Any signed-in session receives the stream; a session with no branch receives every branch; termination is not re-checked during a connection (`server.ts:330-367`). Add a permission, a tenant check, and periodic re-validation or close on sign-out.

**S-13 · Low · Suspected: non-UUID path parameters cause 500s**

`/public/boards/board-lab` (the README's own example) or `/visits/abc/call` would raise a PostgreSQL cast error, which becomes 500 and an error log entry rather than 404. Validate IDs as UUIDs.

**S-14 · Low · Verified (code): role-set validation and permission strings**

- Lockout check is per role, not per user (`rbac.ts:155`).
- Unknown permission strings are accepted on write.
- Role and user management absent, so there is **no in-product recovery** if administrators lose access, and **no password reset** for anyone.

**S-15 · Informational · Verified (code): the browser demo authentication must never be used for real**

`LocalIdentityProvider` verifies PBKDF2 hashes in the browser. Accounts are seeded in every bundle, including the public board and tracker bundles (they import `bootstrap.ts`). If `VITE_SEED_PASSWORD` is set at build time, it is embedded in public JavaScript. This contradicts ADR-023's claim that public bundles ship no staff code.

**S-16 · Informational · Verified (code): smaller items**

- Health check does not test the database.
- Sign-in and sign-out and lockout events are not persisted to the server audit log (logs only).
- Every authenticated request writes the session row (`auth.ts:250-251`), which adds write load.
- PII is stored unencrypted at the column level.
- Login with a stale session cookie but no CSRF cookie would be refused by CSRF (Suspected edge case).

### 11.3 Patient-data exposure summary

| Surface | Exposes |
|---|---|
| Staff API responses | Full identity, to any role with `queue.call` or `reports.view` (S-2) |
| Staff SSE | Journey Code and ticket; no name |
| Board API | Tickets and status only |
| Tracker API | One visit's status, Journey Code, current ticket and station |
| Logs | No PII, except usernames on failed sign-in (by design) |
| Audit events | `visit.created` payload stores `patientName` and `hospitalNumber` in `events.payload` (`visit.ts` create, `visit-events.ts:515`). The audit table is therefore a second PII store, contrary to the stated intent in `visit-events.ts:457-463` ("never the patient's name"; true only of the summary) |

---

## 12. Testing and quality status

### 12.1 Why no check was run

- `node_modules` is **absent**. No dependencies are installed in the repository or a parent folder. There is no global `tsc` or `vitest`.
- Running any check needs `npm ci`, and the brief forbids installing packages.
- There is also **no PostgreSQL, `psql` or Docker** on this machine, so `verify:db` would skip or fail even with dependencies.

**Therefore none of these were executed:**

- typecheck
- unit tests
- integration tests
- database tests
- cross-tenant tests
- end-to-end tests
- `npm run verify`
- `npm run verify:db`
- production builds

**Pass and fail status is unknown.** No claim in this report rests on a test passing.

To run them later (not performed here):

```
npm ci
npm run verify
DATABASE_URL=postgres://… npm run verify:db -w @qman/api
```

### 12.2 Test inventory (static count)

- 49 test files
- **663 `it(...)` blocks** counted statically, plus `it.each` expansions in `packages/persistence/src/migrations.test.ts`
- The README's "420 tests" is out of date
- **Skipped by design:** all 44 tests in `apps/api/src/integration.test.ts` are `describe.skip` unless `DATABASE_URL` is set (`integration.test.ts:46-47`). They cover:
  - migrations (apply, idempotent re-run, checksum integrity)
  - seed
  - account, session, lockout and idempotency repositories
  - **concurrent ticket allocation**
  - configuration repository and writer
  - configuration lifecycle
  - board directory
  - admission against the database
  - transaction rollback
- No `.only`, `.todo` or other skips were found.

| Area | Files (it-count) |
|---|---|
| Domain | visit (18), visit-status (8), visit-wire (6), routing (16), station-queue (16), queue-number (15), reset-strategy (9), recovery (9), journey-code (7), hospital-config (11), rbac (9), analytics (14), telemetry (16 + 14), announcements (14), ticket-template (27), identity (24), patient-name (7) |
| Persistence | repositories (21), mappers (20), migrator (9), migrations (7+), pg (8) |
| API | auth (21), security (18), stream (18), config-crud (15), config (12), idempotency (11), config-write (11), http-security (9), config-routes (6), passwords (6), tokens (4), integration (44, skipped) |
| Web | DisplayBoard (22), ActivityExplorer (17), AdminPortal (16), runtime (16), PatientJourney (14), StationWorkspace (14), CommandCentre (14), client (13), printing (12), ReceptionDashboard (11), stream client (11), ManagerDashboard (9), configuration-api (8), visits-api (6) |

### 12.3 Coverage assessment (from reading the tests)

**Strong:**
- domain state machine, routing rules, queue ordering and numbering, configuration validation
- authentication and lockout
- CSRF, CORS and headers
- idempotency repository
- SSE projections (no Journey Code to boards, no names)
- config create/update/delete over fakes
- web components over demo stores
- API clients over fake fetch

**Weak or none:**
- **HTTP tests of queue routes** (`/call`, `/start`, `/route`, …): none (no test registers `registerQueueRoutes` except idempotency fingerprints)
- **public routes** (board, tracker): no tests
- **routing permission enforcement**: no test for `route_off_workflow`
- **`ConfigurationService` against PostgreSQL** (audit insert path): none, which is why the `branch_id NOT NULL` defect (D-1) can hide
- **concurrency on visits**: none
- **cross-tenant reads and writes of visits and events**: none
- **frontend ↔ API integration**: none
- **E2E or browser**: no Playwright or Cypress
- **accessibility**: none
- **performance and load**: none

---

## 13. Deployment and infrastructure status

### 13.1 Currently deployed

**Cannot be verified from the repository. No network checks were made.**

- `apps/web/vercel.json` and commits `ec9ec09` ("Pin the Vercel build command"), `c85e229`, `36f5ed6`, `cdbe190` strongly suggest the **web app has been deployed to Vercel** at some point.
- Any such deployment would be the **in-browser demo** with no backend.
- In a production build the random seed password is not printed (`bootstrap.ts:149`). A Vercel deployment therefore cannot be signed into unless `VITE_SEED_PASSWORD` was set at build time, which would embed it in the public bundle.
- **No evidence of a deployed API or database.**

### 13.2 Deployment-ready but not deployed

- **API:** production-minded configuration (refuses unsafe production settings, auto-migrates, graceful shutdown, structured logs, DB TLS verification). **No container image, Dockerfile, compose file or PaaS manifest.**
- **Web:** Vite build of three entries; Vercel config.

### 13.3 Intended deployment architecture (from `.env.example`, ADRs, HARDENING §5)

- one API process per hospital (`QMAN_HOSPITAL_ID`)
- any PostgreSQL 13+ (managed or on-premise)
- web served from origins listed in `QMAN_ALLOWED_ORIGINS`
- **all three surfaces behind one origin** (HARDENING §5)

That last point is effectively **required**, not optional, for two reasons:

- the client reads the CSRF cookie from `document.cookie` (`api/client.ts:74-80, 155-158`), which only works if the API sets cookies on the same host as the page
- `SameSite=Lax` session cookies are not sent on cross-site fetches

A Vercel-hosted web app on a different site from the API would not work.

### 13.4 Still required (not performed)

| Item | Status |
|---|---|
| Domain and DNS | Not configured in repo |
| API hosting | Choose a host; write a Dockerfile or manifest; reverse proxy with SSE buffering off (`X-Accel-Buffering` is set) and **`trustProxy`** |
| Frontend hosting | Same origin as the API (path-based `/api` proxy), or a single server for both |
| Database | Provision PostgreSQL 13+, TLS, backups with **WAL/PITR** (RPO ≤ 5 min target, HARDENING §1.1), restore drill |
| Environment variables | `DATABASE_URL`, `QMAN_HOSPITAL_ID`, `QMAN_ALLOWED_ORIGINS`, `NODE_ENV=production`, optional `DATABASE_SSL*`, `PORT`, `LOG_LEVEL` |
| Secrets | DB credentials only; no app signing keys are needed |
| Platform bootstrap or organization provisioning | **No tooling.** Needs a script to insert hospital, default branch, system roles (UUIDs), first admin user (scrypt hash), default ticket template and settings, stations and a workflow |
| SSL/TLS | At the proxy; `QMAN_SECURE_COOKIES` forced on |
| Jobs | Visit closure, pruning of `idempotency_keys` and `login_throttle`, ticket `reconcileSeries` after restore (no runner exists) |
| Production smoke test | Not possible until the web app uses the API |

---

## 14. What is currently being built

| Item | Evidence | Status |
|---|---|---|
| **Git state** | `main` @ `5fa1f4f`, clean, in sync with origin, single branch, no stashes found | |
| **Uncommitted changes** | None | |
| **Last activity** | 2026-08-05. No commits for about 3.5 months | **Not actively being worked on** |
| **TODO, FIXME, HACK markers** | None in code, SQL or Markdown | |
| **Frontend ↔ API integration** | The last four commits add the transport (`0af18de`), config API client (`dd7f58e`), visit wire contract (`3454adb`) and visit API client (`5fa1f4f`). None is imported by runtime code | **The unfinished work in progress.** Done: clients and tests. Remaining: replace `clinicStore`, `configStore`, `authStore` and parts of `operationsStore` with API-backed equivalents; SSE wiring; admission UI; error UX; remove demo seeding from production bundles. Depends on the API being run somewhere. Blocker: none technical |
| **Admission UI** | Button without handler (`ReceptionDashboard.tsx:123`) | Unfinished |
| **Session admin API** | `GET /sessions` stub | Unfinished (placeholder) |
| **User management** | UI placeholder (`RolesSection.tsx:132-143`) | Deferred |
| **Escalate API, export, announcements persistence, branch admin** | Domain or UI exist, no API | Unfinished |
| **Notification delivery (SMS, WhatsApp, email, push)** | Channels modelled, table `notification_attempts` unused | Planned |
| **Visit closure and retention** | `Visit.close` unused | Missing |
| **Ops jobs (prune, reconcile)** | Repository methods without callers | Missing |
| **Public board stream** | Audience projection built, no route | Unfinished |
| **Docs** | README, HARDENING and DECISIONS "Open items" describe an earlier state | Stale |

---

## 15. Future enhancements

> These are recommendations, not facts. Complexity: L = low, M = medium, H = high.

### 15.1 V1 completion (before the first pilot)

| Feature | Problem solved | Value | Cx | Dependencies | Priority | Fits vision |
|---|---|---|---|---|---|---|
| Wire web to API (auth, config, visits, SSE) | Product does not work across machines | Essential | H | API hosted | P0 | Yes |
| Admission form (name, hospital number, phone, priority, workflow) + ticket print with **tracking token** QR | Cannot register patients | Essential | M | Wiring | P0 | Yes |
| Server-side route validation (S-1), PII projection by permission (S-2), input validation (S-3, S-10), optimistic concurrency (S-4), idempotent admission (S-7), `branch_id` audit fix (D-1) | Correctness and safety | Essential | M | none | P0 | Yes |
| Public board polling or stream + tracker position, ahead and estimate API | Board and tracker need server data | Essential | M | Wiring | P0 | Yes |
| Provisioning CLI (hospital, branch, roles, first admin) + user management (create, disable, reset password, role, branch) | Cannot onboard a hospital or staff | Essential | M | none | P0 | Yes |
| Visit closure job + retention policy | Unbounded growth, perpetual tokens | High | L | none | P0 | Yes |
| `trustProxy`, health with DB check, deployment manifest, single-origin hosting, backups/PITR, restore drill | Operability | Essential | M | Host choice | P0 | Yes |
| Hospital-timezone resets (D-9) | Wrong daily rollover | High | L | none | P1 | Yes |
| E2E happy path + exception paths test suite (Playwright) | Regressions | High | M | Wiring | P1 | Yes |

### 15.2 V1.1 (shortly after the pilot)

| Feature | Value | Cx | Notes |
|---|---|---|---|
| Visit search (code, name, hospital number), reprint, cancel UI | High | L | Runbook depends on it |
| Escalate and priority API + audit | High | L | Domain ready |
| Session admin API (list, terminate, sign out everywhere) | Medium | L | Domain and UI ready |
| Persisted announcement settings | Medium | L | |
| Daily and weekly reports + CSV export | High | M | Uses `events` and queue entries |
| Browser and PWA push for "your turn" | High | M | Needs push service and VAPID |
| SMS notifications (pluggable provider) | High in many markets | M | Cost, consent, opt-out; uses `notification_attempts` |
| Device heartbeat endpoint (boards check in) for the Command Centre | Medium | L | |
| Accessibility audit fixes | High | M | |

### 15.3 V2

| Feature | Value | Cx | Fit and risk |
|---|---|---|---|
| True multi-tenant hosting (subdomain tenant resolution, tenant-scoped queries, platform admin portal, org provisioning, suspension) | High for SaaS | H | Requires S-5 remediation first |
| Multi-branch operations (branch admin, per-branch dashboards, cross-branch transfers) | Medium–High | M | Schema largely ready |
| WhatsApp notifications and two-way "I'm on my way / delay" | High (regional) | M–H | Template approval, cost |
| Appointments and pre-booked arrivals feeding queues | High | H | New aggregate; fits "flow" |
| HMS integration (HL7/FHIR or vendor APIs: patient lookup, admit events) | High | H | Per-HMS adapters |
| Staff scheduling and rostering (who staffs which station) | Medium | M–H | Feeds presence and SLA |
| Advanced analytics (historic trends, forecasting arrivals and staffing) | Medium–High | M | Event log is a good base |
| Patient self check-in kiosk | Medium | M | Needs a kiosk role and device trust |
| Native mobile apps | Low–Medium | H | PWA likely sufficient first |

### 15.4 Long-term vision

| Feature | Assessment |
|---|---|
| AI-assisted operations (predict bottlenecks, suggest re-routing or staffing, natural-language ops queries) | Fits well on top of the event log. Medium–high complexity. Needs data volume first |
| Laboratory and pharmacy integration (status-driven routing, for example "results ready" → reroute) | Fits as integrations, not as building LIS or pharmacy systems |
| Billing, payments, insurance | **Does not fit.** It is the HMS's domain, with high regulatory risk. Integrate status only ("payment cleared" as a routing gate) |
| Electronic medical records, clinical decision support | **Does not fit.** It contradicts the core positioning ("QMan holds no clinical data") and brings major regulatory burden |
| Patient registration and profiles | Only minimal, as a cache of HMS identity. Do not become the system of record |

---

## 16. Known issues, risks and technical debt

Security findings S-1…S-16 are in §11 and are not repeated here.

### 16.1 Verified defects (code)

| ID | Defect | Where |
|---|---|---|
| D-1 | Config writes insert audit events with `branch_id = session.branchId`; `events.branch_id` is `NOT NULL`, so an admin session without a branch would fail every config write with 500 | `configuration-service.ts:335`, `001_initial.sql:310` |
| D-2 | Frontend not connected to backend; every tab is an isolated demo clinic | `bootstrap.ts`, `display.tsx:5`, `track.tsx:5` |
| D-3 | Lost updates on concurrent visit actions (S-4) | `queue-routes.ts:156-195` |
| D-4 | "Create Visit" and header "Call Next" buttons have no handlers; reception stats show hard-coded deltas | `ReceptionDashboard.tsx:123,133,141`; `App.tsx:92` |
| D-5 | Station workspace attributes every action to `user-doctor` | `clinic-store.ts:412`, `StationWorkspace.tsx:91-142` |
| D-6 | Admission errors for unknown workflow or station are 500, not 4xx | `admission.ts:489-491, 536-544` |
| D-7 | Visits never closed: unbounded "active" sets, perpetual tracking, Journey Code space filling | no caller of `Visit.close` |
| D-8 | A refused route still consumes a ticket number (allocated before validation) | `queue-routes.ts:356-366` |
| D-9 | Queue reset periods use server-local time, not the hospital's timezone | `queue-number.ts:64-88` |
| D-10 | Public board returns `room: null` always and ignores `waitingToShow` / `showRoom` | `public-routes.ts:353` |
| D-11 | `GET /stations/:id/queue` is unordered (no `ORDER BY`); clients must order | `repositories.ts:157-168` |
| D-12 | The printed ticket QR encodes `…/track.html?code=<JourneyCode>`, not the server tracking token. The tracker would therefore use the rate-limited, guessable code path rather than the token | `packages/domain/src/printing/ticket-template.ts:241-248` vs `public-routes.ts:368` |
| D-13 | Migration 005 comment overstates the Journey Code space (810 million vs 810 thousand) | `005_tracking_tokens.sql:7` |
| D-14 | `config-fixtures.ts` (test fakes) is compiled into the API `dist` | `apps/api/tsconfig.json` excludes only `*.test.ts` |

### 16.2 Technical debt and architectural limitations

- Two parallel implementations of the clinic (browser stores versus API). The browser one is the only one with a UI, and the longer it lives the more behaviour diverges (for example, routing validation exists only in the browser).
- Process-local SSE fan-out. Only one API instance is possible without a broker or `LISTEN/NOTIFY`.
- No server-side projections for queue position and wait. Every surface must re-implement or rehydrate the domain (`describeVisit` ships aggregate state for that reason).
- Configuration re-loaded from the database on every admission and route (7 queries). This is fine at pilot scale, but there is no cache.
- No job runner (closure, pruning, reconciliation).
- No per-station ticket template, announcement persistence or branch administration.

### 16.3 Operational risks

- No backup, restore or PITR implementation in the repo. RPO and RTO are not demonstrated (HARDENING §1.1, unchecked).
- No monitoring beyond logs; health check is shallow.
- Provisioning and account recovery require a database administrator.
- Rate limiting behind a proxy (S-6) can lock out a whole hospital's patients.

### 16.4 UX issues

§9.3.

### 16.5 External dependencies

- PostgreSQL provider
- hosting
- browser speech-synthesis voices (board)
- thermal printers (untested on hardware)
- future SMS, WhatsApp and push providers

### 16.6 Documentation drift (verified)

- `README.md`:
  - "420 tests", while the static count is now 663
  - "Not yet verified against a real database", while an integration suite exists and migration 006 and ADR-051 report real-database fixes
  - The "events are the backbone" and three-apps descriptions omit that the apps are not wired
  - Bundle sizes (~7 kB board, ~10 kB tracker) are doubtful, since those bundles import the full demo bootstrap (not measured)
- `docs/HARDENING.md` §2 says auth is browser-only and permissions UI-only; both now exist server-side, but the UI does not use them.
- `docs/DECISIONS.md` "Open items" lists QR, the Command Centre and several screens as unbuilt; they are built (in demo form).
- `admission.ts:576-581` comment says the aggregate enforces workflow routing; it does not.
- `visit-events.ts:457-463` says the log never carries the patient's name; `visit.created` payload does.

### 16.7 Needs further verification (requires running systems)

- that the full test suite passes
- that migrations apply cleanly on PostgreSQL 13–17
- concurrent ticket allocation
- SSE through the chosen proxy
- PWA on iOS and Android
- printing on hardware
- speech voices
- memory over long board uptime
- bundle sizes
- behaviour of non-UUID IDs (S-13)

---

## 17. Product assessment

**What it can do today.**

- As a **demo**, it shows a convincing, well-designed single-tab simulation of hospital patient flow: reception overview, station workspaces with keyboard workflow, manager analytics, Command Centre, activity and audit explorer, a deep admin portal, printable tickets with QR, a display board with voice, and a patient tracker PWA.
- As a **backend**, it offers a serious, security-conscious API that can authenticate staff, hold configuration, admit patients, move them through queues, and publish events.
- The two halves are not connected, so it **cannot run a real clinic today**.

**What category it is.** Architecturally it is a **clinic or hospital patient-flow (workflow) system**: multi-station journeys, configurable pathways, SLAs, operations telemetry. That is more than a queue system. It is **not** yet a hospital operations platform: no appointments, staffing, integrations or multi-tenant hosting.

**Maturity.** Late prototype or pre-alpha as a product. The domain layer is beta quality. The backend is alpha (feature-shaped, not wired, untested end-to-end, several correctness gaps). There is no deployment pipeline. Estimated distance to a supervised single-clinic pilot is the full V1 completion list in §15.1.

**Strongest parts.**

1. The domain model: transition table, routing engine, ticket numbering and recovery, privacy policy, configuration validation, and heavy tests.
2. Security engineering of the HTTP edge: auth, sessions, CSRF, headers, lockout, idempotency, startup safety.
3. Product thinking around clinical failure modes: connection honesty, paper fallback runbook, never reissuing ticket numbers.
4. UI design quality and breadth.

**Weakest parts.**

1. No integration between frontend and backend.
2. Server-side business-rule enforcement is thinner than the domain suggests (routing, identity, priority, concurrency).
3. No onboarding: provisioning, users, password reset.
4. No deployment, operations jobs or backups.
5. Documentation that overstates readiness.

**What blocks a real organization from using it.** In order:

1. the web app cannot talk to the server
2. patients cannot be admitted in the UI
3. there is no way to create the hospital and staff accounts
4. no hosting, backups or monitoring
5. the server-side correctness and privacy gaps S-1 to S-4 and D-1

**What would make it competitive.**

- reliable cross-device real-time (board and tracker)
- SMS or WhatsApp "your turn" alerts (high value in many markets)
- very fast onboarding (a configured clinic in under an hour)
- simple reporting (daily waits, SLA breaches, throughput)
- later, HMS integration

**What should not be built yet.**

- multi-tenant SaaS and platform portal
- AI features
- appointments
- billing, EMR, clinical decision support
- native apps
- more admin depth or more dashboards

All of these widen the surface while the core loop is not yet real.

**Smartest next step.** Make one real clinic loop work end-to-end on one server:

1. Fix the server-side issues D-1, S-1, S-2, S-3, S-4 and S-7.
2. Add a provisioning CLI and minimal user management.
3. Wire the staff app's authentication, configuration and visits to the API, including an admission form, and wire SSE.
4. Make the board and tracker read the public endpoints (poll first, stream later).
5. Deploy behind one origin with a database and backups.

Then prove the loop with an E2E test and a walkthrough.

---

## 18. Recommended roadmap

**Immediate** (correctness and safety, about 1–2 weeks of focused work; estimate, not fact)

1. Install dependencies and run `npm run verify` and `verify:db` on a real PostgreSQL. Record actual results. *(Everything else assumes a green baseline.)*
2. Fix D-1 (audit `branch_id`), S-3 (priority and enum validation + CHECK constraints), S-1 (server-side routing), S-2 (PII by permission), S-4 (optimistic concurrency), S-7 (idempotent admission), S-6 (`trustProxy`).
3. Add HTTP tests for queue and public routes, and cross-tenant and branch tests.

**Before the first pilot**

4. Provisioning CLI (hospital, branch, system roles, first admin) and user management API + UI (create, disable, role, branch, reset password). Real session admin endpoints.
5. Wire the staff app to the API (auth, config, visits, SSE); admission form; error UX; remove demo seeding from production bundles; actor attribution from the session.
6. Board and tracker on public endpoints (poll at about 5–10 s; tracker position and estimate API); QR with tracking token.
7. Visit closure job, pruning jobs, hospital-timezone resets, health check with DB.
8. Deployment: container or manifest, single origin, TLS, managed PostgreSQL with PITR, restore drill (RPO and RTO measured), logging and alerting.
9. E2E suite (Playwright) for the full journey including skip, recall, route, reopen and cancel; accessibility pass on reception, station and tracker; printer and QR hardware test.
10. Update README, HARDENING and DECISIONS to the real state.

*Why this order:* steps 4–6 depend on the API being correct (2–3); deployment (8) depends on wiring (5–6); the pilot depends on E2E proof and operations readiness (9).

**Pilot phase** (one clinic, supervised)

11. Run the runbook rehearsals (paper fallback, reconciliation with `reconcileSeries` / `advanceTo` exposed through an admin action).
12. Measure real waits and SLA; gather staff feedback; fix friction.
13. Add visit search, reprint, cancel UI, escalate API, session termination.

**After the pilot / V1.1**

14. Reports and CSV export; persisted announcements; device heartbeat endpoint for the Command Centre.
15. Notifications: browser push first, then SMS via a pluggable provider, recording `notification_attempts`.

**V2**

16. Tenant-scoped queries everywhere, then hosted multi-tenancy (subdomain resolution, platform admin, org provisioning and suspension).
17. Multi-branch operations, WhatsApp, appointments, HMS integration, staff scheduling, analytics.

**Long-term**

18. Predictive operations and AI assistance on the event history; integration-driven routing (lab or pharmacy status). Keep billing, EMR and decision support out of scope.

---

## 19. Final executive summary

**Identity.** QMan (`github.com/obende-m/QMan`, private monorepo, TypeScript). It is a patient-flow and operations layer that sits above a hospital's HMS. It manages visits moving through stations: tickets, calls, routing, boards, patient tracking, operational dashboards.

**Architecture.**

- npm-workspace monorepo
- `@qman/domain`: pure engine with visit state machine, routing, queues, numbering, configuration validation, RBAC, analytics and telemetry
- `@qman/persistence`: hand-written PostgreSQL SQL, 6 migrations, migrator
- `@qman/api`: Fastify 5, scrypt auth, cookie sessions, CSRF, RBAC, idempotency, config create/update/delete, admission and queue endpoints, public board and tracker endpoints, SSE
- `apps/web`: React/Vite/Tailwind; three builds (staff, display board, patient tracker PWA)
- One API process per hospital (`QMAN_HOSPITAL_ID`)

**Complete.**

- Domain engine (heavily tested)
- Server security edge
- Configuration create/update/delete API with validation and transactional audit
- Queue and admission API
- Rich demo UI for every screen

**Incomplete.**

- **The web app is not connected to the API.** All screens run on per-tab in-memory demo data. API clients exist but only tests use them.
- No admission UI.
- No user management, provisioning, password reset or platform admin.
- No escalate, export, sessions admin, branches or announcements APIs.
- No public board stream.
- Visits are never closed.
- No jobs.
- No deployment manifests.

**Being developed.** The last commits (2026-08-05) were building the frontend's API layer. No work since; the tree is clean.

**Key risks (verified by reading code, not executed).**

- **D-1:** config writes fail when the admin session has no branch (`events.branch_id NOT NULL`).
- **S-1:** server routing ignores the workflow and trusts the client's `followedWorkflow`.
- **S-2:** patient PII returned to roles without `visit.view_identity` (including Manager).
- **S-3:** an unvalidated priority can make a branch unreadable.
- **S-4:** no concurrency control on visit updates.
- **S-5:** tenant isolation relies on one database per hospital.
- **S-6:** rate limits break behind a proxy.
- **S-7:** admission not idempotent.

There is no multi-tenant platform.

**Deployment.** No API or database deployment exists in the repo. The web app has Vercel config; a past Vercel demo deployment is likely, but its status was not verified.

**Git.** `main` @ `5fa1f4f`, clean, synced with `origin/main`, 27 commits, inactive since 2026-08-05.

**Tests.** 49 files and about 663 test cases (static count). The 44 PostgreSQL integration tests are skipped without `DATABASE_URL`. **Nothing was run:** no `node_modules`, installation not permitted, no PostgreSQL available. Pass and fail status is unknown. There are no HTTP tests of queue or public routes, and no E2E.

**Recommended next step.**

1. Install, run `verify` and `verify:db` to establish a baseline.
2. Fix D-1 and S-1…S-7.
3. Add provisioning and user management.
4. Wire the staff app, board and tracker to the API.
5. Deploy one hospital behind a single origin with backups.

Prove a full patient journey end-to-end before adding any new feature.
