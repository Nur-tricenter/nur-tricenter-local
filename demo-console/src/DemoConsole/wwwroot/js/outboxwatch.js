// Watches the outbox/inbox tables and emits one "outbox-row" bus event per row that is new since
// the previous poll. start()/stop() are ref-counted: it only polls while somebody subscribes.
//   outbox-row  { id, service, table: "outbox"|"inbox", type, status, at }
NT.outboxWatch = (function () {
  // In sim mode the data is in memory, so poll faster to keep the canvas in rhythm with the events.
  const SIM_POLL_MS = 400;
  const seen = new Set();
  let refs = 0, timer = null, primed = false, busy = false;

  // The reader returns "identity", "ms1".."ms5"; those are the topology ids. Be lenient anyway.
  function serviceId(s) {
    const v = String(s || "").toLowerCase();
    if (NT.topology.byId[v]) return v;
    const hit = NT.topology.services.find(x => x.consul === v || v.includes(x.id));
    return hit ? hit.id : v;
  }

  function rowsOf(data, table) {
    const list = (data && data[table]) || [];
    return list.map(r => {
      const at = r.createdAt || r.receivedAt || r.processedAt || new Date().toISOString();
      const done = !!r.processedAt || r.status === "Published" || r.status === "Processed";
      return {
        id: r.id || r.messageId, service: serviceId(r.service), table, type: r.type,
        status: r.status || (done ? "Processed" : "Pending"), at
      };
    });
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const data = await NT.api.outbox();
      const fresh = [];
      for (const row of rowsOf(data, "outbox").concat(rowsOf(data, "inbox"))) {
        const key = `${row.service}|${row.table}|${row.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (primed) fresh.push(row);
      }
      primed = true;
      // Oldest first so animations replay in causal order.
      fresh.sort((a, b) => new Date(a.at) - new Date(b.at)).forEach(r => NT.bus.emit("outbox-row", r));
    } catch { /* offline stack or no DB access: stay quiet, no toasts */ }
    finally { busy = false; }
  }

  function start() {
    if (refs++ > 0) return;
    primed = false;
    seen.clear();
    poll();
    const ms = NT.config.mode === "sim" ? SIM_POLL_MS : NT.config.pollOutboxMs;
    timer = setInterval(poll, ms);
  }

  function stop() {
    if (refs === 0) return;
    if (--refs > 0) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop };
})();
