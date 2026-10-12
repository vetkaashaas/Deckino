namespace Deckino.Api.Hosting;

public static class WebSecurity
{
    // The site's own scripts and styles (Mantine sets inline styles), and card images and symbols from Scryfall.
    private const string ContentSecurityPolicy =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https://cards.scryfall.io https://svgs.scryfall.io; font-src 'self' data:; " +
        "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

    public static void UseWebSecurity(this WebApplication app)
    {
        var links = app.Services.GetRequiredService<SiteLinks>();
        var www = "www." + new Uri(links.BaseUrl).Host;
        app.Use(async (http, next) =>
        {
            var request = http.Request;
            // www.deckino.com → deckino.com: one origin, so one login cookie and one set of links.
            if (string.Equals(request.Host.Host, www, StringComparison.OrdinalIgnoreCase))
            {
                http.Response.Redirect($"{links.BaseUrl}{request.Path}{request.QueryString}", permanent: true, preserveMethod: true);
                return;
            }

            // The SameSite=Lax cookie already stays home on cross-site POSTs; this refuses any cross-site change
            // outright, whatever the browser does with cookies.
            if (request.Path.StartsWithSegments("/api") && !HttpMethods.IsGet(request.Method)
                && !HttpMethods.IsHead(request.Method) && !HttpMethods.IsOptions(request.Method) && IsCrossSite(request))
            {
                await Results.Problem("Requests from other sites aren't allowed.", statusCode: StatusCodes.Status403Forbidden)
                    .ExecuteAsync(http);
                return;
            }

            // Set as the response starts, after anything (like the exception handler) that clears headers.
            http.Response.OnStarting(() =>
            {
                var headers = http.Response.Headers;
                headers.XContentTypeOptions = "nosniff";
                headers.XFrameOptions = "DENY";
                headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
                headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()";
                if (!request.Path.StartsWithSegments("/api")) headers.ContentSecurityPolicy = ContentSecurityPolicy;
                return Task.CompletedTask;
            });
            await next(http);
        });
    }

    // Browsers say where a request comes from: Sec-Fetch-Site in all current ones, Origin in older ones. Neither
    // header (the mobile app, curl) means it isn't a browser page on another site.
    private static bool IsCrossSite(HttpRequest request)
    {
        var site = request.Headers["Sec-Fetch-Site"].ToString();
        if (site.Length > 0) return site is not ("same-origin" or "none");
        var origin = request.Headers.Origin.ToString();
        return origin.Length > 0 && !string.Equals(origin, $"{request.Scheme}://{request.Host}", StringComparison.OrdinalIgnoreCase);
    }
}
