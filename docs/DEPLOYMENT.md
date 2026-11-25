# Deployment

How to put QMan into production: the API on Render, Railway or Fly, the web app
on Vercel, and PostgreSQL on Neon.

Pick **one** of the three API guides. They are alternatives, not steps.

---

## 0. Before any of them

Three things decide whether the deployment works, and all three are easier to
get right now than to debug later.

### 0.1 One registrable domain. This is not optional.

The session cookie is `SameSite=Lax`. That means the browser sends it only on
**same-site** requests — and "same-site" is decided by the registrable domain
(eTLD+1), not by the origin.

So this works:

| | |
|---|---|
| Web | `app.qman.example` |
| API | `api.qman.example` |

…because both are `qman.example`. Different origins, same site, cookie flows.

**And this does not:**

| | |
|---|---|
| Web | `qman.vercel.app` |
| API | `qman-api.onrender.com` |

Those are cross-*site*. The browser silently withholds the session cookie from
every API call. Sign-in returns 200 and sets the cookie, and every subsequent
request is anonymous — which looks exactly like a bug in the application.

`*.vercel.app` is on the Public Suffix List, so even two Vercel domains are
cross-site to each other. You cannot dodge this by naming things carefully.

**Buy a domain before you start.** The alternative is relaxing cookies to
`SameSite=None`, which trades away a CSRF defence you currently get for free.

### 0.2 The database

Create a Neon project (or any PostgreSQL 13+ — the schema uses no extensions and
is portable to Render, Railway, RDS, Azure, DigitalOcean, Supabase or a hospital's
own server). Copy the connection string.

Migrations run automatically when the API starts, so no separate step is
required. Running them deliberately first is still better: it separates "the
schema changed" from "the new code is live", and it fails somewhere you are
watching.

### 0.3 What the API needs to run

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | PostgreSQL connection string |
| `QMAN_ALLOWED_ORIGINS` | **yes in production** | Comma-separated. No default — a permissive default would disable CSRF for every deployment that did not know to set it |
| `NODE_ENV` | recommended | Anything other than `development` is treated as production |
| `PORT` | injected by the host | Defaults to 3001 |
| `HOST` | no | Defaults to `0.0.0.0` |
| `LOG_LEVEL` | no | `debug`/`info`/`warn`/`error`, defaults to `info` |
| `DATABASE_SSL` | no | Defaults on unless the URL is localhost |
| `DATABASE_SSL_INSECURE` | no | Leave false for every managed provider |
| `DATABASE_POOL_SIZE` | no | Defaults to 10 |
| `QMAN_SECURE_COOKIES` | no | On in production; setting it false there is refused at startup |

**`QMAN_HOSPITAL_ID` must not be set.** QMan hosts many organizations and derives
the tenant from the session. A deployment that still carries this variable is
**refused at startup** rather than ignored, because the belief behind it — that
this server serves one named hospital — is now wrong in a way that would not
otherwise surface.

### 0.4 Two things that break monorepo builds

Both were hit during development and both produce confusing errors.

**Do not deploy `apps/api/dist` alone.** Migrations are read from disk at
runtime: `migrationsDirectory()` resolves `@qman/persistence/package.json` and
reads the sibling `migrations/` directory. The workspace has to be intact, with
`packages/persistence/migrations/*.sql` present. A deployment of just the
compiled output starts and then fails to migrate.

**Do not prune dev dependencies before building.** `npm ci --omit=dev` removes
TypeScript, and the build needs it. Install everything, build, then prune if you
want to.

---

## 1. API on Render

Render builds from source and is the least fiddly of the three.

1. **New → Web Service**, connect the GitHub repository.
2. **Root Directory:** leave **blank** (the repository root). The API cannot be
   built from `apps/api` alone — it imports two workspace packages.
3. **Runtime:** Node
4. **Build Command:**
   ```
   npm ci && npm run build -w @qman/api
   ```
5. **Start Command:**
   ```
   npm start -w @qman/api
   ```
