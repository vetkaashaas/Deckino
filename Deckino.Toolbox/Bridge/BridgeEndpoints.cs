using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows.Input;
using CommunityToolkit.Mvvm.Input;
using Deckino.Toolbox.Services;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.StaticFiles;

namespace Deckino.Toolbox.Bridge;

/// <summary>The HTTP side of the bridge, served on 127.0.0.1 to the window (and to Playwright with --serve).</summary>
public static class BridgeEndpoints
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(60);
    private static readonly TimeSpan FullCheckInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan KeepAlive = TimeSpan.FromSeconds(15);
    private static readonly FileExtensionContentTypeProvider ContentTypes = new();
    // Orders snapshots (all taken on the UI thread), so the UI keeps the newest when a response and an event cross.
    // It starts at the clock, so a server started afresh (behind Vite) counts on past the last one.
    private static long _sequence = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>
    /// The token cookie of the server on this port. Cookies ignore ports, and every Toolbox window shares one WebView2
    /// profile, so a second Toolbox would otherwise replace the first one's token.
    /// </summary>
    public static string TokenCookie(int port) => $"deckino-token-{port}";

    /// <summary>A failed request is logged, and the page gets the error's message to show.</summary>
    public static void UseBridgeErrors(this WebApplication app, ApplicationLogService log) => app.Use(async (context, next) =>
    {
        try
        {
            await next();
        }
        catch (Exception error) when (!context.RequestAborted.IsCancellationRequested)
        {
            log.Error("bridge", $"{context.Request.Method} {context.Request.Path} failed.", error);
            if (context.Response.HasStarted) return;
            context.Response.StatusCode = error is KeyNotFoundException
                ? StatusCodes.Status404NotFound
                : StatusCodes.Status500InternalServerError;
            await context.Response.WriteAsync(error.Message);
        }
    });

    /// <summary>
    /// Only this PC's loopback names (no DNS rebinding), and every /api call carries the per-launch token cookie the
    /// window sets (HttpOnly, SameSite=Strict), so neither websites nor other local programs can drive the Toolbox.
    /// </summary>
    public static void UseBridgeSecurity(this WebApplication app, string token)
    {
        var expected = Encoding.UTF8.GetBytes(token);
        app.Use(async (context, next) =>
        {
            if (context.Request.Host.Host is not ("localhost" or "127.0.0.1" or "[::1]"))
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }
            var path = context.Request.Path;
            if (path.StartsWithSegments("/api") && !path.Equals("/api/session")
                && !CryptographicOperations.FixedTimeEquals(
                    Encoding.UTF8.GetBytes(context.Request.Cookies[TokenCookie(context.Connection.LocalPort)] ?? string.Empty), expected))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }
            await next();
        });

        // A browser other than the window (a dev browser, Playwright) signs in once with the token.
        app.MapGet("/api/session", (string token, HttpContext context) =>
        {
            if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(token), expected))
                return Results.Unauthorized();
            context.Response.Cookies.Append(TokenCookie(context.Connection.LocalPort), token, new CookieOptions
            {
                HttpOnly = true,
                SameSite = SameSiteMode.Strict,
                Path = "/",
            });
            return Results.Redirect("/");
        });
    }

    public static void MapBridge(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/workspaces/{name}", (string name, WorkspaceRegistry registry, UiDispatcher ui) =>
            ui.InvokeAsync(() => registry.Find(name) is { } target ? Snapshot(target) : Results.NotFound()));

        api.MapPost("/workspaces/{name}/commands/{command}", async (
            string name, string command, HttpRequest request, WorkspaceRegistry registry, UiDispatcher ui,
            AppEvents events, ApplicationLogService log) =>
        {
            var argument = await ReadJsonAsync(request);
            return await ui.InvokeAsync(() =>
            {
                if (registry.Find(name) is not { } target) return Results.NotFound();
                var (action, parameter) = StateSerializer.PrepareCommand(target, command, argument);
                if (!action.CanExecute(parameter)) return Snapshot(target, StatusCodes.Status409Conflict);
                Execute(action, parameter, $"{name}.{command}", events, log);
                return Snapshot(target);
            });
        });

        api.MapMethods("/workspaces/{name}", ["PATCH"], async (
            string name, HttpRequest request, WorkspaceRegistry registry, UiDispatcher ui) =>
        {
            if (await ReadJsonAsync(request) is not { ValueKind: JsonValueKind.Object } changes)
                return Results.BadRequest();
            return await ui.InvokeAsync(() =>
            {
                if (registry.Find(name) is not { } target) return Results.NotFound();
                StateSerializer.Patch(target, changes);
                return Snapshot(target);
            });
        });

        api.MapPost("/dialogs/{id}", async (string id, HttpRequest request, AppEvents events, UiDispatcher ui) =>
        {
            var accepted = await ReadJsonAsync(request) is { } body
                && body.TryGetProperty("accept", out var accept) && accept.ValueKind == JsonValueKind.True;
            return await ui.InvokeAsync(() => events.Answer(id, accepted)) ? Results.NoContent() : Results.NotFound();
        });

        // What broke in the window (PageErrorBoundary).
        api.MapPost("/log", (UiError error, ApplicationLogService log) =>
        {
            log.Error("ui", $"{error.Message}{Environment.NewLine}{error.Detail}");
            return Results.NoContent();
        });

        // Server-sent events: each watched workspace's state whenever it changed. The view models say when (as they did
        // for MAUI's bindings), checked every PollInterval; every FullCheckInterval it is compared anyway, for text that
        // changes with time alone.
        api.MapGet("/events", async (HttpContext context, WorkspaceRegistry registry, UiDispatcher ui, ApplicationLogService log) =>
        {
            var cancellation = context.RequestAborted;
            context.Response.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            var sent = new Dictionary<string, string>();
            var seen = new Dictionary<string, (long Changes, long Responses)>();
            var failing = new HashSet<string>();
            var lastWrite = DateTime.UtcNow;
            var lastCheck = DateTime.MinValue;
            try
            {
                while (!cancellation.IsCancellationRequested)
                {
                    var full = DateTime.UtcNow - lastCheck > FullCheckInterval;
                    if (full) lastCheck = DateTime.UtcNow;
                    var snapshots = await ui.InvokeAsync(() => registry.Watched.Select(name =>
                    {
                        if (registry.Find(name) is not { } target) return default;
                        var version = StateSerializer.VersionOf(target);
                        var known = seen.TryGetValue(name, out var last);
                        if (known && last == version && !full) return default;
                        seen[name] = version;
                        // A response may have handed the page a state this stream never sent (a "loading" in between):
                        // after one, the state goes out again even if it looks unchanged from here.
                        if (known && last.Responses != version.Responses) sent.Remove(name);
                        try
                        {
                            var json = StateSerializer.Snapshot(target);
                            failing.Remove(name);
                            return (Name: name, Json: json, Sequence: Interlocked.Increment(ref _sequence));
                        }
                        catch (Exception error)
                        {
                            // One workspace failing leaves the others (dialogs and toasts too) streaming; logged once
                            // each time it starts failing.
                            if (failing.Add(name)) log.Error("bridge", $"The {name} state could not be sent.", error);
                            return default;
                        }
                    }).Where(snapshot => snapshot.Name is not null).ToArray());
                    var wrote = false;
                    foreach (var (name, json, sequence) in snapshots)
                    {
                        if (sent.TryGetValue(name, out var previous) && previous == json) continue;
                        sent[name] = json;
                        await context.Response.WriteAsync(
                            $"event: state\ndata: {{\"name\":\"{name}\",\"seq\":{sequence},\"snapshot\":{json}}}\n\n", cancellation);
                        wrote = true;
                    }
                    if (!wrote && DateTime.UtcNow - lastWrite > KeepAlive)
                    {
                        await context.Response.WriteAsync(": ping\n\n", cancellation);
                        wrote = true;
                    }
                    if (wrote)
                    {
                        lastWrite = DateTime.UtcNow;
                        await context.Response.Body.FlushAsync(cancellation);
                    }
                    await Task.Delay(PollInterval, cancellation);
                }
            }
            catch (OperationCanceledException)
            {
                // The page closed or reloaded.
            }
        });

        api.MapGet("/files", (string path, TrainingPaths paths, HttpContext context) =>
        {
            if (!IsServable(path, paths)) return Results.NotFound();
            CacheForever(context);
            return Results.File(Path.GetFullPath(path),
                ContentTypes.TryGetContentType(path, out var type) ? type : "application/octet-stream");
        });

        api.MapGet("/thumbnails", (string path, TrainingPaths paths, CameraAnnotationStore store, HttpContext context) =>
        {
            if (!IsServable(path, paths)) return Results.NotFound();
            byte[] bytes;
            try
            {
                bytes = store.LoadThumbnail(path);
            }
            catch (Exception error) when (IsUndecodable(error))
            {
                return Results.NotFound();
            }
            CacheForever(context);
            return Results.Bytes(bytes, "image/jpeg");
        });

        // Card art URLs carry no version (making one reads the disk, for hundreds of printings at once), so the
        // browser asks again each time and gets "not modified" until the card image changes.
        api.MapGet("/card-art", (string path, TrainingPaths paths, HttpContext context) =>
        {
            if (!IsServable(path, paths)) return Results.NotFound();
            var modified = new DateTimeOffset(File.GetLastWriteTimeUtc(path));
            modified = modified.AddTicks(-(modified.Ticks % TimeSpan.TicksPerSecond)); // HTTP dates have whole seconds
            context.Response.Headers.CacheControl = "private, no-cache";
            if (context.Request.GetTypedHeaders().IfModifiedSince >= modified) return Results.StatusCode(StatusCodes.Status304NotModified);
            try
            {
                return Results.Bytes(Images.CropCardArt(path), "image/jpeg", lastModified: modified);
            }
            catch (Exception error) when (IsUndecodable(error))
            {
                return Results.NotFound();
            }
        });

        api.MapGet("/images/{id}", (string id, HttpContext context) =>
        {
            if (Images.FindGenerated(id) is not { } bytes) return Results.NotFound();
            CacheForever(context);
            return Results.Bytes(bytes, "image/jpeg");
        });
    }

    private static void Execute(ICommand command, object? parameter, string name, AppEvents events, ApplicationLogService log)
    {
        void Report(Exception error)
        {
            log.Error("ui", $"{name} failed.", error);
            events.Show($"Something went wrong: {error.Message}", "error");
        }

        try
        {
            if (command is IAsyncRelayCommand asyncCommand) _ = ObserveAsync(asyncCommand.ExecuteAsync(parameter));
            else command.Execute(parameter);
        }
        catch (Exception error)
        {
            Report(error);
        }

        async Task ObserveAsync(Task task)
        {
            try
            {
                await task;
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception error)
            {
                Report(error);
            }
        }
    }

    // Everything the pages show lives in the data root: photos, card images, diagnostics, thumbnails.
    private static bool IsServable(string path, TrainingPaths paths)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;
        var full = Path.GetFullPath(path);
        var root = Path.GetFullPath(paths.DataRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return full.StartsWith(root, StringComparison.OrdinalIgnoreCase) && File.Exists(full);
    }

    // A photo or card image that can't be read (cut short by an interrupted download, say) is a blank tile, as under
    // MAUI, not an error logged at every visit.
    private static bool IsUndecodable(Exception error) =>
        error is IOException or ArgumentException or OutOfMemoryException or System.Runtime.InteropServices.ExternalException;

    private static void CacheForever(HttpContext context) =>
        context.Response.Headers.CacheControl = "private, max-age=31536000, immutable";

    private static IResult Snapshot(object target, int status = StatusCodes.Status200OK)
    {
        StateSerializer.Responded(target);
        return Results.Content(
            $"{{\"seq\":{Interlocked.Increment(ref _sequence)},\"snapshot\":{StateSerializer.Snapshot(target)}}}",
            "application/json", Encoding.UTF8, status);
    }

    private static async Task<JsonElement?> ReadJsonAsync(HttpRequest request)
    {
        if (request.ContentLength is 0 or null && !request.Headers.TransferEncoding.Any()) return null;
        using var document = await JsonDocument.ParseAsync(request.Body);
        return document.RootElement.Clone();
    }
}

internal sealed record UiError(string Message, string? Detail);
