# Nur-Tricenter Orchestrator: ms2-plans-and-recipes-catalog

Single command to bring up the full **ms2-plans-and-recipes-catalog**
microservice: its own Postgres, RabbitMQ and Consul, the catalog
(WebApi + WorkerService) and the API Gateway that fronts it. The whole
stack runs in Docker; the three .NET 10 projects run from the host's
`bin/Debug/net10.0` build outputs mounted into the runtime containers.

## What is here

| File | What it is |
|------|------------|
| `Orchestrator.AppHost/` | .NET Aspire AppHost entry point. Compiles, mirrors what Aspire would do in a clean host. The README documents why the Aspire path is not the one this dev environment uses today. |
| `docker-compose.yml` | The root compose. Includes `docker-compose.infra.yml` (Postgres + RabbitMQ + Consul) and adds the three business processes with their bind-mounted outputs. |
| `docker-compose.infra.yml` | Just the platform containers, for cases where you want them up without the business code. |
| `start-stack.{sh,ps1}` | The dev script: cleans stale containers, builds the three projects, brings up the whole stack, applies the catalog schema. |
| `start-infrastructure.{sh,ps1}` | Brings up just the platform containers. |
| `stop-infrastructure.{sh,ps1}` | Tears down the platform containers. |

## Why both Aspire and compose

`ROADMAP-MS2026.md` says the orchestrator is `Store.AppHost`-equivalent in
Aspire. This repo also has the AppHost (`Orchestrator.AppHost/`), so that
the "tal cual la guía" path is preserved as code, and a developer with a
clean host can run `dotnet run --project Orchestrator.AppHost` and get
the same dashboard the guide has.

In practice on a host that already has containers from earlier sessions,
Aspire 13.6.1 fights the existing docker network namespace. The
`start-stack` script uses compose directly, which is predictable and
restarts in seconds. The Fase 7 Dockerfile, when it lands, builds proper
images and the two paths converge: Aspire for the dashboard during dev,
compose for production-like behavior.

## How to use

### Prereqs

- Docker Desktop running.
- .NET SDK 10.0.
- The three sibling repos at the same level: `ms2-plans-and-recipes-catalog`
  and `ms2-plans-and-recipes-catalog-api-gateway` (this orchestrator references them by
  path; it does not clone them).

### Start the whole stack

```bash
# Unix
./start-stack.sh

# Windows
powershell -File start-stack.ps1
```

> **The catalog and the gateway are each in their own repo with their own
> `bin/Debug` output.** The catalog lives at
> `../ms2-plans-and-recipes-catalog/`. The gateway lives at
> `../nur-tricenter-api-gateway/` (its own repo, named after the platform,
> not the microservice). The compose's bind-mount for the gateway points
> at that path; the `container_name` and `hostname` still carry the
> `ms2-plans-and-recipes-catalog-` prefix because, in this layout, the
> gateway exists to front this microservice.

The script:

1. Removes any stale containers under the `ms2-plans-and-recipes-catalog-`
   names (volumes are kept).
2. Builds the three business projects.
3. Brings up infra + the three processes via `docker compose up -d`.
4. Applies the catalog schema with `dotnet Catalog.WebApi.dll --migrate`.

### Verify

```bash
# Consul
open http://localhost:8500

# RabbitMQ
open http://localhost:15672   # guest / guest

# Gateway
curl http://localhost:15005/api/catalog/v1/foods

# Health (Healthy)
curl http://localhost:15005/health
```

### Logs

```bash
docker logs -f ms2-plans-and-recipes-catalog-catalog-webapi
docker logs -f ms2-plans-and-recipes-catalog-catalog-workerservice
docker logs -f ms2-plans-and-recipes-catalog-apigateway-webapp
```

### Tear down

```bash
./stop-infrastructure.sh           # keeps the data volumes
./stop-infrastructure.sh -v        # also drops the data volume
```

## What is where inside the stack

```
ms2-plans-and-recipes-catalog-net  (docker network, the only one)
  |
  +-- ms2-plans-and-recipes-catalog-postgres   :5432   (data: ms2-plans-and-recipes-catalog-postgres-data)
  +-- ms2-plans-and-recipes-catalog-rabbitmq   :5672  :15672
  +-- ms2-plans-and-recipes-catalog-consul     :8500
  +-- ms2-plans-and-recipes-catalog-catalog-webapi         :8080
  +-- ms2-plans-and-recipes-catalog-catalog-workerservice
  +-- ms2-plans-and-recipes-catalog-apigateway-webapp     :8080
                                        host:15005 -> 8080
```

The Gateway learns about `catalog-webapi` through Consul. It is the only
process that needs a port on the host (15005).

## Iteration loop

Edit a business project, then:

```bash
# from the project's directory
dotnet build

# from the orchestrator directory
docker compose restart ms2-plans-and-recipes-catalog-catalog-webapi     # or whichever service
```

The bind-mount means the rebuilt DLLs are picked up on the next restart.
This is the dev loop until the Fase 7 Dockerfile lands.

## Adding a new microservice

1. Create the new repo next to this one, e.g. `ms2-plans-and-recipes-catalog-inventory`.
2. Add it to the orchestrator's `Orchestrator.AppHost/Orchestrator.AppHost.csproj`
   via `<ProjectReference Include="..\..\ms2-plans-and-recipes-catalog-inventory\..." />`.
3. Add two `AddProject<...>(...)` calls to `AppHost.cs`.
4. Add the corresponding compose service to `docker-compose.yml`.
5. The Gateway discovers the new service through Consul without any change
   on its side.

Identity, Inventory, Orders, Payments and Fase 5b (JWT) are out of scope
for this phase by user decision; they arrive later with the same shape.

## See also

- `ROADMAP-MS2026.md` (in the catalog repo) — the project-wide plan.
- `ANALISIS-ARQUITECTURA-MS2026.md` (in the catalog repo) — the guide this
  orchestrator mirrors.
