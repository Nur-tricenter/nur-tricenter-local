// "Pedido en vivo": the e2e-smoke.py happy path, one clickable step at a time, told on one screen:
// big canvas (NT.canvas), order dossier, narrated caption and a stepper. Every call goes through the
// real gateway (or the in-browser simulation); the step logic below is verified against the platform.
NT.views.flujo = (function () {
  const U = NT.util, T = NT.topology, api = NT.api;

  const state = { ctx: {}, status: {}, calls: {}, notes: {}, current: 0, running: false, outcome: "deliver", all: false, paused: false, result: null };
  let root = null, stageEl = null, offs = [], capturing = null;
  let viewed = -1, typeTimer = null, detachInspect = null, boardPrev = null, litKeys = {}, sigs = {};

  const reduced = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

  const expect = (r, codes, what) => {
    if (!codes.includes(r.status)) {
      const detail = r.response && (r.response.detail || r.response.title || r.response.error);
      throw new Error(`${what}: respondió ${r.status || "sin conexión"}${detail ? " (" + detail + ")" : ""}`);
    }
    return r.response;
  };

  async function poll(desc, fn, timeoutMs = 90000, everyMs = 2500) {
    const end = Date.now() + timeoutMs;
    note(`Esperando: ${desc}…`);
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await U.sleep(everyMs);
    }
    throw new Error(`Tiempo agotado esperando: ${desc}`);
  }

  // Notes belong to the step that is running, even if the viewer clicked another chip meanwhile.
  function note(text) {
    const i = capturing !== null ? capturing : state.current;
    (state.notes[i] = state.notes[i] || []).push(text);
    renderCaption();
  }

  // `what` / `data` / `why` are the narration shown in the caption (`backticks` render as code).
  const steps = [
    { svc: "identity", title: "Iniciar sesión", short: "Sesión", desc: "El usuario obtiene un JWT de Identity.",
      what: "El usuario inicia sesión y Identity le entrega un JWT con sus permisos (scopes).",
      data: "`POST /auth/login` {userName, password} → 200 {accessToken}",
      why: "El token viaja en cada llamada y cada servicio lo valida por su cuenta, sin consultar a Identity: identidad centralizada, validación distribuida.",
      async run(c) {
        const r = await api.login("admin", "admin");
        expect(r, [200], "Login");
        note(`Token emitido para admin con ${U.claimScopes(api.claims).length} scopes. Todas las llamadas siguientes lo envían en Authorization: Bearer.`);
      } },
    { svc: "ms1", title: "Registrar paciente", short: "Paciente", desc: "MS1 guarda al paciente y publica paciente-published por su outbox; MS3 lo proyecta.",
      what: "MS1 registra al paciente y lo anuncia al resto de la plataforma como un evento.",
      data: "`POST /Patient/CreatePaciente` {ci, nombre, apellido, telefono} → 200 · evento `paciente-published` (outbox de MS1)",
      why: "MS3 no llama a MS1: conocerá al paciente porque proyecta paciente-published. Desacople por eventos, no por REST.",
      async run(c) {
        c.stamp = U.stamp();
        const r = await api.call("ms1", "POST", "/Patient/CreatePaciente", { body: { ci: `DEMO${c.stamp}`, nombre: "Ana", apellido: `Demo ${c.stamp}`, telefono: "+591 700 55555" } });
        const v = expect(r, [200], "Crear paciente");
        c.patientId = v.value;
        expect(await api.call("ms1", "GET", `/Patient/${c.patientId}`), [200], "Leer paciente");
      } },
    { svc: "ms2", title: "Crear recetas y plan de 15 días", short: "Plan y recetas", desc: "MS2 publica recipe-published, meal-plan-published y meal-plan-composition-changed; MS3 y MS4 los proyectan.",
      what: "MS2 crea dos recetas y un plan de 15 días, y asigna las recetas al día 1.",
      data: "`POST /recipes`, `POST /meal-plans`, `POST /meal-plans/assign-recipes` → eventos `recipe-published`, `meal-plan-published`, `meal-plan-composition-changed`",
      why: "MS3 y MS4 guardan su propia proyección del catálogo. La lectura de MS2 es eventualmente consistente (CQRS): por eso la consola espera con polling.",
      async run(c) {
        c.recipes = [];
        for (const name of ["Majadito", "Sopa de maní"]) {
          const r = await api.call("ms2", "POST", "/recipes", { body: { name: `${name} ${c.stamp}`, instructions: "Cocinar a fuego lento." } });
          c.recipes.push(expect(r, [200, 201], "Crear receta").data);
        }
        const p = await api.call("ms2", "POST", "/meal-plans", { body: { name: `Plan Demo ${c.stamp}`, durationType: "FIFTEEN_DAYS", mealsPerDay: 2 } });
        c.planId = expect(p, [200, 201], "Crear plan").data;
        for (const type of [3, 5]) expect(await api.call("ms2", "POST", "/meal-plans/meal-times", { body: { mealPlanId: c.planId, dayNumber: 1, mealTimeType: type } }), [200, 201, 204], "Agregar tiempo de comida");
        const full = await poll("el modelo de lectura de MS2 muestre el plan", async () => {
          const r = await api.call("ms2", "GET", `/meal-plans/${c.planId}`, { quiet: true });
          return r.status === 200 && r.response.data.days.length ? r.response.data : null;
        }, 60000);
        const day1 = full.days.find(d => d.dayNumber === 1);
        for (let i = 0; i < day1.mealTimes.length && i < c.recipes.length; i++) {
          expect(await api.call("ms2", "POST", "/meal-plans/assign-recipes", { body: { mealPlanId: c.planId, mealTimeId: day1.mealTimes[i].mealTimeId, recipes: [{ recipeId: c.recipes[i], rationQuantity: 1 }] } }), [200, 201, 204], "Asignar receta");
        }
        await poll("el día 1 tenga sus dos recetas", async () => {
          const r = await api.call("ms2", "GET", `/meal-plans/${c.planId}`, { quiet: true });
          return r.status === 200 && r.response.data.days[0].mealTimes.reduce((n, m) => n + m.recipes.length, 0) >= 2;
        }, 60000);
        note("Plan listo. meal-plan-published viajó a MS3 y MS4; cada receta asignada publicó meal-plan-composition-changed con el plan completo, y MS4 lo guardó como proyección.");
      } },
    { svc: "ms3", title: "Contratar y cobrar", short: "Contrato", desc: "MS3 acepta el contrato cuando ya proyectó el plan y el paciente a partir de eventos. No llama a MS1 ni a MS2.",
      what: "MS3 crea el contrato del paciente y registra el cobro del plan.",
      data: "`POST /contracts` {patientId, catalogPlanId} → 201 {id} · `POST /billing/charge-plan` → evento `contract-activated`",
      why: "El contrato solo se acepta cuando MS3 ya proyectó plan y paciente (reintenta hasta lograrlo). MS3 nunca pregunta a MS1 ni a MS2.",
      async run(c) {
        const r = await poll("que MS3 conozca el plan y el paciente (meal-plan-published y paciente-published)", async () => {
          const x = await api.call("ms3", "POST", "/contracts", { body: { patientId: c.patientId, catalogPlanId: c.planId }, quiet: true });
          return x.status === 201 ? x : null;
        }, 90000, 3000);
        NT.bus.emit("http", Object.assign({}, r, { quiet: false }));
        c.contractId = r.response.id;
        expect(await api.call("ms3", "POST", "/billing/charge-plan", { body: { contractId: c.contractId, amount: 150.0, invoiceNumber: `inv-demo-${c.stamp}` } }), [200, 201], "Cobro");
        note("Pagado. El worker de MS3 publica contract-activated desde su outbox; MS4 lo consume y crea el calendario. No hay llamada REST entre los dos.");
      } },
    { svc: "ms4", title: "Calendario de entregas creado", short: "Calendario", desc: "MS4 consumió contract-activated y creó 15 días pendientes.",
      what: "MS4 crea solo el calendario de 15 días: nadie se lo pidió por REST.",
      data: "evento `contract-activated` → MS4 crea 15 días Pending · la consola solo lee `GET /calendars/{id}`",
      why: "Un evento basta para disparar un proceso en otro servicio. Si MS4 estuviera caído, el mensaje esperaría en la cola y se procesaría al volver.",
      async run(c) {
        const found = await poll("el calendario del contrato en MS4", () => api.lookup("calendar-by-contract", c.contractId), 60000);
        c.calendarId = found.calendarId;
        const cal = expect(await api.call("ms4", "GET", `/calendars/${c.calendarId}`), [200], "Leer calendario");
        const first = cal.days.reduce((a, b) => (a.dayNumber < b.dayNumber ? a : b));
        c.dayId = first.id;
        c.deliveryDate = first.date;
        note(`Calendario ${c.calendarId} con ${cal.days.length} días. El día 1 (${first.date}) es mañana en UTC.`);
      } },
    { svc: "ms4", title: "Dirección y menú de mañana", short: "Menú", desc: "El paciente registra la dirección; MS4 resuelve el menú con su proyección del plan de MS2 y publica production-order-ready.",
      what: "El paciente registra su dirección y MS4 resuelve el menú de mañana.",
      data: "`POST /calendars/{id}/addresses` · `POST /calendars/resolve-daily-catalog` → evento `production-order-ready` {lines}",
      why: "MS4 arma el menú con su propia proyección del plan de MS2, sin llamarle. La orden de producción llega a MS3 como evento.",
      async run(c) {
        expect(await api.call("ms4", "POST", `/calendars/${c.calendarId}/addresses`, { body: { dayId: c.dayId, street: "Av. Banzer 123", city: "Santa Cruz", latitude: -17.78, longitude: -63.18, references: "Portón verde", notes: null } }), [200, 201], "Dirección");
        // The menu comes from MS4's projection of meal-plan-composition-changed (asynchronous), so an early
        // run leaves the day Scheduled. The job is idempotent: rerun it until the day has its menu.
        const mine = await poll("que MS4 resuelva el menú del día con la composición que publicó MS2", async () => {
          const r = await api.call("ms4", "POST", `/calendars/resolve-daily-catalog?date=${c.deliveryDate}`, { quiet: true });
          if (![200, 204].includes(r.status)) return null;
          const a = await api.call("ms4", "GET", `/calendars/active-tomorrow?date=${c.deliveryDate}`, { quiet: true });
          const day = a.status === 200 ? (a.response || []).find(x => x.packId === c.dayId) : null;
          return day && (day.menu || []).length ? day : null;
        }, 90000, 3000);
        note(`Menú resuelto: ${(mine.menu || []).map(m => U.pick(m, "recipeName") || U.pick(m, "name")).filter(Boolean).join(", ") || "sin recetas"}. MS4 publicó production-order-ready con la orden completa; MS3 la proyecta.`);
      } },
    { svc: "ms5", title: "Repartidor y ruta de mañana", short: "Repartidor", desc: "MS5 crea el repartidor y su ruta; publica courier-created y route-created.",
      what: "MS5 da de alta un repartidor y crea su ruta para mañana.",
      data: "`POST /couriers`, `POST /routes` {courierId, scheduledDate} → eventos `courier-created`, `route-created`",
      why: "Estos eventos aún no tienen consumidores y se publican igual: quien los necesite mañana se suscribe sin tocar a MS5.",
      async run(c) {
        const k = expect(await api.call("ms5", "POST", "/couriers", { body: { fullName: `Repartidor ${c.stamp}` } }), [200, 201], "Repartidor");
        c.courierId = k.id;
        const r = expect(await api.call("ms5", "POST", "/routes", { body: { courierId: c.courierId, scheduledDate: c.deliveryDate } }), [200, 201], "Ruta");
        c.routeId = r.id;
      } },
    { svc: "ms3", title: "Producir y validar el paquete", short: "Paquete", desc: "MS3 arma la orden del día con lo que proyectó de production-order-ready, empaqueta, etiqueta y valida. Publica package-validated.",
      what: "MS3 arma la orden del día, empaca, etiqueta y valida el paquete.",
      data: "`GET /production/daily-order` · `POST /production/packages`, `…/assemble`, `…/label`, `…/validate` → evento `package-validated`",
      why: "La orden sale de lo que MS3 proyectó de production-order-ready (MS4). Al validar, MS5 se entera por evento, no por una llamada.",
      async run(c) {
        // MS3 builds the order from its projection of MS4's production-order-ready: wait until it holds this day.
        await poll("que MS3 proyecte production-order-ready de MS4 con este día", () => api.lookup("scheduled-delivery-by-day", c.dayId), 60000, 2000);
        const o = expect(await api.call("ms3", "GET", `/production/daily-order?productionDate=${c.deliveryDate}`), [200], "Orden de producción");
        c.productionOrderId = o.productionOrderId;
        const p = expect(await api.call("ms3", "POST", "/production/packages", { body: { productionOrderId: c.productionOrderId, patientId: c.patientId, catalogPlanId: c.planId } }), [200, 201], "Paquete");
        c.packageId = p.packageId;
        const pkgs = await api.lookup("packages-by-order", c.productionOrderId) || [];
        for (const pk of pkgs) {
          let st = pk.status;
          if (st === "Pending") { expect(await api.call("ms3", "POST", "/production/packages/assemble", { body: { packageId: pk.packageId, staffId: "staff-01" } }), [200, 204], "Ensamblar"); st = "Assembled"; }
          if (st === "Assembled") expect(await api.call("ms3", "POST", "/production/packages/label", { body: { packageId: pk.packageId, patientId: pk.patientId } }), [200, 204], "Etiquetar");
        }
        expect(await api.call("ms3", "POST", "/production/packages/validate", { body: { productionOrderId: c.productionOrderId, supervisorId: "sup-01", batchValidated: true, totalValidatedCount: 0 } }), [200, 204], "Validar");
        note(`${pkgs.length} paquete(s) validados. package-validated sale del outbox de MS3 hacia MS5.`);
      } },
    { svc: "ms5", title: "Entrega asignada a la ruta", short: "Asignación", desc: "Sin llamadas del navegador: MS5 consume package-validated y MS4 consume delivery-added-to-route.",
      what: "Sin llamadas del navegador: los servicios se coordinan solos por eventos.",
      data: "`package-validated` → MS5 agrega la entrega a la ruta → `delivery-added-to-route` → MS4 vincula día ↔ entrega",
      why: "Dos saltos asíncronos por el broker. El inbox de cada consumidor recuerda lo ya procesado: un mensaje repetido no duplica nada (idempotencia).",
      async run(c) {
        const link = await poll("que MS4 vincule la entrega de MS5 al día", () => api.lookup("delivery-by-day", c.dayId), 90000);
        c.deliveryId = link.deliveryId;
        note(`Entrega ${String(c.deliveryId).slice(0, 8)}… vinculada al día ${c.dayId}. Dos saltos asíncronos por el broker.`);
      } },
    { svc: "ms5", title: "Iniciar ruta y entregar", short: "Entrega", desc: "El repartidor sale y cierra la entrega con evidencia, o la marca fallida.",
      what: () => state.outcome === "deliver"
        ? "El repartidor inicia la ruta y entrega el pedido con foto y firma."
        : "El repartidor inicia la ruta, pero no encuentra a nadie y marca la entrega como fallida.",
      data: () => state.outcome === "deliver"
        ? "`POST /routes/{id}/start` · `POST …/deliver` {evidencePhotoUrl, digitalSignature} → evento `delivery-completed`"
        : "`POST /routes/{id}/start` · `POST …/fail` {reason} → evento `delivery-failed`",
      why: "MS5 solo informa el resultado como evento. No sabe quién lo escuchará ni qué hará con él.",
      async run(c) {
        expect(await api.call("ms5", "POST", `/routes/${c.routeId}/start`), [200, 204], "Iniciar ruta");
        if (state.outcome === "deliver") {
          expect(await api.call("ms5", "POST", `/routes/${c.routeId}/deliveries/${c.deliveryId}/deliver`, { body: { deliveredAt: new Date().toISOString().slice(0, 19) + "Z", evidencePhotoUrl: "https://example.org/entrega.jpg", digitalSignature: "firma-ana" } }), [200, 204], "Entregar");
        } else {
          expect(await api.call("ms5", "POST", `/routes/${c.routeId}/deliveries/${c.deliveryId}/fail`, { body: { reason: "Nadie en el domicilio" } }), [200, 204], "Marcar fallida");
        }
      } },
    { svc: "ms4", title: "Día cerrado en el calendario", short: "Día cerrado", desc: "MS4 consume delivery-completed o delivery-failed y cierra el día. Nadie lo cambia a mano.",
      what: "MS4 cierra el día del calendario por sí solo al recibir el evento de MS5.",
      data: () => state.outcome === "deliver"
        ? "evento `delivery-completed` → el día pasa a Delivered · la consola solo lee `GET /calendars/{id}`"
        : "evento `delivery-failed` → el día pasa a Failed · la consola solo lee `GET /calendars/{id}`",
      why: "Nadie cambia el estado a mano: la consistencia entre MS5 y MS4 la da el evento. Un pedido cruzó 5 microservicios sin una sola llamada entre ellos.",
      async run(c) {
        const want = state.outcome === "deliver" ? "Delivered" : "Failed";
        const day = await poll(`que el día quede ${want}`, async () => {
          const r = await api.call("ms4", "GET", `/calendars/${c.calendarId}`, { quiet: true });
          return r.status === 200 ? r.response.days.find(d => d.id === c.dayId && d.status === want) : null;
        }, 45000);
        await api.call("ms4", "GET", `/calendars/${c.calendarId}`);
        note(`Día ${day.id}: ${want === "Delivered" ? "entregado" : "fallido"}. Recorrido completo a través de 5 microservicios.`);
      } }
  ];

  const text = v => (typeof v === "function" ? v() : v);

  async function runStep(i) {
    if (state.running) return false;
    state.running = true;
    state.current = i;
    state.status[i] = "running";
    state.calls[i] = [];
    state.notes[i] = [];
    capturing = i;
    NT.bus.emit("step", { index: i, svc: steps[i].svc, title: steps[i].title, phase: "start" });
    refresh();
    let ok = false;
    try {
      await steps[i].run(state.ctx);
      state.status[i] = "done";
      if (i === steps.length - 1) state.result = state.outcome;
      ok = true;
      return true;
    } catch (e) {
      state.status[i] = "failed";
      note(e.message);
      U.toast(e.message, "bad");
      return false;
    } finally {
      NT.bus.emit("step", { index: i, svc: steps[i].svc, title: steps[i].title, phase: ok ? "done" : "failed" });
      capturing = null;
      state.running = false;
      refresh();
    }
  }

  async function runFrom(i) {
    if (state.all || state.running) return;
    state.all = true;
    refresh();
    try {
      for (let k = i; k < steps.length; k++) {
        if (state.status[k] === "done") continue;
        // Pause takes effect between steps.
        while (state.paused && state.all && root) await U.sleep(150);
        if (!state.all || !root) return;
        const ok = await runStep(k);
        if (!ok || !root || !state.all) return;
        await U.sleep(900);
      }
    } finally {
      state.all = false;
      state.paused = false;
      refresh();
    }
  }

  const nextIndex = () => { const i = steps.findIndex((_, k) => state.status[k] !== "done"); return i < 0 ? steps.length : i; };

  // ---------- helpers ----------
  const md = s => U.esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  const shortId = v => {
    const s = String(v);
    return s.length > 14 && !/\s/.test(s) ? s.slice(0, 8) + "…" : s;
  };
  const trimPath = p => String(p || "").replace(/^\/api\/[^/]+\/v1/, "");
  const svcName = id => (T.byId[id] ? T.byId[id].name : id);
  const setIf = (el, key, html) => { if (sigs[key] !== html) { sigs[key] = html; el.innerHTML = html; } };

  // ---------- dossier ----------
  const lastCall = (step, re, method) => {
    const list = state.calls[step] || [];
    for (let k = list.length - 1; k >= 0; k--) if ((!method || list[k].method === method) && re.test(list[k].path)) return list[k];
    return null;
  };
  const dayOf = () => {
    const r = lastCall(4, /\/calendars\/[^/?]+$/, "GET");
    return r && r.response && r.response.days ? r.response.days.find(d => d.id === state.ctx.dayId) : null;
  };

  const chips = [
    { key: "token", label: "Token JWT", svc: "identity", step: 0,
      get: () => (state.status[0] === "done" || capturing === 0) && api.token ? api.token : undefined,
      show: () => `${U.claimName(api.claims) || "sesión"} · JWT`,
      origin: "Identity emitió el token en POST /auth/login. Los demás servicios lo validan por su cuenta (AddSecurity), sin llamar a Identity.",
      call: () => lastCall(0, /auth\/login/), extra: () => ({ label: "Claims del token", data: api.claims, kind: "json" }) },
    { key: "patient", label: "Paciente", svc: "ms1", step: 1, get: () => state.ctx.patientId,
      origin: "MS1 · POST /Patient/CreatePaciente. Publicó paciente-published por su outbox; MS3 lo proyectó.",
      call: () => lastCall(1, /CreatePaciente/, "POST") },
    { key: "plan", label: "Plan", svc: "ms2", step: 2, get: () => state.ctx.planId,
      origin: "MS2 · POST /meal-plans. meal-plan-published llegó a MS3 y MS4.",
      call: () => lastCall(2, /\/meal-plans$/, "POST") },
    { key: "contract", label: "Contrato", svc: "ms3", step: 3, get: () => state.ctx.contractId,
      origin: "MS3 · POST /contracts (201). Tras el cobro, contract-activated salió del outbox de MS3.",
      call: () => lastCall(3, /\/contracts$/, "POST") },
    { key: "calendar", label: "Calendario", svc: "ms4", step: 4, get: () => state.ctx.calendarId,
      origin: "MS4 creó el calendario al consumir contract-activated; la consola solo lo leyó (GET /calendars/{id}).",
      call: () => lastCall(4, /\/calendars\/[^/?]+$/, "GET") },
    { key: "day", label: "Día de entrega", svc: "ms4", step: 4, get: () => (state.ctx.dayId ? state.ctx.deliveryDate : undefined),
      full: () => `${state.ctx.deliveryDate} · día ${state.ctx.dayId}`,
      origin: "Primer día del calendario de MS4: la entrega de mañana (UTC).",
      call: () => lastCall(4, /\/calendars\/[^/?]+$/, "GET") },
    { key: "route", label: "Ruta", svc: "ms5", step: 6, get: () => state.ctx.routeId,
      origin: "MS5 · POST /routes. route-created se publicó (todavía sin consumidores).",
      call: () => lastCall(6, /\/routes$/, "POST") },
    { key: "order", label: "Orden producción", svc: "ms3", svc2: "ms4", step: 7, get: () => state.ctx.productionOrderId,
      origin: "MS4 → MS3: production-order-ready. MS3 la proyectó como entrega programada y armó la orden (GET /production/daily-order).",
      call: () => lastCall(7, /daily-order/, "GET") },
    { key: "package", label: "Paquete", svc: "ms3", step: 7, get: () => state.ctx.packageId,
      origin: "MS3 · POST /production/packages; luego ensamblado, etiquetado y validado → package-validated.",
      call: () => lastCall(7, /\/production\/packages$/, "POST") },
    { key: "delivery", label: "Entrega", svc: "ms5", step: 8, get: () => state.ctx.deliveryId,
      origin: "MS5 agregó la entrega a la ruta al consumir package-validated; MS4 la vinculó al día con delivery-added-to-route (inbox idempotente).",
      call: () => lastCall(8, /delivery-link/) },
    { key: "final", label: "Estado final", svc: "ms4", step: 10, final: true,
      get: () => (state.status[10] === "done" ? (state.result === "fail" ? "Failed" : "Delivered") : undefined),
      show: v => v,
      origin: "MS4 cerró el día al consumir delivery-completed | delivery-failed. Nadie lo cambió a mano.",
      call: () => lastCall(10, /\/calendars\/[^/?]+$/, "GET"),
      extra: () => { const d = dayOf(); return d ? { label: "Día en el calendario", data: d, kind: "json" } : null; } }
  ];
  const chipBy = Object.fromEntries(chips.map(c => [c.key, c]));

  function buildDossier() {
    root.querySelector("#pv-chips").innerHTML = chips.map(c => {
      const dot = c.svc2 ? `background:linear-gradient(135deg,${T.byId[c.svc2].hex} 50%,${T.byId[c.svc].hex} 50%)` : `background:${T.byId[c.svc].hex}`;
      return `<div class="pv-chip${c.final ? " final" : ""}" data-key="${c.key}" data-inspect="chip:${c.key}" tabindex="0" style="--c:${T.byId[c.svc].hex}">
        <i class="pv-dot" style="${dot}"></i><span class="pv-chip-l">${U.esc(c.label)}</span><span class="pv-chip-v">pendiente</span></div>`;
    }).join("");
  }

  function updateDossier() {
    if (!root) return;
    let n = 0;
    for (const c of chips) {
      const el = root.querySelector(`.pv-chip[data-key="${c.key}"]`);
      if (!el) continue;
      const v = c.get();
      const on = v !== undefined && v !== null && v !== "";
      if (on) n++;
      const was = !!litKeys[c.key];
      litKeys[c.key] = on;
      el.classList.toggle("lit", on);
      el.classList.toggle("bad", on && c.final && v === "Failed");
      if (on && !was) {
        el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
        setTimeout(() => el.classList.remove("pop"), 1400);
      }
      const val = el.querySelector(".pv-chip-v");
      const shown = on ? (c.show ? c.show(v) : shortId(v)) : "pendiente";
      if (val.textContent !== shown) val.textContent = shown;
    }
    const cnt = root.querySelector("#pv-dos-count");
    if (cnt) cnt.textContent = `${n}/${chips.length}`;
  }

  // ---------- stepper ----------
  function buildStepper() {
    const grad = steps.map((s, i) => `${T.byId[s.svc].hex} ${(i * 100 / steps.length).toFixed(2)}% ${((i + 1) * 100 / steps.length).toFixed(2)}%`).join(",");
    root.querySelector("#pv-stepper").innerHTML = `
      <div class="pv-prog" aria-hidden="true"><div class="pv-prog-bg" style="background:linear-gradient(90deg,${grad})"></div>
        <div class="pv-prog-fill" id="pv-prog-fill" style="background:linear-gradient(90deg,${grad})"></div></div>
      <ol class="pv-steps">${steps.map((s, i) => `<li><button type="button" class="pv-st" data-i="${i}" style="--c:${T.byId[s.svc].hex}">
        <span class="pv-st-top"><span class="pv-st-n">${i + 1}</span><span class="pv-st-s">pendiente</span></span>
        <span class="pv-st-t">${U.esc(s.short)}</span></button></li>`).join("")}</ol>`;
  }

  const STATE_LABEL = { running: "en curso", done: "✓ hecho", failed: "✕ falló" };

  function updateStepper() {
    if (!root) return;
    steps.forEach((s, i) => {
      const el = root.querySelector(`.pv-st[data-i="${i}"]`);
      if (!el) return;
      const st = state.status[i] || "pending";
      el.className = `pv-st ${st}${i === state.current ? " current" : ""}`;
      el.setAttribute("aria-current", i === state.current ? "step" : "false");
      const lab = el.querySelector(".pv-st-s");
      const want = STATE_LABEL[st] || "pendiente";
      if (lab.dataset.v !== want) { lab.dataset.v = want; lab.innerHTML = st === "running" ? `<i class="pv-spin"></i>${want}` : want; }
    });
    let contiguous = 0;
    while (contiguous < steps.length && state.status[contiguous] === "done") contiguous++;
    const part = steps.some((_, i) => state.status[i] === "running") ? 0.5 : 0;
    const frac = Math.min(1, (contiguous + part) / steps.length);
    const fill = root.querySelector("#pv-prog-fill");
    if (fill) fill.style.clipPath = `inset(0 ${((1 - frac) * 100).toFixed(2)}% 0 0)`;
  }

  // ---------- caption ----------
  function typeInto(el, str) {
    clearInterval(typeTimer);
    el.classList.remove("typing");
    if (reduced() || !str) { el.textContent = str; return; }
    let n = 0;
    el.textContent = "";
    el.classList.add("typing");
    typeTimer = setInterval(() => {
      n += 2;
      el.textContent = str.slice(0, n);
      if (n >= str.length) { clearInterval(typeTimer); el.classList.remove("typing"); }
    }, 20);
  }

  function renderCaption() {
    if (!root) return;
    const cap = root.querySelector("#pv-cap");
    if (!cap) return;
    const i = state.current, s = steps[i], hex = T.byId[s.svc].hex;
    if (viewed !== i) {
      viewed = i;
      sigs = Object.assign({}, sigs, { live: null, ticker: null });
      cap.style.setProperty("--c", hex);
      cap.classList.remove("swap"); void cap.offsetWidth; cap.classList.add("swap");
      cap.querySelector("#pv-cap-badge").innerHTML = `<b>Paso ${i + 1} de ${steps.length}</b><span>${U.esc(svcName(s.svc))}</span>`;
      typeInto(cap.querySelector("#pv-cap-what"), text(s.what));
      cap.querySelector("#pv-cap-data").innerHTML = md(text(s.data));
      cap.querySelector("#pv-cap-why").innerHTML = md(text(s.why));
    }

    // live line: last note (spinner while running, red on error)
    const notes = state.notes[i] || [], last = notes[notes.length - 1], st = state.status[i];
    let live;
    if (st === "running") live = `<i class="pv-spin"></i><span>${U.esc(last || "Ejecutando…")}</span>`;
    else if (st === "failed") live = `<span class="pv-err">✕ ${U.esc(last || "El paso falló")}</span>`;
    else if (st === "done") live = `<span class="pv-okc">✓ ${U.esc(last || "Paso completado")}</span>`;
    else live = `<span class="pv-idle">Pendiente: aún no se ejecutó este paso.</span>`;
    setIf(cap.querySelector("#pv-live"), "live", live);

    // call ticker: last 4 calls of the viewed step
    const calls = state.calls[i] || [];
    const from = Math.max(0, calls.length - 4);
    const sig = `${i}|${calls.length}|${st}`;
    if (sigs.ticker !== sig) {
      sigs.ticker = sig;
      const items = calls.slice(from).map((r, k) => {
        const ok = r.status >= 200 && r.status < 300;
        return `<button type="button" class="pv-call" data-inspect="call:${i}:${from + k}" style="--c:${(T.byId[r.service] || {}).hex || "#8c969f"}">
          <i class="pv-dot"></i><b>${U.esc(r.method)}</b><span class="pv-call-p">${U.esc(trimPath(r.path))}</span>
          <em class="${ok ? "ok" : "bad"}">${r.status || "sin conexión"}</em><small>${r.ms} ms</small></button>`;
      }).join("");
      cap.querySelector("#pv-ticker").innerHTML = items ||
        `<span class="pv-ticker-empty">${st === "running" ? "Esperando la primera llamada…" : st ? "Sin llamadas del navegador en este paso." : "Aún sin llamadas: el paso no se ejecutó."}</span>`;
    }
  }

  // ---------- controls ----------
  function updateControls() {
    if (!root) return;
    const n = nextIndex(), busy = state.running || state.all;
    const next = root.querySelector("#run-next"), all = root.querySelector("#run-all");
    next.disabled = busy || n >= steps.length;
    all.disabled = busy || n >= steps.length;
    next.textContent = n >= steps.length ? "Recorrido completo" : `Ejecutar paso ${n + 1}`;
    root.querySelector("#reset").disabled = state.running;
    root.querySelector("#outcome").disabled = busy;
    const pause = root.querySelector("#pause"), badge = root.querySelector("#pv-paused");
    pause.hidden = !state.all;
    pause.textContent = state.paused ? "Continuar" : "Pausa";
    pause.setAttribute("aria-pressed", String(state.paused));
    badge.hidden = !(state.all && state.paused);
    badge.textContent = state.running ? "en pausa al terminar este paso" : "en pausa";
  }

  function refresh() {
    updateStepper();
    updateDossier();
    updateControls();
    renderCaption();
  }

  // ---------- inspector ----------
  const callSections = (r, n) => [
    { label: `${n ? n + ". " : ""}Petición ${r.method} ${trimPath(r.path)}`, data: r.request === undefined ? "(sin cuerpo)" : r.request, kind: r.request === undefined ? "text" : "json" },
    { label: `${n ? n + ". " : ""}Respuesta ${r.status || "sin conexión"} · ${r.ms} ms`, data: r.response === null || r.response === undefined ? "(vacía)" : r.response, kind: typeof r.response === "object" && r.response !== null ? "json" : "text" }
  ];

  function resolve(el) {
    const [kind, a, b] = String(el.getAttribute("data-inspect") || "").split(":");
    if (kind === "call") {
      const r = (state.calls[a] || [])[Number(b)];
      return r ? { title: `${r.method} ${trimPath(r.path)}`, subtitle: svcName(r.service), color: (T.byId[r.service] || {}).hex, sections: callSections(r) } : null;
    }
    if (kind === "chip") {
      const c = chipBy[a], v = c.get();
      const on = v !== undefined && v !== null && v !== "";
      if (!on) return { title: c.label, subtitle: `${svcName(c.svc)} · se llena en el paso ${c.step + 1}`, color: T.byId[c.svc].hex, sections: [{ label: "Estado", data: "Pendiente: todavía no se ejecutó el paso que produce este dato.", kind: "text" }] };
      const sections = [{ label: "Valor completo", data: c.full ? c.full(v) : String(v), kind: "text" }, { label: "De dónde sale", data: c.origin, kind: "text" }];
      const x = c.extra && c.extra();
      if (x) sections.push(x);
      const r = c.call();
      if (r) sections.push(...callSections(r));
      return { title: c.label, subtitle: `${svcName(c.svc)} · paso ${c.step + 1}`, color: T.byId[c.svc].hex, sections };
    }
    return null;
  }

  function pinStep(i) {
    if (!NT.inspect || !NT.inspect.pin) return;
    const s = steps[i], calls = state.calls[i] || [];
    const sections = calls.length ? calls.flatMap((r, k) => callSections(r, k + 1))
      : [{ label: "Llamadas", data: state.status[i] ? "Este paso no hizo llamadas desde el navegador: ocurrió entre servicios por eventos." : "Este paso todavía no se ejecutó.", kind: "text" }];
    NT.inspect.pin({ title: `Paso ${i + 1}: ${s.title}`, subtitle: `${svcName(s.svc)} · ${calls.length} llamada${calls.length === 1 ? "" : "s"}`, color: T.byId[s.svc].hex, sections });
  }

  // ---------- board ----------
  function collapseBoard() {
    const b = NT.live && NT.live.board;
    if (b && b.collapse) { boardPrev = b.isCollapsed(); b.collapse(true); return; }
    const el = document.getElementById("board"), btn = document.getElementById("board-toggle");
    boardPrev = el ? el.classList.contains("collapsed") : null;
    if (el && btn && !boardPrev) btn.click();
  }
  function restoreBoard() {
    if (boardPrev === null) return;
    const b = NT.live && NT.live.board;
    if (b && b.collapse) b.collapse(boardPrev);
    else {
      const el = document.getElementById("board"), btn = document.getElementById("board-toggle");
      if (el && btn && el.classList.contains("collapsed") !== boardPrev) btn.click();
    }
    boardPrev = null;
  }

  // ---------- mount ----------
  function mount(el) {
    root = el;
    stageEl = el;
    el.classList.add("pv-stage");
    viewed = -1; sigs = {}; litKeys = {};
    el.innerHTML = `
      <div class="pv">
        <header class="pv-head">
          <div class="pv-title">
            <h1>Pedido en vivo</h1>
            <p>Un paciente cruza 5 microservicios sin una sola llamada REST entre ellos.</p>
          </div>
          <div class="pv-actions">
            <label class="pv-outcome">Resultado
              <select id="outcome"><option value="deliver">Entregado</option><option value="fail">Fallido</option></select></label>
            <button class="btn ghost" id="reset" type="button">Empezar de nuevo</button>
            <button class="btn ghost" id="run-all" type="button">Ejecutar todo</button>
            <span class="pv-paused" id="pv-paused" hidden>en pausa</span>
            <button class="btn ghost" id="pause" type="button" hidden>Pausa</button>
            <button class="btn" id="run-next" type="button">Ejecutar paso 1</button>
          </div>
        </header>
        <div class="pv-main">
          <div class="pv-canvas" id="pv-canvas"></div>
          <aside class="pv-dossier" aria-label="Expediente del pedido">
            <div class="pv-dos-head"><span>Expediente del pedido</span><b id="pv-dos-count">0/${chips.length}</b></div>
            <div class="pv-chips" id="pv-chips"></div>
          </aside>
        </div>
        <section class="pv-cap" id="pv-cap" aria-live="polite">
          <div class="pv-cap-col pv-cap-main">
            <div class="pv-badge" id="pv-cap-badge"></div>
            <p class="pv-what" id="pv-cap-what"></p>
            <div class="pv-live" id="pv-live"></div>
          </div>
          <div class="pv-cap-col"><h3>Qué dato viaja</h3><p class="pv-data" id="pv-cap-data"></p></div>
          <div class="pv-cap-col"><h3>Por qué importa</h3><p class="pv-why" id="pv-cap-why"></p></div>
          <div class="pv-ticker" id="pv-ticker"></div>
        </section>
        <nav class="pv-stepper" id="pv-stepper" aria-label="Pasos del recorrido"></nav>
      </div>`;

    el.querySelector("#outcome").value = state.outcome;
    el.querySelector("#outcome").addEventListener("change", e => { state.outcome = e.target.value; viewed = -1; renderCaption(); });
    el.querySelector("#run-next").addEventListener("click", () => runStep(nextIndex()));
    el.querySelector("#run-all").addEventListener("click", () => runFrom(nextIndex()));
    el.querySelector("#pause").addEventListener("click", () => { state.paused = !state.paused; updateControls(); });
    el.querySelector("#reset").addEventListener("click", () => {
      if (state.running) return;
      // Also cancels a paused "Ejecutar todo" (the loop checks state.all).
      Object.assign(state, { ctx: {}, status: {}, calls: {}, notes: {}, current: 0, all: false, paused: false, result: null });
      viewed = -1; litKeys = {};
      if (NT.canvas) { if (NT.canvas.reset) NT.canvas.reset(); if (NT.canvas.focus) NT.canvas.focus(null); }
      refresh();
    });

    buildDossier();
    buildStepper();
    el.querySelector("#pv-stepper").addEventListener("click", e => {
      const b = e.target.closest(".pv-st");
      if (!b) return;
      state.current = Number(b.dataset.i);
      refresh();
      pinStep(state.current);
    });

    const host = el.querySelector("#pv-canvas");
    let mounted = false;
    if (NT.canvas && NT.canvas.mount) { try { NT.canvas.mount(host); mounted = true; } catch (e) { console.error("canvas", e); } }
    if (!mounted) host.innerHTML = `<div class="pv-canvas-empty">El lienzo del recorrido no está disponible.</div>`;
    canvasOn = mounted;

    if (NT.inspect && NT.inspect.attach) detachInspect = NT.inspect.attach(el, resolve);
    collapseBoard();

    offs.push(NT.bus.on("http", r => {
      if (capturing === null || r.quiet) return;
      state.calls[capturing].push(r);
      if (state.current === capturing) renderCaption();
    }));
    // ctx fills in between events; a light tick lights the dossier chips as soon as a value exists.
    const tick = setInterval(updateDossier, 250);
    offs.push(() => clearInterval(tick));
    refresh();
  }
  let canvasOn = false;

  function unmount() {
    clearInterval(typeTimer);
    offs.forEach(f => f()); offs = [];
    if (detachInspect) { detachInspect(); detachInspect = null; }
    if (NT.inspect && NT.inspect.hide) NT.inspect.hide();
    if (canvasOn && NT.canvas && NT.canvas.unmount) { try { NT.canvas.unmount(); } catch (e) { console.error("canvas", e); } }
    canvasOn = false;
    restoreBoard();
    if (stageEl) stageEl.classList.remove("pv-stage");
    stageEl = null;
    root = null;
  }

  return { mount, unmount };
})();
