using System.Text;
using System.Text.Json;
using DemoConsole;
using Yarp.ReverseProxy.Configuration;

// Demo console: serves the presentation dashboard (wwwroot) and is its backend-for-frontend.
// Everything the page needs comes from this origin, so no platform service has to enable CORS:
//   /gw/**      -> API gateway (every business call goes through the real gateway)
//   /consul/**  -> Consul HTTP API (service registry and health)
//   /rabbit/**  -> RabbitMQ management API (queue counters)
//   /live/*     -> broker events over SSE, outbox/inbox rows, gap X-17 lookups (read-only)
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<EventHub>();
builder.Services.AddHostedService<EventTap>();
builder.Services.AddSingleton<PlatformReader>();
builder.Services.AddReverseProxy().LoadFromMemory(Routes(), Clusters(builder.Configuration));

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/health", () => Results.Ok("Healthy"));

var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);

app.MapGet("/live/events", async (HttpContext ctx, EventHub hub) =>
{
    ctx.Response.Headers.ContentType = "text/event-stream";
    ctx.Response.Headers.CacheControl = "no-cache";
    ctx.Response.Headers["X-Accel-Buffering"] = "no";

    var (snapshot, reader, unsubscribe) = hub.Subscribe();
    try
    {
        foreach (var ev in snapshot) await WriteAsync(ev);
        await ctx.Response.Body.FlushAsync(ctx.RequestAborted);

        using var heartbeat = new PeriodicTimer(TimeSpan.FromSeconds(15));
        var next = reader.ReadAsync(ctx.RequestAborted).AsTask();
        var tick = heartbeat.WaitForNextTickAsync(ctx.RequestAborted).AsTask();
        while (!ctx.RequestAborted.IsCancellationRequested)
        {
            var done = await Task.WhenAny(next, tick);
            if (done == next)
            {
                await WriteAsync(await next);
                next = reader.ReadAsync(ctx.RequestAborted).AsTask();
            }
            else
            {
                await ctx.Response.WriteAsync(": keep-alive\n\n", ctx.RequestAborted);
                tick = heartbeat.WaitForNextTickAsync(ctx.RequestAborted).AsTask();
            }
            await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
        }
    }
    catch (OperationCanceledException) { /* browser closed the stream */ }
    finally { unsubscribe(); }

    Task WriteAsync(TappedEvent ev) =>
        ctx.Response.WriteAsync($"data: {JsonSerializer.Serialize(ev, json)}\n\n", ctx.RequestAborted);
});

app.MapGet("/live/outbox", (PlatformReader db, CancellationToken ct) => db.OutboxAsync(ct));

app.MapGet("/live/lookup/calendar-by-contract/{contractId:guid}", async (Guid contractId, PlatformReader db, CancellationToken ct) =>
    await db.CalendarByContractAsync(contractId, ct) is { } r ? Results.Ok(r) : Results.NotFound());
app.MapGet("/live/lookup/packages-by-order/{orderId:guid}", (Guid orderId, PlatformReader db, CancellationToken ct) =>
    db.PackagesByOrderAsync(orderId, ct));
app.MapGet("/live/lookup/delivery-by-day/{dayId:int}", async (int dayId, PlatformReader db, CancellationToken ct) =>
    await db.DeliveryByDayAsync(dayId, ct) is { } r ? Results.Ok(r) : Results.NotFound());

app.MapReverseProxy();
app.Run();

static RouteConfig[] Routes() =>
[
    Route("gateway", "/gw"),
    Route("consul", "/consul"),
    Route("rabbit", "/rabbit", new Dictionary<string, string>
    {
        ["RequestHeader"] = "Authorization",
        ["Set"] = "Basic " + Convert.ToBase64String(Encoding.ASCII.GetBytes("guest:guest"))
    })
];

static RouteConfig Route(string id, string prefix, Dictionary<string, string>? extra = null) => new()
{
    RouteId = id,
    ClusterId = id,
    Match = new RouteMatch { Path = prefix + "/{**rest}" },
    Transforms = extra is null
        ? [new Dictionary<string, string> { ["PathRemovePrefix"] = prefix }]
        : [new Dictionary<string, string> { ["PathRemovePrefix"] = prefix }, extra]
};

static ClusterConfig[] Clusters(IConfiguration config) =>
[
    Cluster("gateway", config["Upstreams:Gateway"]!),
    Cluster("consul", config["Upstreams:Consul"]!),
    Cluster("rabbit", config["Upstreams:RabbitManagement"]!)
];

static ClusterConfig Cluster(string id, string address) => new()
{
    ClusterId = id,
    Destinations = new Dictionary<string, DestinationConfig> { ["d1"] = new() { Address = address } }
};
