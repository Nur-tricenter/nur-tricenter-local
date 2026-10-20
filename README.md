# nur-tricenter-local

Brings the whole platform up in Docker for local development: the shared infrastructure
(PostgreSQL, RabbitMQ, Consul) plus every business process that subscribes to a profile.

**This repository is local development only.** Nothing here is deployed: in production the gateway
and each microservice are published on their own.

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

| File | What it is |
|---|---|
| `docker-compose.yml` | Root compose. Includes the infrastructure and adds the business processes with their binaries bind-mounted from the host. |
| `docker-compose.infra.yml` | Platform containers only. |
| `postgres-init/` | Creates one database per microservice. |
| `start-stack.{sh,ps1}` | Dev script: cleans, builds, starts everything, applies the schema. |
| `start-infrastructure.{sh,ps1}` | Starts the platform only. |
| `stop-infrastructure.{sh,ps1}` | Tears the platform down. |
| `Orchestrator.AppHost/` | Aspire AppHost. It compiles and documents the reference path; see below for why it is not the one in use. |

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
./start-stack.sh

# Windows
powershell -File start-stack.ps1
```

The script:

1. Removes stale containers (volumes are kept).
2. Builds the business projects.
3. Brings up infrastructure and the processes with `docker compose up -d`.
4. Applies the catalog schema with `dotnet Catalog.App.dll --migrate`.

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
```

The gateway rewrites `/api/{service}/**` to the service's own route, so
`/api/catalog/v1/foods` reaches `Catalog.App` as `/api/v1/foods`. The gateway refreshes its
routing table from Consul every 30 seconds, so a newly registered service can return 404 for up to
half a minute after it becomes healthy.

## Logs

```bash
docker logs -f nur-tricenter-ms2-plans-and-recipes-catalog-api
docker logs -f nur-tricenter-ms2-plans-and-recipes-catalog-workerservice
docker logs -f nur-tricenter-apigateway-webapp
```

`docker ps` shows container names; `docker exec` and `docker logs` also accept the short ID, which is
what you want to copy while a container is in a restart loop.

## What is where inside the stack

```
nur-tricenter-net  (the only network)
  |
  +-- nur-tricenter-postgres    :5432      host:5433
  |     data volume: nur-tricenter-postgres-data
  +-- nur-tricenter-rabbitmq    :5672      host:5672, :15672
  +-- nur-tricenter-consul      :8500      host:8500
  +-- nur-tricenter-ms2-plans-and-recipes-catalog-api            :8080  (internal)
  +-- nur-tricenter-ms2-plans-and-recipes-catalog-workerservice :8080  (internal)
  +-- nur-tricenter-apigateway-webapp                           :8080  host:15005
```

Only the gateway publishes a host port, because it is the sole public entry point. The business
services are reachable only through it.

Naming follows one convention: platform components keep the `nur-tricenter-` prefix because they
are shared, and a microservice's processes carry the `nur-tricenter-<service>-` prefix because they
belong to that service.

## Iteration loop

```bash
# from the service's directory
dotnet build

# from this directory
docker compose --profile catalog restart catalog-api
```

The bind-mount means rebuilt assemblies are picked up on restart. This is the dev loop until the
generic Dockerfile lands.

## Why both Aspire and compose

The reference architecture's orchestrator is an Aspire AppHost, and `Orchestrator.AppHost/` keeps
that path in code so it can be run and compared: `dotnet run --project Orchestrator.AppHost` gives
the dashboard the guide describes.

In practice, on a host that already has containers from earlier sessions, Aspire 13.6.1 conflicts
with the existing docker network namespace. `start-stack` uses compose directly, which is
predictable and restarts in seconds. Once the generic Dockerfile lands, the two paths converge:
Aspire for the dashboard during development, compose for production-like behaviour.

Note that the two paths are **not** currently equivalent. The AppHost does not inject every variable
the compose does, so its database name and the service registration differ. Treat compose as the
source of truth until that is reconciled.

## See also

- `ROADMAP-MS2026.md` (in the catalog repository) — the project-wide state and gap plan.
- `ANALISIS-ARQUITECTURA-MS2026.md` (in the catalog repository) — the guide this mirrors.
- `nur-tricenter-shared-kernels` — the platform libraries, consumed as NuGet packages.