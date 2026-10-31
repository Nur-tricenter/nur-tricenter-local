using System.Text.Json;
using System.Threading.Channels;

namespace DemoConsole;

/// <summary>One integration event copied off the broker, as sent to the browser.</summary>
public sealed record TappedEvent(string Id, string Exchange, DateTimeOffset ReceivedAt, JsonElement Payload);

/// <summary>Keeps the last events and fans each new one out to every open SSE stream.</summary>
public sealed class EventHub
{
    private const int Capacity = 300;
    private readonly LinkedList<TappedEvent> _recent = new();
    private readonly List<Channel<TappedEvent>> _subscribers = [];
    private readonly Lock _gate = new();

    public void Publish(TappedEvent ev)
    {
        lock (_gate)
        {
            _recent.AddLast(ev);
            if (_recent.Count > Capacity) _recent.RemoveFirst();
            foreach (var s in _subscribers) s.Writer.TryWrite(ev);
        }
    }

    /// <summary>Returns the buffered events (oldest first) and a reader for the ones that follow.</summary>
    public (IReadOnlyList<TappedEvent> Snapshot, ChannelReader<TappedEvent> Reader, Action Unsubscribe) Subscribe()
    {
        var channel = Channel.CreateBounded<TappedEvent>(new BoundedChannelOptions(500) { FullMode = BoundedChannelFullMode.DropOldest });
        lock (_gate)
        {
            _subscribers.Add(channel);
            return ([.. _recent], channel.Reader, () => { lock (_gate) _subscribers.Remove(channel); });
        }
    }
}
