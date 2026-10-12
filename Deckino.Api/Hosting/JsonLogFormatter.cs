using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging.Console;

namespace Deckino.Api.Hosting;

// One JSON object per line in the shape Railway's log explorer reads: "level" colours the line, "message" is its
// text, and every other field is an attribute to filter on. Those are the message's values (RunId, Tag, …) and the
// request's scope (TraceId, RequestPath), so @TraceId:… finds every line of the request an error reference names.
public sealed class JsonLogFormatter() : ConsoleFormatter(FormatterName)
{
    public const string FormatterName = "railway-json";
    private static readonly JsonWriterOptions Options = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private static readonly string[] Reserved = ["level", "message", "category", "exception", "{OriginalFormat}"];

    public override void Write<TState>(in LogEntry<TState> entry, IExternalScopeProvider? scopeProvider, TextWriter textWriter)
    {
        var message = entry.Formatter(entry.State, entry.Exception);
        if (string.IsNullOrEmpty(message) && entry.Exception is null) return;

        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer, Options))
        {
            json.WriteStartObject();
            json.WriteString("level", entry.LogLevel switch
            {
                LogLevel.Trace or LogLevel.Debug => "debug",
                LogLevel.Information => "info",
                LogLevel.Warning => "warn",
                _ => "error",
            });
            json.WriteString("message", message);
            json.WriteString("category", entry.Category);
            if (entry.Exception is { } exception) json.WriteString("exception", exception.ToString());
            // A key in both the message and a scope (say RequestPath) is written once: JSON keys must be unique.
            var written = new HashSet<string>(Reserved);
            WriteValues(json, entry.State, written);
            scopeProvider?.ForEachScope((scope, state) => WriteValues(state.json, scope, state.written), (json, written));
            json.WriteEndObject();
        }
        textWriter.WriteLine(Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length));
    }

    private static void WriteValues(Utf8JsonWriter json, object? state, HashSet<string> written)
    {
        if (state is not IEnumerable<KeyValuePair<string, object?>> values) return;
        foreach (var (key, value) in values)
        {
            if (written.Add(key)) json.WriteString(key, Convert.ToString(value, CultureInfo.InvariantCulture));
        }
    }
}
