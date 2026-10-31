NT.util = (function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Tagged template that escapes interpolated values; wrap trusted markup with raw().
  const RAW = Symbol("raw");
  const raw = s => ({ [RAW]: true, s });
  function html(strings, ...values) {
    return strings.reduce((out, str, i) => {
      if (i === 0) return str;
      const v = values[i - 1];
      const part = Array.isArray(v) ? v.map(x => (x && x[RAW]) ? x.s : esc(x)).join("")
        : (v && v[RAW]) ? v.s : esc(v);
      return out + part + str;
    }, "");
  }

  const json = v => esc(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  const time = d => new Date(d).toLocaleTimeString("es-BO", { hour12: false });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16);
  }));
  const stamp = () => new Date().toTimeString().slice(0, 8).replace(/:/g, "");
  const utcDate = (offsetDays = 0) => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  // Case-insensitive property read: Joseco envelopes and services differ in casing.
  function pick(obj, key) {
    if (!obj || typeof obj !== "object") return undefined;
    const k = Object.keys(obj).find(x => x.toLowerCase() === key.toLowerCase());
    return k === undefined ? undefined : obj[k];
  }

  function decodeJwt(token) {
    try {
      const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(decodeURIComponent(atob(part).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")));
    } catch { return null; }
  }

  // Identity writes the user name as the long xmlsoap claim and scopes as one space-separated string.
  const claimName = c => c && (c.unique_name || c.name || c["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] || c.sub);
  const claimScopes = c => {
    const s = c && c.scope;
    return Array.isArray(s) ? s : typeof s === "string" ? s.split(/\s+/).filter(Boolean) : [];
  };

  function toast(message, kind) {
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = message;
    document.getElementById("toasts").appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  return { esc, html, raw, json, time, sleep, uid, stamp, utcDate, pick, decodeJwt, claimName, claimScopes, toast };
})();
