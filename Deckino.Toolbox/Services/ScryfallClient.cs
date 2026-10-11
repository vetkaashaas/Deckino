using System.Net.Http;
using System.Net.Http.Headers;

namespace Deckino.Toolbox.Services;

public sealed class ScryfallClient : IDisposable
{
    private readonly HttpClient _http;

    public ScryfallClient(int requestIntervalMs) : this(requestIntervalMs, new HttpClientHandler())
    {
    }

    internal ScryfallClient(int requestIntervalMs, HttpMessageHandler handler)
    {
        RateGate = new RateLimiter(requestIntervalMs);
        _http = new HttpClient(handler);
        _http.DefaultRequestHeaders.UserAgent.Add(
            new ProductInfoHeaderValue("Deckino.Toolbox", "0.1"));
        _http.DefaultRequestHeaders.Accept.Add(
            new MediaTypeWithQualityHeaderValue("application/json"));
    }

    internal RateLimiter RateGate { get; }

    public async Task<HttpResponseMessage> GetAsync(
        Uri uri,
        HttpCompletionOption completionOption,
        CancellationToken cancellationToken)
    {
        // Scryfall rate-limits its API; the file origins at *.scryfall.io (card images) have no rate limit.
        if (!uri.Host.EndsWith(".scryfall.io", StringComparison.OrdinalIgnoreCase))
            await RateGate.WaitAsync(cancellationToken);
        return await _http.GetAsync(uri, completionOption, cancellationToken);
    }

    public void Dispose() => _http.Dispose();

    internal sealed class RateLimiter
    {
        private readonly int _intervalMs;
        private long _nextSlotTick;

        public RateLimiter(int intervalMs)
        {
            _intervalMs = intervalMs;
            _nextSlotTick = Environment.TickCount64;
        }

        public async Task WaitAsync(CancellationToken cancellationToken)
        {
            while (true)
            {
                var now = Environment.TickCount64;
                var observed = Interlocked.Read(ref _nextSlotTick);
                var slotStart = Math.Max(observed, now);
                var claimed = slotStart + _intervalMs;
                if (Interlocked.CompareExchange(ref _nextSlotTick, claimed, observed) == observed)
                {
                    if (slotStart > now)
                    {
                        await Task.Delay((int)Math.Min(slotStart - now, int.MaxValue), cancellationToken);
                    }
                    return;
                }
            }
        }
    }
}
