// In-browser stand-in for the platform, used to rehearse the demo or build the UI without the
// stack. It follows the real contracts closely (paths, status codes, scopes, event names and
// the order in which events travel) but none of it is persisted.
NT.sim = (function () {
  const U = NT.util;
  const T = NT.topology;
  const wait = ms => U.sleep(ms * (0.8 + Math.random() * 0.4));

  const ALL_SCOPES = [
    "catalog.food:read", "catalog.food:create", "catalog.food:edit",
    "catalog.recipe:read", "catalog.recipe:create", "catalog.recipe:edit",
    "catalog.mealPlan:read", "catalog.mealPlan:create", "catalog.mealPlan:edit",
    "deliveryCalendar.calendar:create", "deliveryCalendar.calendar:read", "deliveryCalendar.calendar:edit",
    "deliveryCalendar.productionOrder:read", "deliveryCalendar.deliveryResult:edit",
    "deliveryCalendar.catalogResolution:manage", "identity.user:manage"
  ];
  const ACCOUNTS = {
    "admin": { password: "admin", admin: true, scopes: ["platform:*"] },
    "ms4-service": { password: "dev-only-ms4-service-password", scopes: ["catalog.mealPlan:read"] },
    "ms3-service": { password: "dev-only-ms3-service-password", scopes: ["deliveryCalendar.calendar:create", "deliveryCalendar.productionOrder:read"] }
  };

  const db = {
    patients: {}, recipes: {}, plans: {}, ms3Plans: new Set(), ms3Patients: new Set(), ms4Menus: {}, ms3Deliveries: {}, contracts: {},
    calendars: {}, nextCalendar: 41, nextDay: 900, orders: {}, packages: {},
    couriers: {}, routes: {}, deliveries: {}, links: {}, nextDelivery: 300
  };
  const down = new Set();
  const outboxRows = [];
  const inboxRows = [];
  const queueStats = {};

  // ---------- tokens ----------
  const b64 = o => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  function issue(user) {
    const acc = ACCOUNTS[user];
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: U.uid(), unique_name: user, iss: "nur-tricenter-identity", aud: "nur-tricenter-clients",
      scope: acc.admin ? ALL_SCOPES : acc.scopes, is_admin: !!acc.admin, iat: now, nbf: now, exp: now + 3600
    };
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.${b64("firma-simulada").slice(0, 43)}`;
  }
  function scopesOf(token) {
    const c = token && U.decodeJwt(token);
    if (!c || c.exp * 1000 < Date.now()) return null;
    return [].concat(c.scope || []);
  }

  // ---------- events + outbox ----------
  // Visual rhythm: outbox row now -> dispatcher publishes after `delay` -> each consumer records
  // an inbox row 400-900 ms later (a little staggered) -> the reaction runs with the first inbox row.
  const INBOX_ROWS_FOR = ["ms2", "ms3", "ms4", "ms5"]; // services that keep an inbox table
  const hop = () => 400 + Math.random() * 500;

  function publish(publisher, exchange, payload, delay = 700) {
    const def = T.eventByName[exchange];
    const row = { id: U.uid(), service: publisher, type: def ? def.type : exchange, createdAt: new Date().toISOString(), processedAt: null, payload };
    outboxRows.unshift(row);
    if (outboxRows.length > 80) outboxRows.pop();
    setTimeout(() => {
      row.processedAt = new Date().toISOString();
      const id = U.uid();
      const receivedAt = new Date().toISOString();
      NT.bus.emit("sim-event", { id, exchange, receivedAt, payload });
      const consumers = def ? def.consumers : [];
      let first = Infinity;
      consumers.forEach((c, k) => {
        const q = `${c}.${exchange}`;
        queueStats[q] = queueStats[q] || { publish: 0, ack: 0 };
        queueStats[q].publish++;
        if (!INBOX_ROWS_FOR.includes(c)) { queueStats[q].ack++; return; }
        const wait = hop() + k * 120;
        first = Math.min(first, wait);
        setTimeout(() => {
          queueStats[q].ack++;
          const now = new Date().toISOString();
          inboxRows.unshift({ id, service: c, type: row.type, receivedAt: now, processedAt: now, payload });
          if (inboxRows.length > 80) inboxRows.pop();
        }, wait);
      });
      if (reactions[exchange]) setTimeout(() => reactions[exchange](payload), isFinite(first) ? first : hop());
    }, delay);
  }

  // What consumers do when an event reaches them.
  const reactions = {
    "meal-plan-published": p => { db.ms3Plans.add(p.PlanId); },
    "paciente-published": p => { db.ms3Patients.add(p.PatientId); },
    "meal-plan-composition-changed": p => { db.ms4Menus[p.PlanId] = p.Days; },
    "contract-activated": p => createCalendar({ id: p.ContractId, patientId: p.PatientId, planId: p.CatalogPlanId }),
    "production-order-ready": p => { db.ms3Deliveries[p.DeliveryDate] = p.Lines; },
    "package-validated": p => {
      const route = Object.values(db.routes).find(r => r.scheduledDate === p.DeliveryDate);
      if (!route) return;
      const deliveryId = U.uid();
      db.deliveries[deliveryId] = { id: deliveryId, routeId: route.id, packageId: p.PackageId, dayId: p.DeliveryDayId, status: "Pending" };
      route.deliveries.push(deliveryId);
      publish("ms5", "delivery-added-to-route", { RouteId: route.id, DeliveryId: deliveryId, PackageId: p.PackageId, PatientId: p.PatientId, DeliveryDayId: p.DeliveryDayId });
    },
    "delivery-added-to-route": p => {
      db.links[p.DeliveryDayId] = p.DeliveryId;
      const day = findDay(p.DeliveryDayId);
      if (day) day.status = "InProduction";
    },
    "delivery-completed": p => closeDay(p.DeliveryId, "Delivered", { photo: p.EvidencePhotoUrl, signature: p.DigitalSignature, at: p.DeliveredAt }),
    "delivery-failed": p => closeDay(p.DeliveryId, "Failed", { reason: p.Reason })
  };

  function findDay(dayId) {
    for (const c of Object.values(db.calendars)) {
      const d = c.days.find(x => x.id === Number(dayId));
      if (d) return d;
    }
    return null;
  }
  function closeDay(deliveryId, status, evidence) {
    const dayId = Object.keys(db.links).find(k => db.links[k] === deliveryId);
    const day = dayId && findDay(dayId);
    if (day) { day.status = status; day.evidence = evidence; }
  }

  // ---------- request routing ----------
  const ok = (response, status = 200) => ({ status, response });
  const problem = (status, title, detail) => ({ status, response: { type: "https://tools.ietf.org/html/rfc9110", title, status, detail } });

  function guard(service, method, path, token) {
    if (service === "identity" || service === "ms3" || service === "ms5") return null;
    const scopes = scopesOf(token);
    if (!scopes) return { status: 401, response: null };
    if (service === "ms1") return null;
    const need = requiredScope(service, method, path);
    return need && !scopes.includes(need) ? { status: 403, response: null } : null;
  }

  function requiredScope(service, method, path) {
    if (service === "ms2") {
      const area = path.startsWith("/recipes") ? "recipe" : path.startsWith("/foods") ? "food" : "mealPlan";
      const verb = method === "GET" ? "read" : (path === "/recipes" || path === "/meal-plans" || path === "/foods") ? "create" : "edit";
      return `catalog.${area}:${verb}`;
    }
    if (path.startsWith("/schedule")) return "deliveryCalendar.calendar:create";
    if (path.startsWith("/calendars/active-tomorrow")) return "deliveryCalendar.productionOrder:read";
    if (path.startsWith("/calendars/resolve-daily-catalog")) return "deliveryCalendar.catalogResolution:manage";
    if (path.includes("/delivery-result")) return "deliveryCalendar.deliveryResult:edit";
    return method === "GET" ? "deliveryCalendar.calendar:read" : "deliveryCalendar.calendar:edit";
  }

  async function handle(service, method, path, body, token) {
    await wait(service === "identity" ? 260 : 180);
    if (down.has(service)) return { status: 404, response: null }; // gateway has no route for it
    const denied = guard(service, method, path, token);
    if (denied) return denied;
    const route = path.split("?")[0];
    const qs = new URLSearchParams(path.split("?")[1] || "");
    const seg = route.split("/").filter(Boolean);

    switch (service) {
      case "identity": {
        if (route === "/auth/login") {
          const acc = ACCOUNTS[body && body.userName];
          if (!acc || acc.password !== body.password) return problem(401, "Credenciales inválidas");
          const t = issue(body.userName);
          return ok({ accessToken: t, expiresIn: 3600, userName: body.userName, isAdministrator: !!acc.admin, scopes: U.decodeJwt(t).scope });
        }
        break;
      }
      case "ms1": {
        if (route === "/Patient/CreatePaciente") {
          const id = U.uid();
          db.patients[id] = Object.assign({ id }, body);
          publish("ms1", "paciente-published", { PatientId: id, DocumentNumber: body.ci, FirstName: body.nombre, LastName: body.apellido, Phone: body.telefono || null });
          return ok({ isSuccess: true, value: id });
        }
        if (seg[0] === "Patient" && method === "GET") {
          const p = db.patients[seg[1]];
          return p ? ok(p) : problem(404, "Paciente no encontrado");
        }
        break;
      }
      case "ms2": {
        if (route === "/recipes" && method === "POST") {
          const id = U.uid();
          db.recipes[id] = { id, name: body.name };
          publish("ms2", "recipe-published", { RecipeId: id, Name: body.name, Instructions: body.instructions });
          return ok({ data: id }, 201);
        }
        if (route === "/meal-plans" && method === "POST") {
          const id = U.uid();
          db.plans[id] = { id, name: body.name, durationType: body.durationType, mealsPerDay: body.mealsPerDay, days: [{ dayNumber: 1, mealTimes: [] }] };
          publish("ms2", "meal-plan-published", { PlanId: id, Name: body.name, DurationType: body.durationType, TotalDays: 15, MealsPerDay: body.mealsPerDay });
          return ok({ data: id }, 201);
        }
        if (route === "/meal-plans/meal-times") {
          const plan = db.plans[body.mealPlanId];
          plan.days[0].mealTimes.push({ mealTimeId: U.uid(), mealTimeType: body.mealTimeType, recipes: [] });
          return ok({ data: true });
        }
        if (route === "/meal-plans/assign-recipes") {
          const plan = db.plans[body.mealPlanId];
          const mt = plan.days[0].mealTimes.find(m => m.mealTimeId === body.mealTimeId);
          body.recipes.forEach(r => mt.recipes.push({ recipeId: r.recipeId, name: db.recipes[r.recipeId].name, rationQuantity: r.rationQuantity }));
          publish("ms2", "meal-plan-composition-changed", {
            PlanId: plan.id,
            Days: plan.days.map(d => ({ DayNumber: d.dayNumber, MealTimes: d.mealTimes.map(m => ({
              Name: m.mealTimeType === 3 ? "Almuerzo" : "Cena", Order: m.mealTimeType,
              Recipes: m.recipes.map(r => ({ RecipeId: r.recipeId, RecipeName: r.name, Rations: r.rationQuantity })) })) }))
          });
          return ok({ data: true });
        }
        if (seg[0] === "meal-plans" && method === "GET") {
          const plan = db.plans[seg[1]];
          return plan ? ok({ data: plan }) : problem(404, "Plan no encontrado");
        }
        break;
      }
      case "ms3": {
        if (route === "/contracts") {
          if (!db.ms3Patients.has(body.patientId)) return problem(404, "Paciente aún no proyectado en MS3", "Esperando paciente-published");
          if (!db.ms3Plans.has(body.catalogPlanId)) return problem(404, "Plan aún no proyectado en MS3", "Esperando meal-plan-published");
          const id = U.uid();
          db.contracts[id] = { id, patientId: body.patientId, planId: body.catalogPlanId, status: "Created" };
          return ok({ id, status: "Created" }, 201);
        }
        if (route === "/billing/charge-plan") {
          const c = db.contracts[body.contractId];
          c.status = "Active";
          publish("ms3", "contract-activated", { ContractId: c.id, PatientId: c.patientId, CatalogPlanId: c.planId, DurationDays: 15, StartDate: U.utcDate(1) }, 900);
          return ok({ invoiceNumber: body.invoiceNumber, amount: body.amount, status: "Paid" });
        }
        if (route === "/production/daily-order") {
          const date = qs.get("productionDate");
          const lines = db.ms3Deliveries[date];
          if (!lines || !lines.length) return problem(404, "Sin calendarios", "NO_CALENDARS: MS3 aún no recibió production-order-ready");
          let order = Object.values(db.orders).find(o => o.date === date);
          if (!order) { order = { id: U.uid(), date, packages: [] }; db.orders[order.id] = order; }
          return ok({ productionOrderId: order.id, productionDate: date, lines });
        }
        if (route === "/production/packages") {
          const order = db.orders[body.productionOrderId];
          const id = U.uid();
          db.packages[id] = { id, orderId: order.id, patientId: body.patientId, status: "Pending" };
          order.packages.push(id);
          return ok({ packageId: id, status: "Pending" }, 201);
        }
        if (route === "/production/packages/assemble") { db.packages[body.packageId].status = "Assembled"; return ok({ status: "Assembled" }); }
        if (route === "/production/packages/label") { db.packages[body.packageId].status = "Labeled"; return ok({ status: "Labeled" }); }
        if (route === "/production/packages/validate") {
          const order = db.orders[body.productionOrderId];
          order.packages.forEach((pid, i) => {
            const pkg = db.packages[pid];
            pkg.status = "Validated";
            const cal = Object.values(db.calendars).find(c => c.patientId === pkg.patientId);
            const day = cal && cal.days.find(d => d.date === order.date);
            const patient = db.patients[pkg.patientId] || {};
            publish("ms3", "package-validated", {
              PackageId: pid, PatientId: pkg.patientId, PatientName: `${patient.nombre || ""} ${patient.apellido || ""}`.trim(),
              ProductionOrderId: order.id, CatalogPlanId: cal && cal.planId, ReleasedAt: new Date().toISOString(),
              DeliveryDate: order.date, DeliveryAddress: day && day.address ? `${day.address.street}, ${day.address.city}` : null,
              TrackingNumber: "NT-" + pid.slice(0, 8).toUpperCase(), Latitude: day && day.address ? day.address.latitude : null,
              Longitude: day && day.address ? day.address.longitude : null, DeliveryDayId: day ? day.id : null, PatientPhone: patient.telefono || null
            }, 700 + i * 250);
          });
          return ok({ productionOrderId: order.id, validated: order.packages.length });
        }
        break;
      }
      case "ms4": {
        if (route === "/calendars/resolve-daily-catalog") {
          const date = qs.get("date");
          let resolved = 0;
          Object.values(db.calendars).forEach(c => c.days.forEach(d => {
            if (d.date === date && d.status === "Scheduled") {
              // Menus come from MS4's own projection of meal-plan-composition-changed; no snapshot yet, no menu.
              const planDay = (db.ms4Menus[c.planId] || []).find(x => x.DayNumber === d.dayNumber);
              const items = planDay ? planDay.MealTimes.flatMap(m => m.Recipes.map(r => ({ mealTime: m.Name, mealTimeOrder: m.Order, recipeId: r.RecipeId, recipeName: r.RecipeName, rations: r.Rations }))) : [];
              if (!items.length) return;
              d.menu = items;
              d.portions = items.reduce((n, i) => n + i.rations, 0);
              d.status = "ReadyForProduction";
              resolved++;
            }
          }));
          const lines = [];
          Object.values(db.calendars).forEach(c => c.days.forEach(d => {
            if (d.date === date && d.status === "ReadyForProduction" && d.address)
              lines.push({ DeliveryDayId: d.id, PatientId: c.patientId, PlanId: c.planId, Hour: null, Address: `${d.address.street}, ${d.address.city}`,
                Latitude: d.address.latitude, Longitude: d.address.longitude,
                Menu: d.menu.map(m => ({ MealTime: m.mealTime, MealTimeOrder: m.mealTimeOrder, RecipeId: m.recipeId, RecipeName: m.recipeName, Rations: m.rations })) });
          }));
          publish("ms4", "production-order-ready", { ProductionOrderId: 1, DeliveryDate: date, ProductionDate: U.utcDate(0), Lines: lines });
          return ok({ date, resolvedDays: resolved });
        }
        if (route === "/calendars/active-tomorrow") return ok(activeTomorrow(qs.get("date")));
        if (seg[0] === "calendars" && seg.length === 2 && method === "GET") {
          const c = db.calendars[seg[1]];
          return c ? ok(c) : problem(404, "Calendario no encontrado");
        }
        if (seg[0] === "calendars" && seg[2] === "addresses") {
          const c = db.calendars[seg[1]];
          const d = c && c.days.find(x => x.id === body.dayId);
          if (!d) return problem(404, "Día no encontrado");
          d.address = { street: body.street, city: body.city, references: body.references, latitude: body.latitude, longitude: body.longitude };
          if (d.status === "Pending") d.status = "Scheduled";
          return ok({ dayId: d.id, address: d.address });
        }
        break;
      }
      case "ms5": {
        if (route === "/couriers") {
          const id = U.uid();
          db.couriers[id] = { id, fullName: body.fullName, status: "Available" };
          publish("ms5", "courier-created", { CourierId: id, FullName: body.fullName, Status: "Available" });
          return ok({ id, fullName: body.fullName, status: "Available" }, 201);
        }
        if (route === "/routes") {
          const id = U.uid();
          db.routes[id] = { id, courierId: body.courierId, scheduledDate: body.scheduledDate, status: "Planned", deliveries: [] };
          publish("ms5", "route-created", { RouteId: id, CourierId: body.courierId, ScheduledDate: body.scheduledDate });
          publish("ms5", "courier-assigned-to-route", { RouteId: id, CourierId: body.courierId }, 1100);
          return ok({ id, status: "Planned" }, 201);
        }
        if (seg[0] === "routes" && seg[2] === "start") {
          const r = db.routes[seg[1]];
          r.status = "InProgress";
          publish("ms5", "route-started", { RouteId: r.id });
          return ok({ id: r.id, status: r.status });
        }
        if (seg[0] === "routes" && seg[2] === "deliveries") {
          const r = db.routes[seg[1]];
          const d = db.deliveries[seg[3]];
          if (!d) return problem(404, "Entrega no encontrada");
          if (seg[4] === "deliver") {
            d.status = "Delivered";
            publish("ms5", "delivery-completed", { DeliveryId: d.id, RouteId: r.id, DeliveredAt: body.deliveredAt, EvidencePhotoUrl: body.evidencePhotoUrl, DigitalSignature: body.digitalSignature });
          } else {
            d.status = "Failed";
            publish("ms5", "delivery-failed", { DeliveryId: d.id, RouteId: r.id, Reason: body.reason });
          }
          if (r.deliveries.every(x => db.deliveries[x].status !== "Pending")) {
            r.status = "Completed";
            publish("ms5", "route-completed", { RouteId: r.id }, 1500);
          }
          return ok({ id: d.id, status: d.status });
        }
        break;
      }
    }
    return problem(404, "Ruta no simulada", `${method} ${path}`);
  }

  function createCalendar(contract) {
    const id = db.nextCalendar++;
    const days = Array.from({ length: 15 }, (_, i) => ({
      id: db.nextDay++, dayNumber: i + 1, date: U.utcDate(i + 1), status: "Pending", address: null, menu: [], portions: 0
    }));
    db.calendars[id] = { id, contractId: contract.id, patientId: contract.patientId, planId: contract.planId, duration: 15, startDate: days[0].date, status: "Active", days };
  }

  function activeTomorrow(date) {
    const out = [];
    Object.values(db.calendars).forEach(c => c.days.forEach(d => {
      if (d.date === date && d.status === "ReadyForProduction")
        out.push({ packId: d.id, patientId: c.patientId, planId: c.planId, hour: "12:00", address: d.address && d.address.street, lat: d.address && d.address.latitude, long: d.address && d.address.longitude, menu: d.menu });
    }));
    return out;
  }

  // ---------- read-side helpers ----------
  function health() {
    const out = {};
    T.services.forEach((s, i) => {
      const st = down.has(s.id) ? "critical" : "passing";
      out[s.id] = { status: st, instances: [{ id: `${s.consul}-${(1000 + i * 37).toString(16)}`, address: `${s.consul}-api`, port: 8080, tags: ["api", "v1"],
        checks: [{ name: "Serf Health Status", status: "passing", output: "Agent alive and reachable" },
                 { name: `HTTP GET http://${s.consul}-api:8080/health`, status: st, output: st === "passing" ? "HTTP GET: 200 OK Output: Healthy" : "dial tcp: connection refused" }] }] };
    });
    return Promise.resolve(out);
  }

  function queues() {
    const list = [];
    T.events.forEach(e => e.consumers.forEach(c => {
      const name = `${c}.${e.name}`;
      const st = queueStats[name] || { publish: 0, ack: 0 };
      list.push({ name, messages: 0, consumers: down.has(c) ? 0 : 1, message_stats: { publish: st.publish, ack: st.ack, deliver_get: st.ack } });
    }));
    return Promise.resolve(list);
  }

  function outbox() {
    return Promise.resolve({ outbox: outboxRows.slice(0, 60), inbox: inboxRows.slice(0, 60) });
  }

  function lookup(kind, id) {
    if (kind === "calendar-by-contract") {
      const c = Object.values(db.calendars).find(x => x.contractId === id);
      return Promise.resolve(c ? { calendarId: c.id } : null);
    }
    if (kind === "packages-by-order") {
      const o = db.orders[id];
      return Promise.resolve(o ? o.packages.map(p => ({ packageId: p, patientId: db.packages[p].patientId, status: db.packages[p].status })) : []);
    }
    if (kind === "scheduled-delivery-by-day") {
      const held = Object.keys(db.ms3Deliveries).find(date => db.ms3Deliveries[date].some(l => l.DeliveryDayId === Number(id)));
      return Promise.resolve(held ? { deliveryDayId: Number(id), deliveryDate: held } : null);
    }
    if (kind === "delivery-by-day") {
      const d = db.links[id];
      return Promise.resolve(d ? { deliveryId: d } : null);
    }
    return Promise.resolve(null);
  }

  function setDown(service, isDown) { isDown ? down.add(service) : down.delete(service); }

  // A little background chatter so the board is never completely still while rehearsing.
  function ambient() {
    setInterval(() => {
      if (Math.random() < 0.5) return;
      const f = { FoodId: U.uid(), Name: ["Quinua", "Pollo", "Palta", "Yogur natural"][Math.floor(Math.random() * 4)], Category: "Base", Calories: 120 + Math.round(Math.random() * 200) };
      publish("ms2", "food-published", f, 400);
    }, 22000);
  }

  return { handle, health, queues, outbox, lookup, setDown, isDown: s => down.has(s), ambient };
})();
