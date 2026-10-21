# nur-tricenter-local

Brings the whole platform up in Docker for local development: the shared infrastructure
(PostgreSQL, RabbitMQ, Consul) plus every business process that subscribes to a profile.

**This repository is local development only.** Nothing here is deployed: in production the gateway
and each microservice are published on their own.

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
- .NET SDK 8 and 10 — the catalog targets `net8.0`, the gateway `net10.0`.
- The sibling repositories at the same level: `ms2-plans-and-recipes-catalog` and
  `nur-tricenter-api-gateway`. This orchestrator references them by path; it does not clone them.

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

- `ROADMAP-MS2026.md` (in the catalog repository) — the project-wide state and gap plan.
- `ANALISIS-ARQUITECTURA-MS2026.md` (in the catalog repository) — the guide this mirrors.
- `nur-tricenter-shared-kernels` — the platform libraries, consumed as NuGet packages.