// Hover tooltip + click-to-pin slide-over inspector, shared by the flow canvas and the map.
//   NT.inspect.attach(rootEl, resolve) -> detach()
//     resolve(el) gets the closest [data-inspect] element and returns null or
//     { title, subtitle?, color?, sections: [{ label, data, kind?: "json"|"text"|"kv" }] }
//   NT.inspect.show(info, x, y) / pin(info) / hide() / close()
NT.inspect = (function () {
  const esc = NT.util.esc;
  const TIP_LINES = 18;
  let tip = null, panel = null, pinned = null, copyTimer = null;

  // ---------- rendering ----------
  // Tokenise raw text and escape each piece on its own, so nothing from the payload can inject markup.
  const TOK = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  function tint(line) {
    let out = "", last = 0, m;
    TOK.lastIndex = 0;
    while ((m = TOK.exec(line))) {
      out += esc(line.slice(last, m.index));
      if (m[1]) out += `<span class="${m[2] ? "insp-k" : "insp-s"}">${esc(m[1])}</span>${esc(m[2] || "")}`;
      else if (m[3]) out += `<span class="insp-b">${esc(m[3])}</span>`;
      else out += `<span class="insp-n">${esc(m[0])}</span>`;
      last = TOK.lastIndex;
    }
    return out + esc(line.slice(last));
  }

  // data -> { lines: [html], mode } ; json values are pretty printed, strings that parse as JSON too.
  function toLines(data, kind) {
    if (data === undefined || data === null) return { mode: "text", lines: ['<span class="insp-muted">—</span>'] };
    if (kind === "kv" && typeof data === "object") {
      // plain object {label: value} or array of [label, value] pairs
      const rows = (Array.isArray(data) ? data : Object.entries(data)).map(r => Array.isArray(r) ? r : [r, ""]);
      return { mode: "kv", lines: rows.map(([k, v]) =>
        `<span class="insp-kk">${esc(k)}</span><span class="insp-kv-v">${esc(v !== null && typeof v === "object" ? JSON.stringify(v) : v)}</span>`) };
    }
    if (kind === "kv") kind = "text";
    if (kind === "text") {
      const arr = Array.isArray(data) ? data : String(data).split("\n");
      return { mode: "text", lines: arr.map(l => esc(l)) };
    }
    let v = data;
    if (typeof v === "string") { try { v = JSON.parse(v); } catch { return { mode: "text", lines: v.split("\n").map(l => esc(l)) }; } }
    let text;
    try { text = JSON.stringify(v, null, 2); } catch { text = String(v); }
    return { mode: "json", lines: (text === undefined ? "undefined" : text).split("\n").map(tint) };
  }

  // budget: max body lines (tooltip) or Infinity (panel).
  function renderBody(info, budget) {
    let left = budget, cut = false, out = "";
    for (const s of info.sections || []) {
      if (left <= 0) { cut = true; break; }
      const { mode, lines } = toLines(s.data, s.kind);
      const shown = lines.slice(0, left);
      if (shown.length < lines.length) cut = true;
      left -= shown.length;
      out += (s.label ? `<div class="insp-label">${esc(s.label)}</div>` : "") +
        `<div class="insp-pre insp-${mode}">${shown.map(l => `<div class="insp-ln">${l}</div>`).join("")}</div>`;
      if (cut) break;
    }
    return { html: out, cut };
  }

  function head(info) {
    return `<div class="insp-head"><span class="insp-dot" style="background:${esc(info.color || "#8c969f")}"></span>` +
      `<span class="insp-title">${esc(info.title || "")}</span></div>` +
      (info.subtitle ? `<div class="insp-sub">${esc(info.subtitle)}</div>` : "");
  }

  // ---------- tooltip ----------
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.className = "insp-tip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
    return tip;
  }

  function place(x, y) {
    const w = tip.offsetWidth, h = tip.offsetHeight, vw = innerWidth, vh = innerHeight, gap = 16;
    let left = x + gap, top = y + gap;
    if (left + w > vw - 8) left = x - gap - w;
    if (top + h > vh - 8) top = y - gap - h;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }

  function fill(info) {
    const b = renderBody(info, TIP_LINES);
    tip.innerHTML = head(info) + b.html +
      (b.cut ? '<div class="insp-more">… clic para ver todo</div>' : "");
  }

  function show(info, x, y) {
    if (!info) return hide();
    ensureTip();
    fill(info);
    tip.classList.add("on");
    place(x, y);
  }

  function hide() {
    if (tip) tip.classList.remove("on");
  }

  // ---------- pinned panel ----------
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("aside");
    panel.className = "insp-panel";
    panel.setAttribute("aria-label", "Inspector");
    panel.innerHTML = `
      <div class="insp-panel-top">
        <div class="insp-panel-title"></div>
        <button type="button" class="insp-copy">Copiar JSON</button>
        <button type="button" class="insp-x" aria-label="Cerrar">✕</button>
      </div>
      <div class="insp-body"></div>`;
    document.body.appendChild(panel);
    panel.querySelector(".insp-x").addEventListener("click", close);
    panel.querySelector(".insp-copy").addEventListener("click", copyJson);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && pinned) close(); });
    return panel;
  }

  function pin(info) {
    if (!info) return;
    ensurePanel();
    hide();
    pinned = info;
    panel.style.setProperty("--c", info.color || "#8c969f");
    panel.querySelector(".insp-panel-title").innerHTML = head(info);
    panel.querySelector(".insp-body").innerHTML = renderBody(info, Infinity).html;
    panel.querySelector(".insp-body").scrollTop = 0;
    panel.classList.add("on");
  }

  function close() {
    pinned = null;
    if (panel) panel.classList.remove("on");
  }

  function jsonOf(info) {
    const js = (info.sections || []).filter(s => s.kind === "json" || (!s.kind && typeof s.data === "object" && s.data !== null));
    const val = s => { if (typeof s.data === "string") { try { return JSON.parse(s.data); } catch { return s.data; } } return s.data; };
    if (!js.length) return JSON.stringify({ title: info.title, subtitle: info.subtitle }, null, 2);
    if (js.length === 1) return JSON.stringify(val(js[0]), null, 2);
    return JSON.stringify(Object.fromEntries(js.map(s => [s.label || "datos", val(s)])), null, 2);
  }

  function copyJson() {
    if (!pinned) return;
    const text = jsonOf(pinned), btn = panel.querySelector(".insp-copy");
    const done = ok => {
      btn.textContent = ok ? "Copiado ✓" : "No se pudo copiar";
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { btn.textContent = "Copiar JSON"; }, 1400);
    };
    const legacy = () => {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;opacity:0;left:-999px";
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { /* blocked */ }
      ta.remove(); done(ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), legacy);
    else legacy();
  }

  // ---------- delegation ----------
  // Several roots can be attached at once (and nested: the flow view wraps the canvas). Each root has
  // its own resolver and token. An event is handled by the innermost root whose resolver answers it
  // (later roots skip it), and only the root that owns the visible tooltip may refresh or hide it.
  let owner = null;
  const HANDLED = "__inspHandled";

  function attach(root, resolve) {
    const token = {};
    let cur = null, lastX = 0, lastY = 0, timer = null;
    const closest = t => (t && t.closest) ? t.closest("[data-inspect]") : null;
    const inside = el => el && root.contains(el);
    const visible = () => tip && tip.classList.contains("on");
    const release = () => {
      clearInterval(timer); timer = null; cur = null;
      if (owner === token) { owner = null; hide(); }
    };
    const answer = el => { try { return resolve(el); } catch (err) { console.error("inspect resolve", err); return null; } };

    function refresh() {
      if (owner !== token || !cur || !visible()) { clearInterval(timer); timer = null; return; }
      if (!root.contains(cur)) { release(); return; }
      const info = answer(cur);
      if (!info) { release(); return; }
      fill(info); place(lastX, lastY);
    }
    // true when this root answered (tooltip shown)
    function start(el, x, y) {
      const info = answer(el);
      if (!info) { cur = null; return false; }
      cur = el; lastX = x; lastY = y;
      show(info, x, y);
      owner = token;
      clearInterval(timer);
      timer = setInterval(refresh, 450);
      return true;
    }
    // claim an event for this root (returns false if an inner root already took it)
    const claim = e => { if (e[HANDLED]) return false; return true; };
    const take = e => { e[HANDLED] = true; };

    const onOver = e => {
      if (!claim(e)) return;
      const el = closest(e.target);
      if (!inside(el)) return;
      if (el === cur && owner === token) { take(e); return; }
      if (start(el, e.clientX, e.clientY)) take(e);
    };
    const onMove = e => {
      if (owner !== token || !cur) return;
      lastX = e.clientX; lastY = e.clientY;
      if (visible()) place(lastX, lastY);
    };
    const onOut = e => {
      if (owner !== token) return;
      const to = closest(e.relatedTarget);
      if (to !== cur) release();
    };
    const pinFrom = (e, el) => {
      const info = answer(el);
      if (!info) return false;
      take(e); pin(info);
      return true;
    };
    const onClick = e => {
      if (!claim(e)) return;
      const el = closest(e.target);
      if (inside(el)) pinFrom(e, el);
    };
    const onKey = e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (!claim(e)) return;
      const el = closest(e.target);
      if (!inside(el)) return;
      if (pinFrom(e, el)) e.preventDefault();
    };
    const onFocus = e => {
      if (!claim(e)) return;
      const el = closest(e.target);
      if (!inside(el)) return;
      const r = el.getBoundingClientRect();
      if (start(el, r.left + r.width / 2, r.top + r.height / 2)) take(e);
    };
    const onBlur = () => { if (owner === token) release(); };

    root.addEventListener("mouseover", onOver);
    root.addEventListener("mousemove", onMove);
    root.addEventListener("mouseout", onOut);
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKey);
    root.addEventListener("focusin", onFocus);
    root.addEventListener("focusout", onBlur);
    return function detach() {
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("mouseout", onOut);
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("focusin", onFocus);
      root.removeEventListener("focusout", onBlur);
      release();
    };
  }

  return { attach, show, pin, hide, close, isPinned: () => !!pinned };
})();
