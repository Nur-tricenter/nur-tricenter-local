"""End-to-end smoke test of the running platform (start-stack first). Python 3, stdlib only.

Walks one patient through every service, always through the gateway:

  MS2 recipes + plan (meal-plan-published -> MS3, MS4)
  -> MS3 contract + payment -> MS3 worker -> MS4 POST /schedule
  -> MS4 address + resolve-daily-catalog (MS4 -> MS2) -> active-tomorrow
  -> MS3 daily-order (MS3 -> MS4) + package assemble/label/validate
  -> package-validated -> MS5 adds the delivery to today's route
  -> delivery-added-to-route -> MS4 links the delivery to the day
  -> MS5 deliver (or --fail) -> delivery-completed/failed -> MS4 closes the day

Usage:
  python scripts/e2e-smoke.py [patientId] [--fail]

patientId must be one of MS3's simulated patients (00000000-0000-0000-0000-00000000000{1,2,3}).
A few lookups read the databases through `docker exec nur-tricenter-postgres psql`, because no
service exposes them (e.g. which MS4 calendar a contract produced). Exit code 0 = all green.

Needs ms5's package-validated consumer (ms5 `dev` until it is merged to `main`).
"""
import json, subprocess, sys, time, urllib.request, urllib.error, datetime as dt

GW = "http://localhost:15005"
FAILS = []


