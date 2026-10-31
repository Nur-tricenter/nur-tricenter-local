// "Outbox transaccional": the business row and the outgoing message are saved in one database
// transaction; a dispatcher publishes later. Consumers record what they processed in an inbox.
NT.views.outbox = (function () {
  const U = NT.util, T = NT.topology;
  let root = null, timer = null;
  const seen = new Set();
  let firstLoad = true;

  const explainer = `
    <svg viewBox="0 0 1000 200" role="img" aria-label="Diagrama del patrón outbox">
      <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#1d2b3a"/></marker></defs>
      <rect class="tx" x="10" y="20" width="390" height="160" rx="12"/>
      <text x="26" y="44" style="font-weight:700;fill:var(--ms4)">Una sola transacción en la BD del servicio</text>
      <rect class="box" x="30" y="64" width="160" height="96" rx="8"/><text x="110" y="104" text-anchor="middle" style="font-weight:700">Tabla de negocio</text><text x="110" y="126" text-anchor="middle">p. ej. Courier</text>
      <rect class="box" x="220" y="64" width="160" height="96" rx="8"/><text x="300" y="104" text-anchor="middle" style="font-weight:700">Tabla outbox</text><text x="300" y="126" text-anchor="middle">CourierCreated</text>
      <path class="arrow" d="M 380 112 H 450"/>
      <rect class="box" x="455" y="72" width="150" height="80" rx="8"/><text x="530" y="106" text-anchor="middle" style="font-weight:700">Worker</text><text x="530" y="128" text-anchor="middle">lee y publica</text>
      <path class="arrow" d="M 605 112 H 665"/>
      <rect class="box" x="670" y="72" width="130" height="80" rx="8" style="stroke:var(--broker)"/><text x="735" y="117" text-anchor="middle" style="font-weight:700">RabbitMQ</text>
      <path class="arrow" d="M 800 112 H 850"/>
      <rect class="box" x="855" y="64" width="135" height="96" rx="8"/><text x="922" y="100" text-anchor="middle" style="font-weight:700">Inbox</text><text x="922" y="122" text-anchor="middle">del consumidor</text><text x="922" y="142" text-anchor="middle">descarta repetidos</text>
    </svg>`;

  function rows(list, kind) {
    if (!list.length) return `<tr><td colspan="5" class="muted">Sin mensajes todavía.</td></tr>`;
    return list.map(r => {
      const s = T.byId[r.service] || { name: r.service, hex: "#8c969f" };
      const key = kind + (r.id || r.messageId) + (r.processedAt || "");
      const fresh = !firstLoad && !seen.has(key);
      seen.add(key);
      const done = !!r.processedAt || r.status === "Published" || r.status === "Processed";
      return U.html`<tr class="${fresh ? "fresh" : ""}">
        <td><span class="line-dot" style="--line:${s.hex}"></span>${s.name}</td>
        <td><code>${r.type}</code></td>
        <td class="mono">${U.time(r.createdAt || r.receivedAt)}</td>
        <td>${U.raw(done ? '<span class="tag ok">' + (kind === "out" ? "publicado" : "procesado") + "</span>" : '<span class="tag warn">pendiente</span>')}</td>
        <td class="mono muted">${r.processedAt ? U.time(r.processedAt) : r.status || "–"}</td></tr>`;
    }).join("");
  }

  async function refresh() {
    if (!root) return;
    let data;
    try { data = await NT.api.outbox(); } catch {
      root.querySelector("#outbox-rows").innerHTML = `<tr><td colspan="5" class="muted">No se pudieron leer las tablas outbox. Revisa que demo-console tenga acceso a Postgres.</td></tr>`;
      return;
    }
    if (!root) return;
    root.querySelector("#outbox-rows").innerHTML = rows(data.outbox || [], "out");
    root.querySelector("#inbox-rows").innerHTML = rows(data.inbox || [], "in");
    firstLoad = false;
  }

  function mount(el) {
    root = el;
    firstLoad = seen.size === 0;
    el.innerHTML = `
      <div class="view-head">
        <div>
          <h1>Outbox transaccional</h1>
          <p>Si un servicio guardara el dato y luego publicara el evento por separado, una caída en medio dejaría a los demás sin enterarse. Con outbox, el evento se guarda en la misma transacción que el dato y un worker lo publica después: o pasan ambos o ninguno.</p>
        </div>
      </div>
      <section class="panel outbox-explainer">${explainer}</section>
      <div class="grid-2" style="margin-top:18px;align-items:start">
        <section class="panel">
          <h2>Mensajes en outbox</h2>
          <p class="muted" style="margin-top:-4px">Identity, MS1, MS2 y MS5 (Joseco.Outbox) y MS3 (tabla propia). Una fila nueva aparece pendiente y pasa a publicada.</p>
          <table class="data"><thead><tr><th>Servicio</th><th>Evento</th><th>Creado</th><th>Estado</th><th>Publicado</th></tr></thead><tbody id="outbox-rows"></tbody></table>
        </section>
        <section class="panel">
          <h2>Mensajes recibidos (inbox)</h2>
          <p class="muted" style="margin-top:-4px">MS3, MS4 y MS5 anotan cada evento procesado; si RabbitMQ lo entrega dos veces, el segundo se ignora.</p>
          <table class="data"><thead><tr><th>Servicio</th><th>Evento</th><th>Recibido</th><th>Estado</th><th>Procesado</th></tr></thead><tbody id="inbox-rows"></tbody></table>
        </section>
      </div>`;
    refresh();
    timer = setInterval(refresh, NT.config.pollOutboxMs);
  }

  function unmount() { clearInterval(timer); root = null; }
  return { mount, unmount };
})();
