# nur-tricenter-local

Brings the whole platform up in Docker for local development: the shared infrastructure
(PostgreSQL, RabbitMQ, Consul) plus every business process that subscribes to a profile.

**This repository is local development only.** Nothing here is deployed: in production the gateway
and each microservice are published on their own.

## Quick start on a new machine

1. Install **git**, **Docker Desktop** (running), the **.NET SDK 8 and 10**, and **Python 3** (only for the smoke test).
2. Set the GitHub Packages credentials once (the shared kernels are private): see
   [Private feed credentials](#private-feed-credentials).
3. Make sure these host ports are free: `5433` (Postgres), `5672` / `15672` (RabbitMQ), `8500` (Consul),
   `15005` (gateway), `15100` (demo console).
4. Clone this repository into an empty folder, then from its root:

   ```powershell
   .\scripts\setup-project.ps1   # clones every sibling repository, seeds ms5's local .env
   .\scripts\start-stack.ps1     # builds everything, starts the stack, creates service accounts
   ```

   (`./scripts/setup-project.sh` and `./scripts/start-stack.sh` on Linux/macOS.)
5. Open the **demo console** at **http://localhost:15100**: system map, guided end-to-end order,
   security probes, Consul registry, live RabbitMQ events and outbox rows. Its README and the Spanish
   presentation guide are in [`demo-console/`](./demo-console/).
6. Optional check from a terminal: `python scripts/e2e-smoke.py` must end with `ALL GREEN`
   (the first run right after a start can fail once while the services warm up; run it again).

## Two ways to start: base vs dev profile

There are two scripts, two intents:

| Script | What is on | When to use it |
|---|---|---|
| `scripts/start-stack.{sh,ps1}` | The platform as it ships. Swagger stays off. No extra host ports. | The default. Every day, every PR, every teammate. |
| `scripts/start-stack-dev.{sh,ps1}` | The base stack + the catalog's OpenAPI document on the workstation. | When you want to read the catalog contract in a browser. |

The dev profile is layered on top of the base compose via `compose/dev/docker-compose.dev.yml`. It
does ONE thing: enable the catalog's `Swagger__Enabled=true` and bind the catalog process to host
port `18080`. Application traffic still flows through the gateway at `:15005` — the extra host port
is purely a developer convenience for reading the contract.

**Why two scripts and not one with Swagger always on:** Swagger ships the entire API surface as a
machine-readable document (`/swagger/v1/swagger.json`) and a UI. That is fine on a developer
laptop, never on a public endpoint. Splitting the file is what makes the default safe: the dev
profile is opt-in, never the default, never in a deployment pipeline.

## Profiles: adding a microservice requires no edit here

Each business process declares the profile it belongs to:

| Profile | What it starts |
|---|---|
| *(none)* | Infrastructure only: Postgres, RabbitMQ, Consul |
| `catalog` | `catalog-api` + `catalog-workerservice` |
| `ms1` | `clinica-nutricional-api` + `clinica-nutricional-workerservice` |
| `gateway` | `apigateway-webapp` |

```bash
docker compose up                                        # infrastructure only
docker compose --profile catalog up                       # catalog + infrastructure
docker compose --profile gateway up                       # gateway + infrastructure
docker compose --profile catalog --profile gateway up     # both
```

**Why this matters:** when the next microservice arrives, its team adds a compose file with its own
profile in **its own PR**. The platform owner does not edit this repository, and therefore there are
no merge conflicts between teams.

Several profiles can be active at once, as in the last example.

## What is here

```
nur-tricenter-orchestrator/
├── compose/                         -> stack definition, split by responsibility
│   ├── docker-compose.yml           -> root compose. Includes infra + business
│   │                                   processes with bind-mounted binaries.
│   │                                   Base flow, Swagger OFF.
│   ├── docker-compose.infra.yml     -> platform containers only (Postgres,
│   │                                   RabbitMQ, Consul). Included by the root
│   │                                   compose.
│   └── dev/
│       └── docker-compose.dev.yml   -> dev profile. Layered on top of the root
│                                       compose with -f. Enables the catalog's
│                                       OpenAPI document and binds host port
│                                       18080. Never used in production.
├── topology/                        -> what makes the broker and the database
│   │                                   the same on every boot
│   ├── rabbitmq.conf                -> broker config: defines-import backend,
│   │                                   loopback_users = none
│   ├── rabbitmq-definitions.json    -> exchanges / queues / bindings imported
│   │                                   on broker boot
│   └── postgres-init/
│       └── 01-create-databases.sql  -> idempotent CREATE DATABASE for each
│                                       microservice
└── scripts/                         -> entry points
    ├── start-stack.{sh,ps1}         -> base flow
    ├── start-stack-dev.{sh,ps1}     -> base flow layered with dev profile
    ├── start-infrastructure.{sh,ps1}-> platform only
    └── stop-infrastructure.{sh,ps1} -> tears the platform down
```

The `Orchestrator.AppHost/` directory used to live here. It was a .NET Aspire reference path that
predated this compose-based stack. Aspire 13.6.1 conflicts with the docker network namespace on a
host that already has containers, so compose is the source of truth now and the AppHost is gone.
The general idea is captured in the comment block at the top of `docker-compose.yml`.

## Adding a microservice

On the service's side:

1. A compose file declaring `profiles: [<service-name>]`
2. A `CREATE DATABASE <service-name>` in its own init script
3. Registration in Consul through `ServiceRegistration__ServiceName`

On this side: **nothing**. A profile is opt-in, so a service that declares no profile appears in no
`up`.

## Prerequisites

- Docker Desktop running.
- .NET SDK 8 and 10 — the catalog and identity target `net8.0`, the gateway `net10.0`.
- The four sibling repositories. This orchestrator references them by relative path, so they
  have to be present next to it. `scripts/setup-project.sh` clones them for you (see below).

## First time setup

The stack spans five repositories and compose reaches into each one with a relative path
(`../ms2-plans-and-recipes-catalog/catalog.compose.yml`, and so on). Cloning this
repository alone therefore produces a stack that cannot start, and the error names
compose syntax rather than the missing directories.

```bash
# Unix
./scripts/setup-project.sh

# Windows PowerShell
.\scripts\setup-project.ps1
```

The script is idempotent: a repository already present is left alone, so it is safe to
re-run after pulling changes in one of them. It also reports whether `NUGET_TOKEN` is
defined, because the platform kernels are private GitHub Packages.

> `nur-tricenter-identity` is not published yet. `setup-project` will fail on it until
> the repository exists and is pushed.

### Private feed credentials

```bash
# Unix
export NUGET_USERNAME="your-github-user"
export NUGET_TOKEN="a-token-with-read:packages"

# Windows PowerShell
[Environment]::SetEnvironmentVariable("NUGET_USERNAME", "your-github-user", "User")
[Environment]::SetEnvironmentVariable("NUGET_TOKEN",   "your-token",        "User")
```

One name across all four repositories. The token is only read from your environment —
never written to a file in version control.

## Starting the stack

```bash
# Unix
./scripts/start-stack.sh
./scripts/start-stack-dev.sh   # with Swagger and the catalog on :18080

# Windows (from the repo root)
pwsh ./scripts/start-stack.ps1
pwsh ./scripts/start-stack-dev.ps1
```

Each script:

1. Removes stale containers (volumes are kept).
2. Resolves absolute paths from its own location (../compose/, ../topology/, ../../<sibling>).
3. Creates the `nur-tricenter-net` network if missing.
4. Builds the three business projects (`dotnet build`).
5. Brings up infrastructure and the processes with `docker compose up -d` (dev adds a third `-f
   compose/dev/docker-compose.dev.yml`).
6. Applies the catalog schema with `dotnet Catalog.App.dll --migrate`.

> **Every service is bind-mounted from its own repository's `bin/Debug` output.** The catalog is at
> `../ms2-plans-and-recipes-catalog/`, the gateway at `../nur-tricenter-api-gateway/`. A stale build
> directory is the most common cause of a container that starts and immediately crashes on a missing
> assembly — rebuild the project before restarting it.

## Verify

```bash
# Consul
open http://localhost:8500

# RabbitMQ
open http://localhost:15672          # guest / guest

# Gateway
curl http://localhost:15005/health
curl http://localhost:15005/api/catalog/v1/foods

# Demo console (presentation dashboard)
open http://localhost:15100

# (dev profile only) Catalog Swagger UI
open http://localhost:18080/swagger
# (dev profile only) Catalog OpenAPI document
curl http://localhost:18080/swagger/v1/swagger.json
```

The gateway rewrites `/api/{service}/**` to the service's own route, so
`/api/catalog/v1/foods` reaches `Catalog.App` as `/api/v1/foods`. The gateway refreshes its
routing table from Consul every 30 seconds, so a newly registered service can return 404 for up to
half a minute after it becomes healthy.

The Swagger URLs only exist when the stack was started with `start-stack-dev.*`. With
`start-stack.*` (the base script), `localhost:18080` returns connection refused on purpose — the
dev profile is opt-in by file split, not by an env var that could leak into prod.

## Logs

```bash
docker logs -f nur-tricenter-catalog-api
docker logs -f nur-tricenter-catalog-workerservice
docker logs -f nur-tricenter-gateway
```

`docker ps` shows container names; `docker exec` and `docker logs` also accept the short ID, which is
what you want to copy while a container is in a restart loop.

## What is where inside the stack

Everything is grouped by Docker Desktop under the compose project **`nur-tricenter`**, and each
container's compose service name is the same word as its container name, so `docker compose ps` and
`docker ps` never disagree:

| Container | Compose service | Hostname (internal DNS) | Ports |
|---|---|---|---|
| `nur-tricenter-postgres` | `db` | `nur-tricenter-postgres` | host 5433 → 5432 |
| `nur-tricenter-rabbitmq` | `rabbitmq` | `nur-tricenter-rabbitmq` | 5672, 15672 |
| `nur-tricenter-consul` | `consul` | `nur-tricenter-consul` | 8500 |
| `nur-tricenter-catalog-api` | `catalog-api` | `catalog-api` | internal 8080 — and host 18080 → 8080 **only** with the dev profile |
| `nur-tricenter-catalog-workerservice` | `catalog-workerservice` | `catalog-workerservice` | internal 8080 |
| `nur-tricenter-gateway` | `gateway` | `gateway` | host 15005 → 8080 |

Every container is `nur-tricenter-<what-it-is>`: the prefix says the platform, the suffix says the
role. Nothing repeats the repository name, because a container outlives the repository it was built
from.

`hostname` drops the prefix entirely, because it only has to be unique inside the network — that is
what the other containers resolve through Docker DNS.

The gateway is the only service that is always mapped to a host port — it is the sole public entry
point. The catalog's `18080 → 8080` mapping is dev-only and exists only to expose the OpenAPI UI
to the workstation.

## Health checks and service registration

All six containers report `healthy`, and the business processes wait on `service_healthy` for
Postgres and RabbitMQ rather than `service_started`.

| Container | How it is checked | Notes |
|---|---|---|
| `nur-tricenter-postgres` | `pg_isready` | |
| `nur-tricenter-rabbitmq` | `rabbitmq-diagnostics check_running` | |
| `nur-tricenter-consul` | `consul members` | |
| `nur-tricenter-catalog-api` | TCP probe to port 8080 | |
| `nur-tricenter-gateway` | TCP probe to port 8080 | |
| `nur-tricenter-catalog-workerservice` | `/proc/*/cmdline` | |

Three of those deserve their reasoning recorded, because each was wrong first:

**The probes are shell TCP checks, not `curl`.** The `aspnet` runtime image ships no curl, so a
healthcheck calling it fails with `curl: not found` forever and marks a perfectly healthy
application as unhealthy.

**The worker check reads `/proc`, not `pgrep`.** The runtime image also lacks procps.

**The worker is not registered in Consul, and that is correct.** Consul registration exists so the
gateway can route traffic; the worker publishes to RabbitMQ and serves no HTTP at all, so it has no
address to register. Registering it would publish a route to an endpoint that cannot answer. Its
liveness is a container concern, so it belongs in a Docker healthcheck — and if the
`OutboxProcessor` dies, the outbox stops draining silently, which is exactly what this check catches.

## Iteration loop

```bash
# from the service's directory
dotnet build

# from this directory
docker compose -f compose/docker-compose.yml -f compose/docker-compose.infra.yml restart catalog-api
```

The bind-mount means rebuilt assemblies are picked up on restart. This is the dev loop until the
generic Dockerfile lands.

## Why compose and not Aspire

The reference architecture's orchestrator is an Aspire AppHost. The previous incarnation of this
repository carried both: an `Orchestrator.AppHost/` project kept the Aspire path compilable, and
the compose files carried the default flow.

In practice Aspire 13.6.1 conflicts with the docker network namespace on a host that already has
containers from earlier sessions (and the AppHost did not inject every variable the compose
does, so its database name and service registration differed). The Aspire path was removed to
keep the source of truth singular — compose is the orchestrator now. Bringing Aspire back in
later would mean one Dockerfile per business service and a clean split between compose (used by
the dev/start scripts) and AppHost (used by the dashboard), with both agreeing on
environment-variable names.

## See also

- `ANALISIS-ARQUITECTURA-MS2026.md` (in the workspace root) — the architecture analysis this stack implements.
- `nur-tricenter-shared-kernels` — the platform libraries, consumed as NuGet packages.

## Integration & extending the platform

The orchestrator brings the **whole platform** up in Docker for local development: shared infrastructure
(Postgres, RabbitMQ, Consul) plus every business process that subscribes to a profile. It is local-dev
only; in production each service ships on its own.

### What is here

```
nur-tricenter-orchestrator/
├── compose/                  # stack definition, split by responsibility
│   ├── docker-compose.yml    # root compose (include: infra + business processes)
│   ├── docker-compose.infra.yml
│   └── dev/docker-compose.dev.yml   # dev profile (catalog Swagger + host port 18080)
├── topology/                 # broker + database stay the same on every boot
│   ├── rabbitmq.conf
│   ├── rabbitmq-definitions.json   # exchanges / queues / bindings
│   └── postgres-init/01-create-databases.sql
└── scripts/                  # entry points
    ├── start-stack.{sh,ps1}        # base flow (Swagger OFF)
    ├── start-stack-dev.{sh,ps1}    # base + dev profile
    ├── start-infrastructure.{sh,ps1}
    └── stop-infrastructure.{sh,ps1}
```

### Prerequisites

- Docker Desktop running.
- .NET SDK 8 and 10 (catalog/identity target `net8.0`, gateway `net10.0`).
- The four sibling repositories next to this one (cloned by `setup-project`).
- `NUGET_USERNAME` / `NUGET_TOKEN` env vars (read:packages) for the private kernel feed.

### First-time setup

```bash
./scripts/setup-project.sh        # or .ps1 on Windows (idempotent)
```

Clones the sibling repos if missing. Reports whether `NUGET_TOKEN` is defined.

### Starting the stack

```bash
./scripts/start-stack.sh          # base (Swagger off, no extra host ports)
./scripts/start-stack-dev.sh     # base + catalog Swagger on :18080
```

Each script: removes stale containers (keeps volumes), resolves absolute paths, creates the
`nur-tricenter-net` network, builds the three business projects (`dotnet build`), brings up infra +
processes, applies the catalog schema (`--migrate`).

### Profiles (adding a microservice requires no edit here)

| Profile | What it starts |
|---|---|
| *(none)* | Infra only: Postgres, RabbitMQ, Consul |
| `catalog` | catalog-api + catalog-workerservice |
| `gateway` | apigateway-webapp |

```bash
docker compose up                                    # infra only
docker compose --profile catalog up                  # catalog + infra
docker compose --profile catalog --profile gateway up # both
```

### How to add a new microservice

On the **service's** side (its own repo, its own PR):
1. A compose file declaring `profiles: [<service-name>]`.
2. A `CREATE DATABASE <service>` block in the orchestrator's `postgres-init/01-create-databases.sql`.
3. Consul self-registration via `ServiceRegistration__ServiceName`.
4. Its own RabbitMQ exchanges/queues in `rabbitmq-definitions.json` if it publishes/consumes.

On the **orchestrator's** side: **nothing**. A profile is opt-in, so a service that declares no profile
appears in no `up`. This is what keeps teams from conflicting on the platform repo.

### Topology (container names)

| Container | Hostname (DNS) | Ports |
|---|---|---|
| nur-tricenter-postgres | nur-tricenter-postgres | host 5433 → 5432 |
| nur-tricenter-rabbitmq | nur-tricenter-rabbitmq | 5672, 15672 |
| nur-tricenter-consul | nur-tricenter-consul | 8500 |
| nur-tricenter-catalog-api | catalog-api | 8080 (host 18080 only in dev) |
| nur-tricenter-catalog-workerservice | catalog-workerservice | 8080 |
| nur-tricenter-identity-api | identity-api | 8080 |
| nur-tricenter-identity-workerservice | identity-workerservice | 8080 |
| nur-tricenter-nurtricenter-api | nurtricenter-api | 8080 |
| nur-tricenter-nurtricenter-workerservice | nurtricenter-workerservice | — (no HTTP) |
| nur-tricenter-contracting-api | contracting-api | 8080 (host 18083 only in dev) |
| nur-tricenter-contracting-workerservice | contracting-workerservice | — (no HTTP) |
| nur-tricenter-gateway | gateway | host 15005 → 8080 |

### ms5 (logistics and delivery)

Repository: [Nur-tricenter/ms5-logistics-and-delivery](https://github.com/Nur-tricenter/ms5-logistics-and-delivery),
cloned by `setup-project` as `ms5-logistics-and-delivery`. Included from
`../ms5-logistics-and-delivery/nurtricenter.compose.yml`. If your checkout has another folder
name, set `NURTRICENTER_REPO_DIR` to it, e.g.
`[Environment]::SetEnvironmentVariable("NURTRICENTER_REPO_DIR", "my-ms5-folder", "User")`.

- The database is whatever the gitignored `.env` in the ms5 repository points to
  (`ConnectionStrings__DefaultConnection=...`). The default in `.env.example` is ms5's private Neon
  database; without a `.env` the ms5 containers start but fail on their first query.
- **Offline option** (no Neon credentials): `setup-project` seeds that `.env` from
  `.env.local-postgres.example` when it is missing, pointing at the platform Postgres, whose
  `ms5_logistics` database `start-stack` creates:

  ```bash
  # ms5-logistics-and-delivery/.env
  ConnectionStrings__DefaultConnection=Host=nur-tricenter-postgres;Port=5432;Database=ms5_logistics;Username=dev-only;Password=dev-only-password
  ```
- The schema is applied by the one-shot `nur-tricenter-nurtricenter-migrate` container
  (`dotnet Nurtricenter.Api.dll --migrate`); the API and the worker wait for it to exit 0. No manual
  `dotnet ef database update` is needed any more.
- Registers in Consul as `nurtricenter`: `curl http://localhost:15005/api/nurtricenter/v1/couriers`
  answers only POST (create a courier); there is no list endpoint.
- Publishes 10 fanout exchanges (`courier-created`, `route-started`, `delivery-failed`, ...),
  declared in `rabbitmq-definitions.json`. Contracts: `Nur.Tricenter.Integration.Messages.Logistics`.

### ms3 (contracting and production)

Repository: [Nur-tricenter/ms3-contract-and-production](https://github.com/Nur-tricenter/ms3-contract-and-production),
cloned by `setup-project` as `ms3-contract-and-production`. Included from
`../ms3-contract-and-production/contracting.compose.yml`.

- Uses the platform Postgres, database `nur_tricenter_contracting` (created by `01-create-databases.sql`;
  the API also creates it on its first migration).
- Registers in Consul as `contracting`: `curl http://localhost:15005/api/contracting/v1/sim/patients/<ms1-patient-id>`
  (patients come from MS1 through `Clinic__BaseUrl`; the 3 simulated ones are only used when it is unset).
- Consumes `ms3.meal-plan-published`, `ms3.recipe-published` and `ms3.recipe-updated` (catalog).
- Calls MS4 through the gateway as service account `ms3-service` (created by `start-stack`):
  `POST /api/delivery-calendar/v1/schedule` after a payment (from its outbox, idempotent by `contractId`) and
  `GET /api/delivery-calendar/v1/calendars/active-tomorrow` for the daily production order.
- Publishes `package-validated` (→ `ms5.package-validated`). Contract: `Nur.Tricenter.Integration.Messages.Contracting`.

### ms1 (clinica nutricional)

Repository `ms1-gestion-clinica-nutricional` (Nur-tricenter), cloned by `setup-project` as a sibling.
`start-stack` builds its API and worker, and `ms1.compose.yml` adds a `--migrate` job, the API and the
outbox worker on the shared network. Database `ms1_clinica_nutricional` on the platform Postgres.

- Registers in Consul as `clinica-nutricional`; the gateway serves it at `/api/clinica-nutricional/v1/...`.
- Every endpoint needs a bearer JWT from identity (there are no MS1 scopes yet, so any valid token works).
- Publishes `paciente-published` (nobody consumes it yet) and serves `POST /api/v1/patients/contact-information`,
  the call MS5 used to make.

This needs the MS1 branch that adds `ms1.compose.yml` (Postgres, JWT, Consul): earlier checkouts of the
repository do not have it.

### Verify

```bash
curl http://localhost:15005/health
curl http://localhost:15005/api/catalog/v1/foods
open http://localhost:8500   # Consul
open http://localhost:15672  # RabbitMQ (guest/guest)
```

### End-to-end smoke test

`scripts/e2e-smoke.py` (Python 3, stdlib only) walks one patient through every service, through the
gateway, and exits non-zero on the first broken hop:

```bash
python scripts/e2e-smoke.py                    # registers a new patient in MS1, successful delivery
python scripts/e2e-smoke.py --fail             # same, but the delivery fails
python scripts/e2e-smoke.py <ms1-patient-id>   # reuse a patient that already exists in MS1
```

MS3 reads patients from MS1 (`Clinic__BaseUrl`), so the script first registers a patient in MS1 and
checks that MS3 rejects an unknown one (404). It creates a plan in MS2, contracts and pays it in MS3 (which creates the MS4 calendar), sets the
address and resolves tomorrow's menu in MS4, builds and validates the package in MS3, and lets MS5
receive it (`package-validated`) into **tomorrow's** route (the message's `DeliveryDate`), deliver it
and report back (`delivery-*`) until MS4 closes the day. It needs MS3, MS4 and MS5 built with
`Nur.Tricenter.Integration` 1.4.0: MS4 links the MS5 delivery to its day by `DeliveryDayId`. Dates are
taken in UTC, like the services, so the script also works after 20:00 Bolivia time.

### Notes

- All business processes are **bind-mounted** from their own repo's `bin/Debug` output. A stale build
  directory is the most common cause of a container that starts and immediately crashes on a missing
  assembly — rebuild the project before restarting.
- `start-stack` builds every included service (and stops on the first failed build), starts the
  infrastructure, creates any missing service database (Postgres runs `postgres-init/` only on a
  brand-new volume), then starts the services and creates the `ms3-service`/`ms4-service` accounts,
  so a fresh clone comes up from a single command after `setup-project`.
- The gateway is the only service always mapped to a host port (sole public entry point). The catalog's
  `18080 → 8080` is dev-only.
- Compose is the source of truth (Aspire AppHost was removed: Aspire 13.6.1 conflicts with the docker
  network namespace on a host that already has containers).
- `ANALISIS-ARQUITECTURA-MS2026.md` (workspace root) is the architecture analysis this stack implements.