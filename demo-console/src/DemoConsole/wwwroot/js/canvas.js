// Flow canvas: browser -> gateway -> services, plus the async path service outbox -> RabbitMQ
// port -> consumer inbox. One rAF loop moves every packet; arrival callbacks update counters.
//   NT.canvas.mount(el) / unmount() / reset() / focus(svcId|null)
NT.canvas = (function () {
  const U = NT.util, T = NT.topology, esc = U.esc;
  const NS = "http://www.w3.org/2000/svg";
  // Wide viewBox (aspect ~2.4) to match the flow view's canvas box; text sizes are chosen so the
  // smallest label is ~10px on screen at 1366x768.
  const W = 1320, H = 540;
  const MAX_PACKETS = 40;
  const INK = "#1d2b3a", OK = "#2e8b57", BAD = "#c62828", BROKER_HEX = "#8c969f";
  const ORDER = ["identity", "ms1", "ms2", "ms3", "ms4", "ms5"];

  // ---------- geometry ----------
  const BR = { x: 8, w: 112, cy: 267, h: 88 };
  const GW = { x: 168, w: 148, cy: 267, h: 76 };
  const CS = { x: 168, y: 30, w: 148, h: 66 };
  const CARD = { x: 372, w: 330, h: 76, y0: 14, pitch: 86 };
  const TRAY = { x: CARD.x + CARD.w - 8, w: 116, h: 30 };
  const BRK = { x: 920, y: 12, w: 384, h: 506, head: 76, pitch: 39, rowH: 32 };
  const TRAY_CX = TRAY.x + TRAY.w / 2;
  const ANCHOR_X = CARD.x + 292;
  const top = id => CARD.y0 + ORDER.indexOf(id) * CARD.pitch;
  const outCy = id => top(id) + 20, inCy = id => top(id) + 56;

  const PORT_NAMES = ["paciente-published", "meal-plan-published", "meal-plan-composition-changed", "recipe-published",
    "contract-activated", "production-order-ready", "package-validated", "delivery-added-to-route",
    "delivery-completed", "delivery-failed"];
  const others = T.events.filter(e => !PORT_NAMES.includes(e.name));
  const portKey = ex => PORT_NAMES.includes(ex) ? ex : "otros";
  const PORTS = PORT_NAMES.map(n => ({ key: n, def: T.eventByName[n] || null })).concat([{ key: "otros", def: null }]);
  PORTS.forEach((p, i) => {
    p.y = BRK.y + BRK.head + i * BRK.pitch + BRK.rowH / 2;
    const evs = p.key === "otros" ? others : (p.def ? [p.def] : []);
    p.consumers = ORDER.filter(id => evs.some(e => e.consumers.includes(id)));
    p.publishers = ORDER.filter(id => evs.some(e => e.publisher === id));
    p.hex = p.def ? T.byId[p.def.publisher].hex : BROKER_HEX;
    p.label = p.key === "otros" ? `otros (${others.length})` : p.key;
    p.exchanges = evs.map(e => e.name);
  });
  const PORT = Object.fromEntries(PORTS.map(p => [p.key, p]));
  const hasInbox = id => T.events.some(e => e.consumers.includes(id));

  const EMPTY = "Todavía no pasó nada por aquí. Ejecuta un paso del recorrido.";
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- module state ----------
  let host = null, svg = null, mounted = false, offs = [], detach = null, usesWatch = false;
  let layers = {}, nodeEls = {}, portEls = {}, edges = {}, brokerCountEl = null;
  let S = null, focusId = null;
  let active = [], pktMap = new Map(), seq = 0, raf = 0, lastT = 0, timers = new Set();
  const widthCache = new Map();

  const freshState = () => {
    const nodes = {};
    ORDER.forEach(id => { nodes[id] = { req: null, res: null, pubEv: null, conEv: null, out: 0, in: 0, outRows: [], inRows: [], outTable: 0, inTable: 0, calls: 0 }; });
    ["gateway", "browser", "consul"].forEach(id => { nodes[id] = { req: null, res: null, calls: 0 }; });
    const ports = {};
    PORTS.forEach(p => { ports[p.key] = { count: 0, last: null }; });
    return { nodes, ports, brokerCount: 0 };
  };

  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (mounted) fn(); }, ms); timers.add(t); };
  const safe = fn => { if (fn) { try { fn(); } catch (e) { console.error(e); } } };

  function flash(el, cls, ms) {
    if (!el) return;
    cls = cls || "is-hot";
    el.classList.add(cls);
    el.__ft = el.__ft || {};
    clearTimeout(el.__ft[cls]);
    el.__ft[cls] = setTimeout(() => el.classList.remove(cls), ms || 800);
  }

  // ---------- static drawing ----------
  function serviceNode(id) {
    const s = T.byId[id], x = CARD.x, y = top(id), hex = s.hex;
    return `<g class="cv-node cv-svc" data-svc="${id}" data-inspect="node:${id}" tabindex="0" role="button" aria-label="${esc(s.name)}" style="--c:${hex}">
      <rect class="cv-halo" x="${x - 8}" y="${y - 8}" width="${CARD.w + 16}" height="${CARD.h + 16}" rx="18" fill="${hex}" filter="url(#cv-blur)"/>
      <rect class="cv-card-outer" x="${x}" y="${y}" width="${CARD.w}" height="${CARD.h}" rx="12" fill="${hex}" stroke="${hex}" filter="url(#cv-shadow)"/>
      <rect class="cv-card" x="${x + 8}" y="${y + 1.5}" width="${CARD.w - 9.5}" height="${CARD.h - 3}" rx="10"/>
      <text class="cv-name" x="${x + 22}" y="${y + 25}">${esc(s.name)}</text>
      <text class="cv-role" x="${x + 22}" y="${y + 45}">${esc(s.role)}</text>
      <circle class="cv-dot" cx="${x + 298}" cy="${y + 20}" r="6"/>
      <g class="cv-tag"><rect x="${x + 214}" y="${y + 7}" width="66" height="26" rx="13"/><text x="${x + 247}" y="${y + 25}" text-anchor="middle">caído</text></g>
      <g class="cv-db" transform="translate(${x + 22} ${y + 52})">
        <path d="M0 4v11a7 4 0 0 0 14 0V4"/><ellipse cx="7" cy="4" rx="7" ry="4"/><path d="M0 10a7 4 0 0 0 14 0" fill="none"/>
      </g>
      <text class="cv-dbname" x="${x + 44}" y="${y + 67}">${esc(s.db)}</text>
      ${tray(id, "out")}${hasInbox(id) ? tray(id, "in") : ""}
    </g>`;
  }

  function tray(id, side) {
    const s = T.byId[id], y = side === "out" ? top(id) + 5 : top(id) + 41, x = TRAY.x;
    const arrow = side === "out"
      ? `M${x + 14} ${y + 21}V${y + 9}m-3 3 3 -3 3 3`
      : `M${x + 14} ${y + 9}V${y + 21}m-3 -3 3 3 3 -3`;
    return `<g class="cv-tray cv-${side}" data-svc="${id}" data-side="${side}" data-inspect="tray:${id}:${side}" tabindex="0" role="button" aria-label="${side}box de ${esc(s.name)}" style="--c:${s.hex}">
      <rect class="cv-tray-bg" x="${x}" y="${y}" width="${TRAY.w}" height="${TRAY.h}" rx="8"/>
      <path class="cv-tray-ico" d="${arrow}"/>
      <text class="cv-tray-lbl" x="${x + 28}" y="${y + 21}">${side}box</text>
      <g class="cv-badge zero"><rect x="${x + TRAY.w - 36}" y="${y + 5}" width="30" height="20" rx="10"/><text x="${x + TRAY.w - 21}" y="${y + 20}" text-anchor="middle">0</text></g>
    </g>`;
  }

  function portMarkup(p) {
    const x = BRK.x, rx = x + 14, rw = BRK.w - 28, ry = p.y - BRK.rowH / 2, right = x + BRK.w - 26;
    const dots = p.consumers.map((c, k) => `<circle cx="${right - k * 14}" cy="${p.y}" r="5" fill="${T.byId[c].hex}"/>`).join("");
    const cx = right - Math.max(0, p.consumers.length) * 14 - 2;
    return `<g class="cv-port" data-port="${p.key}" data-inspect="port:${p.key}" tabindex="0" role="button" aria-label="Exchange ${esc(p.label)}" style="--c:${p.hex}">
      <rect class="cv-port-row" x="${rx}" y="${ry}" width="${rw}" height="${BRK.rowH}" rx="9"/>
      <circle class="cv-port-dot" cx="${x}" cy="${p.y}" r="7.5"/>
      <circle cx="${x + 32}" cy="${p.y}" r="6" fill="${p.hex}"/>
      <text class="cv-port-name" x="${x + 46}" y="${p.y + 5.5}">${esc(p.label)}</text>
      <text class="cv-port-count" x="${cx}" y="${p.y + 5.5}" text-anchor="end"></text>
      ${dots}
    </g>`;
  }

  function staticMarkup() {
    const gwx = GW.x + GW.w / 2;
    const LG = { x: 8, y: 396, w: 300, h: 124 };
    const pill = (x, y, w, fill, txt) => `<rect x="${x}" y="${y}" width="${w}" height="26" rx="13" fill="${fill}"/><text x="${x + w / 2}" y="${y + 18}" class="cv-leg-pt">${txt}</text>`;
    const legend = `<g class="cv-legend">
      <rect x="${LG.x}" y="${LG.y}" width="${LG.w}" height="${LG.h}" rx="12"/>
      <text class="cv-leg-title" x="${LG.x + 14}" y="${LG.y + 24}">Cómo leerlo</text>
      ${pill(LG.x + 14, LG.y + 36, 74, INK, "POST /x")}<text class="cv-leg-t" x="${LG.x + 96}" y="${LG.y + 55}">petición</text>
      ${pill(LG.x + 164, LG.y + 36, 52, OK, "201")}<text class="cv-leg-t" x="${LG.x + 224}" y="${LG.y + 55}">respuesta</text>
      ${pill(LG.x + 14, LG.y + 68, 74, T.byId.ms3.hex, "evento")}<text class="cv-leg-t" x="${LG.x + 96}" y="${LG.y + 87}">broker</text>
      <rect x="${LG.x + 164}" y="${LG.y + 68}" width="72" height="26" rx="8" fill="#fff" stroke="${INK}" stroke-width="2"/><text x="${LG.x + 200}" y="${LG.y + 87}" class="cv-leg-t" text-anchor="middle">outbox</text><text class="cv-leg-t" x="${LG.x + 244}" y="${LG.y + 87}">BD</text>
      <text class="cv-leg-s" x="${LG.x + 14}" y="${LG.y + 114}">Cursor: ver datos · clic: fijar</text>
    </g>`;
    return `
      <defs>
        <pattern id="cv-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#e4e9e2" stroke-width="1"/></pattern>
        <filter id="cv-shadow" x="-10%" y="-15%" width="125%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#1d2b3a" flood-opacity=".16"/></filter>
        <filter id="cv-blur" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="8"/></filter>
      </defs>
      <rect x="-3000" y="-3000" width="7400" height="6800" fill="#f8faf7"/>
      <rect x="-3000" y="-3000" width="7400" height="6800" fill="url(#cv-grid)"/>
      <g class="cv-layer-edges"></g>
      <g class="cv-layer-hits"></g>
      <g class="cv-layer-nodes">
        <g class="cv-node cv-infra" data-svc="browser" data-inspect="node:browser" tabindex="0" role="button" aria-label="Navegador" style="--c:${INK}">
          <rect class="cv-halo" x="${BR.x - 8}" y="${BR.cy - BR.h / 2 - 8}" width="${BR.w + 16}" height="${BR.h + 16}" rx="18" fill="${INK}" filter="url(#cv-blur)"/>
          <rect class="cv-card-outer cv-plain" x="${BR.x}" y="${BR.cy - BR.h / 2}" width="${BR.w}" height="${BR.h}" rx="12" filter="url(#cv-shadow)"/>
          <g class="cv-laptop" transform="translate(${BR.x + BR.w / 2 - 15} ${BR.cy - 34})"><rect width="30" height="20" rx="3"/><path d="M-3 24H33L30 20H0Z"/></g>
          <text class="cv-name sm" x="${BR.x + BR.w / 2}" y="${BR.cy + 17}" text-anchor="middle">Navegador</text>
          <text class="cv-role" x="${BR.x + BR.w / 2}" y="${BR.cy + 36}" text-anchor="middle">esta consola</text>
        </g>

        <g class="cv-node cv-infra cv-gw" data-svc="gateway" data-inspect="node:gateway" tabindex="0" role="button" aria-label="API Gateway" style="--c:${INK}">
          <rect class="cv-halo" x="${GW.x - 8}" y="${GW.cy - GW.h / 2 - 8}" width="${GW.w + 16}" height="${GW.h + 16}" rx="46" fill="${INK}" filter="url(#cv-blur)"/>
          <rect class="cv-gw-body" x="${GW.x}" y="${GW.cy - GW.h / 2}" width="${GW.w}" height="${GW.h}" rx="${GW.h / 2}" filter="url(#cv-shadow)"/>
          <text class="cv-gw-t" x="${gwx}" y="${GW.cy - 3}" text-anchor="middle">API Gateway</text>
          <text class="cv-gw-s" x="${gwx}" y="${GW.cy + 19}" text-anchor="middle">YARP · :15005</text>
        </g>
        <text class="cv-gw-route" x="${gwx}" y="${GW.cy + GW.h / 2 + 22}" text-anchor="middle">/api/{servicio}/**</text>

        <g class="cv-node cv-infra cv-consul" data-svc="consul" data-inspect="node:consul" tabindex="0" role="button" aria-label="Consul" style="--c:var(--consul)">
          <rect class="cv-card-outer cv-plain" x="${CS.x}" y="${CS.y}" width="${CS.w}" height="${CS.h}" rx="12" filter="url(#cv-shadow)" style="stroke:var(--consul)"/>
          <text class="cv-name sm" x="${CS.x + CS.w / 2}" y="${CS.y + 27}" text-anchor="middle">Consul</text>
          <text class="cv-role" x="${CS.x + CS.w / 2}" y="${CS.y + 49}" text-anchor="middle">registro y salud</text>
        </g>

        ${ORDER.map(serviceNode).join("")}

        <rect class="cv-broker" x="${BRK.x}" y="${BRK.y}" width="${BRK.w}" height="${BRK.h}" rx="16" filter="url(#cv-shadow)"/>
        <text class="cv-brk-t" x="${BRK.x + 22}" y="${BRK.y + 30}">RabbitMQ</text>
        <text class="cv-role" x="${BRK.x + 22}" y="${BRK.y + 52}">${T.events.length} exchanges fanout</text>
        <text class="cv-brk-count" x="${BRK.x + BRK.w - 22}" y="${BRK.y + 30}" text-anchor="end">0 mensajes</text>
        <path class="cv-brk-sep" d="M${BRK.x + 16} ${BRK.y + 64}H${BRK.x + BRK.w - 16}"/>
        ${PORTS.map(portMarkup).join("")}
        ${legend}
      </g>
      <g class="cv-layer-pkts"></g>
      <g class="cv-layer-fx"></g>`;
  }

  // ---------- edges ----------
  function pathFor(kind, a, b) {
    const gx = GW.x + GW.w;
    if (kind === "http") {
      if (a === "b-g") return `M${BR.x + BR.w} ${BR.cy}H${GW.x}`;
      const ty = top(a.slice(2)) + 38;
      return `M${gx} ${GW.cy}C${gx + 30} ${GW.cy} ${CARD.x - 30} ${ty} ${CARD.x} ${ty}`;
    }
    if (kind === "reg") { const ty = top(a) + 10; return `M${CS.x + CS.w} ${CS.y + 33}C${CS.x + CS.w + 30} ${CS.y + 33} ${CARD.x - 30} ${ty} ${CARD.x} ${ty}`; }
    if (kind === "out") return `M${ANCHOR_X} ${outCy(a)}H${TRAY_CX}`;
    if (kind === "in") return `M${TRAY_CX} ${inCy(a)}H${ANCHOR_X}`;
    if (kind === "pub") {
      const p = PORT[b], y = outCy(a);
      return `M${TRAY_CX} ${y}C${TRAY_CX + 70} ${y} ${BRK.x - 70} ${p.y} ${BRK.x} ${p.y}`;
    }
    const p = PORT[a], y = inCy(b);   // con: port -> inbox
    return `M${BRK.x} ${p.y}C${BRK.x - 70} ${p.y} ${TRAY_CX + 70} ${y} ${TRAY_CX} ${y}`;
  }

  function edgeFor(kind, a, b) {
    const id = kind + ":" + a + (b !== undefined ? "|" + b : "");
    if (edges[id]) return edges[id];
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", pathFor(kind, a, b));
    const svcId = kind === "pub" ? a : kind === "con" ? b : null;
    let hex = INK;
    if (kind === "pub") hex = T.byId[a].hex;
    if (kind === "con") hex = PORT[a].hex;
    if (kind === "out" || kind === "in") path.setAttribute("class", "cv-inner");
    else {
      path.setAttribute("class", "cv-edge " + (kind === "http" ? "http" : kind));
      if (kind === "pub" || kind === "con") path.setAttribute("stroke", hex);
    }
    const e = { id, kind, a, b, path, len: 0, last: null, count: 0, hit: null, svcId };
    (kind === "out" || kind === "in" ? layers.edges : layers.edges).appendChild(path);
    if (kind === "http" || kind === "pub" || kind === "con") {
      const hit = document.createElementNS(NS, "path");
      hit.setAttribute("d", path.getAttribute("d"));
      hit.setAttribute("class", "cv-hit");
      hit.setAttribute("data-inspect", "edge:" + id);
      layers.hits.appendChild(hit);
      e.hit = hit;
    }
    edges[id] = e;
    return e;
  }

  function edgeLen(e) { return e.len || (e.len = e.path.getTotalLength()); }

  function buildEdges() {
    edgeFor("http", "b-g");
    ORDER.forEach(id => { edgeFor("http", "g-" + id); edgeFor("reg", id); edgeFor("out", id); if (hasInbox(id)) edgeFor("in", id); });
    T.events.forEach(ev => {
      const k = portKey(ev.name);
      edgeFor("pub", ev.publisher, k);
      ev.consumers.forEach(c => edgeFor("con", k, c));
    });
  }

  // ---------- packets ----------
  const ease = k => 0.5 - Math.cos(Math.PI * k) / 2;

  function textWidth(label) {
    let w = widthCache.get(label);
    if (w) return w;
    const t = document.createElementNS(NS, "text");
    t.setAttribute("class", "cv-pkt-t");
    t.textContent = label;
    layers.pkts.appendChild(t);
    w = t.getComputedTextLength();
    t.remove();
    widthCache.set(label, w);
    return w;
  }

  function paint(p, label) {
    const g = p.g;
    while (g.firstChild) g.removeChild(g.firstChild);
    if (!label) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("r", "10"); c.setAttribute("class", "cv-pkt-dot"); c.style.fill = p.color;
      g.appendChild(c);
      return;
    }
    if (label.length > 30) label = label.slice(0, 29) + "…";
    const w = textWidth(label) + 24;
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", -w / 2); r.setAttribute("y", -14); r.setAttribute("width", w); r.setAttribute("height", 28); r.setAttribute("rx", 14);
    r.setAttribute("class", "cv-pkt-pill"); r.style.fill = p.color;
    const t = document.createElementNS(NS, "text");
    t.setAttribute("class", "cv-pkt-t"); t.setAttribute("dy", ".35em"); t.setAttribute("text-anchor", "middle");
    t.textContent = label;
    g.appendChild(r); g.appendChild(t);
  }

  function place(p, k) {
    const leg = p.legs[p.i], e = leg.edge, len = edgeLen(e);
    const d = ease(k) * len, pt = e.path.getPointAtLength(leg.rev ? len - d : d);
    p.g.setAttribute("transform", `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`);
  }

  function startLeg(p) {
    const leg = p.legs[p.i];
    p.started = true; leg.arrived = false;
    paint(p, leg.label || "");
    place(p, 0);
    p.g.removeAttribute("visibility");
    flash(leg.edge.path, "is-hot", leg.dur + 700);
    safe(leg.onStart);
  }

  function finish(p, n) {
    p.g.remove(); pktMap.delete(p.id); active.splice(n, 1);
    safe(p.done);
  }

  function tick(now) {
    raf = 0;
    const dt = Math.max(0, Math.min(48, now - lastT)); lastT = now;
    for (let n = active.length - 1; n >= 0; n--) {
      const p = active[n];
      if (!p) continue;
      if (p.paused && now < p.pauseUntil) continue;
      p.t += dt;
      if (!p.started) { if (p.t < 0) continue; startLeg(p); }
      const leg = p.legs[p.i];
      const k = leg.dur ? Math.min(1, p.t / leg.dur) : 1;
      place(p, k);
      if (k >= 1 && !leg.arrived) { leg.arrived = true; safe(leg.onEnd); }
      if (p.t >= leg.dur + leg.hold) {
        if (++p.i >= p.legs.length) { finish(p, n); continue; }
        p.started = false; p.t = -(p.legs[p.i].delay || 0);
        if (p.t >= 0) startLeg(p);
      }
    }
    if (active.length) raf = requestAnimationFrame(tick);
  }

  // o: { kind, color, info, legs: [{ edge, rev?, dur, label?, delay?, onStart?, onEnd? }], done? }
  function spawn(o) {
    if (!mounted) return null;
    if (active.length >= MAX_PACKETS) {         // too busy: skip the travel, keep the effects
      o.legs.forEach(l => safe(l.onEnd)); safe(o.done);
      return null;
    }
    const red = reduced();
    o.legs.forEach(l => { l.hold = red ? 260 : 70; if (red) l.dur = 0; });
    const id = ++seq;
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "cv-pkt cv-" + o.kind);
    g.setAttribute("data-inspect", "pkt:" + id);
    g.setAttribute("visibility", "hidden");
    const p = { id, g, legs: o.legs, i: 0, t: -(o.legs[0].delay || 0), started: false, info: o.info, color: o.color, done: o.done, paused: false, pauseUntil: 0 };
    g.addEventListener("mouseenter", () => { p.paused = true; p.pauseUntil = performance.now() + 6000; });
    g.addEventListener("mouseleave", () => { p.paused = false; });
    layers.pkts.appendChild(g);
    pktMap.set(id, p); active.push(p);
    if (p.t >= 0) startLeg(p);
    if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(tick); }
    return p;
  }

  // ---------- counters / effects ----------
  function setBadge(trayEl, n) {
    const b = trayEl.querySelector(".cv-badge");
    b.querySelector("text").textContent = n > 99 ? "99+" : String(n);
    b.classList.toggle("zero", n === 0);
    flash(b, "is-hot", 450);
  }

  function bump(id, side) {
    const n = S.nodes[id], els = nodeEls[id];
    n[side]++;
    const tr = els && els[side + "Tray"];
    if (tr) { setBadge(tr, n[side]); flash(tr); }
  }

  function floatText(x, y, text, color) {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("class", "cv-float"); t.setAttribute("x", x); t.setAttribute("y", y);
    t.style.setProperty("--c", color || INK);
    t.textContent = text;
    layers.fx.appendChild(t);
    const red = reduced();
    later(() => t.classList.add("go"), red ? 1200 : 30);
    later(() => t.remove(), 1700);
  }

  function shortPath(path, svc) {
    let p = String(path || "").split("?")[0];
    const pre = T.prefix(svc) + "/v1";
    if (p.startsWith(pre)) p = p.slice(pre.length);
    const segs = p.split("/").filter(Boolean).map(s => s.length > 14 ? s.slice(0, 6) + "…" : s);
    return "/" + segs.slice(-2).join("/");
  }

  // ---------- bus handlers ----------
  function onHttp(r) {
    if (!mounted || r.quiet || !S.nodes[r.service] || !ORDER.includes(r.service)) return;
    const id = r.service, s = T.byId[id], n = S.nodes[id];
    const ok = r.status >= 200 && r.status < 400;
    const reqLabel = `${r.method} ${shortPath(r.path, id)}`;
    const resLabel = r.status ? String(r.status) : "sin respuesta";
    const reqData = { method: r.method, path: r.path, authorized: !!r.authorized, body: r.request === undefined ? null : r.request };
    const resData = { status: r.status, ms: r.ms, body: r.response === undefined ? null : r.response };
    const eBG = edges["http:b-g"], eGS = edges["http:g-" + id];
    const reqInfo = { title: `Petición ${reqLabel}`, subtitle: `Navegador → API Gateway → ${s.name}`, color: INK, sections: [
      r.request === undefined || r.request === null ? { label: "Cuerpo enviado", data: "(sin cuerpo)", kind: "text" } : { label: "Cuerpo enviado", data: r.request, kind: "json" },
      { label: "Ruta completa", data: `${r.method} ${r.path}`, kind: "text" },
      { label: "Autenticación", data: r.authorized ? "Con token JWT en Authorization: Bearer" : "Sin token", kind: "text" }] };
    const resInfo = { title: `Respuesta ${resLabel}`, subtitle: `${s.name} → API Gateway → Navegador · ${r.ms} ms`, color: ok ? OK : BAD, sections: [
      r.response === undefined || r.response === null ? { label: "Cuerpo recibido", data: "(sin cuerpo)", kind: "text" } : { label: "Cuerpo recibido", data: r.response, kind: "json" },
      { label: "Estado", data: `${r.status || "sin respuesta"} · ${r.ms} ms`, kind: "text" }] };

    const respond = () => {
      n.res = resData;
      spawn({ kind: "res", color: ok ? OK : BAD, info: resInfo, legs: [
        { edge: eGS, rev: true, dur: 560, label: resLabel, onEnd: () => { flash(nodeEls.gateway.g); eGS.last = { req: reqData, res: resData }; } },
        { edge: eBG, rev: true, dur: 420, label: resLabel, onEnd: () => {
          flash(nodeEls.browser.g); eBG.last = { req: reqData, res: resData };
          S.nodes.browser.res = resData; S.nodes.gateway.res = resData;
        } }] });
    };

    spawn({ kind: "req", color: INK, info: reqInfo, legs: [
      { edge: eBG, dur: 420, label: reqLabel, onEnd: () => {
        flash(nodeEls.gateway.g); eBG.last = { req: reqData }; S.nodes.browser.req = reqData; S.nodes.gateway.req = reqData; S.nodes.gateway.calls++;
      } },
      { edge: eGS, dur: 560, label: reqLabel, onEnd: () => {
        flash(nodeEls[id].g); flash(nodeEls[id].db, "is-hot", 900);
        n.req = reqData; n.calls++; eGS.last = { req: reqData };
        later(respond, Math.min(Math.max((r.ms || 0) * 0.4, 160), 520));
      } }] });
  }

  function onEvent(ev) {
    if (!mounted || !ev || !S.nodes[ev.publisher] || !ORDER.includes(ev.publisher)) return;
    const pubId = ev.publisher, pub = T.byId[pubId], hex = pub.hex;
    const key = portKey(ev.exchange), port = PORT[key], ps = S.ports[key];
    const def = T.eventByName[ev.exchange];
    const consumers = (ev.consumers || []).filter(c => ORDER.includes(c));
    const evInfo = { exchange: ev.exchange, type: def && def.type, publisher: pubId, consumers, payload: ev.payload };
    const info = {
      title: ev.exchange, color: hex,
      subtitle: `${pub.name} → ${consumers.length ? consumers.map(c => T.byId[c].name).join(", ") : "sin consumidores"}`,
      sections: [{ label: "Payload del evento", data: ev.payload === undefined ? "(sin datos)" : ev.payload, kind: ev.payload === undefined ? "text" : "json" }] };
    const ePub = edgeFor("pub", pubId, key);

    const arrivePort = () => {
      ps.count++; ps.last = evInfo; S.brokerCount++;
      portEls[key].count.textContent = "×" + ps.count;
      brokerCountEl.textContent = S.brokerCount + (S.brokerCount === 1 ? " mensaje" : " mensajes");
      ePub.last = evInfo; ePub.count++;
      flash(portEls[key].g, "is-hot", 900);
      if (!consumers.length) { floatText(BRK.x - 74, port.y - 20, "sin consumidores", BAD); return; }
      consumers.forEach((c, k) => {
        const cn = S.nodes[c], eCon = edgeFor("con", key, c);
        const arriveNode = () => { flash(nodeEls[c].g); cn.conEv = evInfo; };
        if (!hasInbox(c)) { arriveNode(); return; }
        spawn({ kind: "evt", color: hex, info, legs: [
          { edge: eCon, dur: 950, delay: k * 130, onEnd: () => { bump(c, "in"); eCon.last = evInfo; eCon.count++; } },
          { edge: edgeFor("in", c), dur: 380, onEnd: arriveNode }] });
      });
    };

    spawn({ kind: "evt", color: hex, info, legs: [
      { edge: edgeFor("out", pubId), dur: 380, label: ev.exchange, onEnd: () => { bump(pubId, "out"); S.nodes[pubId].pubEv = evInfo; flash(nodeEls[pubId].g); } },
      { edge: ePub, dur: 950, label: ev.exchange, onEnd: arrivePort }] });
  }

  function onOutboxRow(r) {
    if (!mounted || !r || !S.nodes[r.service] || !ORDER.includes(r.service)) return;
    const side = r.table === "inbox" ? "in" : "out", n = S.nodes[r.service], els = nodeEls[r.service];
    n[side + "Rows"].unshift(r); if (n[side + "Rows"].length > 8) n[side + "Rows"].pop();
    n[side + "Table"]++;
    const tr = els[side + "Tray"];
    if (!tr) { flash(els.g); return; }
    flash(tr, "is-hot", 1000);
    const y = side === "out" ? outCy(r.service) : inCy(r.service);
    floatText(TRAY_CX, y - 20, String(r.type || "fila").slice(0, 26), T.byId[r.service].hex);
  }

  function applyHealth(h) {
    if (!mounted) return;
    h = h || {};
    ORDER.forEach(id => {
      const st = (h[id] || {}).status || "unknown", el = nodeEls[id];
      el.g.classList.toggle("is-down", st === "critical");
      el.g.classList.toggle("is-unk", st === "unknown");
      el.g.classList.toggle("is-warn", st === "warning");
      el.dot.setAttribute("data-st", st);
      const reg = edges["reg:" + id];
      if (reg) reg.path.setAttribute("class", "cv-edge reg " + (st === "passing" ? "ok" : st === "critical" ? "bad" : "unk"));
      S.nodes[id].health = st;
    });
  }

  function focus(id) {
    focusId = id && nodeEls[id] ? id : null;
    if (!svg) return;
    svg.classList.toggle("has-focus", !!focusId);
    Object.keys(nodeEls).forEach(k => nodeEls[k].g.classList.toggle("is-focus", k === focusId));
  }

  function onStep(s) {
    if (!mounted || !s) return;
    if (s.phase === "start") focus(s.svc);
    else if (s.phase === "failed" && nodeEls[s.svc]) flash(nodeEls[s.svc].g, "is-bad", 1800);
  }

  // ---------- inspector data ----------
  const empty = () => [{ label: "", data: EMPTY, kind: "text" }];
  const lines = a => a.length ? a : ["nada"];

  function nodeInfo(id) {
    if (id === "browser") {
      const n = S.nodes.browser, sec = [];
      if (n.req) sec.push({ label: "Última petición enviada", data: n.req, kind: "json" });
      if (n.res) sec.push({ label: "Última respuesta recibida", data: n.res, kind: "json" });
      return { title: "Navegador", subtitle: "Esta consola: llama al gateway con fetch()", color: INK, sections: sec.length ? sec : empty() };
    }
    if (id === "gateway") {
      const n = S.nodes.gateway, sec = [{ label: "Qué hace", data: "Punto único de entrada (YARP). Recibe /api/{servicio}/** y lo reenvía a una instancia sana que Consul conoce.", kind: "text" }];
      if (n.req) sec.push({ label: "Última petición", data: n.req, kind: "json" });
      if (n.res) sec.push({ label: "Última respuesta", data: n.res, kind: "json" });
      return { title: "API Gateway", subtitle: "YARP · puerto 15005 · " + n.calls + " peticiones", color: INK, sections: sec };
    }
    if (id === "consul") {
      return { title: "Consul", subtitle: "Registro y salud · :8500", color: "#8a4f7d", sections: [
        { label: "Qué hace", data: "Cada servicio se registra al arrancar y Consul revisa su salud. El gateway solo enruta a instancias sanas.", kind: "text" },
        { label: "Estado de servicios", kind: "kv", data: ORDER.map(s => [T.byId[s].name, ({ passing: "en línea", critical: "caído", warning: "con avisos" })[S.nodes[s].health] || "sin datos"]) }] };
    }
    const s = T.byId[id], n = S.nodes[id], sec = [];
    if (n.req) sec.push({ label: "Última petición", data: n.req, kind: "json" });
    if (n.res) sec.push({ label: "Última respuesta", data: n.res, kind: "json" });
    if (n.pubEv) sec.push({ label: "Último evento publicado", data: n.pubEv, kind: "json" });
    if (n.conEv) sec.push({ label: "Último evento consumido", data: n.conEv, kind: "json" });
    if (!sec.length) sec.push(...empty());
    sec.push({ label: "Publica", data: lines(T.events.filter(e => e.publisher === id).map(e => e.name)), kind: "text" });
    sec.push({ label: "Consume", data: lines(T.events.filter(e => e.consumers.includes(id)).map(e => e.name)), kind: "text" });
    return { title: s.name, subtitle: `${s.role} · Consul: ${s.consul} · BD: ${s.db}`, color: s.hex, sections: sec };
  }

  function trayInfo(id, side) {
    const s = T.byId[id], n = S.nodes[id], rows = n[side + "Rows"];
    const what = side === "out"
      ? "Tabla en la base del propio servicio. El evento se guarda aquí en la misma transacción que el dato de negocio y un publicador lo envía luego a RabbitMQ: no se pierde ni se publica algo que no se guardó."
      : "Tabla donde el servicio anota cada mensaje que recibe de RabbitMQ antes de procesarlo. Así un mensaje repetido no se procesa dos veces (idempotencia).";
    const last = side === "out" ? n.pubEv : n.conEv;
    const sec = [{ label: "Qué es", data: what, kind: "text" }];
    if (rows.length) sec.push({ label: "Últimas filas vistas en la tabla", data: rows, kind: "json" });
    else sec.push({ label: "Filas en la tabla", data: "Todavía no se vio ninguna fila nueva.", kind: "text" });
    if (last) sec.push({ label: side === "out" ? "Último mensaje publicado" : "Último mensaje recibido", data: last, kind: "json" });
    return { title: `${side === "out" ? "Outbox" : "Inbox"} de ${s.name}`, color: s.hex,
      subtitle: `${n[side]} mensajes por aquí · ${n[side + "Table"]} filas nuevas en tabla`, sections: sec };
  }

  function portInfo(key) {
    const p = PORT[key], ps = S.ports[key];
    const sec = [{ label: "Recorrido", kind: "kv", data: [
      ["Publica", p.publishers.map(i => T.byId[i].name).join(", ") || "—"],
      ["Consumen", p.consumers.map(i => T.byId[i].name).join(", ") || "nadie todavía"],
      ["Mensajes", ps.count]] }];
    if (key === "otros") sec.push({ label: "Exchanges agrupados", data: p.exchanges, kind: "text" });
    if (ps.last) sec.push({ label: "Último mensaje" + (key === "otros" ? " · " + ps.last.exchange : ""), data: ps.last.payload === undefined ? ps.last : ps.last.payload, kind: "json" });
    else sec.push({ label: "", data: EMPTY, kind: "text" });
    return { title: key === "otros" ? p.label : "Exchange " + key, color: p.hex,
      subtitle: `${p.publishers.map(i => T.byId[i].name).join(", ") || "—"} → ${p.consumers.length ? p.consumers.map(i => T.byId[i].name.split(" ")[0]).join(", ") : "sin consumidores"}`, sections: sec };
  }

  function edgeInfo(id) {
    const e = edges[id]; if (!e) return null;
    if (e.kind === "http") {
      const svcId = e.a === "b-g" ? null : e.a.slice(2), svc = svcId && T.byId[svcId];
      const sec = [];
      if (e.last && e.last.req) sec.push({ label: "Última petición", data: e.last.req, kind: "json" });
      if (e.last && e.last.res) sec.push({ label: "Última respuesta", data: e.last.res, kind: "json" });
      return { title: svc ? `API Gateway → ${svc.name}` : "Navegador → API Gateway", color: svc ? svc.hex : INK,
        subtitle: svc ? `Ruta ${T.prefix(svcId)}/**` : "HTTP hacia el gateway", sections: sec.length ? sec : empty() };
    }
    const pubSide = e.kind === "pub", svc = T.byId[pubSide ? e.a : e.b], p = PORT[pubSide ? e.b : e.a];
    return { title: pubSide ? `${svc.name} → exchange ${p.key}` : `Exchange ${p.key} → inbox de ${svc.name}`, color: pubSide ? svc.hex : p.hex,
      subtitle: `${e.count} mensajes por este tramo`, sections: e.last ? [{ label: "Último mensaje", data: e.last.payload === undefined ? e.last : e.last.payload, kind: "json" }] : empty() };
  }

  function resolve(el) {
    if (!mounted) return null;
    const key = el.getAttribute("data-inspect") || "", i = key.indexOf(":"), type = key.slice(0, i), rest = key.slice(i + 1);
    if (type === "node") return nodeInfo(rest);
    if (type === "tray") { const [id, side] = rest.split(":"); return trayInfo(id, side); }
    if (type === "port") return portInfo(rest);
    if (type === "edge") return edgeInfo(rest);
    if (type === "pkt") { const p = pktMap.get(+rest); return p ? p.info : null; }
    return null;
  }

  // ---------- public ----------
  function collectRefs() {
    layers = { edges: svg.querySelector(".cv-layer-edges"), hits: svg.querySelector(".cv-layer-hits"),
      pkts: svg.querySelector(".cv-layer-pkts"), fx: svg.querySelector(".cv-layer-fx") };
    nodeEls = {};
    svg.querySelectorAll(".cv-node").forEach(g => {
      const id = g.getAttribute("data-svc");
      nodeEls[id] = { g, db: g.querySelector(".cv-db"), dot: g.querySelector(".cv-dot"),
        outTray: g.querySelector(".cv-tray.cv-out"), inTray: g.querySelector(".cv-tray.cv-in") };
    });
    portEls = {};
    svg.querySelectorAll(".cv-port").forEach(g => { portEls[g.getAttribute("data-port")] = { g, count: g.querySelector(".cv-port-count") }; });
    brokerCountEl = svg.querySelector(".cv-brk-count");
  }

  function mount(el, opts) {
    if (mounted) unmount();
    host = el;
    host.classList.add("cv-host");
    host.innerHTML = `<svg class="cv-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="Plataforma en vivo: navegador, gateway, servicios y RabbitMQ"></svg>`;
    svg = host.firstChild;
    svg.innerHTML = staticMarkup();
    mounted = true;
    S = freshState();
    edges = {};
    collectRefs();
    buildEdges();
    applyHealth(NT.live && NT.live.health);
    detach = NT.inspect ? NT.inspect.attach(svg, resolve) : null;
    offs = [NT.bus.on("http", onHttp), NT.bus.on("event", onEvent), NT.bus.on("outbox-row", onOutboxRow),
      NT.bus.on("health", applyHealth), NT.bus.on("step", onStep)];
    if (NT.outboxWatch) { NT.outboxWatch.start(); usesWatch = true; }
    if (opts && opts.focus) focus(opts.focus);
  }

  function clearDynamic() {
    active.forEach(p => p.g.remove());
    active = []; pktMap.clear();
    timers.forEach(clearTimeout); timers.clear();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    offs.forEach(f => f()); offs = [];
    if (detach) detach(); detach = null;
    if (usesWatch && NT.outboxWatch) NT.outboxWatch.stop();
    usesWatch = false;
    clearDynamic();
    if (host) { host.classList.remove("cv-host"); host.innerHTML = ""; }
    host = svg = null; nodeEls = {}; portEls = {}; edges = {}; layers = {}; focusId = null;
  }

  function reset() {
    if (!mounted) return;
    clearDynamic();
    layers.fx.innerHTML = "";
    const health = {};
    ORDER.forEach(id => { health[id] = S.nodes[id].health; });
    S = freshState();
    ORDER.forEach(id => { S.nodes[id].health = health[id]; });
    Object.values(edges).forEach(e => { e.last = null; e.count = 0; });
    ORDER.forEach(id => {
      ["outTray", "inTray"].forEach(k => { const t = nodeEls[id][k]; if (t) setBadge(t, 0); });
    });
    Object.values(portEls).forEach(p => { p.count.textContent = ""; });
    brokerCountEl.textContent = "0 mensajes";
  }

  return { mount, unmount, reset, focus };
})();
