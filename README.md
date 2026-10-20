# Nur-Tricenter: stack local

Trae arriba toda la plataforma en Docker para desarrollo local: la
infraestructura compartida (Postgres, RabbitMQ, Consul) y los procesos de
negocio que se suscriban al perfil.

Este repo es **solo de desarrollo local**. Nada de lo que hay acá se despliega:
en producción el gateway y cada microservicio se publican por su cuenta.

## Perfiles: agregar un microservicio no requiere tocar nada acá

Cada proceso de negocio declara el perfil al que pertenece:

| Perfil | Qué levanta |
|--------|-------------|
| (ninguno) | Solo la infraestructura: Postgres, RabbitMQ, Consul |
| `catalog` | `catalog-api` + `catalog-workerservice` |
| `gateway` | `apigateway-webapp` |

```bash
docker compose up                        # solo infraestructura
docker compose --profile catalog up       # catálogo + infraestructura
docker compose --profile gateway up       # gateway + infraestructura
docker compose --profile catalog --profile gateway up   # los dos
```

**Por qué importa:** cuando llegue el siguiente microservicio, el equipo lo
agrega en **su propio PR** a su propio compose, o abre uno con el perfil de su
servicio. No hace falta que el dueño de la plataforma edite este archivo, y
por lo tanto no hay conflictos de merge entre equipos.

Si en algún momento se necesita todo junto, se pueden activar varios perfiles
a la vez, como en el último ejemplo.

## Qué hay en este repo

| Archivo | Qué es |
|---------|--------|
| `docker-compose.yml` | Compose raíz. Incluye la infraestructura y agrega los procesos de negocio con sus binarios montados desde el host. |
| `docker-compose.infra.yml` | Solo los contenedores de plataforma. |
| `postgres-init/` | Script que crea una base de datos por microservicio. |
| `start-stack.{sh,ps1}` | Script de desarrollo: limpia, construye y levanta todo. |
| `start-infrastructure.{sh,ps1}` | Levanta solo la plataforma. |
| `stop-infrastructure.{sh,ps1}` | Baja la plataforma. |
| `Orchestrator.AppHost/` | AppHost de Aspire. Compila y documenta el camino de la guía; ver más abajo por qué no es el que se usa. |

## Adding a microservice

Un servicio nuevo necesita, de su lado:

1. Un `docker-compose.yml` propio con `profiles: [<su-nombre>]`
2. Un `CREATE DATABASE <su-nombre>` en su propio script de init
3. Registrarse en Consul con `ServiceRegistration__ServiceName`

Y de este lado: **nada**. El perfil es opt-in, así que un servicio que no
declara perfil no aparece en ningún `up`.

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
4. Applies the catalog schema with `dotnet Catalog.App.dll --migrate`.

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
