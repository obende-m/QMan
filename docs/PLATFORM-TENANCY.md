# Multi-Tenant Platform — Migration and Design

How QMan becomes a platform that hosts many hospitals, with a platform
administration layer that belongs to QMan rather than to any of them.

This document is the design. Nothing in it is implemented yet. It exists to be
argued with before code is written.

---

## 1. What the inspection found

Three findings shape everything below, and two of them are good news.

**The persistence layer is already multi-tenant.** Every repository method takes
its tenant explicitly: `ConfigurationRepository.load(hospitalId)`,
`ConfigurationWriter.createRole(tx, hospitalId, role, at)`,
`VisitRepository.activeInBranch(branchId)`. No repository reads a global
"current hospital". The schema agrees — `hospital_id` on everything the hospital
owns, `branch_id` below it, `UNIQUE (hospital_id, code)` on branches,
`UNIQUE (hospital_id, key)` on roles, `users_hospital_username_key` on
`(hospital_id, lower(username))`. The database was designed for this from the
first migration.

**The single-tenant assumption lives in exactly one expression.**
[index.ts:63](../apps/api/src/index.ts#L63):

```ts
resolveHospital: () => config.hospitalId,
```

Read from `QMAN_HOSPITAL_ID`, passed to the guards and to both idempotency
scopes. Three call sites, one environment variable. That is the whole of the
single-tenant deployment model.

**Public surfaces are already tenant-agnostic.** `/api/v1/public/boards/:boardId`
resolves the board to its branch server-side; tracking resolves by opaque token,
or by `branchId` plus Journey Code. All identifiers are UUIDs the client cannot
guess and cannot use to name a tenant it was not given. These routes need no
tenant selector and are unaffected by this migration, except for suspension
(§6.4).

So this is not a rewrite. It is a new administration layer beside the existing
one, plus replacing one hardcoded expression with a derivation.

### 1.1 The load-bearing control that this migration can silently kill

[authorization.ts:89](../apps/api/src/authorization.ts#L84-L101) currently reads:

```ts
const hospitalId = deps.resolveHospital(request);
if (authenticated.hospitalId !== hospitalId) { /* refuse, and alarm */ }
```

Two different quantities are being compared. `resolveHospital(request)` is *the
tenant the request is addressing*. `authenticated.hospitalId` is *the tenant the
session belongs to*. The check catches a valid session reaching another
hospital's data.

The obvious multi-tenant move — `resolveHospital: (req) => req.session.hospitalId`
— makes the comparison `x === x`. The code still runs, the tests still pass, and
the control is gone. This is the single most important thing to get right in
this migration, and §6 is about not doing that.

---

## 2. New entities

Platform administration gets its own tables rather than columns on the existing
ones. The reason is a constraint the user set: platform administration must
remain completely separate from organization administration, and tenancy must
not weaken.

`users.hospital_id` is `NOT NULL`. A platform user is a member of no hospital.
Making that column nullable to accommodate them would mean every tenant-scoped
query in the system — all of which currently rely on it — acquires a `NULL` case,
and one forgotten `WHERE hospital_id = $1` becomes a cross-tenant leak instead of
a no-op. Separate tables keep `NOT NULL` intact and make the leak
unrepresentable: there is no join from `platform_users` to a hospital's data.

### `platform_users`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `username` | text | globally unique, case-insensitively, via expression index |
| `display_name` | text | |
| `password_hash`, `password_salt` | text | scrypt, same `passwords.ts` |
| `role` | text | closed set; `super_admin` only in V1 |
| `enabled` | boolean | |
| `created_at`, `updated_at` | timestamptz | |

No `hospital_id`, and no column that could ever hold one.

### `platform_sessions` and `platform_session_tokens`

Mirrors `sessions` and its token index, referencing `platform_users`. Separate
tables, not a `kind` column on `sessions`, so a platform token can never resolve
through the organization session path or the reverse. The token format, hashing
(SHA-256) and opacity are unchanged — `tokens.ts` is reused as-is.

### `platform_events`

The platform audit log. `events.hospital_id` is `NOT NULL` and platform actions
have no hospital, so they cannot live there. Columns mirror `events` — monotonic
`sequence`, `type`, `occurred_at`, `summary`, `payload`, `correlation_id` — with:

- `actor_id` → `platform_users(id)`, `ON DELETE SET NULL`
- `target_hospital_id` → `hospitals(id)`, **nullable**, `ON DELETE SET NULL`

Nullable and `SET NULL` on purpose: "who deleted this organization" must survive
the organization. `ON DELETE CASCADE` here would erase the audit trail of the
exact action most worth auditing.

### `platform_login_throttle`

`login_throttle` is keyed `(hospital_id, username_key)` with a `NOT NULL` FK.
Platform login has no hospital. Keyed by `username_key` alone. The sliding-window
IP rate limiter in front of it is shared code and needs no change.

---

## 3. Existing entities that change

Exactly one table changes shape.

### `hospitals` gains a lifecycle

| Column | Type | Notes |
|---|---|---|
| `status` | text NOT NULL DEFAULT `'active'` | `active` \| `suspended` |
| `suspended_at` | timestamptz | |
| `suspended_reason` | text | |

Suspension is reversible and non-destructive: no rows are deleted, no
configuration is touched. A suspended organization's data is intact and its
staff cannot sign in.

**Nothing else changes.** `users`, `roles`, `branches`, `stations`, `workflows`,
`visits`, `queue_entries`, `events`, `idempotency_keys` are untouched. Tenancy is
not weakened because tenancy is not modified.

---

## 4. How authentication changes

Two authentication systems that share implementation and share no state.

|  | Organization | Platform |
|---|---|---|
| Endpoint | `POST /api/v1/auth/login` | `POST /api/v1/platform/auth/login` |
| Credentials | org code + username + password | username + password |
| Cookie | `qman_session` | `qman_platform_session` |
| Session table | `sessions` | `platform_sessions` |
| Throttle | `login_throttle` (hospital, username) | `platform_login_throttle` (username) |
| Resolves to | `AuthenticatedUser` with `hospitalId` | `PlatformUser`, no hospital |

Distinct cookie names are the mechanism, not a convention. A platform token
presented as `qman_session` resolves against `sessions` and finds nothing;
`readSessionToken` reads one name and the platform guard reads the other. There
is no code path where one is accepted for the other.

**Organization selection at login.** `hospitals.code` is already
`NOT NULL UNIQUE` globally — a natural tenant selector that exists today. Sign-in
becomes organization code plus username plus password. The alternative,
per-tenant subdomains, is deferred: it multiplies DNS, certificate and
`QMAN_ALLOWED_ORIGINS` management per organization for no security gain, and the
code field can be replaced by a subdomain later without a schema change.

Failure messages stay uniform. An unknown organization code, an unknown username
and a wrong password must be indistinguishable, or the login form becomes an
organization-enumeration oracle for a platform whose customer list is
commercially sensitive.

**CSRF, cookies and sessions are unchanged.** Same double-submit token, same
`SameSite=Lax`, same `HttpOnly` and `Secure`, same opaque DB-backed tokens
storing only hashes.

---

## 5. How RBAC changes

Organization permissions and platform permissions are two closed sets that never
mix.

`roles.permissions` is `text[]`, validated against the domain's
`ALL_PERMISSIONS`. If platform capabilities were added to that enum, an
organization administrator with `admin.users` could mint a role granting
`platform.organizations.create` and escalate out of their own tenant. That is the
"do not weaken RBAC" constraint, concretely.

So: a separate `PlatformPermission` type in the domain, a separate catalogue, and
a separate guard.

```
platform.organizations.view
platform.organizations.create
platform.organizations.suspend
platform.organizations.reset_admin
platform.audit.view
platform.health.view
```

`requirePlatformPermission(deps, permission)` mirrors `requirePermission`: same
deny-by-default posture, same 401/403 distinction, same declaration on the route
rather than inside the handler. It authenticates against `platform_sessions` and
never consults `roles`. Conversely `requirePermission` never consults
`platform_users`. Neither guard can be satisfied by the other's credential.

V1 ships one platform role, `super_admin`, holding all of the above. The
permission set exists now so that adding a read-only platform support role later
is a data change rather than an architecture change.

---

## 6. How tenancy changes

### 6.1 The tenant is derived from the session, never from client input

`resolveHospital` stops reading configuration and starts reading the
authenticated organization session. `QMAN_HOSPITAL_ID` is deleted.

The security property this rests on: **there is no way for a client to name a
tenant.** No route takes a `hospitalId` path parameter, query parameter or body
field. A request carries a session; the session carries exactly one hospital;
every repository call is scoped by it. Reaching another tenant's data is not
refused — it is unrepresentable.

### 6.2 The cross-tenant guard is kept, and kept meaningful

Deriving the tenant from the session makes the existing comparison tautological
(§1.1). Deleting the check would be honest but would remove a tripwire. Instead
it is re-pointed at a quantity that can actually differ: **the tenant that owns
the resource being addressed.**

Routes that resolve a resource by an opaque id — a board, a visit, a branch —
load it, take the hospital that owns it, and compare that against the session's
hospital. Same refusal, same `cross-tenant request refused` alarm, same 403. The
check now catches a real class of bug: a repository method that forgot its
`WHERE hospital_id = $1`. It stops being an assertion about the request and
becomes an assertion about the data layer, which is where the mistake would
actually be made.

This is the part of the design most worth reviewing.

### 6.3 Idempotency stays tenant-scoped

`idempotency_keys` is `PRIMARY KEY (hospital_id, key)`. Its `resolveHospital`
follows §6.1. Two organizations replaying the same client-generated key must not
collide, and the composite key already guarantees they cannot.

### 6.4 Suspension is enforced at authentication and at every request

A suspension that only blocked new logins would leave existing sessions working
for their full lifetime. Both paths:

- **Login** refuses when the organization is not `active`, with a message that
  says the organization is suspended and to contact QMan — this is a billing or
  compliance state a hospital's administrator should be able to act on, not a
  mystery.
- **Session resolution** rejects sessions whose organization is not `active`, so
  suspension takes effect on the next request rather than at token expiry.

Public surfaces are included. A suspended organization's display boards and
tracking pages must stop serving, or suspension means nothing to anyone standing
in the building. `/public/boards/:boardId` and both tracking routes resolve
board → branch → hospital and check status.

---

## 7. How routing changes

Organization routes are unchanged. `/api/v1/config`, `/api/v1/queue/*`,
`/api/v1/visits/*`, `/api/v1/stream`, `/api/v1/events`, `/api/v1/public/*` keep
their paths and their shapes. The tenant moved from configuration to the session;
the URLs did not need to know.

Platform routes are a new tree under `/api/v1/platform`, guarded exclusively by
`requirePlatformPermission`:

| Route | Permission |
|---|---|
| `POST /api/v1/platform/auth/login` | — |
| `POST /api/v1/platform/auth/logout` | — |
| `GET /api/v1/platform/auth/me` | signed in |
| `GET /api/v1/platform/organizations` | `platform.organizations.view` |
| `POST /api/v1/platform/organizations` | `platform.organizations.create` |
| `GET /api/v1/platform/organizations/:id` | `platform.organizations.view` |
| `POST /api/v1/platform/organizations/:id/suspend` | `platform.organizations.suspend` |
| `POST /api/v1/platform/organizations/:id/reactivate` | `platform.organizations.suspend` |
| `POST /api/v1/platform/organizations/:id/admin-reset` | `platform.organizations.reset_admin` |
| `GET /api/v1/platform/audit` | `platform.audit.view` |
| `GET /api/v1/platform/health` | `platform.health.view` |

The `/platform` prefix is a trust boundary, not a grouping. Every route beneath
it requires a platform session; no route beneath it accepts an organization one.

### 7.1 Creating an organization

`POST /api/v1/platform/organizations` is the only way an organization comes into
existence. It creates, in one transaction: the hospital, its default branch, a
system administrator role holding the organization-level permission set, and one
administrator user with a generated password returned exactly once.

It reuses `ConfigurationService` and `ConfigurationWriter` rather than issuing
its own SQL, so an organization created through the platform is
indistinguishable from one built up through the configuration API. No duplicated
business logic; no second definition of what a valid hospital is.

### 7.2 Resetting an organization administrator

`POST /api/v1/platform/organizations/:id/admin-reset` is the documented recovery
path for a hospital that has locked itself out. It generates a new password for a
nominated administrator, returns it once, and writes to `platform_events` with
the target hospital. It never reveals the old password and never returns
organization data beyond the administrator's username.

Impersonation is explicitly out of scope for V1, as specified.

---

## 8. How the frontend changes

A fourth entry point, alongside `index.html`, `display.html` and `track.html`:

**`platform.html` → `platform.tsx` → `PlatformPortal`.**

A separate bundle for the same reason the Display Board is one. It is a different
trust domain with a different authentication model, and shipping it as a route
inside the staff app would put platform code in a bundle every hospital
receptionist downloads. Nothing that can create or suspend an organization
belongs in the staff app at all.

**New:** `PlatformAuthStore` and `PlatformApi` against `/api/v1/platform`, an
`OrganizationsSection` (list, create, suspend, reactivate, reset admin), an
`AuditSection` over `platform_events`, and a `HealthSection`. These follow the
existing store and section conventions exactly — API-backed store, feature
component that reads it, no business logic in React.

**Changed:** `SignIn` gains an organization code field. This is the only change
to an existing staff component.

**Unchanged:** `AdminPortal` and all nine of its sections, every workspace and
dashboard, both public surfaces. The organization administration UI already
operates on exactly one hospital's configuration and does not need to learn that
others exist. `AdminPortal` never gains an organization concept — that is the
Layer 1 / Layer 2 separation expressed in the code.

---

## 9. How deployment changes

The `QMAN_HOSPITAL_ID` environment variable is **deleted**. It is the deployment
expression of single tenancy and there is nothing to repoint it at.

`.env.example` and the deployment documentation change accordingly, and
`VITE_API_URL` — currently read in `runtime-stores.ts` but absent from
`.env.example` — is documented at the same time.

**Bootstrap.** A one-time command creating only the first Platform Super Admin:

```
npm run bootstrap -w @qman/api
```

- Creates exactly one row in `platform_users`. It has no code path that writes to
  `hospitals`, and cannot create an organization by any argument.
- Refuses to run when any `platform_users` row exists, unless
  `--recover` is passed, which is for a lost-credentials disaster and is logged
  to `platform_events`.
- Uses the existing `passwords.ts` scrypt hashing. No second implementation.
- Generates a strong password, prints it once to stdout, and never stores or logs
  the plaintext.

**First deployment** becomes: deploy → migrate → bootstrap → sign in to the
Platform portal → create Freshsprings Medical Services through the UI. Every
organization after that is created the same way, through the application.

The hosting shape from the deployment discussion is unchanged and still applies:
the web app on Vercel, the Fastify API on a host that can hold SSE connections,
and both on subdomains of one registrable domain so the `SameSite=Lax` session
cookie is not dropped.

---

## 10. Migrations required

Additive only. No column is dropped, no type changes, no data is rewritten.
Every one is safe to run against the existing database.

| # | Migration | Contents |
|---|---|---|
| 007 | `platform_users` | table; `UNIQUE INDEX ON (lower(username))`; role check constraint |
| 008 | `platform_sessions` | table; token-hash unique index; partial index on live sessions |
| 009 | `platform_events` | table; `UNIQUE (sequence)`; index on `(occurred_at DESC)`; index on `(target_hospital_id, occurred_at DESC)` |
| 010 | `platform_login_throttle` | table keyed by `username_key` |
| 011 | `hospitals` lifecycle | `status` NOT NULL DEFAULT `'active'`, `suspended_at`, `suspended_reason`; partial index on suspended rows |

Migration 011 is the only one touching an existing table, and only by adding
columns with a default that preserves current behaviour — every existing hospital
becomes `active`.

Standard PostgreSQL 13+ throughout. No extensions, consistent with the
portability constraint.

---

## 11. Compatibility concerns

**The existing deployment has no organization row.** Nothing has been deployed to
production, so there is no live tenant to migrate. If that changes before this
ships, migration 011's default makes the existing hospital `active` and it keeps
working; only `QMAN_HOSPITAL_ID` removal and the org-code login field affect it.

**Existing sessions break at deploy.** `resolveHospital` changes meaning, and
`SignIn` gains a required field. Everyone signed in must sign in again. In a
hospital this is a shift-change event, not a rollout — worth scheduling.

**`QMAN_HOSPITAL_ID` removal is a hard failure, deliberately.** The config loader
should reject the variable if present rather than ignore it, so a deployment
carrying it forward stops at startup instead of running with an operator's
mistaken belief about which tenant it serves.

**Test fixtures assume one hospital.** `apps/web/src/test/api-fixture.ts` pins
`HOSPITAL_ID`, and `apps/api/src/config-fixtures.ts` builds one hospital's
configuration. Both continue to work — one tenant is a valid case of many — but
new coverage is needed for two hospitals proving isolation, which is the test
that would have caught a missing `WHERE hospital_id = $1` all along.

**The tenant guard's meaning changes (§6.2).** Existing authorization tests
assert the current behaviour and will need to be rewritten against the
resource-owner comparison rather than deleted. A test deleted here is a control
deleted.

**Suspension has no UI in the staff app.** A suspended organization's staff get a
sign-in refusal. That is correct but needs a specific message rather than the
generic failure, and it is the one place where suspension must *not* be
indistinguishable from a bad password.

**Login enumeration.** Adding the organization code creates a new oracle if
handled carelessly. Covered in §4; called out again because it is easy to
regress when improving an error message.

**Public surfaces gain a status check** on a hot path — a display board polls and
holds an SSE connection. The check resolves board → branch → hospital, which is
one extra join; it belongs in the board lookup that already happens rather than
as a separate query per event.

**Three trust domains become four.** Staff, Display Board, Patient Tracker, and
now Platform. The existing rule — separate entry points, separate bundles,
independent authentication — is what keeps that manageable, and §8 follows it.

---

## 12. Open questions for review

1. **§6.2 is the decision that most deserves scrutiny.** Re-pointing the
   cross-tenant guard at resource ownership keeps a real control; the alternative
   is deleting it and relying entirely on session-derived scoping. I recommend
   keeping it. It is worth disagreeing with explicitly rather than by omission.

2. **Organization code at login versus subdomains.** I recommend the code field
   for V1 (§4). Subdomains are a better product experience and can be added later
   without a schema change, but they multiply per-tenant DNS, certificate and
   CORS-origin management immediately.

3. **One platform role or a permission-backed set from the start.** I recommend
   shipping the permission catalogue now and one role that holds all of it, so a
   read-only support role is later a data change.

Implementation begins once these are settled.
