// Every call the UI makes goes through here, so the map can animate it and sim mode can answer it.
NT.api = (function () {
  const cfg = NT.config;
  const sim = () => cfg.mode === "sim";
  let token = null;
  let claims = null;

  function setToken(t) {
    token = t;
    claims = t ? NT.util.decodeJwt(t) : null;
    NT.bus.emit("auth", t ? { token, claims } : null);
  }

  // service: topology id; path: relative to /api/{consul}/v1, e.g. "/calendars/12".
  // opts.token: string to use, null to send none, undefined to use the session token.
  async function call(service, method, path, opts = {}) {
    const body = opts.body;
    const useToken = opts.token === undefined ? token : opts.token;
    const url = `${NT.topology.prefix(service)}/v1${path}`;
    const started = performance.now();
    let status = 0, response = null;

    try {
      if (sim()) {
        ({ status, response } = await NT.sim.handle(service, method, path, body, useToken));
      } else {
        const res = await fetch(cfg.gatewayBase + url, {
          method,
          headers: Object.assign(
            body !== undefined ? { "Content-Type": "application/json" } : {},
            useToken ? { Authorization: "Bearer " + useToken } : {}),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20000)
        });
        status = res.status;
        const text = await res.text();
        try { response = text ? JSON.parse(text) : null; } catch { response = text; }
      }
    } catch (e) {
      status = 0;
      response = { error: "No se pudo contactar al gateway", detail: String(e) };
    }

    const result = { service, method, path: url, status, ms: Math.round(performance.now() - started),
      request: body, response, authorized: !!useToken, quiet: !!opts.quiet };
    NT.bus.emit("http", result);
    return result;
  }

  async function login(userName, password) {
    const r = await call("identity", "POST", "/auth/login", { body: { userName, password }, token: null });
    if (r.status === 200 && r.response && r.response.accessToken) setToken(r.response.accessToken);
    return r;
  }

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status + " " + url);
    return res.json();
  }

  // Consul: one entry per known service with its aggregated check status and instances.
  async function health() {
    if (sim()) return NT.sim.health();
    const out = {};
    await Promise.all(NT.topology.services.map(async s => {
      try {
        const entries = await getJson(`${cfg.consulBase}/v1/health/service/${s.consul}`);
        const checks = entries.flatMap(e => e.Checks || []);
        const status = entries.length === 0 ? "critical"
          : checks.some(c => c.Status === "critical") ? "critical"
          : checks.some(c => c.Status === "warning") ? "warning" : "passing";
        out[s.id] = { status, instances: entries.map(e => ({
          id: e.Service.ID, address: e.Service.Address, port: e.Service.Port, tags: e.Service.Tags || [],
          checks: (e.Checks || []).map(c => ({ name: c.Name, status: c.Status, output: c.Output }))
        })) };
      } catch {
        out[s.id] = { status: "unknown", instances: [] };
      }
    }));
    return out;
  }

  async function queues() {
    if (sim()) return NT.sim.queues();
    // No vhost segment: the proxy would decode %2F into a path separator. The stack has one vhost.
    return getJson(`${cfg.rabbitBase}/api/queues?columns=name,messages,consumers,message_stats`);
  }

  async function outbox() {
    if (sim()) return NT.sim.outbox();
    return getJson(cfg.liveOutbox);
  }

  // Gap X-17 lookups: the services' own query endpoints first, then the demo-console's read-only
  // SQL helper (for a stack built from branches that don't have those endpoints yet).
  const realLookups = {
    "calendar-by-contract": {
      svc: "ms4", path: id => `/calendars/by-contract/${id}`,
      map: r => (r && r.id ? { calendarId: r.id } : null)
    },
    "packages-by-order": {
      svc: "ms3", path: id => `/production/orders/${id}/packages`,
      map: r => ((r && r.packages) || []).map(p => ({ packageId: p.packageId, patientId: p.patientId, status: p.status }))
    },
    "delivery-by-day": {
      svc: "ms4", path: id => `/calendars/days/${id}/delivery-link`,
      map: r => (r && r.deliveryId ? { deliveryId: r.deliveryId, routeId: r.routeId } : null)
    }
  };

  async function lookup(kind, id) {
    if (sim()) return NT.sim.lookup(kind, id);
    const real = realLookups[kind];
    if (real) {
      const r = await call(real.svc, "GET", real.path(encodeURIComponent(id)), { quiet: true });
      if (r.status === 200) {
        const value = real.map(r.response);
        // Show the call (map + step card) only once it answers, so polling doesn't flood the view.
        if (value && (!Array.isArray(value) || value.length)) NT.bus.emit("http", Object.assign({}, r, { quiet: false }));
        return value;
      }
    }
    const res = await fetch(`${cfg.liveLookup}/${kind}/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("lookup " + kind + " " + res.status);
    return res.json();
  }

  return {
    call, login, health, queues, outbox, lookup,
    get token() { return token; }, get claims() { return claims; },
    logout() { setToken(null); },
    useToken: setToken
  };
})();
