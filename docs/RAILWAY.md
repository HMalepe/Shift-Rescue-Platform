# Deploying to Railway (MVP path)

This is the fast path to a live instance without an AWS account, a domain, or
a Terraform apply. `infra/` (AWS/ECS/Terraform) is not deleted or replaced —
it is the scale-out path for later, and stays validated and untouched. This
document is the other path: get something live today, on Railway's own
infrastructure and billing.

## Why Railway fits an MVP better than AWS here

- No VPC, no ECS task definitions, no ACM certificate, no NAT gateway line
  item. Railway gives every service a public HTTPS URL on a free
  `*.up.railway.app` subdomain the moment it deploys — no domain purchase
  required to go live.
- Postgres, Redis and a plain container are all "add a service" clicks rather
  than Terraform resources.
- Cost scales down to near-zero for low traffic, which matters more for an
  MVP than the headroom `infra/` was sized for.

The trade-off, stated plainly: Railway does not give you a VPC, a KMS key you
control, or the alarm/budget infrastructure in `infra/monitoring.tf`. This is
the right choice for "get it live and see if anyone uses it", not for the
scale `infra/` was built for.

## What changed in the code to make this possible

`packages/integrations/src/s3.ts`'s `S3DocumentStorage` used to require an AWS
KMS key unconditionally — correct for AWS, but Cloudflare R2 (the
S3-compatible object store used here, no AWS account needed) encrypts every
object at rest under a key **it** manages, and has no bucket-side equivalent
of a customer KMS key to send. The adapter now takes an explicit `sse` mode:

- `{ mode: "aws-kms", kmsKeyId }` — the AWS path, unchanged.
- `{ mode: "provider-managed" }` — R2/B2, sends no encryption header at all,
  because there is nothing S3-shaped to send.

There is no default and no inference from which fields happen to be set —
`S3_SSE_MODE` must be set explicitly, the same "fail closed, not silently
downgraded" posture as everywhere else in this codebase. See the header
comment in `s3.ts` for the full reasoning.

## Services to create, in order

Create one Railway project, then add these services. Names matter — Railway's
private networking addresses services by name as `<service>.railway.internal`,
and the env vars below assume the names given.

### 1. `postgres`

**New Service → Docker Image** → `postgis/postgis:16-3.4`. This is the same
image `docker-compose.yml` and `infra/data.tf` use — do not substitute
Railway's own Postgres template, which is vanilla Postgres and has no PostGIS
extension. §0.1 requires version parity for exactly this reason: `ST_DWithin`
on `geography` plans differently across majors.

Environment variables:

```
POSTGRES_USER=locum
POSTGRES_PASSWORD=<generate a strong one>
POSTGRES_DB=locum_planner
PGDATA=/var/lib/postgresql/data/pgdata
```

Attach a Volume mounted at `/var/lib/postgresql/data` — without it, every
redeploy starts from an empty database.

`PGDATA` above is not optional. Railway volumes have a `lost+found` directory
at their root, and Postgres's own initdb refuses to initialise into a
directory that already contains anything — so mounting the volume straight at
`/var/lib/postgresql/data` and leaving `PGDATA` unset fails on first boot with
"initdb: error: directory ... exists but is not empty". Pointing `PGDATA` at
an empty subdirectory of the mount (`pgdata/`) gives Postgres a genuinely
empty directory to initialise into, while `lost+found` sits alongside it,
still on the same persistent volume.

### 2. `redis`

Use Railway's official Redis template (New Service → Database → Redis) rather
than a custom image. BullMQ needs nothing PostGIS-shaped from Redis, so there
is no reason to hand-roll this one. Railway exposes its connection string as a
reference variable; copy it into the API/worker services as `REDIS_URL` (see
below).

### 3. `clamav`

**New Service → Docker Image** → `clamav/clamav:1.4`. Do **not** enable public
networking on this service — it should only be reachable from `api` over
Railway's private network. Set:

```
CLAMAV_NO_MILTERD=true
```

