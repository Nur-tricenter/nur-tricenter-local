# Nur-Tricenter Orchestrator

Single command to bring up the full Nur-Tricenter stack: Postgres, RabbitMQ,
Consul, the catalog (WebApi + WorkerService) and the API Gateway. The whole
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
  and `nur-tricenter-api-gateway` (this orchestrator references them by
  path; it does not clone them).

### Start the whole stack

```bash
# Unix
./start-stack.sh

# Windows
powershell -File start-stack.ps1
```

The script:

1. Removes any stale containers under the expected names (volumes are kept).
2. Builds the three business projects.
3. Brings up infra + the three processes via `docker compose up -d`.
4. Applies the catalog schema with `dotnet Catalog.WebApi.dll --migrate`.

### Verify

```bash
# Consul
open http://localhost:8500

# RabbitMQ
open http://localhost:15672   # catalogUser / catalogUserPassword

# Gateway
curl http://localhost:15005/api/catalog/v1/foods

# Health (Healthy)
curl http://localhost:15005/health
```

### Logs

```bash
docker logs -f nur-tricenter-catalog-webapi
docker logs -f nur-tricenter-catalog-workerservice
docker logs -f nur-tricenter-apigateway-webapp
```

### Tear down

```bash
./stop-infrastructure.sh           # keeps the data volumes
./stop-infrastructure.sh -v        # also drops the data volume
```

## What is where inside the stack

```
nur-tricenter-net  (docker network, the only one)
  |
  +-- nur-tricenter-postgres   :5432   (data: nur-tricenter-postgres-data)
  +-- nur-tricenter-rabbitmq   :5672  :15672
  +-- nur-tricenter-consul     :8500
  +-- nur-tricenter-catalog-webapi         :8080
  +-- nur-tricenter-catalog-workerservice
  +-- nur-tricenter-apigateway-webapp     :8080
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
docker compose restart nur-tricenter-catalog-webapi     # or whichever service
```

The bind-mount means the rebuilt DLLs are picked up on the next restart.
This is the dev loop until the Fase 7 Dockerfile lands.

## Adding a new microservice

1. Create the new repo next to this one, e.g. `nur-tricenter-inventory`.
2. Add it to the orchestrator's `Orchestrator.AppHost/Orchestrator.AppHost.csproj`
   via `<ProjectReference Include="..\..\nur-tricenter-inventory\..." />`.
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