6. **Health Check Path:** `/api/health`
7. **Environment** — add:
   ```
   DATABASE_URL          = postgresql://…            (from Neon)
   QMAN_ALLOWED_ORIGINS  = https://app.qman.example
   NODE_ENV              = production
   ```
   Render injects `PORT` itself. Do not set `QMAN_HOSPITAL_ID`.
8. **Instance type:** any paid tier. **Not the free tier** — it sleeps after
   inactivity, and a sleeping instance drops every display board's SSE
   connection and makes the first request of the morning wait for a cold start.
9. Deploy, then **Settings → Custom Domain** → `api.qman.example`, and add the
   CNAME Render shows you at your DNS provider.

Once TLS is issued, confirm `https://api.qman.example/api/health` returns 200,
then continue to §5.

---

## 2. API on Railway

1. **New Project → Deploy from GitHub repo.**
2. Open the service → **Settings**.
3. **Root Directory:** `/` (the repository root).
4. **Build Command:**
   ```
   npm ci && npm run build -w @qman/api
   ```
5. **Start Command:**
   ```
   npm start -w @qman/api
   ```
6. **Healthcheck Path:** `/api/health`
7. **Variables** — the same three as Render:
   ```
   DATABASE_URL          = postgresql://…
   QMAN_ALLOWED_ORIGINS  = https://app.qman.example
   NODE_ENV              = production
   ```
   Railway injects `PORT`. Do not set `QMAN_HOSPITAL_ID`.

   If you use Railway's own PostgreSQL instead of Neon, reference it rather than
   pasting a copy that will drift:
   ```
   DATABASE_URL = ${{Postgres.DATABASE_URL}}
   ```
8. **Settings → Networking → Custom Domain** → `api.qman.example`, then add the
   CNAME at your DNS provider.

**Serverless/sleep settings:** leave the service always-on. Railway's
app-sleeping feature is incompatible with held-open SSE connections.

---

## 3. API on Fly.io

Fly runs containers, so this uses the `Dockerfile` and `fly.toml` in the
repository root. Both are committed — you do not need to write them.

```bash
fly auth login
fly launch --no-deploy          # keeps the committed fly.toml; edit `app` if the name is taken
```

Set the secrets. `fly secrets` is the right home for the connection string —
values in `fly.toml` are in your git history, and `[env]` there is for
non-sensitive values only:

```bash
fly secrets set \
  DATABASE_URL='postgresql://…' \
  QMAN_ALLOWED_ORIGINS='https://app.qman.example'
```

Deploy and attach the domain:

```bash
fly deploy
fly certs add api.qman.example
```

`fly certs add` prints the DNS records to create. `PORT` and `NODE_ENV` are set
in `fly.toml`; do not set `QMAN_HOSPITAL_ID`.

**What `fly.toml` already handles, and why:**

- `auto_stop_machines = false`, `min_machines_running = 1` — a suspended machine
  drops every board's SSE connection. Reconnection recovers, but a waiting-room
  screen that reconnects every few minutes is one that regularly shows nothing.
- `soft_limit = 200` connections — sized for long-lived, nearly idle SSE
  connections rather than for requests per second.
- Health check on `/api/health`, which is deliberately unversioned: it answers
  "is this process alive", which is not a business capability and must not move
  when the API version does.

**Scaling past one machine:** everything that must be shared already lives in
PostgreSQL — sessions, lockout counters, idempotency keys. The one thing that
does not is the SSE fan-out: `EventStream` is in-process, so a client connected
to machine A will not receive an event published on machine B. Until that is
addressed, **run a single machine**.

---

## 4. Frontend on Vercel

1. **Add New → Project**, import the repository.
2. **Root Directory:** `apps/web`
3. Leave the build and output settings **alone**. `apps/web/vercel.json` already
   pins them:
   ```json
   { "buildCommand": "npm run build", "outputDirectory": "dist" }
   ```
   This is load-bearing. Vercel's Vite preset runs `vite build` directly, which
   skips `build:deps` and fails with *"Failed to resolve entry for package
   @qman/domain"*. Overriding these in the dashboard reintroduces that.
