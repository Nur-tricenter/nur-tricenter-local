// "Requisitos del proyecto": the assignment slide, each item linked to where the demo proves it.
NT.views.requisitos = (function () {
  const U = NT.util;
  const reqs = [
    { title: "Trabajo en grupo", state: "ok", text: "Cinco microservicios, cada uno de un integrante, más gateway, identidad y kernels compartidos en la organización Nur-tricenter de GitHub.", link: "#mapa", cta: "Ver el mapa" },
    { title: "API Gateway para comunicar los microservicios al exterior", state: "ok", text: "YARP en :15005 es la única puerta de entrada. Toda llamada de esta consola pasa por /api/{servicio}/**.", link: "#mapa", cta: "Ver rutas" },
    { title: "Service Discovery para registro y descubrimiento", state: "ok", text: "Cada servicio se registra en Consul con su health check; el gateway arma sus rutas leyendo Consul.", link: "#discovery", cta: "Ver registro" },
    { title: "Integración de los microservicios del diplomado", state: "ok", text: "El recorrido de un pedido atraviesa MS1, MS2, MS3, MS4 y MS5. Entre servicios no hay REST: solo eventos por RabbitMQ; el navegador entra por el gateway.", link: "#flujo", cta: "Recorrer un pedido" },
    { title: "Seguridad en los endpoints", state: "partial", text: "JWT de Identity con scopes por endpoint en MS2 y MS4, JWT obligatorio en MS1. MS3 y MS5 aún son anónimos (gaps X-11, X-03).", link: "#seguridad", cta: "Probar accesos" },
    { title: "Patrón Transactional Outbox", state: "ok", text: "Identity, MS1, MS2 y MS5 publican desde su tabla outbox (Joseco); MS3 y MS4 con su tabla propia. Los consumidores deduplican con inbox.", link: "#outbox", cta: "Ver outbox" },
    { title: "Comunicación interna asíncrona con un broker", state: "ok", text: "RabbitMQ con un exchange fanout por evento y una cola por consumidor; contratos compartidos en Nur.Tricenter.Integration.", link: "#eventos", cta: "Ver eventos" },
    { title: "Proceso con patrón Saga", state: "out", text: "Retirado de los requisitos del proyecto.", link: null }
  ];

  function mount(el) {
    el.innerHTML = `
      <div class="view-head">
        <div>
          <h1>Requisitos del proyecto</h1>
          <p>Lo que pide el proyecto final y dónde se demuestra en esta consola.</p>
        </div>
      </div>
      <ul class="reqs">${reqs.map(r => U.html`<li class="req ${r.state === "ok" ? "" : r.state}">
        <span class="check" aria-label="${r.state === "ok" ? "cumplido" : r.state === "partial" ? "parcial" : "fuera de alcance"}">${r.state === "ok" ? "✓" : r.state === "partial" ? "½" : "–"}</span>
        <div><h3>${r.title}</h3><p>${r.text}</p></div>
        ${r.link ? U.raw(U.html`<a class="btn small ghost" href="${r.link}">${r.cta}</a>`) : ""}</li>`).join("")}</ul>`;
  }
  return { mount, unmount() {} };
})();
