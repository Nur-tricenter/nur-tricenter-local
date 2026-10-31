// Runtime configuration. Classic scripts (no ES modules) so the page also opens from file://
// in simulated mode, e.g. to rehearse the presentation without the stack running.
window.NT = window.NT || {};

NT.config = (function () {
  const stored = (() => { try { return localStorage.getItem("nt.mode"); } catch { return null; } })();
  const query = new URLSearchParams(location.search).get("modo");
  const fromFile = location.protocol === "file:";

  return {
    // "live" talks to the demo-console backend; "sim" answers everything in the browser.
    mode: fromFile ? "sim" : (query || stored || "live"),
    fromFile,

    // Paths served by the demo-console backend (same origin, so no CORS needed).
    gatewayBase: "/gw",            // -> nur-tricenter-gateway (YARP), every business call
    consulBase: "/consul",         // -> Consul HTTP API
    rabbitBase: "/rabbit",         // -> RabbitMQ management API
    liveEvents: "/live/events",    // SSE: copy of every integration event
    liveOutbox: "/live/outbox",    // outbox/inbox rows, read-only
    liveLookup: "/live/lookup",    // read-only lookups for gap X-17

    pollConsulMs: 5000,
    pollQueuesMs: 4000,
    pollOutboxMs: 3000,
    boardMax: 200,

    accounts: [
      { user: "admin", password: "admin", label: "Administrador" },
      { user: "ms4-service", password: "dev-only-ms4-service-password", label: "Cuenta de servicio MS4" },
      { user: "ms3-service", password: "dev-only-ms3-service-password", label: "Cuenta de servicio MS3" }
    ],

    setMode(mode) {
      try { localStorage.setItem("nt.mode", mode); } catch { /* private window */ }
      location.reload();
    }
  };
})();
