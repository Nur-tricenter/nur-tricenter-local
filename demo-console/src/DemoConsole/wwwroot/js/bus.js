// Tiny pub/sub shared by every view.
//   "http"    one gateway call finished   { service, method, path, status, ms, request, response }
//   "event"   one broker message arrived   { id, exchange, receivedAt, payload }
//   "health"  Consul state refreshed       { [serviceId]: "passing" | "critical" | "unknown" }
//   "auth"    token changed                { token, claims } | null
//   "live"    event stream connection      { connected }
NT.bus = (function () {
  const handlers = {};
  return {
    on(name, fn) { (handlers[name] = handlers[name] || new Set()).add(fn); return () => handlers[name].delete(fn); },
    emit(name, data) { (handlers[name] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
  };
})();