4. **Environment Variables:**
   ```
   VITE_API_URL = https://api.qman.example
   ```
   **Read at build time, not run time.** Changing it later needs a redeploy, not
   a restart.
5. Deploy, then **Settings → Domains** → `app.qman.example`.
6. Go back to the API host and make sure `QMAN_ALLOWED_ORIGINS` is exactly
   `https://app.qman.example` — the origin only, no path, no trailing slash. The
   API validates this at startup and refuses anything else.

The build produces four entry points:

| Path | Surface |
|---|---|
| `/` | Staff app |
| `/display.html?board=<id>` | Display board |
| `/track.html` | Patient tracker |
| `/platform.html` | Platform administration |

---

## 5. First run

With the API and web app both live:

```bash
# 1. Migrations, run deliberately rather than on first boot.
DATABASE_URL='postgresql://…' npm run migrate -w @qman/api

# 2. The first and only Platform Super Admin.
DATABASE_URL='postgresql://…' npm run bootstrap -w @qman/api -- \
  --username root --name "Platform Root"
```

Both can be run from your machine against the production database, or from the
host's shell (`render ssh`, `railway run`, `fly ssh console`).

Bootstrap prints the password **once**. It is not recoverable and is not stored
in plaintext anywhere. Copy it before closing the terminal.

It refuses to run a second time. If every platform credential is ever lost,
`--recover` overrides that and is recorded in the platform audit log.

**Bootstrap cannot create a hospital.** There is no flag that would make it. Sign
in at `https://app.qman.example/platform.html` and create your first
organization — Freshsprings Medical Services — through the portal, which records
who created it and when.

Creating an organization returns its administrator's password **once**, in the
same way. That administrator signs in at `https://app.qman.example/` with the
organization code, their username and that password.

---

## 6. Smoke test

In this order, because each failure has a distinct cause.

| # | Check | A failure here means |
|---|---|---|
| 1 | `GET https://api.qman.example/api/health` → 200 | The service is not up, or the domain is not attached |
| 2 | Sign in to `/platform.html` | Bootstrap did not run, or credentials are wrong |
| 3 | **Reload the page.** Still signed in? | **The cookie is being dropped — §0.1.** This is where a wrong domain layout shows up |
| 4 | Create an organization | Provisioning or the database |
| 5 | Sign in to `/` with the org code | Organization login |
| 6 | Add a station in Administration | Configuration writes and CSRF |
| 7 | Admit a patient | Admission, ticket allocation |
| 8 | Open `/display.html?board=<id>` in another tab | Public surfaces |
| 9 | Call the patient; the board updates within a second | **SSE** — if steps 1–8 pass and this does not, suspect a proxy buffering the stream |

Step 3 is the one worth being deliberate about. Everything else can be fixed
after launch; a cookie the browser refuses to send cannot be worked around.

---

## 7. After deploying

**Run the database-backed suite against the real instance.** It is not part of
`npm run verify`, and every serious defect found late in development was found
by it and by nothing else:

```bash
DATABASE_URL='postgresql://…' npm run verify:db -w @qman/api
```

Point it at a **staging** database. It creates and drops its own schema, so it is
safe alongside existing data, but it is not something to aim at production.

**Watch for `cross-tenant request refused` in the logs.** It should never appear.
Any occurrence is an incident, not a warning.

---

## 8. Rollback

Migrations 001–012 are additive: no column is dropped and no data is rewritten,
so the previous release runs against the new schema — with one exception. The
previous release **requires** `QMAN_HOSPITAL_ID`, which the current one refuses.

To roll back: redeploy the previous API and web builds **together**, and restore
`QMAN_HOSPITAL_ID`. Platform tables are orphaned but harmless. All sessions
invalidate, so everyone signs in again.

Take a `pg_dump` before every migration regardless. Neon's point-in-time restore
is the faster path if you have it.
