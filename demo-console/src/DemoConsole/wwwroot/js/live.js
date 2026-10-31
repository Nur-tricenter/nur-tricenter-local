// Live feeds shared by all views: broker events (SSE or sim), Consul health, the departure
// board at the bottom of the screen, the status strip and the session chip in the top bar.
NT.live = (function () {
  const U = NT.util, T = NT.topology, cfg = NT.config;
  const events = [];
  let health = {};

  // Joseco wraps the contract in an envelope; dig for the object that holds the payload fields.
  function unwrap(payload) {
    if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { return payload; } }
    for (const key of ["message", "data", "payload", "content"]) {
      const inner = U.pick(payload, key);
      if (inner && typeof inner === "object") return unwrap(inner);
      if (typeof inner === "string" && inner.trim().startsWith("{")) return unwrap(inner);
    }
    return payload;
  }

  function summarize(exchange, payload) {
    const def = T.eventByName[exchange];
    const keys = def ? def.payload : Object.keys(payload || {});
    return keys.map(k => [k, U.pick(payload, k)])
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .slice(0, 3)
      .map(([k, v]) => `${k}=${typeof v === "string" && v.length > 18 ? v.slice(0, 8) + "…" : v}`)
      .join("  ");
  }

  function accept(raw) {
    const payload = unwrap(raw.payload);
    const def = T.eventByName[raw.exchange];
    const ev = {
      id: raw.id || U.uid(), exchange: raw.exchange, receivedAt: raw.receivedAt || new Date().toISOString(),
      payload, raw: raw.payload, def,
      publisher: def ? def.publisher : null, consumers: def ? def.consumers : [],
      summary: summarize(raw.exchange, payload)
    };
    if (events.some(e => e.id === ev.id)) return;
    events.unshift(ev);
    if (events.length > cfg.boardMax) events.pop();
    renderBoard(ev);
    NT.bus.emit("event", ev);
  }

  function connect() {
    const conn = document.getElementById("board-conn");
    const setConn = (on, label) => {
      conn.textContent = label;
      conn.classList.toggle("on", on);
      NT.bus.emit("live", { connected: on });
    };
    if (cfg.mode === "sim") {
      NT.bus.on("sim-event", accept);
      setConn(true, "simulación en el navegador");
      return;
    }
    const es = new EventSource(cfg.liveEvents);
    es.onopen = () => setConn(true, "conectado a RabbitMQ");
    es.onerror = () => setConn(false, "reconectando con el broker…");
    es.onmessage = m => { try { accept(JSON.parse(m.data)); } catch (e) { console.warn("bad event", e); } };
  }

  // ---------- departure board ----------
  function boardRow(ev, fresh) {
    const pub = ev.publisher ? T.byId[ev.publisher] : null;
    const to = ev.consumers.length ? ev.consumers.map(c => T.byId[c].name.split(" ")[0]).join(", ") : "sin consumidores";
    return U.html`<li class="board-row${fresh ? " new" : ""}" data-id="${ev.id}" style="--line:${pub ? pub.hex : "#8c969f"}">
      <time>${U.time(ev.receivedAt)}</time><i></i>
      <span class="ex">${ev.exchange}</span>
      <span class="summary">${ev.summary}</span>
      <span class="route">${pub ? pub.name.split(" ")[0] : "?"} → ${to}</span></li>`;
  }

  function renderBoard(fresh) {
    const list = document.getElementById("board-list");
    document.getElementById("board-count").textContent = `${events.length} evento${events.length === 1 ? "" : "s"}`;
    if (!events.length) {
      list.innerHTML = `<li class="board-empty">Todavía no pasó ningún evento. Ejecuta un paso del recorrido para ver los mensajes viajar por RabbitMQ.</li>`;
      return;
    }
    if (fresh && list.querySelector(".board-row")) list.insertAdjacentHTML("afterbegin", boardRow(fresh, true));
    else list.innerHTML = events.map(e => boardRow(e, e === fresh)).join("");
    while (list.children.length > cfg.boardMax) list.lastElementChild.remove();
  }

  // Same logic for the toggle button and for views that need the room (the flow view).
  const board = {
    collapse(on) {
      const el = document.getElementById("board");
      const btn = document.getElementById("board-toggle");
      if (!el) return;
      el.classList.toggle("collapsed", !!on);
      if (btn) btn.setAttribute("aria-expanded", String(!on));
    },
    isCollapsed() {
      const el = document.getElementById("board");
      return !!el && el.classList.contains("collapsed");
    }
  };
  const collapse = on => board.collapse(on);
  const isCollapsed = () => board.isCollapsed();

  // ---------- health ----------
  async function pollHealth() {
    try { health = await NT.api.health(); } catch { /* keep last */ }
    renderStrip();
    NT.bus.emit("health", health);
  }

  function renderStrip() {
    const strip = document.getElementById("status-strip");
    strip.innerHTML = T.services.map(s => {
      const st = (health[s.id] || {}).status || "unknown";
      const cls = st === "passing" ? "" : st === "unknown" ? " unknown" : " down";
      const label = st === "passing" ? "en línea" : st === "unknown" ? "sin datos" : "caído";
      return U.html`<span class="pill${cls}" style="--line:${s.hex}" title="${s.name}: ${label}"><i></i>${s.name.split(" ")[0]}</span>`;
    }).join("");
  }

  function renderSession(auth) {
    const chip = document.getElementById("session-chip");
    if (!auth) { chip.innerHTML = `<b>Sin sesión</b><span>Inicia sesión en Identidad</span>`; return; }
    const c = auth.claims || {};
    const name = U.claimName(c);
    const scopes = U.claimScopes(c);
    chip.innerHTML = U.html`<b>${name}</b><span>${scopes.length} permisos · vence ${U.time((c.exp || 0) * 1000)}</span>`;
  }

  function start() {
    renderBoard();
    renderStrip();
    renderSession(null);
    NT.bus.on("auth", renderSession);
    connect();
    pollHealth();
    setInterval(pollHealth, cfg.pollConsulMs);

    document.getElementById("board-toggle").addEventListener("click", () => collapse(!isCollapsed()));
    document.getElementById("board-list").addEventListener("click", e => {
      const row = e.target.closest(".board-row");
      if (row) { location.hash = "#eventos"; setTimeout(() => NT.bus.emit("focus-event", row.dataset.id), 50); }
    });
  }

  return { start, events, board, get health() { return health; }, pollHealth };
})();
