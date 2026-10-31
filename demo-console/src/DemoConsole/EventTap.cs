using System.Text;
using System.Text.Json;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

namespace DemoConsole;

/// <summary>
/// Binds one exclusive, auto-delete queue to every platform exchange. The exchanges are fanout,
/// so this queue gets its own copy of each message and the real consumer queues are untouched.
/// Reconnects forever: the demo console may start before RabbitMQ is ready.
/// </summary>
public sealed class EventTap(IConfiguration config, EventHub hub, ILogger<EventTap> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RunAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                logger.LogWarning("Event tap disconnected ({Message}); retrying in 5 s", ex.Message);
            }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }

    private async Task RunAsync(CancellationToken ct)
    {
        var section = config.GetSection("RabbitMq");
        var factory = new ConnectionFactory
        {
            HostName = section["Host"] ?? "localhost",
            Port = section.GetValue("Port", 5672),
            UserName = section["UserName"] ?? "guest",
            Password = section["Password"] ?? "guest",
            ClientProvidedName = "demo-console-tap"
        };

        await using var connection = await factory.CreateConnectionAsync(ct);
        await using var channel = await connection.CreateChannelAsync(cancellationToken: ct);

        var queue = section["TapQueue"] ?? "demo-console.tap";
        await channel.QueueDeclareAsync(queue, durable: false, exclusive: true, autoDelete: true, cancellationToken: ct);

        var bound = new List<string>();
        foreach (var exchange in section.GetSection("Exchanges").Get<string[]>() ?? [])
        {
            if (await ExchangeExistsAsync(connection, exchange, ct))
            {
                await channel.QueueBindAsync(queue, exchange, routingKey: "", cancellationToken: ct);
                bound.Add(exchange);
            }
        }
        logger.LogInformation("Event tap listening on {Count} exchanges: {Exchanges}", bound.Count, string.Join(", ", bound));

        var consumer = new AsyncEventingBasicConsumer(channel);
        consumer.ReceivedAsync += (_, ea) =>
        {
            hub.Publish(new TappedEvent(
                ea.BasicProperties.MessageId ?? Guid.NewGuid().ToString(),
                ea.Exchange,
                DateTimeOffset.UtcNow,
                ParseBody(ea.Body.Span)));
            return Task.CompletedTask;
        };
        await channel.BasicConsumeAsync(queue, autoAck: true, consumer, ct);

        // Stay here until the connection drops or the host stops.
        var closed = new TaskCompletionSource();
        connection.ConnectionShutdownAsync += (_, _) => { closed.TrySetResult(); return Task.CompletedTask; };
        await closed.Task.WaitAsync(ct);
        throw new InvalidOperationException("connection closed");
    }

    // A passive declare on a missing exchange closes the channel, so each check gets its own.
    private static async Task<bool> ExchangeExistsAsync(IConnection connection, string exchange, CancellationToken ct)
    {
        await using var probe = await connection.CreateChannelAsync(cancellationToken: ct);
        try
        {
            await probe.ExchangeDeclarePassiveAsync(exchange, ct);
            return true;
        }
        catch (RabbitMQ.Client.Exceptions.OperationInterruptedException)
        {
            return false;
        }
    }

    private static JsonElement ParseBody(ReadOnlySpan<byte> body)
    {
        var text = Encoding.UTF8.GetString(body);
        try
        {
            using var doc = JsonDocument.Parse(text);
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return JsonSerializer.SerializeToElement(text);
        }
    }
}
