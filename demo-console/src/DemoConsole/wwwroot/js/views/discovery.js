// "Registro de servicios": what Consul knows right now, and the gateway route each entry produces.
NT.views.discovery = (function () {
  const U = NT.util, T = NT.topology, cfg = NT.config;
  let root = null, offs = [];

  function render(h) {
    if (!root) return;
    root.querySelector("#registry").innerHTML = T.services.map(s => {
      const e = h[s.id] || { status: "unknown", instances: [] };
      const tag = e.status === "passing" ? '<span class="tag ok">en línea</span>' : e.status === "unknown" ? '<span class="tag">sin datos</span>' : '<span class="tag bad">caído</span>';
      const inst = e.instances.length ? e.instances.map(i => U.html`<div><code>${i.address}:${i.port}</code> <span class="muted">${i.id}</span></div>
          ${U.raw(i.checks.map(c => U.html`<div class="muted" style="font-size:12.5px">${c.status === "passing" ? "✓" : "✕"} ${c.name}</div>`).join(""))}`).join("")
        : '<span class="muted">sin instancias registradas</span>';
      const sim = cfg.mode === "sim"
        ? U.html`<button class="btn small ghost" type="button" data-toggle="${s.id}">${NT.sim.isDown(s.id) ? "Encender" : "Apagar"}</button>`
        : U.html`<code class="muted" style="font-size:11.5px">docker stop nur-tricenter-${s.consul.replace(/-service$/, "")}-api</code>`;
      return U.html`<tr>
        <td><span class="line-dot" style="--line:${s.hex}"></span><b>${s.name}</b></td>
        <td><code>${s.consul}</code></td>
        <td>${U.raw(tag)}</td>
        <td>${U.raw(inst)}</td>
        <td><code>${T.prefix(s.id)}/**</code><div class="muted" style="font-size:12px">${e.status === "passing" ? "el gateway enruta" : "sin ruta: el gateway responde 404"}</div></td>
        <td>${U.raw(sim)}</td></tr>`;
    }).join("");
    root.querySelector("#updated").textContent = "Actualizado " + U.time(Date.now());
  }

  function mount(el) {
    root = el;
    el.innerHTML = `
      <div class="view-head">
        <div>
          <h1>Registro de servicios</h1>
          <p>Cada microservicio se registra en Consul al arrancar y Consul revisa su /health cada pocos segundos. El gateway relee Consul cada 30 s y solo arma rutas hacia instancias sanas: nadie escribe direcciones a mano.</p>
        </div>
        <span class="muted" id="updated"></span>
      </div>
      <section class="panel">
        <table class="data">
          <thead><tr><th>Servicio</th><th>Nombre en Consul</th><th>Salud</th><th>Instancias y checks</th><th>Ruta del gateway</th><th>${cfg.mode === "sim" ? "Simular caída" : "Para la demo"}</th></tr></thead>
          <tbody id="registry"></tbody>
        </table>
      </section>
      <div class="note" style="margin-top:16px;--line:var(--consul)">Prueba en vivo: detén un contenedor con el comando de la última columna. En unos segundos la fila pasa a caído y su estación se pone roja en el mapa; el gateway deja de enrutarlo. Al volver a encenderlo, se registra solo.</div>`;
    el.addEventListener("click", e => {
      const b = e.target.closest("[data-toggle]");
      if (!b) return;
      NT.sim.setDown(b.dataset.toggle, !NT.sim.isDown(b.dataset.toggle));
      NT.live.pollHealth();
    });
    offs.push(NT.bus.on("health", render));
    render(NT.live.health);
  }

  function unmount() { offs.forEach(f => f()); offs = []; root = null; }
  return { mount, unmount };
})();