Give it real memory (at least 1 GB) — clamd loads the full signature database
into memory on startup, and an undersized container gets OOM-killed while
loading, which presents as every upload failing for the first few minutes
after a deploy (the same note as `infra/compute.tf`'s sidecar sizing).

### 4. `api`

**New Service → GitHub Repo** → this repository. Railway will find
`railway.json` at the repo root automatically (Dockerfile build,
`pnpm --filter @locum/api start`, healthcheck at `/health`).

Environment variables:

```
NODE_ENV=production
AUTH_SECRET=<64+ random chars>
DATABASE_URL=postgresql://locum:<password>@postgres.railway.internal:5432/locum_planner
REDIS_URL=<paste the Redis service's connection string>

PUBLIC_BASE_URL=https://<this-service>.up.railway.app
ALERT_WEBHOOK_URL=<your alert sink>

TWILIO_ACCOUNT_SID=<from your Twilio account>
TWILIO_AUTH_TOKEN=<from your Twilio account>
TWILIO_FROM_NUMBER=<your approved WhatsApp sender>
TWILIO_CONTENT_SIDS={"shift_offer_v1":"HX...", "booking_confirmed_v1":"HX...", ...}

PAYFAST_MERCHANT_KEY=<from your Payfast account>
PAYFAST_PASSPHRASE=<from your Payfast account>

CLAMD_HOST=clamav.railway.internal
CLAMD_PORT=3310

S3_BUCKET=<your R2 bucket name>
S3_REGION=auto
S3_SSE_MODE=provider-managed
S3_ENDPOINT=https://<your-cloudflare-account-id>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=<R2 API token id>
AWS_SECRET_ACCESS_KEY=<R2 API token secret>
```

`PUBLIC_BASE_URL` must be exact — Twilio signs the full request URL for
webhook verification, and a trailing slash or `http://` mismatch fails every
signature check silently rather than loudly.

### 5. `worker`

**New Service → GitHub Repo** → the same repository. Set one extra variable so
it picks up the worker config instead of the API's:

```
RAILWAY_CONFIG_FILE=railway.worker.json
```

Give it the same `DATABASE_URL`, `REDIS_URL`, `AUTH_SECRET`, Twilio and
Payfast variables as `api` — it runs the §4.4 drain and §2 dunning jobs
against the same database and queue. It has no `PUBLIC_BASE_URL` use and no
public networking; nothing calls it, it wakes on a schedule.

### 6. `web` — not yet wired

`apps/web` is a standalone Next.js app inside this pnpm workspace, and the
root `Dockerfile` only builds `api`/`worker`. Deploying it on Railway needs
either a second Dockerfile (multi-stage, building the workspace's shared
packages first) or a Root Directory + Nixpacks build pointed at `apps/web`
with the workspace dependencies resolved — neither is done yet. Treat this as
the next piece of work, not something this guide has solved. Until then, run
`apps/web` locally against the deployed `api` by setting
`API_URL=https://<api-service>.up.railway.app` in `apps/web`'s local `.env`.

## After all five services exist

1. **Run migrations once**, from your machine with the Railway CLI:
   ```sh
   railway link              # select this project
   railway run --service api pnpm --filter @locum/db migrate
   ```
   This runs inside Railway's network, so it reaches `postgres.railway.internal`
   the same way the API does.

2. **Confirm boot**: `curl https://<api-service>.up.railway.app/health` should
   return `{"status":"healthy",...}`. If it does not, check the deploy logs —
   `assertProductionReady` refuses to start with any stub adapter still wired,
   and its error message names exactly which one.

3. **A custom domain is optional**, not required to go live. Railway's own
   `*.up.railway.app` subdomain is a real HTTPS endpoint from the moment the
   service deploys. Add a custom domain later via Service Settings → Networking
   → Custom Domain, which only then needs a DNS CNAME record — no ACM
   certificate wait, Railway issues it automatically.

## What is genuinely still missing

Same list as the AWS path, because these are external/human blockers, not
platform-specific:

- §16 anti-spoofing needs a physical Android device.
- The §14 disintermediation corpus needs human review.
- `apps/web` has no Railway build path yet (see §6 above).
- CloudWatch-style alarms (`infra/monitoring.tf`) have no Railway equivalent
  configured here — Railway has its own metrics/alerting, not wired up.
