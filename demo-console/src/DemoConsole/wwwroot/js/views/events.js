// "Eventos del broker": every integration event copied off RabbitMQ, plus the consumer queues.
NT.views.eventos = (function () {
  const U = NT.util, T = NT.topology;
  let root = null, offs = [], timer = null;
  let filter = "all", focusId = null;

  function card(ev, open) {
    const pub = ev.publisher ? T.byId[ev.publisher] : null;
    const to = ev.consumers.length ? ev.consumers.map(c => T.byId[c].name).join(", ") : "nadie lo consume todavía";
    return U.html`<details class="event-card" data-id="${ev.id}" style="--line:${pub ? pub.hex : "#8c969f"}" ${open ? U.raw("open") : ""}>
      <summary><span class="mono muted">${U.time(ev.receivedAt)}</span><b>${ev.exchange}</b>
        <span class="flowline">${pub ? pub.name : "origen desconocido"} → RabbitMQ → ${to}</span></summary>
      <div class="inner">
        <dl class="ctx" style="margin-bottom:8px"><dt>Contrato</dt><dd>${ev.def ? ev.def.type : "?"}</dd><dt>Colas</dt><dd>${ev.consumers.map(c => c + "." + ev.exchange).join(", ") || "ninguna"}</dd></dl>
        <pre class="json">${JSON.stringify(ev.payload, null, 2)}</pre>
      </div></details>`;
  }

  function renderFeed() {
    if (!root) return;
    const list = NT.live.events.filter(e => filter === "all" || e.publisher === filter || e.consumers.includes(filter));
    root.querySelector("#feed").innerHTML = list.length
      ? list.map(e => card(e, e.id === focusId)).join("")
      : `<div class="empty">Sin eventos para este filtro. Ejecuta el recorrido de un pedido y vuelve aquí.</div>`;
    if (focusId) {
      const el = root.querySelector(`[data-id="${CSS.escape(focusId)}"]`);
      if (el) el.scrollIntoView({ block: "center" });
      focusId = null;
    }
  }

  function renderFilters() {
    const chips = [{ id: "all", name: "Todos", hex: "#1d2b3a" }].concat(T.services);
    root.querySelector("#filters").innerHTML = chips.map(s => U.html`<button type="button" class="chip" data-f="${s.id}" aria-pressed="${filter === s.id}" style="--line:${s.hex}">${s.name}</button>`).join("");
  }

  async function renderQueues() {
    if (!root) return;
    let qs = [];
    try { qs = await NT.api.queues(); } catch { root.querySelector("#queues").innerHTML = `<tr><td colspan="5" class="muted">No se pudo leer la API de administración de RabbitMQ.</td></tr>`; return; }
    if (!root) return;
    qs = qs.filter(q => /^ms\d\./.test(q.name) || q.name.startsWith("demo-console")).sort((a, b) => a.name.localeCompare(b.name));
    root.querySelector("#queues").innerHTML = qs.map(q => {
      const owner = T.byId[q.name.split(".")[0]];
      const st = q.message_stats || {};
      return U.html`<tr><td>${owner ? U.raw(U.html`<span class="line-dot" style="--line:${owner.hex}"></span>`) : ""}<code>${q.name}</code></td>
        <td>${q.consumers ?? 0}</td><td>${st.publish ?? 0}</td><td>${st.ack ?? 0}</td><td>${q.messages ?? 0}</td></tr>`;
    }).join("");
  }

  function mount(el) {
    root = el;
    el.innerHTML = `
      <div class="view-head">
        <div>
          <h1>Eventos del broker</h1>
          <p>Los servicios no se llaman entre sí para avisar cambios: publican un evento en un exchange de RabbitMQ y cada interesado lo recibe en su propia cola. Esta consola escucha con una cola propia, así ve una copia sin quitarle mensajes a nadie.</p>
        </div>
      </div>
      <div class="filters" id="filters"></div>
      <div class="grid-2" style="grid-template-columns:1.4fr 1fr;align-items:start">
        <div class="event-feed" id="feed"></div>
        <section class="panel">
          <h2>Colas de consumidores</h2>
          <p class="muted" style="margin-top:-4px">Nombre {consumidor}.{exchange}. Pendientes en 0 significa que el servicio va al día.</p>
          <table class="data"><thead><tr><th>Cola</th><th>Consumidores</th><th>Publicados</th><th>Confirmados</th><th>Pendientes</th></tr></thead><tbody id="queues"></tbody></table>
        </section>
      </div>`;
    el.querySelector("#filters").addEventListener("click", e => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      filter = b.dataset.f;
      renderFilters(); renderFeed();
    });
    offs.push(NT.bus.on("event", renderFeed), NT.bus.on("focus-event", id => { focusId = id; renderFeed(); }));
    renderFilters(); renderFeed(); renderQueues();
    timer = setInterval(renderQueues, NT.config.pollQueuesMs);
  }

  function unmount() { clearInterval(timer); offs.forEach(f => f()); offs = []; root = null; }
  return { mount, unmount };
})();