def call(method, path, body=None, token=None, ok=(200, 201, 204), quiet=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(GW + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            code, raw = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read().decode()
    try:
        payload = json.loads(raw) if raw else None
    except ValueError:
        payload = raw
    good = code in ok
    if not quiet:
        print(f"{'OK ' if good else 'ERR'} {code} {method} {path}")
    if not good and not quiet:
        print("     ", str(payload)[:500])
    return code, payload


def sql(db, q):
    out = subprocess.run(["docker", "exec", "nur-tricenter-postgres", "psql", "-U", "dev-only", "-d", db,
                          "-Atc", q], capture_output=True, text=True)
    return out.stdout.strip()


def wait(desc, fn, timeout=90, every=3):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            print(f"  -> {desc}: {str(v)[:80]}")
            return v
        time.sleep(every)
    print(f"  -> {desc}: TIMEOUT")
    FAILS.append(desc)
    return None


def check(desc, cond):
    print(f"  {'PASS' if cond else 'FAIL'} {desc}")
    if not cond:
        FAILS.append(desc)


def main():
    stamp = dt.datetime.now().strftime("%H%M%S")
    today = dt.date.today()
    tomorrow = today + dt.timedelta(days=1)
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    patient = args[0] if args else "00000000-0000-0000-0000-000000000002"
    fail = "--fail" in sys.argv

    print("== identity")
    _, p = call("POST", "/api/identity-service/v1/auth/login", {"userName": "admin", "password": "admin"})
    tok = p["accessToken"]

    print("== MS2: recipes + 15-day plan with a day-1 menu")
    recipes = []
    for name in ("Majadito", "Sopa de mani"):
        _, r = call("POST", "/api/catalog/v1/recipes", {"name": f"{name} {stamp}", "instructions": "Cocinar."}, tok)
        recipes.append(r["data"])
    _, r = call("POST", "/api/catalog/v1/meal-plans",
                {"name": f"Plan E2E {stamp}", "durationType": "FIFTEEN_DAYS", "mealsPerDay": 2}, tok)
    plan = r["data"]
    for meal_type, recipe in ((3, recipes[0]), (5, recipes[1])):
        call("POST", "/api/catalog/v1/meal-plans/meal-times", {"mealPlanId": plan, "dayNumber": 1, "mealTimeType": meal_type}, tok)
    full = wait("MS2 read model has the plan", lambda: (lambda r: r[1] if r[0] == 200 else None)(
        call("GET", f"/api/catalog/v1/meal-plans/{plan}", token=tok, quiet=True)), timeout=60)
    if not full:
        FAILS.append("aborted")
        return

    day1 = next(d for d in full["data"]["days"] if d["dayNumber"] == 1)
    for mt, recipe in zip(day1["mealTimes"], recipes):
        call("POST", "/api/catalog/v1/meal-plans/assign-recipes",
             {"mealPlanId": plan, "mealTimeId": mt["mealTimeId"], "recipes": [{"recipeId": recipe, "rationQuantity": 1}]}, tok)
    # MS2's read model is projected by its worker: wait until day 1 shows both recipes.
    wait("MS2 read model shows the day-1 recipes", lambda: (lambda r: r[0] == 200 and sum(
        len(m["recipes"]) for m in r[1]["data"]["days"][0]["mealTimes"]) == 2)(
        call("GET", f"/api/catalog/v1/meal-plans/{plan}", token=tok, quiet=True)), timeout=60)

    print("== MS3: wait for the plan projection, contract, pay")
    contract = wait("MS3 knows the plan (meal-plan-published)", lambda: (
        lambda c: c[1]["id"] if c[0] == 201 else None)(
        call("POST", "/api/contracting/v1/contracts", {"patientId": patient, "catalogPlanId": plan}, quiet=True)))
    if not contract:
        FAILS.append("aborted")
        return
    call("POST", "/api/contracting/v1/billing/charge-plan",
         {"contractId": contract, "amount": 150.0, "invoiceNumber": f"inv-e2e-{stamp}"})

    print("== MS4: calendar created by MS3's worker")
    cal = wait("MS4 calendar for the contract", lambda: sql(
        "ms4_delivery_calendar", f"select \"Id\" from \"DeliveryCalendars\" where \"ContractId\"='{contract}'"))
    if not cal:
        FAILS.append("aborted")
        return
    _, c = call("GET", f"/api/delivery-calendar/v1/calendars/{cal}", token=tok)
    first = min(c["days"], key=lambda d: d["dayNumber"])
    check(f"day 1 is tomorrow ({first['date']})", first["date"] == tomorrow.isoformat())
    day_id = first["id"]

    print("== MS4: patient sets the address, ops resolves tomorrow's catalog")
    call("POST", f"/api/delivery-calendar/v1/calendars/{cal}/addresses",
         {"dayId": day_id, "street": "Av. Banzer 123", "city": "Santa Cruz", "latitude": -17.78,
          "longitude": -63.18, "references": "porton verde", "notes": None}, tok)
    call("POST", f"/api/delivery-calendar/v1/calendars/resolve-daily-catalog?date={tomorrow}", token=tok)
    _, at = call("GET", f"/api/delivery-calendar/v1/calendars/active-tomorrow?date={tomorrow}", token=tok)
    mine = [x for x in at if x["packId"] == day_id]
    check("active-tomorrow lists the day with its menu", bool(mine) and bool(mine[0].get("menu")))

    print("== MS5: courier + today's route (must exist before the package arrives)")
    _, courier = call("POST", "/api/nurtricenter/v1/couriers", {"fullName": f"Repartidor {stamp}"})
    _, route = call("POST", "/api/nurtricenter/v1/routes", {"courierId": courier["id"], "scheduledDate": today.isoformat()})

    print("== MS3: production order, package, assemble, label, validate")
    _, order = call("GET", f"/api/contracting/v1/production/daily-order?productionDate={tomorrow}")
    if not isinstance(order, dict) or "productionOrderId" not in order:
        FAILS.append("aborted")
        return
    oid = order["productionOrderId"]
    _, pkg = call("POST", "/api/contracting/v1/production/packages",
                  {"productionOrderId": oid, "patientId": patient, "catalogPlanId": plan})
    pid = pkg["packageId"]
    # validate covers EVERY package of the order (ms3-gap-04): push leftovers of earlier runs too.
    rows = sql("nur_tricenter_contracting",
               f"select \"Id\"||'|'||\"PatientId\"||'|'||\"Status\" from \"Packages\" where \"ProductionOrderId\"='{oid}'")
    for row in rows.splitlines():
        p_id, p_patient, status = row.split("|")
        if status == "Pending":
            call("POST", "/api/contracting/v1/production/packages/assemble", {"packageId": p_id, "staffId": "staff-01"})
            status = "Assembled"
        if status == "Assembled":
            call("POST", "/api/contracting/v1/production/packages/label", {"packageId": p_id, "patientId": p_patient})
    call("POST", "/api/contracting/v1/production/packages/validate",
         {"productionOrderId": oid, "supervisorId": "sup-01", "batchValidated": True, "totalValidatedCount": 0})

    print("== MS5: package-validated consumed into today's route")
    delivery = wait("delivery on the route", lambda: (lambda r: next(
        (d["packageDeliveryId"] for d in r[1].get("deliveries", []) if d.get("patientName") == patient), None)
        if r[0] == 200 else None)(
        call("GET", f"/api/nurtricenter/v1/couriers/{courier['id']}/route/today", quiet=True)))
    if not delivery:
        FAILS.append("aborted")
        return

    print("== MS4: delivery-added-to-route linked to the day")
    wait("MS4 link (DeliveryRouteLinks)", lambda: sql(
        "ms4_delivery_calendar", f"select \"DayId\" from \"DeliveryRouteLinks\" where \"DeliveryId\"='{delivery}'"), timeout=30)

    print("== MS5: start route, deliver")
    call("POST", f"/api/nurtricenter/v1/routes/{route['id']}/start")
    if fail:
        call("POST", f"/api/nurtricenter/v1/routes/{route['id']}/deliveries/{delivery}/fail",
             {"reason": "Nadie en el domicilio"})
    else:
        call("POST", f"/api/nurtricenter/v1/routes/{route['id']}/deliveries/{delivery}/deliver",
             {"deliveredAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "evidencePhotoUrl": "https://example.org/f.jpg",
              "digitalSignature": "firma"})

    expected = "Failed" if fail else "Delivered"
    print(f"== MS4: day closed by delivery-{'failed' if fail else 'completed'}")
    wait(f"day status {expected}", lambda: (lambda c: next(
        (d["status"] for d in c[1]["days"] if d["id"] == day_id and d["status"] == expected), None))(
        call("GET", f"/api/delivery-calendar/v1/calendars/{cal}", token=tok, quiet=True)), timeout=40)


if __name__ == "__main__":
    main()
    print("\nRESULT:", "ALL GREEN" if not FAILS else "FAILED -> " + "; ".join(FAILS))
    sys.exit(1 if FAILS else 0)
