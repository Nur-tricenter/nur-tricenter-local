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

// When the Aspire path is used, the three business projects connect to
// the infra by hostname (nur-tricenter-postgres, etc.) and the service
// discovery endpoint resolves through the AppHost-managed Consul.
var catalogConn = "Host=nur-tricenter-postgres;Port=5432;Database=catalog;Username=dev-only;Password=dev-only-password";

builder.AddProject<Projects.Catalog_WebApi>("catalog-webapi")
       .WithEnvironment("ConnectionStrings__CatalogDbConnectionString", catalogConn)
       .WithEnvironment("RabbitMqSettings__Host", "nur-tricenter-rabbitmq")
       .WithEnvironment("ServiceRegistration__ServiceDiscoveryAddress", "http://nur-tricenter-consul:8500");

builder.AddProject<Projects.Catalog_WorkerService>("catalog-workerservice")
       .WithEnvironment("ConnectionStrings__CatalogDbConnectionString", catalogConn)
       .WithEnvironment("RabbitMqSettings__Host", "nur-tricenter-rabbitmq");

builder.AddProject<Projects.ApiGateway_WebApp>("apigateway-webapp")
       .WithEnvironment("ServiceRegistration__ServiceDiscoveryAddress", "http://nur-tricenter-consul:8500");

builder.Build().Run();
