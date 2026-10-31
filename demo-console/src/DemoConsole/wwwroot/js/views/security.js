// "Identidad y seguridad": log in with different accounts, inspect the JWT, and probe secured
// endpoints without a token, with a token that lacks the scope, and with the right one.
NT.views.seguridad = (function () {
  const U = NT.util, T = NT.topology, api = NT.api, cfg = NT.config;
  let root = null, timer = null, offs = [];
  const tokens = {};     // user -> token, so probes can compare accounts side by side
  const results = {};    // probe id + variant -> status

  const probes = [
    { id: "ms4-cal", svc: "ms4", method: "GET", path: "/calendars/1", what: "Leer un calendario", scope: "deliveryCalendar.calendar:read" },
    { id: "ms4-res", svc: "ms4", method: "POST", path: "/calendars/resolve-daily-catalog?date=" + U.utcDate(1), what: "Resolver el menú de mañana", scope: "deliveryCalendar.catalogResolution:manage" },
    { id: "ms2-plans", svc: "ms2", method: "GET", path: "/meal-plans", what: "Listar planes del catálogo", scope: "catalog.mealPlan:read" },
    { id: "ms2-new", svc: "ms2", method: "POST", path: "/recipes", what: "Crear una receta", scope: "catalog.recipe:create", body: { name: "Prueba de permisos", instructions: "-" } },
    { id: "ms1-pat", svc: "ms1", method: "GET", path: "/Patient/00000000-0000-0000-0000-000000000000", what: "Leer un paciente", scope: "cualquier JWT válido" }
  ];
  const variants = [
    { key: "none", label: "Sin token", token: () => null },
    { key: "ms4-service", label: "ms4-service", token: () => tokens["ms4-service"] },
    { key: "admin", label: "admin", token: () => tokens["admin"] }
  ];

  async function login(user) {
    const acc = cfg.accounts.find(a => a.user === user);
    const r = await api.login(acc.user, acc.password);
    if (r.status === 200) { tokens[user] = api.token; U.toast(`Sesión iniciada como ${user}`); }
    else U.toast(`Login de ${user} falló (${r.status})`, "bad");
    render();
  }

  async function ensureTokens() {
    for (const u of ["ms4-service", "admin"]) {
      if (!tokens[u]) {
        const acc = cfg.accounts.find(a => a.user === u);
        const r = await api.call("identity", "POST", "/auth/login", { body: { userName: acc.user, password: acc.password }, token: null });
        if (r.status === 200) tokens[u] = r.response.accessToken;
      }
    }
  }

  async function runProbe(p) {
    await ensureTokens();
    for (const v of variants) {
      results[p.id + v.key] = "…";
      renderProbes();
      const r = await api.call(p.svc, p.method, p.path, { body: p.body, token: v.token() || null });
      results[p.id + v.key] = r.status;
      renderProbes();
    }
  }

  function explain(code) {
    if (code === 401) return "401: sin token o token inválido";
    if (code === 403) return "403: token válido pero sin el scope";
    if (code === 404) return "404: autorizado, el recurso no existe";
    if (code >= 200 && code < 300) return code + ": autorizado";
    return String(code);
  }

  function renderProbes() {
    if (!root) return;
    root.querySelector("#probes").innerHTML = probes.map(p => U.html`<div class="probe">
      <div class="what"><b><span class="line-dot" style="--line:${T.byId[p.svc].hex}"></span>${p.what}</b><span>${p.method} ${T.prefix(p.svc)}/v1${p.path.split("?")[0]} · requiere ${p.scope}</span></div>
      ${U.raw(variants.map(v => {
        const code = results[p.id + v.key];
        const cls = typeof code === "number" ? (code < 300 ? "s2" : code === 404 ? "s2" : "s4") : "s0";
        return U.html`<div style="text-align:center" title="${typeof code === "number" ? explain(code) : ""}"><div class="status-code ${cls}">${code ?? "–"}</div><div class="muted" style="font-size:11.5px">${v.label}</div></div>`;
      }).join(""))}
    </div>`).join("");
  }

  function jwtParts(t) {
    const [h, p, s] = t.split(".");
    return U.html`<div class="jwt"><span class="h">${h}</span>.<span class="p">${p}</span>.<span class="s">${s}</span></div>`;
  }

  function render() {
    if (!root) return;
    const c = api.claims;
    const box = root.querySelector("#token");
    if (!c) {
      box.innerHTML = `<div class="empty">Elige una cuenta para iniciar sesión. Identity devuelve un JWT firmado (HS256) que cada microservicio valida por su cuenta con el kernel Security.</div>`;
    } else {
      const scopes = U.claimScopes(c);
      const left = Math.max(0, c.exp * 1000 - Date.now());
      box.innerHTML = U.html`
        <h3>Token actual</h3>
        ${U.raw(jwtParts(api.token))}
        <div class="expiry" aria-hidden="true"><span style="width:${(left / 3600000) * 100}%"></span></div>
        <p class="muted" style="font-size:12.5px;margin:4px 0 12px">Vence en ${Math.floor(left / 60000)} min · emisor ${c.iss} · audiencia ${c.aud}</p>
        <dl class="ctx">
          <dt>Usuario</dt><dd>${U.claimName(c)}</dd>
          <dt>sub</dt><dd>${c.sub}</dd>
          <dt>Administrador</dt><dd>${c.is_admin || Object.keys(c).some(k => k.endsWith(":*")) ? "sí" : "no"}</dd>
        </dl>
        <h3 style="margin-top:12px">Scopes (${scopes.length})</h3>
        <div class="scopes">${U.raw(scopes.map(s => U.html`<span class="tag">${s}</span>`).join(""))}</div>`;
    }
    root.querySelectorAll("[data-login]").forEach(b => b.setAttribute("aria-pressed", String(!!c && U.claimName(c) === b.dataset.login)));
  }

  function mount(el) {
    root = el;
    el.innerHTML = `
      <div class="view-head">
        <div>
          <h1>Identidad y seguridad</h1>
          <p>Identity emite el token; el gateway lo deja pasar y cada servicio decide con sus propios scopes. Compara la misma llamada sin token, con una cuenta de servicio limitada y con el administrador.</p>
        </div>
      </div>
      <div class="grid-2">
        <section class="panel">
          <h2>Iniciar sesión</h2>
          <div class="actions" style="margin-bottom:14px">
            ${cfg.accounts.map(a => U.html`<button class="chip" type="button" data-login="${a.user}" aria-pressed="false">${a.user}</button>`).join("")}
            <button class="btn small ghost" type="button" id="logout">Cerrar sesión</button>
          </div>
          <div id="token"></div>
        </section>
        <section class="panel">
          <h2>Pruebas de acceso</h2>
          <p class="muted" style="margin-top:-4px">MS3 y MS5 todavía aceptan llamadas anónimas (gaps X-11 y X-03), por eso no aparecen aquí.</p>
          <div class="actions" style="margin:8px 0 4px"><button class="btn" type="button" id="probe-all">Probar todos los accesos</button></div>
          <div id="probes"></div>
        </section>
      </div>`;
    el.querySelectorAll("[data-login]").forEach(b => b.addEventListener("click", () => login(b.dataset.login)));
    el.querySelector("#logout").addEventListener("click", () => { api.logout(); render(); });
    el.querySelector("#probe-all").addEventListener("click", async e => {
      e.currentTarget.disabled = true;
      for (const p of probes) await runProbe(p);
      if (root) root.querySelector("#probe-all").disabled = false;
    });
    offs.push(NT.bus.on("auth", render));
    timer = setInterval(render, 30000);
    render();
    renderProbes();
  }

  function unmount() { clearInterval(timer); offs.forEach(f => f()); offs = []; root = null; }
  return { mount, unmount };
})();
