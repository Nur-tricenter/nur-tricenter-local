// The platform as data. Sources: knowledge/platform/local-stack.md (names, prefixes, databases)
// and knowledge/contracts/events.yaml (publishers, consumer queues, payload fields).
NT.topology = (function () {
  const services = [
    { id: "identity", name: "Identity", role: "Usuarios, login y tokens JWT", consul: "identity-service",
      db: "identity", color: "var(--identity)", hex: "#6b5ca5", auth: "Emite los tokens",
      outbox: true, kernels: ["Access", "Security", "Integration"] },
    { id: "ms1", name: "MS1 Clínica", role: "Pacientes, consultas y evaluaciones", consul: "clinica-nutricional",
      db: "ms1_clinica_nutricional", color: "var(--ms1)", hex: "#b23a6b", auth: "JWT obligatorio",
      outbox: true, kernels: ["Security"] },
    { id: "ms2", name: "MS2 Catálogo", role: "Recetas, alimentos y planes", consul: "catalog",
      db: "ms2-plans-and-recipes-catalog", color: "var(--ms2)", hex: "#3e8e3a", auth: "JWT + scope por endpoint",
      outbox: true, kernels: ["Access", "Security", "Integration", "Observability"] },
    { id: "ms3", name: "MS3 Contratos", role: "Contratos, cobros y producción", consul: "contracting",
      db: "nur_tricenter_contracting", color: "var(--ms3)", hex: "#c98f00", auth: "Anónimo (gap X-11)",
      outbox: true, kernels: ["Integration"] },
    { id: "ms4", name: "MS4 Calendario", role: "Calendario de entregas del paciente", consul: "delivery-calendar",
      db: "ms4_delivery_calendar", color: "var(--ms4)", hex: "#0e7c86", auth: "JWT + scope por endpoint",
      outbox: true, kernels: ["Access", "Security", "Integration"] },
    { id: "ms5", name: "MS5 Logística", role: "Repartidores, rutas y entregas", consul: "nurtricenter",
      db: "ms5_logistics", color: "var(--ms5)", hex: "#2f4fb8", auth: "Anónimo (gap X-03)",
      outbox: true, kernels: ["Integration"] }
  ];

  const byId = Object.fromEntries(services.map(s => [s.id, s]));
  const byConsul = Object.fromEntries(services.map(s => [s.consul, s]));
  const prefix = id => `/api/${byId[id].consul}`;

  // queues are named {consumer}.{exchange}; only consumers that actually act are listed.
  const events = [
    { name: "user-published", publisher: "identity", type: "User.Published", consumers: ["ms1", "ms2", "ms3", "ms4", "ms5"], payload: ["UserId", "UserName", "Email", "IsAdministrator", "Scopes"] },
    { name: "user-updated", publisher: "identity", type: "User.Changed", consumers: ["ms1", "ms2", "ms3", "ms4", "ms5"], payload: ["UserId", "UserName", "Scopes", "IsActive", "ChangeKind"] },
    { name: "paciente-published", publisher: "ms1", type: "Patient.Published", consumers: ["ms3"], payload: ["PatientId", "DocumentNumber", "FirstName", "LastName", "Phone"] },
    { name: "food-published", publisher: "ms2", type: "Food.Published", consumers: ["ms1", "ms3", "ms4", "ms5"], payload: ["FoodId", "Name", "Category", "Calories"] },
    { name: "food-nutritional-info-updated", publisher: "ms2", type: "Food.NutritionalInfoUpdated", consumers: ["ms1", "ms3", "ms4", "ms5"], payload: ["FoodId", "NewCalories", "NewProtein"] },
    { name: "recipe-published", publisher: "ms2", type: "Recipe.Published", consumers: ["ms3"], payload: ["RecipeId", "Name"] },
    { name: "recipe-updated", publisher: "ms2", type: "Recipe.Updated", consumers: ["ms3", "ms4"], payload: ["RecipeId", "Name"] },
    { name: "meal-plan-published", publisher: "ms2", type: "MealPlan.Published", consumers: ["ms3", "ms4"], payload: ["PlanId", "Name", "DurationType", "TotalDays", "MealsPerDay"] },
    { name: "meal-plan-composition-changed", publisher: "ms2", type: "MealPlan.CompositionChanged", consumers: ["ms4"], payload: ["PlanId", "Days"] },
    { name: "contract-activated", publisher: "ms3", type: "Contract.Activated", consumers: ["ms4"], payload: ["ContractId", "PatientId", "CatalogPlanId", "DurationDays", "StartDate"] },
    { name: "production-order-ready", publisher: "ms4", type: "ProductionOrder.Ready", consumers: ["ms3"], payload: ["ProductionOrderId", "DeliveryDate", "ProductionDate", "Lines"] },
    { name: "package-validated", publisher: "ms3", type: "Package.Validated", consumers: ["ms5"], payload: ["PackageId", "PatientName", "DeliveryDate", "DeliveryAddress", "DeliveryDayId", "TrackingNumber"] },
    { name: "courier-created", publisher: "ms5", type: "Courier.Created", consumers: [], payload: ["CourierId", "FullName", "Status"] },
    { name: "courier-status-changed", publisher: "ms5", type: "Courier.StatusChanged", consumers: [], payload: ["CourierId", "OldStatus", "NewStatus"] },
    { name: "route-created", publisher: "ms5", type: "Route.Created", consumers: [], payload: ["RouteId", "CourierId", "ScheduledDate"] },
    { name: "courier-assigned-to-route", publisher: "ms5", type: "Route.CourierAssigned", consumers: [], payload: ["RouteId", "CourierId"] },
    { name: "delivery-added-to-route", publisher: "ms5", type: "Route.DeliveryAdded", consumers: ["ms4"], payload: ["RouteId", "DeliveryId", "PackageId", "DeliveryDayId"] },
    { name: "route-started", publisher: "ms5", type: "Route.Started", consumers: [], payload: ["RouteId"] },
    { name: "route-completed", publisher: "ms5", type: "Route.Completed", consumers: [], payload: ["RouteId"] },
    { name: "route-cancelled", publisher: "ms5", type: "Route.Cancelled", consumers: [], payload: ["RouteId"] },
    { name: "delivery-completed", publisher: "ms5", type: "Delivery.Completed", consumers: ["ms4"], payload: ["DeliveryId", "RouteId", "DeliveredAt", "EvidencePhotoUrl"] },
    { name: "delivery-failed", publisher: "ms5", type: "Delivery.Failed", consumers: ["ms4"], payload: ["DeliveryId", "RouteId", "Reason"] }
  ];
  const eventByName = Object.fromEntries(events.map(e => [e.name, e]));

  // Synchronous REST calls between services (not through the browser), drawn as thin lines. There
  // are none: every service-to-service dependency is an event. Kept as data so the map code that
  // draws them stays generic.
  const restLinks = [];

  const kernels = [
    { id: "Access", pkg: "Nur.Tricenter.Access", what: "Nombres de permisos y reglas por scope" },
    { id: "Security", pkg: "Nur.Tricenter.Security", what: "Validación JWT común (AddSecurity)" },
    { id: "Integration", pkg: "Nur.Tricenter.Integration", what: "Contratos de eventos compartidos (v1.6.0)" },
    { id: "Observability", pkg: "Nur.Tricenter.Observability", what: "OpenTelemetry y Serilog" }
  ];

  return { services, byId, byConsul, prefix, events, eventByName, restLinks, kernels };
})();
