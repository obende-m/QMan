# QMan

**Every Journey. Every Queue. In Sync.**

An intelligent Patient Flow & Operations Platform. QMan sits *above* a hospital's
existing HMS as an operational layer: the HMS owns registration, billing and
medical records; QMan owns how patients move.

## Status

All Version 1 modules are built and tested. 420 tests, `npm run verify` green.

| Layer | State |
| --- | --- |
| `@qman/domain` — visits, workflows, queues, analytics, config, telemetry | ✅ 165 tests |
| Staff app — Reception + Priority Patients | ✅ 11 tests |
| Staff app — Station Workspace (every station type) | ✅ 14 tests |
| Staff app — Manager Dashboard | ✅ 9 tests |
| Staff app — Operational Command Centre | ✅ 14 tests |
| Staff app — Administration Portal | ✅ 14 tests |
| Display Board app — configurable, live signage | ✅ 16 tests |
| Patient Tracker app — journey tracking, no login | ✅ 10 tests |
| Event bus, audit trail, announcement rendering | ✅ built |
| Voice announcements + browser notifications | ✅ 16 tests |
| Patient Tracker installable as a PWA | ✅ built |
| QR codes + configurable ticket printing | ✅ 41 tests |
| Authentication, sessions, RBAC gating | ✅ 24 tests |
| `@qman/persistence` — schema, mappers, repositories | ✅ 41 tests |
| Activity & Audit Explorer | ✅ 17 tests |

**Version 1 is feature complete.** The objective is no longer *build QMan* but
**prepare QMan for clinical use** — reliability, security, performance,
usability, deployment, documentation, training, operational readiness.
See [docs/HARDENING.md](docs/HARDENING.md) and the hospital-facing
[docs/RUNBOOK.md](docs/RUNBOOK.md).

> **Not yet verified against a real database.** The schema, mappers and
> repository SQL are unit-tested against a recording fake; no Postgres exists in
> this environment. See the open items in [docs/DECISIONS.md](docs/DECISIONS.md).

> **Development accounts.** `npm run dev` seeds three users — `ifeoma`
> (reception), `adams` (clinician) and `admin` — and prints a freshly generated
> password to the browser console on start. Set `VITE_SEED_PASSWORD` in
> `.env.local` for a stable one; see `.env.example`.

### Events are the backbone

One clinical action fans out to everything downstream, and the queue engine
knows about none of it (ADR-028):

```
clinic.callNext()
   └─ VisitCalled ──> event bus ──┬── announcements   (what to say)
                                  ├── notifications   (delivery + outcome)
                                  ├── audit log       (what happened)
                                  ├── presence        (who is at their post)
                                  └── every open screen
```

### Configured, not coded

Stations, queue-number templates, reset strategies, SLAs, workflows, display
boards, privacy policy and roles are all data, validated in the domain and
edited in the Administration Portal (ADR-026). Adding a Dialysis station is a
row, not a release.

### Three applications, one engine

Separate builds, not routes — so the public surfaces ship none of the staff code
that can mutate clinical state (ADR-023).

| App | Entry | Bundle | Who loads it |
| --- | --- | --- | --- |
| Staff | `/` | ~130 kB | Reception, clinicians, managers |
| Display Board | `/display.html?board=board-lab` | ~7 kB | Waiting-room screens |
| Patient Tracker | `/track.html?code=QM-8F4K` | ~10 kB | Patients, via QR |

### Two identities, deliberately

| | Journey Code | Queue number | Position |
| --- | --- | --- | --- |
| Example | `QM-8F4K` | `A-064` | `#2` |
| Scope | the whole visit | one station | one station, one moment |
| Lifetime | permanent | fixed for that stop | changes as the queue moves |
| Stored? | yes | yes, as issued | **no** — always derived |
| Used for | tracking, QR, search, audit | calling the patient forward | "how many ahead of me" |

Numbering is a per-station template (`A-{n:3}`, `{station}-{n:3}`, `{journey}`)
with a per-station reset strategy (daily / weekly / monthly / never / manual),
so both are configuration. See ADR-016 to ADR-018, ADR-020 and ADR-021.

## Getting started

```bash
npm install
npm run dev        # web app at http://localhost:5173
npm run verify     # typecheck + build + test (420 tests)
```

Other scripts: `npm test`, `npm run test:watch`, `npm run build`.

> Run the web app through `npm run dev` or `npm run build -w @qman/web`.
> Invoking Vite directly from the repo root is not supported — PostCSS config
> discovery does not follow Vite's `root`, and the app comes out unstyled.

## Architecture

QMan is three products sharing one engine — the Operations Platform, the Patient
Experience, and Operations Intelligence. All three consume the same `Visit`
stream, which is what lets analytics ship without touching visit management.

```
apps/web ───────────┐
@qman/persistence ──┼──> @qman/domain  (no dependencies: no HTTP, no DB, no clock)
                    │
                    └──> ports: Clock, IdGenerator, RandomSource, SqlExecutor
```

### The one idea

**The Visit is the source of truth. Queues are a projection of where visits
currently are.** A visit owns many queue entries; a queue entry is one visit's
stop at one station. Adding a new station — Dialysis, MRI, ECG — is
configuration: rows, not tables, and no code.

### Package layout

```
packages/domain/src/
  shared/     Clock, branded ids, domain errors
  events/     the event envelope and every visit event
  journey/    Journey Code generation, parsing, patient-input repair
  workflow/   workflow definitions, validation, the routing engine
  visit/      the Visit aggregate, its state machine, queue entries, priority
  queue/      station worklists, ordering, wait estimation
  testing/    deterministic fixtures

apps/web/src/
  design/     tokens transcribed from design/qman_clinical_flow/DESIGN.md
  components/ ui primitives + the app shell
  features/   one folder per screen
  data/       demo clinic, built by driving the real domain engine
```

### Design

`design/` holds the visual reference: a screenshot per screen and `DESIGN.md`,
which is the source of truth for the visual language. Its tokens are transcribed
once into `apps/web/src/design/tokens.ts`; nothing else hardcodes a colour or
type step.

The demo clinic in `apps/web/src/data/` is not fixture JSON. Every visit is
produced by calling `Visit.create`, `enqueue`, `call`, `startService` and
`routeTo` on the real aggregate, so the screens are wired to the same state
machine production will use — an illegal transition fails the build rather than
being papered over by convenient mock data.

Issues found in the source designs (a clipped chip, an empty chart, two
conflicting code schemes, an ordering that can hide an emergency patient) are
listed at the end of [docs/DECISIONS.md](docs/DECISIONS.md).

Significant decisions — and the places where the implementation sharpens the
source documents — are recorded in [docs/DECISIONS.md](docs/DECISIONS.md).

## Design docs

The PRD, SAD and ERD are the starting point, not immutable spec. Where
implementation revealed a better answer, the decision and its reasoning are in
the ADR log. Three worth knowing before reading the code:

- **ADR-003** — routing is atomic, so a visit is never between queues.
- **ADR-005** — one transition table is the sole authority on visit state,
  consulted before anything else.
- **ADR-006** — VIP never outranks clinical urgency.
