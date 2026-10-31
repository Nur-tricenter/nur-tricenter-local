# Demo support report — platform constraints for the Demo Console

Date: 2026-10-31. Written for the session building `demo-console/`; kept as a record of what the
platform had to add so the demo console could run without CORS hacks or database reads.

**Status:** all three items done and **merged** (PRs below), verified on the local stack through the
gateway; `e2e-smoke.py` is green on both paths (delivered and `--fail`).

> Later change (same day): the inter-service REST calls this report mentions (MS3 → MS4 schedule /
> active-tomorrow, MS3 → MS1 patient, MS4 → MS2 meal plan) were replaced by RabbitMQ events
> (kernel 1.6.0, nur-tricenter-local#12). The lookup endpoints and CORS described here are unchanged.

## PRs

| Repo | PR | Branch |
|---|---|---|
| nur-tricenter-api-gateway | https://github.com/Nur-tricenter/nur-tricenter-api-gateway/pull/1 | `feat/demo-support-cors` |
| ms4-delivery-schedule-management | https://github.com/Nur-tricenter/ms4-delivery-schedule-management/pull/11 | `feat/demo-support-lookups` |
| ms3-contract-and-production | https://github.com/Nur-tricenter/ms3-contract-and-production/pull/10 | `feat/demo-support-order-packages` |
| ms5-logistics-and-delivery | https://github.com/Nur-tricenter/ms5-logistics-and-delivery/pull/9 | `feat/demo-support-lookups` |
| knowledge (docs, merge last) | https://github.com/Nur-tricenter/knowledge/pull/24 | `docs/demo-support-x17` |

## 1. CORS on the gateway

| Key | File | Value |
|---|---|---|
| `Cors:AllowedOrigins` (string array) | `appsettings.json` | `[]` → CORS off (production) |
| | `appsettings.Development.json` (used by the local stack) | `["http://localhost:15100"]` |
| env override | compose / shell | `Cors__AllowedOrigins__0=http://...` |

- Applied right after `UseRouting()`, before `MapReverseProxy()`: preflight answered by the gateway (204).
- Any method and header, **no credentials** (use `Authorization: Bearer`, not cookies; don't set `credentials: 'include'`).
- `Access-Control-Expose-Headers: X-Correlation-Id`, so `response.headers.get('X-Correlation-Id')` works.
- Other origins get no CORS headers. CORS headers are present on 401/403 too, so the browser can read those statuses.
- Since the demo console proxies `/gw/**` same-origin, CORS is only needed if the browser calls `http://localhost:15005` directly.

## 2. Lookup endpoints (gap X-17)

Gateway base: `http://localhost:15005` (or `/gw` through the demo console).

### MS4 — scope `deliveryCalendar.calendar:read` (admin has it; `ms4-service` / `ms3-service` don't). No token → 401, wrong scope → 403.

**`GET /api/delivery-calendar/v1/calendars/by-contract/{contractId}`** → `200 CalendarVm`, `404` until MS3's worker creates it (poll).
```json
{ "id": 49, "patientId": "4fdc3444-…", "contractId": "819ee9f1-…", "planId": "7912e1c9-…", "duration": 15,
  "startDate": "2026-11-01", "status": "Active",
  "days": [ { "id": 259, "dayNumber": 1, "date": "2026-11-01", "status": "Pending", "address": null,
              "deliveryHour": null, "portions": null, "menu": [] } ] }
```
Replaces SQL helper `calendar-by-contract/{id}`.

**`GET /api/delivery-calendar/v1/calendars/by-patient/{patientId}`** → `200 CalendarVm[]`, newest first; `[]` if none.

**`GET /api/delivery-calendar/v1/calendars/days/{dayId}/delivery-link`** → `200`, `404` only if the day doesn't exist.
```json
{ "dayId": 259, "calendarId": 49, "date": "2026-11-01", "dayStatus": "Failed",
  "deliveryId": "de93857a-e3f3-47be-bf7b-d14c930cbb00", "routeId": "855ddcda-2c71-47ab-b089-9bd491ccdaef",
  "linkedAt": "2026-10-31T05:50:33.393618+00:00" }
```
`deliveryId`/`routeId`/`linkedAt` are `null` until `delivery-added-to-route` is consumed → poll until non-null.
Replaces SQL helper `delivery-by-day/{dayId}` (`DeliveryRouteLinks`). `deliveryId` is what `/deliver` and `/fail` need.

### MS3 — anonymous (X-11)

**`GET /api/contracting/v1/production/orders/{productionOrderId}/packages`** → `200`, `404` if neither order nor packages exist.
```json
{ "productionOrderId": "54a02677-…", "productionDate": null, "orderStatus": null, "totalPackages": 1,
  "packages": [ { "packageId": "d6127b59-…", "patientId": "cdbf9714-…", "catalogPlanId": "c1bf3db6-…",
                  "status": "Validated", "trackingNumber": "NTR-D6127B59-20261031",
                  "deliveryAddress": "Av. Banzer 123, Santa Cruz", "validatedAt": "2026-10-31T04:57:51.510477Z" } ] }
```
`status`: `Pending` → `Assembled` → `Labeled` → `Validated`. Replaces SQL helper `packages-by-order/{id}`.
`productionDate`/`orderStatus` are **always null today**: see "Unresolved" (ms3-gap-17).

### MS5 — anonymous (X-03)

**`GET /api/nurtricenter/v1/routes/{routeId}`** → `200`, `404` `Route.NotFound`. Any date (unlike `route/today`).
```json
{ "id": "855ddcda-…", "courierId": "3dd78741-…", "scheduledDate": "2026-11-01", "status": "Completed",
  "createdAt": "2026-10-31T05:50:27.533829Z",
  "deliveries": [ { "deliveryId": "de93857a-…", "routeId": "855ddcda-…", "sequenceOrder": 1, "status": "Failed",
                    "packageId": "82f21563-…", "deliveryDayId": 259, "patientId": "4fdc3444-…",
                    "patientName": "Ana E2E 015010", "patientPhone": null, "address": "Av. Banzer 123, Santa Cruz",
                    "latitude": -17.78, "longitude": -63.18, "deliveredAt": null, "evidencePhotoUrl": null,
                    "failureReason": "Nadie en el domicilio", "createdAt": "2026-10-31T05:50:30.030451Z" } ] }
```

**`GET /api/nurtricenter/v1/deliveries?packageId={ms3PackageId}&deliveryDayId={ms4DayId}`** — at least one filter
(else `400 Delivery.LookupFilterRequired`); `[]` when nothing matches; newest route first.
```json
[ { "delivery": { …same shape as above… }, "courierId": "3dd78741-…", "scheduledDate": "2026-11-01", "routeStatus": "Completed" } ]
```
`packageId` = MS3 package GUID; `deliveryDayId` = MS4 day id. Route `status`: Pending/InProgress/Completed/Cancelled; delivery `status`: Pending/InProgress/Delivered/Failed.

### Suggested flow chaining (no SQL)
contract → `by-contract` (poll) → day id → … → order id from `daily-order` → `orders/{id}/packages` →
validate → `delivery-link` (poll until `deliveryId`) or `deliveries?deliveryDayId=` → `/routes/{id}/start` →
`/deliver` | `/fail` → `GET calendars/{id}` or `delivery-link.dayStatus` until `Delivered`/`Failed`.

## 3. Live event observation (RabbitMQ tap)

Verified, **no RabbitMQ or Consul config change needed** (server-side proxy covers `/rabbit` and `/consul`).

- Live broker has **19** fanout exchanges, not 18: `paciente-published` (MS1) is declared at runtime by MS1 and is
  **not** in `topology/rabbitmq-definitions.json`. Add it to the tap list.
- All exchanges: `fanout`, `durable=false`, `auto_delete=false`. `guest` is administrator with `.*` on vhost `/`.
- Test: bound a temporary queue to all 19 exchanges and ran `e2e-smoke.py` (both paths): it got a copy of every
  event, all consumer queues (`ms3.*`, `ms4.*`, `ms5.package-validated`) stayed at 0 ready with their consumer,
  both runs green. Test queue deleted afterwards. A `demo-console.tap` queue with 1 consumer was already attached
  during the test (your process, presumably) — no interference.
- Tap recommendations:
  - Before `QueueBind`, `ExchangeDeclare(name, "fanout", durable: false, autoDelete: false)` with exactly these flags
    (other flags → 406 PRECONDITION_FAILED and the channel closes). Binding to a missing exchange → 404 and closes the channel.
  - Exchanges are non-durable: a broker restart drops them and their bindings (they come back from the definitions
    import / publisher). Re-declare + re-bind on every reconnect (`AutomaticRecoveryEnabled` + topology recovery, or your own loop).
  - Exclusive, auto-delete, non-durable queue; `autoAck: true` is fine (copies only).
- Backlogs you may see in queue counters are pre-existing (X-06: queues with no consumer, e.g. `ms4.recipe-published`,
  `ms5.meal-plan-published`, `ms5.recipe-published`).

## Unresolved / caveats

1. **PRs not merged.** When they merge, nothing changes locally; if someone checks out `main` before merging,
   the endpoints disappear (the stack bind-mounts each repo's build output). Use `fetch` with a fallback to the SQL helpers until then.
2. **ms3-gap-17 (found here):** `GET /production/daily-order` never commits the order (0 rows in
   `DailyProductionOrders`), so every call returns a **new** `productionOrderId`. Call `daily-order` **once** per flow
   and keep its id; `orders/{id}/packages` still works because it searches packages by id. Not fixed (MS3 owner's call, see ms3-gap-14).
3. Security left as is: MS3 and MS5 lookups are anonymous (X-11, X-03); MS4's need `admin`.
4. `e2e-smoke.py` still uses its SQL lookups; switching it to the new endpoints is a follow-up in this repo (left alone to avoid touching `nur-tricenter-local` while you work in it).
5. First `e2e-smoke.py` right after `start-stack.ps1` can fail at "MS2 read model shows the day-1 recipes" (warm-up, I-10); a second run is green.
6. MS5 test suite has one pre-existing locale failure (`CoordinateTests.ToString_ReturnsFormattedString` on a Spanish-culture machine), unrelated.
7. Login body field is `userName` (`e2e-smoke.py`); `username` also works.
