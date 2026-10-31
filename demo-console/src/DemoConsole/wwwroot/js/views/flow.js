// "Recorrido de un pedido": the e2e-smoke.py happy path, one clickable step at a time.
// Every call goes through the real gateway; the mini map and the board show the hops live.
NT.views.flujo = (function () {
  const U = NT.util, T = NT.topology, api = NT.api;

  const state = { ctx: {}, status: {}, calls: {}, notes: {}, current: 0, running: false, outcome: "deliver" };
  let root = null, offs = [], capturing = null;

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

  function note(text) {
    const i = state.current;
    (state.notes[i] = state.notes[i] || []).push(text);
    renderDetail();
  }

  const steps = [
    { svc: "identity", title: "Iniciar sesión", desc: "El usuario obtiene un JWT de Identity.",
      async run(c) {
        const r = await api.login("admin", "admin");
        expect(r, [200], "Login");
        note(`Token emitido para admin con ${U.claimScopes(api.claims).length} scopes. Todas las llamadas siguientes lo envían en Authorization: Bearer.`);
      } },
    { svc: "ms1", title: "Registrar paciente", desc: "MS1 guarda al paciente y publica paciente-published por su outbox.",
      async run(c) {
        c.stamp = U.stamp();
        const r = await api.call("ms1", "POST", "/Patient/CreatePaciente", { body: { ci: `DEMO${c.stamp}`, nombre: "Ana", apellido: `Demo ${c.stamp}`, telefono: "+591 700 55555" } });
        const v = expect(r, [200], "Crear paciente");
        c.patientId = v.value;
        expect(await api.call("ms1", "GET", `/Patient/${c.patientId}`), [200], "Leer paciente");
      } },
    { svc: "ms2", title: "Crear recetas y plan de 15 días", desc: "MS2 publica recipe-published y meal-plan-published; MS3 y MS4 los proyectan.",
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
        note("Plan listo. El evento meal-plan-published ya viajó a MS3 y MS4 por RabbitMQ.");
      } },
    { svc: "ms3", title: "Contratar y cobrar", desc: "MS3 acepta el contrato cuando ya recibió el plan por evento, y valida al paciente contra MS1.",
      async run(c) {
        const r = await poll("que MS3 conozca el plan (meal-plan-published)", async () => {
          const x = await api.call("ms3", "POST", "/contracts", { body: { patientId: c.patientId, catalogPlanId: c.planId }, quiet: true });
          return x.status === 201 ? x : null;
        }, 90000, 3000);
        NT.bus.emit("http", Object.assign({}, r, { quiet: false }));
        c.contractId = r.response.id;
        expect(await api.call("ms3", "POST", "/billing/charge-plan", { body: { contractId: c.contractId, amount: 150.0, invoiceNumber: `inv-demo-${c.stamp}` } }), [200, 201], "Cobro");
        note("Pagado. El worker de MS3 llama a MS4 POST /schedule con la cuenta de servicio ms3-service.");
      } },
    { svc: "ms4", title: "Calendario de entregas creado", desc: "MS4 recibió el pedido de MS3 y creó 15 días pendientes.",
      async run(c) {
        const found = await poll("el calendario del contrato en MS4", () => api.lookup("calendar-by-contract", c.contractId), 60000);
        c.calendarId = found.calendarId;
        const cal = expect(await api.call("ms4", "GET", `/calendars/${c.calendarId}`), [200], "Leer calendario");
        const first = cal.days.reduce((a, b) => (a.dayNumber < b.dayNumber ? a : b));
        c.dayId = first.id;
        c.deliveryDate = first.date;
        note(`Calendario ${c.calendarId} con ${cal.days.length} días. El día 1 (${first.date}) es mañana en UTC.`);
      } },
    { svc: "ms4", title: "Dirección y menú de mañana", desc: "El paciente registra la dirección; MS4 resuelve el menú pidiéndolo a MS2.",
      async run(c) {
        expect(await api.call("ms4", "POST", `/calendars/${c.calendarId}/addresses`, { body: { dayId: c.dayId, street: "Av. Banzer 123", city: "Santa Cruz", latitude: -17.78, longitude: -63.18, references: "Portón verde", notes: null } }), [200, 201], "Dirección");
        expect(await api.call("ms4", "POST", `/calendars/resolve-daily-catalog?date=${c.deliveryDate}`), [200, 204], "Resolver menú");
        const at = expect(await api.call("ms4", "GET", `/calendars/active-tomorrow?date=${c.deliveryDate}`), [200], "Pedidos de mañana");
        const mine = (at || []).find(x => x.packId === c.dayId);
        if (!mine) throw new Error("El día no aparece en active-tomorrow");
        note(`Menú resuelto: ${(mine.menu || []).map(m => U.pick(m, "recipeName") || U.pick(m, "name")).filter(Boolean).join(", ") || "sin recetas"}.`);
      } },
    { svc: "ms5", title: "Repartidor y ruta de mañana", desc: "MS5 crea el repartidor y su ruta; publica courier-created y route-created.",
      async run(c) {
        const k = expect(await api.call("ms5", "POST", "/couriers", { body: { fullName: `Repartidor ${c.stamp}` } }), [200, 201], "Repartidor");
        c.courierId = k.id;
        const r = expect(await api.call("ms5", "POST", "/routes", { body: { courierId: c.courierId, scheduledDate: c.deliveryDate } }), [200, 201], "Ruta");
        c.routeId = r.id;
      } },
    { svc: "ms3", title: "Producir y validar el paquete", desc: "MS3 arma la orden del día, empaqueta, etiqueta y valida. Publica package-validated.",
      async run(c) {
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
    { svc: "ms5", title: "Entrega asignada a la ruta", desc: "Sin llamadas del navegador: MS5 consume package-validated y MS4 consume delivery-added-to-route.",
      async run(c) {
        const link = await poll("que MS4 vincule la entrega de MS5 al día", () => api.lookup("delivery-by-day", c.dayId), 90000);
        c.deliveryId = link.deliveryId;
        note(`Entrega ${String(c.deliveryId).slice(0, 8)}… vinculada al día ${c.dayId}. Dos saltos asíncronos por el broker.`);
      } },
    { svc: "ms5", title: "Iniciar ruta y entregar", desc: "El repartidor sale y cierra la entrega con evidencia, o la marca fallida.",
      async run(c) {
        expect(await api.call("ms5", "POST", `/routes/${c.routeId}/start`), [200, 204], "Iniciar ruta");
        if (state.outcome === "deliver") {
          expect(await api.call("ms5", "POST", `/routes/${c.routeId}/deliveries/${c.deliveryId}/deliver`, { body: { deliveredAt: new Date().toISOString().slice(0, 19) + "Z", evidencePhotoUrl: "https://example.org/entrega.jpg", digitalSignature: "firma-ana" } }), [200, 204], "Entregar");
        } else {
          expect(await api.call("ms5", "POST", `/routes/${c.routeId}/deliveries/${c.deliveryId}/fail`, { body: { reason: "Nadie en el domicilio" } }), [200, 204], "Marcar fallida");
        }
      } },
    { svc: "ms4", title: "Día cerrado en el calendario", desc: "MS4 consume delivery-completed o delivery-failed y cierra el día. Nadie lo cambia a mano.",
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

  async function runStep(i) {
    if (state.running) return false;
    state.running = true;
    state.current = i;
    state.status[i] = "running";
    state.calls[i] = [];
    state.notes[i] = [];
    capturing = i;
    render();
    try {
      await steps[i].run(state.ctx);
      state.status[i] = "done";
      return true;
    } catch (e) {
      state.status[i] = "failed";
      note(e.message);
      U.toast(e.message, "bad");
      return false;
    } finally {
      capturing = null;
      state.running = false;
      render();
    }
  }

  async function runFrom(i) {
    for (let k = i; k < steps.length; k++) {
      if (state.status[k] === "done") continue;
      const ok = await runStep(k);
      if (!ok || !root) return;
      await U.sleep(900);
    }
  }

  const nextIndex = () => { const i = steps.findIndex((_, k) => state.status[k] !== "done"); return i < 0 ? steps.length : i; };

  // ---------- render ----------
  function render() {
    if (!root) return;
    const list = root.querySelector("#steps");
    list.innerHTML = steps.map((s, i) => U.html`<li class="step ${state.status[i] || ""} ${i === state.current ? "active" : ""}" data-i="${i}" style="--line:${T.byId[s.svc].hex}">
        <span class="dot" aria-hidden="true"></span><h3>${s.title}</h3><p>${T.byId[s.svc].name}: ${s.desc}</p></li>`).join("");
    const n = nextIndex();
    root.querySelector("#run-next").disabled = state.running || n >= steps.length;
    root.querySelector("#run-all").disabled = state.running || n >= steps.length;
    root.querySelector("#run-next").textContent = n >= steps.length ? "Recorrido completo" : `Ejecutar paso ${n + 1}`;
    renderDetail();
  }

  function renderDetail() {
    if (!root) return;
    const i = state.current, s = steps[i];
    const calls = state.calls[i] || [];
    const notes = state.notes[i] || [];
    const c = state.ctx;
    const ctxRows = [["Paciente", c.patientId], ["Plan MS2", c.planId], ["Contrato", c.contractId], ["Calendario", c.calendarId], ["Día", c.dayId],
      ["Fecha de entrega", c.deliveryDate], ["Ruta MS5", c.routeId], ["Orden de producción", c.productionOrderId], ["Entrega MS5", c.deliveryId]].filter(([, v]) => v);
    root.querySelector("#step-detail").innerHTML = U.html`
      <div class="panel" style="--line:${T.byId[s.svc].hex}">
        <h2><span class="line-dot" style="--line:${T.byId[s.svc].hex}"></span>Paso ${i + 1}: ${s.title}</h2>
        <p class="muted" style="margin-top:-4px">${s.desc}</p>
        ${U.raw(notes.map(t => U.html`<div class="note" style="margin-top:8px">${t}</div>`).join(""))}
      </div>
      ${U.raw(calls.length ? calls.map(callCard).join("") : `<div class="empty">${state.status[i] === "running" ? "Ejecutando…" : "Este paso todavía no se ejecutó."}</div>`)}
      ${ctxRows.length ? U.raw(U.html`<div class="panel"><h3>Datos del recorrido</h3><dl class="ctx">${U.raw(ctxRows.map(([k, v]) => U.html`<dt>${k}</dt><dd>${v}</dd>`).join(""))}</dl></div>`) : ""}`;
  }

  function callCard(r) {
    const cls = r.status >= 200 && r.status < 300 ? "ok" : "bad";
    return U.html`<article class="call">
      <header><span class="line-dot" style="--line:${T.byId[r.service].hex}"></span><span class="verb">${r.method}</span>
        <span class="path">${r.path}</span><span class="tag ${cls}">${r.status || "sin conexión"}</span><span class="muted">${r.ms} ms</span>
        ${r.authorized ? U.raw('<span class="tag" title="Se envió el JWT">JWT</span>') : ""}</header>
      <div class="body">
        <div><h4>Petición</h4><pre class="json">${r.request === undefined ? "(sin cuerpo)" : JSON.stringify(r.request, null, 2)}</pre></div>
        <div><h4>Respuesta</h4><pre class="json">${r.response === null || r.response === undefined ? "(vacía)" : typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2)}</pre></div>
      </div></article>`;
  }

  function mount(el) {
    root = el;
    el.innerHTML = `
      <div class="view-head">
        <div>
          <h1>Recorrido de un pedido</h1>
          <p>Un paciente nuevo, desde el registro hasta la entrega en su puerta. Cada paso llama a la API real por el gateway; los pasos asíncronos esperan a que los eventos crucen RabbitMQ.</p>
        </div>
        <div class="actions">
          <label class="muted" style="display:flex;align-items:center;gap:6px">Resultado
            <select id="outcome"><option value="deliver">Entregado</option><option value="fail">Fallido</option></select></label>
          <button class="btn ghost" id="reset" type="button">Empezar de nuevo</button>
          <button class="btn ghost" id="run-all" type="button">Ejecutar todo</button>
          <button class="btn" id="run-next" type="button">Ejecutar paso 1</button>
        </div>
      </div>
      <div class="flow">
        <ol class="steps" id="steps"></ol>
        <div class="exchange">
          <div id="mini-map"></div>
          <div class="exchange" id="step-detail"></div>
        </div>
      </div>`;
    el.querySelector("#outcome").value = state.outcome;
    el.querySelector("#outcome").addEventListener("change", e => { state.outcome = e.target.value; });
    el.querySelector("#run-next").addEventListener("click", () => runStep(nextIndex()));
    el.querySelector("#run-all").addEventListener("click", () => runFrom(nextIndex()));
    el.querySelector("#reset").addEventListener("click", () => {
      if (state.running) return;
      Object.assign(state, { ctx: {}, status: {}, calls: {}, notes: {}, current: 0 });
      render();
    });
    el.querySelector("#steps").addEventListener("click", e => {
      const li = e.target.closest(".step");
      if (li) { state.current = Number(li.dataset.i); render(); }
    });
    NT.views.mapa.mount(el.querySelector("#mini-map"), { mini: true });
    offs.push(NT.bus.on("http", r => {
      if (capturing === null || r.quiet) return;
      state.calls[capturing].push(r);
      if (state.current === capturing) renderDetail();
    }));
    render();
  }

  function unmount() { NT.views.mapa.unmount(); offs.forEach(f => f()); offs = []; root = null; }

  return { mount, unmount };
})();
