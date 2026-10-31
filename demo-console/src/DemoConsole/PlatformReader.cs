using Npgsql;

namespace DemoConsole;

/// <summary>
/// Read-only SQL against the services' databases: outbox/inbox rows for the Outbox view, and the
/// lookups no service exposes yet (gap X-17). Never writes.
/// </summary>
public sealed class PlatformReader(IConfiguration config, ILogger<PlatformReader> logger)
{
    public sealed record MessageRow(string Id, string Service, string Type, DateTimeOffset? CreatedAt, DateTimeOffset? ProcessedAt, string? Status);

    // Joseco.Outbox table (identity, MS1, MS2, MS5), MS3's own table and MS4's own table.
    private static readonly string[] JosecoOutbox = ["identity", "ms1", "ms2", "ms5"];
    private static readonly string[] Inbox = ["ms2", "ms3", "ms4", "ms5"];

    private const string JosecoSql = """
        select "outboxId"::text, "type", "created", "processedOn", case when "processed" then 'Processed' else 'Pending' end
        from outbox."outboxMessage" order by "created" desc limit @n
        """;
    private const string Ms3OutboxSql = """
        select "Id"::text, "EventType", "CreatedAt", "PublishedAt", "Status"
        from "OutgoingIntegrationEvents" order by "CreatedAt" desc limit @n
        """;
    private const string Ms4OutboxSql = """
        select "Id"::text, "Type", "CreatedAt", "PublishedAt", case when "PublishedAt" is null then 'Pending' else 'Processed' end
        from "OutboxMessages" order by "CreatedAt" desc limit @n
        """;
    private const string InboxSql = """
        select "MessageId"::text, "MessageType", "MessageCreatedAt", "ProcessedOn", null
        from {0}"InboxMessages" order by coalesce("ProcessedOn", "MessageCreatedAt") desc limit @n
        """;

    public async Task<object> OutboxAsync(CancellationToken ct)
    {
        const int n = 25;
        var outTasks = JosecoOutbox.Select(s => QueryRowsAsync(s, JosecoSql, n, ct))
            .Append(QueryRowsAsync("ms3", Ms3OutboxSql, n, ct))
            .Append(QueryRowsAsync("ms4", Ms4OutboxSql, n, ct));
        var inTasks = Inbox.Select(s => QueryRowsAsync(s, string.Format(InboxSql, s == "ms2" ? "read." : ""), n, ct));

        var outbox = (await Task.WhenAll(outTasks)).SelectMany(x => x).OrderByDescending(r => r.CreatedAt).Take(60);
        var inbox = (await Task.WhenAll(inTasks)).SelectMany(x => x).OrderByDescending(r => r.ProcessedAt ?? r.CreatedAt).Take(60);
        return new { outbox, inbox = inbox.Select(r => new { r.Id, r.Service, r.Type, receivedAt = r.CreatedAt, r.ProcessedAt }) };
    }

    private async Task<IReadOnlyList<MessageRow>> QueryRowsAsync(string service, string sql, int limit, CancellationToken ct)
    {
        try
        {
            await using var conn = await OpenAsync(service, ct);
            await using var cmd = new NpgsqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("n", limit);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            var rows = new List<MessageRow>();
            while (await reader.ReadAsync(ct))
            {
                rows.Add(new MessageRow(
                    reader.GetString(0), service, ShortType(reader.IsDBNull(1) ? "?" : reader.GetString(1)),
                    reader.IsDBNull(2) ? null : reader.GetFieldValue<DateTimeOffset>(2),
                    reader.IsDBNull(3) ? null : reader.GetFieldValue<DateTimeOffset>(3),
                    reader.IsDBNull(4) ? null : reader.GetString(4)));
            }
            return rows;
        }
        catch (Exception ex) when (ex is NpgsqlException or InvalidOperationException)
        {
            // A service without that table (or a database that isn't there) just contributes nothing.
            logger.LogDebug("Skipping {Service}: {Message}", service, ex.Message);
            return [];
        }
    }

    // "Nur.Tricenter.Integration.Messages.Logistics.CourierCreated, Nur.Tricenter.Integration" -> "CourierCreated"
    private static string ShortType(string type)
    {
        var name = type.Split(',')[0].Trim();
        return name.Contains('.') ? name[(name.LastIndexOf('.') + 1)..] : name;
    }

    // ---------- gap X-17 lookups ----------

    public async Task<object?> CalendarByContractAsync(Guid contractId, CancellationToken ct)
    {
        await using var conn = await OpenAsync("ms4", ct);
        await using var cmd = new NpgsqlCommand("""select "Id" from "DeliveryCalendars" where "ContractId" = @id""", conn);
        cmd.Parameters.AddWithValue("id", contractId);
        return await cmd.ExecuteScalarAsync(ct) is int id ? new { calendarId = id } : null;
    }

    public async Task<object> PackagesByOrderAsync(Guid orderId, CancellationToken ct)
    {
        await using var conn = await OpenAsync("ms3", ct);
        await using var cmd = new NpgsqlCommand("""select "Id", "PatientId", "Status" from "Packages" where "ProductionOrderId" = @id""", conn);
        cmd.Parameters.AddWithValue("id", orderId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var list = new List<object>();
        while (await reader.ReadAsync(ct))
            list.Add(new { packageId = reader.GetGuid(0), patientId = reader.GetGuid(1), status = reader.GetString(2) });
        return list;
    }

    /// <summary>
    /// The MS3 projection row of an MS4 delivery day (from <c>production-order-ready</c>). No service exposes it,
    /// so the flow reads it here to know MS3 holds the day before it builds the daily order.
    /// </summary>
    public async Task<object?> ScheduledDeliveryByDayAsync(int dayId, CancellationToken ct)
    {
        await using var conn = await OpenAsync("ms3", ct);
        await using var cmd = new NpgsqlCommand("""select "DeliveryDate" from "ScheduledDeliveries" where "DeliveryDayId" = @id""", conn);
        cmd.Parameters.AddWithValue("id", dayId);
        return await cmd.ExecuteScalarAsync(ct) is { } date ? new { deliveryDayId = dayId, deliveryDate = date } : null;
    }

    public async Task<object?> DeliveryByDayAsync(int dayId, CancellationToken ct)
    {
        await using var conn = await OpenAsync("ms4", ct);
        await using var cmd = new NpgsqlCommand("""select "DeliveryId", "RouteId" from "DeliveryRouteLinks" where "DayId" = @id""", conn);
        cmd.Parameters.AddWithValue("id", dayId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? new { deliveryId = reader.GetGuid(0), routeId = reader.GetGuid(1) } : null;
    }

    private async Task<NpgsqlConnection> OpenAsync(string service, CancellationToken ct)
    {
        var database = config[$"Postgres:Databases:{service}"] ?? throw new InvalidOperationException($"No database configured for {service}");
        var builder = new NpgsqlConnectionStringBuilder(config["Postgres:Server"]) { Database = database };
        var conn = new NpgsqlConnection(builder.ConnectionString);
        await conn.OpenAsync(ct);
        return conn;
    }
}
