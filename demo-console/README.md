# Demo console

Presentation dashboard for the whole Nur-Tricenter platform, built for the diplomado final demo.
It runs as one more container of the local stack and is served at **http://localhost:15100**.
The UI text is in Spanish (it is shown to the jury); code and docs are in English.

## What it shows

| View | Requirement it demonstrates | Data source |
|---|---|---|
| Mapa del sistema | Integration of MS1–MS5, gateway, shared kernels | static topology + live HTTP/event animations |
| Recorrido de un pedido | End-to-end integration (the `scripts/e2e-smoke.py` happy path, step by step) | real API calls through the gateway |
| Identidad y seguridad | Endpoint security: 401 / 403 / 2xx with different accounts | identity login + secured endpoints |
| Registro de servicios | Service discovery | Consul HTTP API |
| Eventos del broker | Asynchronous communication through RabbitMQ | event tap (SSE) + RabbitMQ management API |
| Outbox transaccional | Transactional outbox + inbox deduplication | outbox/inbox tables (read-only SQL; MS4's own `OutboxMessages` included) |
| Requisitos del proyecto | The assignment checklist, linked to each view | static |

A permanent "Eventos en vivo" board at the bottom lists every integration event as it crosses the broker.

## How it works

`src/DemoConsole` is a .NET 10 minimal API that serves `wwwroot/` and acts as the page's
backend-for-frontend, so no platform service needs CORS:

| Path | Goes to |
|---|---|
| `/gw/**` | API gateway (YARP). Every business call uses the real gateway. |
| `/consul/**` | Consul HTTP API |
| `/rabbit/**` | RabbitMQ management API (Basic auth added server-side) |
| `/live/events` | Server-sent events: a copy of every integration event |
| `/live/outbox` | Latest outbox (identity, MS1, MS2, MS5 via Joseco; MS3's own table) and inbox rows |
| `/live/lookup/*` | Read-only SQL fallback for the gap X-17 lookups. The UI calls the services' own endpoints first (MS4 `calendars/by-contract`, `calendars/days/{id}/delivery-link`; MS3 `production/orders/{id}/packages`) and only falls back here on a stack built without them |

**Event tap.** `EventTap` declares an exclusive, auto-delete queue `demo-console.tap` and binds it
to every exchange listed in `appsettings.json`. The exchanges are fanout, so the tap receives its
own copy and never takes messages from the real consumer queues. It reconnects every 5 s.

**Read-only SQL.** `PlatformReader` only runs `select` statements. Missing tables or databases
are skipped, so a partially running stack still renders.

## Running

With the stack: `scripts/start-stack.ps1` builds it and starts the `nur-tricenter-demo-console`
container. `wwwroot` is bind-mounted, so front-end edits only need a browser refresh.

Outside Docker (talks to the stack through its published ports):

```powershell
dotnet run --project demo-console/src/DemoConsole --urls http://localhost:15100
```

**Simulated mode.** Tick "Datos simulados" in the sidebar (or open `?modo=sim`) and everything is
answered inside the browser by `js/sim.js`: same paths, status codes, scopes and event order, nothing
persisted. Use it to rehearse without the stack.

## Front-end layout

Plain HTML/CSS/JS, no build step and no CDN (works offline). Classic scripts share the `NT` namespace:

- `js/config.js`, `js/bus.js`, `js/topology.js` (services, events, kernels), `js/util.js`
- `js/api.js` (every call; emits `http` for the map), `js/sim.js`, `js/live.js` (SSE, Consul polling, board)
- `js/views/*.js`, one per sidebar entry; `js/app.js` is the hash router

## Demo script

The full presentation guide (in Spanish, with timing, speaker split, talking points per step,
likely questions and a fallback plan) is in [`GUIA-PRESENTACION.md`](./GUIA-PRESENTACION.md). Short version:

1. **Mapa del sistema**: walk the stations; click MS4 to show what it publishes and consumes.
2. **Recorrido de un pedido**: "Ejecutar todo". Point at the trains crossing the broker on steps 3, 8, 9 and 11.
3. **Identidad y seguridad**: log in as `ms4-service`, then "Probar todos los accesos" (401 / 403 / 200).
4. **Registro de servicios**: `docker stop nur-tricenter-catalog-api`, wait for it to turn red, `docker start` it again.
5. **Outbox transaccional**: the rows created by the run, pending → published.
6. **Requisitos del proyecto**: close on the checklist.
