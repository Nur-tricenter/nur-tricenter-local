// =============================================================================
//  Orchestrator.AppHost - Nur-Tricenter
// =============================================================================
//
//  This file is the .NET Aspire AppHost entry point, but the project also
//  ships a docker-compose.yml (and start-stack.sh/.ps1) that brings up
//  the same stack in pure compose. Why both?
//
//  Compose is kept as the primary path because, on a host with leftover
//  containers from an earlier session, Aspire 13.6.1's container lifecycle
//  collides with the host's docker network namespace in ways the
//  AppHost cannot reconcile (port 5432 already bound, projects pass
//  from Running to Finished in seconds, the AppHost's bridge network
//  does not share DNS with the compose network).
//
//  In a clean environment the AppHost is the right choice: it brings
//  up the infra containers, attaches the projects to its own bridge
//  network with stable hostnames, and gives a unified dashboard for
//  logs, traces and metrics. The README documents this path.
//
//  For the dev loop on this host today, start-stack.sh / .ps1 runs the
//  same three processes through compose with bind-mounted build
//  outputs. Iteration stays at `dotnet build` + `docker compose
//  restart <service>`. When the Fase 7 Dockerfile lands, the
//  bind-mounts become proper image builds and the two paths converge.
//
//  The two files are kept in sync: the env vars below mirror the ones
//  in docker-compose.yml. If you change one, change the other.
// =============================================================================

var builder = DistributedApplication.CreateBuilder(args);

// When the Aspire path is used, the business projects connect to the
// infra by hostname (nur-tricenter-postgres, etc.) and the service
// discovery endpoint resolves through the AppHost-managed Consul.
var catalogConn = "Host=nur-tricenter-postgres;Port=5432;Database=catalog;Username=dev-only;Password=dev-only-password";
var identityConn = "Host=nur-tricenter-postgres;Port=5432;Database=nur_tricenter_identity;Username=dev-only;Password=dev-only-password";

// The JWT signing key. dev-only value: a signing key does not belong in version control, and
// it must be the SAME value the API signs with and every other service validates against.
var jwtKey = "dev-only-signing-key-not-a-secret-0123456789";

// --- Identity ------------------------------------------------------------------
// The HTTP host: login, /me, and user creation. Registers itself in Consul so the gateway
// discovers it. Its database is its own, not the catalog's: one database per microservice.
builder.AddProject<Projects.Identity_App>("identity-webapi")
       .WithEnvironment("ConnectionStrings__IdentityDatabaseConnectionString", identityConn)
       .WithEnvironment("Jwt__SecretKey", jwtKey)
       .WithEnvironment("Jwt__ValidIssuer", "nur-tricenter-identity")
       .WithEnvironment("Jwt__ValidAudience", "nur-tricenter-clients")
       .WithEnvironment("Jwt__Lifetime", "3600")
       .WithEnvironment("DefaultUser__Enabled", "true")
       .WithEnvironment("DefaultUser__UserName", "admin")
       .WithEnvironment("DefaultUser__Password", "admin")
       .WithEnvironment("ServiceRegistration__ServiceDiscoveryAddress", "http://nur-tricenter-consul:8500");

// The worker: drains the outbox and publishes to RabbitMQ. NOT registered in Consul — it
// serves no HTTP, so a registration would advertise a route to an endpoint that cannot answer.
builder.AddProject<Projects.Identity_WorkerService>("identity-workerservice")
       .WithEnvironment("ConnectionStrings__IdentityDatabaseConnectionString", identityConn)
       .WithEnvironment("Jwt__SecretKey", jwtKey)
       .WithEnvironment("Jwt__ValidIssuer", "nur-tricenter-identity")
       .WithEnvironment("Jwt__ValidAudience", "nur-tricenter-clients")
       .WithEnvironment("Jwt__Lifetime", "3600")
       .WithEnvironment("RabbitMqSettings__Host", "nur-tricenter-rabbitmq")
       .WithEnvironment("DefaultUser__Enabled", "true")
       .WithEnvironment("DefaultUser__UserName", "admin")
       .WithEnvironment("DefaultUser__Password", "admin");

// --- Catalog -------------------------------------------------------------------
builder.AddProject<Projects.Catalog_App>("catalog-webapi")
       .WithEnvironment("ConnectionStrings__CatalogDbConnectionString", catalogConn)
       .WithEnvironment("RabbitMqSettings__Host", "nur-tricenter-rabbitmq")
       .WithEnvironment("ServiceRegistration__ServiceDiscoveryAddress", "http://nur-tricenter-consul:8500");

builder.AddProject<Projects.Catalog_WorkerService>("catalog-workerservice")
       .WithEnvironment("ConnectionStrings__CatalogDbConnectionString", catalogConn)
       .WithEnvironment("RabbitMqSettings__Host", "nur-tricenter-rabbitmq");

// --- Gateway -------------------------------------------------------------------
builder.AddProject<Projects.ApiGateway_App>("apigateway-webapp")
       .WithEnvironment("ServiceRegistration__ServiceDiscoveryAddress", "http://nur-tricenter-consul:8500");

builder.Build().Run();
