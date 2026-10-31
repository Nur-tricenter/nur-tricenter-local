// Hash router + startup.
(function () {
  const stage = document.getElementById("stage");
  let current = null;

  function show() {
    const name = (location.hash || "#mapa").slice(1);
    const view = NT.views[name] || NT.views.mapa;
    if (current && current.unmount) current.unmount();
    stage.innerHTML = "";
    current = view;
    view.mount(stage);
    document.querySelectorAll(".rail a").forEach(a => {
      if (a.dataset.view === (NT.views[name] ? name : "mapa")) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    stage.scrollTop = 0;
  }

  const toggle = document.getElementById("mode-toggle");
  toggle.checked = NT.config.mode === "sim";
  toggle.disabled = NT.config.fromFile;
  toggle.addEventListener("change", () => NT.config.setMode(toggle.checked ? "sim" : "live"));
  document.getElementById("mode-hint").textContent = NT.config.mode === "sim"
    ? (NT.config.fromFile ? "Abierto como archivo: todo se simula en el navegador." : "Nada sale del navegador. Desactívalo para usar la plataforma real.")
    : "Conectado a la plataforma real por el gateway.";

  window.addEventListener("hashchange", show);
  NT.live.start();
  if (NT.config.mode === "sim") NT.sim.ambient();
  show();
})();
