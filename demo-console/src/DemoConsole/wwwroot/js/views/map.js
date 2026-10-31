// "Mapa del sistema": the platform drawn as a transit map. HTTP calls run browser -> gateway ->
// station; integration events run station -> broker trunk -> consumer stations.
NT.views = NT.views || {};
NT.views.mapa = (function () {
  const U = NT.util, T = NT.topology;
  const SVGNS = "http://www.w3.org/2000/svg";
  const W = 1200, H = 640;
  const HUB = { x: 300, y: 330 };
  const STATION_X = 610, TRUNK_X = 1010;
  const order = ["identity", "ms1", "ms2", "ms3", "ms4", "ms5"];
  const Y = Object.fromEntries(order.map((id, i) => [id, 100 + i * 92]));

  let root = null, svg = null, trainLayer = null, offs = [], selected = "ms4", detach = null;

  // Last traffic seen per service, for the hover/pin inspector. Subscribed at load time so the
  // cache survives leaving and re-entering the view.
  const last = {};
  const slot = id => (last[id] = last[id] || {});
  NT.bus.on("http", r => { if (!r.quiet && T.byId[r.service]) slot(r.service).http = r; });
  NT.bus.on("event", ev => {
    if (ev.publisher) slot(ev.publisher).published = ev;
    (ev.consumers || []).forEach(c => { slot(c).consumed = ev; });
  });
  const trainInfo = new Map(); // data-inspect key -> info for moving trains
  let trainSeq = 0;

  const gwPath = (id, i) => {
    const y = Y[id], x = 430 + i * 9, r = 18, dir = y < HUB.y ? -1 : 1;
    if (Math.abs(y - HUB.y) < 4) return `M ${HUB.x + 80} ${HUB.y} H ${STATION_X - 16}`;
    return `M ${HUB.x + 80} ${HUB.y} H ${x - r} Q ${x} ${HUB.y} ${x} ${HUB.y + dir * r} V ${y - dir * r} Q ${x} ${y} ${x + r} ${y} H ${STATION_X - 16}`;
  };
  const brokerPath = id => `M ${STATION_X + 16} ${Y[id]} H ${TRUNK_X}`;
  function draw() {
    const lines = order.map((id, i) => {
      const s = T.byId[id];
      return `<path class="line" id="gw-${id}" d="${gwPath(id, i)}" stroke="${s.hex}"/>
              <path class="line" id="bk-${id}" d="${brokerPath(id)}" stroke="${s.hex}" stroke-width="6" opacity=".85"/>`;
    }).join("");

    const reg = order.map(id => `<path class="reg" d="M 300 120 C 300 ${Y[id] - 40}, 520 ${Y[id]}, ${STATION_X - 14} ${Y[id]}"/>`).join("");

    const stations = order.map(id => {
      const s = T.byId[id], y = Y[id];
      const pubs = T.events.filter(e => e.publisher === id).length;
      const subs = T.events.filter(e => e.consumers.includes(id)).length;
      return `<g class="station" data-id="${id}" data-inspect="svc:${id}" tabindex="0" role="button" aria-label="${U.esc(s.name)}">
        <rect class="hit" x="${STATION_X - 22}" y="${y - 36}" width="330" height="62" fill="transparent"/>
        <circle class="ring" cx="${STATION_X}" cy="${y}" r="15"/>
        <text class="name" x="${STATION_X + 30}" y="${y - 14}">${U.esc(s.name)}</text>
        <text class="db" x="${STATION_X + 30}" y="${y + 25}">BD ${U.esc(s.db)}</text>
        <text class="sub" x="${TRUNK_X - 16}" y="${y - 12}" text-anchor="end">${pubs} publica · ${subs} consume</text>
      </g>`;
    }).join("");

    svg.innerHTML = `
      <defs>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#eef1ec" stroke-width="1"/></pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#grid)"/>
      ${reg}
      <path class="line" id="browser-gw" d="M 130 ${HUB.y} H ${HUB.x - 80}" stroke="#1d2b3a"/>
      ${lines}
      <path class="trunk" d="M ${TRUNK_X} 70 V ${Y.ms5 + 30}"/>
      <path class="trunk-inner" d="M ${TRUNK_X} 70 V ${Y.ms5 + 30}"/>

      <g class="infra" transform="translate(30 ${HUB.y - 34})">
        <rect width="100" height="68" rx="8"/>
        <text x="50" y="30" text-anchor="middle">Navegador</text>
        <text class="sub" x="50" y="50" text-anchor="middle">esta consola</text>
      </g>
      <g class="hub" transform="translate(${HUB.x - 80} ${HUB.y - 40})">
        <rect width="160" height="80" rx="40"/>
        <text x="80" y="36" text-anchor="middle">API Gateway</text>
        <text class="sub" x="80" y="56" text-anchor="middle">YARP · :15005</text>
      </g>
      <g class="infra" transform="translate(220 52)">
        <rect width="160" height="68" rx="8" style="stroke:var(--consul)"/>
        <text x="80" y="30" text-anchor="middle">Consul</text>
        <text class="sub" x="80" y="50" text-anchor="middle">registro y salud · :8500</text>
      </g>
      <text x="300" y="${HUB.y + 70}" text-anchor="middle" class="train-label" style="font-weight:400;fill:#56657a">/api/{servicio}/** → servicio sano en Consul</text>

      <g class="infra" transform="translate(${TRUNK_X - 90} 14)">
        <rect width="180" height="50" rx="8" style="stroke:var(--broker)"/>
        <text x="90" y="24" text-anchor="middle">RabbitMQ</text>
        <text class="sub" x="90" y="41" text-anchor="middle">${T.events.length} exchanges fanout</text>
      </g>
      <text x="${TRUNK_X + 20}" y="${Y.ms5 + 60}" class="train-label" style="font-weight:400;fill:#56657a" text-anchor="middle">bus de eventos</text>

      <g class="infra" transform="translate(30 ${H - 92})">
        <rect width="250" height="68" rx="8"/>
        <text x="16" y="28">PostgreSQL :5433</text>
        <text class="sub" x="16" y="48">una base de datos por servicio</text>
      </g>
      ${stations}
      <g id="trains"></g>`;

    trainLayer = svg.querySelector("#trains");
    svg.querySelectorAll(".station").forEach(g => {
      g.addEventListener("click", () => select(g.dataset.id));
      g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(g.dataset.id); } });
    });
    applyHealth(NT.live.health);
    select(selected);
  }

  function applyHealth(h) {
    if (!svg) return;
    svg.querySelectorAll(".station").forEach(g => {
      const st = (h[g.dataset.id] || {}).status || "unknown";
      g.classList.toggle("down", st === "critical");
      g.classList.toggle("unknown", st === "unknown");
    });
  }

  // ---------- animation ----------
  function ride(d, color, label, duration = 1100, info = null) {
    if (!trainLayer) return Promise.resolve();
    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    trainLayer.appendChild(path);
    const len = path.getTotalLength();
    const dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("r", "9");
    dot.setAttribute("class", "train");
    dot.setAttribute("fill", color);
    let key = null;
    if (info) {
      key = "train:" + (++trainSeq);
      trainInfo.set(key, info);
      dot.setAttribute("data-inspect", key);
      dot.setAttribute("tabindex", "0");
      dot.style.pointerEvents = "all";
    }
    trainLayer.appendChild(dot);
    let text = null;
    if (label) {
      text = document.createElementNS(SVGNS, "text");
      text.setAttribute("class", "train-label");
      text.textContent = label;
      trainLayer.appendChild(text);
    }
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    return new Promise(resolve => {
      const t0 = performance.now();
      const step = now => {
        const k = reduce ? 1 : Math.min(1, (now - t0) / duration);
        const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        const p = path.getPointAtLength(e * len);
        dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y);
        if (text) { text.setAttribute("x", p.x + 14); text.setAttribute("y", p.y - 12); }
        if (k < 1) requestAnimationFrame(step);
        else setTimeout(() => { path.remove(); dot.remove(); text && text.remove(); key && trainInfo.delete(key); resolve(); }, reduce ? 600 : 120);
      };
      requestAnimationFrame(step);
    });
  }

  function flash(id) {
    const el = svg && svg.querySelector("#gw-" + id);
    if (!el) return;
    el.classList.remove("flash"); void el.getBBox(); el.classList.add("flash");
  }

  function onHttp(r) {
    if (!svg || r.quiet) return;
    const i = order.indexOf(r.service);
    if (i < 0) return;
    const d = `M 130 ${HUB.y} H ${HUB.x + 80} ` + gwPath(r.service, i).replace(/^M [\d.]+ [\d.]+ /, "");
    const color = r.status >= 400 || r.status === 0 ? "#c62828" : "#1d2b3a";
    ride(d, color, `${r.method} ${r.status || "×"}`, 900, httpInfo(r)).then(() => flash(r.service));
  }

  function onEvent(ev) {
    if (!svg || !ev.publisher || !Y[ev.publisher]) return;
    const pub = T.byId[ev.publisher];
    const yP = Y[ev.publisher];
    if (!ev.consumers.length) {
      ride(`M ${STATION_X} ${yP} H ${TRUNK_X}`, pub.hex, ev.exchange, 1000, eventInfo(ev));
      return;
    }
    ev.consumers.forEach((c, k) => {
      const yC = Y[c];
      const d = `M ${STATION_X} ${yP} H ${TRUNK_X - 6} V ${yC} H ${STATION_X}`;
      setTimeout(() => ride(d, pub.hex, k === 0 ? ev.exchange : "", 1800, eventInfo(ev, c)), k * 140);
    });
  }

  // ---------- inspector (hover / click to pin) ----------
  const section = (label, data, kind) => data === undefined || data === null ? null : { label, data, kind: kind || "json" };

  function httpInfo(r) {
    const s = T.byId[r.service] || {};
    return {
      title: `${r.method} ${r.path}`, subtitle: `${s.name || r.service} · HTTP ${r.status || "sin respuesta"} · ${r.ms} ms`, color: s.hex,
      sections: [section("Solicitud", r.request === undefined ? "(sin cuerpo)" : r.request, r.request === undefined ? "text" : "json"),
                 section("Respuesta", r.response === null ? "(sin cuerpo)" : r.response, r.response === null ? "text" : "json")].filter(Boolean)
    };
  }

  function eventInfo(ev, to) {
    const pub = ev.publisher ? T.byId[ev.publisher] : null;
    const dest = to ? T.byId[to].name : (ev.consumers.length ? ev.consumers.map(c => T.byId[c].name).join(", ") : "sin consumidores");
    return {
      title: ev.exchange, subtitle: `${pub ? pub.name : "?"} → ${dest} · ${U.time(ev.receivedAt)}`, color: pub ? pub.hex : undefined,
      sections: [section("Cuerpo del evento", ev.payload)].filter(Boolean)
    };
  }

  function stationInfo(id) {
    const s = T.byId[id];
    const pubs = T.events.filter(e => e.publisher === id).map(e => e.name);
    const subs = T.events.filter(e => e.consumers.includes(id)).map(e => `${e.name} (de ${T.byId[e.publisher].name.split(" ")[0]})`);
    const h = NT.live.health[id] || {};
    const l = last[id] || {};
    const sections = [
      { label: "Ficha", kind: "kv", data: {
        Rol: s.role, "Ruta en el gateway": T.prefix(id) + "/**", Consul: s.consul, "Base de datos": s.db, Seguridad: s.auth,
        Estado: h.status === "passing" ? "en línea" : h.status === "critical" ? "caído" : "sin datos" } },
      { label: "Publica", kind: "json", data: pubs.length ? pubs : "nada" },
      { label: "Consume", kind: "json", data: subs.length ? subs : "nada" }
    ];
    if (l.published) sections.push({ label: `Último evento publicado: ${l.published.exchange}`, kind: "json", data: l.published.payload });
    if (l.consumed) sections.push({ label: `Último evento consumido: ${l.consumed.exchange}`, kind: "json", data: l.consumed.payload });
    if (l.http) {
      const r = l.http;
      sections.push({ label: `Última solicitud: ${r.method} ${r.path}`, kind: "json", data: r.request === undefined ? "(sin cuerpo)" : r.request });
      sections.push({ label: `Última respuesta: HTTP ${r.status || "×"}`, kind: "json", data: r.response === null ? "(sin cuerpo)" : r.response });
    }
    return { title: s.name, subtitle: s.role, color: s.hex, sections };
  }

  function resolveInspect(el) {
    const key = el && el.getAttribute && el.getAttribute("data-inspect");
    if (!key) return null;
    if (key.startsWith("svc:")) return T.byId[key.slice(4)] ? stationInfo(key.slice(4)) : null;
    return trainInfo.get(key) || null;
  }

  function attachInspect() {
    if (NT.inspect && svg) detach = NT.inspect.attach(svg, resolveInspect);
  }

  // ---------- side panel ----------
  function select(id) {
    selected = id;
    if (!svg) return;
    svg.querySelectorAll(".station").forEach(g => g.classList.toggle("selected", g.dataset.id === id));
    const s = T.byId[id];
    const pubs = T.events.filter(e => e.publisher === id);
    const subs = T.events.filter(e => e.consumers.includes(id));
    const h = (NT.live.health[id] || {});
    const detail = root.querySelector("#station-detail");
    if (!detail) return;
    detail.innerHTML = U.html`
      <h2><span class="line-dot" style="--line:${s.hex}"></span>${s.name}</h2>
      <p class="muted" style="margin-top:-4px">${s.role}</p>
      <dl class="ctx">
        <dt>Ruta en el gateway</dt><dd>${T.prefix(id)}/**</dd>
        <dt>Nombre en Consul</dt><dd>${s.consul}</dd>
        <dt>Estado</dt><dd>${h.status === "passing" ? "en línea" : h.status === "critical" ? "caído" : "sin datos"}${h.instances ? ` (${h.instances.length} instancia${h.instances.length === 1 ? "" : "s"})` : ""}</dd>
        <dt>Seguridad</dt><dd>${s.auth}</dd>
        <dt>Base de datos</dt><dd>${s.db}</dd>
        <dt>Outbox</dt><dd>${s.outbox ? "sí, publica desde su tabla outbox" : "no publica eventos"}</dd>
      </dl>
      <div class="grid-2" style="margin-top:14px">
        <div><h3>Publica</h3>${pubs.length ? U.raw(pubs.map(e => U.html`<div><code>${e.name}</code></div>`).join("")) : U.raw('<span class="muted">nada</span>')}</div>
        <div><h3>Consume</h3>${subs.length ? U.raw(subs.map(e => U.html`<div><code>${e.name}</code> <span class="muted">de ${T.byId[e.publisher].name.split(" ")[0]}</span></div>`).join("")) : U.raw('<span class="muted">nada</span>')}</div>
      </div>
      <p class="muted" style="margin-top:14px">Sin llamadas REST entre servicios: todo cambio viaja como evento.</p>`;
  }

  let boardPrev = null;

  // opts.mini: only the drawing, embedded by another view (the guided flow).
  function mount(el, opts = {}) {
    root = el;
    if (opts.mini) {
      el.innerHTML = `<svg class="map-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Mapa de servicios en vivo"></svg>`;
      svg = el.querySelector("svg");
      draw();
      attachInspect();
      offs = [NT.bus.on("http", onHttp), NT.bus.on("event", onEvent), NT.bus.on("health", applyHealth)];
      return;
    }
    el.innerHTML = `
      <div class="view-head">
        <div>
          <h1>Mapa del sistema</h1>
          <p>Cada servicio es una estación con su propia base de datos. Las llamadas entran por el API Gateway; los eventos viajan por RabbitMQ hasta cada servicio que los escucha. Toca una estación para ver qué publica y qué consume.</p>
        </div>
        <div class="actions"><a class="btn" href="#flujo">Recorrer un pedido</a></div>
      </div>
      <div class="map-wrap"><svg class="map-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Mapa de servicios, gateway, Consul y RabbitMQ"></svg></div>
      <div class="map-side">
        <section class="panel" id="station-detail"></section>
        <section class="panel">
          <h2>Shared kernels</h2>
          <p class="muted" style="margin-top:-4px">Paquetes NuGet comunes que comparten los servicios, así todos hablan el mismo idioma de seguridad y eventos.</p>
          <div class="kernels" id="kernels"></div>
          <h3 style="margin-top:16px">Cómo leer el mapa</h3>
          <div class="muted">Línea gruesa: ruta del gateway al servicio. Línea hacia la derecha: conexión al broker. Punteado violeta: registro en Consul. No hay llamadas REST entre servicios: todo lo que se dicen es un evento por el broker.</div>
        </section>
      </div>`;
    svg = el.querySelector("svg");
    el.querySelector("#kernels").innerHTML = T.kernels.map(k => U.html`<div class="kernel"><b>${k.id}</b><span>${k.pkg}</span><div class="muted" style="font-size:13px;margin-top:4px">${k.what}</div>
      <div class="users">${U.raw(T.services.filter(s => s.kernels.includes(k.id)).map(s => U.html`<span class="tag" style="background:${s.hex};color:#fff">${s.name.split(" ")[0]}</span>`).join(""))}</div></div>`).join("");
    draw();
    attachInspect();
    offs = [NT.bus.on("http", onHttp), NT.bus.on("event", onEvent), NT.bus.on("health", applyHealth)];
    // The trains already show every event; give the map the full height on small screens.
    const board = NT.live && NT.live.board;
    if (board) { boardPrev = board.isCollapsed(); board.collapse(true); }
  }

  function unmount() {
    const board = NT.live && NT.live.board;
    if (board && boardPrev !== null) board.collapse(boardPrev);
    boardPrev = null;
    offs.forEach(f => f()); offs = [];
    if (detach) { detach(); detach = null; }
    trainInfo.clear();
    svg = null; trainLayer = null;
  }

  return { mount, unmount };
})();
