using System.Text;
using System.Text.Encodings.Web;
using System.Text.RegularExpressions;
using System.Text.Unicode;
using Deckino.Api.Data;
using Deckino.Api.Decks;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Sharing;

// Link previews (Discord, WhatsApp, …) for shared deck and binder links. Crawlers don't run the SPA's JavaScript,
// so these addresses serve the site's index.html with OpenGraph tags for that deck or binder already in it.
// Private or missing ones get the plain page, which then shows its own "not found".
public static partial class SharePreviews
{
    private record Preview(string Title, string Description, string? Image);
    private static readonly HtmlEncoder Html = HtmlEncoder.Create(UnicodeRanges.All); // escapes markup, keeps "·" and accented names readable

    public static void MapSharePreviews(this WebApplication app)
    {
        app.MapGet("/deck/{id:guid}", async (Guid id, HttpContext http, DeckinoDbContext db, IWebHostEnvironment env, SiteLinks links, CancellationToken ct) =>
        {
            var found = await PublicDeckEndpoints.FindAsync(db, id, ct);
            Preview? preview = null;
            if (found is { } f)
            {
                var cards = await DeckEndpoints.LoadCardsAsync(db, f.Deck.Cards.Commander.Concat(f.Deck.Cards.Mainboard), ct);
                var summary = DeckSummary.From(f.Deck, cards);
                var format = char.ToUpperInvariant(f.Deck.Format[0]) + f.Deck.Format[1..];
                preview = new Preview($"{f.Deck.Name} by {f.Owner}", $"{format} deck · {Cards(summary.CardCount)} · Deckino", summary.Cover);
            }
            return await PageAsync(http, env, links, preview, ct);
        });

        app.MapGet("/binder/{id:guid}", async (Guid id, HttpContext http, DeckinoDbContext db, IWebHostEnvironment env, SiteLinks links, CancellationToken ct) =>
        {
            var found = await db.Binders.AsNoTracking()
                .Where(b => b.Id == id && b.IsPublic)
                .Join(db.Users, b => b.OwnerId, u => u.Id, (b, u) => new
                {
                    b.Name,
                    b.IsSelling,
                    Owner = u.UserName!,
                    Count = db.BinderCards.Count(c => c.BinderId == b.Id),
                    Cover = db.BinderCards.Where(c => c.BinderId == b.Id).OrderBy(c => c.CreatedAt).Select(c => (Guid?)c.ScryfallId).FirstOrDefault(),
                })
                .FirstOrDefaultAsync(ct);
            Preview? preview = null;
            if (found is not null)
            {
                var cover = found.Cover is { } coverId ? (await db.Cards.AsNoTracking().FirstAsync(c => c.Id == coverId, ct)).FrontImages : null;
                var what = found.IsSelling ? $"Cards for sale by {found.Owner}" : $"A binder by {found.Owner}";
                preview = new Preview(found.Name, $"{what} · {Cards(found.Count)} · Deckino", cover?.ArtCrop ?? cover?.Normal);
            }
            return await PageAsync(http, env, links, preview, ct);
        });
    }

    // Every other page of the SPA (the home page included) is index.html with the site-wide preview.
    public static Task<IResult> SitePageAsync(HttpContext http, IWebHostEnvironment env, SiteLinks links, CancellationToken ct) =>
        PageAsync(http, env, links, null, ct);

    private const string SiteImage = "/og-image.png";

    // index.html, read once and again only when a new build replaces it.
    // A record, not a tuple: replacing a reference is atomic, so concurrent requests never see half an update.
    private sealed record IndexFile(DateTimeOffset Modified, string Html);
    private static IndexFile? index;

    private static async Task<string?> IndexHtmlAsync(IWebHostEnvironment env, CancellationToken ct)
    {
        var file = env.WebRootFileProvider.GetFileInfo("index.html");
        if (!file.Exists) return null;
        if (index is { } cached && cached.Modified == file.LastModified) return cached.Html;
        using var reader = new StreamReader(file.CreateReadStream());
        var html = await reader.ReadToEndAsync(ct);
        index = new IndexFile(file.LastModified, html);
        return html;
    }

    private static string Cards(int count) => count == 1 ? "1 card" : $"{count} cards";

    private static async Task<IResult> PageAsync(HttpContext http, IWebHostEnvironment env, SiteLinks links, Preview? preview, CancellationToken ct)
    {
        var html = await IndexHtmlAsync(env, ct);
        if (html is null) return Results.NotFound();
        // Every value is the user's or the catalogue's text: HTML-encoded before it goes into the page.
        string E(string value) => Html.Encode(value);
        var origin = links.BaseUrl;
        var url = $"{origin}{http.Request.Path}";
        if (preview is null)
        {
            // index.html's site-wide preview, with the address and an absolute image URL (crawlers need full URLs).
            html = html
                .Replace($"content=\"{SiteImage}\"", $"content=\"{E(origin + SiteImage)}\"")
                .Replace("</head>", $"<meta property=\"og:url\" content=\"{E(url)}\" /></head>");
            return Results.Content(html, "text/html; charset=utf-8");
        }

        var tags = new StringBuilder()
            .Append($"<meta property=\"og:site_name\" content=\"Deckino\" />")
            .Append($"<meta property=\"og:type\" content=\"website\" />")
            .Append($"<meta property=\"og:title\" content=\"{E(preview.Title)}\" />")
            .Append($"<meta property=\"og:description\" content=\"{E(preview.Description)}\" />")
            .Append($"<meta property=\"og:url\" content=\"{E(url)}\" />")
            .Append($"<meta name=\"description\" content=\"{E(preview.Description)}\" />");
        if (preview.Image is not null)
        {
            tags.Append($"<meta property=\"og:image\" content=\"{E(preview.Image)}\" />")
                .Append("<meta name=\"twitter:card\" content=\"summary_large_image\" />");
        }
        html = SiteTags().Replace(html, ""); // index.html's site-wide preview, replaced by this page's
        html = html.Replace("<title>Deckino</title>", $"<title>{E(preview.Title)} · Deckino</title>").Replace("</head>", $"{tags}</head>");
        return Results.Content(html, "text/html; charset=utf-8");
    }

    [GeneratedRegex(@"<meta (property=""og:[^""]*""|name=""(description|twitter:card)"") content=""[^""]*"" */?>\s*")]
    private static partial Regex SiteTags();
}
